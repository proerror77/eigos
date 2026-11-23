import { z } from 'zod';
import { Conflict, InvalidInput, digest } from '../../core/identity.js';
import { yuanToFen } from '../../core/private-source.js';
import {
  addressedDeliveryInput, addressedDeliveryReport, deliveryMerchantId, deliveryRecord, deliveryReportRef, deliverySearchReport,
  hemaSearchInput, instantDeliveryInput, localDeliveryProviders, localDeliveryServices, type LocalDeliveryProvider,
} from '../../ontology/local-delivery.js';
import { deliveryAddressNames } from '../../ontology/delivery-addresses.js';
import type { ObjectRef } from '../../ontology/schema.js';
import { confirmDeliveryDestination, persistDeliveryAddress, recheckPersonalDestination, resolveDeliveryDestination } from './addresses.js';
import type { FunctionHandler } from '../../runtime/functions.js';
import { configuredDelivery, deliveryFailure, DeliveryReadFailure, deliveryMcp, type DeliveryCall, type DeliveryConnectionPaths } from './mcp.js';

type Report = z.infer<typeof deliverySearchReport>;
type Item = Report['items'][number];
type Search = z.infer<typeof instantDeliveryInput>;
type Data = Pick<Report, 'status' | 'complete' | 'stores' | 'items'>;
type Owner = { platformId: 'taobao' | 'hema'; accountRef: string };
const ttl = 5 * 60 * 1000;
const stockChecks = 3;
const short = z.string().trim().min(1).max(300);
const addressRef = z.string().regex(/^[a-f0-9]{64}$/);
const price = z.union([z.string(), z.number()]).nullish();
const catalogItem = z.object({
  id: deliveryMerchantId, name: short, price,
  priceUnit: z.string().max(300).optional(), availability: z.enum(['available', 'sold-out', 'outside-sale-time', 'unknown']),
});
const group = z.object({ shopId: deliveryMerchantId, shopName: z.string().max(300), addressRef,
  state: z.enum(['ready', 'deferred', 'error']), hasMore: z.boolean() });
const groupError = z.object({ code: z.string().optional(), message: z.string().optional() });
const scope = (provider: LocalDeliveryProvider, input: Search): Report['scope'] =>
  provider === 'Hema' ? 'delivery_groups'
    : input.mode === 'stores' ? 'nearby_recommendations' : input.mode === 'menu' ? 'selected_store' : 'delivery_area';

function listing(item: z.infer<typeof catalogItem>, merchantId: string, merchantName: string | null): Item {
  return {
    merchantId, merchantName, itemId: item.id, name: item.name, listedPriceMinor: item.price == null ? null : yuanToFen(item.price),
    priceUnit: item.priceUnit?.trim() || null,
    availability: item.availability === 'sold-out' ? 'sold_out'
      : item.availability === 'outside-sale-time' ? 'outside_sale_time' : item.availability,
    stockEvidence: 'unknown', stockQuantity: null, variants: [],
  };
}

async function taobaoStoreData(call: DeliveryCall, owner: Owner, input: Search, expectedAddress?: string): Promise<Data> {
  const query = input.query?.normalize('NFKC').toLowerCase() ?? '';
  const matches = (name: string) => name.normalize('NFKC').toLowerCase().includes(query);
  if (input.mode === 'stores') {
    const page = z.object({ platformId: z.literal('taobao'), scope: z.literal('nearby-recommendations'),
      addressRef: addressRef.optional(), nextCursor: z.unknown(), shops: z.array(z.object({ id: deliveryMerchantId, name: short })).max(100) })
      .parse(await call('account_nearby_shops', { ...owner, ...(expectedAddress ? { addressRef: expectedAddress } : {}) }));
    if (expectedAddress && page.addressRef !== expectedAddress) throw new DeliveryReadFailure('address_required');
    const stores = page.shops.filter(shop => matches(shop.name)).map(({ id, name }) => ({ merchantId: id, name }));
    const complete = page.nextCursor === null && stores.length <= input.limit;
    return { status: complete ? 'available' : 'partial', complete, stores: stores.slice(0, input.limit), items: [] };
  }
  if (!input.merchantId) throw new InvalidInput('A selected merchant is required');
  const page = z.object({ platformId: z.literal('taobao'), shopId: deliveryMerchantId, addressRef: addressRef.optional(),
    categories: z.array(z.object({ items: z.array(catalogItem).max(5000) })).max(100),
  }).parse(await call('account_probe_menu', { ...owner, shopId: input.merchantId, ...(expectedAddress ? { addressRef: expectedAddress } : {}) }));
  if (expectedAddress && page.addressRef !== expectedAddress) throw new DeliveryReadFailure('address_required');
  if (page.shopId !== input.merchantId) throw new DeliveryReadFailure('unavailable');
  const matchesById = new Map(page.categories.flatMap(category => category.items).filter(item => matches(item.name)).map(item => [item.id, item]));
  const items = [...matchesById.values()].slice(0, input.limit).map(item => listing(item, page.shopId, null));
  const complete = matchesById.size <= input.limit;
  return { status: complete ? 'available' : 'partial', complete, items, stores: [{ merchantId: page.shopId, name: null }] };
}

async function catalogData(call: DeliveryCall, owner: Owner, query: string, limit: number, expectedAddress?: string): Promise<Data> {
  const response = z.object({ keyword: z.literal(query), platforms: z.array(z.object({
    platformId: z.literal(owner.platformId), accountRef: z.literal(owner.accountRef),
    scope: z.enum(['platform', 'delivery-stores', 'unavailable']),
    state: z.enum(['ready', 'partial', 'error', 'unavailable']), error: groupError.optional(), groups: z.array(z.unknown()).max(100),
  })).length(1) }).parse(await call('account_cross_search', { keyword: query, accounts: [owner] }));
  const page = response.platforms[0]!;
  if (page.state === 'error' || page.state === 'unavailable')
    throw new DeliveryReadFailure(deliveryFailure(page.error?.code, page.error?.message));

  if (expectedAddress && page.groups.some(raw => group.parse(raw).addressRef !== expectedAddress))
    throw new DeliveryReadFailure('address_required');
  const rows: { item: Item; stock?: () => Promise<void> }[] = [];
  const stores = new Map<string, string>();
  if (owner.platformId === 'taobao') {
    if (page.scope !== 'platform') throw new DeliveryReadFailure('unavailable');
    const [search] = z.array(group.extend({
      items: z.array(catalogItem.extend({ shopId: deliveryMerchantId, shopName: short, shopIsRetail: z.boolean().nullable() })).max(5000),
    })).length(1).parse(page.groups);
    for (const row of search!.items) {
      const item = listing(row, row.shopId, row.shopName);
      stores.set(row.shopId, row.shopName);
      rows.push({ item, stock: row.shopIsRetail === true ? async () => {
        const stock = z.object({ platformId: z.literal('taobao'), shopId: z.literal(row.shopId), addressRef: z.literal(search!.addressRef),
          name: z.literal(row.name), stock: z.number().nonnegative().finite(), simpleSku: z.boolean(), available: z.boolean(),
        }).parse(await call('account_retail_resolve_search', {
          ...owner, shopId: row.shopId, addressRef: search!.addressRef, keyword: query, itemId: row.id,
        }));
        if (stock.simpleSku) {
          item.stockQuantity = stock.stock;
          item.stockEvidence = 'verified';
          item.availability = stock.available ? 'available' : stock.stock === 0 ? 'sold_out' : 'unknown';
        }
      } : undefined });
    }
  } else {
    if (page.scope !== 'delivery-stores') throw new DeliveryReadFailure('unavailable');
    for (const search of z.array(group.extend({
      items: z.array(catalogItem.extend({ productRef: z.uuid() })).max(100),
    })).parse(page.groups)) {
      stores.set(search.shopId, search.shopName);
      for (const row of search.items) {
        const item = listing(row, search.shopId, search.shopName);
        rows.push({ item, stock: async () => {
          const detail = z.object({
            platformId: z.literal('hema'), shopId: z.literal(search.shopId), addressRef: z.literal(search.addressRef),
            productRef: z.literal(row.productRef), product: z.object({
              id: z.literal(row.id), available: z.boolean(),
              variants: z.array(z.object({ name: z.string().max(300), stockQuantity: z.number().nonnegative().finite(),
                saleUnit: z.string().max(300) })).max(100),
            }),
          }).parse(await call('account_product_detail', {
            ...owner, addressRef: search.addressRef, productRef: row.productRef,
          }));
          item.variants = detail.product.variants.map(variant => ({
            name: variant.name.trim() || '默认规格', quantity: variant.stockQuantity, saleUnit: variant.saleUnit.trim() || null,
          }));
          if (item.variants.length) {
            item.stockEvidence = 'verified';
            item.stockQuantity = item.variants.length === 1 ? item.variants[0]!.quantity : null;
          }
          if (!detail.product.available && item.availability === 'available') item.availability = 'unknown';
        } });
      }
    }
  }

  const selected = rows.slice(0, limit);
  let checks = 0;
  for (const row of selected) {
    if (!row.stock) continue;
    if (++checks > stockChecks) break;
    try { await row.stock(); }
    catch (error) {
      if (error instanceof Conflict && !(error instanceof DeliveryReadFailure)) throw error;
      row.item.stockEvidence = error instanceof DeliveryReadFailure && error.state === 'verification_required'
        ? 'verification_required' : 'unavailable';
      // Avoid repeating a challenged provider read with another item.
      if (row.item.stockEvidence === 'verification_required') break;
    }
  }
  const complete = page.state === 'ready' && rows.length <= limit && stores.size <= limit;
  return {
    status: complete ? 'available' : 'partial', complete, items: selected.map(row => row.item),
    stores: [...stores].slice(0, limit).map(([merchantId, name]) => ({ merchantId, name })),
  };
}

export function localDeliveryFunctions(paths: DeliveryConnectionPaths, mockFetch?: typeof fetch): ReadonlyMap<string, FunctionHandler> {
  const handlers = new Map<string, FunctionHandler>();
  for (const provider of localDeliveryProviders) {
    const service = localDeliveryServices[provider], names = deliveryAddressNames(provider);
    const runSearch = (addressed: boolean): FunctionHandler => async (raw, ctx) => {
      if (!ctx.edit || !ctx.operationId || ctx.objects.model.scenario) throw new Conflict('Use a live delivery search Action');
      const { destination: _destination, ...criteria } = raw;
      const input: Search = provider === 'Hema' ? hemaSearchInput.parse(criteria) : instantDeliveryInput.parse(criteria);
      const destination = addressed ? addressedDeliveryInput[provider].parse(raw).destination : undefined;
      const connection = await configuredDelivery(paths[provider], provider, ctx);
      const owner = { platformId: service.platformId, accountRef: connection.accountRef };
      let data: Data, usedAddress: Awaited<ReturnType<typeof resolveDeliveryDestination>> | undefined;
      try {
        data = await deliveryMcp(connection, ctx.signal, async call => {
          const chosen = destination && await resolveDeliveryDestination(call, ctx, provider, owner, destination);
          const search = async () => {
            if (input.mode === 'stores' || input.mode === 'menu') return taobaoStoreData(call, owner, input, chosen?.nativeRef);
            if (!input.query) throw new InvalidInput('A product or dish keyword is required');
            return catalogData(call, owner, input.query, input.limit, chosen?.nativeRef);
          };
          const result = await search();
          if (chosen) {
            await confirmDeliveryDestination(call, ctx, provider, owner, chosen.address);
            usedAddress = chosen;
          }
          return result;
        }, mockFetch ?? fetch);
      } catch (error) {
        ctx.signal.throwIfAborted();
        if (!(error instanceof DeliveryReadFailure || error instanceof z.ZodError)) throw error;
        data = { status: error instanceof DeliveryReadFailure ? error.state : 'unavailable', complete: false, stores: [], items: [] };
      }
      await connection.check();
      const now = Date.now(), ref = { type: service.object, id: digest([ctx.principal.owner, addressed ? names.search : service.action, ctx.operationId]) };
      const result = deliveryRecord.parse({
        id: ref.id, name: service.displayName + '查询', bindingId: connection.id,
        ...(usedAddress ? { deliveryAddressKey: usedAddress.address.id } : {}),
        ...(usedAddress?.personalVersion ? { personalPlaceVersionKey: usedAddress.personalVersion.id } : {}),
        provider, scope: scope(provider, input), query: input.query ?? null, ...data,
        observedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString(),
        evidence: mockFetch ? 'provider_mock' : 'live_readonly', currency: 'CNY',
      });
      return ctx.edit(ref, async graph => {
        await connection.assertBinding();
        if (destination && usedAddress) {
          await recheckPersonalDestination(graph, provider, destination, usedAddress.address, usedAddress.personalVersion);
          await persistDeliveryAddress(graph, usedAddress.address, provider, usedAddress.text);
        }
        await graph.create(ref, result);
        if (usedAddress) await graph.link({ type: names.searchLink, from: ref, to: usedAddress.address });
        if (usedAddress?.personalVersion)
          await graph.link({ type: names.searchVersionLink, from: ref, to: usedAddress.personalVersion });
      });
    };
    handlers.set(service.edit, runSearch(false));
    handlers.set(names.editSearch, runSearch(true));
    const readSearch = (addressed: boolean): FunctionHandler => async (raw, ctx) => {
      const { search } = deliveryReportRef.parse(raw);
      if (search.type !== service.object) throw new Conflict('Use the matching delivery search result');
      const connection = await configuredDelivery(paths[provider], provider, ctx);
      const { id: _id, name: _name, bindingId, deliveryAddressKey, personalPlaceVersionKey: _version, ...report } = deliveryRecord.parse((await ctx.objects.read(search)).properties);
      if (bindingId !== connection.id || report.provider !== provider || Date.parse(report.expiresAt) <= Date.now())
        throw new Conflict('The delivery search has expired or its account binding changed; run a new search');
      await connection.check();
      if (!addressed) return { ...report, search };
      if (!deliveryAddressKey && (report.status === 'available' || report.status === 'partial'))
        throw new Conflict('Run an address-bound search for a verified delivery address');
      const [address] = await ctx.objects.follow(search, 'deliveryAddress');
      if (address?.ref.id !== deliveryAddressKey) throw new Conflict('The search is missing its verified delivery address');
      return addressedDeliveryReport.parse({ ...report, search, deliveryAddress: address?.ref ?? null });
    };
    handlers.set(service.read, readSearch(false));
    handlers.set(names.readSearch, readSearch(true));
  }
  return handlers;
}
