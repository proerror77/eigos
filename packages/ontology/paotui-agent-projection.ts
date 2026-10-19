import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { atomicPaotuiSchemas, atomicResultSchemas, atomicTool, type PaotuiOperation } from '../capabilities/paotui-atomic.js';
import { paotuiActionSchemas, paotuiObservationSchema, type PaotuiAction, type PaotuiObservation } from './paotui-agent.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectWrite, type LinkWrite } from './object-store.js';
import type { ObjectRef } from './model.js';

export const paotuiOperation: Record<PaotuiAction, PaotuiOperation> = { ReadSavedAddresses: 'get_address_list', ReadSavedAddressDetail: 'get_address_info', PreviewDeliveryQuote: 'delivery_preview' };
export function paotuiSummary(action: PaotuiAction, input: Record<string, unknown>, result: Record<string, unknown>, observedAt: string) {
  const base = { action, observedAt, expiresAt: new Date(Date.parse(observedAt) + 300000).toISOString(), noOrder: true as const, noPayment: true as const };
  if (action === 'ReadSavedAddresses') return { ...base, count: atomicResultSchemas.get_address_list.parse(result).addresses.length };
  if (action === 'ReadSavedAddressDetail') return { ...base, role: paotuiActionSchemas.ReadSavedAddressDetail.parse(input).role };
  const q = atomicResultSchemas.delivery_preview.parse(result), a = paotuiActionSchemas.PreviewDeliveryQuote.parse(input), [whole, fraction = ''] = q._previewTotal.split('.');
  return { ...base, totalPrice: { minor: String(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))), currency: 'CNY' as const }, weightKg: a.weightKg, service: a.service };
}
export function checkedPaotuiObservation(value: unknown): PaotuiObservation {
  const s = paotuiObservationSchema.parse(value), { contentDigest, ...body } = s, op = paotuiOperation[s.action];
  const args = paotuiActionSchemas[s.action].parse(s.actionInput), providerInput = atomicPaotuiSchemas[op].parse(s.providerInput), result = atomicResultSchemas[op].parse(s.result);
  if (digest(body) !== contentDigest || s.id !== s.receipt.id || s.receipt.operation !== op || s.receipt.tool !== atomicTool(op) || digest(s.receipt.sourceCalls) !== digest([op])
    || s.receipt.inputDigest !== digest(providerInput) || s.receipt.resultDigest !== digest(result) || digest(s.scope) !== digest(args.scope)
    || digest(s.summary) !== digest(paotuiSummary(s.action, s.actionInput, result, s.receipt.observedAt))
    || s.receipt.sourceConnectionDigest && s.receipt.sourceConnectionDigest !== s.connectionDigest) throw new DomainError('CONFLICT', 'Single-read source provenance is invalid');
  return s;
}
export function projectPaotuiObservation(graph: OntologyObjectStore, owner: string, value: unknown): ObjectRef {
  const s = checkedPaotuiObservation(value), root = { type: 'ServiceRequest', id: s.requestId }, subject = { type: 'PaotuiObservation', id: s.id };
  if (graph.read(owner, root).properties.revision !== s.requestRevision) throw new DomainError('CONFLICT', 'Source response belongs to an old request revision');
  const objects: ObjectWrite[] = [], sealed: ObjectWrite[] = [], links: LinkWrite[] = [], removeLinks: LinkWrite[] = [];
  const add = (ref: ObjectRef, displayTitle: string, properties: Record<string, unknown>, seal = false) => {
    try { graph.read(owner, ref); throw new DomainError('CONFLICT', 'Read observations are immutable'); } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
    const def = graph.model.object(ref.type), record = { ref, properties: { [def.primaryKey]: ref.id, displayTitle, ...properties } };
    objects.push(record); if (seal) sealed.push(record); return ref;
  };
  add(subject, '美团只读观察', { requestRevision: s.requestRevision, summary: s.summary, privateSnapshot: s }, true);
  links.push({ type: 'PaotuiObservationRequest', from: subject, to: root }, { type: 'PaotuiObservationTask', from: subject, to: s.scope });
  if (s.action === 'PreviewDeliveryQuote') {
    const a = paotuiActionSchemas.PreviewDeliveryQuote.parse(s.actionInput);
    const parcel = add({ type: 'Parcel', id: `paotui:${s.id}` }, '已声明物品', { contentsCategory: a.category, declaredContents: a.goodsName, declaredWeight: { amount: String(a.weightKg), unit: 'kg' } });
    // Opaque references identify the exact priced route without exposing addresses.
    const route = add({ type: 'DeliveryRoute', id: `paotui:${s.id}` }, '本人已选同城路线', { originSnapshot: { text: `owned-address:${a.sender.id}` }, destinationSnapshot: { text: `owned-address:${a.recipient.id}` }, selectedAt: s.summary.observedAt });
    const provider = add({ type: 'Provider', id: `paotui:${s.id}` }, '美团跑腿', { name: '美团跑腿' });
    const channel = add({ type: 'Channel', id: `paotui:${s.id}` }, '本人授权只读渠道', { name: '美团本人只读渠道', accessScope: ['read'], supportedOperationRefs: ['delivery_preview'] });
    const quote = add({ type: 'DeliveryQuote', id: s.id }, '美团费用预估', { observedAt: s.summary.observedAt, expiresAt: s.summary.expiresAt, validityBasis: 'local_refresh_limit', priceKind: 'estimate', pricingCompleteness: 'unknown', serviceLevel: a.service, quotedWeight: { amount: String(a.weightKg), unit: 'kg' }, requestRevision: s.requestRevision, parcelRevision: 1, routeRevision: 1,
      pricingTerms: { total: s.summary.totalPrice, scope: 'unknown', components: [] } }, true);
    for (const [type, from, to] of [['PaotuiObservationQuote', subject, quote], ['ParcelRequest', parcel, root], ['RouteRequest', route, root], ['QuoteParcel', quote, parcel], ['QuoteRoute', quote, route], ['OfferRequest', quote, root], ['OfferProvider', quote, provider], ['OfferChannel', quote, channel]] as const) links.push({ type, from, to });
    for (const old of graph.related(owner, root, 'selectedRoute', { remaining: 1000 }) ?? []) removeLinks.push({ type: 'SelectedRoute', from: root, to: old.ref });
    links.push({ type: 'SelectedRoute', from: root, to: route });
  }
  const receipt = { type: 'SourceReceipt', id: `paotui:${s.id}` };
  add(receipt, '美团单次查询回执', { sourceIdentity: 'meituan-paotui:official-cli', sourceEventId: s.receipt.id, scope: 'delivery_quote', observedAt: s.receipt.observedAt, evidenceLevel: s.receipt.evidenceKind === 'fixture' ? 'synthetic' : 'live_readonly', contentDigest: s.contentDigest,
    subjects: sealed.map(o => ({ object: o.ref, digest: digest(Object.fromEntries(Object.entries(o.properties).filter(([k]) => !graph.model.object(o.ref.type).properties[k]?.restricted))), linksDigest: linkSnapshotDigest(o.ref, links) })), safeSummary: `一次模型选择的 ${s.receipt.operation} 只读调用；未下单付款` });
  links.push({ type: 'ReceiptRequest', from: receipt, to: root });
  for (const o of sealed) links.push({ type: `${o.ref.type}Evidence`, from: o.ref, to: receipt });
  graph.ingest(owner, { objects, links, removeLinks }, { kind: s.receipt.evidenceKind === 'fixture' ? 'synthetic' : 'provider', id: s.receipt.id, observedAt: s.receipt.observedAt });
  return subject;
}
