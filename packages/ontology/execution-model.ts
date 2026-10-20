import { z } from 'zod';
import { objectRefSchema, type ActionDefinition, type InterfaceDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import { refSchema } from './execution.js';

const text = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/), time = z.iso.datetime({ offset: true });
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, required = true): PropertyDefinition =>
  ({ kind, schema, description, required, source: 'Authenticated request or sealed execution ledger; never provider authority' });
const s = (description: string, max = 200, required = true) => p('string', z.string().min(1).max(max), description, required);
const integer = (description: string) => p('integer', z.number().int().nonnegative(), description);
const hash = (description: string) => p('string', sha, description);
const bool = (description: string) => p('boolean', z.boolean(), description);
const ref = (description: string, required = true) => p('struct', refSchema, description, required);
const objectRef = (description: string, required = true) => p('struct', objectRefSchema, description, required);
const strings = (description: string, max = 128) => p('array', z.array(text).max(max), description);
const type = (id: string, description: string, properties: Record<string, PropertyDefinition>): ObjectTypeDefinition => ({
  id, version: '1', name: id, aliases: [id], description, primaryKey: 'id', titleKey: 'displayTitle',
  properties: { id: s('Scoped immutable identity'), displayTitle: s('Safe record label', 500), ...properties },
});
const requestRevision = integer('Owning business request revision');
const intentState = z.enum(['unprepared', 'ready', 'dispatching', 'awaiting_remote', 'effect_unknown', 'effect_confirmed', 'rejected', 'canceled_before_dispatch', 'canceled_after_dispatch', 'needs_review']);
export const executionFeedbackSchema = z.strictObject({
  at: time, kind: z.enum(['validation', 'action', 'completion', 'runtime']), message: z.string().min(1).max(4000), inputDigest: sha,
});
export const executionSubmissionSchema = z.strictObject({
  action: text, definitionDigest: sha, subject: objectRefSchema.optional(),
  checks: z.array(z.strictObject({ criterion: text, result: z.literal('pass') })).max(64),
  evidenceRefs: z.array(objectRefSchema).max(200),
});
export const executionProviderContractSchema = z.strictObject({
  capabilityRef: refSchema, providerId: text, channelId: text, merchantId: text.optional(), adapterId: text,
  protocol: z.enum(['local', 'http', 'mcp', 'a2a', 'browser']), enabled: z.boolean(),
  recovery: z.strictObject({ idempotency: z.enum(['none', 'provider_key', 'provider_reference']), lookup: z.boolean() }),
  verificationLevel: z.enum(['local_test', 'read_only_probe', 'simulated', 'live_fulfillment']),
});
export const executionObjects: ObjectTypeDefinition[] = [
  type('RequestSpecification', 'Current request specification. Instructions and constraints are separate typed records.', {
    requestRevision, requestDigest: hash('Digest of the current safe request view'), instructionCount: integer('Exact number of instructions'),
    constraintCount: integer('Exact number of active requirements and success criteria'),
    requestedDeliverable: s('Explicit requested deliverable', 10000, false),
    executionEnvironment: p('string', z.enum(['live', 'sandbox']), 'Explicit execution environment, not authorization', false),
    outcome: p('string', z.enum(['refund', 'cancel']), 'Explicit remedy outcome', false), businessScopeId: s('Business scope identity', 200, false),
    confirmedInputDigests: p('struct', z.record(z.string(), sha), 'Source message digest for each current confirmed-input family'),
  }),
  type('RequestInstruction', 'One exact authenticated owner instruction with its original order and timestamp.', {
    introducedRevision: integer('First request revision in which this instruction was recorded in Ontology'), messageId: s('Original message identity'), sequence: integer('Original instruction order'),
    text: s('Exact authenticated instruction', 10000), receivedAt: p('timestamp', time, 'Original receipt time'),
  }),
  type('RequestConstraint', 'An immutable requirement assertion, not a new business entity. Unchanged assertions are reused across specifications; requirementId and supersedes retain correction lineage.', {
    introducedRevision: integer('First request revision containing this exact assertion'), requirementId: s('Original requirement identity'), sequence: integer('Order in its constraint group'),
    group: p('string', z.enum(['requirement', 'success_criterion']), 'Precondition requirement or requested result criterion'),
    kind: p('string', z.enum(['quantity', 'budget', 'deadline', 'location', 'condition']), 'Registered requirement kind'),
    role: s('Declared business role', 100, false), strength: p('string', z.enum(['hard', 'preference']), 'Required or preferred'),
    expected: p('struct', z.record(z.string(), z.unknown()), 'Typed expected value; interpreted according to kind'),
    provenance: p('struct', z.strictObject({ source: z.literal('pa'), interpretation: z.enum(['structured', 'quoted_text']), messageId: text, receivedAt: time, quote: z.string().max(10000).optional() }), 'Authenticated source and exact quote'),
  }),
  type('RegisteredActionType', 'A task-local snapshot of registered action semantics. A definition grants no execution or source permission.', {
    contractKind: p('string', z.enum(['semantic_definition', 'adapter_operation']), 'Registered business semantics or an explicitly declared technical adapter operation'),
    actionId: s('Registered action identifier'), actionVersion: s('Registered read version or definition digest'),
    capabilityRef: ref('Declaring capability for a technical adapter operation', false),
    definitionDigest: hash('Exact action definition digest'), description: s('Registered action description', 10000),
    inputs: p('struct', z.record(z.string(), z.string()), 'Named typed object inputs'),
    inputSchema: p('struct', z.record(z.string(), z.unknown()), 'Published argument schema', false),
    resultType: s('Registered result object type', 80, false),
    effect: p('string', z.enum(['read', 'definition_only']), 'Registered effect, not permission'),
    kind: p('string', z.enum(['decision', 'source_read', 'business']), 'Registered action meaning', false),
    effects: strings('Declared effects; never a permission grant'), resultTypes: strings('Registered normalized result object types'),
    changes: strings('Declared object changes'), submissionCriteria: strings('Checks required before invocation'),
    execution: p('string', z.literal('definition_only'), 'Definition visibility never grants execution'),
  }),
  type('ActionBinding', 'Pinned task-local executable implementation snapshot. Current permission is checked independently at dispatch.', {
    requestRevision, bindingRef: ref('Configured program or provider reference'), configurationDigest: s('Opaque implementation configuration fingerprint when actually declared; compared exactly against the pinned binding', 2000, false),
    bindingDigest: p('string', sha, 'Exact provider binding digest pinned by a sealed fixed plan', false),
    providerContract: p('struct', executionProviderContractSchema, 'Public adapter/provider contract fields that reproduce the pinned binding digest', false),
    kind: p('string', z.enum(['agent_program', 'fixed_plan']), 'Implementation binding kind'),
    actionIds: strings('Explicitly bound registered definitions'), active: bool('Binding belongs to the current execution scope'),
    authorization: p('string', z.literal('runtime_check_required'), 'No persisted graph record supplies current source authority'),
  }),
  type('ExecutionContext', 'Current task execution context, distinct from business evidence and freshness.', {
    requestRevision, phase: s('Coordinator phase'), state: s('Task state'), programRef: ref('Pinned agent program', false),
    programDigest: p('string', sha, 'Pinned program configuration', false), scope: objectRef('Current business scope', false),
    activeBinding: objectRef('Current task binding snapshot', false), pendingPlanId: s('Plan awaiting execution', 200, false),
    observationOrder: p('array', z.array(objectRefSchema).max(128), 'Current-scope observation order; each reference also has a typed link'),
    feedback: p('array', z.array(executionFeedbackSchema).max(20), 'Bounded safe runtime feedback'),
  }),
  type('ExecutionPlan', 'Sealed execution plan. The plan structure and registry digest are checked independently before dispatch.', {
    planId: s('Sealed plan identity'), planDigest: hash('Sealed plan digest'), requestRevision,
    kind: p('string', z.enum(['agent', 'fixed']), 'Agent-selected frontier or registered fixed plan'),
    sequence: integer('Plan order'), state: s('Plan lifecycle'), structureDigest: hash('Digest of immutable safe graph structure'),
    createdAt: p('timestamp', time, 'Plan recording time'), modelRunId: s('Model evidence identity', 200, false),
  }),
  type('ExecutionStep', 'One version-bound invocation intent with typed inputs, dependency edges and actual attempts.', {
    stepId: s('Plan-local step identity'), sequence: integer('Position within the sealed plan'), actionId: s('Selected action identifier'),
    definitionDigest: p('string', sha, 'Pinned registered action digest', false), inputDigest: hash('Exact arguments and input-reference digest'),
    intentId: s('Original durable intent', 200, false), planDigest: hash('Intent plan version'),
    effect: s('Permitted effect class'), state: p('string', intentState, 'Durable execution state, not business completion'),
    structureDigest: hash('Immutable step structure digest'), acceptedOutput: objectRef('Accepted normalized business object only', false),
  }),
  type('ExecutionInput', 'A named argument or output binding. Private argument values are omitted; exact values remain digest-bound.', {
    parameter: s('Target argument name'), sourceKind: p('string', z.enum(['literal', 'object', 'step_output']), 'Argument source'),
    valueDigest: hash('Exact sealed value or output-binding digest'), valueType: s('Value shape or typed object name'),
    sourceStepId: s('Producing step identifier', 200, false), sourcePath: s('Selected output path', 500, false),
    object: objectRef('Referenced public business object', false),
  }),
  type('ExecutionAttempt', 'One actual invocation or reconciliation attempt. Claim tokens, dispatch keys and private arguments are never exposed.', {
    attemptId: s('Durable attempt identity'), intentId: s('Original intent identity'), planDigest: hash('Original pinned plan version'),
    ordinal: integer('Original attempt order'), requestRevision, taskRevision: integer('Durable task lease-fence revision; technical recovery may advance it without changing business intent'),
    kind: p('string', z.enum(['dispatch', 'observe', 'reconcile', 'resume']), 'Attempt kind'),
    inputDigest: hash('Exact dispatched input digest'), startedAt: p('timestamp', time, 'Dispatch recording time'),
    state: p('string', z.enum(['started', 'observed', 'audit_only']), 'Whether an applied observation exists for this attempt'),
    submission: p('struct', executionSubmissionSchema, 'Recorded semantic submission checks for this exact attempt; current execution authority remains a separate check', false),
  }),
  type('ExecutionResult', 'A received result with intent-ledger acceptance and verification status. Ledger acceptance does not prove application to the current task or business completion.', {
    resultId: s('Durable observation identity'), resultDigest: hash('Exact private result digest'), receivedAt: p('timestamp', time, 'Receipt recording time'),
    kind: p('string', z.enum(['pending', 'confirmed', 'rejected', 'unknown', 'requires_input', 'requires_authorization', 'not_found']), 'Source result state'),
    sourceVersion: integer('Source event version'), applied: bool('Accepted into the durable intent ledger. Agent reads also require their request and lease fence; fixed business effects retain observable truth while task updates require a separate valid checkpoint.'),
    verification: p('string', z.enum(['verified', 'unverified', 'not_recorded']), 'Validation outcome; never inferred from confirmed alone'),
    output: objectRef('Accepted projected business object; absent for audit-only results', false),
  }),
];

const relation = (id: string, fromType: string, fromName: string, fromMany: boolean, toType: string, toName: string, toMany = true, required = false): LinkDefinition =>
  ({ id, description: `${fromType}.${fromName} ↔ ${toType}.${toName}`, from: { type: fromType, name: fromName, many: fromMany, required }, to: { type: toType, name: toName, many: toMany } });
export const executionLinks: LinkDefinition[] = [
  ...([
    ['RequestSpecification', 'specifications'], ['RequestInstruction', 'instructions'], ['RequestConstraint', 'constraints'],
    ['RegisteredActionType', 'registeredActionTypes'], ['ActionBinding', 'actionBindings'], ['ExecutionContext', 'executionContexts'],
    ['ExecutionPlan', 'executionPlans'], ['ExecutionStep', 'executionSteps'],
  ] as const).map(([type, name]) => relation(`${type}Request`, type, 'request', false, 'ServiceRequest', name, true, true)),
  relation('ExecutionBindingAction', 'ActionBinding', 'actionTypes', true, 'RegisteredActionType', 'bindings'),
  relation('RequestSpecificationInstruction', 'RequestSpecification', 'instructions', true, 'RequestInstruction', 'specifications'),
  relation('RequestSpecificationConstraint', 'RequestSpecification', 'constraints', true, 'RequestConstraint', 'specifications'),
  relation('RequestConstraintInstruction', 'RequestConstraint', 'sourceInstruction', false, 'RequestInstruction', 'constraints'),
  relation('RequestConstraintPredecessor', 'RequestConstraint', 'supersedes', false, 'RequestConstraint', 'supersededBy'),
  relation('ExecutionContextBinding', 'ActionBinding', 'context', false, 'ExecutionContext', 'bindings'),
  relation('ExecutionPlanContext', 'ExecutionPlan', 'context', false, 'ExecutionContext', 'plans'),
  relation('ExecutionPlanBinding', 'ExecutionPlan', 'binding', false, 'ActionBinding', 'plans'),
  relation('ExecutionStepPlan', 'ExecutionStep', 'plan', false, 'ExecutionPlan', 'steps', true, true),
  relation('ExecutionStepAction', 'ExecutionStep', 'actionType', false, 'RegisteredActionType', 'steps'),
  relation('ExecutionStepBinding', 'ExecutionStep', 'binding', false, 'ActionBinding', 'steps'),
  relation('ExecutionStepDependency', 'ExecutionStep', 'dependencies', true, 'ExecutionStep', 'dependents'),
  relation('ExecutionInputStep', 'ExecutionInput', 'step', false, 'ExecutionStep', 'inputs', true, true),
  relation('ExecutionInputSource', 'ExecutionInput', 'sourceStep', false, 'ExecutionStep', 'outputConsumers'),
  relation('ExecutionAttemptStep', 'ExecutionAttempt', 'step', false, 'ExecutionStep', 'attempts', true, true),
  relation('ExecutionResultAttempt', 'ExecutionResult', 'attempt', false, 'ExecutionAttempt', 'results', true, true),
  relation('ExecutionResultStep', 'ExecutionResult', 'step', false, 'ExecutionStep', 'results'),
];
export type ExecutionReferenceKind = 'input' | 'output' | 'scope' | 'observation';
export function executionReferenceLink(kind: ExecutionReferenceKind, target: string): { id: string; name: string } {
  const prefix = { input: 'ExecutionInputObject', output: 'ExecutionResultOutput', scope: 'ExecutionContextScope', observation: 'ExecutionContextObservation' }[kind];
  return { id: `${prefix}${target}`, name: `${{ input: 'object', output: 'output', scope: 'scope', observation: 'observed' }[kind]}${target}` };
}
/** Concrete endpoint typing is preserved without modifying any business object's interfaces. */
export function executionReferenceLinks(businessTypes: readonly ObjectTypeDefinition[], actions: readonly ActionDefinition[], interfaces: readonly InterfaceDefinition[] = []): LinkDefinition[] {
  const implementsInterface = (id: string, target: string): boolean => id === target || !!interfaces.find(i => i.id === id)?.parents?.some(parent => implementsInterface(parent, target));
  const expand = (types: string[]) => new Set(businessTypes.filter(object => types.includes(object.id) || object.interfaces?.some(i => types.some(target => implementsInterface(i.id, target)))).map(o => o.id));
  const outputs = actions.flatMap(action => [...(action.read ? [action.read.resultType] : []), ...(action.resultTypes ?? [])]);
  const targets = {
    input: expand(actions.flatMap(action => Object.values(action.inputs)).concat(outputs)),
    output: expand(outputs), observation: expand(outputs),
    scope: expand(actions.flatMap(action => action.inputs.scope ? [action.inputs.scope] : [])),
  };
  return (Object.keys(targets) as ExecutionReferenceKind[]).flatMap(kind => [...targets[kind]].map(id => {
    const descriptor = executionReferenceLink(kind, id);
    const from = { input: 'ExecutionInput', output: 'ExecutionResult', scope: 'ExecutionContext', observation: 'ExecutionContext' }[kind];
    const reverse = { input: 'executionInputs', output: 'executionResults', scope: 'executionScopes', observation: 'executionObservations' }[kind];
    return relation(descriptor.id, from, descriptor.name, kind === 'observation', id, reverse);
  }));
}
const bookkeeping = new Set(executionObjects.map(o => o.id).filter(id => !id.startsWith('Request')));
export const isExecutionBookkeepingType = (type: string): boolean => bookkeeping.has(type);
for (const object of executionObjects) if (bookkeeping.has(object.id)) object.visibility = 'technical';
