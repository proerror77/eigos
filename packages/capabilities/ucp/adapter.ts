import { z } from 'zod';
import { DomainError } from '../../core/domain.js';
import { actionOperationKey, digest } from '../../core/delegation.js';
import type { JobStore } from '../../core/store.js';
import type { ActionAdapter, AdapterContext, Delivery, Preparation } from '../../core/catalog.js';
import type { ActionContext, ActionResult } from '../../ontology/actions.js';
import { moneySchema, type CandidateFacts, type ExecutionPlan, type PlanStep, type ProviderBinding, type ServiceCapability } from '../../ontology/execution.js';
import { assessCommerce, commerceSnapshotSchema, type CommerceSnapshot } from '../../ontology/commerce.js';
import { requestedItemsSchema, UCP_VERSION, type UcpCheckout } from './contracts.js';
import { UcpRestClient, type UcpLocalConnection, type UcpResponse } from './client.js';
import { addressDigest, checkoutSnapshot, orderSnapshot } from './snapshot.js';

export const UCP_PREPARE = 'commerce.ucp.prepare.sandbox';
export const UCP_CONFIRM = 'commerce.ucp.confirm.sandbox';
export const prepareCheckoutInput = z.object({ items: requestedItemsSchema, fulfillmentProfile: z.string().min(1).max(80) }).strict();
export const confirmCheckoutInput = z.object({ preparationTaskId: z.uuid(), budget: moneySchema }).strict();
export interface UcpSandboxOptions extends UcpLocalConnection {
  fulfillmentProfiles: Record<string, { label: string; destination: { address_country: string; postal_code?: string; address_region?: string; address_locality?: string; street_address?: string; extended_address?: string; first_name?: string; last_name?: string; phone_number?: string }; optionId: string }>;
}
type Mode = 'prepare' | 'confirm';
interface PreparedData {
  mode: Mode; requestId: string; requestRevision: number; configurationDigest: string; inputDigest: string;
  preparationTaskId: string; expectedItems: z.infer<typeof requestedItemsSchema>; createBody?: Record<string, unknown>;
  expectedDestinationDigest?: string; checkout?: CommerceSnapshot['checkout']; budget?: z.infer<typeof moneySchema>;
}
export function ucpCapabilities(options: UcpSandboxOptions): ServiceCapability[] {
  const common = { tags: ['commerce', 'ucp', 'sandbox'], ontologyRef: { id: 'eigos.commerce.ucp', version: '1' }, environment: 'sandbox' as const, verifierRef: { id: 'ucp.independent', version: '1' }, ontology: { protocol: 'UCP', version: UCP_VERSION, objects: ['CheckoutRequest', 'CheckoutSession', 'Order', 'OrderLine'], functions: ['checkoutReadiness', 'commerceOrderOutcome'], realSourceConnected: false } };
  return [
    { ...common, ref: { id: UCP_PREPARE, version: '1' }, name: '准备测试商家结账', description: `仅在官方本地测试商家 ${options.merchantId} 创建结账会话，不下单或付款。商品件数是要写入会话的输入，不是实物交付要求；本次终点只是取得会话及商家当前报价。收货资料：${Object.entries(options.fulfillmentProfiles).map(([id, p]) => `${id}=${p.label}`).join('；')}。购买须另行确认。`, inputSchema: z.toJSONSchema(prepareCheckoutInput), actions: [{ ref: { id: 'ucp.checkout.create', version: '1' }, effect: 'reserve' }], predicates: [{ id: 'ucp.checkout.prepared', description: 'The requested checkout session was created; no purchase, payment or delivery' }], outcomePredicates: ['ucp.checkout.prepared'], completion: 'artifact' },
    { ...common, ref: { id: UCP_CONFIRM, version: '1' }, name: '确认测试商家结账', description: '仅确认本用户已准备的官方本地 UCP 结账会话。输入引用先前准备任务及明确币种预算；保留原商品、数量、地址和报价。需要同时批准 order/payment 两种模拟效果；完成仅证明订单确认，付款到账与实际送达另需证据。外币预算使用已有结构化最小货币单位，不自行换汇。', inputSchema: z.toJSONSchema(confirmCheckoutInput), actions: [{ ref: { id: 'ucp.checkout.complete', version: '1' }, effect: 'order', additionalEffects: ['payment'] }], predicates: [{ id: 'ucp.order.confirmed', description: 'Original order independently read and matched to the fixed checkout; not delivered' }], outcomePredicates: ['ucp.order.confirmed'], requirementRoles: [{ kind: 'budget', role: 'service_total', description: 'Complete merchant order total' }, { kind: 'quantity', role: 'item_quantity', description: 'Integer count of the fixed merchant items' }], completion: 'order' },
  ];
}
export class UcpSandboxAdapter implements ActionAdapter {
  readonly environment = 'sandbox' as const;
  readonly id: string;
  readonly configurationDigest: string;
  readonly client: UcpRestClient;
  constructor(readonly mode: Mode, private store: JobStore, private options: UcpSandboxOptions) {
    this.client = new UcpRestClient(options); this.id = `ucp.${options.merchantId}.${mode}`;
    if (!Object.keys(options.fulfillmentProfiles).length || Object.keys(options.fulfillmentProfiles).length > 8) throw new DomainError('INVALID_INPUT', 'A bounded explicit test fulfillment profile is required');
    for (const [id, p] of Object.entries(options.fulfillmentProfiles)) if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !p.label || !p.optionId || !addressDigest(p.destination)) throw new DomainError('INVALID_INPUT', 'Invalid test fulfillment profile');
    this.configurationDigest = digest({ transport: this.client.configurationDigest, profiles: options.fulfillmentProfiles });
  }
  capability() { return ucpCapabilities(this.options)[this.mode === 'prepare' ? 0 : 1]!; }
  binding(): ProviderBinding {
    return { ref: { id: this.id, version: '1' }, capabilityRef: this.capability().ref, providerId: this.options.merchantId, channelId: 'ucp-local-reference', merchantId: this.options.merchantId, adapterId: this.id, protocol: 'http', enabled: true, configurationDigest: this.configurationDigest, verification: { level: 'simulated', evidenceRefs: ['official-ucp-local-reference-only'] }, recovery: { idempotency: 'provider_key', lookup: this.mode === 'confirm' } };
  }
  permitted(owner: string) { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  private scope(ctx: AdapterContext) { if (!this.permitted(ctx.owner) || ctx.request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'UCP reference integration is available only to the explicit local sandbox identity'); }
  operationScope(checkoutId: string) { return `ucp-checkout:${digest({ merchant: this.configurationDigest, checkoutId })}`; }
  async prepare(ctx: AdapterContext, raw: unknown, signal: AbortSignal, acceptedCheckout?: CommerceSnapshot): Promise<Preparation> {
    this.scope(ctx); const input = (this.mode === 'prepare' ? prepareCheckoutInput : confirmCheckoutInput).parse(raw);
    const discovery = await this.client.discover(signal); signal.throwIfAborted();
    const fixed: PreparedData = { mode: this.mode, requestId: ctx.request.id, requestRevision: ctx.request.revision, configurationDigest: this.configurationDigest, inputDigest: digest(input), preparationTaskId: ctx.request.id, expectedItems: [] };
    let facts: CandidateFacts = {}, observedAt = discovery.receipt.receivedAt, expiresAt = new Date(Date.now() + 300000).toISOString();
    const details: Record<string, unknown> = { environment: 'sandbox', realOperationsAllowed: false, merchantId: this.options.merchantId, protocolVersion: UCP_VERSION, operation: this.mode, sourceReceipt: discovery.receipt.id };
    if ('items' in input) {
      const profile = Object.hasOwn(this.options.fulfillmentProfiles, input.fulfillmentProfile) ? this.options.fulfillmentProfiles[input.fulfillmentProfile] : undefined; if (!profile) return { kind: 'unavailable', reason: '没有这份已配置的测试收货资料。' };
      fixed.expectedItems = input.items; fixed.expectedDestinationDigest = addressDigest(profile.destination);
      fixed.createBody = { line_items: input.items.map(i => ({ item: { id: i.id }, quantity: i.quantity })), payment: { instruments: [] }, fulfillment: { methods: [{ id: 'shipping', type: 'shipping', destinations: [{ id: 'destination', ...profile.destination }], selected_destination_id: 'destination', groups: [{ id: 'package', selected_option_id: profile.optionId }] }] } };
    } else {
      if (!this.client.supportsMockPayment()) return { kind: 'unavailable', reason: '该本地商家未声明本次允许的官方模拟支付处理器。' };
      let original: CommerceSnapshot;
      if (acceptedCheckout) {
        original = commerceSnapshotSchema.parse(acceptedCheckout);
        if (original.requestId !== ctx.request.id || original.requestRevision !== ctx.request.revision || original.preparationTaskId !== ctx.request.id || input.preparationTaskId !== ctx.request.id) throw new DomainError('CONFLICT', 'Same-task checkout must retain its original request and revision');
      } else {
        const previous = this.store.get(ctx.owner, input.preparationTaskId);
        if (previous.state !== 'completed' || previous.delegation?.plan?.capabilityRef.id !== UCP_PREPARE) throw new DomainError('CONFLICT', 'Reference an owned, completed checkout preparation task');
        const result = previous.artifact?.data.result as { ucpSnapshot?: unknown } | undefined;
        original = commerceSnapshotSchema.parse(result?.ucpSnapshot);
      }
      if (original.configurationDigest !== this.configurationDigest || original.preparationTaskId !== input.preparationTaskId || original.operation !== 'prepare') throw new DomainError('CONFLICT', 'Prepared checkout belongs to a different merchant configuration');
      const prior = this.store.intentByBusinessKey(ctx.owner, actionOperationKey(ctx.owner, this.operationScope(original.checkout.id), 'complete-checkout'));
      if (prior && prior.jobId !== ctx.request.id) return { kind: 'unavailable', reason: '该结账会话已有确认任务，请读取或查证原任务，不能另建购买意图。', details: { originalTaskId: prior.jobId } };
      const response = await this.client.getCheckout(original.checkout.id, signal), checkout = checkoutSnapshot(response);
      if (checkout.id !== original.checkout.id || checkout.quoteDigest !== original.checkout.quoteDigest) return { kind: 'unavailable', reason: '结账商品、费用、地址或条款已经变化，需要重新准备并确认准确方案。' };
      if (checkout.state !== 'ready_for_complete' || checkout.messageCodes.length || !checkout.destinationDigest || !checkout.destinationComplete) return { kind: 'unavailable', reason: checkout.state === 'completed' ? '该会话已有订单，应查询原订单；不能作为新的购买再次提交。' : '商家尚未提供可确认的完整结账会话，请先处理商家要求。', details: { state: checkout.state, ...(checkout.continueUrl ? { continueUrl: checkout.continueUrl } : {}), messageCodes: checkout.messageCodes } };
      if (checkout.total.currency !== input.budget.currency || BigInt(checkout.total.minor) > BigInt(input.budget.minor)) return { kind: 'unavailable', reason: '商家当前完整总额超过指定预算，或币种不一致。' };
      fixed.preparationTaskId = original.preparationTaskId; fixed.expectedItems = original.expectedItems; fixed.checkout = checkout; fixed.expectedDestinationDigest = original.checkout.destinationDigest; fixed.budget = input.budget;
      facts = this.facts(checkout); observedAt = response.receipt.receivedAt;
      expiresAt = new Date(Math.min(Date.now() + 300000, checkout.expiresAt ? Date.parse(checkout.expiresAt) : Infinity)).toISOString();
      Object.assign(details, { checkoutId: checkout.id, total: checkout.total, quoteDigest: checkout.quoteDigest, requiresOrderAndPaymentAuthority: true, fulfillment: 'not_started' });
    }
    const requestProjection = { requestId: ctx.request.id, requestRevision: ctx.request.revision, operation: this.mode, preparationTaskId: fixed.preparationTaskId, expectedItems: fixed.expectedItems, ...(fixed.budget ? { budget: fixed.budget } : {}) };
    const cost = fixed.checkout?.total ?? { minor: '0', currency: 'USD' };
    const snapshot = fixed.checkout ? this.snapshot(fixed, fixed.checkout) : undefined;
    return { kind: 'ready', input, facts, details, observedAt, expiresAt, evidenceRefs: [discovery.receipt.id, ...(fixed.checkout ? [fixed.checkout.receipt.id] : [])], privateData: { ...fixed, result: { checkoutRequest: requestProjection, ...(snapshot ? { ucpSnapshot: snapshot } : {}) } }, recipe: [{ id: 'checkout', operationId: this.mode === 'prepare' ? 'prepare-checkout' : 'complete-checkout', ...(fixed.checkout ? { operationScope: this.operationScope(fixed.checkout.id) } : {}), actionTypeRef: this.capability().actions[0]!.ref, input, inputRefs: [], dependsOn: [], cost: { ...cost, payeeId: this.options.merchantId, purpose: 'service_total' } }] };
  }
  validateInput(step: PlanStep, input: Record<string, unknown>) {
    if (step.actionTypeRef.id !== this.capability().actions[0]!.ref.id || step.actionTypeRef.version !== '1' || step.effect !== (this.mode === 'prepare' ? 'reserve' : 'order')) throw new DomainError('FORBIDDEN', 'Wrong UCP operation or effect');
    (this.mode === 'prepare' ? prepareCheckoutInput : confirmCheckoutInput).parse(input);
  }
  private fixed(ctx: ActionContext, raw: unknown): PreparedData {
    const data = raw as PreparedData;
    if (!data || !this.permitted(ctx.owner) || data.mode !== this.mode || data.requestId !== ctx.requestId || data.requestRevision !== ctx.requestRevision || data.configurationDigest !== this.configurationDigest || data.inputDigest !== digest(ctx.input)) throw new DomainError('CONFLICT', 'UCP action changed its owned request or merchant binding');
    return data;
  }
  async dispatch(ctx: ActionContext, raw: unknown, signal: AbortSignal): Promise<ActionResult> {
    const fixed = this.fixed(ctx, raw); await this.client.discover(signal);
    if (this.mode === 'prepare') {
      ctx.assertDispatchAllowed?.();
      return this.result(ctx, fixed, await this.client.createCheckout(fixed.createBody!, ctx.intent.businessOperationKey, signal), signal);
    }
    const current = await this.client.getCheckout(fixed.checkout!.id, signal), snapshot = checkoutSnapshot(current);
    if (snapshot.id !== fixed.checkout!.id || snapshot.quoteDigest !== fixed.checkout!.quoteDigest) return this.reject(ctx, fixed, snapshot, 'quote_changed');
    if (snapshot.state === 'completed' || snapshot.state === 'complete_in_progress') return this.result(ctx, fixed, current, signal);
    if (snapshot.state !== 'ready_for_complete' || snapshot.messageCodes.length) return this.reject(ctx, fixed, snapshot, 'checkout_not_ready');
    ctx.assertDispatchAllowed?.();
    return this.result(ctx, fixed, await this.client.completeMockCheckout(snapshot.id, ctx.intent.businessOperationKey, signal), signal);
  }
  async observe(ctx: ActionContext, raw: unknown, signal: AbortSignal) { return this.reconcile(ctx, raw, signal); }
  async reconcile(ctx: ActionContext, raw: unknown, signal: AbortSignal): Promise<ActionResult> {
    const fixed = this.fixed(ctx, raw), id = fixed.checkout?.id ?? ctx.intent.remoteRef;
    if (!id) return { kind: 'unknown', eventId: `${ctx.attempt.id}:missing-checkout-reference`, sourceVersion: ctx.attempt.ordinal, evidenceRefs: [], message: 'Create Checkout response was lost. UCP provides no lookup by this idempotency key; stop and recover the original reference without replaying the create.' };
    await this.client.discover(signal); return this.result(ctx, fixed, await this.client.getCheckout(id, signal), signal);
  }
  private snapshot(fixed: PreparedData, checkout: CommerceSnapshot['checkout'], order?: CommerceSnapshot['order']): CommerceSnapshot {
    return commerceSnapshotSchema.parse({ environment: 'sandbox', merchantId: this.options.merchantId, merchantOrigin: this.client.origin, protocolVersion: UCP_VERSION, requestId: fixed.requestId, requestRevision: fixed.requestRevision, preparationTaskId: fixed.preparationTaskId, operation: fixed.mode, inputDigest: fixed.inputDigest, configurationDigest: fixed.configurationDigest, expectedItems: fixed.expectedItems, ...(fixed.budget ? { budget: fixed.budget } : {}), checkout, ...(order ? { order } : {}) });
  }
  private reject(ctx: ActionContext, fixed: PreparedData, checkout: CommerceSnapshot['checkout'], rejection: string): ActionResult {
    const snapshot = this.snapshot(fixed, checkout);
    return { kind: 'rejected', eventId: checkout.receipt.id, sourceVersion: ctx.attempt.ordinal, remoteRef: checkout.id, output: { ucpSnapshot: snapshot, snapshotDigest: digest(snapshot), rejection }, evidenceRefs: [checkout.receipt.id], message: 'The fixed checkout is no longer executable; no complete request was sent.' };
  }
  private async result(ctx: ActionContext, fixed: PreparedData, response: UcpResponse<UcpCheckout>, signal: AbortSignal): Promise<ActionResult> {
    const checkout = checkoutSnapshot(response);
    if (fixed.checkout && checkout.id !== fixed.checkout.id) throw new DomainError('CONFLICT', 'The merchant returned another checkout');
    if (checkout.destinationDigest && fixed.expectedDestinationDigest && checkout.destinationDigest !== fixed.expectedDestinationDigest) return this.reject(ctx, fixed, checkout, 'destination_changed');
    const order = this.mode === 'confirm' && checkout.state === 'completed' && checkout.orderId ? orderSnapshot(await this.client.getOrder(checkout.orderId, signal)) : undefined;
    const snapshot = this.snapshot(fixed, checkout, order), assessment = assessCommerce(snapshot), evidenceRefs = [checkout.receipt.id, ...(order ? [order.receipt.id] : [])];
    const result: ActionResult = { kind: assessment.status === 'unknown' ? 'pending' : 'confirmed', eventId: order?.receipt.id ?? checkout.receipt.id, sourceVersion: ctx.attempt.ordinal, remoteRef: checkout.id, output: { ucpSnapshot: snapshot, snapshotDigest: digest(snapshot) }, business: { order: order ? order.adjustmentCount ? 'unknown' : 'confirmed' : 'pending', payment: 'unknown', fulfillment: order?.fulfillment ?? 'unknown' }, evidenceRefs, retryAfterMs: 1000 };
    if (assessment.status !== 'unknown') result.delivery = { artifact: { id: digest(snapshot), name: `ucp-${this.mode}-result.json`, data: { goal: ctx.goal, deliverable: this.mode === 'prepare' ? '官方本地测试商家的结账会话已准备；没有下单或付款。' : '官方本地测试商家的原订单已独立核对；不代表真实购买、付款到账或配送完成。', execution: 'completed', result: { environment: 'sandbox', ucpSnapshot: snapshot, assessment } } }, facts: { ...this.facts(order ?? checkout), conditions: assessment.status === 'satisfied' ? [this.mode === 'prepare' ? 'ucp.checkout.prepared' : 'ucp.order.confirmed'] : [] }, evidenceRefs };
    return result;
  }
  private facts(value: Pick<CommerceSnapshot['checkout'], 'items' | 'total'>): CandidateFacts {
    if (this.mode === 'prepare') return {};
    const quantity = { amount: String(value.items.reduce((n, i) => n + i.quantity, 0)), unit: 'piece' };
    return { quantity, quantities: { item_quantity: quantity }, totalPrice: value.total, amounts: { service_total: value.total } };
  }
  verifyAction(ctx: ActionContext, result: ActionResult) {
    try {
      const fixed = this.fixed(ctx, ctx.intent.privateData), snapshot = commerceSnapshotSchema.parse(result.output?.ucpSnapshot), assessment = assessCommerce(snapshot);
      const source = snapshot.order?.receipt ?? snapshot.checkout.receipt;
      const same = snapshot.requestId === ctx.requestId && snapshot.requestRevision === ctx.requestRevision && snapshot.configurationDigest === this.configurationDigest && snapshot.merchantId === this.options.merchantId && snapshot.merchantOrigin === this.client.origin && snapshot.inputDigest === digest(ctx.input) && snapshot.operation === this.mode && snapshot.preparationTaskId === fixed.preparationTaskId && digest(snapshot.expectedItems) === digest(fixed.expectedItems) && digest(snapshot.budget ?? null) === digest(fixed.budget ?? null) && result.remoteRef === snapshot.checkout.id && (!fixed.checkout || snapshot.checkout.id === fixed.checkout.id) && (!ctx.intent.remoteRef || ctx.intent.remoteRef === snapshot.checkout.id) && result.sourceVersion === ctx.attempt.ordinal && result.eventId === source.id && result.output?.snapshotDigest === digest(snapshot) && Date.parse(source.startedAt) >= Date.parse(ctx.attempt.startedAt);
      if (result.kind === 'rejected') return { accepted: same && (result.output?.rejection === 'quote_changed' && snapshot.checkout.quoteDigest !== fixed.checkout?.quoteDigest || result.output?.rejection === 'checkout_not_ready' && (snapshot.checkout.state !== 'ready_for_complete' || !!snapshot.checkout.messageCodes.length) || result.output?.rejection === 'destination_changed' && snapshot.checkout.destinationDigest !== fixed.expectedDestinationDigest), reason: 'Rechecked the source reason for refusing the fixed checkout' };
      const business = { order: snapshot.order ? snapshot.order.adjustmentCount ? 'unknown' : 'confirmed' : 'pending', payment: 'unknown', fulfillment: snapshot.order?.fulfillment ?? 'unknown' };
      return { accepted: same && result.kind === (assessment.status === 'unknown' ? 'pending' : 'confirmed') && (!result.delivery || result.delivery.artifact.id === digest(snapshot)) && digest(result.business) === digest(business), reason: 'Independently checked original checkout, original order, source receipts and fixed requirements' };
    } catch { return { accepted: false, reason: 'UCP observation is not bound to the fixed owned operation' }; }
  }
  verify(ctx: AdapterContext, plan: import('../../core/catalog.js').AdapterPlan, raw: unknown, delivery: Delivery) {
    try {
      this.scope(ctx); const fixed = raw as PreparedData, report = delivery.artifact.data.result as { ucpSnapshot: unknown; assessment: unknown }, snapshot = commerceSnapshotSchema.parse(report.ucpSnapshot), assessment = assessCommerce(snapshot);
      const accepted = fixed.configurationDigest === this.configurationDigest && snapshot.configurationDigest === this.configurationDigest && snapshot.requestId === ctx.request.id && snapshot.requestRevision === ctx.request.revision && snapshot.inputDigest === digest(plan.steps[0]!.input) && digest(snapshot.expectedItems) === digest(fixed.expectedItems) && digest(snapshot.budget ?? null) === digest(fixed.budget ?? null) && snapshot.preparationTaskId === fixed.preparationTaskId && snapshot.operation === this.mode && (!fixed.checkout || snapshot.checkout.quoteDigest === fixed.checkout.quoteDigest) && (!fixed.expectedDestinationDigest || snapshot.checkout.destinationDigest === fixed.expectedDestinationDigest) && assessment.status === 'satisfied' && digest(report.assessment) === digest(assessment) && delivery.artifact.id === digest(snapshot) && delivery.evidenceRefs.includes(snapshot.checkout.receipt.id) && (!snapshot.order || delivery.evidenceRefs.includes(snapshot.order.receipt.id));
      return { accepted, reason: accepted ? 'The exact local UCP business endpoint was independently verified; real operations and delivery are not implied' : 'UCP outcome does not satisfy the fixed request and source evidence' };
    } catch { return { accepted: false, reason: 'Malformed or unbound UCP outcome' }; }
  }
}
