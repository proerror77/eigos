import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AdapterContext, ExecutionAdapter, Preparation, Delivery } from '../core/catalog.js';
import { digest } from '../core/delegation.js';
import { DomainError, ReplanRequired } from '../core/domain.js';
import type { ExecutionPlan, ProviderBinding, ServiceCapability } from '../ontology/execution.js';
import { paotuiPreviewSchema, type PaotuiReader, type PaotuiQuery } from './paotui-contracts.js';
const geoInput = z.object({ keyword: z.string().trim().min(1).max(100), city: z.string().trim().min(1).max(50) }).strict();
const deliveryInput = paotuiPreviewSchema.omit({ action: true }); const addressInput = z.object({}).strict();
const definitions = [
  { id: 'geo.search', name: 'Search public locations', description: 'Read-only POI address search through the configured personal Meituan channel. Requires city and keyword. Returns locations, not menu/product search, stock, merchant reliability, delivery or purchase fulfillment.', schema: geoInput, kind: 'geo' },
  { id: 'delivery.quote', name: 'Read a parcel delivery quote', description: 'Read-only Meituan Paotui fee preview using two existing owned same-city address IDs and explicit goods/weight/service. No order, payment or cancellation. Quoted service time is an estimate, not proof of delivery. Ask for necessary saved-address IDs; never invent them.', schema: deliveryInput, kind: 'quote' },
  { id: 'address.book.read', name: 'Read owned saved addresses', description: 'Read this local user\'s existing Meituan address book, with masked phones. Only select when the requester needs their address list. Never disclose it to another tenant or provider, and never claim a purchase.', schema: addressInput, kind: 'addresses' },
] as const;
export const PAOTUI_READ_CAPABILITIES: ServiceCapability[] = definitions.map(d => ({ ref: { id: d.id, version: '1' }, ontologyRef: { id: 'locations-and-parcel-quotes', version: '1' }, name: d.name, description: d.description, tags: ['read-only', d.kind], inputSchema: z.toJSONSchema(d.schema), environment: 'live',
  ontology: { objects: ['OwnedAddressReference', 'PublicLocation', 'DeliveryQuote'], rules: ['Location search is not product search', 'Quote is not an order', 'Personal address data is task-owner scoped'] }, actions: [{ ref: { id: `${d.id}.read`, version: '1' }, effect: 'read' }], verifierRef: { id: `${d.id}.receipt`, version: '1' }, predicates: [{ id: 'execution.no_order', description: 'Read-only response; no order or payment' }] }));
export const PAOTUI_READ_BINDINGS: ProviderBinding[] = PAOTUI_READ_CAPABILITIES.map(c => ({ ref: { id: `meituan:${c.ref.id}`, version: '1' }, capabilityRef: c.ref, providerId: 'meituan-paotui', channelId: 'meituan', adapterId: `meituan:${c.ref.id}`, protocol: 'local', enabled: true, verification: { level: 'read_only_probe', evidenceRefs: ['docs/meituan-paotui-integration.md'] }, recovery: { idempotency: 'none', lookup: false } }));
function total(result: Record<string, unknown>) {
  const quote = result.quote as Record<string, unknown> | undefined; const text = String(quote?._previewTotal ?? '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return undefined; const [whole, fraction = ''] = text.split('.');
  return { minor: (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))).toString(), currency: 'CNY' };
}
export class PaotuiReadAdapter implements ExecutionAdapter {
  readonly id: string;
  constructor(private capabilityIndex: number, private reader: PaotuiReader) { this.id = PAOTUI_READ_BINDINGS[capabilityIndex]!.adapterId; }
  permitted(owner: string) { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  private query(input: unknown): PaotuiQuery {
    const definition = definitions[this.capabilityIndex]!;
    if (definition.kind === 'geo') return { action: 'search_address', ...geoInput.parse(input) };
    if (definition.kind === 'quote') return { action: 'preview', ...deliveryInput.parse(input) };
    addressInput.parse(input); return { action: 'addresses' };
  }
  async prepare(ctx: AdapterContext, input: unknown, signal: AbortSignal): Promise<Preparation> {
    if (!this.permitted(ctx.owner)) throw new DomainError('FORBIDDEN', 'Personal Paotui read requires local identity');
    const query = this.query(input); const result = await this.reader.query(query, signal) as Record<string, unknown>;
    if (query.action === 'preview' && !total(result)) return { kind: 'unavailable', reason: '配送总费用无法核实，不能把缺失费用当作零。' };
    const { action, ...normalized } = query;
    return { kind: 'ready', input: normalized, details: { readOnly: true, queryKind: action, resultDigest: digest(result) }, facts: { totalPrice: total(result), conditions: ['execution.no_order'] }, evidenceRefs: [`meituan:read:${digest(result)}`],
      observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), privateData: { query, result } };
  }
  async execute(ctx: AdapterContext, plan: ExecutionPlan, data: unknown, signal: AbortSignal): Promise<Delivery> {
    const payload = data as { query: PaotuiQuery; result: Record<string, unknown> };
    let result = payload.result;
    if (payload.query.action === 'preview') { result = await this.reader.query(payload.query, signal) as Record<string, unknown>; if (digest(result) !== digest(payload.result)) throw new ReplanRequired('Paotui quote or address snapshot changed; refresh the plan'); }
    return { artifact: { id: randomUUID(), name: `${PAOTUI_READ_CAPABILITIES[this.capabilityIndex]!.ref.id}.json`, data: { goal: ctx.request.originalGoal, deliverable: '只读结果已取得；不代表订单、支付或履约完成。', execution: 'completed', result } }, facts: { totalPrice: total(result), conditions: ['execution.no_order'] }, evidenceRefs: [`meituan:read:${digest(result)}`] };
  }
  verify(_ctx: AdapterContext, _plan: ExecutionPlan, data: unknown, delivery: Delivery) {
    const payload = data as { query: PaotuiQuery; result: Record<string, unknown> }; const result = delivery.artifact.data.result as Record<string, unknown>;
    const accepted = result?.source === 'meituan' && (payload.query.action === 'preview' ? result.previewOnly === true && result.orderCreated === false && digest(total(result)) === digest(total(payload.result)) : result.readOnly === true && digest(result) === digest(payload.result));
    return { accepted, reason: accepted ? 'Owner-scoped read receipt, source and no-order boundary verified; no fulfillment asserted' : 'Read receipt/source mismatch' };
  }
}
