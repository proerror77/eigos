import { isPersonalAction } from '../ontology/personal-context.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentActionContext, AgentActionResult, AgentProgram, AgentProgramContext } from '../core/agent-program.js';
import type { Delivery } from '../core/catalog.js';
import type { OntologyReleaseRef } from '../ontology/definition-contracts.js';
import type { ServiceCapability, ServiceRequest } from '../ontology/execution.js';
import { nameSchema, objectRefSchema, type ObjectRef, type OntologyModel } from '../ontology/model.js';
import { compileJsonSchema } from '../ontology/model-compiler.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import { applyDeclarativeAction, previewDeclarativeAction, type ManagedActionPreview } from '../ontology/declarative-actions.js';
import { readManagedResultFacts, mergeManagedResultFacts } from '../ontology/managed-result-facts.js';
import type { ManagedResultFact } from '../ontology/action-dsl.js';
import { checkRequirements } from '../ontology/requirement-checks.js';
import { stepBindingRef, stepInputDigest } from '../core/composed-actions.js';

const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const taskInputSchema = z.strictObject({
  actionIds: z.array(nameSchema).min(1).max(64).describe('Exact published declarative Action IDs needed for this task; discover them from the current Ontology.'),
  objects: z.array(objectRefSchema).max(64).optional().describe('Only already-existing owned objects to read as task context. For a pure creation use an empty array or omit this field. A future object ID belongs in the later create Action arguments, never in this existing-object context list.'),
});
function inputError(path: (string | number)[], message: string): never { throw new z.ZodError([{ code: 'custom', path, message }]); }
const completionSchema = z.strictObject({ intentIds: z.array(z.string().min(1).max(200)).min(1).max(64), rationale: z.string().max(2000).optional() });
interface ManagedInvocationResult {
  version: '1'; requestId: string; requestRevision: number; planId: string; intentId: string; attemptId: string;
  programDigest: string; preview: ManagedActionPreview;
}

/** One engine binding serves all declarative Action definitions in an immutable release. */
export class DynamicOntologyProgram implements AgentProgram {
  readonly callerManagedActions = true;
  readonly ref;
  readonly configurationDigest: string;
  readonly actionIds: string[];
  readonly completionSchema = z.toJSONSchema(completionSchema);
  readonly guidance = 'Discover the managed object and action definitions in this pinned ontology release. Read the current request specification and every relevant target before selecting an action. Action input schemas and executable conditions are authoritative. A data mutation requires an exact object_write grant for its preview; model publication never grants execution authority. Use current revisions from object reads. Creating an internal request or relation does not reserve a real service or establish payment or fulfillment. Complete using the confirmed Intent IDs returned by these data actions; the host independently reads back all changed objects and links.';
  constructor(readonly model: OntologyModel, readonly releaseRef: OntologyReleaseRef, private readonly allowed: string | ((owner: string) => boolean)) {
    this.ref = { id: `ontology.managed.${releaseRef.ontologyId}`, version: releaseRef.digest };
    this.actionIds = model.actionDefinitions().filter(action => model.actionImplementation(action.id)?.kind === 'declarative').map(action => action.id).sort();
    this.configurationDigest = digest({ engine: 'eigos.declarative-actions@1', releaseRef, modelDigest: model.ref.digest, actionIds: this.actionIds });
  }
  permitted(owner: string): boolean { return (typeof this.allowed === 'string' ? owner === this.allowed : this.allowed(owner)) && this.actionIds.length > 0; }
  capability(): ServiceCapability {
    return {
      ref: this.ref, ontologyRef: { id: this.releaseRef.ontologyId, version: this.releaseRef.digest }, name: '本体内受管数据操作',
      description: '根据已发布 Action 定义发现、比较并创建、更新或逻辑删除本人受管对象及关系。发现仅覆盖获准的本体内受管输入，记录中的金额、日期等条件须按原请求与动作规则核验。每次变更先预览并取得准确授权；只交付内部记录及回读，不执行订单、付款或供应商操作。',
      tags: ['ontology', 'managed-data', 'dynamic-actions'], environment: 'local', completion: 'artifact', inputSchema: z.toJSONSchema(taskInputSchema.extend({
        actionIds: z.array(z.enum(this.actionIds)).min(1).max(64).describe('Exact published Actions available in this pinned program. Select only the actions needed for the user goal; inspect their contracts by exact ID before resolving.'),
      })),
      ontology: { release: this.releaseRef, actions: this.actionIds, execution: 'declarative_managed_data' },
      actions: this.actionIds.map(id => ({ ref: { id, version: this.model.action(id).version ?? '1' }, effect: 'object_write' as const })),
      requirementRoles: [...new Map(this.actionIds.flatMap(id => {
        const implementation = this.model.actionImplementation(id);
        return implementation?.kind === 'declarative' ? (implementation.resultFacts ?? []).flatMap(fact => fact.role ? [{ kind: fact.kind, role: fact.role, description: `Managed result ${fact.kind} from ${fact.amountProperty}` }] : []) : [];
      }).map(role => [`${role.kind}:${role.role}`, role])).values()],
      predicates: [{ id: 'ontology.managed_data_readback', description: '已授权变更与原 Intent、对象版本及关系回读相符' }], outcomePredicates: ['ontology.managed_data_readback'],
      goalOutcomes: [{ predicate: 'ontology.managed_data_readback', phase: 'artifact', description: 'Committed internal records and independently checked readback; no external business fulfillment' }],
      verifierRef: { id: 'ontology.managed-data-readback', version: '1' },
    };
  }
  private graph(graph: OntologyObjectStore): void {
    if (!equal(graph.releaseRef, this.releaseRef) || graph.model.ref.digest !== this.model.ref.digest) fail('Managed program is pinned to a different ontology release');
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, value: unknown) {
    this.graph(graph);
    if (!this.permitted(owner)) throw new DomainError('FORBIDDEN', 'Managed program belongs to another owner');
    const input = taskInputSchema.parse(value);
    if (new Set(input.actionIds).size !== input.actionIds.length || input.actionIds.some(id => !this.actionIds.includes(id))) inputError(['actionIds'], 'Choose unique currently published declarative Action IDs from this ontology');
    for (const [index, ref] of (input.objects ?? []).entries()) {
      try { graph.read(owner, ref); }
      catch (error) {
        if (error instanceof DomainError && error.code === 'NOT_FOUND') inputError(['objects', index], 'Context references must already exist and belong to this owner. Query existing records first; for a pure creation use objects:[] and supply the new identity only in the later create Action arguments.');
        throw error;
      }
    }
    const specifications = graph.query(owner, { from: { type: 'ServiceRequest', id: request.id }, link: 'specifications', where: [{ property: 'requestRevision', op: 'eq', value: request.revision }], limit: 2 });
    if (specifications.page.hasMore || specifications.items.length !== 1) fail('Managed task requires its exact immutable request specification');
    return { scope: specifications.items[0]!.ref, input, managedActionIds: [...input.actionIds] };
  }
  contextRefs(ctx: AgentProgramContext): ObjectRef[] { return taskInputSchema.parse(ctx.state.input).objects ?? []; }
  private scope(ctx: AgentProgramContext) {
    this.graph(ctx.graph);
    if (!this.permitted(ctx.owner) || !equal(ctx.state.programRef, this.ref) || ctx.state.programDigest !== this.configurationDigest || ctx.state.requestRevision !== ctx.request.revision) fail('Managed task scope changed');
    const scope = ctx.graph.read(ctx.owner, ctx.state.scope), input = taskInputSchema.parse(ctx.state.input);
    const requests = ctx.graph.related(ctx.owner, scope.ref, 'request', { remaining: 1000 });
    if (scope.ref.type !== 'RequestSpecification' || scope.properties.requestRevision !== ctx.request.revision || requests?.length !== 1 || requests[0]!.ref.id !== ctx.request.id || input.actionIds.some(id => !this.actionIds.includes(id)) || !equal(ctx.state.managedActionIds, input.actionIds)) fail('Managed execution requires the current owned request specification');
    return input;
  }
  schema(actionId: string): z.ZodType<Record<string, unknown>> {
    if (!this.actionIds.includes(actionId)) throw new DomainError('FORBIDDEN', 'Action has no executable managed binding');
    const definition = this.model.action(actionId);
    if (!definition.inputSchema) fail('Managed action input schema is unavailable');
    return compileJsonSchema(definition.inputSchema) as z.ZodType<Record<string, unknown>>;
  }
  definition(graph: OntologyObjectStore, actionId: string) {
    this.graph(graph);
    if (!this.actionIds.includes(actionId)) throw new DomainError('FORBIDDEN', 'Action is not bound to this managed program');
    return graph.model.action(actionId);
  }
  validate(ctx: AgentProgramContext, actionId: string, input: Record<string, unknown>): void {
    if (!this.scope(ctx).actionIds.includes(actionId)) throw new DomainError('FORBIDDEN', 'Action is outside the approved task scope');
    this.definition(ctx.graph, actionId);
    const preview = previewDeclarativeAction(ctx.graph, ctx.owner, actionId, input), implementation = this.model.actionImplementation(actionId);
    const bindings = implementation?.kind === 'declarative' ? implementation.resultFacts : undefined;
    if (bindings) {
      const requirements = [...ctx.request.requirements, ...(ctx.request.successCriteria ?? [])].filter(requirement => bindings.some(binding => binding.kind === requirement.kind && binding.role === ('role' in requirement ? requirement.role : undefined)));
      const checks = checkRequirements({ ...ctx.request, requirements }, preview.resultFacts ?? {}, [preview.digest]);
      if (requirements.some(requirement => requirement.strength === 'hard' && !checks.some(check => check.requirementId === requirement.id && check.result === 'pass'))) fail('Managed result preview does not meet the fixed numeric requirements');
    }
  }
  validatePlanning(ctx: AgentProgramContext, actionId: string, input: Record<string, unknown>, reads: PlanningSnapshot): void {
    const preview = previewDeclarativeAction(ctx.graph, ctx.owner, actionId, input);
    if (reads.mode === 'trusted_template') return;
    for (const required of preview.reads) if (!(reads.deliveredObjects ?? reads.objects).some(object => equal(object.ref, required.ref) && object.revision === required.revision && object.propertiesDigest === required.propertiesDigest)) fail('Read each current action input and target before planning a managed mutation');
  }
  authority(ctx: AgentProgramContext, actionId: string, input: Record<string, unknown>) {
    this.validate(ctx, actionId, input);
    return { objectWrite: previewDeclarativeAction(ctx.graph, ctx.owner, actionId, input).scope };
  }
  async invoke(ctx: AgentActionContext, actionId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    signal.throwIfAborted(); this.validate(ctx, actionId, input);
    const value: ManagedInvocationResult = { version: '1', requestId: ctx.request.id, requestRevision: ctx.request.revision, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, programDigest: this.configurationDigest, preview: previewDeclarativeAction(ctx.graph, ctx.owner, actionId, input) };
    return { value, evidenceRefs: [ctx.intentId] };
  }
  project(ctx: AgentActionContext, actionId: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    this.scope(ctx);
    if (ctx.recovery) fail('Readback cannot apply a new managed mutation');
    const value = result.value as ManagedInvocationResult;
    if (!value || value.version !== '1' || value.requestId !== ctx.request.id || value.requestRevision !== ctx.request.revision || value.planId !== ctx.planId || value.intentId !== ctx.intentId || value.attemptId !== ctx.attemptId || value.programDigest !== this.configurationDigest || !equal(result.evidenceRefs, [ctx.intentId])) fail('Managed result differs from the exact invocation');
    const step = ctx.state.plans.find(plan => plan.id === ctx.planId)?.steps.find(step => step.intentId === ctx.intentId);
    if (!step?.objectWrite || step.action !== actionId || !equal(step.input, input)) fail('Managed action has no pinned nonfinancial authority');
    if (!ctx.assertDispatchAllowed) throw new DomainError('FORBIDDEN', 'Managed projection requires the current dispatch authority fence');
    ctx.assertDispatchAllowed();
    const applied = applyDeclarativeAction(ctx.graph, ctx.owner, actionId, input, value.preview, step.objectWrite, { kind: 'user', id: ctx.intentId, observedAt: new Date(ctx.graph.now()).toISOString() });
    return applied.result ?? { type: 'ServiceRequest', id: ctx.request.id };
  }
  async recover(ctx: AgentActionContext, _actionId: string, _input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult | undefined> {
    signal.throwIfAborted(); this.scope(ctx);
    const original = ctx.intents?.find(intent => intent.id === ctx.intentId && intent.jobId === ctx.request.id);
    const value = original?.lastVerifiedResult?.output?.source as ManagedInvocationResult | undefined;
    return original?.state === 'effect_confirmed' && value ? { value: structuredClone(value), evidenceRefs: [ctx.intentId] } : undefined;
  }
  projectOutputs(ctx: AgentActionContext, actionId: string, _input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef) {
    const value = result.value as ManagedInvocationResult, definition = this.definition(ctx.graph, actionId);
    return { values: { receipt: { intentId: ctx.intentId, actionId, previewDigest: value.preview.digest }, ...(definition.composition?.outputs.result ? { result: object } : {}) },
      evidence: { origin: 'managed' as const, refs: result.evidenceRefs, observedAt: new Date(ctx.graph.now()).toISOString() } };
  }
  complete(ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot): Delivery {
    this.scope(ctx);
    const completion = completionSchema.parse(proposal), confirmed = (ctx.intents ?? []).filter(intent => intent.effect === 'object_write' && intent.state === 'effect_confirmed');
    const ordered = new Map<string, { ordinal: number; plan: typeof ctx.state.plans[number]; step: typeof ctx.state.plans[number]['steps'][number] }>();
    const sequences = new Set<number>();
    for (const plan of [...ctx.state.plans].sort((a, b) => a.sequence - b.sequence)) {
      const { digest: planDigest, ...body } = plan;
      if (sequences.has(plan.sequence) || digest(body) !== planDigest || plan.requestId !== ctx.request.id || plan.requestRevision !== ctx.request.revision
        || !ctx.state.composition && (plan.programDigest !== this.configurationDigest || !equal(plan.programRef, this.ref))) fail('Managed completion requires an unambiguous sealed plan order');
      sequences.add(plan.sequence);
      for (const step of plan.steps.filter(step => step.effect === 'object_write' && (!ctx.state.composition || !!ctx.intents?.some(intent => intent.id === step.intentId)))) {
        if (ctx.state.composition && (!step.binding || !equal(step.binding.programRef, this.ref) || step.binding.configurationDigest !== this.configurationDigest)) fail('Managed step has another bound implementation');
        if (ordered.has(step.intentId)) fail('Managed completion repeats an Intent in its sealed plans');
        ordered.set(step.intentId, { ordinal: ordered.size, plan, step });
      }
    }
    for (const intent of confirmed) {
      const entry = ordered.get(intent.id);
      if (!entry || intent.jobId !== ctx.request.id || intent.planDigest !== entry.plan.digest || intent.stepId !== entry.step.id || !equal(intent.bindingRef, stepBindingRef(entry.plan, entry.step)) || intent.inputDigest !== stepInputDigest(entry.step)) fail('Managed Intent does not match its sealed plan and step');
    }
    confirmed.sort((a, b) => ordered.get(a.id)!.ordinal - ordered.get(b.id)!.ordinal);
    if (!confirmed.length || !equal([...completion.intentIds].sort(), confirmed.map(intent => intent.id).sort()) || new Set(completion.intentIds).size !== completion.intentIds.length) fail('Completion must account for every confirmed managed Intent');
    if ((ctx.intents ?? []).some(intent => intent.effect === 'object_write' && ['ready', 'dispatching', 'awaiting_remote', 'effect_unknown', 'needs_review'].includes(intent.state))) fail('Managed effects still require reconciliation');
    const finalObjects = new Map<string, ManagedActionPreview['objects'][number]>(), finalLinks = new Map<string, ManagedActionPreview['links'][number]>();
    const resultBindings = new Map<string, { ref: ObjectRef; bindings: ManagedResultFact[] }>();
    const changes = confirmed.map(intent => {
      const value = intent.lastVerifiedResult?.output?.source as ManagedInvocationResult | undefined;
      const entry = ordered.get(intent.id)!;
      if (!value || value.version !== '1' || value.intentId !== intent.id || value.planId !== entry.plan.id || value.requestId !== ctx.request.id || value.requestRevision !== ctx.request.revision || value.programDigest !== this.configurationDigest || value.preview.ontologyRelease.digest !== this.releaseRef.digest || value.preview.actionId !== entry.step.action || !equal(value.preview.scope, entry.step.objectWrite)) fail('Managed completion requires an original verified mutation record');
      for (const object of value.preview.objects) finalObjects.set(digest(object.ref), object);
      for (const link of value.preview.links) finalLinks.set(digest(link.link), link);
      const implementation = this.model.actionImplementation(value.preview.actionId);
      if (implementation?.kind === 'declarative' && implementation.resultFacts) {
        if (!value.preview.result || !value.preview.objects.some(object => equal(object.ref, value.preview.result) && object.operation !== 'tombstone')) fail('Verified result facts have no changed result object');
        resultBindings.set(digest(value.preview.result), { ref: value.preview.result, bindings: implementation.resultFacts });
      }
      return { intentId: intent.id, actionId: value.preview.actionId, previewDigest: value.preview.digest, objects: value.preview.objects, links: value.preview.links };
    });
    for (const change of finalObjects.values()) {
      if (change.operation === 'tombstone') {
        if (ctx.graph.managedObject(ctx.owner, change.ref) || ctx.graph.tombstone(ctx.owner, change.ref)?.revision !== change.expectedRevision! + 1) fail('Tombstone readback differs from the committed action');
      } else {
        const current = ctx.graph.read(ctx.owner, change.ref);
        if (!equal(current.properties, change.after) || current.revision !== (change.expectedRevision ?? 0) + 1) fail('Managed object changed after the committed action');
        if (reads.mode === 'model_queries' && !(reads.deliveredObjects ?? reads.objects).some(object => equal(object.ref, current.ref) && object.revision === current.revision)) fail('Completion requires current object readback');
      }
    }
    for (const change of finalLinks.values()) if (ctx.graph.containsLinks(ctx.owner, [change.link]) !== (change.operation === 'add')) fail('Managed relationship readback differs from the committed action');
    const resultFacts = mergeManagedResultFacts([...resultBindings.values()].filter(result => finalObjects.get(digest(result.ref))?.operation !== 'tombstone')
      .map(result => readManagedResultFacts(ctx.graph.read(ctx.owner, result.ref).properties, result.bindings)));
    const deliverable = '已完成并回读授权的本体受管数据变更。';
    return { artifact: { id: randomUUID(), name: 'ontology-action-result.json', data: { goal: ctx.request.originalGoal, deliverable, execution: 'completed', result: { ontologyRelease: this.releaseRef, managedChanges: changes, ...(changes.every(change => isPersonalAction(change.actionId)) ? { securityEvidenceRefs: [...finalObjects.values()].filter(change => change.operation !== 'tombstone').map(change => change.ref) } : {}), ...(completion.rationale ? { rationale: completion.rationale } : {}) } } }, facts: { ...resultFacts, conditions: ['ontology.managed_data_readback'] }, evidenceRefs: confirmed.map(intent => intent.id) };
  }
}

export function createDynamicOntologyProgram(graph: OntologyObjectStore, owner: string): DynamicOntologyProgram | undefined {
  if (!graph.releaseRef || !graph.model.actionDefinitions().some(action => graph.model.actionImplementation(action.id)?.kind === 'declarative')) return undefined;
  return new DynamicOntologyProgram(graph.model, graph.releaseRef, owner);
}
