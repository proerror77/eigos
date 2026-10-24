import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import { AgentOperationRejected, type AgentActionContext, type AgentActionResult, type AgentProgram, type AgentProgramContext } from '../../core/agent-program.js';
import type { Delivery, Preparation } from '../../core/catalog.js';
import type { ServiceRequest } from '../../ontology/execution.js';
import { objectRefSchema, type ObjectRef } from '../../ontology/model.js';
import { linkSnapshotDigest, type OntologyObjectStore } from '../../ontology/object-store.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import type { ActionResult } from '../../ontology/actions.js';
import { commerceSnapshotSchema } from '../../ontology/commerce.js';
import { projectCommerceSnapshot } from '../../ontology/commerce-projection.js';
import { domainPreparedReceiptSchema } from '../../ontology/domain-composition.js';
import { ucpConfirmScopeSchema, ucpSchemas } from '../../ontology/ucp-composition.js';
import { objectResultProjection } from '../../core/composed-actions.js';
import { adapterActionContext, adapterInvocation } from '../atomic-adapter.js';
import { prepareCheckoutInput, UcpSandboxAdapter } from './adapter.js';

const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const completion = z.strictObject({ result: objectRefSchema.extend({ type: z.literal('UcpCheckoutObservation') }) });
type Prepared = Omit<Extract<Preparation, { kind: 'ready' }>, 'recipe'>;

/** Model-selected reads and writes, each reusing the original protocol verifier.
 * No component completes its parent or chooses another component's next action. */
export class UcpAgentProgram implements AgentProgram {
  readonly ref; readonly configurationDigest; readonly actionIds; readonly completionSchema = z.toJSONSchema(completion);
  readonly guidance;
  constructor(readonly adapter: UcpSandboxAdapter) {
    this.ref = { id: `${adapter.id}.atomic`, version: '1' }; this.configurationDigest = adapter.configurationDigest;
    this.actionIds = adapter.mode === 'prepare' ? ['ReadUcpCreateTerms', 'CreateUcpCheckout'] : ['ReadUcpConfirmationTerms', 'ConfirmUcpCheckout'];
    this.guidance = adapter.mode === 'prepare'
      ? 'Prepare a pure scope from exact item IDs, integer quantities and a configured fulfillment profile. Read current create terms, then choose whether to authorize and create one checkout. Return its immutable UcpCheckoutObservation. This only prepares a checkout; a different confirmation binding can consume that accepted output in this same task.'
      : 'Prepare only the explicit currency budget. ReadUcpConfirmationTerms consumes a prior accepted UcpCheckoutObservation from this same task and exact merchant configuration. It rechecks original items, address and quote before confirming. ConfirmUcpCheckout requires both sandbox order and payment authorization. Independently read the returned observation before completion. Unknown writes use only the original checkout; never create a replacement.';
  }
  permitted(owner: string) { return this.adapter.permitted(owner); }
  capability() {
    const old = this.adapter.capability(), confirm = this.adapter.mode === 'confirm';
    return { ...old, ref: { id: `${old.ref.id}.atomic`, version: '1' }, inputSchema: z.toJSONSchema(confirm ? ucpConfirmScopeSchema : prepareCheckoutInput),
      actions: this.actionIds.map((id, index) => ({ ref: { id, version: '1' }, effect: index === 0 ? 'read' as const : confirm ? 'order' as const : 'reserve' as const, ...(index === 1 && confirm ? { additionalEffects: ['payment' as const] } : {}) })),
      goalOutcomes: [{ predicate: confirm ? 'ucp.order.confirmed' : 'ucp.checkout.prepared', phase: confirm ? 'commitment' as const : 'artifact' as const, description: confirm ? 'Original sandbox order independently read, without delivery or real payment claims' : 'Original local checkout prepared, without purchase' }] };
  }
  listingBinding() { return { ...this.adapter.binding(), ref: this.ref, capabilityRef: this.capability().ref }; }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown, component?: { id: string; scopeKey: string }) {
    if (!this.permitted(owner) || request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'Only the configured isolated UCP sandbox is available');
    const input = (this.adapter.mode === 'prepare' ? prepareCheckoutInput : ucpConfirmScopeSchema).parse(raw), scope = { type: 'UcpTask', id: `${request.id}:r${request.revision}:c${component?.scopeKey ?? digest(this.ref)}` };
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: 'UCP 操作范围', requestRevision: request.revision, mode: this.adapter.mode, input, configurationDigest: this.configurationDigest } }], links: [{ type: 'UcpTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  assertContext(ctx: AgentProgramContext) { const scope = ctx.graph.read(ctx.owner, ctx.state.scope); if (!this.permitted(ctx.owner) || ctx.request.executionEnvironment !== 'sandbox' || ctx.state.programDigest !== this.configurationDigest || !same(ctx.state.programRef, this.ref) || scope.ref.type !== 'UcpTask' || scope.properties.mode !== this.adapter.mode || scope.properties.requestRevision !== ctx.request.revision || scope.properties.configurationDigest !== this.configurationDigest || !same(scope.properties.input, ctx.state.input)) fail('UCP context or merchant configuration changed'); }
  schema(action: string): z.ZodType<Record<string, unknown>> { return this.actionIds.includes(action) ? ucpSchemas[action as keyof typeof ucpSchemas] : fail('Unknown UCP operation'); }
  definition(graph: OntologyObjectStore, action: string) { const definition = graph.model.action(action); if (!same((definition.read ?? definition.operation)?.inputSchema, z.toJSONSchema(this.schema(action)))) fail('UCP action definition differs from its bound handler'); return definition; }
  private checkout(ctx: AgentProgramContext, raw: unknown) {
    const ref = objectRefSchema.parse(raw), object = ctx.graph.read(ctx.owner, ref), snapshot = commerceSnapshotSchema.parse(object.properties.snapshot);
    const original = (ctx.taskIntents ?? ctx.intents)?.find(intent => intent.id === object.properties.intentId && intent.state === 'effect_confirmed' && same(intent.acceptedOutput?.object, ref));
    const result = original?.lastVerifiedResult?.output?.source as ActionResult | undefined;
    if (ref.type !== 'UcpCheckoutObservation' || !original || !result || !same(result.output?.ucpSnapshot, snapshot) || snapshot.configurationDigest !== this.configurationDigest || snapshot.requestId !== ctx.request.id || snapshot.requestRevision !== ctx.request.revision || snapshot.operation !== 'prepare') fail('Confirmation requires this task\'s accepted original prepared checkout from this exact merchant');
    return snapshot;
  }
  private prepared(ctx: AgentProgramContext, raw: unknown) {
    const ref = objectRefSchema.parse(raw), receipt = domainPreparedReceiptSchema.parse(ctx.graph.read(ctx.owner, ref).properties.receipt);
    const intent = ctx.intents?.find(value => value.id === receipt.intentId && value.state === 'effect_confirmed' && same(value.acceptedOutput?.object, ref));
    const value = intent?.lastVerifiedResult?.output?.source as Prepared | undefined;
    if (ref.type !== 'UcpOperationTerms' || !value || receipt.configurationDigest !== this.configurationDigest || !same(receipt.scope, ctx.state.scope) || receipt.preparationDigest !== digest(value) || Date.parse(receipt.expiresAt) <= Date.now()) return fail('UCP terms are expired or lack their original accepted preparation');
    return value;
  }
  validate(ctx: AgentProgramContext, action: string, raw: Record<string, unknown>) { this.assertContext(ctx); const input = this.schema(action).parse(raw); if (!same(input.scope, ctx.state.scope)) fail('UCP operation uses another scope'); if ('terms' in input) this.prepared(ctx, input.terms); if ('checkout' in input) this.checkout(ctx, input.checkout); }
  privateInput(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) { return action.startsWith('Read') ? {} : this.prepared(ctx, input.terms).privateData; }
  authority(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    this.validate(ctx, action, input); const prepared = this.prepared(ctx, input.terms), data = prepared.privateData as { checkout?: { id: string; total: { minor: string; currency: string } } };
    return { cost: { ...(data.checkout?.total ?? { minor: '0', currency: 'USD' }), payeeId: this.listingBinding().providerId },
      ...(data.checkout ? { budgetImpact: { key: this.adapter.operationScope(data.checkout.id), kind: 'commitment' as const, role: 'service_total' as const, amount: data.checkout.total } } : {}),
      operationScope: data.checkout ? this.adapter.operationScope(data.checkout.id) : `${this.ref.id}:${ctx.state.scope.id}` };
  }
  private invocation(ctx: AgentActionContext) {
    const data = ctx.execution?.intent.privateData as { expectedItems: unknown; budget?: unknown };
    const input = this.adapter.mode === 'prepare' ? ctx.state.input : { preparationTaskId: ctx.request.id, budget: data.budget };
    const plan = adapterInvocation(ctx, ctx.intentId, this.listingBinding(), this.adapter.capability().actions[0]!.ref, input);
    return { context: adapterActionContext(ctx, plan, input), data };
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    if (action.startsWith('Read')) {
      const original = this.adapter.mode === 'confirm' ? this.checkout(ctx, input.checkout) : undefined;
      const prepared = await this.adapter.prepare(ctx, original ? { preparationTaskId: ctx.request.id, budget: ctx.state.input.budget } : ctx.state.input, signal, original);
      if (prepared.kind !== 'ready') throw new AgentOperationRejected(prepared.kind === 'unavailable' ? prepared.reason : prepared.question, []);
      const { recipe: _recipe, ...value } = prepared; return { value, evidenceRefs: prepared.evidenceRefs };
    }
    const invocation = this.invocation(ctx); ctx.assertDispatchAllowed?.(); const result = await this.adapter.dispatch(invocation.context, invocation.data, signal);
    if (!this.adapter.verifyAction(invocation.context, result).accepted) fail('UCP original operation receipt failed validation');
    return { value: result, evidenceRefs: result.evidenceRefs, observation: result };
  }
  async recover(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, signal: AbortSignal) {
    if (action.startsWith('Read')) return;
    const invocation = this.invocation(ctx), result = await this.adapter.reconcile(invocation.context, invocation.data, signal);
    // Missing create response has no provider lookup key. Preserve unknown;
    // accepting a new write or inventing a checkout reference would be unsafe.
    if (result.kind !== 'unknown' && !this.adapter.verifyAction(invocation.context, result).accepted) fail('Original UCP recovery receipt failed validation');
    return { value: result, evidenceRefs: result.evidenceRefs, observation: result };
  }
  project(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, result: AgentActionResult) {
    const read = action.startsWith('Read'), prepared = read ? result.value as Prepared : undefined, operation = read ? undefined : result.value as ActionResult;
    const snapshot = operation ? commerceSnapshotSchema.parse(operation.output?.ucpSnapshot) : undefined;
    const object = { type: read ? 'UcpOperationTerms' : 'UcpCheckoutObservation', id: digest({ intent: ctx.intentId, attempt: ctx.attemptId }) };
    const observedAt = prepared?.observedAt ?? (snapshot!.order?.receipt ?? snapshot!.checkout.receipt).receivedAt;
    const sourceEvent = prepared?.evidenceRefs.at(-1)! ?? operation!.eventId, proof = { type: 'SourceReceipt', id: digest({ object, sourceEvent }) };
    const receipt = prepared ? domainPreparedReceiptSchema.parse({ configurationDigest: this.configurationDigest, scope: ctx.state.scope, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, preparationDigest: digest(prepared), evidenceRefs: prepared.evidenceRefs, observedAt, expiresAt: prepared.expiresAt }) : undefined;
    const properties = { id: object.id, displayTitle: read ? 'UCP 商家操作条款' : 'UCP 原始结账观察', requestRevision: ctx.request.revision, ...(receipt ? { receipt } : { snapshot, intentId: ctx.intentId, scope: ctx.state.scope }) };
    const links = [{ type: `${object.type}Request`, from: object, to: { type: 'ServiceRequest', id: ctx.request.id } }, { type: `${object.type}Evidence`, from: object, to: proof }];
    if (snapshot) {
      const input = this.adapter.mode === 'prepare' ? ctx.state.input : { preparationTaskId: ctx.request.id, budget: ctx.state.input.budget };
      const projected = projectCommerceSnapshot(ctx.graph, ctx.owner, ctx.request, this.adapter.capability().ref.id, input, snapshot, ctx.state.scope);
      if (!projected.subject) return fail('UCP source could not be projected into its typed checkout and order');
      links.push({ type: 'UcpObservationSession', from: object, to: projected.subject });
    }
    ctx.graph.ingest(ctx.owner, { objects: [{ ref: object, properties }, { ref: proof, properties: { receiptId: proof.id, displayTitle: 'UCP 本地商家来源回执', sourceIdentity: `ucp:${this.configurationDigest}`, sourceEventId: sourceEvent, scope: 'checkout_session', observedAt, evidenceLevel: 'synthetic', contentDigest: digest(result.value), subjects: [{ object, digest: digest(properties), linksDigest: linkSnapshotDigest(object, links) }], safeSummary: 'Verified original local UCP merchant receipt; no real money or fulfillment' } }], links: [...links, { type: 'ReceiptRequest', from: proof, to: { type: 'ServiceRequest', id: ctx.request.id } }] }, { kind: 'synthetic', id: sourceEvent, observedAt });
    return object;
  }
  projectOutputs(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef) { const view = ctx.graph.read(ctx.owner, object), value = result.value as Prepared; return objectResultProjection(object, { origin: 'synthetic', refs: result.evidenceRefs, observedAt: view.source.observedAt, ...(action.startsWith('Read') ? { expiresAt: value.expiresAt } : {}) }, false); }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    this.assertContext(ctx); const ref = completion.parse(raw).result, object = ctx.graph.read(ctx.owner, ref);
    if (!(reads.deliveredObjects ?? reads.objects).some(value => same(value.ref, ref)) || !same(object.properties.scope, ctx.state.scope)) fail('Read this exact UCP component observation before completion');
    const snapshot = commerceSnapshotSchema.parse(object.properties.snapshot), intent = ctx.intents?.find(value => value.id === object.properties.intentId && value.state === 'effect_confirmed' && same(value.acceptedOutput?.object, ref));
    const result = intent?.lastVerifiedResult?.output?.source as ActionResult | undefined, delivery = result?.delivery ?? fail('Original UCP intent has no independently accepted delivery');
    const input = this.adapter.mode === 'prepare' ? ctx.state.input : { preparationTaskId: ctx.request.id, budget: ctx.state.input.budget };
    const plan = adapterInvocation(ctx, intent!.id, this.listingBinding(), this.adapter.capability().actions[0]!.ref, input);
    if (!same(result!.output?.ucpSnapshot, snapshot) || !this.adapter.verify(ctx, plan, intent!.privateData, delivery).accepted) fail('Original checkout or order endpoint is not proven');
    return { ...delivery, ...(this.adapter.mode === 'confirm' ? { economicFacts: [{ key: this.adapter.operationScope(snapshot.checkout.id), phase: 'commitment' as const, role: 'service_total' as const, amount: snapshot.checkout.total, evidenceRefs: delivery.evidenceRefs }] } : {}) };
  }
}
