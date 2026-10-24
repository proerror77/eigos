import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError, type Job } from '../core/domain.js';
import { AgentOperationRejected, type AgentActionContext, type AgentActionResult, type AgentProgram, type AgentProgramContext } from '../core/agent-program.js';
import type { Delivery, Preparation } from '../core/catalog.js';
import type { JobStore } from '../core/store.js';
import type { ServiceRequest } from '../ontology/execution.js';
import type { ActionResult } from '../ontology/actions.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import { linkSnapshotDigest, type OntologyObjectStore } from '../ontology/object-store.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import { domainPreparedReceiptSchema } from '../ontology/domain-composition.js';
import { sandboxActionSchemas, sandboxAtomicOperations, sandboxScopeSchema } from '../ontology/sandbox-composition.js';
import { objectResultProjection } from '../core/composed-actions.js';
import { SandboxServiceAdapter, SANDBOX_CAPABILITY, SANDBOX_BINDING, sandboxInputSchema, sandboxQuoteSchema, sandboxOrderSchema } from './sandbox-service.js';
import { adapterActionContext, adapterInvocation } from './atomic-adapter.js';

const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const completion = z.strictObject({ result: objectRefSchema.extend({ type: z.literal('SandboxOrderObservation') }) });
type Prepared = Omit<Extract<Preparation, { kind: 'ready' }>, 'recipe'>;
type Payload = { quote: z.infer<typeof sandboxQuoteSchema>; query: z.infer<typeof sandboxInputSchema>; remedy?: { action: 'cancel' | 'refund'; originalOrderId: string; paidMinor: string }; providerInput?: Record<string, unknown> };

export class SandboxAgentProgram implements AgentProgram {
  readonly ref = { id: 'service.fulfillment.sandbox.atomic', version: '1' }; readonly actionIds = Object.keys(sandboxActionSchemas); readonly completionSchema = z.toJSONSchema(completion);
  readonly guidance = 'Explicit simulator only. Prepare an immutable quantity/unit/deadline scope, read its quote, then select individual order, payment and original-order reads as needed. Order and payment do not prove delivery. AwaitSandboxDelivery retains the original operation while pending; partial delivery must not complete a delivery goal. For a linked after-sales task, query the request\'s remedyCases relationship and prepare {caseId}; ReadSandboxRemedyOrder reads only that case\'s original order. Then select only its requested cancel/refund action under separate authorization. Every write and its exact amount requires a new explicit frontier. Never run a recipe or replace an uncertain order.';
  readonly configurationDigest: string;
  constructor(readonly adapter: SandboxServiceAdapter, private store?: JobStore) { this.configurationDigest = adapter.configurationDigest; }
  permitted(owner: string) { return this.adapter.permitted(owner); }
  capability() { return { ...SANDBOX_CAPABILITY, ref: this.ref, inputSchema: z.toJSONSchema(sandboxScopeSchema), actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: id === 'SubmitSandboxOrder' ? 'order' as const : id === 'ExecuteSandboxPayment' ? 'payment' as const : id === 'ExecuteSandboxCancel' ? 'cancel' as const : id === 'ExecuteSandboxRefund' ? 'refund' as const : 'read' as const })),
    goalOutcomes: [{ predicate: 'delivery.confirmed', phase: 'delivery' as const, description: 'Exact requested synthetic delivery and payment independently verified' }, { predicate: 'refund.confirmed', phase: 'payment' as const, description: 'Original paid amount actually refunded by the simulator' }, { predicate: 'order.canceled', phase: 'fact' as const, description: 'Original simulator order is canceled' }],
    predicates: [...SANDBOX_CAPABILITY.predicates, { id: 'sandbox.refund_only', description: 'Only original-operation reads and the explicitly requested refund' }, { id: 'sandbox.cancel_only', description: 'Only original-operation reads and the explicitly requested cancellation' }],
    effectConstraints: [{ predicate: 'sandbox.refund_only', allowedEffects: ['read' as const, 'local' as const, 'refund' as const] }, { predicate: 'sandbox.cancel_only', allowedEffects: ['read' as const, 'local' as const, 'cancel' as const] }] }; }
  listingBinding() { return { ...SANDBOX_BINDING, ref: { id: 'sandbox.loopback.atomic', version: '1' }, capabilityRef: this.ref, configurationDigest: this.configurationDigest }; }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown, component?: { id: string; scopeKey: string }) {
    if (!this.permitted(owner) || request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'Sandbox source requires the explicit isolated environment');
    const input = sandboxScopeSchema.parse(raw), scope = { type: 'SandboxTask', id: `${request.id}:r${request.revision}:c${component?.scopeKey ?? digest(this.ref)}` };
    if ('caseId' in input) this.remedy(owner, request, input.caseId);
    else if (request.outcome) fail('After-sales requires its exact existing case');
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: '模拟履约范围', requestRevision: request.revision, input, configurationDigest: this.configurationDigest } }], links: [{ type: 'SandboxTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  assertContext(ctx: AgentProgramContext) { const view = ctx.graph.read(ctx.owner, ctx.state.scope); if (!this.permitted(ctx.owner) || ctx.request.executionEnvironment !== 'sandbox' || ctx.state.programDigest !== this.configurationDigest || !same(ctx.state.programRef, this.ref) || view.ref.type !== 'SandboxTask' || view.properties.configurationDigest !== this.configurationDigest || view.properties.requestRevision !== ctx.request.revision || !same(view.properties.input, ctx.state.input)) fail('Sandbox scope or configured source changed'); if ('caseId' in ctx.state.input) this.remedy(ctx.owner, ctx.request, String(ctx.state.input.caseId)); }
  schema(action: string): z.ZodType<Record<string, unknown>> { return sandboxActionSchemas[action as keyof typeof sandboxActionSchemas] ?? fail('Unknown simulator action'); }
  definition(graph: OntologyObjectStore, action: string) { const value = graph.model.action(action); if (!same((value.read ?? value.operation)?.inputSchema, z.toJSONSchema(this.schema(action)))) fail('Simulator action differs from its published contract'); return value; }
  private remedy(owner: string, request: ServiceRequest, caseId: string) {
    const store = this.store ?? fail('Original after-sales ledger is unavailable'), job = store.get(owner, request.id), item = store.afterSalesCase(owner, caseId);
    if (!item || item.remedyJobId !== request.id || job.delegation?.afterSalesCaseId !== caseId || item.configurationDigest !== this.configurationDigest || !same(item.programRef, this.ref) || item.action !== request.outcome || !item.originalIntentId || !item.reason) return fail('After-sales scope is not this task\'s current owned original case');
    const original = store.intent(owner, item.originalIntentId), source = store.get(owner, item.originalJobId), step = source.delegation?.agent?.plans.find(plan => plan.digest === original.planDigest)?.steps.find(step => step.intentId === original.id);
    if (original.jobId !== item.originalJobId || original.remoteRef !== item.remoteRef || step?.binding?.configurationDigest !== this.configurationDigest || !same(step.binding.programRef, this.ref)) fail('Original after-sales source changed');
    const paid = store.intents(owner, source.id).filter(value => value.remoteRef === item.remoteRef && value.businessSnapshot?.value.payment === 'paid').sort((a, b) => (b.latestVersion ?? 0) - (a.latestVersion ?? 0))[0];
    const record = sandboxOrderSchema.parse((paid ?? original).lastVerifiedResult?.output?.record), payload = original.privateData as Payload;
    if (item.action === 'refund' && record.paymentState !== 'paid') fail('No original independently verified payment');
    return { item, payload: { ...payload, remedy: { action: item.action, originalOrderId: item.remoteRef, paidMinor: item.action === 'refund' ? record.paidMinor : '0' } } as Payload };
  }
  private quote(ctx: AgentProgramContext, raw: unknown) {
    const ref = objectRefSchema.parse(raw), object = ctx.graph.read(ctx.owner, ref), receipt = domainPreparedReceiptSchema.parse(object.properties.receipt), intent = ctx.intents?.find(value => value.id === receipt.intentId && value.state === 'effect_confirmed' && same(value.acceptedOutput?.object, ref));
    const value = intent?.lastVerifiedResult?.output?.source as Prepared | undefined;
    if (ref.type !== 'SandboxQuoteObservation' || !value || receipt.preparationDigest !== digest(value) || receipt.configurationDigest !== this.configurationDigest || !same(receipt.scope, ctx.state.scope) || Date.parse(receipt.expiresAt) <= Date.now()) return fail('Simulator quote expired or is not the accepted original source');
    const payload = value.privateData as Payload;
    if (!same(object.properties.quote, payload.quote) || payload.quote.capacity < payload.query.quantity || payload.query.deadline && Date.parse(payload.quote.deliveryBy) > Date.parse(payload.query.deadline)) fail('Exact quote cannot meet the requested quantity or deadline');
    return payload;
  }
  private order(ctx: AgentProgramContext, raw: unknown, current = false) {
    const ref = objectRefSchema.parse(raw), object = ctx.graph.read(ctx.owner, ref), record = sandboxOrderSchema.parse(object.properties.record);
    const intent = ctx.intents?.find(value => value.id === object.properties.intentId && value.state === 'effect_confirmed' && same(value.acceptedOutput?.object, ref));
    if (ref.type !== 'SandboxOrderObservation' || !intent || !same(object.properties.scope, ctx.state.scope) || !same(intent.lastVerifiedResult?.output?.record, record)) return fail('Simulator action requires its own accepted original order observation');
    if (current && ctx.intents?.some(value => value.remoteRef === record.id && (value.latestVersion ?? 0) > record.version)) fail('Read the latest original order before another business decision');
    return { record, payload: intent.privateData as Payload, intent, object };
  }
  validate(ctx: AgentProgramContext, action: string, raw: Record<string, unknown>) {
    this.assertContext(ctx); const input = this.schema(action).parse(raw); if (!same(input.scope, ctx.state.scope)) fail('Simulator action uses another scope');
    const remedy = 'caseId' in ctx.state.input ? this.remedy(ctx.owner, ctx.request, String(ctx.state.input.caseId)) : undefined;
    if (remedy && !['ReadSandboxRemedyOrder', 'ReadSandboxOrder', remedy.item.action === 'refund' ? 'ExecuteSandboxRefund' : 'ExecuteSandboxCancel'].includes(action)) fail('After-sales may only read or perform its exactly requested remedy');
    if (action === 'ReadSandboxRemedyOrder' && !remedy) fail('Original cross-task order reads require an owned after-sales case');
    if ('quote' in input) this.quote(ctx, input.quote);
    if ('order' in input) {
      const { record } = this.order(ctx, input.order, !['ReadSandboxOrder', 'AwaitSandboxDelivery'].includes(action));
      if (action === 'ExecuteSandboxPayment' && (record.orderState !== 'confirmed' || record.paymentState !== 'not_started')) fail('Only the original confirmed unpaid order can be paid');
      if (action === 'ExecuteSandboxRefund' && (record.paymentState !== 'paid' || record.refundState !== 'not_started')) fail('Only the original paid and not-yet-refunded amount can be requested');
      if (action === 'ExecuteSandboxCancel' && record.orderState !== 'confirmed') fail('Original order is already canceled');
    }
  }
  private inputs(ctx: AgentProgramContext, action: string, input: Record<string, unknown>): Payload {
    if (action === 'ReadSandboxRemedyOrder') { const { item, payload } = this.remedy(ctx.owner, ctx.request, String(ctx.state.input.caseId)); return { ...payload, providerInput: { orderId: item.remoteRef } }; }
    if (action === 'SubmitSandboxOrder') { const payload = this.quote(ctx, input.quote), quote = payload.quote; return { ...payload, providerInput: { quoteId: quote.id, quantity: payload.query.quantity, unit: payload.query.unit, totalMinor: quote.totalMinor, currency: quote.currency, payeeId: quote.payeeId } }; }
    const { record, payload } = this.order(ctx, input.order), amount = action === 'ExecuteSandboxPayment' ? record.totalMinor : action === 'ExecuteSandboxRefund' ? record.paidMinor : '0';
    const remedy = action === 'ExecuteSandboxCancel' || action === 'ExecuteSandboxRefund';
    return { ...payload, ...(remedy ? { remedy: { action: action === 'ExecuteSandboxRefund' ? 'refund' as const : 'cancel' as const, originalOrderId: record.id, paidMinor: amount } } : {}), providerInput: { orderId: record.id, ...(!['ReadSandboxOrder', 'AwaitSandboxDelivery'].includes(action) ? { amountMinor: amount, currency: record.currency, payeeId: record.payeeId, ...(remedy ? { reason: input.reason } : {}) } : {}) } };
  }
  privateInput(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) { return action === 'ReadSandboxQuote' ? {} : this.inputs(ctx, action, input); }
  authority(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) { this.validate(ctx, action, input); const data = this.inputs(ctx, action, input), paid = action === 'ExecuteSandboxPayment' || action === 'ExecuteSandboxRefund'; return { cost: { minor: paid ? String(data.providerInput!.amountMinor) : '0', currency: data.quote.currency, payeeId: data.quote.payeeId }, budgetImpact: { key: `${ctx.state.scope.id}:${data.quote.id}`, kind: action === 'ExecuteSandboxPayment' ? 'spend' as const : 'commitment' as const, role: 'service_total' as const, amount: { minor: data.quote.totalMinor, currency: data.quote.currency } }, operationScope: `${this.configurationDigest}:${data.providerInput!.orderId ?? ctx.state.scope.id}` }; }
  private invocation(ctx: AgentActionContext, action: string) { const data = ctx.execution?.intent.privateData as Payload, input = data.providerInput ?? fail('Missing original sealed simulator input'), operation = sandboxAtomicOperations[action as keyof typeof sandboxAtomicOperations]; if (!operation) return fail('Unsupported simulator operation'); const plan = adapterInvocation(ctx, ctx.intentId, this.listingBinding(), { id: operation, version: '1' }, input); this.adapter.validateInput(plan.steps[0]!, input); return { context: adapterActionContext(ctx, plan, input), data }; }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    if (action === 'ReadSandboxQuote') { const prepared = await this.adapter.prepare(ctx, ctx.state.input, signal); if (prepared.kind !== 'ready') throw new AgentOperationRejected(prepared.kind === 'unavailable' ? prepared.reason : prepared.question, []); const { recipe: _recipe, ...value } = prepared; return { value, evidenceRefs: prepared.evidenceRefs }; }
    const invocation = this.invocation(ctx, action); ctx.assertDispatchAllowed?.(); const result = await this.adapter.dispatch(invocation.context, invocation.data, signal); if (!this.adapter.verifyAction(invocation.context, result).accepted) fail('Simulator operation receipt did not match the original intent'); return { value: result, evidenceRefs: result.evidenceRefs, observation: result };
  }
  async recover(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, signal: AbortSignal) { if (action === 'ReadSandboxQuote') return; const invocation = this.invocation(ctx, action), result = await this.adapter.reconcile(invocation.context, invocation.data, signal); if (!this.adapter.verifyAction(invocation.context, result).accepted) fail('Original simulator lookup failed verification'); return { value: result, evidenceRefs: result.evidenceRefs, observation: result }; }
  project(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, result: AgentActionResult) {
    const quote = action === 'ReadSandboxQuote', prepared = quote ? result.value as Prepared : undefined, operation = quote ? undefined : result.value as ActionResult;
    const object = { type: quote ? 'SandboxQuoteObservation' : 'SandboxOrderObservation', id: digest({ intent: ctx.intentId, attempt: ctx.attemptId }) }, sourceEvent = prepared?.evidenceRefs[0] ?? operation!.eventId, proof = { type: 'SourceReceipt', id: digest({ object, sourceEvent }) }, observedAt = prepared?.observedAt ?? new Date().toISOString();
    const properties = { id: object.id, displayTitle: quote ? '模拟履约报价' : '原始模拟订单观察', requestRevision: ctx.request.revision, ...(prepared ? { quote: (prepared.privateData as Payload).quote, receipt: domainPreparedReceiptSchema.parse({ configurationDigest: this.configurationDigest, scope: ctx.state.scope, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, preparationDigest: digest(prepared), evidenceRefs: prepared.evidenceRefs, observedAt, expiresAt: prepared.expiresAt }) } : { record: sandboxOrderSchema.parse(operation!.output?.record), intentId: ctx.intentId, action, scope: ctx.state.scope }) };
    const links = [{ type: `${object.type}Request`, from: object, to: { type: 'ServiceRequest', id: ctx.request.id } }, { type: `${object.type}Evidence`, from: object, to: proof }];
    ctx.graph.ingest(ctx.owner, { objects: [{ ref: object, properties }, { ref: proof, properties: { receiptId: proof.id, displayTitle: '模拟服务来源回执', sourceIdentity: `sandbox:${this.configurationDigest}`, sourceEventId: sourceEvent, scope: quote ? 'goods_offer' : action === 'ExecuteSandboxRefund' ? 'refund' : action === 'ExecuteSandboxPayment' ? 'payment' : action === 'AwaitSandboxDelivery' ? 'delivery' : 'order', observedAt, evidenceLevel: 'synthetic', contentDigest: digest(result.value), subjects: [{ object, digest: digest(properties), linksDigest: linkSnapshotDigest(object, links) }], safeSummary: 'Original authenticated loopback observation; no real transaction or fulfillment' } }], links: [...links, { type: 'ReceiptRequest', from: proof, to: { type: 'ServiceRequest', id: ctx.request.id } }] }, { kind: 'synthetic', id: sourceEvent, observedAt });
    return object;
  }
  projectOutputs(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef) { return objectResultProjection(object, { origin: 'synthetic', refs: result.evidenceRefs, observedAt: ctx.graph.read(ctx.owner, object).source.observedAt, ...(action === 'ReadSandboxQuote' ? { expiresAt: (result.value as Prepared).expiresAt } : {}) }, action !== 'ReadSandboxQuote'); }
  validateOutput(ctx: AgentProgramContext, output: import('../ontology/composition-contract.js').AcceptedPortValue) {
    if (output.port === 'identity') return;
    const ref = objectRefSchema.parse(output.value);
    if (ref.type === 'SandboxQuoteObservation') this.quote(ctx, ref); else this.order(ctx, ref, true);
  }
  remediationTarget(ctx: AgentProgramContext, action: 'cancel' | 'refund') {
    if (!this.store || 'caseId' in ctx.state.input) return;
    this.assertContext(ctx); const originals = ctx.intents?.filter(value => value.effect === 'order' && value.state === 'effect_confirmed' && value.remoteRef) ?? [];
    if (!originals.length) return; if (originals.length !== 1) fail('Select one original order before requesting after-sales');
    const original = originals[0]!;
    if (action === 'refund' && !ctx.intents?.some(value => value.remoteRef === original.remoteRef && value.businessSnapshot?.value.payment === 'paid')) fail('Reconcile the original paid amount before requesting refund');
    return { originalIntentId: original.id, remoteRef: original.remoteRef!, predicate: action === 'refund' ? 'refund.confirmed' : 'order.canceled', constraintPredicate: `sandbox.${action}_only` };
  }
  onCompletionAccepted(ctx: AgentProgramContext, job: Job) { if (job.delegation?.afterSalesCaseId && this.store) this.store.updateAfterSales(ctx.owner, job.delegation.afterSalesCaseId, 'resolved'); }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    this.assertContext(ctx); const ref = completion.parse(raw).result, { record, intent, object, payload } = this.order(ctx, ref, true);
    if (!(reads.deliveredObjects ?? reads.objects).some(value => same(value.ref, ref))) fail('Read the exact latest simulator result before completion');
    const result = intent.lastVerifiedResult?.output?.source as ActionResult | undefined, delivery = result?.delivery ?? fail('Order or payment alone cannot complete fulfillment or after-sales');
    const action = String(object.properties.action), operation = sandboxAtomicOperations[action as keyof typeof sandboxAtomicOperations], input = payload.providerInput!;
    const plan = adapterInvocation(ctx, intent.id, this.listingBinding(), { id: operation, version: '1' }, input);
    const outcome = action === 'ExecuteSandboxRefund' ? 'refund' as const : action === 'ExecuteSandboxCancel' ? 'cancel' as const : ctx.request.outcome;
    if (!this.adapter.verify({ ...ctx, request: { ...ctx.request, outcome } }, plan, payload, delivery).accepted) fail('Simulator delivery, cancellation or exact refund is not independently verified');
    return { ...delivery, facts: { ...delivery.facts, ...(ctx.request.outcome ? { conditions: [...(delivery.facts.conditions ?? []), `sandbox.${ctx.request.outcome}_only`] } : {}) }, economicFacts: [{ key: `${this.configurationDigest}:${record.id}`, phase: outcome === 'refund' ? 'refund' : 'payment', amount: { minor: record.paidMinor, currency: record.currency }, role: 'service_total', evidenceRefs: delivery.evidenceRefs }] };
  }
}
