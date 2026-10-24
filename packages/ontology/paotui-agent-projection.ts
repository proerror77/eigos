import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { atomicPaotuiSchemas, atomicResultSchemas, atomicTool, type PaotuiOperation } from '../capabilities/paotui-atomic.js';
import { paotuiActionSchemas, legacyPaotuiActionSchemas, paotuiObservationSchema, type PaotuiAction, type PaotuiObservation, type PaotuiQuoteContext } from './paotui-agent.js';
import { matchesPaotuiSnapshot } from './paotui-business-context.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectWrite, type LinkWrite } from './object-store.js';
import type { ObjectRef } from './model.js';

export const paotuiOperation: Record<PaotuiAction, PaotuiOperation> = { ReadSavedAddresses: 'get_address_list', ReadSavedAddressDetail: 'get_address_info', PreviewDeliveryQuote: 'delivery_preview' };
export function paotuiSummary(action: PaotuiAction, input: Record<string, unknown>, result: Record<string, unknown>, observedAt: string, inputState?: PaotuiQuoteContext) {
  const base = { action, observedAt, expiresAt: new Date(Date.parse(observedAt) + 300000).toISOString(), noOrder: true as const, noPayment: true as const };
  if (action === 'ReadSavedAddresses') return { ...base, count: atomicResultSchemas.get_address_list.parse(result).addresses.length };
  if (action === 'ReadSavedAddressDetail') return { ...base, role: paotuiActionSchemas.ReadSavedAddressDetail.parse(input).role };
  const q = atomicResultSchemas.delivery_preview.parse(result), a = inputState?.facts ?? legacyPaotuiActionSchemas.PreviewDeliveryQuote.parse(input), [whole, fraction = ''] = q._previewTotal.split('.');
  return { ...base, totalPrice: { minor: String(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))), currency: 'CNY' as const }, weightKg: a.weightKg, service: a.service };
}
export function checkedPaotuiObservation(value: unknown): PaotuiObservation {
  const s = paotuiObservationSchema.parse(value), { contentDigest, ...body } = s, op = paotuiOperation[s.action];
  const args = (s.inputState ? paotuiActionSchemas : legacyPaotuiActionSchemas)[s.action].parse(s.actionInput), providerInput = atomicPaotuiSchemas[op].parse(s.providerInput), result = atomicResultSchemas[op].parse(s.result);
  if (s.inputState) {
    if (s.action !== 'PreviewDeliveryQuote') throw new DomainError('CONFLICT', 'Only a quote binds priced business objects');
    const a = paotuiActionSchemas.PreviewDeliveryQuote.parse(s.actionInput);
    if (digest(a.parcel) !== digest(s.inputState.parcel.ref) || digest(a.route) !== digest(s.inputState.route.ref)
      || Object.entries(s.inputState.facts).some(([key, value]) => digest(value) !== digest(providerInput[key as keyof typeof providerInput])))
      throw new DomainError('CONFLICT', 'Priced object snapshots differ from the exact source input');
  }
  if (digest(body) !== contentDigest || s.id !== s.receipt.id || s.receipt.operation !== op || s.receipt.tool !== atomicTool(op) || digest(s.receipt.sourceCalls) !== digest([op])
    || s.receipt.inputDigest !== digest(providerInput) || s.receipt.resultDigest !== digest(result) || digest(s.scope) !== digest(args.scope)
    || digest(s.summary) !== digest(paotuiSummary(s.action, s.actionInput, result, s.receipt.observedAt, s.inputState))
    || s.receipt.sourceConnectionDigest && s.receipt.sourceConnectionDigest !== s.connectionDigest) throw new DomainError('CONFLICT', 'Single-read source provenance is invalid');
  return s;
}
export function projectPaotuiObservation(graph: OntologyObjectStore, owner: string, value: unknown, business: { addresses?: ObjectRef[]; address?: ObjectRef } = {}): ObjectRef {
  const s = checkedPaotuiObservation(value), root = { type: 'ServiceRequest', id: s.requestId }, subject = { type: 'PaotuiObservation', id: s.id };
  if (graph.read(owner, root).properties.revision !== s.requestRevision) throw new DomainError('CONFLICT', 'Source response belongs to an old request revision');
  const objects: ObjectWrite[] = [], sealed: ObjectWrite[] = [], links: LinkWrite[] = [];
  const add = (ref: ObjectRef, displayTitle: string, properties: Record<string, unknown>, seal = false) => {
    try { graph.read(owner, ref); throw new DomainError('CONFLICT', 'Read observations are immutable'); } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
    const def = graph.model.object(ref.type), record = { ref, properties: { [def.primaryKey]: ref.id, displayTitle, ...properties } };
    objects.push(record); if (seal) sealed.push(record); return ref;
  };
  add(subject, '美团只读观察', { requestRevision: s.requestRevision, summary: s.summary, privateSnapshot: s }, true);
  links.push({ type: 'PaotuiObservationRequest', from: subject, to: root }, { type: 'PaotuiObservationTask', from: subject, to: s.scope });
  if (s.action === 'ReadSavedAddresses') for (const address of business.addresses ?? []) links.push({ type: 'PaotuiObservationAddresses', from: subject, to: address });
  if (s.action === 'ReadSavedAddressDetail' && business.address) links.push({ type: 'PaotuiObservationAddress', from: subject, to: business.address });
  if (s.action === 'PreviewDeliveryQuote') {
    const state = s.inputState;
    if (!state || [state.parcel, state.route, state.senderAddress, state.recipientAddress].some(snapshot => !matchesPaotuiSnapshot(graph, owner, snapshot))) throw new DomainError('CONFLICT', 'Priced business objects changed before quote projection');
    const quote = add({ type: 'DeliveryQuote', id: s.id }, '美团费用预估', { observedAt: s.summary.observedAt, expiresAt: s.summary.expiresAt, validityBasis: 'local_refresh_limit', priceKind: 'estimate', pricingCompleteness: 'unknown', serviceLevel: state.facts.service, quotedWeight: { amount: String(state.facts.weightKg), unit: 'kg' }, requestRevision: s.requestRevision, parcelRevision: state.parcel.revision, routeRevision: state.route.revision,
      pricingTerms: { total: s.summary.totalPrice, scope: 'unknown', components: [] } }, true);
    for (const [type, from, to] of [['PaotuiObservationQuote', subject, quote], ['QuoteParcel', quote, state.parcel.ref], ['QuoteRoute', quote, state.route.ref], ['OfferRequest', quote, root], ['OfferProvider', quote, state.provider], ['OfferChannel', quote, state.channel]] as const) links.push({ type, from, to });
  }
  const receipt = { type: 'SourceReceipt', id: `paotui:${s.id}` };
  add(receipt, '美团单次查询回执', { sourceIdentity: 'meituan-paotui:official-cli', sourceEventId: s.receipt.id, scope: 'delivery_quote', observedAt: s.receipt.observedAt, evidenceLevel: s.receipt.evidenceKind === 'fixture' ? 'synthetic' : 'live_readonly', contentDigest: s.contentDigest,
    subjects: sealed.map(o => ({ object: o.ref, digest: digest(Object.fromEntries(Object.entries(o.properties).filter(([k]) => !graph.model.object(o.ref.type).properties[k]?.restricted))), linksDigest: linkSnapshotDigest(o.ref, links) })), safeSummary: `一次模型选择的 ${s.receipt.operation} 只读调用；未下单付款` });
  links.push({ type: 'ReceiptRequest', from: receipt, to: root });
  for (const o of sealed) links.push({ type: `${o.ref.type}Evidence`, from: o.ref, to: receipt });
  graph.ingest(owner, { objects, links }, { kind: s.receipt.evidenceKind === 'fixture' ? 'synthetic' : 'provider', id: s.receipt.id, observedAt: s.receipt.observedAt });
  return subject;
}
