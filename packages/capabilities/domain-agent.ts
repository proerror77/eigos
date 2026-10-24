import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { AgentOperationRejected, type AgentActionContext, type AgentActionResult, type AgentProgram, type AgentProgramContext } from '../core/agent-program.js';
import type { Delivery, Preparation } from '../core/catalog.js';
import { objectResultProjection } from '../core/composed-actions.js';
import type { ServiceCapability, ServiceRequest } from '../ontology/execution.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { ActionResult } from '../ontology/actions.js';
import { domainAtomicMetadata, domainPreparedReceiptSchema } from '../ontology/domain-composition.js';
import { domainSnapshotSchema, projectDomainSnapshot } from '../ontology/domain-projection.js';
import { parseDomainParameters, serviceDomain } from '../ontology/service-domains.js';
import { DomainServiceAdapter, domainBinding, domainCapability, type DomainSandboxProvider } from './domain-service.js';
import { adapterActionContext, adapterInvocation } from './atomic-adapter.js';

const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const completion = z.strictObject({ result: objectRefSchema });

/** One provider binding for a domain. The model independently chooses the
 * source read and business operation; no recipe is returned or executed. */
export class DomainAgentProgram implements AgentProgram {
  readonly ref;
  readonly configurationDigest: string;
  readonly actionIds: string[];
  readonly completionSchema = z.toJSONSchema(completion);
  readonly guidance: string;
  readonly adapter: DomainServiceAdapter;
  private readonly domain;
  private readonly metadata;
  constructor(private provider: DomainSandboxProvider) {
    this.adapter = new DomainServiceAdapter(provider); this.domain = serviceDomain(provider.domain); this.metadata = domainAtomicMetadata(provider.domain);
    this.ref = { id: `${domainBinding(provider).ref.id}.agent`, version: '1' };
    this.configurationDigest = digest({ provider: provider.configurationDigest, semantics: 'domain-atomic-v1', domain: provider.domain });
    this.actionIds = [this.metadata.read, this.metadata.execute];
    this.guidance = `This is one explicitly injected synthetic ${this.domain.name} provider. Initialize only the user's typed domain request. ${this.metadata.read} obtains its current option and facts; ${this.metadata.execute} submits one accepted option after ${this.domain.eligibleFunction} is actually evaluated. You choose when to read, submit, compare another binding or stop. The provider cannot choose a next service. A pending operation is queried under the original key; never replace it. Complete with an actually read and evaluated ${this.domain.resultType}, using ${this.domain.outcomeFunction}. ${this.domain.endpoint}. No live service or payment exists.`;
  }
  permitted(owner: string) { return this.adapter.permitted(owner); }
  capability(): ServiceCapability {
    const original = domainCapability(this.provider.domain), phase = ['ride', 'food'].includes(this.provider.domain) ? 'delivery' as const : this.provider.domain === 'itinerary' ? 'artifact' as const : 'commitment' as const;
    const extra = this.provider.domain === 'hotel' ? [{ predicate: 'domain.hotel.stay_completed', phase: 'delivery' as const, description: 'Actual completed synthetic hotel stay, beyond reservation' }]
      : this.provider.domain === 'vehicle' ? [{ predicate: 'domain.vehicle.use_completed', phase: 'delivery' as const, description: 'Synthetic use and required return/deposit evidence complete' }]
      : this.provider.domain === 'itinerary' ? [{ predicate: 'domain.itinerary.booked', phase: 'commitment' as const, description: 'All required itinerary bookings independently confirmed' }] : [];
    return { ...original, actions: [...original.actions, { ref: { id: this.metadata.read, version: '1' }, effect: 'read' }, { ref: { id: this.metadata.execute, version: '1' }, effect: this.domain.effect }],
      goalOutcomes: [{ predicate: `domain.${this.provider.domain}.complete`, phase, description: this.domain.endpoint }, ...extra],
      outcomePredicates: [...original.outcomePredicates!, ...extra.map(value => value.predicate)] };
  }
  listingBinding() { const original = domainBinding(this.provider); return { ...original, ref: { id: `${original.ref.id}.atomic`, version: '1' }, configurationDigest: this.configurationDigest }; }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown, component?: { id: string; scopeKey: string }) {
    if (!this.permitted(owner) || request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'Domain operation requires the explicit isolated sandbox');
    const input = parseDomainParameters(this.provider.domain, raw) as Record<string, unknown>;
    const scope = { type: this.domain.requestType, id: `${request.id}:r${request.revision}:c${component?.scopeKey ?? digest(this.ref)}` };
    const root = graph.read(owner, { type: 'ServiceRequest', id: request.id });
    graph.ingest(owner, { objects: [{ ref: scope, properties: { objectId: scope.id, displayTitle: `${this.domain.name}固定要求`, ...input, requestRevision: request.revision, capturedAt: root.createdAt } }],
      links: [{ type: `${this.domain.requestType}Request`, from: scope, to: root.ref }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  assertContext(ctx: AgentProgramContext) {
    if (!this.permitted(ctx.owner) || ctx.request.executionEnvironment !== 'sandbox' || !same(ctx.state.programRef, this.ref) || ctx.state.programDigest !== this.configurationDigest) fail('Domain component or source changed');
    const scope = ctx.graph.read(ctx.owner, ctx.state.scope);
    const parameters = Object.fromEntries(Object.keys(this.domain.parameters.shape).filter(key => scope.properties[key] !== undefined).map(key => [key, scope.properties[key]]));
    if (scope.ref.type !== this.domain.requestType || scope.properties.requestRevision !== ctx.request.revision || !same(parseDomainParameters(this.provider.domain, parameters), ctx.state.input)
      || ctx.graph.related(ctx.owner, scope.ref, 'request', { remaining: 1000 })?.[0]?.ref.id !== ctx.request.id) fail('Domain scope changed its fixed input or request');
  }
  schema(action: string): z.ZodType<Record<string, unknown>> { if (action === this.metadata.read) return this.metadata.readSchema; if (action === this.metadata.execute) return this.metadata.executeSchema; return fail('Unknown domain operation'); }
  definition(graph: OntologyObjectStore, action: string) { const definition = graph.model.action(action), operation = definition.read ?? definition.operation; if (!operation || !same(operation.inputSchema, z.toJSONSchema(this.schema(action)))) fail('Domain atomic action differs from its exact published definition'); return definition; }
  private prepared(ctx: AgentProgramContext, raw: unknown) {
    const object = objectRefSchema.parse(raw), view = ctx.graph.readPrivate(ctx.owner, object);
    const prepared = domainPreparedReceiptSchema.parse(view.properties.preparedReceipt);
    const original = ctx.intents?.find(intent => intent.id === prepared.intentId && intent.state === 'effect_confirmed' && same(intent.acceptedOutput?.object, object));
    const value = (original?.lastVerifiedResult?.output?.source as Extract<Preparation, { kind: 'ready' }> | undefined) ?? fail('Missing original accepted preparation');
    if (object.type !== this.domain.candidateType || !original || !value || prepared.preparationDigest !== digest(value) || prepared.configurationDigest !== this.configurationDigest || !same(prepared.scope, ctx.state.scope) || !same(value.input, ctx.state.input)) fail('Option lacks this exact component source observation');
    return { ...prepared, input: value.input, details: value.details, privateData: z.record(z.string(), z.unknown()).parse(value.privateData) };
  }
  validate(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    this.assertContext(ctx); const parsed = this.schema(action).parse(input);
    if (!same(parsed.scope, ctx.state.scope)) fail('Domain action uses another component scope');
    if (action === this.metadata.execute) {
      const prepared = this.prepared(ctx, parsed.option), result = ctx.graph.evaluate(ctx.owner, { function: this.domain.eligibleFunction, object: objectRefSchema.parse(parsed.option) });
      if (Date.parse(prepared.expiresAt) <= Date.now() || result.status !== 'known' || (result.value as { status?: string }).status !== 'satisfied') fail('Original option has expired or its domain eligibility is unproven');
    }
  }
  private evaluated(ctx: AgentProgramContext, object: ObjectRef, name: string, reads: PlanningSnapshot) {
    const call = { function: name, object }, result = ctx.graph.evaluate(ctx.owner, call);
    if (result.status !== 'known' || !reads.reads.some(read => read.tool === 'evaluate_ontology' && read.status === 'ok' && read.inputDigest === digest(call) && read.outputDigest === digest(result))) fail('Read and evaluate the exact current domain evidence before this decision');
    return result.value;
  }
  validatePlanning(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot) { if (action === this.metadata.execute) this.evaluated(ctx, objectRefSchema.parse(input.option), this.domain.eligibleFunction, reads); }
  privateInput(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) { return action === this.metadata.execute ? this.prepared(ctx, input.option).privateData : {}; }
  authority(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    this.validate(ctx, action, input); const prepared = this.prepared(ctx, input.option), snapshot = domainSnapshotSchema.parse((prepared.privateData.result as { domainSnapshot: unknown }).domainSnapshot);
    return { cost: { minor: '0', currency: snapshot.option.total.currency, payeeId: this.provider.id },
      budgetImpact: { key: `${this.provider.id}:${ctx.state.scope.id}`, kind: 'commitment' as const, role: 'service_total' as const, amount: snapshot.option.total, ...(snapshot.option.deposit ? { additional: [{ key: `${this.provider.id}:${ctx.state.scope.id}:deposit`, kind: 'commitment' as const, role: 'deposit' as const, amount: snapshot.option.deposit }] } : {}) },
      operationScope: `${this.ref.id}:${ctx.state.scope.id}` };
  }
  private invocation(ctx: AgentActionContext) {
    const data = ctx.execution?.intent.privateData as { result?: { domainSnapshot?: unknown } };
    const snapshot = domainSnapshotSchema.parse(data?.result?.domainSnapshot);
    const plan = adapterInvocation(ctx, ctx.intentId, this.listingBinding(), { id: `domain.${this.provider.domain}.submit`, version: '1' }, snapshot.parameters);
    return { context: adapterActionContext(ctx, plan, snapshot.parameters), data };
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    if (action === this.metadata.read) {
      const prepared = await this.adapter.prepare(ctx, ctx.state.input, signal);
      if (prepared.kind !== 'ready') throw new AgentOperationRejected(prepared.kind === 'unavailable' ? prepared.reason : prepared.question, []);
      const { recipe: _recipe, ...value } = prepared;
      return { value, evidenceRefs: prepared.evidenceRefs };
    }
    const invocation = this.invocation(ctx); ctx.assertDispatchAllowed?.();
    const result = await this.adapter.dispatch(invocation.context, invocation.data, signal);
    if (!this.adapter.verifyAction(invocation.context, result).accepted) fail('Original domain operation receipt failed verification');
    return { value: result, evidenceRefs: result.evidenceRefs, observation: result };
  }
  async recover(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, signal: AbortSignal) {
    if (action !== this.metadata.execute) return;
    const invocation = this.invocation(ctx), result = await this.adapter.reconcile(invocation.context, invocation.data, signal);
    if (!this.adapter.verifyAction(invocation.context, result).accepted) fail('Original domain lookup failed verification');
    return { value: result, evidenceRefs: result.evidenceRefs, observation: result };
  }
  project(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, result: AgentActionResult) {
    const read = action === this.metadata.read, prepared = read ? result.value as Extract<Preparation, { kind: 'ready' }> : undefined;
    const snapshot = read ? (prepared!.privateData as { result: { domainSnapshot: unknown } }).result.domainSnapshot : (result.value as ActionResult).output?.domainSnapshot;
    const projected = projectDomainSnapshot(ctx.graph, ctx.owner, this.capability().ref.id, ctx.request, ctx.state.input, snapshot, ctx.state.scope);
    const object = projected.subject ?? fail('Domain source could not be projected into its typed objects');
    if (prepared) {
      const prior = ctx.graph.readPrivate(ctx.owner, object), receipt = domainPreparedReceiptSchema.parse({ configurationDigest: this.configurationDigest, scope: ctx.state.scope,
        planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, preparationDigest: digest(prepared),
        evidenceRefs: prepared.evidenceRefs, observedAt: prepared.observedAt, expiresAt: prepared.expiresAt });
      ctx.graph.ingest(ctx.owner, { objects: [{ ref: object, expectedRevision: prior.revision, properties: { ...prior.properties, preparedReceipt: receipt } }] }, { kind: 'synthetic', id: ctx.intentId, observedAt: prepared.observedAt });
    }
    return object;
  }
  projectOutputs(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef) {
    const view = ctx.graph.read(ctx.owner, object), expiresAt = action === this.metadata.read ? (result.value as Extract<Preparation, { kind: 'ready' }>).expiresAt : undefined;
    return objectResultProjection(object, { origin: 'synthetic', refs: result.evidenceRefs, observedAt: view.source.observedAt, ...(expiresAt ? { expiresAt } : {}) }, false, !!ctx.graph.model.action(action).composition?.outputs.citations);
  }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    this.assertContext(ctx); const selected = completion.parse(raw).result;
    if (selected.type !== this.domain.resultType) fail('Select the typed domain result, not its quote or request');
    this.evaluated(ctx, selected, this.domain.outcomeFunction, reads);
    const intent = ctx.intents?.find(value => value.state === 'effect_confirmed' && same(value.acceptedOutput?.object, selected)) ?? fail('Selected result has no accepted original intent');
    const result = intent?.lastVerifiedResult?.output?.source as ActionResult | undefined, delivery = result?.delivery ?? fail('Selected result has no original accepted delivery evidence');
    const snapshot = domainSnapshotSchema.parse(result!.output?.domainSnapshot), plan = adapterInvocation(ctx, intent.id, this.listingBinding(), { id: `domain.${this.provider.domain}.submit`, version: '1' }, snapshot.parameters);
    if (!this.adapter.verify(ctx, plan, intent.privateData, delivery).accepted) fail('Domain outcome is not independently proven');
    const facts = structuredClone(delivery.facts);
    if (this.provider.domain === 'hotel' && ctx.state.input.endpoint === 'stay_completed') facts.conditions!.push('domain.hotel.stay_completed');
    if (this.provider.domain === 'vehicle' && ctx.state.input.endpoint === 'completed') facts.conditions!.push('domain.vehicle.use_completed');
    if (this.provider.domain === 'itinerary' && ctx.state.input.endpoint === 'booked') facts.conditions!.push('domain.itinerary.booked');
    return { ...delivery, facts, conditionSubject: selected, ...(facts.totalPrice ? { economicFacts: [{ key: `${this.provider.id}:${String(snapshot.observation!.providerReference)}`, phase: 'commitment' as const, amount: facts.totalPrice, role: 'service_total' as const, evidenceRefs: delivery.evidenceRefs }, ...(facts.amounts?.deposit ? [{ key: `${this.provider.id}:${String(snapshot.observation!.providerReference)}:deposit`, phase: 'commitment' as const, amount: facts.amounts.deposit, role: 'deposit' as const, evidenceRefs: delivery.evidenceRefs }] : [])] } : {}) };
  }
}
