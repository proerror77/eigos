import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../../core/agent-program.js';
import type { Delivery } from '../../core/catalog.js';
import type { ServiceCapability, ServiceRequest } from '../../ontology/execution.js';
import type { ObjectRef } from '../../ontology/model.js';
import type { OntologyObjectStore } from '../../ontology/object-store.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import { rideEstimateInputSchema, rideEstimateActionIds, rideEstimateActionSchemas, rideEstimateCompletionSchema, type RideEstimateAction, type RideEstimateObservation } from '../../ontology/ride-estimate.js';
import { checkedRideEstimate, projectRideEstimate } from '../../ontology/ride-estimate-projection.js';
import { didiBindingSchema, didiDataSchema, didiReceiptSchema, didiEndpoint, type DidiBinding } from './contracts.js';
import { DidiMcpConnector, type DidiConnector } from './connector.js';

export const DIDI_PROGRAM_REF = { id: 'ride.estimate.query', version: '1' } as const;
const equal = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : digest(a) === digest(b);
const invalid = (message: string): never => { throw new DomainError('CONFLICT', message); };
const normalized = (s: string) => s.replace(/\s+/g, '').toLowerCase();

export class DidiAgentProgram implements AgentProgram {
  readonly ref = DIDI_PROGRAM_REF;
  readonly actionIds = rideEstimateActionIds;
  readonly completionSchema = z.toJSONSchema(rideEstimateCompletionSchema);
  readonly guidance = 'For completion after an estimate exists, read RideEstimateTask and the selected RideEstimateObservation, then evaluate rideEstimateStatus on that observation; this function already checks both source searches, so re-reading all place candidates is unnecessary unless selecting a new source action. Use describe_ontology with actions=[] for completion metadata; request actions=[exact action IDs] only when choosing executable read schemas. Read RideEstimateTask and choose only its two read actions. SearchDidiPlaces searches one exact requested keyword and city, preserving all candidates. For an estimate, select source place IDs, never supply coordinates. A unique exact name can disambiguate among other names; duplicate exact names require the user to specify the full address. Ask on this same task when ambiguous; do not silently choose the first place. Read and evaluate rideEstimateStatus for both place observations before proposing EstimateDidiRide. The connector never chooses the next action. Complete by reading and evaluating the final observation and selecting it. A place-search goal may complete with a known empty result. An estimate with no returned or no requested class is a bounded no-result, never permission to substitute a class. The host renders factual source text; rationale is not a fact. Prices are estimates, complete fees and provider quote expiry are unknown; the five-minute freshness limit is local policy. No RideOption, order, trip, deep link, cancellation, driver query or payment can be produced. Mock/fixture results must be labeled.';
  readonly configurationDigest: string;
  private connector: DidiConnector;
  readonly binding: DidiBinding;
  constructor(binding: DidiBinding, options: { connector?: DidiConnector } = {}) {
    this.binding = didiBindingSchema.parse(binding);
    this.connector = options.connector ?? new DidiMcpConnector(this.binding);
    this.configurationDigest = digest({ program: this.ref, binding: { bindingId: binding.bindingId, keyFile: binding.keyFile, keySha256: binding.keySha256, environment: binding.environment }, evidenceKind: this.connector.evidenceKind, policy: 'two-reads-source-bound-v1' });
  }
  permitted(owner: string) { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: { id: 'ride.estimate.actions', version: '1' }, name: '滴滴地点搜索与打车估价', description: '仅查询滴滴地点或指定路线的车型预估价。输入 mode=places 时只需 city、keywords；mode=estimate 时只需 city、origin、destination，可保留 serviceClass 偏好。不强迫补人数、预算、上下车期限。先搜索来源地点，歧义需要确认；估价不证明完整费用、可叫到车、接驾或到达承诺。无法接受真实叫车、订单或付款目标。', tags: ['didi', 'ride', 'places', 'estimate', 'read-only'], environment: this.binding.environment === 'mock' ? 'sandbox' : 'live', completion: 'artifact', inputSchema: z.toJSONSchema(rideEstimateInputSchema), ontology: { objects: ['RideEstimateTask', 'DidiPlaceObservation', 'RideEstimateObservation', 'RideRoute', 'Provider', 'SourceReceipt'], planning: 'Agent-selected read actions and source place selections; no automatic call sequence or business writes' }, actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: 'read' as const })), verifierRef: { id: 'ride.estimate.source-readback', version: '1' }, predicates: [{ id: 'execution.no_order', description: '不创建订单或付款' }, { id: 'ride.estimate_only', description: '仅地点或估价观察，完整车费与行程完成未知' }] };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, value: unknown) {
    if (!this.permitted(owner)) throw new DomainError('FORBIDDEN', 'Personal DiDi binding is unavailable to this identity');
    const input = rideEstimateInputSchema.parse(value), root = { type: 'ServiceRequest', id: request.id }, scope = { type: 'RideEstimateTask', id: digest({ request: request.id, revision: request.revision, input, binding: this.configurationDigest }) };
    if (graph.read(owner, root).properties.revision !== request.revision) invalid('Request changed before DiDi scope creation');
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: '滴滴只读查询任务', requestRevision: request.revision, input, configurationDigest: this.configurationDigest, allowedActions: [...this.actionIds] } }], links: [{ type: 'RideEstimateTaskRequest', from: scope, to: root }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  schema(action: string): z.ZodType<Record<string, unknown>> {
    if (!Object.hasOwn(rideEstimateActionSchemas, action)) throw new DomainError('FORBIDDEN', 'DiDi action is not registered');
    return rideEstimateActionSchemas[action as RideEstimateAction];
  }
  definition(graph: OntologyObjectStore, action: string) {
    const definition = graph.model.action(action);
    if (!this.actionIds.includes(action as RideEstimateAction) || definition.read?.effect !== 'read' || !equal(definition.read.inputSchema, z.toJSONSchema(this.schema(action)))) invalid('DiDi action definition changed');
    return definition;
  }
  private scope(ctx: AgentProgramContext) {
    if (!this.permitted(ctx.owner) || !equal(ctx.state.programRef, this.ref) || ctx.state.programDigest !== this.configurationDigest || ctx.state.requestRevision !== ctx.request.revision) invalid('DiDi account or execution scope changed');
    const scope = ctx.graph.read(ctx.owner, ctx.state.scope), input = rideEstimateInputSchema.parse(ctx.state.input), roots = ctx.graph.related(ctx.owner, ctx.state.scope, 'request', { remaining: 1000 });
    if (scope.ref.type !== 'RideEstimateTask' || scope.properties.configurationDigest !== this.configurationDigest || scope.properties.requestRevision !== ctx.request.revision || !equal(scope.properties.input, input) || !equal(scope.properties.allowedActions, this.actionIds) || roots?.length !== 1 || roots[0]!.ref.id !== ctx.request.id) invalid('DiDi scope belongs to another task');
    return input;
  }
  private observation(ctx: AgentProgramContext, ref: ObjectRef) {
    if (!ctx.state.observations.some(r => equal(r, ref))) invalid('DiDi observation was not accepted by this task');
    const status = ctx.graph.evaluate(ctx.owner, { function: 'rideEstimateStatus', object: ref });
    if (status.status !== 'known') invalid(status.reason ?? 'DiDi observation is unknown');
    const snapshot = checkedRideEstimate(ctx.graph.read(ctx.owner, ref).properties.snapshot);
    if (snapshot.requestId !== ctx.request.id || snapshot.requestRevision !== ctx.request.revision || snapshot.configurationDigest !== this.configurationDigest || snapshot.receipt.bindingId !== this.binding.bindingId || snapshot.receipt.environment !== this.binding.environment || snapshot.evidenceKind !== this.connector.evidenceKind || !equal(snapshot.scope, ctx.state.scope)) invalid('DiDi source provenance differs from the task');
    return { snapshot, status };
  }
  private selectPlace(ctx: AgentProgramContext, ref: ObjectRef, id: string, role: 'origin' | 'destination') {
    const scope = this.scope(ctx), s = this.observation(ctx, ref).snapshot;
    if (scope.mode !== 'estimate' || s.data.kind !== 'places' || s.actionInput.role !== role) return invalid('Wrong place source for the route role');
    const place = s.data.places.find(p => p.id === id) ?? invalid('Place was not returned by the cited search');
    if (normalized(place.city).replace(/市$/, '') !== normalized(scope.city).replace(/市$/, '')) invalid('The selected place is outside the requested city');
    const target = scope[role], exact = s.data.places.filter(p => normalized(p.name) === normalized(target));
    const explicitlyAddressed = place.addressAll.length > place.name.length && s.data.places.filter(p => p.addressAll === place.addressAll).length === 1 && ctx.request.messages.some(m => m.text.includes(place.addressAll));
    if (s.data.places.length !== 1 && !(exact.length === 1 && exact[0]!.id === id) && !explicitlyAddressed) invalid('Ambiguous place needs an explicit full-address choice; the first candidate is not a default');
    return place;
  }
  private call(ctx: AgentProgramContext, action: string, value: Record<string, unknown>) {
    const scope = this.scope(ctx);
    if (action === 'SearchDidiPlaces') {
      const input = rideEstimateActionSchemas.SearchDidiPlaces.parse(value);
      const expected = scope.mode === 'places' ? input.role === 'search' ? scope.keywords : undefined : input.role === 'origin' ? scope.origin : input.role === 'destination' ? scope.destination : undefined;
      if (expected !== input.keywords) invalid('Search changed the requested place or role');
      return { tool: 'maps_textsearch' as const, args: { keywords: input.keywords, city: scope.city }, route: undefined };
    }
    const input = rideEstimateActionSchemas.EstimateDidiRide.parse(value);
    const origin = this.selectPlace(ctx, input.originObservation, input.originPlaceId, 'origin'), destination = this.selectPlace(ctx, input.destinationObservation, input.destinationPlaceId, 'destination');
    return { tool: 'taxi_estimate' as const, args: { from_lng: String(origin.lng), from_lat: String(origin.lat), from_name: origin.name, to_lng: String(destination.lng), to_lat: String(destination.lat), to_name: destination.name }, route: { origin, destination } };
  }
  validate(ctx: AgentProgramContext, action: string, value: Record<string, unknown>) {
    const parsed = this.schema(action).parse(value); this.definition(ctx.graph, action);
    if (!equal(parsed, value) || !equal(parsed.scope, ctx.state.scope)) invalid('DiDi action escaped its canonical task scope');
    this.call(ctx, action, value);
  }
  private readEvaluated(ctx: AgentProgramContext, ref: ObjectRef, reads: PlanningSnapshot) {
    const status = this.observation(ctx, ref).status;
    if (!reads.objects.some(o => equal(o.ref, ref)) || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest({ function: 'rideEstimateStatus', object: ref }) && r.outputDigest === digest(status))) invalid('The model must read and evaluate the exact current DiDi observation');
  }
  validatePlanning(ctx: AgentProgramContext, action: string, value: Record<string, unknown>, reads: PlanningSnapshot) {
    if (action === 'EstimateDidiRide') { const input = rideEstimateActionSchemas.EstimateDidiRide.parse(value); this.readEvaluated(ctx, input.originObservation, reads); this.readEvaluated(ctx, input.destinationObservation, reads); }
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input); const call = this.call(ctx, action, input);
    if (action === 'EstimateDidiRide') this.validatePlanning(ctx, action, input, ctx.state.plans.find(p => p.id === ctx.planId)?.ontologyPlanning ?? invalid('A persisted, source-read model plan is required'));
    const result = await this.connector.invoke({ requestId: ctx.request.id, requestRevision: ctx.request.revision, actionInputDigest: digest(input), planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId }, call.tool, call.args, signal);
    const data = didiDataSchema.parse(result.data), receipt = didiReceiptSchema.parse(result.receipt);
    if (receipt.tool !== call.tool || receipt.inputDigest !== digest(call.args) || receipt.resultDigest !== digest(data) || receipt.endpoint !== didiEndpoint(this.binding.environment) || receipt.bindingId !== this.binding.bindingId || receipt.environment !== this.binding.environment) invalid('DiDi source receipt differs from the selected action');
    const body = { id: receipt.id, requestId: ctx.request.id, requestRevision: ctx.request.revision, configurationDigest: this.configurationDigest, scope: ctx.state.scope, action, actionInput: input, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, receipt, data, evidenceKind: this.connector.evidenceKind, ...(call.route ? { route: call.route } : {}), observedAt: receipt.receivedAt, expiresAt: new Date(Date.parse(receipt.startedAt) + 300000).toISOString(), validityBasis: 'local_refresh_limit', noBusinessWrites: true };
    return { value: checkedRideEstimate({ ...body, contentDigest: digest(body) }), evidenceRefs: [receipt.id] };
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    this.validate(ctx, action, input); const s = checkedRideEstimate(result.value), call = this.call(ctx, action, input);
    if (s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== this.configurationDigest || s.action !== action || !equal(s.actionInput, input) || !equal(s.scope, ctx.state.scope) || !equal(s.route, call.route) || s.receipt.inputDigest !== digest(call.args) || s.receipt.bindingId !== this.binding.bindingId || s.receipt.environment !== this.binding.environment || s.receipt.endpoint !== didiEndpoint(this.binding.environment) || s.evidenceKind !== this.connector.evidenceKind || s.planId !== ctx.planId || s.intentId !== ctx.intentId || s.attemptId !== ctx.attemptId || s.modelRunId !== ctx.modelRunId || !equal(result.evidenceRefs, [s.id]) || Date.parse(s.expiresAt) <= ctx.graph.now()) invalid('DiDi result does not bind this accepted action attempt');
    return projectRideEstimate(ctx.graph, ctx.owner, s);
  }
  complete(ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot): Delivery {
    const scope = this.scope(ctx), completion = rideEstimateCompletionSchema.parse(proposal), { snapshot: s } = this.observation(ctx, completion.observation);
    this.readEvaluated(ctx, completion.observation, reads);
    if (scope.mode !== s.data.kind) invalid('The selected observation does not complete the requested query mode');
    if (ctx.state.observations.slice(ctx.state.observations.findIndex(r => equal(r, completion.observation)) + 1).some(ref => {
      const later = checkedRideEstimate(ctx.graph.read(ctx.owner, ref).properties.snapshot); return later.action === s.action && equal(later.actionInput, s.actionInput) && !equal(later.data, s.data);
    })) invalid('A later DiDi observation changed the selected facts');
    const requestedItems = scope.mode === 'estimate' && s.data.kind === 'estimate' && scope.serviceClass ? s.data.items.filter(item => normalized(item.productName) === normalized(scope.serviceClass!)) : s.data.kind === 'estimate' ? s.data.items : [];
    const prefix = s.evidenceKind === 'provider_mock' ? '【滴滴 Mock 数据】' : s.evidenceKind === 'fixture' ? '【合成测试数据】' : '';
    const answer = s.data.kind === 'places' ? s.data.places.map(p => `${p.name}：${p.addressAll || p.address}`).join('\n') || '本次地点搜索未返回结果。'
      : `${s.route!.origin.name} → ${s.route!.destination.name}\n${requestedItems.map(item => `${item.productName}：${item.priceText}（预估）`).join('\n') || '本次未返回符合指定车型的估价。'}\n估价不代表最终完整车费或接驾承诺。`;
    return { artifact: { id: randomUUID(), name: 'didi-read-result.json', data: { goal: ctx.request.originalGoal, deliverable: `${prefix}${answer}\n未下单、未付款。`, execution: 'completed', result: { didiAnswer: { observation: completion.observation, ...s.data, ...(s.route ? { route: s.route, requestedItems } : {}), receiptId: s.receipt.id, observedAt: s.observedAt, freshnessPolicyUntil: s.expiresAt, providerQuoteExpiry: 'unknown', evidenceKind: s.evidenceKind, noBusinessWrites: true } } } }, facts: { conditions: ['execution.no_order', 'ride.estimate_only'] }, evidenceRefs: [s.receipt.id] };
  }
}
