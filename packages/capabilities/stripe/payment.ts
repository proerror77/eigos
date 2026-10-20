import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import { AgentReadError, AgentOperationRejected, type AgentActionContext, type AgentActionResult, type AgentProgramContext } from '../../core/agent-program.js';
import { objectRefSchema } from '../../ontology/model.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import { checkedCommerceObservation, readCommerceObservation, commerceObservationReadiness } from '../../ontology/commerce-journey-functions.js';
import { parseCommerceEntity } from '../../ontology/commerce-journey.js';
import { stripePaymentActionSchemas, stripePaymentDataSchema, stripePaymentObservationSchema, type StripePaymentData, type StripePaymentObservation } from '../../ontology/stripe-payment.js';
import { readStripePayment, stripeOrderDigest, stripeTestCaptured, projectStripePayment } from '../../ontology/stripe-payment-functions.js';
import { StripeTestClient, stripeOperationDigest, type StripeTestOptions, type StripeResponse, type StripeHttpReceipt } from './client.js';

const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const integer = z.number().int().nonnegative().max(99_999_999);
const apiIntent = z.object({ id: z.string().regex(/^pi_[a-zA-Z0-9]{1,150}$/), object: z.literal('payment_intent'), amount: integer.positive(), currency: z.string().regex(/^[a-z]{3}$/), amount_received: integer, status: stripePaymentDataSchema.shape.status, capture_method: z.literal('automatic'), confirmation_method: z.literal('automatic'), payment_method_types: z.tuple([z.literal('card')]), transfer_data: z.null(), on_behalf_of: z.null(), application_fee_amount: z.null(), setup_future_usage: z.null(), livemode: z.literal(false), metadata: z.object({ eigos_binding: z.string(), eigos_prepare: z.string() }), latest_charge: z.unknown().nullable(), last_payment_error: z.unknown().nullable() });
const apiCharge = z.object({ id: z.string().regex(/^ch_[a-zA-Z0-9]{1,150}$/), object: z.literal('charge'), payment_intent: z.string(), amount: integer, currency: z.string().regex(/^[a-z]{3}$/), paid: z.boolean(), captured: z.boolean(), refunded: z.boolean(), amount_refunded: integer, disputed: z.boolean(), livemode: z.literal(false) });

/** Payment semantics only. The model chooses these actions through the existing
 * runtime; this adapter does not select products, issue PA grants or close tasks. */
export class StripeTestPayments {
  readonly client: StripeTestClient;
  constructor(options: StripeTestOptions) { this.client = new StripeTestClient(options); }
  private order(ctx: AgentProgramContext, input: Record<string, unknown>, historical = false) {
    const ref = objectRefSchema.parse(input.order);
    if (ref.type !== 'CommerceOrderObservation') return fail('Stripe requires an owned commerce order');
    const prior = checkedCommerceObservation(ctx.graph.read(ctx.owner, ref).properties.snapshot);
    const snapshot = readCommerceObservation(ctx.graph, ctx.owner, ref, historical ? { at: Date.parse(prior.observedAt) } : {});
    const data = parseCommerceEntity('CommerceOrderObservation', snapshot.data);
    if (snapshot.requestId !== ctx.request.id || snapshot.requestRevision !== ctx.request.revision || !equal(snapshot.scope, ctx.state.scope) || snapshot.configurationDigest !== ctx.state.programDigest || snapshot.action !== 'ReadCommerceOrder' || !data.independentRead || data.state !== 'confirmed' || data.paymentProvider !== 'stripe_test' || data.merchantId !== this.client.options.merchantId || BigInt(data.total.minor) <= 0n || BigInt(data.total.minor) > 99_999_999n) return fail('Stripe requires the independently read unpaid order for the configured test merchant');
    if (commerceObservationReadiness(ctx.graph, ctx.owner, snapshot).status !== 'satisfied') return fail('The original unpaid order does not satisfy its fixed goods, cost and delivery contract');
    const orderDigest = stripeOrderDigest(snapshot), bindingDigest = digest({ owner: ctx.owner, request: ctx.request.id, revision: ctx.request.revision, configuration: ctx.state.programDigest, account: this.client.options.accountId, orderDigest });
    return { ref, snapshot, data, orderDigest, bindingDigest };
  }
  private payment(ctx: AgentProgramContext, input: Record<string, unknown>, historical = false) {
    const s = readStripePayment(ctx.graph, ctx.owner, objectRefSchema.parse(input.payment), { historical });
    const order = this.order(ctx, input, historical);
    if (s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || !equal(s.scope, ctx.state.scope) || s.configurationDigest !== ctx.state.programDigest || s.data.accountId !== this.client.options.accountId || s.data.bindingDigest !== order.bindingDigest || s.data.orderDigest !== order.orderDigest || s.evidenceLevel !== this.client.evidenceLevel) return fail('Stripe payment binding, owner, account or source configuration changed');
    return s;
  }
  validate(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    if (!Object.hasOwn(stripePaymentActionSchemas, action) || !equal(input.scope, ctx.state.scope) || ctx.request.executionEnvironment !== 'sandbox') return fail('Stripe payment requires its registered sandbox action and scope');
    this.order(ctx, input, action === 'ReadStripePayment');
    if (action !== 'PrepareStripePayment') {
      const s = this.payment(ctx, input, action === 'ReadStripePayment');
      if (action === 'PayStripePayment' && (s.action !== 'PrepareStripePayment' || s.data.status !== 'requires_payment_method' || s.data.hasPaymentError || s.data.amountReceived !== '0' || s.data.charge)) return fail('Payment requires the original unconfirmed Stripe test PaymentIntent');
    }
  }
  validatePlanning(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot) {
    if (action === 'ReadStripePayment') return;
    for (const [key, fn] of [['order', 'commerceObservationStatus'], ...(action === 'PayStripePayment' ? [['payment', 'stripePaymentStatus']] : [])]) {
      const call = { function: fn!, object: objectRefSchema.parse(input[key!]) }, result = ctx.graph.evaluate(ctx.owner, call);
      if (result.status !== 'known' || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(call) && r.outputDigest === digest(result))) return fail('The Agent must evaluate the exact current order and Stripe payment before requesting payment authority');
      if (fn === 'stripePaymentStatus' && (result.value as { status?: string }).status !== 'prepared') return fail('Stripe payment is not ready for its first confirmation');
    }
  }
  authority(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    this.validate(ctx, action, input);
    const o = this.order(ctx, input);
    return { cost: { ...o.data.total, minor: action === 'PayStripePayment' ? o.data.total.minor : '0', payeeId: `stripe-test:${this.client.options.accountId}:${o.data.merchantId}` }, operationScope: `stripe-test:${action}:${digest({ account: this.client.options.accountId, merchant: o.data.merchantId, order: o.data.orderId })}` };
  }
  private normalize(raw: unknown, ctx: AgentActionContext, input: Record<string, unknown>, prepareDigest: string): StripePaymentData {
    const parsed = apiIntent.safeParse(raw);
    if (!parsed.success) return fail('Stripe returned an invalid or live PaymentIntent');
    const pi = parsed.data, o = this.order(ctx, input, true);
    if (input.payment && pi.id !== this.payment(ctx, input, true).data.paymentIntentId) return fail('Stripe returned a different PaymentIntent identity');
    if (pi.metadata.eigos_binding !== o.bindingDigest || pi.metadata.eigos_prepare !== prepareDigest || String(pi.amount) !== o.data.total.minor || pi.currency !== o.data.total.currency.toLowerCase()) return fail('Stripe PaymentIntent differs from the original account, order, amount or currency');
    let charge: StripePaymentData['charge'] = null;
    if (pi.latest_charge != null) {
      const parsedCharge = apiCharge.safeParse(pi.latest_charge);
      if (!parsedCharge.success) return fail('Stripe charge must be independently expanded and test-scoped');
      const c = parsedCharge.data;
      if (c.payment_intent !== pi.id || c.amount !== pi.amount || c.currency !== pi.currency) return fail('Stripe charge belongs to a different payment or amount');
      charge = { id: c.id, paymentIntentId: c.payment_intent, amount: { minor: String(c.amount), currency: c.currency.toUpperCase() }, paid: c.paid, captured: c.captured, refunded: c.refunded, amountRefunded: String(c.amount_refunded), disputed: c.disputed, livemode: false };
    }
    return stripePaymentDataSchema.parse({ paymentIntentId: pi.id, accountId: this.client.options.accountId, merchantId: o.data.merchantId, orderId: o.data.orderId, orderDigest: o.orderDigest, bindingDigest: o.bindingDigest, prepareOperationDigest: prepareDigest, amount: o.data.total, amountReceived: String(pi.amount_received), status: pi.status, captureMethod: pi.capture_method, livemode: false, hasPaymentError: pi.last_payment_error != null, charge, independentRead: false, tokenSource: 'stripe_test_helper' });
  }
  private result(ctx: AgentActionContext, action: string, input: Record<string, unknown>, data: StripePaymentData, receipts: StripeHttpReceipt[]): AgentActionResult {
    const o = this.order(ctx, input, true), observedAt = receipts.at(-1)!.receivedAt;
    const base = { requestId: ctx.request.id, requestRevision: ctx.request.revision, ownerDigest: digest(ctx.owner), scope: ctx.state.scope, configurationDigest: ctx.state.programDigest, action, order: o.ref, orderContentDigest: o.snapshot.contentDigest, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, operationKey: ctx.operationKey!, data: { ...data, independentRead: action === 'ReadStripePayment' }, receipts, observedAt, expiresAt: new Date(Date.parse(observedAt) + 300_000).toISOString(), evidenceLevel: this.client.evidenceLevel };
    const value = stripePaymentObservationSchema.parse({ ...base, contentDigest: digest(base) });
    return { value, evidenceRefs: receipts.map(r => r.requestId) };
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    const account = await this.client.verifyAccount(signal), o = this.order(ctx, input, action === 'ReadStripePayment');
    if (!ctx.operationKey) return fail('Stripe action lacks its durable operation identity');
    let result: StripeResponse, data: StripePaymentData;
    if (action === 'PrepareStripePayment') {
      if (!ctx.assertDispatchAllowed) return fail('Stripe write requires a current runtime dispatch guard');
      ctx.assertDispatchAllowed();
      result = await this.client.createIntent(o.data.total.minor, o.data.total.currency, o.bindingDigest, ctx.operationKey, signal);
      data = this.normalize(result.body, ctx, input, stripeOperationDigest(ctx.operationKey));
      if (data.status !== 'requires_payment_method' || data.amountReceived !== '0' || data.charge || data.hasPaymentError) return fail('Stripe preparation unexpectedly has a payment effect');
      return this.result(ctx, action, input, data, [account, result.receipt]);
    }
    const prior = this.payment(ctx, input, action === 'ReadStripePayment');
    const current = await this.client.readIntent(prior.data.paymentIntentId, signal);
    data = this.normalize(current.body, ctx, input, prior.data.prepareOperationDigest);
    if (action === 'ReadStripePayment') return this.result(ctx, action, input, data, [account, current.receipt]);
    if (data.status !== 'requires_payment_method' || data.amountReceived !== '0' || data.charge || data.hasPaymentError) throw new AgentReadError('Original Stripe payment already changed; only readback is allowed');
    if (!ctx.assertDispatchAllowed) return fail('Stripe write requires a current runtime dispatch guard');
    ctx.assertDispatchAllowed();
    const grant = await this.client.createTestToken(data.amount.minor, data.amount.currency, ctx.operationKey, signal);
    ctx.assertDispatchAllowed();
    result = await this.client.confirmIntent(data.paymentIntentId, grant.token, ctx.operationKey, signal);
    data = this.normalize(result.body, ctx, input, prior.data.prepareOperationDigest);
    if (!stripeTestCaptured(data)) {
      if (data.status === 'canceled' || data.status === 'requires_payment_method' && data.hasPaymentError) throw new AgentOperationRejected('Stripe test payment was declined; no capture is confirmed', [result.receipt.requestId]);
      throw new AgentReadError(`Stripe test payment remains ${data.status}; original payment requires readback or user action`);
    }
    return this.result(ctx, action, input, data, [account, current.receipt, ...grant.receipts, result.receipt]);
  }
  async recover(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult | undefined> {
    const account = await this.client.verifyAccount(signal);
    if (!ctx.operationKey) return fail('Stripe recovery lacks its original operation key');
    let response: StripeResponse | undefined, prepareDigest: string;
    if (action === 'PrepareStripePayment') { prepareDigest = stripeOperationDigest(ctx.operationKey); response = await this.client.findOriginalIntent(ctx.operationKey, signal); }
    else { const prior = this.payment(ctx, input, true); prepareDigest = prior.data.prepareOperationDigest; response = await this.client.readIntent(prior.data.paymentIntentId, signal); }
    if (!response) return;
    const data = this.normalize(response.body, ctx, input, prepareDigest);
    if (action === 'PrepareStripePayment' ? data.status !== 'requires_payment_method' || data.hasPaymentError || data.amountReceived !== '0' || !!data.charge : !stripeTestCaptured(data)) throw new AgentReadError(`Original Stripe test payment is ${data.status}; its outcome remains unresolved`);
    return this.result(ctx, action, input, data, [account, response.receipt]);
  }
  project(ctx: AgentActionContext, action: string, result: AgentActionResult) { return projectStripePayment(ctx, action, result.value); }
  complete(ctx: AgentProgramContext, raw: unknown, orderRef: unknown, reads: PlanningSnapshot): StripePaymentObservation {
    const ref = objectRefSchema.parse(raw), input = { scope: ctx.state.scope, order: objectRefSchema.parse(orderRef), payment: ref };
    const s = this.payment(ctx, input), call = { function: 'stripePaymentStatus', object: ref }, result = ctx.graph.evaluate(ctx.owner, call);
    if (result.status !== 'known' || (result.value as { status?: string }).status !== 'test_paid' || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(call) && r.outputDigest === digest(result))) return fail('Completion requires an independently read and Agent-evaluated successful Stripe test capture');
    return s;
  }
}
