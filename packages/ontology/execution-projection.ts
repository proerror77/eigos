import { digest, validPlanDigest } from '../core/delegation.js';
import { bindingDigest as providerBindingDigest } from '../core/catalog.js';
import { DomainError, type Job } from '../core/domain.js';
import type { AgentActionPlan, AgentExecutionState } from './agent-actions.js';
import type { ActionIntent, ActionResult, ExecutionAttempt } from './actions.js';
import { BACKEND_VERSION, FIXED_CANDIDATE_CONTEXT_PARAMETER, requirementSchema, type ActionType, type ConfirmedInputs, type ExecutionPlan, type FixedCandidateBinding, type ProviderBinding, type Ref, type ServiceRequest } from './execution.js';
import { executionProviderContractSchema, executionReferenceLink, executionSubmissionSchema, fixedCandidateBindingSchema, type ExecutionReferenceKind } from './execution-model.js';
import { readPreparedCapability, readPreparedResolution } from './capability-catalog.js';
import { objectRefSchema, type ActionDefinition, type ObjectRef } from './model.js';
import { linkSnapshotDigest, type LinkWrite, type ObjectSource, type ObjectView, type OntologyObjectStore } from './object-store.js';

export interface ExecutionObservation {
  id: string; intentId: string; attemptId: string; receivedAt: string; digest: string;
  applied: boolean; verified?: boolean; result: ActionResult;
}
export interface ExecutionLedger { intents: ActionIntent[]; attempts: ExecutionAttempt[]; observations: ExecutionObservation[] }
export interface ExecutionContextView {
  ref: ObjectRef; requestId: string; requestRevision: number; phase: string; state: string;
  programRef?: Ref; programDigest?: string; scope?: ObjectRef; observations: ObjectRef[];
  composition?: { goal: Pick<import('../core/goal-contract.js').GoalContract, 'digest' | 'criteria'>; components: { id: string; programRef: Ref; configurationDigest: string; scope: ObjectRef; digest: string; retired?: boolean }[]; assessment?: unknown };
  feedback: AgentExecutionState['feedback']; pendingPlanId?: string; actionIds: string[];
  history: { planCount: number; omittedPlanCount: number; olderPlanRefs: ObjectRef[] };
  unreadRefs: ObjectRef[];
  tombstonedRefs?: { ref: ObjectRef; revision: number; deletedAt: string }[];
  plans: { ref: ObjectRef; planId: string; planDigest: string; state: string; steps: {
    ref: ObjectRef; stepId: string; action: string; state: string; dependsOn: string[];
    inputRefs: { stepId: string; targetKey: string; port?: string }[]; acceptedInputs?: { intentId: string; port: string; targetKey: string }[]; inputDigest: string; output?: ObjectRef;
  }[] }[];
  objects: ObjectView[]; links: LinkWrite[];
}
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const key = (ref: ObjectRef) => JSON.stringify([ref.type, ref.id]);
const node = (type: string, identity: unknown): ObjectRef => ({ type, id: digest(identity) });
const root = (requestId: string): ObjectRef => ({ type: 'ServiceRequest', id: requestId });
const edge = (type: string, from: ObjectRef, to: ObjectRef): LinkWrite => ({ type, from, to });
const requestEdge = (ref: ObjectRef, requestId: string) => edge(`${ref.type}Request`, ref, root(requestId));
export const executionContextRef = (requestId: string, requestRevision: number): ObjectRef => node('ExecutionContext', { requestId, requestRevision });
export const executionPlanRef = (plan: { id: string; digest: string; requestId: string }): ObjectRef => node('ExecutionPlan', { requestId: plan.requestId, planId: plan.id, planDigest: plan.digest });
export const executionStepRef = (plan: { id: string; digest: string; requestId: string }, stepId: string): ObjectRef => node('ExecutionStep', { plan: executionPlanRef(plan), stepId });
const inputRef = (step: ObjectRef, parameter: string): ObjectRef => node('ExecutionInput', { step, parameter });
export const attemptRef = (requestId: string, attempt: ExecutionAttempt): ObjectRef => node('ExecutionAttempt', { requestId, planDigest: attempt.planDigest, attemptId: attempt.id });
export const resultRef = (requestId: string, attempt: ExecutionAttempt, observation: ExecutionObservation): ObjectRef => node('ExecutionResult', { requestId, planDigest: attempt.planDigest, attemptId: attempt.id, observationId: observation.id });
export const actionRef = (requestId: string, definition: ActionDefinition): ObjectRef => node('RegisteredActionType', { requestId, actionId: definition.id, definitionDigest: digest(definition) });
export const bindingRef = (requestId: string, state: Pick<AgentExecutionState, 'programRef' | 'programDigest' | 'scope' | 'requestRevision'>): ObjectRef =>
  node('ActionBinding', { requestId, requestRevision: state.requestRevision, programRef: state.programRef, programDigest: state.programDigest, scope: state.scope });
export const composedBindingRef = (step: AgentActionPlan['steps'][number]): ObjectRef => node('ActionBinding', { pin: step.binding!.digest, contextDigest: step.contextDigest });
const referenceEdge = (kind: ExecutionReferenceKind, from: ObjectRef, to: ObjectRef): LinkWrite => edge(executionReferenceLink(kind, to.type).id, from, to);

function readOptional(graph: OntologyObjectStore, owner: string, ref: ObjectRef): ObjectView | undefined {
  try { return graph.read(owner, ref); } catch (error) { if (error instanceof DomainError && error.code === 'NOT_FOUND') return; throw error; }
}
function related(graph: OntologyObjectStore, owner: string, from: ObjectRef, link: string, where?: { property: string; op: 'eq'; value: number | string }[]): ObjectView[] {
  const items: ObjectView[] = []; let cursor: string | undefined;
  do {
    const page = graph.query(owner, { from, link, limit: 50, where, ...(cursor ? { cursor } : {}) }, { remaining: 2000 });
    items.push(...page.items); cursor = page.page.cursor;
    if (items.length > 2000) fail('Execution graph exceeds the bounded read limit');
  } while (cursor);
  return items;
}
function write(graph: OntologyObjectStore, owner: string, ref: ObjectRef, properties: Record<string, unknown>, links: LinkWrite[], source: ObjectSource, removeLinks: LinkWrite[] = []): void {
  const previous = readOptional(graph, owner, ref), values: Record<string, unknown> = { [graph.model.object(ref.type).primaryKey]: ref.id, displayTitle: ref.type, ...properties };
  const mutable: Record<string, string[]> = {
    RequestInstruction: [], RequestConstraint: [],
    RegisteredActionType: [], ActionBinding: ['active'], ExecutionPlan: ['state'], ExecutionStep: ['state', 'acceptedOutput'],
    ExecutionInput: [], ExecutionAttempt: ['state'], ExecutionResult: ['verification', 'output'],
  };
  const omitted = mutable[ref.type];
  let linksVerified = false;
  if (previous && omitted) {
    const bindingIntent = ref.type === 'ExecutionStep' && previous.properties.intentId === undefined && typeof values.intentId === 'string';
    const immutable = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([name]) => !omitted.includes(name) && !(bindingIntent && name === 'intentId')));
    if (!same(immutable(previous.properties), immutable(values))) fail('Immutable execution graph data changed');
    const existingLinks = ref.type === 'ExecutionResult' && !previous.properties.output ? links.filter(link => !link.type.startsWith('ExecutionResultOutput')) : links;
    assertLinks(graph, owner, ref, existingLinks);
    linksVerified = existingLinks.length === links.length;
  }
  const unchanged = previous && same(previous.properties, values);
  if (unchanged && !removeLinks.length && links.every(link => link.from.type === ref.type && link.from.id === ref.id)) {
    // The sealed-property and relationship checks above still run for every
    // historical node. Avoid another import/cardinality pass only when nothing
    // can change. relationshipDigest excludes SourceReceipt edges, so types
    // that can carry those edges conservatively retain the normal import path.
    const excludesNoEdges = !graph.model.sides(ref.type).some(side => side.direction === 'forward' && graph.model.implements('SourceReceipt', side.other.type));
    if (excludesNoEdges && (linksVerified || graph.relationshipDigest(owner, ref, { remaining: 1000 }) === linkSnapshotDigest(ref, links))) return;
  }
  const objects = unchanged ? [] : [{ ref, properties: values, ...(previous ? { expectedRevision: previous.revision } : {}) }];
  graph.ingest(owner, { objects, links, removeLinks }, source);
}
function registered(graph: OntologyObjectStore, action: string): ActionDefinition | undefined {
  return graph.model.actionForOperation(action);
}
export function actionProperties(definition: ActionDefinition) {
  const managed = definition.implementation?.kind === 'declarative';
  return { contractKind: 'semantic_definition', actionId: definition.id, actionVersion: definition.version ?? definition.read?.version ?? definition.operation?.version ?? digest(definition), definitionDigest: digest(definition),
    description: definition.description, inputs: definition.inputs, ...((definition.read ?? definition.operation) ? { inputSchema: (definition.read ?? definition.operation)!.inputSchema, resultType: (definition.read ?? definition.operation)!.resultType } : managed ? { inputSchema: definition.inputSchema, resultType: definition.resultTypes?.[0] ?? 'ServiceRequest' } : {}),
    effect: definition.read?.effect ?? definition.operation?.effect ?? (managed ? 'object_write' : 'definition_only'), ...(definition.kind ? { kind: definition.kind } : {}),
    effects: definition.effects ?? (definition.read ? ['read'] : definition.operation ? [definition.operation.effect, ...(definition.operation.additionalEffects ?? [])] : []), resultTypes: definition.resultTypes ?? (definition.read ? [definition.read.resultType] : definition.operation ? [definition.operation.resultType] : []),
    changes: definition.changes, submissionCriteria: definition.submissionCriteria, ...(definition.composition ? { composition: definition.composition } : {}), execution: 'definition_only' };
}
function safeRequest(request: ServiceRequest): ServiceRequest {
  return { id: request.id, revision: request.revision, originalGoal: request.originalGoal,
    ...(request.requestedDeliverable !== undefined ? { requestedDeliverable: request.requestedDeliverable } : {}),
    ...(request.executionEnvironment ? { executionEnvironment: request.executionEnvironment } : {}),
    ...(request.outcome ? { outcome: request.outcome } : {}), ...(request.businessScopeId ? { businessScopeId: request.businessScopeId } : {}),
    requirements: structuredClone(request.requirements), successCriteria: structuredClone(request.successCriteria ?? []), conditions: structuredClone(request.conditions ?? []),
    confirmedInputs: Object.fromEntries(Object.entries(request.confirmedInputs ?? {}).map(([name, value]) => [name, { version: value.version, revision: value.revision, messageDigest: value.messageDigest, fields: structuredClone(value.fields), history: [] }])),
    messages: structuredClone(request.messages) };
}
function projectRequest(graph: OntologyObjectStore, owner: string, request: ServiceRequest, source: ObjectSource): void {
  const specification = node('RequestSpecification', { requestId: request.id, requestRevision: request.revision });
  const view = safeRequest(request), specificationProperties = { requestRevision: request.revision, requestDigest: digest(view), instructionCount: request.messages.length,
    assertionSnapshotVersion: '1', factCount: Object.values(request.confirmedInputs ?? {}).reduce((n, family) => n + Object.keys(family.fields).length, 0), conditionCount: request.conditions?.length ?? 0,
    factFamilies: Object.fromEntries(Object.entries(request.confirmedInputs ?? {}).map(([namespace, {version, revision, messageDigest}]) => [namespace, {version, revision, messageDigest}])),
    constraintCount: request.requirements.length + (request.successCriteria?.length ?? 0), confirmedInputDigests: Object.fromEntries(Object.entries(request.confirmedInputs ?? {}).map(([name, value]) => [name, value.messageDigest])),
    ...Object.fromEntries(['requestedDeliverable', 'executionEnvironment', 'outcome', 'businessScopeId'].filter(name => view[name as keyof ServiceRequest] !== undefined).map(name => [name, view[name as keyof ServiceRequest]])),
  };
  const specificationLinks = [requestEdge(specification, request.id)];
  const previousSpecification = readOptional(graph, owner, specification);
  const priorActiveConstraints = previousSpecification ? related(graph, owner, specification, 'constraints') : [];
  const instructions = new Map<string, ObjectRef>();
  for (const [sequence, message] of request.messages.entries()) {
    if (instructions.has(message.id)) fail('Request instructions require unique stable message identities');
    const ref = node('RequestInstruction', { requestId: request.id, messageId: message.id }), previous = readOptional(graph, owner, ref);
    instructions.set(message.id, ref); specificationLinks.push(edge('RequestSpecificationInstruction', specification, ref));
    write(graph, owner, ref, { introducedRevision: previous?.properties.introducedRevision ?? request.revision, messageId: message.id, sequence, text: message.text, receivedAt: message.receivedAt }, [requestEdge(ref, request.id)], source);
  }
  for (const [group, values] of [['requirement', request.requirements], ['success_criterion', request.successCriteria ?? []]] as const) for (const [sequence, requirement] of values.entries()) {
    const { provenance, ...body } = requirement; requirementSchema.parse(body);
    const ref = node('RequestConstraint', { requestId: request.id, group, requirement, sequence });
    specificationLinks.push(edge('RequestSpecificationConstraint', specification, ref));
    const previous = readOptional(graph, owner, ref);
    const predecessor = previous
      ? related(graph, owner, ref, 'supersedes')[0]
      : priorActiveConstraints.find(value => value.properties.requirementId === requirement.id && value.properties.group === group)
        ?? related(graph, owner, root(request.id), 'constraints', [{ property: 'requirementId', op: 'eq', value: requirement.id }, { property: 'group', op: 'eq', value: group }])
          .filter(value => Number(value.properties.introducedRevision) <= request.revision).sort((a, b) => Number(a.properties.introducedRevision) - Number(b.properties.introducedRevision)).at(-1);
    const links = [requestEdge(ref, request.id), ...(instructions.has(provenance.messageId) ? [edge('RequestConstraintInstruction', ref, instructions.get(provenance.messageId)!)] : []),
      ...(predecessor && !same(predecessor.ref, ref) ? [edge('RequestConstraintPredecessor', ref, predecessor.ref)] : [])];
    write(graph, owner, ref, { introducedRevision: previous?.properties.introducedRevision ?? request.revision, requirementId: requirement.id, sequence, group, kind: requirement.kind, strength: requirement.strength,
      ...('role' in requirement && requirement.role ? { role: requirement.role } : {}), expected: requirement.expected, provenance }, links, source);
  }
  for (const [namespace, family] of Object.entries(request.confirmedInputs ?? {})) for (const fact of Object.values(family.fields)) {
    const ref = node('RequestFact', { requestId: request.id, namespace, fact });
    const links = [edge('FactRequest', ref, root(request.id)), ...(instructions.has(fact.source.messageId) ? [edge('FactInstruction', ref, instructions.get(fact.source.messageId)!)] : [])];
    write(graph, owner, ref, { namespace, field: fact.field, status: fact.status, ...(fact.value !== undefined ? { value: fact.value } : {}), quote: fact.quote, source: fact.source, factRevision: fact.revision }, links, source);
    specificationLinks.push(edge('SpecificationFact', specification, ref));
  }
  for (const [sequence, condition] of (request.conditions ?? []).entries()) {
    const ref = node('RequestCondition', { requestId: request.id, condition, sequence });
    write(graph, owner, ref, { condition, sequence }, [edge('ConditionRequest', ref, root(request.id)), ...(instructions.has(condition.source.messageId) ? [edge('ConditionInstruction', ref, instructions.get(condition.source.messageId)!)] : [])], source);
    specificationLinks.push(edge('SpecificationCondition', specification, ref));
  }
  const removeLinks: LinkWrite[] = [];
  if (previousSpecification) for (const [name, type] of [['instructions', 'RequestSpecificationInstruction'], ['constraints', 'RequestSpecificationConstraint'], ['facts', 'SpecificationFact'], ['conditions', 'SpecificationCondition']] as const) {
    for (const previous of related(graph, owner, specification, name)) {
      const old = edge(type, specification, previous.ref); if (!specificationLinks.some(next => same(next, old))) removeLinks.push(old);
    }
  }
  write(graph, owner, specification, specificationProperties, specificationLinks, source, removeLinks);
}
/** Reconstruct the current safe request from typed graph records, never a Job JSON blob. */
export function readOntologyRequest(graph: OntologyObjectStore, owner: string, requestId: string): ServiceRequest {
  const request = graph.read(owner, root(requestId)), revision = Number(request.properties.revision);
  const filter = [{ property: 'requestRevision', op: 'eq' as const, value: revision }];
  const specs = related(graph, owner, request.ref, 'specifications', filter);
  if (specs.length !== 1) fail('Current request specification is missing or ambiguous');
  const specification = specs[0]!.properties;
  const instructions = related(graph, owner, specs[0]!.ref, 'instructions').sort((a, b) => Number(a.properties.sequence) - Number(b.properties.sequence));
  const constraints = related(graph, owner, specs[0]!.ref, 'constraints');
  if (instructions.length !== specification.instructionCount || constraints.length !== specification.constraintCount || instructions.some((item, i) => item.properties.sequence !== i)) fail('Current request graph is incomplete');
  const readConstraints = (group: string) => constraints.filter(item => item.properties.group === group).sort((a, b) => Number(a.properties.sequence) - Number(b.properties.sequence)).map((item, i) => {
    const p = item.properties; if (p.sequence !== i) fail('Constraint sequence is incomplete');
    return { ...requirementSchema.parse({ id: p.requirementId, kind: p.kind, ...(p.role ? { role: p.role } : {}), strength: p.strength, expected: p.expected }), provenance: structuredClone(p.provenance) as ServiceRequest['requirements'][number]['provenance'] };
  });
  let confirmed = request.properties.confirmedInputs as Record<string, Pick<ConfirmedInputs, 'version' | 'revision' | 'fields'>> | undefined;
  const inputDigests = specification.confirmedInputDigests as Record<string, string>;
  let conditions = structuredClone(request.properties.conditions ?? []) as ServiceRequest['conditions'];
  if (specification.assertionSnapshotVersion === '1') {
    const facts = related(graph, owner, specs[0]!.ref, 'facts'), assertions = related(graph, owner, specs[0]!.ref, 'conditions').sort((a, b) => Number(a.properties.sequence) - Number(b.properties.sequence));
    if (facts.length !== specification.factCount || assertions.length !== specification.conditionCount || assertions.some((item, i) => item.properties.sequence !== i)) fail('Request assertions are incomplete');
    const families = specification.factFamilies as Record<string, Pick<ConfirmedInputs, 'version' | 'revision' | 'messageDigest'>>;
    confirmed = Object.fromEntries(Object.entries(families).map(([namespace, metadata]) => [namespace, { ...metadata, fields: Object.fromEntries(facts.filter(fact => fact.properties.namespace === namespace).map(fact => {
      const p = fact.properties;
      return [String(p.field), { field: p.field, status: p.status, ...(p.value !== undefined ? {value: p.value} : {}), quote: p.quote, revision: p.factRevision, source: p.source } as ConfirmedInputs['fields'][string]];
    })) }]));
    conditions = assertions.map(item => item.properties.condition) as ServiceRequest['conditions'];
  }
  const view: ServiceRequest = { id: requestId, revision, originalGoal: String(request.properties.originalGoal),
    ...Object.fromEntries(['requestedDeliverable', 'executionEnvironment', 'outcome', 'businessScopeId'].filter(name => specification[name] !== undefined).map(name => [name, specification[name]])),
    requirements: readConstraints('requirement'), successCriteria: readConstraints('success_criterion'),
    conditions,
    confirmedInputs: Object.fromEntries(Object.entries(confirmed ?? {}).map(([name, value]) => [name, { ...structuredClone(value), messageDigest: inputDigests[name] ?? fail('Confirmed input provenance is missing'), history: [] }])),
    messages: instructions.map(({ properties: p }) => ({ id: String(p.messageId), text: String(p.text), receivedAt: String(p.receivedAt) })) };
  if (digest(safeRequest(view)) !== specification.requestDigest) fail('Current request graph differs from its sealed specification');
  return view;
}

interface StepShape {
  id: string; action: string; definitionDigest?: string; input: Record<string, unknown>;
  inputRefs: { stepId: string; targetKey: string; path?: string; port?: string }[]; dependsOn: string[]; intentId?: string; effect: string;
  acceptedInputs?: AgentActionPlan['steps'][number]['acceptedInputs']; acceptedInputSources?: AgentActionPlan['steps'][number]['acceptedInputSources'];
  binding?: ObjectRef; contract?: { ref: ObjectRef; properties: Record<string, unknown> };
  candidateBinding?: FixedCandidateBinding;
}
interface PlanShape {
  id: string; digest: string; requestId: string; requestRevision: number; kind: 'agent' | 'fixed'; sequence: number;
  createdAt: string; modelRunId?: string; steps: StepShape[]; binding?: ObjectRef; state: string;
}
function immutableStep(step: StepShape) {
  return { stepId: step.id, actionId: step.action, ...(step.definitionDigest ? { definitionDigest: step.definitionDigest } : {}),
    inputDigest: digest({ input: step.input, inputRefs: step.inputRefs, ...(step.acceptedInputs ? { acceptedInputs: step.acceptedInputs } : {}) }), ...(step.intentId ? { intentId: step.intentId } : {}), effect: step.effect,
    ...(step.binding ? { binding: step.binding } : {}), ...(step.contract ? { contract: step.contract.ref } : {}),
    dependsOn: step.dependsOn, inputs: inputValues(step) };
}
function inputValues(step: StepShape) {
  return [...Object.entries(step.input).map(([parameter, value]) => {
    const parsed = objectRefSchema.safeParse(value);
    return { parameter, sourceKind: parsed.success ? 'object' : 'literal', valueDigest: digest(value),
      valueType: parsed.success ? parsed.data.type : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, ...(parsed.success ? { object: parsed.data } : {}) };
  }), ...step.inputRefs.map(input => ({ parameter: input.targetKey, sourceKind: 'step_output', valueDigest: digest(input), valueType: 'output_reference',
    sourceStepId: input.stepId, ...(input.path ? { sourcePath: input.path } : {}), ...(input.port ? { sourcePort: input.port } : {}) })),
  ...(step.acceptedInputs ?? []).map(input => ({ parameter: input.targetKey, sourceKind: 'accepted_output', valueDigest: digest(input), valueType: 'accepted_named_output', sourceIntentId: input.intentId, sourcePort: input.port })),
  ...(step.candidateBinding ? [{ parameter: FIXED_CANDIDATE_CONTEXT_PARAMETER, sourceKind: 'candidate_context', valueDigest: digest(step.candidateBinding), valueType: step.candidateBinding.subject.ref.type,
    object: step.candidateBinding.subject.ref, candidateId: step.candidateBinding.candidateId, requestRevision: step.candidateBinding.requestRevision,
    objectRevision: step.candidateBinding.subject.revision, objectPropertiesDigest: step.candidateBinding.subject.propertiesDigest, objectLinksDigest: step.candidateBinding.subject.linksDigest }] : [])].sort((a, b) => a.parameter.localeCompare(b.parameter));
}
function planStructure(plan: PlanShape) {
  return { planId: plan.id, planDigest: plan.digest, requestId: plan.requestId, requestRevision: plan.requestRevision, kind: plan.kind,
    binding: plan.binding, steps: plan.steps.map(immutableStep) };
}
function planStatus(intents: (ActionIntent | undefined)[], pending: boolean, historical: boolean) {
  if (historical) return 'historical';
  if (intents.length && intents.every(i => i?.state === 'effect_confirmed')) return 'observed';
  if (intents.some(i => i && ['effect_unknown', 'needs_review'].includes(i.state))) return 'needs_review';
  if (intents.some(i => i && ['rejected', 'canceled_before_dispatch', 'canceled_after_dispatch'].includes(i.state))) return 'stopped';
  return pending ? 'pending' : 'recorded';
}
function agentShape(requestId: string, state: AgentExecutionState, plan: AgentActionPlan, ledger: ExecutionLedger, historical: boolean): PlanShape {
  return { id: plan.id, digest: plan.digest, requestId, requestRevision: plan.requestRevision, kind: 'agent', sequence: plan.sequence, createdAt: plan.createdAt,
    modelRunId: plan.modelRunId, binding: bindingRef(requestId, state),
    state: planStatus(plan.steps.map(step => ledger.intents.find(i => i.id === step.intentId && i.planDigest === plan.digest)), state.pendingPlanId === plan.id, historical),
    steps: plan.steps.map(step => ({ id: step.id, action: step.action, definitionDigest: step.definitionDigest, input: step.input, inputRefs: step.inputRefs, dependsOn: step.dependsOn, intentId: step.intentId, effect: step.effect,
      ...(step.binding ? { binding: composedBindingRef(step) } : {}), ...(step.acceptedInputs ? { acceptedInputs: step.acceptedInputs, acceptedInputSources: step.acceptedInputSources } : {}) })) };
}
function stepLinks(plan: PlanShape, step: StepShape, definition?: ActionDefinition): LinkWrite[] {
  const ref = executionStepRef(plan, step.id);
  const binding = step.binding ?? plan.binding, contract = step.contract?.ref ?? (definition ? actionRef(plan.requestId, definition) : undefined);
  return [requestEdge(ref, plan.requestId), edge('ExecutionStepPlan', ref, executionPlanRef(plan)),
    ...(binding ? [edge('ExecutionStepBinding', ref, binding)] : []),
    ...(contract ? [edge('ExecutionStepAction', ref, contract)] : []),
    ...step.dependsOn.map(id => edge('ExecutionStepDependency', ref, executionStepRef(plan, id)))];
}
function inputLinks(plan: PlanShape, step: StepShape, properties: ReturnType<typeof inputValues>[number]): LinkWrite[] {
  const stepRef = executionStepRef(plan, step.id), ref = inputRef(stepRef, properties.parameter);
  return [edge('ExecutionInputStep', ref, stepRef),
    ...('object' in properties && properties.object ? [referenceEdge('input', ref, properties.object)] : []),
    ...('sourceStepId' in properties ? [edge('ExecutionInputSource', ref, executionStepRef(plan, properties.sourceStepId))] : []),
    ...('sourceIntentId' in properties ? [edge('ExecutionInputSource', ref, step.acceptedInputSources?.find(source => source.targetKey === properties.parameter)?.sourceStep ?? fail('Accepted input has no sealed producing step'))] : [])];
}
function acceptedObject(intent: ActionIntent | undefined, requiresProjectedPointer = false): ObjectRef | undefined {
  if (intent?.state !== 'effect_confirmed') return;
  if (intent.ontologyOutput?.observationId === intent.latestObservationId) {
    const projected = objectRefSchema.safeParse(intent.ontologyOutput?.object);
    if (projected.success) return projected.data;
  }
  if (requiresProjectedPointer) return;
  const parsed = objectRefSchema.safeParse(intent.acceptedOutput?.object);
  return parsed.success ? parsed.data : undefined;
}
function normalizedAdapterAction(action: ActionType): ActionType {
  return { ref: action.ref, effect: action.effect, ...(action.additionalEffects?.length ? { additionalEffects: action.additionalEffects } : {}) };
}
function adapterContract(requestId: string, capabilityRef: Ref, raw: ActionType): NonNullable<StepShape['contract']> {
  const action = normalizedAdapterAction(raw), definitionDigest = digest({ capabilityRef, action });
  return { ref: node('RegisteredActionType', { requestId, contractKind: 'adapter_operation', capabilityRef, definitionDigest }),
    properties: { contractKind: 'adapter_operation', capabilityRef, actionId: action.ref.id, actionVersion: action.ref.version, definitionDigest,
      description: `Technical adapter operation declared by ${capabilityRef.id}@${capabilityRef.version}; no business semantics or permission is inferred.`,
      inputs: {}, effect: action.effect === 'read' && !action.additionalEffects?.length ? 'read' : 'definition_only',
      effects: [action.effect, ...(action.additionalEffects ?? [])], resultTypes: [], changes: [], submissionCriteria: [], execution: 'definition_only' } };
}
function providerContract(binding: ProviderBinding) {
  return executionProviderContractSchema.parse({ capabilityRef: binding.capabilityRef, providerId: binding.providerId, channelId: binding.channelId,
    ...(binding.merchantId ? { merchantId: binding.merchantId } : {}), adapterId: binding.adapterId, protocol: binding.protocol, enabled: binding.enabled,
    recovery: binding.recovery, verificationLevel: binding.verification.level });
}
export function fixedBindingRef(plan: ExecutionPlan, ref: Ref): ObjectRef | undefined {
  const pinned = plan.bindingDigests.find(binding => same(binding.ref, ref));
  return pinned ? node('ActionBinding', { requestId: plan.requestId, requestRevision: plan.requestRevision, planDigest: plan.digest, bindingRef: ref, bindingDigest: pinned.digest }) : undefined;
}
interface FixedGraphShape { shape: PlanShape; bindings: { ref: ObjectRef; properties: Record<string, unknown>; contracts: NonNullable<StepShape['contract']>[] }[] }
function fixedCandidateContext(graph: OntologyObjectStore, owner: string, plan: ExecutionPlan, fresh: boolean): FixedCandidateBinding | undefined {
  if (plan.candidateBinding === undefined) return;
  const parsed = fixedCandidateBindingSchema.safeParse(plan.candidateBinding);
  if (!parsed.success) return fail('Fixed candidate context does not match the sealed schema');
  if (!validPlanDigest(plan)) fail('Fixed candidate context is not sealed by this plan');
  const binding = parsed.data, selected = plan.ontologyPlanning.objects.filter(object => same(object.ref, binding.subject.ref));
  if (binding.requestId !== plan.requestId || binding.requestRevision !== plan.requestRevision || binding.candidateId !== plan.candidateId || selected.length !== 1 || !same(selected[0], binding.subject)) fail('Fixed candidate context differs from the sealed request or object snapshot');
  if (plan.steps.some(step => Object.hasOwn(step.input, FIXED_CANDIDATE_CONTEXT_PARAMETER) || step.inputRefs.some(input => input.targetKey === FIXED_CANDIDATE_CONTEXT_PARAMETER))) fail('Candidate context is not a provider payload parameter');
  const candidates = related(graph, owner, root(plan.requestId), 'preparedCandidates', [{ property: 'candidateId', op: 'eq', value: binding.candidateId }, { property: 'requestRevision', op: 'eq', value: binding.requestRevision }])
    .filter(candidate => candidate.properties.candidateDigest === binding.candidateDigest);
  if (candidates.length !== 1) fail('The exact sealed prepared candidate is missing or ambiguous');
  const candidate = candidates[0]!, p = candidate.properties;
  const { id: _id, name: _name, candidateId, requestRevision: _revision, sequence: _sequence, candidateDigest, ...fields } = p;
  if (digest({ ...fields, id: candidateId }) !== candidateDigest || !p.ontologySubject || !same(p.ontologySubject, binding.subject.ref) || p.status !== 'ready') fail('Sealed prepared candidate facts or subject changed');
  const roots = related(graph, owner, candidate.ref, 'request'), resolutions = related(graph, owner, candidate.ref, 'resolution');
  if (roots.length !== 1 || roots[0]!.ref.id !== plan.requestId || resolutions.length !== 1 || resolutions[0]!.properties.requestRevision !== plan.requestRevision) fail('Prepared candidate belongs to another task or revision');
  const resolutionRequests = related(graph, owner, resolutions[0]!.ref, 'request');
  if (resolutionRequests.length !== 1 || resolutionRequests[0]!.ref.id !== plan.requestId) fail('Prepared resolution belongs to another task');
  const expectedLink = graph.model.implements(binding.subject.ref.type, 'EvidenceBacked') ? 'subject' : binding.subject.ref.type === 'CheckoutRequest' ? 'checkoutRequirements' : undefined;
  if (!expectedLink) fail('Candidate business subject has no registered relationship');
  for (const name of ['subject', 'checkoutRequirements']) {
    const subjects = related(graph, owner, candidate.ref, name);
    if (name === expectedLink ? subjects.length !== 1 || !same(subjects[0]!.ref, binding.subject.ref) : subjects.length !== 0) fail('Prepared candidate business relationship differs from the sealed selection');
  }
  const subject = graph.read(owner, binding.subject.ref);
  if (subject.properties.requestRevision !== undefined && subject.properties.requestRevision !== binding.requestRevision) fail('Selected business object belongs to another request revision');
  if (graph.model.sides(subject.ref.type).some(side => side.side.name === 'request' && side.other.type === 'ServiceRequest')) {
    const requests = related(graph, owner, subject.ref, 'request');
    if (requests.length !== 1 || requests[0]!.ref.id !== plan.requestId) fail('Selected business object belongs to another task');
  }
  if (fresh && (subject.revision !== binding.subject.revision || digest(subject.properties) !== binding.subject.propertiesDigest || graph.relationshipDigest(owner, subject.ref, { remaining: 1000 }) !== binding.subject.linksDigest)) fail('Selected business object changed since the sealed plan');
  return binding;
}
function fixedGraphShape(graph: OntologyObjectStore, owner: string, plan: ExecutionPlan, sequence: number, createdAt: string, state: string, freshCandidate = false): FixedGraphShape {
  const candidateBinding = fixedCandidateContext(graph, owner, plan, freshCandidate);
  const prepared = readPreparedResolution(graph, owner, plan.requestId), capability = readPreparedCapability(graph, owner, plan.requestId);
  const bindings: FixedGraphShape['bindings'] = [];
  for (const pinned of plan.bindingDigests) {
    const ref = fixedBindingRef(plan, pinned.ref)!;
    let binding: ProviderBinding | undefined = [...plan.bindingSnapshots, ...(prepared?.candidates.map(candidate => candidate.binding) ?? [])]
      .find(candidate => same(candidate.ref, pinned.ref) && providerBindingDigest(candidate) === pinned.digest);
    // Historical plans retain their already-pinned public binding, even after a
    // different prepared resolution becomes current. Never fabricate metadata.
    if (!binding) {
      const old = readOptional(graph, owner, ref);
      if (old?.properties.kind === 'fixed_plan' && old.properties.providerContract) {
        const fields = executionProviderContractSchema.parse(old.properties.providerContract);
        const { verificationLevel, ...publicFields } = fields;
        const reconstructed: ProviderBinding = { ref: pinned.ref, ...publicFields,
          ...(old.properties.configurationDigest ? { configurationDigest: String(old.properties.configurationDigest) } : {}),
          verification: { level: verificationLevel, evidenceRefs: [] } };
        if (providerBindingDigest(reconstructed) === pinned.digest) binding = reconstructed;
      }
    }
    if (binding) bindings.push({ ref, contracts: [], properties: { requestRevision: plan.requestRevision, bindingRef: binding.ref, bindingDigest: pinned.digest,
      ...(binding.configurationDigest ? { configurationDigest: binding.configurationDigest } : {}), providerContract: providerContract(binding),
      kind: 'fixed_plan', actionIds: [], active: state !== 'historical', authorization: 'runtime_check_required' } });
  }
  const steps: StepShape[] = plan.steps.map(step => {
    const definition = registered(graph, step.actionTypeRef.id);
    let contract = definition ? { ref: actionRef(plan.requestId, definition), properties: actionProperties(definition) as Record<string, unknown> } : undefined;
    if (!contract) {
      const declared = capability && same(capability.ref, step.capabilityRef)
        ? capability.actions.find(action => same(action.ref, step.actionTypeRef)) : undefined;
      if (declared) contract = adapterContract(plan.requestId, step.capabilityRef, declared);
      else {
        const oldStep = readOptional(graph, owner, executionStepRef(plan, step.id));
        const old = oldStep ? related(graph, owner, oldStep.ref, 'actionType') : [];
        const value = old.length === 1 ? old[0] : undefined;
        if (value?.properties.contractKind === 'adapter_operation' && same(value.properties.capabilityRef, step.capabilityRef)
          && value.properties.actionId === step.actionTypeRef.id && value.properties.actionVersion === step.actionTypeRef.version) {
          const effects = value.properties.effects as ActionType['effect'][];
          if (effects.length) {
            const proposed = adapterContract(plan.requestId, step.capabilityRef, { ref: step.actionTypeRef, effect: effects[0]!, ...(effects.length > 1 ? { additionalEffects: effects.slice(1) } : {}) });
            if (same(value.ref, proposed.ref) && same(value.properties, { id: proposed.ref.id, displayTitle: proposed.ref.type, ...proposed.properties })) contract = proposed;
          }
        }
      }
    }
    if (contract && (!same([...(contract.properties.effects as string[])].sort(), [step.effect, ...(step.additionalEffects ?? [])].sort())
      || contract.properties.actionVersion !== step.actionTypeRef.version)) fail('Fixed execution action differs from its registered contract');
    const binding = bindings.find(value => same(value.properties.bindingRef, step.bindingRef));
    if (binding && contract && !binding.contracts.some(value => same(value.ref, contract!.ref))) binding.contracts.push(contract);
    return { id: step.id, action: step.actionTypeRef.id, ...(contract ? { definitionDigest: String(contract.properties.definitionDigest), contract } : {}),
      ...(binding ? { binding: binding.ref } : {}), ...(candidateBinding ? { candidateBinding } : {}), input: step.input, inputRefs: step.inputRefs, dependsOn: step.dependsOn, effect: step.effect };
  });
  for (const binding of bindings) binding.properties.actionIds = binding.contracts.map(contract => String(contract.properties.actionId));
  const primary = bindings.find(binding => same(binding.properties.bindingRef, plan.bindingRef));
  return { shape: { id: plan.id, digest: plan.digest, requestId: plan.requestId, requestRevision: plan.requestRevision, kind: 'fixed', sequence, createdAt, state,
    ...(primary ? { binding: primary.ref } : {}), steps }, bindings };
}
function projectPlan(graph: OntologyObjectStore, owner: string, plan: PlanShape, ledger: ExecutionLedger, source: ObjectSource): void {
  const ref = executionPlanRef(plan), context = executionContextRef(plan.requestId, plan.requestRevision);
  write(graph, owner, ref, { planId: plan.id, planDigest: plan.digest, requestRevision: plan.requestRevision, kind: plan.kind, sequence: plan.sequence, state: plan.state,
    structureDigest: digest(planStructure(plan)), createdAt: plan.createdAt, ...(plan.modelRunId ? { modelRunId: plan.modelRunId } : {}) },
  [requestEdge(ref, plan.requestId), edge('ExecutionPlanContext', ref, context), ...(plan.binding ? [edge('ExecutionPlanBinding', ref, plan.binding)] : [])], source);
  const seen = new Set<string>();
  for (const [sequence, step] of plan.steps.entries()) {
    if (seen.has(step.id) || step.dependsOn.some(id => !seen.has(id))) fail('Execution graph has duplicate or unordered dependencies');
    seen.add(step.id);
    const matchingIntents = ledger.intents.filter(i => i.planDigest === plan.digest && (step.intentId ? i.id === step.intentId : i.stepId === step.id));
    if (matchingIntents.length > 1 || matchingIntents.some(i => i.owner !== owner || i.jobId !== plan.requestId || i.stepId !== step.id)) fail('Execution graph intent binding is ambiguous or belongs to another task');
    const intent = matchingIntents[0];
    const definition = registered(graph, step.action), stepRef = executionStepRef(plan, step.id), output = acceptedObject(intent, plan.kind === 'fixed');
    const contract = step.contract ?? (definition ? { ref: actionRef(plan.requestId, definition), properties: actionProperties(definition) } : undefined);
    if (contract) write(graph, owner, contract.ref, contract.properties, [requestEdge(contract.ref, plan.requestId)], source);
    const shape = immutableStep(step);
    write(graph, owner, stepRef, { stepId: step.id, sequence, actionId: step.action, ...(step.definitionDigest ? { definitionDigest: step.definitionDigest } : {}),
      inputDigest: shape.inputDigest, ...(step.intentId ? { intentId: step.intentId } : intent ? { intentId: intent.id } : {}),
      planDigest: plan.digest, effect: step.effect, state: intent?.state ?? 'unprepared', structureDigest: digest(shape), ...(output ? { acceptedOutput: output } : {}) },
    stepLinks(plan, step, definition), source);
    for (const properties of inputValues(step)) write(graph, owner, inputRef(stepRef, properties.parameter), properties, inputLinks(plan, step, properties), source);
    if (!intent) continue;
    for (const attempt of ledger.attempts.filter(a => a.intentId === intent.id && a.planDigest === plan.digest)) {
      const attemptNode = attemptRef(plan.requestId, attempt), observations = ledger.observations.filter(o => o.intentId === intent.id && o.attemptId === attempt.id);
      const submission = attempt.submission ? executionSubmissionSchema.parse({
        action: attempt.submission.action, definitionDigest: attempt.submission.definitionDigest,
        ...(attempt.submission.subject ? { subject: attempt.submission.subject } : {}),
        checks: attempt.submission.checks.map(check => ({ criterion: check.criterion, result: check.result })),
        evidenceRefs: attempt.submission.evidenceRefs.map(ref => ({ type: ref.type, id: ref.id })),
      }) : undefined;
      write(graph, owner, attemptNode, { attemptId: attempt.id, intentId: attempt.intentId, planDigest: attempt.planDigest, ordinal: attempt.ordinal,
        requestRevision: plan.requestRevision, taskRevision: attempt.requestRevision, kind: attempt.kind, inputDigest: attempt.inputDigest, startedAt: attempt.startedAt,
        state: observations.some(o => o.applied) ? 'observed' : observations.length ? 'audit_only' : 'started', ...(submission ? { submission } : {}) }, [edge('ExecutionAttemptStep', attemptNode, stepRef), ...(attempt.authorizationId ? [edge('ExecutionAttemptAuthorization', attemptNode, { type: 'Authorization', id: attempt.authorizationId })] : [])], source);
      for (const observation of observations) {
        const result = resultRef(plan.requestId, attempt, observation);
        const oldResult = readOptional(graph, owner, result);
        const accepted = observation.applied && observation.verified !== false && observation.result.kind === 'confirmed'
          ? intent.latestObservationId === observation.id ? output : oldResult?.properties.output as ObjectRef | undefined : undefined;
        write(graph, owner, result, { resultId: observation.id, resultDigest: observation.digest, receivedAt: observation.receivedAt, kind: observation.result.kind,
          sourceVersion: observation.result.sourceVersion, applied: observation.applied, verification: observation.verified === undefined ? oldResult?.properties.verification ?? 'not_recorded' : observation.verified ? 'verified' : 'unverified',
          ...(accepted ? { output: accepted } : {}) },
        [edge('ExecutionResultAttempt', result, attemptNode), edge('ExecutionResultStep', result, stepRef), ...(accepted ? [referenceEdge('output', result, accepted)] : [])], source);
      }
    }
  }
}

/** Internal projection. The caller owns the business transaction shared with the task/intent ledger. */
export function projectExecution(graph: OntologyObjectStore, owner: string, job: Job, ledger: ExecutionLedger = { intents: [], attempts: [], observations: [] }): void {
  const delegation = job.delegation;
  if (job.service !== 'eigos.delegate' || delegation?.backendVersion !== BACKEND_VERSION) return;
  const request = delegation.request, source: ObjectSource = { kind: 'task', id: request.id, observedAt: job.updatedAt };
  graph.read(owner, root(request.id));
  projectRequest(graph, owner, request, source);
  const states = [...(delegation.agentHistory ?? []), ...(delegation.agent ? [delegation.agent] : [])];
  const revisions = new Set([request.revision, ...states.map(s => s.requestRevision), ...(delegation.planHistory ?? []).map(p => p.requestRevision), ...(delegation.plan ? [delegation.plan.requestRevision] : [])]);
  for (const revision of revisions) {
    const current = revision === request.revision ? delegation.agent : undefined, context = executionContextRef(request.id, revision), previous = readOptional(graph, owner, context);
    const links = [requestEdge(context, request.id), ...(current ? [referenceEdge('scope', context, current.scope), ...current.observations.map(ref => referenceEdge('observation', context, ref))] : [])];
    const oldScope = previous?.properties.scope as ObjectRef | undefined, oldObservations = (previous?.properties.observationOrder ?? []) as ObjectRef[];
    const removeLinks = [...(oldScope ? [referenceEdge('scope', context, oldScope)] : []), ...oldObservations.map(ref => referenceEdge('observation', context, ref))].filter(old => !links.some(next => same(old, next)));
    // Historical context keeps its old scope/observations; it is never returned as current.
    if (revision !== request.revision && previous) continue;
    write(graph, owner, context, { requestRevision: revision, phase: revision === request.revision ? delegation.phase : 'historical', state: revision === request.revision ? job.state : 'historical',
      ...(current ? { programRef: current.programRef, programDigest: current.programDigest, scope: current.scope, activeBinding: bindingRef(request.id, current),
        ...(current.composition ? { goal: { digest: current.composition.goal.digest, criteria: current.composition.goal.criteria }, components: current.composition.contexts.map(component => ({ id: component.id, programRef: component.programRef, configurationDigest: component.programDigest, scope: component.scope, digest: component.digest, ...(current.composition!.retiredContexts?.some(value => value.id === component.id) ? { retired: true } : {}) })),
          ...(current.composition.assessment ? { goalAssessment: { accepted: current.composition.assessment.accepted, criteria: current.composition.assessment.criteria, requirements: current.composition.assessment.requirements, conditions: current.composition.assessment.conditions } } : {}) } : {}),
        ...(current.pendingPlanId ? { pendingPlanId: current.pendingPlanId } : {}) } : {}),
      observationOrder: current?.observations ?? [], feedback: current?.feedback.slice(-20) ?? [] }, links, source, removeLinks);
  }
  for (const state of states) {
    const scope = graph.read(owner, state.scope);
    if (state.managedActionIds) {
      const release = graph.releaseRef, all = graph.model.actionDefinitions().filter(action => graph.model.actionImplementation(action.id)?.kind === 'declarative').map(action => action.id).sort();
      if (!release || state.programRef.id !== `ontology.managed.${release.ontologyId}` || state.programRef.version !== release.digest
        || state.programDigest !== digest({ engine: 'eigos.declarative-actions@1', releaseRef: release, modelDigest: graph.model.ref.digest, actionIds: all })
        || new Set(state.managedActionIds).size !== state.managedActionIds.length || !state.managedActionIds.length || state.managedActionIds.some(id => !all.includes(id))) fail('Managed action binding differs from its exact registered engine and release');
    }
    const candidates = state.managedActionIds ?? (Array.isArray(scope.properties.allowedActions) ? scope.properties.allowedActions as string[] : []);
    const definitions = candidates.map(id => registered(graph, id)).filter((value): value is ActionDefinition => !!value);
    for (const definition of definitions) write(graph, owner, actionRef(request.id, definition), actionProperties(definition), [requestEdge(actionRef(request.id, definition), request.id)], source);
    const binding = bindingRef(request.id, state), context = executionContextRef(request.id, state.requestRevision);
    write(graph, owner, binding, { requestRevision: state.requestRevision, bindingRef: state.programRef, configurationDigest: state.programDigest, kind: 'agent_program',
      actionIds: definitions.map(d => d.id), active: state === delegation.agent, authorization: 'runtime_check_required' },
    [requestEdge(binding, request.id), edge('ExecutionContextBinding', binding, context), ...definitions.map(d => edge('ExecutionBindingAction', binding, actionRef(request.id, d)))], source);
    for (const plan of state.plans) {
      for (const step of plan.steps.filter(step => !!step.binding)) {
        const pinned = step.binding!, ref = composedBindingRef(step), definition = graph.model.action(step.action);
        write(graph, owner, actionRef(request.id, definition), actionProperties(definition), [requestEdge(actionRef(request.id, definition), request.id)], source);
        write(graph, owner, ref, { requestRevision: plan.requestRevision, bindingRef: pinned.ref, configurationDigest: pinned.configurationDigest,
          bindingDigest: pinned.digest, kind: 'action', actionIds: [step.action], active: state === delegation.agent, authorization: 'runtime_check_required',
          ...(pinned.providerSnapshot ? { providerContract: providerContract(pinned.providerSnapshot) } : {}),
          programRef: pinned.programRef, contextId: step.contextId, contextDigest: step.contextDigest, scope: step.contextScope, definitionDigest: step.definitionDigest },
        [requestEdge(ref, request.id), edge('ExecutionContextBinding', ref, context), edge('ExecutionBindingAction', ref, actionRef(request.id, definition))], source);
      }
      projectPlan(graph, owner, agentShape(request.id, state, plan, ledger, state !== delegation.agent), ledger, source);
    }
  }
  // Fixed plans can be represented without inventing an executable definition or binding.
  for (const [sequence, plan] of [...(delegation.planHistory ?? []), ...(delegation.plan ? [delegation.plan] : [])].entries()) {
    const { shape, bindings } = fixedGraphShape(graph, owner, plan, sequence, job.createdAt, plan === delegation.plan ? delegation.phase : 'historical');
    for (const binding of bindings) {
      for (const contract of binding.contracts) write(graph, owner, contract.ref, contract.properties, [requestEdge(contract.ref, request.id)], source);
      write(graph, owner, binding.ref, binding.properties, [requestEdge(binding.ref, request.id),
        edge('ExecutionContextBinding', binding.ref, executionContextRef(request.id, plan.requestRevision)),
        ...binding.contracts.map(contract => edge('ExecutionBindingAction', binding.ref, contract.ref))], source);
    }
    projectPlan(graph, owner, shape, ledger, source);
  }
}

function assertLinks(graph: OntologyObjectStore, owner: string, ref: ObjectRef, links: LinkWrite[]): void {
  if (graph.relationshipDigest(owner, ref, { remaining: 1000 }) !== linkSnapshotDigest(ref, links)) fail('Execution graph relationships differ from the sealed plan');
}
/** Verify graph structure against a sealed plan before using any graph-derived invocation. */
export function assertAgentPlanProjection(graph: OntologyObjectStore, owner: string, plan: AgentActionPlan): void {
  const state = { programRef: plan.programRef, programDigest: plan.programDigest, scope: plan.scope, requestRevision: plan.requestRevision } as AgentExecutionState;
  const shape = agentShape(plan.requestId, { ...state, pendingPlanId: plan.id }, plan, { intents: [], attempts: [], observations: [] }, false);
  const ref = executionPlanRef(plan), view = graph.read(owner, ref);
  const expectedPlan = { id: ref.id, displayTitle: ref.type, planId: plan.id, planDigest: plan.digest, requestRevision: plan.requestRevision, kind: 'agent',
    sequence: plan.sequence, structureDigest: digest(planStructure(shape)), createdAt: plan.createdAt, modelRunId: plan.modelRunId };
  const { state: _state, ...actualPlan } = view.properties;
  if (!same(actualPlan, expectedPlan)) fail('Execution graph plan differs from the sealed plan');
  assertLinks(graph, owner, ref, [requestEdge(ref, plan.requestId), edge('ExecutionPlanContext', ref, executionContextRef(plan.requestId, plan.requestRevision)), edge('ExecutionPlanBinding', ref, shape.binding!)]);
  const binding = graph.read(owner, shape.binding!);
  if (!same(binding.properties.bindingRef, plan.programRef) || binding.properties.configurationDigest !== plan.programDigest || binding.properties.authorization !== 'runtime_check_required') fail('Execution graph binding changed');
  const steps = related(graph, owner, ref, 'steps');
  if (steps.length !== plan.steps.length) fail('Execution graph step count changed');
  for (const [sequence, step] of shape.steps.entries()) {
    const stepRef = executionStepRef(plan, step.id), actual = graph.read(owner, stepRef), definition = graph.model.action(step.action), immutable = immutableStep(step);
    if (digest(definition) !== step.definitionDigest || actual.properties.structureDigest !== digest(immutable) || actual.properties.sequence !== sequence
      || actual.properties.stepId !== step.id || actual.properties.actionId !== step.action || actual.properties.definitionDigest !== step.definitionDigest
      || actual.properties.inputDigest !== immutable.inputDigest || actual.properties.intentId !== step.intentId || actual.properties.planDigest !== plan.digest || actual.properties.effect !== step.effect) fail('Execution graph invocation differs from the sealed plan');
    assertLinks(graph, owner, stepRef, stepLinks(shape, step, definition));
    const sealed = plan.steps[sequence]!;
    if (sealed.binding) {
      const binding = graph.read(owner, composedBindingRef(sealed)), pin = sealed.binding;
      const { active: _active, ...actual } = binding.properties;
      if (!same(actual, { id: binding.ref.id, displayTitle: binding.ref.type, requestRevision: plan.requestRevision, bindingRef: pin.ref,
        configurationDigest: pin.configurationDigest, bindingDigest: pin.digest, kind: 'action', actionIds: [sealed.action], authorization: 'runtime_check_required',
        ...(pin.providerSnapshot ? { providerContract: providerContract(pin.providerSnapshot) } : {}),
        programRef: pin.programRef, contextId: sealed.contextId, contextDigest: sealed.contextDigest, scope: sealed.contextScope, definitionDigest: sealed.definitionDigest })) fail('Per-action graph binding differs from the sealed invocation');
      assertLinks(graph, owner, binding.ref, [requestEdge(binding.ref, plan.requestId), edge('ExecutionContextBinding', binding.ref, executionContextRef(plan.requestId, plan.requestRevision)), edge('ExecutionBindingAction', binding.ref, actionRef(plan.requestId, definition))]);
    }
    const action = graph.read(owner, actionRef(plan.requestId, definition));
    if (!same(action.properties, { id: action.ref.id, displayTitle: action.ref.type, ...actionProperties(definition) })) fail('Registered action graph differs from registry truth');
    const inputs = related(graph, owner, stepRef, 'inputs'), expectedInputs = inputValues(step);
    if (inputs.length !== expectedInputs.length) fail('Execution graph input count changed');
    for (const properties of expectedInputs) {
      const ref = inputRef(stepRef, properties.parameter), input = graph.read(owner, ref);
      if (!same(input.properties, { [graph.model.object(ref.type).primaryKey]: ref.id, displayTitle: ref.type, ...properties })) fail('Execution graph input differs from the sealed plan');
      assertLinks(graph, owner, ref, inputLinks(shape, step, properties));
    }
  }
}

/** Fixed plans pin provider metadata and adapter contracts separately from
 * semantic business definitions. Actual intent IDs come from the durable ledger. */
export function assertFixedPlanProjection(graph: OntologyObjectStore, owner: string, plan: ExecutionPlan, intents: readonly ActionIntent[]): void {
  const next = plan.steps.map(step => intents.find(intent => intent.planDigest === plan.digest && intent.stepId === step.id)).find(intent => intent?.state !== 'effect_confirmed');
  const { shape, bindings } = fixedGraphShape(graph, owner, plan, 0, '', 'current', next?.state === 'ready'), planRef = executionPlanRef(plan), actualPlan = graph.read(owner, planRef);
  if (!shape.binding || shape.steps.some(step => !step.binding || !step.contract)) fail('Fixed execution lacks a pinned binding or declared action contract');
  if (actualPlan.properties.planId !== plan.id || actualPlan.properties.planDigest !== plan.digest || actualPlan.properties.requestRevision !== plan.requestRevision
    || actualPlan.properties.kind !== 'fixed' || actualPlan.properties.structureDigest !== digest(planStructure(shape))) fail('Fixed execution graph plan differs from the sealed plan');
  assertLinks(graph, owner, planRef, [requestEdge(planRef, plan.requestId), edge('ExecutionPlanContext', planRef, executionContextRef(plan.requestId, plan.requestRevision)),
    edge('ExecutionPlanBinding', planRef, shape.binding!)]);
  for (const binding of bindings) {
    const actual = graph.read(owner, binding.ref), { active: _active, ...properties } = actual.properties;
    const { active: _expectedActive, ...expected } = binding.properties;
    if (!same(properties, { id: binding.ref.id, displayTitle: binding.ref.type, ...expected })) fail('Fixed execution provider binding changed');
    assertLinks(graph, owner, binding.ref, [requestEdge(binding.ref, plan.requestId), edge('ExecutionContextBinding', binding.ref, executionContextRef(plan.requestId, plan.requestRevision)),
      ...binding.contracts.map(contract => edge('ExecutionBindingAction', binding.ref, contract.ref))]);
  }
  if (related(graph, owner, planRef, 'steps').length !== shape.steps.length) fail('Fixed execution graph step count changed');
  for (const [sequence, step] of shape.steps.entries()) {
    const matching = intents.filter(intent => intent.planDigest === plan.digest && intent.stepId === step.id);
    if (matching.length !== 1 || matching[0]!.owner !== owner || matching[0]!.jobId !== plan.requestId) fail('Fixed execution intent is missing, ambiguous, or belongs to another task');
    const intent = matching[0]!, sealedStep = plan.steps[sequence]!;
    if (!same(intent.bindingRef, sealedStep.bindingRef) || intent.effect !== sealedStep.effect || intent.inputDigest !== digest({ input: sealedStep.input, inputRefs: sealedStep.inputRefs })) fail('Fixed execution intent differs from the sealed step');
    const ref = executionStepRef(plan, step.id), actual = graph.read(owner, ref), immutable = immutableStep(step);
    const { state: _state, acceptedOutput: _output, ...properties } = actual.properties;
    const expected = { id: ref.id, displayTitle: ref.type, stepId: step.id, sequence, actionId: step.action, definitionDigest: step.definitionDigest,
      inputDigest: immutable.inputDigest, intentId: intent.id, planDigest: plan.digest, effect: step.effect, structureDigest: digest(immutable) };
    if (!same(properties, expected)) fail('Fixed execution graph invocation differs from the sealed step');
    assertLinks(graph, owner, ref, stepLinks(shape, step));
    const contract = step.contract!, actualContract = graph.read(owner, contract.ref);
    if (!same(actualContract.properties, { id: contract.ref.id, displayTitle: contract.ref.type, ...contract.properties })) fail('Fixed execution action contract changed');
    assertLinks(graph, owner, contract.ref, [requestEdge(contract.ref, plan.requestId)]);
    const inputs = related(graph, owner, ref, 'inputs'), expectedInputs = inputValues(step);
    if (inputs.length !== expectedInputs.length) fail('Fixed execution graph input count changed');
    for (const properties of expectedInputs) {
      const input = inputRef(ref, properties.parameter), actualInput = graph.read(owner, input);
      if (!same(actualInput.properties, { id: input.id, displayTitle: input.type, ...properties })) fail('Fixed execution graph input changed');
      assertLinks(graph, owner, input, inputLinks(shape, step, properties));
    }
  }
}

/** Bounded public execution readback. Restricted source payloads are never read. */
export function readExecutionContext(graph: OntologyObjectStore, owner: string, requestId: string, requestRevision: number): ExecutionContextView | undefined {
  const rootView = graph.read(owner, root(requestId));
  if (rootView.properties.revision !== requestRevision) fail('Execution context belongs to a superseded request');
  const context = readOptional(graph, owner, executionContextRef(requestId, requestRevision)); if (!context) return;
  const objects = new Map<string, ObjectView>([[key(context.ref), context]]), links = new Map<string, LinkWrite>(), unread = new Map<string, ObjectRef>();
  const tombstoned = new Map<string, { ref: ObjectRef; revision: number; deletedAt: string }>();
  const add = (object: ObjectView) => {
    if (object.tombstone) tombstoned.set(key(object.ref), { ref: object.ref, ...object.tombstone });
    else objects.set(key(object.ref), object);
    return object;
  };
  const addLink = (link: LinkWrite) => { links.set(digest(link), link); };
  const traverse = (from: ObjectRef, name: string, select?: (values: ObjectView[]) => ObjectView[]) => {
    const nav = graph.model.navigation(from.type, name), all = related(graph, owner, from, name), values = select ? select(all) : all;
    for (const value of all) if (!values.some(item => same(item.ref, value.ref))) unread.set(key(value.ref), value.ref);
    for (const value of values) { add(value); addLink(nav.direction === 'forward' ? edge(nav.link.id, from, value.ref) : edge(nav.link.id, value.ref, from)); }
    return values;
  };
  const p = context.properties, scope = p.scope as ObjectRef | undefined, observations = p.observationOrder as ObjectRef[];
  assertLinks(graph, owner, context.ref, [requestEdge(context.ref, requestId), ...(scope ? [referenceEdge('scope', context.ref, scope)] : []),
    ...observations.map(ref => referenceEdge('observation', context.ref, ref))]);
  const linkedObject = (kind: ExecutionReferenceKind, from: ObjectRef, ref: ObjectRef) => {
    const values = traverse(from, executionReferenceLink(kind, ref.type).name);
    if (values.length !== 1 || !same(values[0]!.ref, ref)) fail('Execution object reference differs from its typed relationship');
  };
  addLink(requestEdge(context.ref, requestId));
  if (scope) { add(graph.read(owner, scope)); addLink(referenceEdge('scope', context.ref, scope)); }
  for (const ref of observations.slice(-12)) {
    const deleted = graph.model.objectWritePolicy(ref.type) === 'managed' ? graph.tombstone(owner, ref) : undefined;
    if (deleted) tombstoned.set(key(ref), deleted); else add(graph.read(owner, ref));
    addLink(referenceEdge('observation', context.ref, ref));
  }
  for (const ref of observations.slice(0, -12)) unread.set(key(ref), ref);
  const binding = p.activeBinding ? add(graph.read(owner, p.activeBinding as ObjectRef)) : undefined;
  if (binding) { addLink(edge('ExecutionContextBinding', binding.ref, context.ref)); traverse(binding.ref, 'actionTypes'); }
  const allPlans = related(graph, owner, context.ref, 'plans').sort((a, b) => Number(a.properties.sequence) - Number(b.properties.sequence));
  const pending = allPlans.find(plan => plan.properties.planId === p.pendingPlanId);
  const selectedPlans = pending ? [...allPlans.filter(plan => plan !== pending).slice(-1), pending] : allPlans.slice(-2);
  const olderPlans = allPlans.filter(plan => !selectedPlans.includes(plan));
  const plans = traverse(context.ref, 'plans', () => selectedPlans).sort((a, b) => Number(a.properties.sequence) - Number(b.properties.sequence)).map(plan => {
    const steps = traverse(plan.ref, 'steps').sort((a, b) => Number(a.properties.sequence) - Number(b.properties.sequence)).map(step => {
      const dependencies = traverse(step.ref, 'dependencies'), inputs = traverse(step.ref, 'inputs');
      for (const input of inputs) {
        if (input.properties.object) linkedObject('input', input.ref, input.properties.object as ObjectRef);
        if (input.properties.sourceStepId || input.properties.sourceIntentId) traverse(input.ref, 'sourceStep');
      }
      traverse(step.ref, 'actionType'); traverse(step.ref, 'binding');
      for (const attempt of traverse(step.ref, 'attempts', rows => rows.sort((a, b) => Number(a.properties.ordinal) - Number(b.properties.ordinal)).slice(-2))) for (const result of traverse(attempt.ref, 'results', rows => rows.sort((a, b) => String(a.properties.receivedAt).localeCompare(String(b.properties.receivedAt)) || a.ref.id.localeCompare(b.ref.id)).slice(-2))) {
        addLink(edge('ExecutionResultStep', result.ref, step.ref));
        if (result.properties.output) linkedObject('output', result.ref, result.properties.output as ObjectRef);
      }
      return { ref: step.ref, stepId: String(step.properties.stepId), action: String(step.properties.actionId), state: String(step.properties.state),
        dependsOn: dependencies.sort((a, b) => Number(a.properties.sequence) - Number(b.properties.sequence)).map(d => String(d.properties.stepId)),
        inputRefs: inputs.filter(i => i.properties.sourceKind === 'step_output').map(i => ({ stepId: String(i.properties.sourceStepId), targetKey: String(i.properties.parameter), ...(i.properties.sourcePort ? { port: String(i.properties.sourcePort) } : {}) })),
        ...(inputs.some(i => i.properties.sourceKind === 'accepted_output') ? { acceptedInputs: inputs.filter(i => i.properties.sourceKind === 'accepted_output').map(i => ({ intentId: String(i.properties.sourceIntentId), port: String(i.properties.sourcePort), targetKey: String(i.properties.parameter) })) } : {}),
        inputDigest: String(step.properties.inputDigest), ...(step.properties.acceptedOutput ? { output: step.properties.acceptedOutput as ObjectRef } : {}) };
    });
    return { ref: plan.ref, planId: String(plan.properties.planId), planDigest: String(plan.properties.planDigest), state: String(plan.properties.state), steps };
  });
  return { ref: context.ref, requestId, requestRevision, phase: String(p.phase), state: String(p.state),
    ...(p.programRef ? { programRef: p.programRef as Ref, programDigest: String(p.programDigest) } : {}), ...(scope ? { scope } : {}),
    ...(p.goal ? { composition: { goal: p.goal as NonNullable<ExecutionContextView['composition']>['goal'], components: p.components as NonNullable<ExecutionContextView['composition']>['components'], ...(p.goalAssessment ? { assessment: p.goalAssessment } : {}) } } : {}),
    observations, feedback: p.feedback as AgentExecutionState['feedback'], ...(p.pendingPlanId ? { pendingPlanId: String(p.pendingPlanId) } : {}),
    actionIds: (binding?.properties.actionIds ?? []) as string[], plans,
    history: { planCount: allPlans.length, omittedPlanCount: olderPlans.length, olderPlanRefs: olderPlans.map(plan => plan.ref) },
    unreadRefs: [...unread.values()].filter(ref => !objects.has(key(ref))),
    ...(tombstoned.size ? { tombstonedRefs: [...tombstoned.values()] } : {}),
    objects: [...objects.values()], links: [...links.values()] };
}
