// Synthetic model and PA wallet actors. The provider runs as a separate signed
// HTTP service; no Stripe, Link, real user wallet or live booking is contacted.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createBookingSandboxProvider } from '../../packages/capabilities/booking/sandbox.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { JobStore } from '../../packages/core/store.js';
import { digest } from '../../packages/core/delegation.js';
import type { PAPaymentRequest } from '../../packages/core/pa-payment.js';
import type { AgentPlanningContext, PlanningAccess, Reasoner } from '../../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../../packages/ontology/agent-actions.js';
import type { BookingEntityType, BookingSnapshot } from '../../packages/ontology/booking.js';
import type { Job } from '../../packages/core/domain.js';
import type { ObjectRef } from '../../packages/ontology/model.js';
import { backend, evidence, interpretation, owner, principal } from '../backend-fixture.js';
import { commerceDecision as decision, commerceStep as step } from './commerce-agent.js';

export const bookingProgramRef = { id: 'booking.pa-payment.sandbox', version: '1' };
export function bookingReads(ctx: AgentPlanningContext, access: PlanningAccess) {
  access.session.call('describe_ontology', { search: 'BookingTask', limit: 1 });
  access.session.call('query_ontology', { object: ctx.state.scope });
  const last = (type: BookingEntityType) => {
    const ref = ctx.state.observations.filter(r => r.type === type).at(-1); if (!ref) return;
    const read = access.session.call('query_ontology', { object: ref }) as { items: { properties: { snapshot: BookingSnapshot } }[] };
    const status = access.session.call('evaluate_ontology', { function: 'bookingObservationStatus', object: ref }) as { status: string; value?: Record<string, any> };
    return { ref, snapshot: read.items[0]!.properties.snapshot, status: status.status === 'known' ? status.value! : undefined };
  };
  return { last };
}
export function bookingChoice(ctx: AgentPlanningContext, access: PlanningAccess): AgentDecision {
  const { last } = bookingReads(ctx, access), scope = ctx.state.scope;
  const booking = last('BookingObservation');
  if (!booking) {
    const offers = last('BookingOffers');
    if (!offers) return decision(ctx, [step('offers', 'SearchBookingOffers', { scope, query: 'consultation' })]);
    const offered = offers.snapshot.payload.data.offers as { id: string }[];
    if (!offered.length) return { ...decision(ctx), kind: 'no_feasible_plan', message: 'The configured synthetic provider has no matching appointment offers.' };
    return decision(ctx, [step('reserve', 'CreatePendingBooking', { scope, offers: offers.ref, offerId: offered[0]!.id })]);
  }
  if (!booking.snapshot.payload.data.independentRead) return decision(ctx, [step('read_booking', 'ReadProviderBooking', { scope, booking: booking.ref })]);
  if (!ctx.state.paPayment) {
    if (booking.snapshot.payload.data.state !== 'awaiting_payment') return { ...decision(ctx), kind: 'no_feasible_plan', message: 'The original booking is not awaiting payment.' };
    const unpaid = last('BookingPaymentObservation');
    if (!unpaid) return decision(ctx, [step('read_unpaid', 'ReadProviderPayment', { scope, booking: booking.ref })]);
    if (unpaid.snapshot.payload.data.state !== 'unpaid') return { ...decision(ctx), kind: 'no_feasible_plan', message: 'The provider has already received or started a payment; do not ask the PA to pay again.' };
    return decision(ctx, [step('handoff', 'RequestPAPayment', { scope, booking: booking.ref, payment: unpaid.ref })]);
  }
  const payment = last('BookingPaymentObservation'), sequence = ctx.state.paPayment.readbackSequence;
  const needBooking = booking.snapshot.receipt.readbackSequence !== sequence, needPayment = !payment || payment.snapshot.receipt.readbackSequence !== sequence;
  if (needBooking || needPayment) return decision(ctx, [...(needBooking ? [step('read_booking', 'ReadProviderBooking', { scope, booking: booking.ref })] : []), ...(needPayment ? [step('read_payment', 'ReadProviderPayment', { scope, booking: booking.ref })] : [])]);
  if (['expired', 'canceled'].includes(String(booking.snapshot.payload.data.state)) || payment.snapshot.payload.data.state === 'refunded') return { ...decision(ctx), kind: 'no_feasible_plan', message: 'Independent provider facts show that the original booking/payment cannot be confirmed.' };
  if (booking.status?.status === 'confirmed' && payment.status?.paid) return decision(ctx, [], { booking: booking.ref, payment: payment.ref, rationale: 'Independently read exact original provider booking and PA-funded payment' });
  return decision(ctx, [step('wait_pa', 'WaitForPAPayment', { scope, booking: booking.ref, payment: payment.ref })]);
}

/** This actor holds only the PA fixture credential. EIGOS never receives it. */
export class FixturePAWallet {
  readonly attempts: { handoffId: string; key: string }[] = [];
  private keys = new Map<string, string>();
  constructor(private origin: string, private credential: string) {}
  async pay(request: PAPaymentRequest, approvedAmount = request.terms.amount) {
    const { digest: expected, ...body } = request;
    if (digest(body) !== expected || request.terms.environment !== 'sandbox' || request.terms.handler.endpoint !== this.origin + '/pa/payments' || Date.parse(request.terms.expiresAt) <= Date.now()) throw new Error('PA refuses changed, expired or unbound payment handoff');
    let key = this.keys.get(request.id); if (!key) { key = randomUUID(); this.keys.set(request.id, key); }
    this.attempts.push({ handoffId: request.id, key });
    const response = await fetch(request.terms.handler.endpoint, { method: 'POST', headers: { authorization: `Bearer ${this.credential}`, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ handoff: request, idempotencyKey: key, approvedAmount }), redirect: 'error' });
    if (!response.ok) throw new Error(`PA fixture payment rejected (${response.status})`);
    return response.json() as Promise<{ paymentState: string }>;
  }
}
export async function setupPABooking(options: { databasePath?: string; provider?: Awaited<ReturnType<typeof createBookingSandboxProvider>>; holdMs?: number; choice?: (ctx: AgentPlanningContext, access: PlanningAccess) => AgentDecision } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-pa-booking-')), provider = options.provider ?? await createBookingSandboxProvider({ holdMs: options.holdMs }), tokenFile = join(directory, 'source-token');
  writeFileSync(tokenFile, provider.sourceToken, { mode: 0o600 });
  const settings = { endpoint: provider.endpoint, tokenFile }, store = new JobStore(options.databasePath ?? ':memory:'), catalog = createExecutionCatalog({ store, bookingSandbox: settings });
  const model: Reasoner = { ground: async request => ({ decision: { ...interpretation(request, bookingProgramRef.id, { query: 'consultation', participants: 2, startsAt: null }), capabilityRef: bookingProgramRef }, evidence: evidence() }), plan: async () => { throw new Error('Legacy booking recipe must not run'); }, act: async (ctx, _signal, access) => { const result = (options.choice ?? bookingChoice)(ctx, access); return { decision: result, evidence: { ...evidence(), decisionDigest: digest(result) } }; } };
  const b = backend(catalog, model, store, { allowSandbox: true }), wallet = new FixturePAWallet(provider.endpoint, provider.paToken);
  const submit = (extra: object = {}) => b.submit({ goal: '在沙箱预约两人的咨询服务，预算 200 元；交给 PA 自己付款后，独立核验原付款和预约。', executionEnvironment: 'sandbox', requirements: [{ id: 'count', kind: 'quantity', role: 'participant_count', strength: 'hard', expected: { amount: '2', unit: 'person' } }, { id: 'budget', kind: 'budget', role: 'service_total', strength: 'hard', expected: { minor: '20000', currency: 'CNY' } }, { id: 'confirmed', kind: 'condition', strength: 'hard', expected: { predicate: 'booking.confirmed' } }, { id: 'paid', kind: 'condition', strength: 'hard', expected: { predicate: 'booking.payment_confirmed' } }], ...extra });
  const approve = (job: Job) => { const a = job.delegation!.authorizationRequest!; return b.tasks.authorize(principal, job.id, { requestId: randomUUID(), action: 'approve_plan', planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }); };
  const report = (job: Job, outcome: 'submitted' | 'unknown' | 'declined' | 'canceled' = 'submitted', requestId = randomUUID()) => { const request = job.delegation!.agent!.paPayment!.request; return b.tasks.reportPayment(principal, { action: 'report_payment_result', taskId: job.id, requestId, handoffId: request.id, handoffDigest: request.digest, outcome }); };
  const finish = async (id: string, autoApprove = true) => {
    const deadline = Date.now() + 60000; let iterations = 0;
    while (Date.now() < deadline && iterations < 60) {
      const job = store.get(owner, id);
      if (job.state === 'auth-required' && autoApprove) { approve(job); continue; }
      if (!['working', 'submitted'].includes(job.state)) return job;
      const claim = store.claim(['eigos.delegate'], 15000);
      if (!claim) { await pause(20); continue; }
      iterations++;
      try { await b.coordinator.run(claim, new AbortController().signal); } finally { store.release(claim); }
    }
    throw new Error('Booking fixture did not reach a bounded waiting/terminal state');
  };
  return { directory, provider, settings, store, catalog, model, b, wallet, submit, approve, report, finish, close: async () => { store.close(); if (!options.provider) await provider.close(); rmSync(directory, { recursive: true, force: true }); } };
}
