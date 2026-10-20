import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentActionContext } from '../core/agent-program.js';
import type { ObjectRef } from './model.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectWrite, type LinkWrite, type ReadBudget } from './object-store.js';
import { sourceProof } from './object-evidence.js';
import { checkedCommerceObservation, readCommerceObservation } from './commerce-journey-functions.js';
import { parseCommerceEntity, type CommerceObservation } from './commerce-journey.js';
import { stripePaymentObservationSchema, type StripePaymentObservation, type StripePaymentData } from './stripe-payment.js';
import type { Computation } from './object-functions.js';

const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
export function stripeOrderDigest(order: CommerceObservation) {
  const { independentRead: _read, ...contract } = parseCommerceEntity('CommerceOrderObservation', order.data);
  return digest(contract);
}
export function stripeTestCaptured(data: StripePaymentData) {
  const c = data.charge;
  return data.status === 'succeeded' && !data.hasPaymentError && data.amountReceived === data.amount.minor && !!c && c.paymentIntentId === data.paymentIntentId && equal(c.amount, data.amount) && c.paid && c.captured && !c.refunded && c.amountRefunded === '0' && !c.disputed && !c.livemode;
}
export function readStripePayment(graph: OntologyObjectStore, owner: string, ref: ObjectRef, options: { historical?: boolean; budget?: ReadBudget } = {}): StripePaymentObservation {
  if (ref.type !== 'StripePaymentObservation') return fail('Expected Stripe payment observation');
  const budget = options.budget ?? { remaining: 5000 }, record = graph.read(owner, ref, budget);
  const s = stripePaymentObservationSchema.parse(record.properties.snapshot), { contentDigest, ...body } = s;
  const proof = sourceProof(graph, owner, ref, budget), at = options.historical ? Date.parse(s.observedAt) : graph.now();
  if (digest(body) !== contentDigest || !equal(record.properties.data, s.data) || s.ownerDigest !== digest(owner) || !proof || proof.levels.some(l => l !== s.evidenceLevel) || Date.parse(s.observedAt) > at || Date.parse(s.expiresAt) <= at || s.receipts.some(r => Date.parse(r.startedAt) > Date.parse(r.receivedAt) || Date.parse(r.receivedAt) > Date.parse(s.observedAt))) return fail('Stripe payment evidence is unproven, changed or expired');
  const scopes = graph.related(owner, ref, 'scope', budget), requests = graph.related(owner, ref, 'request', budget), orders = graph.related(owner, ref, 'order', budget);
  if (scopes?.length !== 1 || !equal(scopes[0]!.ref, s.scope) || scopes[0]!.properties.configurationDigest !== s.configurationDigest || scopes[0]!.properties.requestRevision !== s.requestRevision || requests?.length !== 1 || requests[0]!.ref.id !== s.requestId || requests[0]!.properties.revision !== s.requestRevision || orders?.length !== 1 || !equal(orders[0]!.ref, s.order)) return fail('Stripe payment is outside its owned request, order or configuration');
  const rawOrder = checkedCommerceObservation(orders[0]!.properties.snapshot);
  const original = readCommerceObservation(graph, owner, s.order, { at: Date.parse(rawOrder.observedAt), budget });
  const order = parseCommerceEntity('CommerceOrderObservation', original.data);
  if (original.contentDigest !== s.orderContentDigest || !equal(original.scope, s.scope) || original.configurationDigest !== s.configurationDigest || original.action !== 'ReadCommerceOrder' || !order.independentRead || order.paymentProvider !== 'stripe_test' || order.state !== 'confirmed' || order.orderId !== s.data.orderId || order.merchantId !== s.data.merchantId || !equal(order.total, s.data.amount) || stripeOrderDigest(original) !== s.data.orderDigest) return fail('Stripe evidence does not match its independently read unpaid order');
  if (!s.receipts.some(r => r.path === '/v1/account' && r.method === 'GET')) return fail('Stripe account readback is missing');
  const last = s.receipts.at(-1)!;
  if (s.data.independentRead !== (s.action === 'ReadStripePayment') || s.data.independentRead && (last.method !== 'GET' || last.path !== `/v1/payment_intents/${s.data.paymentIntentId}`)) return fail('Stripe independent read provenance changed');
  for (const sibling of graph.related(owner, s.scope, 'stripePayments', budget) ?? []) {
    if (equal(sibling.ref, ref)) continue;
    const other = stripePaymentObservationSchema.parse(sibling.properties.snapshot);
    const { independentRead: _oldRead, ...oldData } = s.data, { independentRead: _newRead, ...newData } = other.data;
    if (other.data.paymentIntentId === s.data.paymentIntentId && Date.parse(other.observedAt) <= at && (Date.parse(other.observedAt) > Date.parse(s.observedAt) || other.observedAt === s.observedAt && !equal(oldData, newData)) && sourceProof(graph, owner, sibling.ref, budget)) return fail('A newer or conflicting Stripe observation supersedes this payment state');
  }
  return s;
}
export function stripePaymentStatus(graph: OntologyObjectStore, owner: string, ref: ObjectRef, budget?: ReadBudget) {
  const s = readStripePayment(graph, owner, ref, { budget });
  const status = s.data.independentRead && stripeTestCaptured(s.data) ? 'test_paid' : s.action === 'PrepareStripePayment' && s.data.status === 'requires_payment_method' && !s.data.hasPaymentError && s.data.amountReceived === '0' && !s.data.charge ? 'prepared' : s.data.status === 'canceled' || s.data.hasPaymentError ? 'failed' : 'pending';
  return { status, data: s.data, evidenceLevel: s.evidenceLevel, tokenSource: 'stripe_test_helper', bankSettlementVerified: false, realPayment: false };
}
export function evaluateStripePaymentFunction(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'stripePaymentStatus') return;
  try { const value = stripePaymentStatus(graph, owner, input.object, budget); return { status: 'known', value, evidenceRefs: [input.object], evidenceLevels: [value.evidenceLevel] }; }
  catch (error) { return { status: 'unknown', reason: error instanceof DomainError ? error.message : 'Stripe payment evidence validation failed', evidenceRefs: [input.object], evidenceLevels: [] }; }
}
export function projectStripePayment(ctx: AgentActionContext, action: string, raw: unknown): ObjectRef {
  const s = stripePaymentObservationSchema.parse(raw);
  if (s.ownerDigest !== digest(ctx.owner) || s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== ctx.state.programDigest || !equal(s.scope, ctx.state.scope) || s.action !== action || s.planId !== ctx.planId || s.intentId !== ctx.intentId || s.attemptId !== ctx.attemptId || s.modelRunId !== ctx.modelRunId || s.operationKey !== ctx.operationKey) return fail('Stripe receipt is not bound to the original owned attempt');
  const ref = { type: 'StripePaymentObservation', id: digest({ attempt: ctx.attemptId, payment: s.data.paymentIntentId, receipt: s.receipts.at(-1)!.requestId }) }, root = { type: 'ServiceRequest', id: ctx.request.id };
  const object: ObjectWrite = { ref, properties: { id: ref.id, displayTitle: 'Stripe 测试支付观测', requestRevision: ctx.request.revision, data: s.data, snapshot: s } };
  const receiptRef = { type: 'SourceReceipt', id: digest({ ref, stripe: s.contentDigest }) };
  const links: LinkWrite[] = [{ type: 'StripePaymentRequest', from: ref, to: root }, { type: 'StripePaymentScope', from: ref, to: ctx.state.scope }, { type: 'StripePaymentOrder', from: ref, to: s.order }];
  const receipt: ObjectWrite = { ref: receiptRef, properties: { receiptId: receiptRef.id, displayTitle: 'Stripe 测试 API 回执', safeSummary: s.evidenceLevel === 'synthetic' ? '隔离 Stripe API 契约测试；没有连接 Stripe' : 'Stripe 测试模式回执；没有真实支付、银行结算或履约', sourceIdentity: `stripe-test:${s.data.accountId}`, sourceEventId: s.receipts.at(-1)!.requestId, scope: 'payment', observedAt: s.observedAt, evidenceLevel: s.evidenceLevel, contentDigest: s.contentDigest, subjects: [{ object: ref, digest: digest(object.properties), linksDigest: linkSnapshotDigest(ref, links) }] } };
  links.push({ type: 'StripePaymentEvidence', from: ref, to: receiptRef }, { type: 'ReceiptRequest', from: receiptRef, to: root });
  ctx.graph.ingest(ctx.owner, { objects: [object, receipt], links }, { kind: s.evidenceLevel === 'synthetic' ? 'synthetic' : 'provider', id: `stripe-test:${s.data.accountId}`, observedAt: s.observedAt });
  // The enclosing task transaction rolls this projection back on any mismatch.
  readStripePayment(ctx.graph, ctx.owner, ref);
  return ref;
}
