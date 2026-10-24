import { projectRideOrder } from '../../ontology/ride-booking-functions.js';
import { randomUUID } from 'node:crypto';
import type { Delivery } from '../../core/catalog.js';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import type { AgentProgramContext, AgentActionContext, AgentActionResult } from '../../core/agent-program.js';
import { objectResultProjection } from '../../core/composed-actions.js';
import type { AcceptedPortValue } from '../../ontology/composition-contract.js';
import type { OntologyObjectStore } from '../../ontology/object-store.js';
import type { ServiceRequest } from '../../ontology/execution.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import type { AgentDecision } from '../../ontology/agent-actions.js';
import type { ObjectRef } from '../../ontology/model.js';
import { rideEstimateActionIds } from '../../ontology/ride-estimate.js';
import { rideBookingActionSchemas, rideBookingCompletionSchema, checkedRideOrder, type RideOrderSnapshot } from '../../ontology/ride-booking.js';
import { DidiAgentProgram, routeLocationFacts } from './program.js';
import { DidiBookingConnector } from './booking-connector.js';
import { didiOrderResultSchema, type DidiOrderResult } from './booking-contracts.js';
import type { DidiBinding } from './contracts.js';
import type { DidiConnector } from './connector.js';

export const DIDI_BOOKING_PROGRAM_REF = { id: 'ride.booking.sandbox', version: '1' };
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
export class DidiBookingProgram extends DidiAgentProgram {
  override readonly actionIds = [...rideEstimateActionIds, ...Object.keys(rideBookingActionSchemas)];
  override readonly completionSchema = z.toJSONSchema(rideBookingCompletionSchema);
  readonly limits = { modelTurns: 24, plans: 12, actions: 12 };
  override readonly guidance = 'Use Ontology to choose source place searches, estimate, CreateDidiRide and ReadDidiRide. This program is official DiDi MOCK only. One context of ride.booking.sandbox covers BOTH ride.estimate_observed and ride.mock_order_readback; its own search and estimate actions provide the prerequisites. Do not initialize another component for these intermediate steps. For every selected action, discover its exact current binding for this existing component and use that binding digest. Read and evaluate both source place observations before estimating; preserve exact city, origin and destination. Read and evaluate the estimate, select only the requested vehicle, and echo its exact productName, productCategory and priceText in CreateDidiRide. Proposing CreateDidiRide does not dispatch it: the host first freezes the exact plan and returns auth-required with the route, vehicle and price for owner approval. Once the route and requested class are known, propose that action to obtain approval; do not use clarify merely to request this same order authorization. Clarify is only for missing business choices. An estimate is not a guaranteed final fare. Never substitute a new quote under an old approval. After creation, read the original DidiOrderObservation and choose ReadDidiRide using its object reference; never supply or guess an order ID. Complete only after reading AND evaluating didiOrderStatus on an independently read observation. Report order ID and current driver state, not an actual completed ride. Creation with missing response must never be repeated. Do not create replacement tasks/orders or query an unscoped current account order. No cancellation, payment or production operation is available.';
  constructor(binding: DidiBinding, private operations = new DidiBookingConnector(binding), connector?: DidiConnector) {
    super(binding, { connector: connector ?? operations, ref: DIDI_BOOKING_PROGRAM_REF });
    if (binding.environment !== 'mock' || !binding.auditDirectory) fail('DiDi booking requires an explicit durable mock binding');
  }
  override capability() {
    return { ...super.capability(), name: '滴滴模拟叫车与原订单回读', description: '在滴滴官方 Mock 环境完成路线搜索、估价、明确车型及预估费用确认、创建模拟订单和原订单司机状态回读。只接受 executionEnvironment=sandbox。用户确认绑定当次路线、车型和预估价；不承诺最终车费。未启用真实叫车或付款。', environment: 'sandbox' as const,
      inputSchema: z.toJSONSchema(z.strictObject({ mode: z.literal('estimate'), city: z.string().min(1).max(500), origin: z.string().min(1).max(500), destination: z.string().min(1).max(500), serviceClass: z.string().min(1).max(500) })),
      tags: ['ride', 'didi', 'order', 'sandbox'], actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: id === 'CreateDidiRide' ? 'order' as const : 'read' as const })),
      predicates: [{ id: 'ride.estimate_observed', description: 'The exact route and vehicle estimate used in authorization' }, { id: 'ride.mock_order_readback', description: 'Official mock order independently read; no real ride or payment' }],
      outcomePredicates: ['ride.estimate_observed', 'ride.mock_order_readback'], goalOutcomes: [{ predicate: 'ride.estimate_observed', phase: 'quote' as const, description: 'The exact route and vehicle estimate used in authorization, not a guaranteed final fare' }, { predicate: 'ride.mock_order_readback', phase: 'commitment' as const, description: 'Mock order identity and driver status independently read' }],
      ontology: { objects: ['RideEstimateTask', 'DidiPlaceObservation', 'RideEstimateObservation', 'DidiOrderObservation'], functions: ['rideEstimateStatus', 'didiOrderStatus'], realOperationsAllowed: false },
    };
  }
  override initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, value: unknown, component?: { id: string; scopeKey: string }) {
    if (request.executionEnvironment !== 'sandbox') fail('DiDi booking is mock only');
    const parsed = z.strictObject({ mode: z.literal('estimate'), city: z.string().min(1).max(500), origin: z.string().min(1).max(500), destination: z.string().min(1).max(500), serviceClass: z.string().min(1).max(500) }).parse(value);
    return super.initialize(graph, owner, request, parsed, component);
  }
  override schema(action: string): z.ZodType<Record<string, unknown>> { return Object.hasOwn(rideBookingActionSchemas, action) ? rideBookingActionSchemas[action as keyof typeof rideBookingActionSchemas] : super.schema(action); }
  override definition(graph: OntologyObjectStore, action: string) {
    if (!Object.hasOwn(rideBookingActionSchemas, action)) return super.definition(graph, action);
    const definition = graph.model.action(action), op = definition.read ?? definition.operation;
    if (!op || !same(op.inputSchema, z.toJSONSchema(this.schema(action))) || action === 'CreateDidiRide' && (definition.operation?.effect !== 'order' || definition.operation.environment !== 'sandbox')) fail('DiDi order definition changed');
    return definition;
  }
  private order(ctx: AgentProgramContext, ref: ObjectRef) {
    this.scope(ctx);
    if (!ctx.state.observations.some(o => same(o, ref))) fail('Order observation was not accepted by this task');
    const s = checkedRideOrder(ctx.graph.read(ctx.owner, ref).properties.snapshot);
    if (s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== this.configurationDigest || !same(s.scope, ctx.state.scope) || s.source.receipt.bindingId !== this.binding.bindingId || s.evidenceKind !== this.operations.evidenceKind) fail('Order belongs to another task, account or source');
    const original = (ctx.taskIntents ?? ctx.intents)?.find(i => i.id === s.originalIntentId);
    if (!original || original.effect !== 'order' || original.remoteRef !== s.source.data.orderId || !['effect_confirmed', 'canceled_after_dispatch'].includes(original.state)) fail('The original accepted order identity is unavailable');
    return s;
  }
  private quote(ctx: AgentProgramContext, raw: Record<string, unknown>) {
    const input = rideBookingActionSchemas.CreateDidiRide.parse(raw), scope = this.scope(ctx), s = this.observation(ctx, input.estimate).snapshot;
    if (scope.mode !== 'estimate' || s.data.kind !== 'estimate') return fail('Expected the current source estimate');
    const item = s.data.items.find(item => item.productCategory === input.productCategory);
    if (!item || item.productName !== input.productName || item.priceText !== input.priceText || scope.serviceClass !== item.productName) fail('Confirm the exact requested source vehicle and displayed estimate');
    const locations = routeLocationFacts(ctx.request, s.route!, scope.city);
    for (const requirement of [...ctx.request.requirements, ...(ctx.request.successCriteria ?? [])]) {
      if (requirement.strength === 'hard' && requirement.kind === 'location' && (requirement.role === 'origin' || requirement.role === 'destination') && locations[requirement.role] !== requirement.expected.ref) fail(`The source route does not match the fixed ${requirement.role} location requirement. Do not place an order or rewrite the goal.`);
    }
    return s;
  }
  override validate(ctx: AgentProgramContext, action: string, raw: Record<string, unknown>) {
    if (!Object.hasOwn(rideBookingActionSchemas, action)) return super.validate(ctx, action, raw);
    this.scope(ctx); this.definition(ctx.graph, action);
    const input = this.schema(action).parse(raw);
    if (ctx.request.executionEnvironment !== 'sandbox' || !same(input, raw) || !same(input.scope, ctx.state.scope)) fail('DiDi mock operation escaped its exact scope');
    if (action === 'CreateDidiRide') {
      this.quote(ctx, raw);
      // The durable business operation scope admits one order intent per task.
      // Authority rechecks also run while that original intent is dispatching.
    } else this.order(ctx, rideBookingActionSchemas.ReadDidiRide.parse(raw).order);
  }
  override validatePlanning(ctx: AgentProgramContext, action: string, raw: Record<string, unknown>, reads: PlanningSnapshot) {
    if (action === 'CreateDidiRide') this.readEvaluated(ctx, rideBookingActionSchemas.CreateDidiRide.parse(raw).estimate, reads);
    else if (action === 'ReadDidiRide') {
      const ref = rideBookingActionSchemas.ReadDidiRide.parse(raw).order; this.order(ctx, ref);
      if (!reads.objects.some(o => same(o.ref, ref))) fail('Read the original order identity before querying its state');
    } else super.validatePlanning(ctx, action, raw, reads);
  }
  validatePause(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot) {
    if (decision.kind === 'no_feasible_plan') {
      const original = ctx.state.observations.filter(ref => ref.type === 'DidiOrderObservation').at(-1);
      if (!original) return;
      const order = this.order(ctx, original);
      if (!order.source.data.independentRead) fail('The original mock order was accepted. Query its observation with ReadDidiRide before judging failure; never create a replacement.');
      const query = { function: 'didiOrderStatus', object: original }, status = ctx.graph.evaluate(ctx.owner, query);
      if (!reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(query) && r.outputDigest === digest(status))) fail('Evaluate the latest original order status in this decision before reporting infeasibility.');
      if (status.status === 'known') fail('The original mock order has a verified status report. Complete from that readback instead of reporting the operation as failed.');
      return;
    }
    if (decision.kind !== 'clarify' || ctx.state.observations.some(ref => ref.type === 'DidiOrderObservation')) return;
    const scope = this.scope(ctx);
    if (scope.mode !== 'estimate') return;
    const ready = ctx.state.observations.filter(ref => ref.type === 'RideEstimateObservation').some(ref => {
      try { const data = this.observation(ctx, ref).snapshot.data; return data.kind === 'estimate' && data.items.some(item => item.productName === scope.serviceClass); } catch { return false; }
    });
    if (ready) fail('The route, requested vehicle and current source estimate are already known. Propose CreateDidiRide to display the exact plan and obtain owner authorization; this proposal cannot dispatch before approval. Do not request the same confirmation as missing information.');
  }
  authority(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    if (action !== 'CreateDidiRide') return fail('Only mock order creation needs order authority');
    this.validate(ctx, action, input);
    const quote = this.quote(ctx, input);
    return { confirmation: { title: '滴滴模拟叫车确认', details: [`路线：${quote.route!.origin.name} → ${quote.route!.destination.name}`, `车型：${String(input.productName)}`, `预估价：${String(input.priceText)}；最终完整车费未知`, `本地刷新截止：${quote.expiresAt}；过期须重新估价并确认`, '仅在官方 Mock 创建模拟订单，不真实叫车、不付款。'] }, cost: { minor: '0', currency: 'CNY', payeeId: 'didi:official-mock' }, operationScope: `didi-order:${digest({ owner: ctx.owner, request: ctx.request.id, binding: this.configurationDigest })}` };
  }
  private result(ctx: AgentActionContext, action: string, input: Record<string, unknown>, source: DidiOrderResult): AgentActionResult {
    const create = action === 'CreateDidiRide' ? rideBookingActionSchemas.CreateDidiRide.parse(input) : undefined;
    const original = create ? undefined : this.order(ctx, rideBookingActionSchemas.ReadDidiRide.parse(input).order);
    const data = didiOrderResultSchema.parse(source);
    const body = { id: data.receipt.id, requestId: ctx.request.id, requestRevision: ctx.request.revision, configurationDigest: this.configurationDigest, scope: ctx.state.scope, action, actionInput: input,
      planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId ?? fail('Missing model decision'), originalIntentId: original?.originalIntentId ?? ctx.intentId,
      estimate: create?.estimate ?? original!.estimate, productCategory: create?.productCategory ?? original!.productCategory, productName: create?.productName ?? original!.productName, priceText: create?.priceText ?? original!.priceText,
      source: data, evidenceKind: this.operations.evidenceKind, observedAt: data.receipt.receivedAt };
    return { value: checkedRideOrder({ ...body, contentDigest: digest(body) }), evidenceRefs: [data.receipt.id], observation: { kind: 'confirmed', eventId: data.receipt.id, sourceVersion: 1, remoteRef: data.data.orderId, evidenceRefs: [data.receipt.id] } };
  }
  override async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    if (!Object.hasOwn(rideBookingActionSchemas, action)) return super.invoke(ctx, action, input, signal);
    this.validate(ctx, action, input);
    const source = action === 'CreateDidiRide' ? await this.operations.create(ctx, this.quote(ctx, input), String(input.productCategory), signal)
      : await this.operations.query(this.order(ctx, rideBookingActionSchemas.ReadDidiRide.parse(input).order).source.data.orderId, signal);
    return this.result(ctx, action, input, source);
  }
  async recover(ctx: AgentActionContext, action: string, input: Record<string, unknown>, _signal: AbortSignal): Promise<AgentActionResult | undefined> {
    if (action !== 'CreateDidiRide') return;
    const original = await this.operations.recoverCreate(ctx);
    // Missing order ID is unresolved; never query whichever order is current.
    if (original) return this.result(ctx, action, input, original);
  }
  override project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    if (!Object.hasOwn(rideBookingActionSchemas, action)) return super.project(ctx, action, input, result);
    const s = checkedRideOrder(result.value), expected = this.result(ctx, action, input, s.source).value as RideOrderSnapshot;
    if (!same(s, expected) || !same(result.evidenceRefs, [s.id])) fail('DiDi order result does not bind this exact accepted attempt');
    return projectRideOrder(ctx.graph, ctx.owner, s);
  }
  override projectOutputs(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef) {
    if (object.type !== 'DidiOrderObservation') return super.projectOutputs(ctx, action, input, result, object);
    const snapshot = checkedRideOrder(ctx.graph.read(ctx.owner, object).properties.snapshot);
    return objectResultProjection(object, {
      origin: snapshot.evidenceKind === 'fixture' ? 'synthetic' : 'provider', refs: result.evidenceRefs,
      observedAt: snapshot.observedAt, expiresAt: new Date(Date.parse(snapshot.observedAt) + 300000).toISOString(),
    }, true, true);
  }
  override validateOutput(ctx: AgentProgramContext, output: AcceptedPortValue) {
    const refs = output.definition.cardinality === 'many' ? output.value as ObjectRef[] : [output.value as ObjectRef];
    for (const ref of refs) {
      if (ref.type === 'DidiOrderObservation') this.order(ctx, ref);
      else this.observation(ctx, ref);
    }
  }
  override complete(ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot): Delivery {
    const completion = rideBookingCompletionSchema.parse(proposal), s = this.order(ctx, completion.order), query = { function: 'didiOrderStatus', object: completion.order }, status = ctx.graph.evaluate(ctx.owner, query);
    const latest = ctx.state.observations.filter(ref => ref.type === 'DidiOrderObservation').at(-1);
    if (!latest || !same(latest, completion.order) || s.action !== 'ReadDidiRide' || !s.source.data.independentRead) fail('Select the latest ReadDidiRide observation, not the creation receipt or an older report.');
    if (status.status !== 'known') fail(`The current order report is unknown: ${status.reason ?? 'read the original order again'}`);
    if (!reads.objects.some(o => same(o.ref, completion.order))) fail('Read the selected latest order observation in this completion decision.');
    if (!reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(query) && r.outputDigest === digest(status))) fail('Call evaluate_ontology with function="didiOrderStatus" and the selected order object in this same completion decision; earlier sessions do not supply current evidence.');
    const quote = ctx.graph.read(ctx.owner, s.estimate).properties.snapshot as import('../../ontology/ride-estimate.js').RideEstimateObservation;
    const data = s.source.data, driver = data.driver ? [data.driver.name, data.driver.carModel, data.driver.carPlate].filter(Boolean).join(' · ') : data.sourceFormat === 'text' ? '以上为来源原文；结构化状态码及最终车费未知。' : '尚无司机信息';
    return { artifact: { id: randomUUID(), name: 'didi-mock-order.json', data: { goal: ctx.request.originalGoal, deliverable: `【滴滴官方模拟订单】${s.productName}，预估 ${s.priceText}\n订单号：${data.orderId}\n状态：${data.statusText}\n${driver}\n未发出真实叫车、未付款；这不证明真实行程完成。`, execution: 'completed', result: { didiOrder: { ...data, productName: s.productName, priceText: s.priceText, evidenceKind: s.evidenceKind, observedAt: s.observedAt, realOperationsAllowed: false } } } },
      facts: { conditions: ['ride.estimate_observed', 'ride.mock_order_readback'], ...(quote.route ? { locations: routeLocationFacts(ctx.request, quote.route, this.scope(ctx).city) } : {}) }, evidenceRefs: [s.id] };
  }
}
