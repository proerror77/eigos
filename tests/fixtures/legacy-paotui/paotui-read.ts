// Historical fixture only: never registered or packaged by the production Worker.
import { randomUUID } from 'node:crypto';
import type { AdapterContext, ExecutionAdapter, Preparation, Delivery } from '../../../packages/core/catalog.js';
import { digest } from '../../../packages/core/delegation.js';
import { DomainError, ReplanRequired } from '../../../packages/core/domain.js';
import type { ExecutionPlan } from '../../../packages/ontology/execution.js';
import { PAOTUI_READ_BINDINGS, PAOTUI_READ_CAPABILITIES, paotuiReadDefinitions } from './paotui-ontology.js';
export { PAOTUI_READ_BINDINGS, PAOTUI_READ_CAPABILITIES } from './paotui-ontology.js';
import { paotuiQuerySchema, type PaotuiReader, type PaotuiQuery } from '../../../packages/capabilities/paotui-contracts.js';
function total(result: Record<string, unknown>) {
  const quote = result.quote as Record<string, unknown> | undefined; const text = String(quote?._previewTotal ?? '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return undefined; const [whole, fraction = ''] = text.split('.');
  return { minor: (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))).toString(), currency: 'CNY' };
}
function quotedQuantity(result: Record<string, unknown>) {
  const weight = (result.goods as { weightKg?: unknown } | undefined)?.weightKg;
  return typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? { amount: String(weight), unit: '公斤' } : undefined;
}
function snapshot(result: Record<string, unknown>) {
  const { ontologyReceipt: _receipt, ...business } = result;
  // A display-only arrival estimate naturally moves as time passes; price/route/service still pin the quote.
  if (business.quote && typeof business.quote === 'object') {
    const { estimateTime: _estimate, ...commercial } = business.quote as Record<string, unknown>;
    return { ...business, quote: commercial };
  }
  return business;
}
function readFacts(query: PaotuiQuery, result: Record<string, unknown>) {
  return { totalPrice: total(result), quantity: quotedQuantity(result), conditions: ['execution.no_order'],
    // This is the scope of the evidenced query, not a verified destination or geofence.
    ...(query.action === 'search_address' ? { searchArea: { city: query.city, keyword: query.keyword } } : {}) };
}
export class PaotuiReadAdapter implements ExecutionAdapter {
  readonly id: string;
  constructor(private capabilityIndex: number, private reader: PaotuiReader) { this.id = PAOTUI_READ_BINDINGS[capabilityIndex]!.adapterId; }
  permitted(owner: string) { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  private query(input: unknown): PaotuiQuery {
    const definition = paotuiReadDefinitions[this.capabilityIndex]!;
    const parsed = definition.schema.parse(input);
    return paotuiQuerySchema.parse({ action: definition.kind === 'geo' ? 'search_address' : definition.kind === 'quote' ? 'preview' : 'addresses', ...parsed });
  }

  async prepare(ctx: AdapterContext, input: unknown, signal: AbortSignal): Promise<Preparation> {
    if (!this.permitted(ctx.owner)) throw new DomainError('FORBIDDEN', 'Personal Paotui read requires local identity');
    const query = this.query(input); const result = await this.reader.query(query, signal) as Record<string, unknown>;
    if (result.source !== 'meituan' || (query.action === 'preview' ? result.previewOnly !== true || result.orderCreated !== false : result.readOnly !== true)) return { kind: 'unavailable', reason: '只读来源回执无法核实。' };
    if (query.action === 'preview' && !total(result)) return { kind: 'unavailable', reason: '配送总费用无法核实，不能把缺失费用当作零。' };
    if (query.action === 'preview') {
      const goods = result.goods as Record<string, unknown> | undefined;
      if (goods?.weightKg !== query.weightKg || goods?.name !== query.goodsName || goods?.category !== query.category || result.service !== query.service) return { kind: 'unavailable', reason: '报价适用的物品、重量或服务与请求不一致。' };
    }
    const { action, ...normalized } = query;
    return { kind: 'ready', input: normalized, details: { readOnly: true, queryKind: action, evidenceKind: (result.ontologyReceipt as { evidenceKind?: string } | undefined)?.evidenceKind ?? 'fixture', resultDigest: digest(snapshot(result)), ...(result.ontologyReceipt ? { ontologyReceipt: result.ontologyReceipt } : {}) }, facts: readFacts(query, result), evidenceRefs: [`meituan:read:${digest(snapshot(result))}`],
      observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), privateData: { query, result } };
  }
  async execute(ctx: AdapterContext, plan: import('../../../packages/core/catalog.js').AdapterPlan, data: unknown, signal: AbortSignal): Promise<Delivery> {
    const payload = data as { query: PaotuiQuery; result: Record<string, unknown> };
    let result = payload.result;
    if (payload.query.action === 'preview') { result = await this.reader.query(payload.query, signal) as Record<string, unknown>; if (digest(snapshot(result)) !== digest(snapshot(payload.result))) throw new ReplanRequired('Paotui quote or address snapshot changed; refresh the plan'); }
    return { artifact: { id: randomUUID(), name: `${PAOTUI_READ_CAPABILITIES[this.capabilityIndex]!.ref.id}.json`, data: { goal: ctx.request.originalGoal, deliverable: '只读结果已取得；不代表订单、支付或履约完成。', execution: 'completed', result } }, facts: readFacts(payload.query, result), evidenceRefs: [`meituan:read:${digest(snapshot(result))}`] };
  }
  verify(_ctx: AdapterContext, _plan: import('../../../packages/core/catalog.js').AdapterPlan, data: unknown, delivery: Delivery) {
    const payload = data as { query: PaotuiQuery; result: Record<string, unknown> }; const result = delivery.artifact.data.result as Record<string, unknown>;
    const accepted = result?.source === 'meituan' && digest(snapshot(result)) === digest(snapshot(payload.result)) && (payload.query.action === 'preview' ? result.previewOnly === true && result.orderCreated === false : result.readOnly === true);
    return { accepted, reason: accepted ? 'Owner-scoped read receipt, source and no-order boundary verified; no fulfillment asserted' : 'Read receipt/source mismatch' };
  }
}
