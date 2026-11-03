import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { objectResultProjection } from '../../core/composed-actions.js';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import { permitsPersonalSource } from '../../core/source-owner.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../../core/agent-program.js';
import type { ServiceCapability, ServiceRequest } from '../../ontology/execution.js';
import { objectRefSchema, type ObjectRef } from '../../ontology/model.js';
import { linkSnapshotDigest, type OntologyObjectStore } from '../../ontology/object-store.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import { ONTOLOGY_READ_GUIDANCE } from '../../ontology/mcp-read.js';
import { checkedCommerceRead, commerceReadActionSchema, commerceReadActions, commerceReadModule } from '../../ontology/payment-commerce.js';
import { commerceQuerySchema, providerActions, providerNames, providerCapabilityIds, type CommerceProvider, type CommerceReadSource } from './contracts.js';
import { PaymentCommerceConnector, resolveCommerceQuery } from './connector.js';
import type { CommerceConnectionOptions } from './connection.js';

const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const completion = z.strictObject({ observation: objectRefSchema, rationale: z.string().min(1).max(2000) });
export interface CommerceReadOptions extends CommerceConnectionOptions {
  connector?: CommerceReadSource;
  evidenceKind?: 'fixture';
  execute?: boolean;
}
export type CommerceReadOptionsMap = Partial<Record<CommerceProvider, CommerceReadOptions>>;
export class PaymentCommerceReadProgram implements AgentProgram {
  readonly ref;
  readonly actionIds: string[];
  readonly projectionTypes = ['PaymentCommerceReadTask', 'PaymentCommerceReadObservation', 'SourceReceipt'];
  readonly guidance = ONTOLOGY_READ_GUIDANCE;
  readonly completionSchema = z.toJSONSchema(completion);
  readonly configurationDigest: string;
  readonly evidenceKind: 'live_readonly' | 'provider_mock' | 'fixture';
  private readonly source: CommerceReadSource;
  private readonly environment: ServiceCapability['environment'];
  constructor(readonly provider: CommerceProvider, private readonly options: CommerceReadOptions) {
    if (options.connector && options.evidenceKind !== 'fixture') throw new Error('Injected commerce sources must be explicitly synthetic');
    const connector = options.connector ? undefined : new PaymentCommerceConnector(provider, options);
    this.source = options.connector ?? connector!;
    this.ref = { id: providerCapabilityIds[provider], version: '1' };
    this.actionIds = [...providerActions[provider]];
    this.evidenceKind = options.evidenceKind ?? (connector?.connection.environment === 'sandbox' ? 'provider_mock' : 'live_readonly');
    this.configurationDigest = digest({ provider, binding: connector?.configurationDigest ?? { fixture: options.connectionFile }, module: commerceReadModule, evidenceKind: this.evidenceKind });
    this.environment = options.evidenceKind || connector?.connection.environment === 'sandbox' ? 'sandbox' : 'live';
  }
  permitted(owner: string) { return permitsPersonalSource(this, owner); }
  capability(): ServiceCapability {
    const schemas = this.actionIds.map(action => commerceQuerySchema.options.find(schema => schema.shape.action.value === action)!);
    return {
      ref: this.ref, ontologyRef: { id: commerceReadModule.id, version: commerceReadModule.version }, name: `${providerNames[this.provider]}只读查询`,
      description: this.provider === 'taobao'
        ? 'Search the authorized Taobao affiliate catalog or inspect explicit item IDs. Choose SearchTaobaoProducts with query/page/limit or GetTaobaoProducts with itemIds. Source prices are references; delivery, stock and checkout totals remain unknown. No cart, order or payment.'
        : `Read one existing ${providerNames[this.provider]} merchant trade by its original order identity. Returns source-reported state only. This merchant connection does not grant access to a PA wallet or enable AI-card payments. Cannot create, pay, refund, close or sign a contract.`,
      tags: [this.provider, 'read-only', this.provider === 'taobao' ? 'catalog' : 'trade-query'], environment: this.environment, completion: 'artifact',
      inputSchema: schemas.length === 1 ? z.toJSONSchema(schemas[0]!) : { oneOf: schemas.map(schema => z.toJSONSchema(schema)) },
      actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: 'read' })),
      verifierRef: { id: 'payment-commerce.source-readback', version: '1' }, ontology: { objects: this.projectionTypes },
      predicates: [{ id: `${this.provider}.read_observed`, description: 'The exact source read was observed; no payment or fulfillment is implied' }, { id: 'execution.no_order', description: 'No order, contract or payment was created' }],
      outcomePredicates: [`${this.provider}.read_observed`], goalOutcomes: [{ predicate: `${this.provider}.read_observed`, phase: 'fact', description: 'Source query observed only' }],
      effectConstraints: [{ predicate: 'execution.no_order', allowedEffects: ['read', 'local', 'object_write'] }],
    };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, value: unknown, component?: { id: string; scopeKey: string }) {
    if (!this.permitted(owner)) throw new DomainError('FORBIDDEN', 'Provider connection is private');
    const { query } = resolveCommerceQuery(this.provider, commerceQuerySchema.parse(value));
    const root = { type: 'ServiceRequest', id: request.id };
    if (graph.read(owner, root).properties.revision !== request.revision) fail('Provider query request revision changed');
    const scope = { type: 'PaymentCommerceReadTask', id: digest({ request: request.id, revision: request.revision, query, provider: this.provider, configuration: this.configurationDigest, component }) };
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: `${providerNames[this.provider]}只读查询`, requestRevision: request.revision, provider: this.provider, input: query, allowedActions: [...this.actionIds], configurationDigest: this.configurationDigest } }],
      links: [{ type: 'PaymentCommerceTaskRequest', from: scope, to: root }] }, { kind: 'task', id: request.id, observedAt: new Date(graph.now()).toISOString() });
    return { scope, input: query };
  }
  schema(action: string) {
    if (!this.actionIds.includes(action)) fail('Unregistered provider read action');
    return commerceReadActionSchema;
  }
  definition(graph: OntologyObjectStore, action: string) {
    this.schema(action);
    const current = graph.model.action(action), expected = commerceReadActions.find(value => value.id === action)!;
    if (!equal(current.read, expected.read)) fail('Provider Ontology binding changed');
    return current;
  }
  private scope(ctx: AgentProgramContext) {
    if (!this.permitted(ctx.owner) || !equal(ctx.state.programRef, this.ref) || ctx.state.programDigest !== this.configurationDigest || ctx.state.requestRevision !== ctx.request.revision) fail('Provider execution scope changed');
    const scope = ctx.graph.read(ctx.owner, ctx.state.scope), roots = ctx.graph.related(ctx.owner, scope.ref, 'request', { remaining: 1000 });
    const { query } = resolveCommerceQuery(this.provider, commerceQuerySchema.parse(ctx.state.input));
    if (scope.ref.type !== 'PaymentCommerceReadTask' || scope.properties.provider !== this.provider || scope.properties.configurationDigest !== this.configurationDigest
      || scope.properties.requestRevision !== ctx.request.revision || !equal(scope.properties.input, query) || !equal(scope.properties.allowedActions, this.actionIds) || roots?.length !== 1
      || roots[0]!.ref.id !== ctx.request.id || roots[0]!.properties.revision !== ctx.request.revision) fail('Provider query belongs to another task or revision');
    return query;
  }
  validate(ctx: AgentProgramContext, action: string, value: Record<string, unknown>) {
    const query = this.scope(ctx); this.definition(ctx.graph, action);
    const input = this.schema(action).parse(value);
    if (action !== query.action || !equal(input, value) || !equal(input.scope, ctx.state.scope)) fail('Provider action escaped its exact query scope');
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    signal.throwIfAborted(); this.validate(ctx, action, input);
    if (this.options.execute === false) throw new DomainError('FORBIDDEN', 'Only the Worker executes provider reads');
    if (!ctx.modelRunId || ctx.callerRequestId) fail('Provider query requires the original model plan');
    ctx.assertDispatchAllowed?.();
    const query = this.scope(ctx), result = await this.source.invoke(query, signal);
    signal.throwIfAborted(); ctx.assertDispatchAllowed?.(); this.scope(ctx);
    const id = randomUUID(), body = { id, provider: this.provider, requestId: ctx.request.id, requestRevision: ctx.request.revision, configurationDigest: this.configurationDigest,
      scope: ctx.state.scope, actionInput: input, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId,
      query, result: result.result, observedAt: result.observedAt, expiresAt: new Date(Date.parse(result.observedAt) + 300000).toISOString(), evidenceKind: this.evidenceKind };
    return { value: checkedCommerceRead({ ...body, contentDigest: digest(body) }), evidenceRefs: [id] };
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    this.validate(ctx, action, input);
    const s = checkedCommerceRead(result.value);
    if (s.provider !== this.provider || s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== this.configurationDigest
      || !equal(s.scope, ctx.state.scope) || !equal(s.query, this.scope(ctx)) || !equal(s.actionInput, input)
      || s.planId !== ctx.planId || s.intentId !== ctx.intentId || s.attemptId !== ctx.attemptId || s.modelRunId !== ctx.modelRunId
      || s.evidenceKind !== this.evidenceKind || !equal(result.evidenceRefs, [s.id])
      || Date.parse(s.observedAt) > ctx.graph.now() || Date.parse(s.expiresAt) <= ctx.graph.now()) fail('Provider result differs from the accepted attempt');
    const ref = { type: 'PaymentCommerceReadObservation', id: s.id }, receipt = { type: 'SourceReceipt', id: `payment-commerce:${s.id}` }, root = { type: 'ServiceRequest', id: s.requestId };
    const properties = { id: s.id, displayTitle: `${providerNames[this.provider]}查询观察`, requestRevision: s.requestRevision, snapshot: s };
    const links = [{ type: 'PaymentCommerceObservationrequest', from: ref, to: root }, { type: 'PaymentCommerceObservationscope', from: ref, to: s.scope }, { type: 'ReceiptRequest', from: receipt, to: root }];
    ctx.graph.ingest(ctx.owner, { objects: [{ ref, properties }, { ref: receipt, properties: {
      receiptId: receipt.id, displayTitle: `${providerNames[this.provider]}只读来源回执`, sourceIdentity: `${this.provider}:readonly:${this.configurationDigest}`, sourceEventId: s.id,
      scope: this.provider === 'taobao' ? 'goods_offer' : 'payment', observedAt: s.observedAt, evidenceLevel: s.evidenceKind === 'fixture' ? 'synthetic' : s.evidenceKind === 'provider_mock' ? 'provider_test' : 'live_readonly', contentDigest: s.contentDigest,
      subjects: [{ object: ref, digest: digest(properties), linksDigest: linkSnapshotDigest(ref, links) }], safeSummary: 'Source query only; no order, contract, payment or fulfillment was performed',
    } }], links: [...links, { type: 'PaymentCommerceObservationsourceReceipts', from: ref, to: receipt }] }, { kind: s.evidenceKind === 'fixture' ? 'synthetic' : 'provider', id: s.id, observedAt: s.observedAt });
    return ref;
  }
  projectOutputs(_ctx: AgentActionContext, _action: string, _input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef) {
    const s = checkedCommerceRead(result.value);
    return objectResultProjection(object, { origin: s.evidenceKind === 'fixture' ? 'synthetic' : 'provider', refs: result.evidenceRefs, observedAt: s.observedAt, expiresAt: s.expiresAt }, false, true);
  }
  validateOutput(ctx: AgentProgramContext, output: import('../../ontology/composition-contract.js').AcceptedPortValue) {
    for (const ref of (output.definition.cardinality === 'many' ? output.value : [output.value]) as ObjectRef[]) this.observation(ctx, ref);
  }
  private observation(ctx: AgentProgramContext, ref: ObjectRef) {
    const query = this.scope(ctx);
    if (!ctx.state.observations.some(value => equal(value, ref))) fail('Provider observation was not accepted by this task');
    const status = ctx.graph.evaluate(ctx.owner, { function: 'paymentCommerceReadStatus', object: ref });
    if (status.status !== 'known') fail(status.reason ?? 'Provider evidence is unknown');
    const s = checkedCommerceRead(ctx.graph.read(ctx.owner, ref).properties.snapshot);
    if (s.provider !== this.provider || s.configurationDigest !== this.configurationDigest || s.requestId !== ctx.request.id || !equal(s.query, query) || !equal(s.scope, ctx.state.scope)) fail('Provider observation scope changed');
    return s;
  }
  complete(ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot) {
    const chosen = completion.parse(proposal), s = this.observation(ctx, chosen.observation), args = { function: 'paymentCommerceReadStatus', object: chosen.observation }, status = ctx.graph.evaluate(ctx.owner, args);
    if (!reads.objects.some(read => equal(read.ref, chosen.observation)) || !reads.reads.some(read => read.tool === 'evaluate_ontology' && read.status === 'ok' && read.inputDigest === digest(args) && read.outputDigest === digest(status))) fail('Read and evaluate the provider result before completion');
    const later = ctx.state.observations.slice(ctx.state.observations.findIndex(ref => equal(ref, chosen.observation)) + 1);
    if (later.some(ref => !equal(checkedCommerceRead(ctx.graph.read(ctx.owner, ref).properties.snapshot).result, s.result))) fail('A later provider read changed the result');
    return { evidenceLevel: s.evidenceKind === 'fixture' ? 'synthetic' as const : s.evidenceKind === 'provider_mock' ? 'provider_test' as const : 'live_readonly' as const,
      artifact: { id: randomUUID(), name: `${this.provider}-read-result.json`, data: { goal: ctx.request.originalGoal, deliverable: `${providerNames[this.provider]}来源查询已完成；未下单、签约或付款。`, execution: 'completed' as const,
        result: { providerRead: { provider: s.provider, query: s.query, result: s.result, observedAt: s.observedAt, expiresAt: s.expiresAt, evidenceKind: s.evidenceKind, noBusinessWrites: true, paymentPerformedByEigos: false } } } },
      facts: { conditions: [`${this.provider}.read_observed`, 'execution.no_order'] }, evidenceRefs: [s.id] };
  }
}
