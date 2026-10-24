import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { AgentOperationRejected, type AgentActionContext, type AgentActionResult, type AgentProgram, type AgentProgramContext } from '../core/agent-program.js';
import type { Delivery, Preparation, ExecutionAdapter } from '../core/catalog.js';
import type { ServiceRequest, ServiceCapability } from '../ontology/execution.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import { type OntologyObjectStore } from '../ontology/object-store.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import { briefInputSchema, csvInputSchema, csvSourceSchema, localActionSchemas, localReceiptSchema } from '../ontology/local-artifacts.js';
import type { AcceptedPortValue } from '../ontology/composition-contract.js';
import { BRIEF_BINDING, BRIEF_CAPABILITY, BriefAdapter } from './brief.js';
import { CSV_BINDING, CSV_CAPABILITY, CsvAuditAdapter } from './csv-audit.js';
import type { CsvSnapshot } from './csv/csv-file.js';
import { adapterInvocation } from './atomic-adapter.js';

const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const completion = z.strictObject({ result: objectRefSchema });
type Prepared = Extract<Preparation, { kind: 'ready' }>;

/** Independent local services share their receipt plumbing, never a business
 * workflow. Every source read and artifact action is explicitly model-selected. */
export class LocalArtifactProgram implements AgentProgram {
  readonly ref; readonly configurationDigest: string; readonly actionIds: string[];
  readonly completionSchema = z.toJSONSchema(completion); readonly guidance: string;
  private readonly adapter: ExecutionAdapter;
  private readonly scopeType: 'BriefTask' | 'CsvAuditTask';
  constructor(private kind: 'brief' | 'csv', directory?: string) {
    if (kind === 'csv' && !directory) throw new Error('CSV source requires its explicitly configured input directory');
    this.adapter = kind === 'brief' ? new BriefAdapter() : new CsvAuditAdapter(directory!);
    const original = kind === 'brief' ? BRIEF_CAPABILITY : CSV_CAPABILITY;
    this.ref = { id: `${original.ref.id}.atomic`, version: '1' };
    this.configurationDigest = digest({ program: this.ref, directory: directory ?? null, semantics: 'local-original-artifact-v1' });
    this.scopeType = kind === 'brief' ? 'BriefTask' : 'CsvAuditTask';
    this.actionIds = kind === 'brief' ? ['PrepareTaskBrief'] : ['ReadCsvAuditSource', 'AuditCsvSnapshot'];
    this.guidance = kind === 'brief' ? 'PrepareTaskBrief preserves the exact user goal and deliverable. Use this only when a brief itself is required; its underlying business execution remains not_started. Complete by reading the accepted TaskBrief.'
      : 'ReadCsvAuditSource reads a bounded user file from the configured local directory and freezes all five registered checks. AuditCsvSnapshot is a separate explicit local action using the accepted CsvSnapshot reference. Read that object and use its literal reference, with no deferred input links, so exact local simulated approval can bind the original bytes and terms. This is never real payment. The host independently checks both report formats against the frozen bytes. Complete by reading the accepted CsvAuditReport; subset audits and silent extra file access are unsupported.';
  }
  permitted(owner: string) { return this.kind === 'brief' || this.adapter.permitted(owner); }
  capability(): ServiceCapability {
    const original = this.kind === 'brief' ? BRIEF_CAPABILITY : CSV_CAPABILITY;
    const predicates = this.kind === 'brief' ? ['brief.json'] : original.predicates.map(value => value.id);
    return { ...original, actions: [...original.actions, ...this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: id === 'ReadCsvAuditSource' ? 'read' as const : 'local' as const }))],
      goalOutcomes: predicates.map(predicate => ({ predicate, phase: 'artifact' as const, description: this.kind === 'brief' ? 'Exact task brief only; underlying execution stays not_started' : 'Independently checked local file audit and its stated simulation boundary' })), outcomePredicates: predicates,
      effectConstraints: [{ predicate: this.kind === 'brief' ? 'execution.none' : 'payment.simulated_only', allowedEffects: ['read', 'local'] }] };
  }
  listingBinding() { const original = this.kind === 'brief' ? BRIEF_BINDING : CSV_BINDING; return { ...original, ref: { id: `${original.ref.id}.atomic`, version: '1' }, configurationDigest: this.configurationDigest }; }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown, component?: { id: string; scopeKey: string }) {
    if (!this.permitted(owner)) throw new DomainError('FORBIDDEN', 'Local source is unavailable to this owner');
    const input = (this.kind === 'brief' ? briefInputSchema : csvInputSchema).parse(raw), scope = { type: this.scopeType, id: `${request.id}:r${request.revision}:c${component?.scopeKey ?? digest(this.ref)}` };
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: this.scopeType, requestRevision: request.revision, input, configurationDigest: this.configurationDigest } }],
      links: [{ type: `${this.scopeType}Request`, from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  assertContext(ctx: AgentProgramContext) {
    const scope = ctx.graph.read(ctx.owner, ctx.state.scope);
    if (!this.permitted(ctx.owner) || scope.ref.type !== this.scopeType || !same(ctx.state.programRef, this.ref) || ctx.state.programDigest !== this.configurationDigest
      || scope.properties.configurationDigest !== this.configurationDigest || scope.properties.requestRevision !== ctx.request.revision || !same(scope.properties.input, ctx.state.input)) fail('Original local component or input changed');
  }
  schema(action: string): z.ZodType<Record<string, unknown>> { if (!this.actionIds.includes(action)) return fail('Action is outside this local component'); return localActionSchemas[action as keyof typeof localActionSchemas]; }
  definition(graph: OntologyObjectStore, action: string) { const definition = graph.model.action(action), operation = definition.read ?? definition.operation; if (!operation || !same(operation.inputSchema, z.toJSONSchema(this.schema(action)))) fail('Local action differs from its published contract'); return definition; }
  private source(ctx: AgentProgramContext, raw: unknown) {
    const object = objectRefSchema.parse(raw), view = ctx.graph.readPrivate(ctx.owner, object), snapshot = csvSourceSchema.parse(view.properties.snapshot);
    const intent = ctx.intents?.find(value => value.id === snapshot.intentId && value.state === 'effect_confirmed' && same(value.acceptedOutput?.object, object));
    const prepared = intent?.lastVerifiedResult?.output?.source as Prepared | undefined;
    if (this.kind !== 'csv' || object.type !== 'CsvSnapshot' || !intent || !prepared || !same(snapshot.scope, ctx.state.scope) || snapshot.configurationDigest !== this.configurationDigest || !same(prepared.input, ctx.state.input)
      || snapshot.inputSha256 !== (prepared.privateData as CsvSnapshot).sha256 || Date.parse(snapshot.expiresAt) <= Date.now()) fail('CSV source is stale or not this accepted original file');
    return { object, snapshot, prepared, intent };
  }
  validate(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    this.assertContext(ctx); const parsed = this.schema(action).parse(input);
    if (!same(parsed.scope, ctx.state.scope)) fail('Local action uses another component scope');
    if (action === 'AuditCsvSnapshot') this.source(ctx, parsed.source);
  }
  privateInput(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) { return action === 'AuditCsvSnapshot' ? this.source(ctx, input.source).prepared.privateData : {}; }
  simulatedApproval(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) { if (action !== 'AuditCsvSnapshot') return; const source = this.source(ctx, input.source); return { amount: source.snapshot.approval.amount, expiresAt: source.snapshot.expiresAt }; }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    const prepared = action === 'AuditCsvSnapshot' ? this.source(ctx, input.source).prepared : await this.adapter.prepare(ctx, ctx.state.input, signal);
    if (prepared.kind !== 'ready') throw new AgentOperationRejected(prepared.kind === 'needs_input' ? prepared.question : prepared.reason, []);
    if (action === 'ReadCsvAuditSource') { const { recipe: _recipe, ...value } = prepared; return { value, evidenceRefs: value.evidenceRefs }; }
    const legacyAction = (this.kind === 'brief' ? BRIEF_CAPABILITY : CSV_CAPABILITY).actions[0]!.ref;
    const plan = adapterInvocation(ctx, ctx.intentId, this.listingBinding(), legacyAction, ctx.state.input, prepared.details), data = action === 'AuditCsvSnapshot' ? ctx.execution!.intent.privateData : prepared.privateData;
    ctx.assertDispatchAllowed?.();
    const delivery = await this.adapter.execute(ctx, plan, data, signal);
    if (!this.adapter.verify(ctx, plan, data, delivery).accepted) fail('Local artifact failed its original independent verifier');
    return { value: delivery, evidenceRefs: delivery.evidenceRefs };
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult) {
    const type = action === 'PrepareTaskBrief' ? 'TaskBrief' : action === 'ReadCsvAuditSource' ? 'CsvSnapshot' : 'CsvAuditReport', object = { type, id: digest({ request: ctx.request.id, intent: ctx.intentId, attempt: ctx.attemptId }) };
    const at = new Date().toISOString();
    let properties: Record<string, unknown> = { id: object.id, displayTitle: type, requestRevision: ctx.request.revision };
    if (type === 'CsvSnapshot') {
      const prepared = result.value as Prepared, snapshot = prepared.privateData as CsvSnapshot;
      properties = { ...properties, snapshot: csvSourceSchema.parse({ configurationDigest: this.configurationDigest, scope: ctx.state.scope, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId,
        fileName: snapshot.fileName, inputSha256: snapshot.sha256, byteLength: snapshot.byteLength, rowCount: snapshot.rowCount, observedAt: prepared.observedAt, expiresAt: prepared.expiresAt, evidenceRefs: result.evidenceRefs, approval: prepared.authorization }) };
    } else {
      const delivery = result.value as Delivery, full = JSON.stringify(delivery.artifact.data), preview = full.slice(0, 6000);
      properties.receipt = localReceiptSchema.parse({ configurationDigest: this.configurationDigest, scope: ctx.state.scope, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, inputDigest: digest(input), observedAt: at, evidenceRefs: result.evidenceRefs, deliveryDigest: digest(delivery), artifactName: delivery.artifact.name, preview, previewComplete: preview === full });
    }
    const links = [{ type: `${type}Request`, from: object, to: { type: 'ServiceRequest', id: ctx.request.id } }, { type: `${type}Scope`, from: object, to: ctx.state.scope },
      ...(type === 'CsvAuditReport' ? [{ type: 'CsvReportSource', from: object, to: objectRefSchema.parse(input.source) }] : [])];
    ctx.graph.ingest(ctx.owner, { objects: [{ ref: object, properties }], links }, { kind: type === 'CsvSnapshot' ? 'user' : 'task', id: ctx.intentId, observedAt: at });
    return object;
  }
  projectOutputs(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef) {
    const prepared = action === 'ReadCsvAuditSource' ? result.value as Prepared : undefined;
    return { values: { result: object, citations: [object] }, evidence: { origin: prepared ? 'user' as const : 'managed' as const, refs: result.evidenceRefs, observedAt: ctx.graph.read(ctx.owner, object).source.observedAt, ...(prepared ? { expiresAt: prepared.expiresAt } : {}) } };
  }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    this.assertContext(ctx); const result = completion.parse(raw).result, expectedType = this.kind === 'brief' ? 'TaskBrief' : 'CsvAuditReport';
    if (result.type !== expectedType || !(reads.deliveredObjects ?? reads.objects).some(value => same(value.ref, result))) fail('Read the exact local result before completion');
    const view = ctx.graph.read(ctx.owner, result), receipt = localReceiptSchema.parse(view.properties.receipt);
    const intent = ctx.intents?.find(value => value.id === receipt.intentId && value.state === 'effect_confirmed' && same(value.acceptedOutput?.object, result)) ?? fail('No accepted local artifact operation');
    const delivery = intent.lastVerifiedResult?.output?.source as Delivery;
    if (receipt.deliveryDigest !== digest(delivery) || receipt.configurationDigest !== this.configurationDigest || !same(receipt.scope, ctx.state.scope)) fail('Local artifact differs from its original source receipt');
    const step = ctx.state.plans.flatMap(plan => plan.steps).find(value => value.intentId === intent.id)!;
    const source = this.kind === 'csv' ? this.source(ctx, step.input.source) : undefined;
    const plan = adapterInvocation(ctx, intent.id, this.listingBinding(), (this.kind === 'brief' ? BRIEF_CAPABILITY : CSV_CAPABILITY).actions[0]!.ref, ctx.state.input, source?.prepared.details ?? { underlyingExecution: 'not_started' });
    if (!this.adapter.verify(ctx, plan, intent.privateData, delivery).accepted) fail('Independent local readback did not accept the original artifact');
    return { ...delivery, ...(source ? { consumedPorts: [(source.intent.acceptedOutput!.ports as AcceptedPortValue[]).find(port => port.port === 'result')!.digest] } : {}) };
  }
}
