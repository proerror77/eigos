import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../../core/agent-program.js';
import type { Delivery } from '../../core/catalog.js';
import type { JobStore } from '../../core/store.js';
import type { ServiceCapability, ServiceRequest } from '../../ontology/execution.js';
import { objectRefSchema, type ObjectRef } from '../../ontology/model.js';
import type { OntologyObjectStore } from '../../ontology/object-store.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import { ORDER_TEST_REF, orderTestInputSchema, orderTestActionSchemas, orderTestCompletionSchema, orderTestModule, orderTestModuleRef, orderTestDataSchema, type OrderTestAction, type OrderTestSnapshot } from '../../ontology/didi-order-test.js';
import { checkedOrderTestSnapshot, readOrderTest, projectOrderTest } from '../../ontology/didi-order-test-functions.js';
import { resolveOntologyMcpRead } from '../../ontology/mcp-read.js';
import { DidiMcpConnector, type DidiConnector } from './connector.js';
import { DidiMockOrderConnector, parseMockOrderStatus, type MockOrderSource } from './order-test-connector.js';
import { mapDidiResult } from './mapping.js';
import type { DidiBinding, DidiPlace } from './contracts.js';

function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
interface QuoteSecret { traceId: string; traceDigest: string; quoteReceiptId: string; configurationDigest: string; expiresAt: string }
interface OrderSecret { orderId: string; quote: ObjectRef; creationIntentId: string; configurationDigest: string; receiptId: string }
export class DidiOrderTestProgram implements AgentProgram {
  readonly ref = ORDER_TEST_REF;
  readonly initialReadFrontier = true;
  readonly preparePlanningContext = true;
  readonly planningObservationTypes = ['DidiOrderTestQuote', 'DidiTestOrderObservation'];
  readonly actionIds = Object.keys(orderTestActionSchemas);
  readonly completionSchema = z.toJSONSchema(orderTestCompletionSchema);
  readonly configurationDigest: string;
  private maps: DidiConnector;
  private orders: MockOrderSource;
  readonly guidance = 'Use the actual Ontology Actions. First select the public map reads and official Mock quote; their declared pure bindings may share an initial read graph. After the quote exists, read/evaluate it and select CreateDidiTestOrder with the exact quoted 快车 category, then QueryDidiTestOrder with inputRefs=[{stepId:theCreateStep,targetKey:"order"}] and dependsOn=[theCreateStep]. You may explicitly select plannedCompletion bound to the query step: fresh post-source verification still runs. The host pauses for an exact sandbox permit before creation. Never create again after a confirmed or uncertain creation, guess an order ID, query the account latest order, or call production writes. Completion means official Mock creation plus independent status read, not a real order, driver acceptance, pickup, trip or payment. Mock geography/statuses are fixed examples, distinct from the production read-only map sources.';
  constructor(private binding: DidiBinding, private store: JobStore, sources: { maps?: DidiConnector; orders?: MockOrderSource } = {}) {
    if (binding.environment !== 'production') fail('Order testing requires the existing explicit production read-only map binding; all order operations remain Mock');
    this.maps = sources.maps ?? new DidiMcpConnector(binding);
    this.orders = sources.orders ?? new DidiMockOrderConnector({ ...binding, environment: 'mock', auditDirectory: binding.auditDirectory ? join(binding.auditDirectory, 'order-test') : undefined });
    this.configurationDigest = digest({ ref: this.ref, binding: { bindingId: binding.bindingId, keyFile: binding.keyFile, keySha256: binding.keySha256, environment: binding.environment }, maps: this.maps.evidenceKind, orders: this.orders.evidenceKind, module: orderTestModuleRef, policy: 'mock-order-only-v1' });
  }
  permitted(owner: string) { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: orderTestModuleRef, name: '滴滴官方 Mock 下单测试', description: 'Only the official Mock order test: 北京市，北京西站 → 西二旗-地铁站，快车，target=created. Public production map reads provide coordinates because Sandbox maps return a fixed unrelated sample. Quote/create/query always use the official sandbox, which does not create real rides or fees. The fixed Mock order route/coordinates are not proof of real travel. Display quote and obtain a separate exact sandbox permit; only an independent query completes this goal. No caller phone, production order, payment, or account-wide lookup. Pre-estimate phases may be model-selected in one initial read graph.', tags: ['didi', 'order', 'test', 'sandbox'], environment: 'sandbox', scopeReviewMode: 'registered_fixed_input', inputSchema: z.toJSONSchema(orderTestInputSchema), completion: 'order', constraintEvaluation: 'staged', requirementRoles: [{ kind: 'location', role: 'origin', description: 'Source-verified fixed test origin, not a real pickup' }, { kind: 'location', role: 'destination', description: 'Source-verified fixed test destination, not a real arrival' }], ontology: { objects: ['DidiOrderTestTask', 'DidiOrderTestPlaceObservation', 'DidiOrderTestQuote', 'DidiTestOrderObservation'], module: orderTestModuleRef, realOrdersEnabled: false, priceMeaning: 'mock_estimate_not_a_final_fare' }, actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: id === 'CreateDidiTestOrder' ? 'order' : 'read' })), predicates: [{ id: 'didi.mock_order_verified', description: 'Official Mock create acknowledged and the exact returned ID independently queried' }, { id: 'execution.no_real_effects', description: 'No real dispatch, payment or account impact; not the absence of a Mock create call' }], outcomePredicates: ['didi.mock_order_verified'], verifierRef: { id: 'didi.mock-order-readback', version: '1' } };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown) {
    if (!this.permitted(owner) || request.executionEnvironment !== 'sandbox') fail('Official order tests require the owned explicit sandbox environment');
    const input = orderTestInputSchema.parse(raw), scope = { type: 'DidiOrderTestTask', id: digest({ request: request.id, revision: request.revision, input, configuration: this.configurationDigest }) };
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: '滴滴官方 Mock 下单测试', requestRevision: request.revision, input, configurationDigest: this.configurationDigest } }], links: [{ type: 'DidiOrderTestTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  schema(action: string): z.ZodType<Record<string, unknown>> { if (!Object.hasOwn(orderTestActionSchemas, action)) fail('Unregistered order-test action'); return orderTestActionSchemas[action as OrderTestAction]; }
  definition(graph: OntologyObjectStore, action: string) {
    const definition = graph.model.action(action), op = definition.read ?? definition.operation;
    if (!op || !same(op.inputSchema, z.toJSONSchema(this.schema(action)))) fail('Order-test Action definition changed');
    return definition;
  }
  private scope(ctx: AgentProgramContext) {
    const value = ctx.graph.read(ctx.owner, ctx.state.scope);
    if (!this.permitted(ctx.owner) || ctx.request.executionEnvironment !== 'sandbox' || ctx.state.programDigest !== this.configurationDigest || value.properties.configurationDigest !== this.configurationDigest || value.properties.requestRevision !== ctx.request.revision || !same(value.properties.input, ctx.state.input)) fail('Order-test scope or identity changed');
    return orderTestInputSchema.parse(value.properties.input);
  }
  private observed(ctx: AgentProgramContext, ref: ObjectRef, historical = false) {
    if (!ctx.state.observations.some(r => same(r, ref))) fail('Order-test source was not accepted by this task');
    const s = readOrderTest(ctx.graph, ctx.owner, ref, undefined, historical);
    if (!same(s.scope, ctx.state.scope) || s.configurationDigest !== this.configurationDigest || s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision) fail('Order-test source belongs to another request');
    return s;
  }
  private evaluated(ctx: AgentProgramContext, ref: ObjectRef, reads: PlanningSnapshot) {
    this.observed(ctx, ref);
    const args = { function: 'didiOrderTestStatus', object: ref }, result = ctx.graph.evaluate(ctx.owner, args);
    if (result.status !== 'known' || !reads.objects.some(o => same(o.ref, ref)) || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(args) && r.outputDigest === digest(result))) fail('Read and evaluate the exact current order-test source');
  }
  private place(ctx: AgentProgramContext, ref: ObjectRef, id: string, role: 'origin' | 'destination'): DidiPlace {
    const task = this.scope(ctx), s = this.observed(ctx, ref);
    if (s.data.kind !== 'places' || s.data.role !== role) return fail('Place belongs to another route role');
    const matches = s.data.places.filter(p => p.name === task[role] && p.city.replace(/市$/, '') === task.city.replace(/市$/, ''));
    if (matches.length !== 1 || matches[0]!.id !== id) fail('Select the unique exact fixed test endpoint from the source');
    return matches[0]!;
  }
  private quote(ctx: AgentProgramContext, ref: ObjectRef) {
    const s = this.observed(ctx, ref); if (s.data.kind !== 'quote') return fail('Expected an owned Mock quote');
    const selected = s.data.items.filter(i => i.productCategory === '1' && i.productName === '快车');
    if (selected.length !== 1 || !selected[0]!.estimatedMoney) fail('An exact Mock 快车 estimate is required before confirmation');
    const secret = this.store.preparationContext<QuoteSecret>(ctx.owner, ctx.request.id, `didi-test-quote:${s.id}`);
    if (!secret || secret.configurationDigest !== this.configurationDigest || secret.traceDigest !== s.data.traceDigest || digest(secret.traceId) !== secret.traceDigest || secret.quoteReceiptId !== s.receipt.id || Date.parse(secret.expiresAt) <= Date.now()) fail('The private estimate trace expired or is not bound to this quote');
    return { snapshot: s, selected: selected[0]!, secret };
  }
  private original(ctx: AgentProgramContext, ref: ObjectRef) {
    const s = this.observed(ctx, ref, true);
    if (s.data.kind !== 'created' && s.data.kind !== 'status') return fail('Readback needs the original order returned by this task');
    const secret = this.store.preparationContext<OrderSecret>(ctx.owner, ctx.request.id, `didi-test-order:${s.data.creationIntentId}`);
    if (!secret || secret.configurationDigest !== this.configurationDigest || secret.orderId !== s.data.orderId || !same(secret.quote, s.data.quote)) fail('The order has no original owned creation receipt');
    return secret;
  }
  validate(ctx: AgentProgramContext, action: string, raw: Record<string, unknown>) {
    this.scope(ctx); this.schema(action).parse(raw);
    if (!same(raw.scope, ctx.state.scope)) fail('Order-test action belongs to another scope');
    if (action === 'EstimateDidiTestOrder') { this.place(ctx, objectRefSchema.parse(raw.origin), String(raw.originPlaceId), 'origin'); this.place(ctx, objectRefSchema.parse(raw.destination), String(raw.destinationPlaceId), 'destination'); }
    if (action === 'CreateDidiTestOrder') {
      this.quote(ctx, objectRefSchema.parse(raw.quote));
      const current = ctx.state.plans.find(p => p.id === ctx.state.pendingPlanId)?.steps.filter(s => s.action === action && same(s.input, raw)).map(s => s.intentId) ?? [];
      if (ctx.intents?.some(i => i.effect === 'order' && !['ready', 'rejected', 'canceled_before_dispatch'].includes(i.state) && !(i.state === 'dispatching' && current.includes(i.id)))) fail('An order was already created or remains uncertain; read its original outcome, never create again');
    }
    if (action === 'QueryDidiTestOrder') this.original(ctx, objectRefSchema.parse(raw.order));
  }
  validatePlanning(ctx: AgentProgramContext, action: string, raw: Record<string, unknown>, reads: PlanningSnapshot) {
    if (action === 'CreateDidiTestOrder') this.evaluated(ctx, objectRefSchema.parse(raw.quote), reads);
    if (action === 'EstimateDidiTestOrder') { this.evaluated(ctx, objectRefSchema.parse(raw.origin), reads); this.evaluated(ctx, objectRefSchema.parse(raw.destination), reads); }
    if (action === 'QueryDidiTestOrder') { const ref = objectRefSchema.parse(raw.order); this.original(ctx, ref); if (!reads.objects.some(o => same(o.ref, ref))) fail('Read the owned order identity before querying it'); }
  }
  authority(ctx: AgentProgramContext, action: string, raw: Record<string, unknown>) {
    this.validate(ctx, action, raw); if (action !== 'CreateDidiTestOrder') return fail('Only the declared Mock creation has an order effect');
    const q = this.quote(ctx, objectRefSchema.parse(raw.quote));
    // The Mock endpoint has no real fee. The displayed estimate remains in the
    // immutable quote/plan; zero authority is never a production payment permit.
    return { cost: { minor: '0', currency: 'CNY', payeeId: 'didi-official-mock' }, operationScope: `didi-test:${digest({ task: ctx.request.id, revision: ctx.request.revision, quote: q.snapshot.id })}` };
  }
  authorizationSummary(ctx: AgentProgramContext, plan: import('../../ontology/agent-actions.js').AgentActionPlan) {
    const step = plan.steps.find(s => s.action === 'CreateDidiTestOrder') ?? fail('No Mock order in this plan');
    const quote = this.quote(ctx, objectRefSchema.parse(step.input.quote));
    return `【滴滴官方 Mock 测试】北京西站 → 西二旗地铁站，快车，模拟预估 ${quote.selected.priceText} 元。不会派真车或产生真实费用。请确认此准确方案后创建测试订单并独立查询；预估不是最终车费。`;
  }
  private snapshot(ctx: AgentActionContext, action: string, input: Record<string, unknown>, receipt: OrderTestSnapshot['receipt'], data: unknown, kind: OrderTestSnapshot['evidenceKind']) {
    if (receipt.bindingId !== this.binding.bindingId) fail('Order-test source account binding changed');
    const body = { id: receipt.id, requestId: ctx.request.id, requestRevision: ctx.request.revision, scope: ctx.state.scope, configurationDigest: this.configurationDigest, action, actionInput: input, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, receipt, evidenceKind: kind, data: orderTestDataSchema.parse(data), observedAt: receipt.receivedAt, expiresAt: new Date(Date.parse(receipt.startedAt) + (action === 'EstimateDidiTestOrder' ? 120000 : 300000)).toISOString() };
    return checkedOrderTestSnapshot({ ...body, contentDigest: digest(body) });
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input); let value: OrderTestSnapshot;
    if (action === 'SearchDidiTestPlaces') {
      const call = resolveOntologyMcpRead(this.definition(ctx.graph, action).read!.mcp!, input, this.scope(ctx), () => fail('No place dependency'));
      if (call.server !== 'didi' || call.tool !== 'maps_textsearch') fail('The declared public map binding is outside its connector');
      const result = await this.maps.invoke({ requestId: ctx.request.id, requestRevision: ctx.request.revision, actionInputDigest: digest(input), planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId }, 'maps_textsearch', call.args, signal);
      if (result.data.kind !== 'places') fail('Wrong public map result');
      value = this.snapshot(ctx, action, input, result.receipt, { ...result.data, role: input.role }, this.maps.evidenceKind);
    } else if (action === 'EstimateDidiTestOrder') {
      const call = resolveOntologyMcpRead(this.definition(ctx.graph, action).read!.mcp!, input, this.scope(ctx), dep => this.place(ctx, objectRefSchema.parse(input[dep.observationInput]), String(input[dep.selectionInput!]), dep.role as 'origin' | 'destination'));
      if (call.server !== 'didi' || call.tool !== 'taxi_estimate') fail('The declared Mock estimate binding is outside its connector');
      const result = await this.orders.invoke('taxi_estimate', call.args, signal), raw = result.raw as any;
      const traceId = z.string().min(1).max(3000).parse(raw.structuredContent?.traceId), data = mapDidiResult('taxi_estimate', raw);
      if (data.kind !== 'estimate') fail('Wrong Mock quote result');
      value = this.snapshot(ctx, action, input, result.receipt, { kind: 'quote', items: data.items, traceDigest: digest(traceId), route: call.route }, this.orders.evidenceKind);
      if (!ctx.persistPrivate?.(() => this.store.savePreparationContext(ctx.owner, ctx.request.id, `didi-test-quote:${value.id}`, { traceId, traceDigest: digest(traceId), quoteReceiptId: result.receipt.id, configurationDigest: this.configurationDigest, expiresAt: value.expiresAt } satisfies QuoteSecret))) fail('Quote arrived after the current claim ended');
    } else if (action === 'CreateDidiTestOrder') {
      const quote = objectRefSchema.parse(input.quote), q = this.quote(ctx, quote);
      if (this.definition(ctx.graph, action).providerOperation !== 'taxi_create_order') fail('The declared Mock order binding changed');
      ctx.assertDispatchAllowed?.();
      const result = await this.orders.invoke('taxi_create_order', { product_category: '1', estimate_trace_id: q.secret.traceId }, signal);
      const raw = (result.raw as any).structuredContent;
      const data = z.object({ orderId: z.string().min(1).max(500), status: z.literal('created'), from: z.object({ name: z.literal('北京西站') }), to: z.object({ name: z.literal('西二旗地铁站') }) }).parse(raw);
      value = this.snapshot(ctx, action, input, result.receipt, { kind: 'created', orderId: data.orderId, fromName: data.from.name, toName: data.to.name, status: data.status, productCategory: '1', quote, creationIntentId: ctx.intentId }, this.orders.evidenceKind);
      ctx.persistPrivate?.(() => this.store.savePreparationContext(ctx.owner, ctx.request.id, `didi-test-order:${ctx.intentId}`, { orderId: data.orderId, quote, creationIntentId: ctx.intentId, configurationDigest: this.configurationDigest, receiptId: result.receipt.id } satisfies OrderSecret));
    } else {
      const order = objectRefSchema.parse(input.order), original = this.original(ctx, order);
      const call = resolveOntologyMcpRead(this.definition(ctx.graph, action).read!.mcp!, input, this.scope(ctx), dep => this.original(ctx, objectRefSchema.parse(input[dep.observationInput])));
      if (call.server !== 'didi' || call.tool !== 'taxi_query_order' || call.args.order_id !== original.orderId) fail('The declared query must retain the original owned order ID');
      const result = await this.orders.invoke('taxi_query_order', call.args, signal);
      value = this.snapshot(ctx, action, input, result.receipt, { kind: 'status', ...parseMockOrderStatus(result.raw, original.orderId), original: order, quote: original.quote, productCategory: '1', creationIntentId: original.creationIntentId }, this.orders.evidenceKind);
    }
    return { value, evidenceRefs: [value.receipt.id] };
  }
  async recover(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal) {
    if (action !== 'CreateDidiTestOrder') return;
    this.scope(ctx);
    let original = this.store.preparationContext<OrderSecret>(ctx.owner, ctx.request.id, `didi-test-order:${ctx.intentId}`);
    if (!original) for (const observation of this.store.observations(ctx.owner, ctx.intentId)) {
      const parsed = (observation as { output?: { source?: unknown } }).output?.source;
      try {
        const s = checkedOrderTestSnapshot(parsed);
        if (s.data.kind !== 'created' || s.action !== action || s.intentId !== ctx.intentId || s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== this.configurationDigest || !same(s.actionInput, input) || s.evidenceKind !== this.orders.evidenceKind) continue;
        original = { orderId: s.data.orderId, quote: s.data.quote, creationIntentId: s.data.creationIntentId, configurationDigest: s.configurationDigest, receiptId: s.receipt.id };
        const recovered = original;
        ctx.persistPrivate?.(() => this.store.savePreparationContext(ctx.owner, ctx.request.id, `didi-test-order:${ctx.intentId}`, recovered));
        break;
      } catch { /* An unknown/error observation cannot manufacture an order ID. */ }
    }
    if (!original || original.configurationDigest !== this.configurationDigest) return; // No ID: no latest-order guessing, no create replay.
    const result = await this.orders.invoke('taxi_query_order', { order_id: original.orderId }, signal);
    const value = this.snapshot(ctx, action, input, result.receipt, { kind: 'status', ...parseMockOrderStatus(result.raw, original.orderId), quote: original.quote, productCategory: '1', creationIntentId: original.creationIntentId }, this.orders.evidenceKind);
    return { value, evidenceRefs: [value.receipt.id] };
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult) {
    const s = checkedOrderTestSnapshot(result.value);
    if (action === 'CreateDidiTestOrder' && s.data.kind === 'status' && !ctx.recovery) fail('Only original-operation recovery can map a status to the creation result');
    if (s.action !== action || !same(s.actionInput, input)) fail('Order-test result differs from its selected Action');
    return projectOrderTest(ctx, s);
  }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    this.scope(ctx); const selected = orderTestCompletionSchema.parse(raw), s = this.observed(ctx, selected.observation); this.evaluated(ctx, selected.observation, reads);
    if (s.data.kind !== 'status' || ![0, 1, 2, 4, 5].includes(s.data.statusCode) || s.receipt.tool !== 'taxi_query_order') fail('Mock creation needs an independent original-ID status read; an acknowledgement is insufficient');
    this.original(ctx, selected.observation);
    const quote = this.observed(ctx, s.data.quote, true);
    if (quote.data.kind !== 'quote') fail('The verified order has no original route quote');
    const locations = { origin: quote.data.route.origin.name, destination: quote.data.route.destination.name };
    const normalize = (value: string) => value.replace(/[\s-]/g, '');
    for (const requirement of ctx.request.requirements) if (requirement.kind === 'location' && (requirement.role === 'origin' || requirement.role === 'destination')) {
      const place = quote.data.route[requirement.role];
      const aliases = [place.name, place.addressAll].flatMap(v => [v, '北京市' + v, '北京' + v]);
      if (aliases.some(v => normalize(v) === normalize(requirement.expected.ref))) locations[requirement.role] = requirement.expected.ref;
    }
    const result = { testOnly: true, realOrder: false, realPayment: false, environment: 'official_mock', orderId: s.data.orderId, statusCode: s.data.statusCode, statusText: s.data.statusText, statusEncoding: s.data.encoding, providerEchoedOrderId: s.data.identityEchoed, readback: selected.observation, fixedMockRoute: '北京西站 → 西二旗地铁站', requestedClass: '快车', driverAcceptanceGuaranteed: false, finalFareKnown: false };
    return { artifact: { id: randomUUID(), name: 'didi-official-mock-order.json', data: { goal: ctx.request.originalGoal, deliverable: `滴滴官方 Mock 测试订单已创建并独立查询，状态：${s.data.statusText}。没有真实派车或付款；匹配中不等于司机已接单。`, execution: 'completed', result } }, facts: { locations, conditions: ['didi.mock_order_verified', 'execution.no_real_effects'] }, evidenceRefs: [s.receipt.id], evidenceLevel: this.orders.evidenceKind === 'fixture' ? 'synthetic' : 'provider_test' };
  }
}
