import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { digest } from '../core/delegation.js';
import { DomainError, type Job } from '../core/domain.js';
import { moneySchema } from '../ontology/execution.js';
import { objectRefSchema } from '../ontology/model.js';

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
// Version 2 stays immutable for existing booking programs and historical models.
// Version 3 binds the same handoff lifecycle to a merchant checkout, while the
// PA chooses its own supported capability. No customer credential crosses it.
export const paCheckoutRouteSchema = z.strictObject({
  id: z.enum(['pa_vault', 'pa_payment_account']), type: z.literal('sandbox.pa-checkout'),
  endpoint: z.url().max(1000), supported: z.boolean(),
});
export const paCheckoutPaymentTermsSchema = z.strictObject({
  providerId: id, payeeId: id,
  resource: z.strictObject({ type: z.literal('shopify_checkout'), id, termsDigest: sha }),
  checkoutObservation: objectRefSchema.extend({ type: z.literal('ShopifyPaymentCheckoutObservation') }),
  unpaidObservation: objectRefSchema.extend({ type: z.literal('ShopifyCheckoutPaymentObservation') }),
  description: z.string().min(1).max(500), amount: moneySchema,
  checkout: z.strictObject({ id, type: z.literal('provider_checkout'), url: z.url().max(1000), testMode: z.literal(true) }),
  routes: z.array(paCheckoutRouteSchema).min(1).max(2), routePolicy: z.literal('pa_selects_authorized_capability'),
  expiresAt: z.iso.datetime({ offset: true }), environment: z.literal('sandbox'), evidenceLevel: z.literal('synthetic'),
}).refine(value => new Set(value.routes.map(route => route.id)).size === value.routes.length, 'Payment routes must be unique');
export type PACheckoutPaymentTerms = z.infer<typeof paCheckoutPaymentTermsSchema>;
export const paCheckoutPaymentRequestSchema = paPaymentRequestSchema.extend({ version: z.literal('3'), terms: paCheckoutPaymentTermsSchema });
export type PACheckoutPaymentRequest = z.infer<typeof paCheckoutPaymentRequestSchema>;
export const paHandoffRequestSchema = z.discriminatedUnion('version', [paPaymentRequestSchema, paCheckoutPaymentRequestSchema]);
export const paHandoffTermsSchema = z.union([paPaymentTermsSchema, paCheckoutPaymentTermsSchema]);
export type PAHandoffRequest = z.infer<typeof paHandoffRequestSchema>;
export const paCheckoutCapabilitySchema = z.strictObject({
  route: z.enum(['pa_vault', 'pa_payment_account']), status: z.literal('available'),
  environment: z.literal('sandbox'), observedAt: z.iso.datetime({ offset: true }),
});
export type PACheckoutCapability = z.infer<typeof paCheckoutCapabilitySchema>;
export const linkWalletAvailabilitySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), reason: z.literal('ready'), observedAt: z.iso.datetime({ offset: true }) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['region_unsupported', 'not_connected', 'connector_missing', 'wallet_unavailable']), observedAt: z.iso.datetime({ offset: true }) }),
  z.strictObject({ status: z.literal('unknown'), reason: z.literal('unknown'), observedAt: z.iso.datetime({ offset: true }) }),
]);
export type LinkWalletAvailability = z.infer<typeof linkWalletAvailabilitySchema>;
export const paPaymentRouteSchema = z.strictObject({
  taskId: z.uuid(), requestId: z.uuid(), action: z.literal('select_payment_route'),
  handoffId: sha, handoffDigest: sha, wallet: linkWalletAvailabilitySchema.optional(), capability: paCheckoutCapabilitySchema.optional(),
}).refine(value => !!value.wallet !== !!value.capability, 'Provide exactly one current PA capability observation');
export const paPaymentSelectionSchema = z.strictObject({
  route: z.enum(['link_agent_wallet', 'link_checkout']),
  reason: z.enum(['wallet_ready', 'region_unsupported', 'not_connected', 'connector_missing', 'wallet_unavailable', 'merchant_wallet_unavailable']),
  wallet: linkWalletAvailabilitySchema, selectedAt: z.iso.datetime({ offset: true }),
  operationId: z.uuid(), handoffDigest: sha, digest: sha,
});
export type PAPaymentSelection = z.infer<typeof paPaymentSelectionSchema>;
export const paCheckoutSelectionSchema = z.strictObject({
  route: z.enum(['pa_vault', 'pa_payment_account']), reason: z.literal('pa_capability_ready'),
  capability: paCheckoutCapabilitySchema, selectedAt: z.iso.datetime({ offset: true }),
  operationId: z.uuid(), handoffDigest: sha, digest: sha,
});
export const paHandoffSelectionSchema = z.union([paPaymentSelectionSchema, paCheckoutSelectionSchema]);
export type PAHandoffSelection = z.infer<typeof paHandoffSelectionSchema>;
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
  request: PAHandoffRequest;
  readbackSequence: number;
  status: 'awaiting_pa' | 'awaiting_user' | 'reported' | 'awaiting_provider' | 'verified' | 'withdrawn';
  selection?: PAHandoffSelection;
  reports: { id: string; outcome: PAPaymentReport['outcome']; receivedAt: string }[];
  recoveryAttempts?: number;
  recovery?: { observedAt: string; result: 'confirmed' | 'pending' | 'mismatch'; evidenceRefs: string[] };
}

/** This is a request for the PA to use its own payment capability. It is not a
 * Stripe credential, an EIGOS payment grant, or evidence that money moved. */
export function recordPAPaymentHandoff(job: Job, owner: string, objectId: string, raw: unknown, mode: 'request' | 'wait', componentId?: string) {
  const terms = paHandoffTermsSchema.parse(raw), state = job.delegation!.agent!;
  if (job.delegation!.request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'PA payment handoff is isolated-test only');
  const component = componentId ? state.composition?.contexts.find(value => value.id === componentId) : undefined;
  if (state.composition && !component || componentId && !component) throw new DomainError('CONFLICT', 'Payment handoff requires its original component');
  const configurationDigest = component?.programDigest ?? state.programDigest;
  const existing = state.paPayment;
  if (mode === 'request') {
    if (existing) throw new DomainError('CONFLICT', 'An original payment handoff already exists');
    if (Date.parse(terms.expiresAt) <= Date.now()) throw new DomainError('CONFLICT', 'The provider booking hold expired before payment handoff');
    const body = { id: sha.parse(objectId), version: 'resource' in terms ? '3' : '2', taskId: job.id, requestRevision: job.delegation!.request.revision, ownerDigest: digest(owner), configurationDigest, createdAt: new Date().toISOString(), terms };
    state.paPayment = { request: paHandoffRequestSchema.parse({ ...body, digest: digest(body) }), status: 'awaiting_pa', readbackSequence: 0, reports: [] };
  } else {
    if (!existing || existing.request.id !== objectId || digest(existing.request.terms) !== digest(terms)) throw new DomainError('CONFLICT', 'Wait must retain the original owned payment request');
    existing.status = existing.reports.length ? 'awaiting_provider' : existing.selection?.route === 'link_checkout' ? 'awaiting_user' : 'awaiting_pa';
  }
  if (component) state.composition!.paymentContextId = component.id;
  delete state.pendingPlanId;
  job.state = 'input-required'; job.delegation!.phase = 'awaiting_pa_payment'; job.delegation!.nextAt = 0;
  job.updatedAt = new Date().toISOString();
  job.question = mode === 'request' ? '沙箱预约已准备到待付款。请 PA 检查自己的 Link Agent Wallet 可用性并调用 select_payment_route：可用时优先钱包，不可用时交给用户在服务商的普通 Link 测试结账页确认。不得真实付款；随后由 EIGOS 独立回读。' : '原模拟付款或预约尚未获得服务商完整确认。请查询原付款，不要重复付款或切换路线；提交状态通知或请求回读后继续核验。';
  if ('resource' in terms) job.question = mode === 'request'
    ? 'Shopify 隔离测试结账已准备。请 PA 用自己的测试 Vault 或测试支付账户选择支持的路线，再以原操作键处理这笔测试付款；凭据留在 PA 侧。EIGOS 将独立回读原结账和付款。'
    : '原测试结账或付款仍待确认。请查询原操作并通知 EIGOS 回读；保留同一结账、付款请求与操作键，不重复付款或切换路线。';
  job.messages.push({ id: randomUUID(), role: 'agent', text: job.question, at: job.updatedAt });
  job.delegation!.events.push({ at: job.updatedAt, event: mode === 'request' ? 'pa_payment_requested' : 'pa_payment_waiting_for_provider', evidence: state.paPayment!.request.digest });
}
export function verifyPAPaymentRequest(job: Job, owner: string) {
  const state = job.delegation?.agent, payment = state?.paPayment;
  if (!state || !payment) throw new DomainError('CONFLICT', 'This task has no PA payment handoff');
  const component = state.composition?.contexts.find(value => value.id === state.composition?.paymentContextId);
  if (state.composition && !component) throw new DomainError('CONFLICT', 'Original payment component is missing');
  const { digest: expected, ...body } = paHandoffRequestSchema.parse(payment.request);
  if (digest(body) !== expected || body.taskId !== job.id || body.ownerDigest !== digest(owner) || body.requestRevision !== job.delegation!.request.revision || body.configurationDigest !== (component?.programDigest ?? state.programDigest)) throw new DomainError('CONFLICT', 'The original PA payment request changed');
  verifyPAPaymentSelection(payment);
  return payment;
}

export function verifyPAPaymentSelection(payment: PAPaymentState) {
  if (!payment.selection) return;
  if (payment.request.version === '3') {
    const { digest: expected, ...selected } = paCheckoutSelectionSchema.parse(payment.selection);
    assertCheckoutCapability(payment.request.terms, selected.capability, Date.parse(selected.selectedAt));
    if (digest(selected) !== expected || selected.handoffDigest !== payment.request.digest || selected.route !== selected.capability.route) throw new DomainError('CONFLICT', 'The original PA checkout route changed');
    return;
  }
  const { digest: selectionDigest, ...selected } = paPaymentSelectionSchema.parse(payment.selection);
  const expectedRoute = choosePAPaymentRoute(payment.request.terms, selected.wallet, Date.parse(selected.selectedAt));
  if (digest(selected) !== selectionDigest || selected.handoffDigest !== payment.request.digest || selected.route !== expectedRoute.route || selected.reason !== expectedRoute.reason) throw new DomainError('CONFLICT', 'The original payment route selection changed');
}

export function recordPAPaymentSelection(payment: PAPaymentState, choice: { wallet?: LinkWalletAvailability; capability?: PACheckoutCapability }): PAHandoffSelection {
  if (payment.selection || payment.reports.length || payment.status !== 'awaiting_pa') throw new DomainError('CONFLICT', 'A payment route or attempt already exists; reconcile the original payment instead of switching routes');
  if (Date.parse(payment.request.terms.expiresAt) <= Date.now()) throw new DomainError('CONFLICT', 'The original booking expired before payment route selection');
  const selectedAt = new Date().toISOString();
  if (payment.request.version === '3') {
    if (!choice.capability || choice.wallet) throw new DomainError('CONFLICT', 'This checkout requires the PA own test Vault or payment-account capability');
    assertCheckoutCapability(payment.request.terms, choice.capability, Date.parse(selectedAt));
    const body = { route: choice.capability.route, reason: 'pa_capability_ready' as const, capability: choice.capability, selectedAt, operationId: randomUUID(), handoffDigest: payment.request.digest };
    payment.selection = { ...body, digest: digest(body) }; payment.status = 'awaiting_pa';
    return payment.selection;
  }
  if (!choice.wallet || choice.capability) throw new DomainError('CONFLICT', 'This booking requires its original Link route observation');
  const wallet = choice.wallet;
  const body = { ...choosePAPaymentRoute(payment.request.terms, wallet, Date.parse(selectedAt)), wallet, selectedAt, operationId: randomUUID(), handoffDigest: payment.request.digest };
  payment.selection = { ...body, digest: digest(body) };
  payment.status = body.route === 'link_checkout' ? 'awaiting_user' : 'awaiting_pa';
  return payment.selection;
}

function assertCheckoutCapability(terms: PACheckoutPaymentTerms, capability: PACheckoutCapability, at: number) {
  const observedAt = Date.parse(capability.observedAt);
  if (observedAt > at || at - observedAt > 300_000 || !terms.routes.some(route => route.id === capability.route && route.supported)) throw new DomainError('CONFLICT', 'Read a currently available PA capability supported by the original test checkout');
}

export function paymentRouteQuestion(payment: PAPaymentState): string {
  const selected = payment.selection;
  if (!selected) throw new DomainError('CONFLICT', 'Select the original payment route first');
  if (payment.request.version === '3') return `已选择 PA 自有${selected.route === 'pa_vault' ? '测试 Vault' : '测试支付账户'}。请核对原结账、准确金额和用户测试授权，保存并复用操作键 ${selected.operationId}。结果未知时查询原付款；EIGOS 随后独立核验付款和订单。`;
  return selected.route === 'link_agent_wallet'
    ? '已选择 Link Agent Wallet 测试路线。请 PA 使用自己的测试钱包和原操作键处理此预约；结果未知时只查询原付款，不切换路线或重付。'
    : `已转到普通 Link 测试结账路线。请用户在服务商提供的页面确认模拟付款：${payment.request.terms.checkout.url}。不得真实付款；页面完成提示不代替服务商付款及预约回读。`;
}

export function paPaymentProtocol(checkoutEnabled = false) {
  return {
    version: checkoutEnabled ? '3' : '2', supportedVersions: checkoutEnabled ? ['2', '3'] : ['2'],
    environment: 'sandbox', paymentAuthority: 'pa_owned', credentialsAccepted: false,
    routePolicy: checkoutEnabled ? 'per_request' : 'prefer_link_agent_wallet',
    routes: checkoutEnabled ? ['link_agent_wallet', 'link_checkout', 'pa_vault', 'pa_payment_account'] : ['link_agent_wallet', 'link_checkout'],
    ...(checkoutEnabled ? { confirmationPolicy: 'pa_authorization_and_provider_requirements' } : { checkoutRequiresUserConfirmation: true }),
    switchAfterSelection: false, requestPath: 'metadata.delegation.agent.paPayment.request', selectionPath: 'metadata.delegation.agent.paPayment.selection',
    a2a: { method: 'SendMessage', actions: ['select_payment_route', 'report_payment_result'] }, mcpTools: ['select_payment_route', 'report_payment_result'],
    notificationIsPaymentProof: false,
    completionRequires: ['independent_provider_payment', checkoutEnabled ? 'independent_original_order_or_booking' : 'independent_provider_booking'],
    requestSchema: z.toJSONSchema(checkoutEnabled ? paHandoffRequestSchema : paPaymentRequestSchema),
    routeSchema: z.toJSONSchema(paPaymentRouteSchema), selectionSchema: z.toJSONSchema(checkoutEnabled ? paHandoffSelectionSchema : paPaymentSelectionSchema),
    reportSchema: z.toJSONSchema(paPaymentReportSchema),
  };
}
