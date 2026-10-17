import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AdapterContext, DiscoverySource, ExecutionAdapter, Preparation, Delivery } from '../../core/catalog.js';
import { DomainError, ReplanRequired } from '../../core/domain.js';
import { digest } from '../../core/delegation.js';
import type { ExecutionPlan, ServiceCapability } from '../../ontology/execution.js';
import { pickupQuerySchema, type Comparison, type DiscoveredBinding, type DiscoveryCoverage, type Offer, type PickupQuery } from '../../ontology/supply.js';
import type { McdTransport, McdResponse, McdSession } from './transport.js';

export const MCD_PICKUP_CAPABILITY: ServiceCapability = {
  ref: { id: 'food.pickup.compare', version: '1' }, ontologyRef: { id: 'pickup-offer-comparison', version: '1' }, name: 'Compare real pickup food quotes', tags: ['food', 'coffee', 'pickup', 'comparison'], environment: 'live',
  description: 'Read-only comparison of real McDonald\'s pickup stores, product specifications and calculated prices. Requires city, locationKeyword, productQuery, quantity, unit, mode=pickup and allowAlternatives. Uses observed default modifications and reports them. Only choose for discovery, price queries or comparison itself, never an actual purchase/delivery request. Stock, capacity and collection time remain unknown unless separately evidenced. No order, payment, coupon binding, points redemption or address creation.',
  inputSchema: z.toJSONSchema(pickupQuerySchema), ontology: { objects: ['Merchant', 'ProductVariant', 'Offer', 'Comparison'], relations: ['Channel exposes Merchant', 'Offer quotes ProductVariant and quantity', 'Comparison retains independent Offer terms'],
    constraints: ['A quoted quantity is not confirmed stock', 'Same name is not same specification', 'Calculated prices require original provider product references', 'Missing fees are unknown, not zero'], outcome: 'Auditable read-only comparison, no purchase fulfillment' },
  actions: [{ ref: { id: 'read_pickup_comparison', version: '1' }, effect: 'read' }], verifierRef: { id: 'mcd.quote-independent', version: '1' },
  locationSemantics: 'search_area', outcomePredicates: ['comparison.default_specifications', 'comparison.unknowns_disclosed'],
  predicates: [{ id: 'comparison.auditable', description: 'Quotes and selection have provider trace references and timestamps' }, { id: 'comparison.default_specifications', description: 'Report the actual default product name and selected modification options' }, { id: 'comparison.unknowns_disclosed', description: 'Explicitly disclose unverified stock/capacity, collection time and future-price limits' }, { id: 'execution.no_order', description: 'Read-only price comparison; no order, payment or redemption' }],
};
const localOwner = JSON.stringify(['local-development', 'local', 'developer']);
const storeSchema = z.object({ storeCode: z.string().min(1), storeName: z.string().min(1), address: z.string().min(1), businessStatus: z.boolean().optional(), distance: z.number().optional(),
  businessStartTime: z.string().optional(), businessEndTime: z.string().optional(), reservation: z.boolean().optional(), reservationTimeOptions: z.array(z.object({ date: z.string(), today: z.boolean(), reservationOptionText: z.string() })).optional() });
const menuSchema = z.object({ meals: z.record(z.string(), z.object({ name: z.string(), currentPrice: z.string().optional() }).passthrough()) });
const valueSchema = z.object({ code: z.string(), name: z.string(), selectedQuantity: z.number().int().nonnegative().optional(), selectedKey: z.string().optional(), unselectedKey: z.string().optional() }).passthrough();
const detailSchema = z.object({ code: z.string(), name: z.string(), rounds: z.array(z.unknown()).optional(), supportModify: z.boolean().optional(),
  modification: z.object({ items: z.array(z.object({ minValues: z.number().optional(), maxValues: z.number().optional(), values: z.array(valueSchema) })) }).optional() });
const minor = z.number().int().nonnegative().safe();
export const calculatedPriceSchema = z.object({ price: minor, productPrice: minor,
  packingPrice: minor.optional(), deliveryPrice: minor.optional(), tablewarePrice: minor.optional(),
  productList: z.array(z.object({ productCode: z.string(), productName: z.string(), quantity: z.number().int().positive(), subtotal: minor })).min(1) });
interface QuotePayload { query: PickupQuery; quoteInput: Record<string, unknown>; rawQuote: McdResponse; offer: Offer; comparison?: Comparison }
function defaultOptions(detail: z.infer<typeof detailSchema>) {
  if (detail.rounds?.length) throw new DomainError('INVALID_INPUT', 'This comparison currently requires a standalone product; combo composition must be selected explicitly');
  const values: { code: string; key: string; quantity: number }[] = []; const observed: { code: string; name: string; key: string; quantity: number }[] = [];
  for (const group of detail.modification?.items ?? []) {
    const selected = group.values.filter(v => (v.selectedQuantity ?? 0) > 0);
    if (selected.length < (group.minValues ?? 0) || selected.length > (group.maxValues ?? group.values.length)) throw new DomainError('INVALID_INPUT', 'Product default configuration is incomplete');
    for (const value of group.values) {
      const quantity = value.selectedQuantity ?? 0;
      const key = quantity ? value.selectedKey : value.unselectedKey;
      if (quantity && !key) throw new DomainError('INVALID_INPUT', 'Product modification has no provider key');
      if (key) values.push({ code: value.code, key, quantity });
      if (quantity) observed.push({ code: value.code, name: value.name, key: key!, quantity });
    }
  }
  return { values, observed };
}
function validateQuote(response: McdResponse, productCode: string, quantity: number) {
  const price = calculatedPriceSchema.parse(response.data);
  if (price.productList.some(p => p.productCode !== productCode) || price.productList.reduce((n, p) => n + p.quantity, 0) !== quantity || price.productList.reduce((n, p) => n + p.subtotal, 0) !== price.productPrice || price.price < price.productPrice) throw new Error('Quote does not match the requested product/count');
  return price;
}
function matchesProduct(name: string, query: string, detail: boolean): boolean {
  const terms = /美式/.test(query) ? ['美式'] : /拿铁|奶铁/.test(query) ? ['拿铁', '奶铁'] : /咖啡/.test(query) ? ['咖啡'] : [query];
  if (!terms.some(term => name.includes(term))) return false;
  return !detail || ['冰', '热', '大杯', '中杯', '小杯', '燕麦', '生椰'].filter(token => query.includes(token)).every(token => name.includes(token));
}
export class McdSupplySource implements DiscoverySource {
  readonly id = 'mcd.pickup.v1'; readonly adapterId = 'mcd.readonly.v1'; readonly channelId = 'mcd-cn'; readonly capabilityRefs = [MCD_PICKUP_CAPABILITY.ref];
  constructor(private transport: McdTransport) {}
  permitted(owner: string) { return owner === localOwner; }
  async discover(ctx: AdapterContext, input: unknown, signal: AbortSignal) {
    if (!this.permitted(ctx.owner)) throw new DomainError('FORBIDDEN', 'Personal MCD queries require the local identity');
    const q = pickupQuerySchema.safeParse(input);
    const coverage: DiscoveryCoverage = { sourceId: this.id, status: 'needs_input', queriedAt: new Date().toISOString(), returnedStores: 0, queriedStores: 0, hasMore: false, realSupply: this.transport.evidenceKind === 'live_readonly' };
    if (!q.success) return { candidates: [], coverage: { ...coverage, note: '请提供城市、公开地点关键词、餐品、数量/单位，并明确到店自取和是否允许比较不同规格。' } };
    return this.transport.session(async session => this.discoverWith(session, ctx, q.data, coverage, signal), signal);
  }
  private async discoverWith(session: McdSession, ctx: AdapterContext, q: PickupQuery, coverage: DiscoveryCoverage, signal: AbortSignal) {
    const storeResponse = await session.call('query-nearby-stores', { searchType: 2, city: q.city, keyword: q.locationKeyword, beType: 1 }, signal);
    const stores = z.array(storeSchema).parse(storeResponse.data); coverage.returnedStores = stores.length; coverage.hasMore = stores.length > q.maxStores;
    const candidates: { binding: DiscoveredBinding; preparation: Preparation; offer?: Offer }[] = [];
    for (const store of stores.slice(0, q.maxStores)) {
      if (candidates.length >= 8) { coverage.hasMore = true; break; }
      signal.throwIfAborted(); coverage.queriedStores++;
      if (store.businessStatus === false) continue;
      const binding: DiscoveredBinding = { ref: { id: `mcd.pickup:${store.storeCode}`, version: '1' }, capabilityRef: MCD_PICKUP_CAPABILITY.ref, providerId: `mcd-cn:${store.storeCode}`, channelId: this.channelId,
        merchantId: store.storeCode, adapterId: this.adapterId, configurationDigest: this.transport.configurationDigest, protocol: 'mcp', enabled: true, verification: { level: this.transport.evidenceKind === 'live_readonly' ? 'read_only_probe' : 'simulated', evidenceRefs: [`mcd:${storeResponse.traceId}`] }, recovery: { idempotency: 'none', lookup: false },
        discovery: { sourceId: this.id, requestId: ctx.request.id, requestRevision: ctx.request.revision, observedAt: coverage.queriedAt, evidenceRefs: [`mcd:${storeResponse.traceId}`] } };
      try {
        const menuResponse = await session.call('query-meals', { storeCode: store.storeCode, orderType: 1, beType: 1 }, signal);
        const menu = menuSchema.parse(menuResponse.data); const options = Object.entries(menu.meals).filter(([, m]) => matchesProduct(m.name, q.productQuery, false)).sort((a, b) => a[1].name.length - b[1].name.length);
        if (!options.length) candidates.push({ binding, preparation: { kind: 'unavailable', reason: '该门店当前菜单没有匹配目标的餐品。', details: { store } } });
        for (const [code] of options.slice(0, 2)) {
          if (candidates.length >= 8) { coverage.hasMore = true; break; }
          const detailResponse = await session.call('query-meal-detail', { storeCode: store.storeCode, code, orderType: 1, beType: 1 }, signal);
          const detail = detailSchema.parse(detailResponse.data); const modification = defaultOptions(detail);
          if (detail.code !== code) throw new Error('Provider product reference changed');
          if (!matchesProduct(detail.name, q.productQuery, true) || q.unit === '杯' && !detail.name.includes('杯')) {
            candidates.push({ binding, preparation: { kind: 'unavailable', reason: '菜单名称包含目标词，但实际默认商品不是所请求餐品；不能替代。', details: { store, actualProductName: detail.name } } }); continue;
          }
          const quoteInput = { storeCode: store.storeCode, beType: 1, orderType: 1, items: [{ productCode: code, quantity: q.quantity, ...(modification.values.length ? { modification: { values: modification.values } } : {}) }], needTableware: false };
          const rawQuote = await session.call('calculate-price', quoteInput, signal); const price = validateQuote(rawQuote, code, q.quantity);
          const observedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 300000).toISOString();
          const specification = { name: detail.name, defaults: modification.observed, rounds: detail.rounds ?? [] };
          const offer: Offer = { id: randomUUID(), channelId: this.channelId, merchant: { namespace: this.channelId, id: store.storeCode }, merchantName: store.storeName, merchantAddress: store.address,
            bindingRef: binding.ref, product: { sourceProductRef: { namespace: `${this.channelId}:${store.storeCode}`, id: code }, name: detail.name, specification, specificationDigest: digest(specification) }, quotedQuantity: { amount: String(q.quantity), unit: q.unit },
            pricing: { currency: 'CNY', total: { minor: String(price.price), currency: 'CNY' }, productSubtotal: String(price.productPrice), fees: { delivery: price.deliveryPrice === undefined ? undefined : String(price.deliveryPrice), packing: price.packingPrice === undefined ? undefined : String(price.packingPrice), tableware: price.tablewarePrice === undefined ? undefined : String(price.tablewarePrice) }, kind: 'calculated_quote' },
            availability: { storeOpen: store.businessStatus ?? 'unknown', capacity: 'unknown', reservation: { supported: store.reservation ?? 'unknown', options: (store.reservationTimeOptions ?? []).map(o => ({ date: o.date, today: o.today, label: o.reservationOptionText })) }, businessHours: { start: store.businessStartTime, end: store.businessEndTime } }, observedAt, expiresAt, validityBasis: 'local_refresh_limit',
            evidenceRefs: [storeResponse, menuResponse, detailResponse, rawQuote].map(r => `mcd:${r.traceId}`), sourceRevision: rawQuote.traceId, unknowns: ['stock/capacity', 'ready/collection time', 'future price guarantee', 'discount eligibility on a future final order'] };
          const payload: QuotePayload = { query: q, quoteInput, rawQuote, offer };
          candidates.push({ binding, offer, preparation: { kind: 'ready', input: { storeCode: store.storeCode, productCode: code, quantity: q.quantity, unit: q.unit, specificationDigest: offer.product.specificationDigest },
            details: { offer, store: { ...store }, readOnly: true, underlyingPurchase: 'not_started' }, facts: { quantity: offer.quotedQuantity, totalPrice: offer.pricing.total, locationRef: `mcd-cn:${store.storeCode}`, searchArea: { city: q.city, keyword: q.locationKeyword }, conditions: ['comparison.auditable', 'comparison.default_specifications', 'comparison.unknowns_disclosed', 'execution.no_order'] },
            evidenceRefs: offer.evidenceRefs, observedAt, expiresAt, privateData: payload } });
        }
      } catch (error) {
        signal.throwIfAborted(); if (error instanceof DomainError && error.code === 'FORBIDDEN') throw error;
        candidates.push({ binding, preparation: error instanceof DomainError ? { kind: 'needs_input', question: error.message, details: { store } } : { kind: 'unavailable', reason: '该门店商品或计价暂不可核实；保留未知，不视为可下单。', details: { store } } });
      }
    }
    if (!q.allowAlternatives && new Set(candidates.flatMap(c => c.offer ? [c.offer.product.specificationDigest] : [])).size > 1) return { candidates: candidates.map(c => ({ binding: c.binding, preparation: { kind: 'needs_input' as const, question: '查询到不同商品规格，请明确规格或允许比较替代品；未创建订单。' } })), coverage: { ...coverage, status: 'needs_input' as const } };
    return { candidates, coverage: { ...coverage, status: candidates.some(c => c.offer) ? 'returned' as const : 'empty' as const } };
  }
}
export class McdQuoteAdapter implements ExecutionAdapter {
  readonly id = 'mcd.readonly.v1'; constructor(private transport: McdTransport) {}
  permitted(owner: string) { return owner === localOwner; }
  async prepare(): Promise<Preparation> { return { kind: 'needs_input', question: '请先通过当前需求的受控门店发现获取商品和报价。' }; }
  async execute(ctx: AdapterContext, plan: ExecutionPlan, data: unknown, signal: AbortSignal): Promise<Delivery> {
    const payload = data as QuotePayload;
    if (!payload?.offer || !payload.comparison || plan.details.comparisonDigest !== digest(payload.comparison) || digest(plan.steps[0]!.input) !== digest({ storeCode: payload.quoteInput.storeCode, productCode: payload.offer.product.sourceProductRef.id, quantity: payload.query.quantity, unit: payload.query.unit, specificationDigest: payload.offer.product.specificationDigest })) throw new DomainError('CONFLICT', 'Prepared comparison changed');
    const response = await this.transport.session(s => s.call('calculate-price', payload.quoteInput, signal), signal);
    const refreshed = validateQuote(response, payload.offer.product.sourceProductRef.id, payload.query.quantity);
    if (String(refreshed.price) !== payload.offer.pricing.total?.minor) throw new ReplanRequired('Quote changed; refresh the comparison before selecting a plan');
    return { artifact: { id: randomUUID(), name: 'pickup-comparison.json', data: { goal: ctx.request.originalGoal, deliverable: this.transport.evidenceKind === 'live_readonly' ? '已完成真实门店和报价的只读比较；所选报价已复查。库存/产能和取餐时间仍未知，未下单或付款。' : '合成报价比较测试完成，未使用真实供给或资金。', execution: 'completed', result: {
      comparison: payload.comparison, selectedOfferId: payload.offer.id, revalidation: { response: { success: true, code: 200, traceId: response.traceId, data: refreshed }, observedAt: new Date().toISOString() }, businessCompleted: false, orderCreated: false, paymentConfirmed: false, deliveryConfirmed: false,
    } } }, facts: { quantity: payload.offer.quotedQuantity, totalPrice: { minor: String(refreshed.price), currency: 'CNY' }, locationRef: `mcd-cn:${payload.offer.merchant.id}`, searchArea: { city: payload.query.city, keyword: payload.query.locationKeyword }, conditions: ['comparison.auditable', 'comparison.default_specifications', 'comparison.unknowns_disclosed', 'execution.no_order'] }, evidenceRefs: [...payload.offer.evidenceRefs, `mcd:${response.traceId}`] };
  }
  verify(ctx: AdapterContext, plan: ExecutionPlan, data: unknown, delivery: Delivery) {
    try {
      const payload = data as QuotePayload; const result = delivery.artifact.data.result as { comparison: Comparison; selectedOfferId: string; revalidation: { response: McdResponse }; orderCreated: boolean; paymentConfirmed: boolean; deliveryConfirmed: boolean };
      if (delivery.artifact.name !== 'pickup-comparison.json' || digest(result.comparison) !== plan.details.comparisonDigest || result.comparison.requestId !== ctx.request.id || result.comparison.requestRevision !== ctx.request.revision || result.selectedOfferId !== payload.offer.id || result.orderCreated !== false || result.paymentConfirmed !== false || result.deliveryConfirmed !== false) throw new Error('Comparison identity or scope mismatch');
      const raw = result.revalidation.response; if (!raw.success || raw.code !== 200 || !raw.traceId) throw new Error('No provider success receipt');
      const p = calculatedPriceSchema.parse(raw.data); let count = 0; let subtotal = 0;
      for (const line of p.productList) { if (line.productCode !== payload.offer.product.sourceProductRef.id) throw new Error('Different product'); count += line.quantity; subtotal += line.subtotal; }
      if (count !== payload.query.quantity || subtotal !== p.productPrice || String(p.price) !== payload.offer.pricing.total?.minor || result.comparison.offers.some(o => !o.evidenceRefs.length || !o.sourceRevision)) throw new Error('Quote count, price or evidence mismatch');
      if (result.comparison.offers.some(o => !Array.isArray(o.product.specification.defaults) || !o.unknowns.includes('stock/capacity') || !o.unknowns.includes('ready/collection time') || o.availability.capacity !== 'unknown')) throw new Error('Default specifications or unknown availability facts were hidden');
      return { accepted: true, reason: 'Independent quote line/count/total, source references, fixed comparison and no-order scope verified; no fulfillment asserted.' };
    } catch { return { accepted: false, reason: 'Independent pickup comparison verification failed' }; }
  }
}
