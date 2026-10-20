// Explicit loopback-only engineering service. Never registers a real merchant or moves money.
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ActionAdapter, AdapterContext, Delivery, Preparation } from '../core/catalog.js';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { ActionContext, ActionIntent, ActionResult } from '../ontology/actions.js';
import type { ExecutionPlan, ProviderBinding, ServiceCapability, PlanStep } from '../ontology/execution.js';

export const sandboxInputSchema = z.object({ quantity: z.number().int().min(1).max(100), unit: z.enum(['杯', '份']), deadline: z.iso.datetime({ offset: true }).optional() }).strict();
const money = z.string().regex(/^(0|[1-9]\d{0,17})$/);
export const sandboxOrderSchema = z.object({ id: z.uuid(), version: z.number().int().positive(), quoteId: z.uuid(), quantity: z.number().int().positive(), unit: z.string(), totalMinor: money, currency: z.literal('CNY'), payeeId: z.string(),
  paidMinor: money, refundedMinor: money, orderState: z.enum(['confirmed', 'canceled']), paymentState: z.enum(['not_started', 'pending', 'paid', 'failed']), fulfillmentState: z.enum(['pending', 'partial', 'delivered', 'failed']), refundState: z.enum(['not_started', 'pending', 'refunded', 'rejected']), deliveredQuantity: z.number().int().nonnegative(), deliveredAt: z.iso.datetime({ offset: true }).optional() });
export const sandboxQuoteSchema = z.object({ id: z.uuid(), quantity: z.number().int().positive(), unit: z.string(), totalMinor: money, currency: z.literal('CNY'), payeeId: z.string(), expiresAt: z.iso.datetime({ offset: true }), deliveryBy: z.iso.datetime({ offset: true }), capacity: z.number().int().nonnegative() });
type Payload = { quote: z.infer<typeof sandboxQuoteSchema>; query: z.infer<typeof sandboxInputSchema>; remedy?: { action: 'cancel' | 'refund'; originalOrderId: string; paidMinor: string } };
const place = { id: 'sandbox.place_order', version: '1' }, pay = { id: 'sandbox.pay', version: '1' }, observe = { id: 'sandbox.await_delivery', version: '1' }, cancel = { id: 'sandbox.cancel', version: '1' }, refund = { id: 'sandbox.refund', version: '1' };
export const SANDBOX_CAPABILITY: ServiceCapability = { ref: { id: 'service.fulfillment.sandbox', version: '1' }, ontologyRef: { id: 'sandbox-service-lifecycle', version: '1' }, name: 'Sandbox fulfillment and remediation', tags: ['sandbox', 'engineering'],
  description: 'Engineering test only: explicitly synthetic service, order, simulated payment, fulfillment and after-sales on an authenticated loopback provider. Never choose for a real-world purchase or delivery request. Requires quantity, unit and optional explicit deadline. No real merchant, money, address, payment instrument or fulfillment.',
  inputSchema: z.toJSONSchema(sandboxInputSchema), ontology: { objects: ['SandboxQuote', 'Order', 'Payment', 'Fulfillment', 'Refund'], rules: ['Order confirmation is not delivery', 'Refund pending is not refunded', 'Every effect uses its original business key', 'Only accepted output references may feed dependent actions'] },
  actions: [{ ref: place, effect: 'order' }, { ref: pay, effect: 'payment' }, { ref: observe, effect: 'read' }, { ref: cancel, effect: 'cancel' }, { ref: refund, effect: 'refund' }], completion: 'delivery', environment: 'sandbox', outcomePredicates: ['delivery.confirmed', 'refund.confirmed', 'order.canceled'],
  verifierRef: { id: 'sandbox.business-independent', version: '1' }, predicates: [{ id: 'environment.sandbox', description: 'Only the authenticated loopback sandbox, no real merchant or money' }, { id: 'delivery.confirmed', description: 'Provider delivery evidence confirms the requested outcome' }, { id: 'refund.confirmed', description: 'Provider confirms refund amount, not just its application' }, { id: 'order.canceled', description: 'Provider confirms business cancellation' }] };
export const SANDBOX_BINDING: ProviderBinding = { ref: { id: 'sandbox.loopback', version: '1' }, capabilityRef: SANDBOX_CAPABILITY.ref, providerId: 'sandbox-provider', channelId: 'sandbox', adapterId: 'sandbox.http.v1', protocol: 'http', enabled: true,
  verification: { level: 'simulated', evidenceRefs: ['tests/e2e/fulfillment.test.ts'] }, recovery: { idempotency: 'provider_key', lookup: true } };
export class SandboxServiceAdapter implements ActionAdapter {
  readonly id = 'sandbox.http.v1'; readonly environment = 'sandbox' as const;
  private origin: string;
  readonly configurationDigest: string;
  constructor(endpoint: string, private tokenFile: string) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !isAbsolute(tokenFile)) throw new Error('Sandbox adapter requires an authenticated loopback origin');
    this.origin = url.origin;
    this.configurationDigest = digest({ endpoint: this.origin, credentialRef: tokenFile, adapterVersion: '1' });
  }
  permitted(owner: string) { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  private async request(path: string, method: 'GET' | 'POST', body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const stat = lstatSync(this.tokenFile); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Private sandbox credential required');
    const token = readFileSync(this.tokenFile, 'utf8').trim(); if (!token || /\s/.test(token)) throw new Error('Sandbox credential unavailable');
    const response = await fetch(this.origin + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const text = await response.text(); if (Buffer.byteLength(text) > 262144) throw new Error('Sandbox receipt exceeds limit');
    const data = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
    if (data.environment !== 'sandbox' || (!response.ok && data.notFound !== true && data.rejected !== true)) throw new Error('Unverified sandbox response');
    return data;
  }
  async prepare(ctx: AdapterContext, input: unknown, signal: AbortSignal): Promise<Preparation> {
    if (!this.permitted(ctx.owner)) throw new DomainError('FORBIDDEN', 'Sandbox identity unavailable');
    if (ctx.request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'A real-world request cannot be fulfilled by a synthetic sandbox provider');
    const query = sandboxInputSchema.parse(input); const raw = await this.request('/quote', 'POST', query, signal); const quote = sandboxQuoteSchema.parse(raw.quote);
    if (quote.quantity !== query.quantity || quote.unit !== query.unit) throw new DomainError('CONFLICT', 'Sandbox quote changed the requested count');
    return { kind: 'ready', input: query, details: { environment: 'sandbox', quote }, facts: { quantity: { amount: String(quote.capacity >= query.quantity ? query.quantity : quote.capacity), unit: query.unit }, totalPrice: { minor: quote.totalMinor, currency: 'CNY' }, deliveryBy: quote.deliveryBy, conditions: ['environment.sandbox'] },
      evidenceRefs: [`sandbox:quote:${digest(raw)}`], observedAt: new Date().toISOString(), expiresAt: quote.expiresAt, privateData: { quote, query } satisfies Payload,
      recipe: [
        { id: 'order', operationId: 'purchase', actionTypeRef: place, input: { quoteId: quote.id, quantity: query.quantity, unit: query.unit, totalMinor: quote.totalMinor, currency: quote.currency, payeeId: quote.payeeId }, inputRefs: [], dependsOn: [], cost: { minor: '0', currency: 'CNY', payeeId: quote.payeeId } },
        { id: 'payment', operationId: 'payment', actionTypeRef: pay, input: { amountMinor: quote.totalMinor, currency: 'CNY', payeeId: quote.payeeId }, inputRefs: [{ stepId: 'order', path: 'remoteRef', targetKey: 'orderId' }], dependsOn: ['order'], cost: { minor: quote.totalMinor, currency: 'CNY', payeeId: quote.payeeId } },
        { id: 'delivery', operationId: 'delivery-observation', actionTypeRef: observe, input: {}, inputRefs: [{ stepId: 'order', path: 'remoteRef', targetKey: 'orderId' }], dependsOn: ['order', 'payment'] },
      ] };
  }
  validateInput(step: PlanStep, input: Record<string, unknown>): void {
    if (step.actionTypeRef.id === place.id) z.object({ quoteId: z.uuid(), quantity: z.number().int().positive(), unit: z.string(), totalMinor: money, currency: z.literal('CNY'), payeeId: z.string() }).strict().parse(input);
    else if (step.actionTypeRef.id === pay.id) z.object({ orderId: z.uuid(), amountMinor: money, currency: z.literal('CNY'), payeeId: z.string() }).strict().parse(input);
    else if (step.actionTypeRef.id === observe.id) z.object({ orderId: z.uuid() }).strict().parse(input);
    else if ([cancel.id, refund.id].includes(step.actionTypeRef.id)) z.object({ orderId: z.uuid(), amountMinor: money, currency: z.literal('CNY'), payeeId: z.string(), reason: z.string().min(1).max(1000) }).strict().parse(input);
    else throw new DomainError('FORBIDDEN', 'Unsupported sandbox action');
    if (['payment', 'refund'].includes(step.effect) && (!step.cost || step.cost.minor !== input.amountMinor || step.cost.currency !== input.currency || step.cost.payeeId !== input.payeeId)) throw new DomainError('FORBIDDEN', 'Payment/refund input exceeds its declared plan amount or counterparty');
  }
  async dispatch(ctx: ActionContext, data: unknown, signal: AbortSignal): Promise<ActionResult> {
    const action = ctx.step.actionTypeRef.id;
    const path = action === place.id ? '/orders' : action === observe.id ? `/orders/${ctx.input.orderId}` : `/orders/${ctx.input.orderId}/${action === pay.id ? 'pay' : action === cancel.id ? 'cancel' : 'refund'}`;
    const raw = await this.request(path, action === observe.id ? 'GET' : 'POST', action === observe.id ? undefined : { key: ctx.intent.businessOperationKey, input: ctx.input }, signal);
    return this.toResult(ctx, data as Payload, raw);
  }
  async observe(ctx: ActionContext, data: unknown, signal: AbortSignal): Promise<ActionResult> { return this.lookup(ctx, data as Payload, signal); }
  async reconcile(ctx: ActionContext, data: unknown, signal: AbortSignal): Promise<ActionResult> { return this.lookup(ctx, data as Payload, signal); }
  private async lookup(ctx: ActionContext, data: Payload, signal: AbortSignal) {
    const path = ctx.step.effect === 'read' ? `/orders/${ctx.input.orderId}` : `/operations/${ctx.intent.businessOperationKey}`;
    return this.toResult(ctx, data, await this.request(path, 'GET', undefined, signal));
  }
  private toResult(ctx: ActionContext, payload: Payload, raw: Record<string, unknown>): ActionResult {
    if (raw.notFound === true) return { kind: 'not_found', eventId: `${ctx.intent.businessOperationKey}:not-found`, sourceVersion: 0, evidenceRefs: [`sandbox:${digest(raw)}`], output: { operationKey: raw.key } };
    if (raw.rejected === true) return { kind: 'rejected', eventId: `${ctx.intent.businessOperationKey}:rejected`, sourceVersion: 0, evidenceRefs: [`sandbox:${digest(raw)}`], output: { operation: raw.operation } };
    const order = sandboxOrderSchema.parse(raw.order); const action = ctx.step.actionTypeRef.id;
    const done = action === place.id ? ['confirmed', 'canceled'].includes(order.orderState) : action === pay.id ? order.paymentState === 'paid' : action === cancel.id ? order.orderState === 'canceled' : action === refund.id ? order.refundState === 'refunded' : ['delivered', 'partial', 'failed'].includes(order.fulfillmentState);
    const evidenceRefs = [`sandbox:receipt:${digest(raw)}`];
    const result: ActionResult = { kind: done ? 'confirmed' : 'pending', eventId: `${ctx.intent.businessOperationKey}:${order.version}:${done ? 'confirmed' : 'pending'}`, sourceVersion: order.version, remoteRef: order.id,
      output: { remoteRef: order.id, record: order, ...(raw.operation ? { operation: raw.operation } : {}) }, business: { order: order.orderState, payment: order.paymentState, fulfillment: order.fulfillmentState, refund: order.refundState }, evidenceRefs, retryAfterMs: 100 };
    if (done && [observe.id, cancel.id, refund.id].includes(action)) {
      const facts = { quantity: { amount: String(order.deliveredQuantity), unit: order.unit }, totalPrice: { minor: order.paidMinor, currency: 'CNY' }, deliveryBy: order.deliveredAt,
        conditions: ['environment.sandbox', order.fulfillmentState === 'delivered' ? 'delivery.confirmed' : '', order.refundState === 'refunded' ? 'refund.confirmed' : '', order.orderState === 'canceled' ? 'order.canceled' : ''].filter(Boolean) };
      result.business!.facts = facts;
      result.delivery = { artifact: { id: digest({ orderId: order.id, version: order.version, action }), name: action === refund.id ? 'sandbox-refund.json' : action === cancel.id ? 'sandbox-cancel.json' : 'sandbox-delivery.json',
        data: { goal: ctx.goal, deliverable: 'Sandbox provider receipt independently checked; no real merchant or money.', execution: 'completed', result: { environment: 'sandbox', receipt: order, action, expectedRefundMinor: payload.remedy?.paidMinor } } }, facts, evidenceRefs };
    }
    return result;
  }
  verifyAction(ctx: ActionContext, result: ActionResult) {
    try {
      if (result.kind === 'not_found') return { accepted: result.output?.operationKey === ctx.intent.businessOperationKey, reason: 'Original-key lookup did not establish an effect; never replay' };
      const operation = result.output?.operation as { key?: string; inputDigest?: string } | undefined;
      if (ctx.step.effect !== 'read' && (operation?.key !== ctx.intent.businessOperationKey || operation.inputDigest !== ctx.attempt.inputDigest)) throw new Error('Operation/input reference mismatch');
      if (result.kind === 'rejected') return { accepted: !!operation, reason: 'Provider explicitly rejected the exact operation' };
      const order = sandboxOrderSchema.parse(result.output?.record);
      if (result.remoteRef !== order.id || (ctx.input.orderId !== undefined && ctx.input.orderId !== order.id) || (ctx.input.payeeId !== undefined && ctx.input.payeeId !== order.payeeId)) throw new Error('Wrong business object or payee');
      if (ctx.step.effect === 'payment' && result.kind === 'confirmed' && (order.paidMinor !== ctx.input.amountMinor || order.paymentState !== 'paid')) throw new Error('Unverified payment amount');
      return { accepted: true, reason: 'Provider operation key, input digest, object, payee and payment amount verified' };
    } catch { return { accepted: false, reason: 'Sandbox action receipt does not match the fixed operation' }; }
  }
  verify(ctx: AdapterContext, plan: ExecutionPlan, data: unknown, delivery: Delivery) {
    try {
      const payload = data as Payload; const report = delivery.artifact.data.result as { environment: string; receipt: unknown; action: string }; const record = sandboxOrderSchema.parse(report.receipt);
      if (report.environment !== 'sandbox' || record.quoteId !== payload.quote.id || record.quantity !== payload.query.quantity || record.unit !== payload.query.unit || record.payeeId !== payload.quote.payeeId) throw new Error('Input/object mismatch');
      if (ctx.request.outcome === 'refund') { if (record.refundState !== 'refunded' || record.refundedMinor !== payload.remedy?.paidMinor) throw new Error('Refund not received in full'); }
      else if (ctx.request.outcome === 'cancel') { if (record.orderState !== 'canceled') throw new Error('Cancellation not confirmed'); }
      else if (record.fulfillmentState !== 'delivered' || record.deliveredQuantity !== payload.query.quantity || record.paymentState !== 'paid' || record.paidMinor !== payload.quote.totalMinor || !record.deliveredAt) throw new Error('Delivery/payment evidence incomplete');
      return { accepted: true, reason: 'Independent sandbox original-object, amount and goal-specific delivery/refund/cancellation verification passed' };
    } catch { return { accepted: false, reason: 'Independent sandbox business outcome verification failed' }; }
  }
  prepareRemediation(ctx: AdapterContext, originalPlan: ExecutionPlan, remoteRef: string, action: 'cancel' | 'refund', reason: string, originalIntents: ActionIntent[]): Preparation {
    const original = originalIntents.find(i => i.effect === 'order' && i.remoteRef === remoteRef); if (!original) throw new DomainError('CONFLICT', 'Original order evidence unavailable');
    const payload = original.privateData as Payload; const payment = originalIntents.find(i => i.remoteRef === remoteRef && i.businessSnapshot?.value.payment === 'paid');
    const paid = payment?.lastVerifiedResult?.output?.record as { paidMinor?: string } | undefined;
    if (action === 'refund' && !paid?.paidMinor) throw new DomainError('CONFLICT', 'Original paid amount unavailable');
    const amount = action === 'refund' ? paid!.paidMinor! : '0';
    const input = { orderId: remoteRef, amountMinor: amount, currency: 'CNY', payeeId: payload.quote.payeeId, reason };
    return { kind: 'ready', input, details: { environment: 'sandbox', originalPlanDigest: originalPlan.digest, originalOrderRef: remoteRef }, facts: {}, evidenceRefs: [original.latestObservationId!], observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
      privateData: { ...payload, remedy: { action, originalOrderId: remoteRef, paidMinor: amount } } satisfies Payload,
      recipe: [{ id: action, operationId: action, actionTypeRef: action === 'refund' ? refund : cancel, input, inputRefs: [], dependsOn: [], cost: { minor: amount, currency: 'CNY', payeeId: payload.quote.payeeId } }] };
  }
}
