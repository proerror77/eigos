import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { digest } from './delegation.js';
import { DomainError, type Job } from './domain.js';
import { moneySchema } from '../ontology/execution.js';
import { objectRefSchema } from '../ontology/model.js';

const id = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/);
export const paPaymentTermsSchema = z.strictObject({
  providerId: id, bookingId: id, bookingTermsDigest: sha,
  booking: objectRefSchema.extend({ type: z.literal('BookingObservation') }),
  unpaidObservation: objectRefSchema.extend({ type: z.literal('BookingPaymentObservation') }),
  description: z.string().min(1).max(500), amount: moneySchema,
  handler: z.strictObject({ id, type: z.literal('sandbox.pa-wallet'), payeeId: id, endpoint: z.url().max(1000) }),
  expiresAt: z.iso.datetime({ offset: true }), environment: z.literal('sandbox'), evidenceLevel: z.literal('synthetic'),
});
export type PAPaymentTerms = z.infer<typeof paPaymentTermsSchema>;
export const paPaymentRequestSchema = z.strictObject({ id: sha, version: z.literal('1'), taskId: z.uuid(), requestRevision: z.number().int().positive(), ownerDigest: sha, configurationDigest: sha, createdAt: z.iso.datetime({ offset: true }), terms: paPaymentTermsSchema, digest: sha });
export type PAPaymentRequest = z.infer<typeof paPaymentRequestSchema>;
export const paPaymentReportSchema = z.strictObject({
  taskId: z.uuid(), requestId: z.uuid(), action: z.literal('report_payment_result'),
  handoffId: sha, handoffDigest: sha, outcome: z.enum(['submitted', 'declined', 'unknown', 'canceled']),
});
export type PAPaymentReport = z.infer<typeof paPaymentReportSchema>;
export interface PAPaymentState {
  request: PAPaymentRequest;
  readbackSequence: number;
  status: 'awaiting_pa' | 'reported' | 'awaiting_provider' | 'verified' | 'withdrawn';
  reports: { id: string; outcome: PAPaymentReport['outcome']; receivedAt: string }[];
  recoveryAttempts?: number;
  recovery?: { observedAt: string; result: 'confirmed' | 'pending' | 'mismatch'; evidenceRefs: string[] };
}

/** This is a request for the PA to use its own payment capability. It is not a
 * Stripe credential, an EIGOS payment grant, or evidence that money moved. */
export function recordPAPaymentHandoff(job: Job, owner: string, objectId: string, raw: unknown, mode: 'request' | 'wait') {
  const terms = paPaymentTermsSchema.parse(raw), state = job.delegation!.agent!;
  if (job.delegation!.request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'PA payment handoff is isolated-test only');
  const existing = state.paPayment;
  if (mode === 'request') {
    if (existing) throw new DomainError('CONFLICT', 'An original payment handoff already exists');
    if (Date.parse(terms.expiresAt) <= Date.now()) throw new DomainError('CONFLICT', 'The provider booking hold expired before payment handoff');
    const body = { id: sha.parse(objectId), version: '1' as const, taskId: job.id, requestRevision: job.delegation!.request.revision, ownerDigest: digest(owner), configurationDigest: state.programDigest, createdAt: new Date().toISOString(), terms };
    state.paPayment = { request: { ...body, digest: digest(body) }, status: 'awaiting_pa', readbackSequence: 0, reports: [] };
  } else {
    if (!existing || existing.request.id !== objectId || digest(existing.request.terms) !== digest(terms)) throw new DomainError('CONFLICT', 'Wait must retain the original owned payment request');
    existing.status = existing.reports.length ? 'awaiting_provider' : 'awaiting_pa';
  }
  delete state.pendingPlanId;
  job.state = 'input-required'; job.delegation!.phase = 'awaiting_pa_payment'; job.delegation!.nextAt = 0;
  job.updatedAt = new Date().toISOString();
  job.question = mode === 'request' ? '沙箱预约已准备到待付款。请 PA 使用自己的测试支付能力处理此准确预约，再提交 report_payment_result；EIGOS 将独立回读模拟服务商结果，不得真实付款。' : '原模拟付款或预约尚未获得服务商完整确认。请查询原付款，不要重复付款；提交状态通知或请求回读后继续核验。';
  job.messages.push({ id: randomUUID(), role: 'agent', text: job.question, at: job.updatedAt });
  job.delegation!.events.push({ at: job.updatedAt, event: mode === 'request' ? 'pa_payment_requested' : 'pa_payment_waiting_for_provider', evidence: state.paPayment!.request.digest });
}
export function verifyPAPaymentRequest(job: Job, owner: string) {
  const state = job.delegation?.agent, payment = state?.paPayment;
  if (!state || !payment) throw new DomainError('CONFLICT', 'This task has no PA payment handoff');
  const { digest: expected, ...body } = paPaymentRequestSchema.parse(payment.request);
  if (digest(body) !== expected || body.taskId !== job.id || body.ownerDigest !== digest(owner) || body.requestRevision !== job.delegation!.request.revision || body.configurationDigest !== state.programDigest) throw new DomainError('CONFLICT', 'The original PA payment request changed');
  paPaymentTermsSchema.parse(body.terms);
  return payment;
}
