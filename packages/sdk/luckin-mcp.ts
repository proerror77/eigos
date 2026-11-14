import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { Conflict, digest } from '../core/identity.js';
import { yuanToFen } from '../core/private-source.js';
import { luckinProduct, luckinShop, pickupInput, pickupQuote, pickupStatus } from '../ontology/luckin.js';

export const luckinMcpEndpoint = 'https://gwmcp.lkcoffee.com/order/user/mcp';
const id = z.number().int().safe().positive();
const providerMoney = z.union([z.number(), z.string()]);
const providerShop = z.object({
  deptId: id, deptName: z.string(), address: z.string(), latitude: z.number(), longitude: z.number(),
  workTimeStart: z.string().nullish(), workTimeEnd: z.string().nullish(),
});
const providerProduct = z.object({
  productId: id, productName: z.string(), skuCode: z.string(),
  initialPrice: providerMoney.nullish(), estimatePrice: providerMoney.nullish(),
  productAttrs: z.array(z.object({ attributeId: id, attributeName: z.string(),
    productSubAttrs: z.array(z.object({
      attributeId: id, attributeName: z.string(), selected: z.boolean().nullish(),
      canSelected: z.union([z.literal(0), z.literal(1), z.boolean()]).nullish(), price: providerMoney.nullish(),
    })).max(80),
  })).max(30).nullish(),
});
const providerPreview = z.object({
  shopInfo: providerShop, discountPrice: providerMoney, totalInitialPrice: providerMoney,
  couponCodeList: z.array(z.string().min(1).max(1024)).max(40).nullish(),
  productInfoList: z.array(z.object({
    productId: id, skuCode: z.string(), name: z.string(), amount: id, additionDesc: z.string().nullish(),
  })).max(10),
});
const providerCreated = z.object({
  orderIdStr: z.string().regex(/^[0-9]{1,30}$/), needPay: z.boolean(),
  discountPrice: providerMoney.nullish(), payOrderQrCodeUrl: z.string().nullish(),
});
const providerStatus = z.object({
  orderId: z.string().regex(/^[0-9]{1,30}$/), orderStatus: z.union([
    z.literal(10), z.literal(20), z.literal(30), z.literal(60), z.literal(80), z.literal(100),
  ]),
  takeMealCodeInfo: z.object({ code: z.string().nullish() }).nullish(),
});
const statuses = { 10: 'awaiting_payment', 20: 'placed', 30: 'preparing', 60: 'ready', 80: 'completed', 100: 'canceled' } as const;
const maybeMinor = (value: string | number | null | undefined) => value == null ? null : yuanToFen(value);

const pickShop = (s: z.infer<typeof providerShop>) => luckinShop.parse({
  shopId: s.deptId, name: s.deptName, address: s.address, latitude: s.latitude, longitude: s.longitude,
  opensAt: s.workTimeStart || undefined, closesAt: s.workTimeEnd || undefined,
});
const pickProduct = (p: z.infer<typeof providerProduct>) => luckinProduct.parse({
  productId: p.productId, name: p.productName, sku: p.skuCode,
  listPriceMinor: maybeMinor(p.initialPrice), estimatedPriceMinor: maybeMinor(p.estimatePrice),
  options: (p.productAttrs ?? []).map(group => ({ groupId: group.attributeId,
    name: group.attributeName, values: group.productSubAttrs.map(value => ({
      optionId: value.attributeId, label: value.attributeName, selected: value.selected ?? null,
      selectable: value.canSelected == null ? null : Boolean(value.canSelected), surchargeMinor: maybeMinor(value.price),
    })),
  })),
});
type Route = 'queryShopList' | 'searchProductForMcp' | 'queryProductDetailInfo' | 'switchProduct' |
  'previewOrder' | 'createOrder' | 'queryOrderDetailInfo';
const cart = (input: z.infer<typeof pickupInput>) => ({
  deptId: input.shopId, productList: input.items.map(item => ({ productId: item.productId, skuCode: item.sku, amount: item.quantity })),
});

/** Official MCP is called only by the owner’s PA host. Only the requested, typed provider operation can be sent. */
export class LuckinMcp {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    if (!/^\S{16,8192}$/.test(token)) throw new Conflict('Configure the owner’s Luckin MCP token on the PA');
  }
  connectionRef(localId: string) { return digest(['luckin-pa', localId, this.token]); }
  private async call(name: Route, args: Record<string, unknown>, signal: AbortSignal,
    providerExtras: readonly string[] = [], beforeDispatch?: () => Promise<void>) {
    const limit = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    let calls = 0;
    let guardFailure: unknown;
    const guarded: typeof fetch = async (input, init) => {
      if (String(input) !== luckinMcpEndpoint) throw new Conflict('Unexpected Luckin MCP target');
      if (init?.method === 'POST') {
        const rpc = JSON.parse(String(init.body));
        if (rpc.method === 'tools/call') {
          if (rpc.params?.name !== name || ++calls !== 1) throw new Conflict('Unexpected Luckin tool or repeated dispatch');
          try { await beforeDispatch?.(); }
          catch (error) { guardFailure = error; throw error; }
          limit.throwIfAborted();
        } else if (!['initialize', 'notifications/initialized', 'notifications/cancelled', 'tools/list', 'ping'].includes(rpc.method))
          throw new Conflict('Unsupported Luckin MCP request');
      }
      const response = await this.fetcher(input, { ...init, redirect: 'error', signal: limit });
      if (!response.body) return response;
      let bytes = 0;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > 1024 * 1024) throw new Conflict('Luckin MCP response exceeded its size limit');
          controller.enqueue(chunk);
        },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const client = new Client({ name: 'eigos-luckin-pa', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(luckinMcpEndpoint), {
      fetch: guarded, requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    try {
      await client.connect(transport, { signal: limit, timeout: 8000 });
      let cursor: string | undefined;
      let descriptor: Awaited<ReturnType<Client['listTools']>>['tools'][number] | undefined;
      for (let page = 0; page < 4; page++) {
        const list = await client.listTools(cursor ? { cursor } : {}, { signal: limit, timeout: 5000 });
        const found = list.tools.filter(tool => tool.name === name);
        if (found.length > 1 || (found.length && descriptor)) throw new Error('Duplicate provider descriptor');
        descriptor ??= found[0];
        cursor = list.nextCursor;
        if (!cursor) break;
      }
      if (cursor || !descriptor) throw new Error('Provider descriptor unavailable');
      const input = { ...args };
      for (const key of providerExtras) if (Object.hasOwn(descriptor.inputSchema.properties ?? {}, key)) input[key] = 'pick';
      if (Object.keys(input).some(key => !Object.hasOwn(descriptor!.inputSchema.properties ?? {}, key)) ||
          (descriptor.inputSchema.required ?? []).some(key => !Object.hasOwn(input, key)))
        throw new Error('Provider input schema differs');
      const result = await client.callTool({ name, arguments: input }, { signal: limit, timeout: 14000 });
      if (result.isError || JSON.stringify(result).includes(this.token)) throw new Error('Provider rejected request');
      const blocks = result.content.filter(block => block.type === 'text');
      if (!result.structuredContent && blocks.length !== 1) throw new Error('Provider did not return one MCP result');
      const raw = result.structuredContent ?? JSON.parse((blocks[0] as { text: string }).text);
      return z.object({ code: z.literal(0), success: z.literal(true), data: z.unknown() }).parse(raw).data;
    } catch {
      if (guardFailure instanceof Conflict) throw guardFailure;
      signal.throwIfAborted();
      throw new Conflict('Luckin MCP connection, permissions or response could not be verified');
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }
  async shops(input: { latitude: number; longitude: number; shopName?: string }, signal: AbortSignal) {
    const { shopName, ...location } = input;
    const raw = await this.call('queryShopList', { ...location, ...(shopName ? { deptName: shopName } : {}) }, signal);
    return z.array(providerShop).parse(raw).slice(0, 30).map(pickShop);
  }
  async search(input: { shopId: number; query: string }, signal: AbortSignal) {
    return z.array(providerProduct).parse(await this.call('searchProductForMcp',
      { deptId: input.shopId, query: input.query }, signal, ['delivery'])).slice(0, 30).map(pickProduct);
  }
  async product(input: { shopId: number; productId: number }, signal: AbortSignal) {
    const result = pickProduct(providerProduct.parse(await this.call('queryProductDetailInfo',
      { deptId: input.shopId, productId: input.productId }, signal, ['delivery'])));
    if (result.productId !== input.productId) throw new Conflict('Luckin returned a different product');
    return result;
  }
  async select(input: { shopId: number; productId: number; sku: string; groupId: number; optionId: number }, signal: AbortSignal) {
    const result = pickProduct(providerProduct.parse(await this.call('switchProduct', {
      deptId: input.shopId, productId: input.productId, skuCode: input.sku, amount: 1,
      attrOperationParam: { attributeId: input.groupId, subAttr: { attributeId: input.optionId, operation: 3 } },
    }, signal, ['delivery'])));
    if (result.productId !== input.productId ||
        !result.options.find(group => group.groupId === input.groupId)?.values.some(option => option.optionId === input.optionId && option.selected === true))
      throw new Conflict('Luckin returned a different product or specification');
    return result;
  }
  async preview(input: z.infer<typeof pickupInput>, signal: AbortSignal) {
    const data = providerPreview.parse(await this.call('previewOrder', cart(input), signal));
    const coupons = data.couponCodeList ?? [];
    const items = input.items.map(item => {
      const matches = data.productInfoList.filter(row => row.productId === item.productId && row.skuCode === item.sku && row.amount === item.quantity);
      if (matches.length !== 1) throw new Conflict('Luckin returned different pickup items');
      return { ...item, name: matches[0]!.name, optionsLabel: matches[0]!.additionDesc || null };
    });
    if (data.shopInfo.deptId !== input.shopId || data.productInfoList.length !== items.length)
      throw new Conflict('Luckin returned a different pickup store or items');
    return { coupons, shop: pickShop(data.shopInfo), items, currency: 'CNY' as const,
      totalMinor: yuanToFen(data.discountPrice), originalTotalMinor: yuanToFen(data.totalInitialPrice) };
  }
  async create(quote: z.infer<typeof pickupQuote>, coupons: string[], signal: AbortSignal, beforeDispatch: () => Promise<void>) {
    const result = providerCreated.parse(await this.call('createOrder', {
      ...cart({ shopId: quote.shop.shopId, items: quote.items, currency: quote.currency }),
      latitude: quote.shop.latitude, longitude: quote.shop.longitude,
      ...(coupons.length ? { couponCodeList: coupons } : {}),
    }, signal, ['delivery'], beforeDispatch));
    const paymentLink = (() => {
      if (!result.needPay || !result.payOrderQrCodeUrl) return;
      try {
        const url = new URL(result.payOrderQrCodeUrl);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
            (url.hostname === 'lkcoffee.com' || url.hostname.endsWith('.lkcoffee.com'))) return result.payOrderQrCodeUrl;
      } catch { /* The original order ID remains available when the payment link is invalid. */ }
    })();
    return { orderId: result.orderIdStr, paymentRequired: result.needPay,
      totalMinor: maybeMinor(result.discountPrice),
      paymentLink };
  }
  async status(orderId: string, signal: AbortSignal) {
    const result = providerStatus.parse(await this.call('queryOrderDetailInfo', { orderId }, signal));
    if (result.orderId !== orderId) throw new Conflict('Luckin returned a different order');
    return pickupStatus.parse({ orderId, providerStatus: statuses[result.orderStatus],
      pickupCode: [20, 30, 60, 80].includes(result.orderStatus) ? result.takeMealCodeInfo?.code || null : null });
  }
}
