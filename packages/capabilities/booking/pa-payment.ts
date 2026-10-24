import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { digest } from '../../core/delegation.js';
import { DomainError, type Job } from '../../core/domain.js';
import { moneySchema } from '../../ontology/execution.js';
import { objectRefSchema } from '../../ontology/model.js';

const id = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/);
export const linkCheckoutSchema = z.strictObject({
  id, type: z.literal('link_checkout'), bookingId: id, payeeId: id,
  url: z.url().max(1000), supported: z.boolean(), userConfirmationRequired: z.literal(true),
});
export const paPaymentTermsSchema = z.strictObject({
  providerId: id, bookingId: id, bookingTermsDigest: sha,
  booking: objectRefSchema.extend({ type: z.literal('BookingObservation') }),
  unpaidObservation: objectRefSchema.extend({ type: z.literal('BookingPaymentObservation') }),
  description: z.string().min(1).max(500), amount: moneySchema,
  handler: z.strictObject({ id, type: z.literal('sandbox.pa-wallet'), payeeId: id, endpoint: z.url().max(1000), supported: z.boolean() }),
  checkout: linkCheckoutSchema, routePolicy: z.literal('prefer_link_agent_wallet'),
  expiresAt: z.iso.datetime({ offset: true }), environment: z.literal('sandbox'), evidenceLevel: z.literal('synthetic'),
});
export type PAPaymentTerms = z.infer<typeof paPaymentTermsSchema>;
export const paPaymentRequestSchema = z.strictObject({ id: sha, version: z.literal('2'), taskId: z.uuid(), requestRevision: z.number().int().positive(), ownerDigest: sha, configurationDigest: sha, createdAt: z.iso.datetime({ offset: true }), terms: paPaymentTermsSchema, digest: sha });
export type PAPaymentRequest = z.infer<typeof paPaymentRequestSchema>;
export const linkWalletAvailabilitySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), reason: z.literal('ready'), observedAt: z.iso.datetime({ offset: true }) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['region_unsupported', 'not_connected', 'connector_missing', 'wallet_unavailable']), observedAt: z.iso.datetime({ offset: true }) }),
  z.strictObject({ status: z.literal('unknown'), reason: z.literal('unknown'), observedAt: z.iso.datetime({ offset: true }) }),
]);
export type LinkWalletAvailability = z.infer<typeof linkWalletAvailabilitySchema>;
export const paPaymentRouteSchema = z.strictObject({
  taskId: z.uuid(), requestId: z.uuid(), action: z.literal('select_payment_route'),
  handoffId: sha, handoffDigest: sha, wallet: linkWalletAvailabilitySchema,
});
export const paPaymentSelectionSchema = z.strictObject({
  route: z.enum(['link_agent_wallet', 'link_checkout']),
  reason: z.enum(['wallet_ready', 'region_unsupported', 'not_connected', 'connector_missing', 'wallet_unavailable', 'merchant_wallet_unavailable']),
  wallet: linkWalletAvailabilitySchema, selectedAt: z.iso.datetime({ offset: true }),
  operationId: z.uuid(), handoffDigest: sha, digest: sha,
});
export type PAPaymentSelection = z.infer<typeof paPaymentSelectionSchema>;
/** Availability is the PA's observation of its own wallet, never payment proof.
 * Once a route has been issued, it may already be in use: do not switch it. */
export function choosePAPaymentRoute(terms: PAPaymentTerms, wallet: LinkWalletAvailability, at = Date.now()) {
  const observedAt = Date.parse(wallet.observedAt);
  if (observedAt > at || at - observedAt > 300_000) throw new DomainError('CONFLICT', 'Read the current PA wallet availability before selecting a payment route');
  if (!terms.handler.supported) {
    if (!terms.checkout.supported) throw new DomainError('CONFLICT', 'The original provider booking offers no usable Link payment route');
    return { route: 'link_checkout' as const, reason: 'merchant_wallet_unavailable' as const };
  }
  if (wallet.status === 'unknown') throw new DomainError('CONFLICT', 'Unknown wallet availability requires a fresh read; it is not a reason to start another payment');
  if (wallet.status === 'available') return { route: 'link_agent_wallet' as const, reason: 'wallet_ready' as const };
  if (!terms.checkout.supported) throw new DomainError('CONFLICT', 'The original provider booking offers no usable Link payment route');
  return { route: 'link_checkout' as const, reason: wallet.reason };
}
export const paPaymentReportSchema = z.strictObject({
  taskId: z.uuid(), requestId: z.uuid(), action: z.literal('report_payment_result'),
  handoffId: sha, handoffDigest: sha, outcome: z.enum(['submitted', 'declined', 'unknown', 'canceled']),
});
export type PAPaymentReport = z.infer<typeof paPaymentReportSchema>;
export interface PAPaymentState {
  request: PAPaymentRequest;
  readbackSequence: number;
  status: 'awaiting_pa' | 'awaiting_user' | 'reported' | 'awaiting_provider' | 'verified' | 'withdrawn';
  selection?: PAPaymentSelection;
  reports: { id: string; outcome: PAPaymentReport['outcome']; receivedAt: string }[];
  recoveryAttempts?: number;
  recovery?: { observedAt: string; result: 'confirmed' | 'pending' | 'mismatch'; evidenceRefs: string[] };
}

/** This is a request for the PA to use its own payment capability. It is not a
 * Stripe credential, an EIGOS payment grant, or evidence that money moved. */
export function recordPAPaymentHandoff(job: Job, owner: string, objectId: string, raw: unknown, mode: 'request' | 'wait', componentId?: string) {
  const terms = paPaymentTermsSchema.parse(raw), state = job.delegation!.agent!;
  if (job.delegation!.request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'PA payment handoff is isolated-test only');
  const component = componentId ? state.composition?.contexts.find(value => value.id === componentId) : undefined;
  if (state.composition && !component || componentId && !component) throw new DomainError('CONFLICT', 'Payment handoff requires its original component');
  const configurationDigest = component?.programDigest ?? state.programDigest;
  const existing = state.paPayment;
  if (mode === 'request') {
    if (existing) throw new DomainError('CONFLICT', 'An original payment handoff already exists');
    if (Date.parse(terms.expiresAt) <= Date.now()) throw new DomainError('CONFLICT', 'The provider booking hold expired before payment handoff');
    const body = { id: sha.parse(objectId), version: '2' as const, taskId: job.id, requestRevision: job.delegation!.request.revision, ownerDigest: digest(owner), configurationDigest, createdAt: new Date().toISOString(), terms };
    state.paPayment = { request: { ...body, digest: digest(body) }, status: 'awaiting_pa', readbackSequence: 0, reports: [] };
  } else {
    if (!existing || existing.request.id !== objectId || digest(existing.request.terms) !== digest(terms)) throw new DomainError('CONFLICT', 'Wait must retain the original owned payment request');
    existing.status = existing.reports.length ? 'awaiting_provider' : existing.selection?.route === 'link_checkout' ? 'awaiting_user' : 'awaiting_pa';
  }
  if (component) state.composition!.paymentContextId = component.id;
  delete state.pendingPlanId;
  job.state = 'input-required'; job.delegation!.phase = 'awaiting_pa_payment'; job.delegation!.nextAt = 0;
  job.updatedAt = new Date().toISOString();
  job.question = mode === 'request' ? '沙箱预约已准备到待付款。请 PA 检查自己的 Link Agent Wallet 可用性并调用 select_payment_route：可用时优先钱包，不可用时交给用户在服务商的普通 Link 测试结账页确认。不得真实付款；随后由 EIGOS 独立回读。' : '原模拟付款或预约尚未获得服务商完整确认。请查询原付款，不要重复付款或切换路线；提交状态通知或请求回读后继续核验。';
  job.messages.push({ id: randomUUID(), role: 'agent', text: job.question, at: job.updatedAt });
  job.delegation!.events.push({ at: job.updatedAt, event: mode === 'request' ? 'pa_payment_requested' : 'pa_payment_waiting_for_provider', evidence: state.paPayment!.request.digest });
}
export function verifyPAPaymentRequest(job: Job, owner: string) {
  const state = job.delegation?.agent, payment = state?.paPayment;
  if (!state || !payment) throw new DomainError('CONFLICT', 'This task has no PA payment handoff');
  const component = state.composition?.contexts.find(value => value.id === state.composition?.paymentContextId);
  if (state.composition && !component) throw new DomainError('CONFLICT', 'Original payment component is missing');
  const { digest: expected, ...body } = paPaymentRequestSchema.parse(payment.request);
  if (digest(body) !== expected || body.taskId !== job.id || body.ownerDigest !== digest(owner) || body.requestRevision !== job.delegation!.request.revision || body.configurationDigest !== (component?.programDigest ?? state.programDigest)) throw new DomainError('CONFLICT', 'The original PA payment request changed');
  paPaymentTermsSchema.parse(body.terms);
  verifyPAPaymentSelection(payment);
  return payment;
}

export function verifyPAPaymentSelection(payment: PAPaymentState) {
  if (!payment.selection) return;
  const { digest: selectionDigest, ...selected } = paPaymentSelectionSchema.parse(payment.selection);
  const expectedRoute = choosePAPaymentRoute(payment.request.terms, selected.wallet, Date.parse(selected.selectedAt));
  if (digest(selected) !== selectionDigest || selected.handoffDigest !== payment.request.digest || selected.route !== expectedRoute.route || selected.reason !== expectedRoute.reason) throw new DomainError('CONFLICT', 'The original payment route selection changed');
}

export function recordPAPaymentSelection(payment: PAPaymentState, wallet: LinkWalletAvailability): PAPaymentSelection {
  if (payment.selection || payment.reports.length || payment.status !== 'awaiting_pa') throw new DomainError('CONFLICT', 'A payment route or attempt already exists; reconcile the original payment instead of switching routes');
  if (Date.parse(payment.request.terms.expiresAt) <= Date.now()) throw new DomainError('CONFLICT', 'The original booking expired before payment route selection');
  const selectedAt = new Date().toISOString();
  const body = { ...choosePAPaymentRoute(payment.request.terms, wallet, Date.parse(selectedAt)), wallet, selectedAt, operationId: randomUUID(), handoffDigest: payment.request.digest };
  payment.selection = { ...body, digest: digest(body) };
  payment.status = body.route === 'link_checkout' ? 'awaiting_user' : 'awaiting_pa';
  return payment.selection;
}
