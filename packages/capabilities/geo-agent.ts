import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { AgentOperationRejected, type AgentActionContext, type AgentActionResult, type AgentProgram, type AgentProgramContext } from '../core/agent-program.js';
import type { Delivery, ExecutionAdapter, Preparation } from '../core/catalog.js';
import type { ServiceCapability, ServiceRequest } from '../ontology/execution.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import { linkSnapshotDigest, type OntologyObjectStore } from '../ontology/object-store.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import { geoActionSchema, geoObservationSchema } from '../ontology/geo-composition.js';
import { projectReadResult } from '../ontology/task-projection.js';
import { objectResultProjection } from '../core/composed-actions.js';
import { publicGeoQuerySchema } from './paotui-contracts.js';
import { paotuiPublicPlaceSchema } from './paotui-public-locations.js';
import { ontologyReceiptSchema } from './paotui-mcp-server.js';
import { PAOTUI_READ_BINDINGS, PAOTUI_READ_CAPABILITIES } from './paotui-ontology.js';
import { adapterInvocation } from './atomic-adapter.js';

const resultSchema = z.strictObject({ source: z.literal('meituan'), readOnly: z.literal(true), places: z.array(paotuiPublicPlaceSchema).max(100), ontologyReceipt: ontologyReceiptSchema });
const completion = z.strictObject({ result: objectRefSchema.extend({ type: z.literal('GeoObservation') }) });
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
type Value = { prepared: Extract<Preparation, { kind: 'ready' }>; delivery: Delivery };

export class GeoAgentProgram implements AgentProgram {
  readonly ref = { id: 'geo.search.atomic', version: '1' }; readonly actionIds = ['ReadPublicLocations']; readonly completionSchema = z.toJSONSchema(completion);
  readonly guidance = 'ReadPublicLocations performs only the exact city and keyword of this explicitly prepared public query. Configured allowlists remain authoritative. A source failure is not missing user data. Read the actual GeoObservation and its locations; the bounded preview is marked incomplete when not all locations fit. Empty results are still a source observation, never proof of complete coverage. Complete with the original GeoObservation; no product search, merchant trust, delivery, orders or payment is implied.';
  constructor(private adapter: ExecutionAdapter, readonly configurationDigest: string, private environment: 'live' | 'sandbox' = 'live') {}
  permitted(owner: string) { return this.adapter.permitted(owner); }
  capability(): ServiceCapability { const original = PAOTUI_READ_CAPABILITIES[0]!; return { ...original, environment: this.environment, actions: [...original.actions, { ref: { id: 'ReadPublicLocations', version: '1' }, effect: 'read' }], outcomePredicates: ['geo.locations_observed'], goalOutcomes: [{ predicate: 'geo.locations_observed', phase: 'fact', description: 'Original public city/keyword result; complete coverage and commerce suitability remain unknown' }], requirementRoles: [{ kind: 'quantity', role: 'result_count', description: 'Number of actually returned public locations' }], effectConstraints: [{ predicate: 'execution.no_order', allowedEffects: ['read', 'local'] }] }; }
  listingBinding() { const original = PAOTUI_READ_BINDINGS[0]!; return { ...original, ref: { id: `${original.ref.id}.atomic`, version: '1' }, configurationDigest: this.configurationDigest }; }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown, component?: { id: string; scopeKey: string }) {
    if (!this.permitted(owner)) throw new DomainError('FORBIDDEN', 'Public source is unavailable to this owner');
    const input = publicGeoQuerySchema.parse(raw), scope = { type: 'GeoQueryTask', id: `${request.id}:r${request.revision}:c${component?.scopeKey ?? digest(this.ref)}` };
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: '公开地点查询', requestRevision: request.revision, input, configurationDigest: this.configurationDigest } }], links: [{ type: 'GeoQueryTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  assertContext(ctx: AgentProgramContext) { const scope = ctx.graph.read(ctx.owner, ctx.state.scope); if (!this.permitted(ctx.owner) || ctx.state.programDigest !== this.configurationDigest || !same(ctx.state.programRef, this.ref) || scope.ref.type !== 'GeoQueryTask' || scope.properties.requestRevision !== ctx.request.revision || scope.properties.configurationDigest !== this.configurationDigest || !same(scope.properties.input, ctx.state.input)) fail('Public query scope or source changed'); }
  schema(action: string) { if (action !== 'ReadPublicLocations') return fail('Unsupported public query operation'); return geoActionSchema; }
  definition(graph: OntologyObjectStore, action: string) { const definition = graph.model.action(action); if (!definition.read || !same(definition.read.inputSchema, z.toJSONSchema(this.schema(action)))) fail('Public query action contract changed'); return definition; }
  validate(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) { this.assertContext(ctx); if (!same(this.schema(action).parse(input).scope, ctx.state.scope)) fail('Public query uses another context'); }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input); const prepared = await this.adapter.prepare(ctx, ctx.state.input, signal);
    if (prepared.kind !== 'ready') throw new AgentOperationRejected(prepared.kind === 'needs_input' ? prepared.question : prepared.reason, []);
    const plan = adapterInvocation(ctx, ctx.intentId, this.listingBinding(), PAOTUI_READ_CAPABILITIES[0]!.actions[0]!.ref, ctx.state.input, prepared.details);
    const delivery = await this.adapter.execute(ctx, plan, prepared.privateData, signal);
    if (!this.adapter.verify(ctx, plan, prepared.privateData, delivery).accepted) fail('Public query receipt failed independent validation');
    resultSchema.parse(delivery.artifact.data.result);
    return { value: { prepared, delivery } satisfies Value, evidenceRefs: delivery.evidenceRefs };
  }
  project(ctx: AgentActionContext, _action: string, _input: Record<string, unknown>, result: AgentActionResult) {
    const value = result.value as Value, raw = resultSchema.parse(value.delivery.artifact.data.result), receipt = raw.ontologyReceipt;
    if (projectReadResult(ctx.graph, ctx.owner, { request: ctx.request, capabilityId: 'geo.search', input: ctx.state.input, preparedReceipt: value.prepared.details.ontologyReceipt, result: raw }).state !== 'typed_result') fail('Public locations could not be mapped from their original source receipt');
    const original = ctx.graph.read(ctx.owner, { type: 'SourceReceipt', id: receipt.id }), locations = (original.properties.subjects as { object: ObjectRef }[]).map(value => value.object);
    const object = { type: 'GeoObservation', id: digest({ intent: ctx.intentId, attempt: ctx.attemptId }) }, proof = { type: 'SourceReceipt', id: digest({ receipt: receipt.id, object }) };
    const snapshot = geoObservationSchema.parse({ configurationDigest: this.configurationDigest, scope: ctx.state.scope, query: ctx.state.input, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, sourceReceipt: receipt.id, resultDigest: digest(raw), observedAt: receipt.observedAt, expiresAt: new Date(Date.parse(receipt.observedAt) + 300000).toISOString(), locations, preview: raw.places.slice(0, 4), previewComplete: raw.places.length <= 4, completeCoverageKnown: false });
    const properties = { id: object.id, displayTitle: '公开地点只读结果', requestRevision: ctx.request.revision, snapshot };
    const links = [{ type: 'GeoObservationRequest', from: object, to: { type: 'ServiceRequest', id: ctx.request.id } }, { type: 'GeoObservationScope', from: object, to: ctx.state.scope }, { type: 'GeoObservationEvidence', from: object, to: proof }, ...locations.map(location => ({ type: 'GeoObservationPlaces', from: object, to: location }))];
    ctx.graph.ingest(ctx.owner, { objects: [{ ref: object, properties }, { ref: proof, properties: { receiptId: proof.id, displayTitle: '公开地点来源回读', sourceIdentity: receipt.server, sourceEventId: receipt.id, scope: 'public_locations', observedAt: receipt.observedAt, evidenceLevel: receipt.evidenceKind === 'fixture' ? 'synthetic' : 'live_readonly', contentDigest: receipt.resultDigest, subjects: [{ object, digest: digest(properties), linksDigest: linkSnapshotDigest(object, links) }], safeSummary: 'Original read-only public query; no commercial supply or fulfillment proof' } }], links: [...links, { type: 'ReceiptRequest', from: proof, to: { type: 'ServiceRequest', id: ctx.request.id } }] }, { kind: receipt.evidenceKind === 'fixture' ? 'synthetic' : 'provider', id: receipt.id, observedAt: receipt.observedAt });
    return object;
  }
  private observation(ctx: AgentProgramContext, ref: ObjectRef) {
    const snapshot = geoObservationSchema.parse(ctx.graph.read(ctx.owner, ref).properties.snapshot), intent = ctx.intents?.find(value => value.id === snapshot.intentId && value.state === 'effect_confirmed' && same(value.acceptedOutput?.object, ref));
    const value = intent?.lastVerifiedResult?.output?.source as Value | undefined;
    if (!value || snapshot.configurationDigest !== this.configurationDigest || !same(snapshot.scope, ctx.state.scope) || !same(snapshot.query, ctx.state.input) || snapshot.resultDigest !== digest(value.delivery.artifact.data.result) || Date.parse(snapshot.expiresAt) <= Date.now()) fail('Public result is stale or not from this original accepted query');
    const original = ctx.graph.read(ctx.owner, { type: 'SourceReceipt', id: snapshot.sourceReceipt });
    for (const subject of original.properties.subjects as { object: ObjectRef; digest: string }[]) if (subject.digest !== digest(ctx.graph.read(ctx.owner, subject.object).properties)) fail('A later public source observation conflicts with this query');
    return { snapshot, value };
  }
  projectOutputs(ctx: AgentActionContext, _action: string, _input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef) { const receipt = resultSchema.parse((result.value as Value).delivery.artifact.data.result).ontologyReceipt; return objectResultProjection(object, { origin: receipt.evidenceKind === 'fixture' ? 'synthetic' : 'provider', refs: result.evidenceRefs, observedAt: receipt.observedAt, expiresAt: new Date(Date.parse(receipt.observedAt) + 300000).toISOString() }, false, true); }
  validateOutput(ctx: AgentProgramContext, output: import('../ontology/composition-contract.js').AcceptedPortValue) { this.assertContext(ctx); const values = output.definition.cardinality === 'many' ? output.value as ObjectRef[] : [output.value as ObjectRef]; for (const value of values) this.observation(ctx, value); }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    this.assertContext(ctx); const selected = completion.parse(raw).result;
    if (!(reads.deliveredObjects ?? reads.objects).some(value => same(value.ref, selected))) fail('Read the original public query observation before completion');
    const { snapshot, value } = this.observation(ctx, selected), plan = adapterInvocation(ctx, snapshot.intentId, this.listingBinding(), PAOTUI_READ_CAPABILITIES[0]!.actions[0]!.ref, ctx.state.input, value.prepared.details);
    if (!this.adapter.verify(ctx, plan, value.prepared.privateData, value.delivery).accepted) fail('Public source readback is no longer independently valid');
    return { ...value.delivery, facts: { ...value.delivery.facts, quantities: { result_count: { amount: String(snapshot.locations.length), unit: 'result' } }, conditions: ['execution.no_order', 'geo.locations_observed'] } };
  }
}
