import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentActionContext } from '../core/agent-program.js';
import { objectRefSchema, type ObjectRef } from './model.js';
import { sourceProof } from './object-evidence.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectWrite, type LinkWrite, type ReadBudget } from './object-store.js';
import { bookingEntitySchemas, bookingSnapshotSchema, bookingDataSchema, bookingPaymentDataSchema, type BookingSnapshot, type BookingSourceResult } from './booking.js';
import type { Computation } from './object-functions.js';

function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
export function checkedBookingSnapshot(raw: unknown): BookingSnapshot {
  const s = bookingSnapshotSchema.parse(raw), { contentDigest, ...body } = s;
  bookingEntitySchemas[s.payload.type].parse(s.payload.data);
  if (digest(body) !== contentDigest || s.receipt.payloadDigest !== digest(s.payload)) fail('Booking source content changed');
  return s;
}
export function readBookingObservation(graph: OntologyObjectStore, owner: string, ref: ObjectRef, options: { historical?: boolean; budget?: ReadBudget; depth?: number } = {}): BookingSnapshot {
  if (!Object.hasOwn(bookingEntitySchemas, ref.type) || (options.depth ?? 0) > 40) fail('Expected a bounded booking source observation');
  const budget = options.budget ?? { remaining: 5000 }, record = graph.read(owner, ref, budget), s = checkedBookingSnapshot(record.properties.snapshot);
  const at = options.historical ? Date.parse(s.receipt.receivedAt) : graph.now(), proof = sourceProof(graph, owner, ref, budget);
  if (s.payload.type !== ref.type || !same(record.properties.data, s.payload.data) || s.receipt.ownerDigest !== digest(owner) || !proof || proof.levels.some(l => l !== 'synthetic') || Date.parse(s.receipt.startedAt) > Date.parse(s.receipt.receivedAt) || Date.parse(s.receipt.receivedAt) > at || Date.parse(s.payload.expiresAt) <= at) fail('Booking source facts are unproven, changed or expired');
  const scopes = graph.related(owner, ref, 'scope', budget), requests = graph.related(owner, ref, 'request', budget);
  if (scopes?.length !== 1 || !same(scopes[0]!.ref, s.scope) || scopes[0]!.properties.configurationDigest !== s.configurationDigest || scopes[0]!.properties.requestRevision !== s.receipt.requestRevision || requests?.length !== 1 || requests[0]!.ref.id !== s.receipt.requestId || requests[0]!.properties.revision !== s.receipt.requestRevision) fail('Booking source is outside its owned request or configuration');
  const observedData = (value: BookingSnapshot) => { const { independentRead: _read, ...data } = value.payload.data; return data; };
  for (const otherRecord of graph.related(owner, s.scope, `observed${s.payload.type}`, budget) ?? []) {
    if (same(otherRecord.ref, ref)) continue;
    const other = checkedBookingSnapshot(otherRecord.properties.snapshot);
    if (other.payload.sourceId === s.payload.sourceId && other.receipt.sourceIdentity === s.receipt.sourceIdentity && Date.parse(other.receipt.receivedAt) <= at && sourceProof(graph, owner, otherRecord.ref, budget) && (other.payload.sourceVersion > s.payload.sourceVersion || other.payload.sourceVersion === s.payload.sourceVersion && !same(observedData(other), observedData(s)))) fail('A newer or conflicting provider state supersedes this observation');
  }
  for (const dependency of s.dependencies) {
    const original = readBookingObservation(graph, owner, dependency.ref, { historical: true, budget, depth: (options.depth ?? 0) + 1 });
    if (original.contentDigest !== dependency.contentDigest || !same(original.scope, s.scope) || original.receipt.requestId !== s.receipt.requestId) fail('Booking dependency does not match its original task');
    const link = s.payload.type === 'BookingPaymentObservation' ? 'booking' : dependency.ref.type === 'BookingOffers' ? 'offers' : 'original';
    const linked = graph.related(owner, ref, link, budget);
    if (linked?.length !== 1 || !same(linked[0]!.ref, dependency.ref)) fail('Booking source dependency relationship changed');
    if (original.payload.type === 'BookingObservation') {
      const agreed = bookingDataSchema.parse(original.payload.data);
      if (s.payload.type === 'BookingObservation') {
        const observed = bookingDataSchema.parse(s.payload.data);
        if (observed.bookingId !== agreed.bookingId || observed.providerId !== agreed.providerId || observed.termsDigest !== agreed.termsDigest || observed.holdExpiresAt !== agreed.holdExpiresAt) fail('Provider changed the original booked agreement');
      } else if (s.payload.type === 'BookingPaymentObservation') {
        const observed = bookingPaymentDataSchema.parse(s.payload.data);
        if (observed.bookingId !== agreed.bookingId || observed.providerId !== agreed.providerId || observed.bookingTermsDigest !== agreed.termsDigest || observed.payeeId !== agreed.paymentHandler.payeeId || !same(observed.amount, agreed.offer.total)) fail('Provider payment is not bound to the original booked agreement');
      }
    }
  }
  if (s.payload.type === 'BookingObservation') {
    const b = bookingDataSchema.parse(s.payload.data);
    if (b.providerId !== s.receipt.sourceIdentity || b.termsDigest !== digest({ offer: b.offer, paymentHandler: b.paymentHandler, checkout: b.checkout }) || b.providerId !== b.offer.providerId) fail('Original booking terms or provider identity changed');
  } else if (s.payload.type === 'BookingPaymentObservation' && s.payload.data.providerId !== s.receipt.sourceIdentity) fail('Payment source identity changed');
  return s;
}
export function bookingObservationStatus(graph: OntologyObjectStore, owner: string, ref: ObjectRef, budget?: ReadBudget) {
  const s = readBookingObservation(graph, owner, ref, { budget });
  if (s.payload.type === 'BookingOffers') return { status: 'known', data: s.payload.data, evidenceLevel: 'synthetic' };
  if (s.payload.type === 'BookingObservation') {
    const b = bookingDataSchema.parse(s.payload.data), independent = b.independentRead && s.receipt.action === 'ReadProviderBooking';
    return { status: b.state, independentRead: independent, readyForPayment: independent && b.state === 'awaiting_payment' && b.offer.feesComplete && Date.parse(b.holdExpiresAt) > graph.now(), data: b, evidenceLevel: 'synthetic' };
  }
  const p = bookingPaymentDataSchema.parse(s.payload.data);
  return { status: p.state, independentRead: s.receipt.action === 'ReadProviderPayment', paid: p.state === 'paid' && !!p.paymentId && !!p.capturedAt && Date.parse(p.capturedAt) <= graph.now() && same(p.amount, p.paidAmount), data: p, evidenceLevel: 'synthetic' };
}
export function evaluateBookingFunction(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'bookingObservationStatus') return;
  try { return { status: 'known', value: bookingObservationStatus(graph, owner, input.object, budget), evidenceRefs: [input.object], evidenceLevels: ['synthetic'] }; }
  catch (error) { return { status: 'unknown', reason: error instanceof DomainError ? error.message : 'Booking source evidence validation failed', evidenceRefs: [input.object], evidenceLevels: [] }; }
}
export function projectBookingObservation(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: BookingSourceResult): ObjectRef {
  const receipt = result.receipt;
  if (receipt.ownerDigest !== digest(ctx.owner) || receipt.requestId !== ctx.request.id || receipt.requestRevision !== ctx.request.revision || receipt.planId !== ctx.planId || receipt.intentId !== ctx.intentId || receipt.attemptId !== ctx.attemptId || receipt.modelRunId !== ctx.modelRunId || receipt.operationKey !== ctx.operationKey || receipt.action !== action || receipt.payloadDigest !== digest(result.payload)) fail('Booking receipt is not bound to the original owned attempt');
  if (action === 'CreatePendingBooking') {
    const offers = readBookingObservation(ctx.graph, ctx.owner, objectRefSchema.parse(input.offers), { historical: true });
    const selected = bookingEntitySchemas.BookingOffers.parse(offers.payload.data).offers.find(o => o.id === input.offerId);
    const booked = bookingDataSchema.parse(result.payload.data);
    if (!selected || !same(selected, booked.offer) || booked.providerId !== selected.providerId || booked.state !== 'awaiting_payment') fail('The provider did not create the exact selected unpaid booking');
  }
  const dependencies = Object.entries(input).flatMap(([key, value]) => {
    const ref = objectRefSchema.safeParse(value); if (key === 'scope' || !ref.success) return [];
    const original = readBookingObservation(ctx.graph, ctx.owner, ref.data, { historical: true });
    if (!same(original.scope, ctx.state.scope)) fail('Booking dependency belongs to another task');
    return [{ ref: ref.data, contentDigest: original.contentDigest }];
  });
  const base = { ...result, scope: ctx.state.scope, configurationDigest: ctx.state.programDigest, dependencies, evidenceLevel: 'synthetic' as const };
  const snapshot = bookingSnapshotSchema.parse({ ...base, contentDigest: digest(base) });
  const ref = { type: result.payload.type, id: digest({ scope: ctx.state.scope, receipt: receipt.id, type: result.payload.type }) }, root = { type: 'ServiceRequest', id: ctx.request.id };
  const object: ObjectWrite = { ref, properties: { id: ref.id, displayTitle: result.payload.type, requestRevision: ctx.request.revision, data: result.payload.data, snapshot } };
  const links: LinkWrite[] = [{ type: `${ref.type}Request`, from: ref, to: root }, { type: `${ref.type}Scope`, from: ref, to: ctx.state.scope }, ...dependencies.map(d => ({ type: ref.type === 'BookingPaymentObservation' ? 'BookingPaymentBooking' : d.ref.type === 'BookingOffers' ? 'BookingSelectedOffers' : 'BookingOriginalObservation', from: ref, to: d.ref }))];
  const source = { type: 'SourceReceipt', id: digest({ object: ref, receipt: receipt.id }) };
  const sealed: ObjectWrite = { ref: source, properties: { receiptId: source.id, displayTitle: '预约服务商沙箱来源回执', sourceIdentity: receipt.sourceIdentity, sourceEventId: receipt.id, scope: ref.type === 'BookingPaymentObservation' ? 'payment' : 'reservation', observedAt: receipt.receivedAt, evidenceLevel: 'synthetic', contentDigest: receipt.responseSha256, subjects: [{ object: ref, digest: digest(object.properties), linksDigest: linkSnapshotDigest(ref, links) }], safeSummary: '独立服务商模拟状态；PA 的通知不作为付款或预约成功证据' } };
  links.push({ type: `${ref.type}Evidence`, from: ref, to: source }, { type: 'ReceiptRequest', from: source, to: root });
  ctx.graph.ingest(ctx.owner, { objects: [object, sealed], links }, { kind: 'synthetic', id: receipt.sourceIdentity, observedAt: receipt.receivedAt });
  readBookingObservation(ctx.graph, ctx.owner, ref);
  return ref;
}
