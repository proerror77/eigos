import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { actionOperationKey, digest } from '../packages/core/delegation.js';
import { bindingDigest } from '../packages/core/catalog.js';
import { JobStore } from '../packages/core/store.js';
import type { Job } from '../packages/core/domain.js';
import type { AgentActionPlan, AgentExecutionState } from '../packages/ontology/agent-actions.js';
import type { ActionIntent, ExecutionAttempt } from '../packages/ontology/actions.js';
import { businessModel } from '../packages/ontology/business-model.js';
import { FROZEN_V14 } from '../packages/ontology/history-schema.js';
import v14Pins from './fixtures/ontology-v14-fingerprints.json' with { type: 'json' };
import { executionObjects, executionLinks, executionReferenceLinks, isExecutionBookkeepingType } from '../packages/ontology/execution-model.js';
import { assertAgentPlanProjection, assertFixedPlanProjection, executionContextRef, executionPlanRef, executionStepRef, projectExecution, readExecutionContext, readOntologyRequest, type ExecutionLedger } from '../packages/ontology/execution-projection.js';
import { BACKEND_VERSION, type ExecutionPlan, type ProviderBinding, type ServiceRequest } from '../packages/ontology/execution.js';
import { assertSemanticSubmission } from '../packages/ontology/action-submission.js';
import { projectPreparedResolution } from '../packages/ontology/capability-catalog.js';
import { domainCapability } from '../packages/capabilities/domain-service.js';
import { domainCapabilityId, projectDomainSnapshot } from '../packages/ontology/domain-projection.js';
import { domainFixture } from './fixtures/service-domains.js';
import { OntologyModel } from '../packages/ontology/model.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { templatePlanning } from '../packages/ontology/planning-contract.js';
import { projectTask } from '../packages/ontology/task-projection.js';

const at = '2026-10-20T03:00:00.000Z', owner = 'execution-test-owner';
function fixture() {
  const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db), scope = { type: 'PaotuiTask', id: 'scope' };
  const request: ServiceRequest = { id: 'request', revision: 1, originalGoal: 'Read my saved addresses', requestedDeliverable: 'Current saved choices', executionEnvironment: 'live',
    requirements: [{ id: 'no-order', kind: 'condition', strength: 'hard', expected: { predicate: 'execution.no_order' }, provenance: { source: 'pa', interpretation: 'structured', messageId: 'message', receivedAt: at } }],
    messages: [{ id: 'message', text: 'Read my saved addresses', receivedAt: at }] };
  const state: AgentExecutionState = { version: '1', programRef: { id: 'test.read-agent', version: '1' }, programDigest: digest('configuration'), scope,
    input: { private: 'PRIVATE_STATE_INPUT' }, requestRevision: 1, plans: [], observations: [], feedback: [] };
  const job: Job = { id: request.id, contextId: 'context', service: 'eigos.delegate', goal: request.originalGoal, state: 'working', revision: 1, createdAt: at, updatedAt: at,
    messages: [], delegation: { backendVersion: BACKEND_VERSION, request, phase: 'planning', agent: state, events: [] } };
  projectTask(graph, owner, job);
  graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: 'Owned read scope', requestRevision: 1,
    configurationDigest: state.programDigest, connectionDigest: digest('source'), outcome: 'quote', allowedActions: ['ReadSavedAddresses', 'ReadSavedAddressDetail'], privateContext: { secret: 'PRIVATE_SOURCE_SECRET' } } }],
  links: [{ type: 'PaotuiTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: at });
  const selected = [
    { id: 'book', action: 'ReadSavedAddresses', argumentsJson: JSON.stringify({ scope }), dependsOn: [], inputRefs: [] },
    { id: 'detail', action: 'ReadSavedAddressDetail', argumentsJson: JSON.stringify({ scope, selector: 'PRIVATE_SELECTOR', role: 'sender' }), dependsOn: ['book'], inputRefs: [{ stepId: 'book', targetKey: 'book' }] },
  ];
  const body: Omit<AgentActionPlan, 'digest'> = { id: 'plan', version: '2', sequence: 1, requestId: request.id, requestRevision: 1, programRef: state.programRef,
    programDigest: state.programDigest, scope, scopeDigest: digest(graph.read(owner, scope).properties), modelRunId: 'model-receipt',
    modelDecision: { kind: 'execute', requestRevision: 1, message: 'PRIVATE_REASONING', steps: selected, completionJson: '' }, reasoning: 'PRIVATE_REASONING', createdAt: at,
    ontologyPlanning: templatePlanning(request),
    steps: selected.map(step => ({ ...step, effect: 'read', operationKey: `PRIVATE_KEY_${step.id}`, input: JSON.parse(step.argumentsJson) as Record<string, unknown>, definitionDigest: digest(graph.model.action(step.action)), intentId: `intent-${step.id}` })) };
  const plan: AgentActionPlan = { ...body, digest: digest(body) }; state.plans.push(plan); state.pendingPlanId = plan.id;
  const intents: ActionIntent[] = plan.steps.map(step => ({ id: step.intentId, owner, jobId: request.id, stepId: step.id, businessOperationKey: `PRIVATE_KEY_${step.id}`,
    planDigest: plan.digest, bindingRef: state.programRef, inputDigest: digest(step.input), privateDigest: digest({}), privateData: { secret: 'PRIVATE_INTENT_SECRET' },
    effect: 'read', state: 'ready', nextAt: 0, createdAt: at }));
  const ledger: ExecutionLedger = { intents, attempts: [], observations: [] };
  const project = () => {
    db.exec('SAVEPOINT fixture');
    try { projectExecution(graph, owner, job, ledger); db.exec('RELEASE fixture'); }
    catch (error) { db.exec('ROLLBACK TO fixture; RELEASE fixture'); throw error; }
  };
  return { db, graph, request, job, state, plan, ledger, project, scope };
}

function fixedFixture(adapterOnly = false) {
  const f = fixture(), domain = domainFixture('hotel');
  delete f.job.delegation!.agent; f.ledger.intents = [];
  f.request.originalGoal = 'Synthetic hotel request'; f.request.messages[0]!.text = f.request.originalGoal;
  f.request.requirements = []; f.request.executionEnvironment = 'sandbox';
  projectTask(f.graph, owner, f.job);
  domain.snapshot.requestId = f.request.id;
  const projected = projectDomainSnapshot(f.graph, owner, domainCapabilityId('hotel'), f.request, domain.parameters, domain.snapshot);
  assert.equal(projected.state, 'typed_result');
  const capability = adapterOnly ? { ...domainCapability('hotel'), ref: { id: 'fixture.adapter', version: '1' },
    actions: [{ ref: { id: 'fixture.legacy.read', version: '1' }, effect: 'read' as const }] } : domainCapability('hotel');
  const binding: ProviderBinding = { ref: { id: 'fixed-provider', version: '1' }, capabilityRef: capability.ref, providerId: 'synthetic-provider',
    channelId: 'synthetic', adapterId: 'synthetic', ...(adapterOnly ? {} : { configurationDigest: 'opaque-provider-configuration-v1' }), protocol: 'local', enabled: true, verification: { level: 'simulated', evidenceRefs: [] }, recovery: { idempotency: 'provider_key', lookup: true } };
  const step = { id: 'fixed-step', operationId: 'synthetic-operation', actionTypeRef: capability.actions[0]!.ref, bindingRef: binding.ref, capabilityRef: capability.ref,
    effect: capability.actions[0]!.effect, input: domain.parameters, inputRefs: [], dependsOn: [] };
  const candidate = { id: 'fixed-candidate', binding, status: 'ready' as const, input: domain.parameters, details: {}, facts: {}, evidenceRefs: ['synthetic'],
    requirementChecks: [], observedAt: domain.snapshot.option.observedAt, expiresAt: domain.snapshot.option.expiresAt, ontologySubject: projected.subject };
  projectPreparedResolution(f.graph, owner, f.request, { candidates: [candidate], scope: { capabilityRef: capability.ref, searchedBindingRefs: [binding.ref], observedAt: at, realSupply: false } }, capability);
  const body: Omit<ExecutionPlan, 'digest'> = { id: 'fixed-plan', version: '7', ontologyPlanning: templatePlanning(f.request), requestId: f.request.id,
    requestRevision: 1, requestDigest: digest(f.request), capabilityRef: capability.ref, ontologyRef: capability.ontologyRef, candidateId: candidate.id,
    bindingRef: binding.ref, bindingSnapshots: [], definitionDigests: [{ ref: capability.ref, digest: digest(capability) }],
    bindingDigests: [{ ref: binding.ref, digest: bindingDigest(binding) }], completionTarget: 'domain', verifierRef: capability.verifierRef,
    steps: [step], details: {}, requirementChecks: [], expiresAt: domain.snapshot.option.expiresAt };
  const plan = { ...body, digest: digest(body) }; f.job.delegation!.plan = plan; f.job.delegation!.phase = 'executing';
  const intent: ActionIntent = { id: 'fixed-intent', owner, jobId: f.request.id, stepId: step.id, businessOperationKey: actionOperationKey(owner, f.request.id, step.operationId),
    planDigest: plan.digest, bindingRef: binding.ref, inputDigest: digest({ input: step.input, inputRefs: step.inputRefs }), privateDigest: digest({}), privateData: {},
    effect: step.effect, state: 'ready', nextAt: 0, createdAt: at };
  return { ...f, fixedPlan: plan, fixedIntent: intent, subject: projected.subject!, binding, domain };
}

test('execution graph preserves frozen v14 definitions or names their exact migration predecessor and concrete reference endpoints', () => {
  for (const [type, fingerprint] of Object.entries(v14Pins.objects)) {
    if (businessModel.fingerprint(type) !== fingerprint) assert.equal(FROZEN_V14.objects[type]?.fingerprint, fingerprint, `${type} requires its independently frozen predecessor schema`);
  }
  for (const [type, previous] of Object.entries(v14Pins.links)) {
    if (digest(businessModel.link(type)) !== previous) assert.equal(FROZEN_V14.links[type]?.digest, previous, `${type} requires its independently frozen predecessor link`);
  }
  assert.equal(businessModel.link('ExecutionInputObjectPaotuiTask').to.type, 'PaotuiTask');
  assert(isExecutionBookkeepingType('ExecutionStep'));
  assert(!isExecutionBookkeepingType('RequestConstraint'));
});

test('request and execution readback traverses typed plans, dependencies and inputs without private state', () => {
  const f = fixture();
  try {
    f.project();
    const request = readOntologyRequest(f.graph, owner, f.request.id);
    assert.deepEqual(request.messages, f.request.messages); assert.deepEqual(request.requirements, f.request.requirements);
    assert.equal(request.requestedDeliverable, f.request.requestedDeliverable); assert.equal(request.executionEnvironment, 'live');
    assertAgentPlanProjection(f.graph, owner, f.plan);
    const view = readExecutionContext(f.graph, owner, f.request.id, 1)!;
    assert.deepEqual(view.scope, f.scope); assert.deepEqual(view.actionIds, ['ReadSavedAddresses', 'ReadSavedAddressDetail']);
    assert.deepEqual(view.plans[0]!.steps[1]!.dependsOn, ['book']);
    assert.deepEqual(view.plans[0]!.steps[1]!.inputRefs, [{ stepId: 'book', targetKey: 'book' }]);
    assert(view.links.some(l => l.type === 'ExecutionStepDependency'));
    assert(view.links.some(l => l.type === 'ExecutionInputObjectPaotuiTask'));
    assert(!JSON.stringify(view).includes('PRIVATE_'));
    const before = f.graph.revision(owner); f.job.updatedAt = '2026-10-20T03:00:01.000Z'; f.project();
    assert.equal(f.graph.revision(owner), before, 'bookkeeping saves with unchanged values do not churn graph revisions');
    assert.throws(() => readExecutionContext(f.graph, 'other-owner', f.request.id, 1), /not found/);
  } finally { f.db.close(); }
});

test('typed fact and condition snapshots retain each historical requirement version and detect current assertion tampering', () => {
  const f = fixture();
  try {
    f.request.confirmedInputs = { parcel: { version: '1', revision: 1, messageDigest: digest('first'), history: [], fields: {
      weightKg: { field: 'weightKg', status: 'confirmed', value: 2, quote: '2 kg', revision: 1, source: { messageId: 'message', messageIndex: 0, receivedAt: at } },
    } } };
    f.request.conditions = [{ id: 'scope', predicateRef: { id: 'geo.query_scope_matches', version: '1' }, subject: { type: 'Place', role: 'search_area' },
      phase: 'result', strength: 'hard', operator: 'eq', expected: { city: '上海', keyword: '咖啡' }, source: { messageId: 'message', quote: '上海咖啡' } }];
    projectTask(f.graph, owner, f.job); f.project();
    const spec = f.graph.query(owner, { from: { type: 'ServiceRequest', id: f.request.id }, link: 'specifications' }).items[0]!;
    const oldFacts = f.graph.query(owner, { from: spec.ref, link: 'facts' }).items, oldConditions = f.graph.query(owner, { from: spec.ref, link: 'conditions' }).items;
    assert.equal(oldFacts[0]!.properties.value, 2); assert.equal(oldConditions.length, 1);
    f.request.revision = 2; f.request.messages.push({ id: 'correction', text: '改为 3 kg', receivedAt: at });
    f.request.confirmedInputs.parcel!.revision = 2; f.request.confirmedInputs.parcel!.messageDigest = digest('second');
    f.request.confirmedInputs.parcel!.fields.weightKg = { field: 'weightKg', status: 'confirmed', value: 3, quote: '3 kg', revision: 2, source: { messageId: 'correction', messageIndex: 1, receivedAt: at } };
    f.job.delegation!.agentHistory = [f.state]; delete f.job.delegation!.agent;
    projectTask(f.graph, owner, f.job); f.project();
    assert.equal(readOntologyRequest(f.graph, owner, f.request.id).confirmedInputs!.parcel!.fields.weightKg!.value, 3);
    assert.deepEqual(f.graph.query(owner, { from: spec.ref, link: 'facts' }).items, oldFacts);
    assert.deepEqual(f.graph.query(owner, { from: spec.ref, link: 'conditions' }).items, oldConditions);
    const currentSpec = f.graph.query(owner, { from: { type: 'ServiceRequest', id: f.request.id }, link: 'specifications', where: [{ property: 'requestRevision', op: 'eq', value: 2 }] }).items[0]!;
    const currentFact = f.graph.query(owner, { from: currentSpec.ref, link: 'facts' }).items[0]!;
    f.graph.ingest(owner, { objects: [{ ref: currentFact.ref, properties: { ...currentFact.properties, value: 99 }, expectedRevision: currentFact.revision }] }, currentFact.source);
    assert.throws(() => readOntologyRequest(f.graph, owner, f.request.id), /differs from its sealed specification/);
  } finally { f.db.close(); }
});

test('sealed graph tampering cannot be silently healed by projection or dispatched', () => {
  const f = fixture();
  try {
    f.project();
    const step = f.graph.read(owner, executionStepRef(f.plan, 'detail'));
    const dependency = { type: 'ExecutionStepDependency', from: step.ref, to: executionStepRef(f.plan, 'book') };
    f.graph.ingest(owner, { objects: [], removeLinks: [dependency] }, { kind: 'task', id: f.request.id, observedAt: at });
    assert.throws(() => assertAgentPlanProjection(f.graph, owner, f.plan), /relationships/);
    assert.throws(f.project, /relationships/);
    f.graph.ingest(owner, { objects: [], links: [dependency] }, { kind: 'task', id: f.request.id, observedAt: at });
    const current = f.graph.read(owner, step.ref);
    f.graph.ingest(owner, { objects: [{ ref: step.ref, expectedRevision: current.revision, properties: { ...current.properties, inputDigest: digest('tampered') } }] }, { kind: 'task', id: f.request.id, observedAt: at });
    assert.throws(() => assertAgentPlanProjection(f.graph, owner, f.plan), /invocation/);
    f.job.state = 'paused';
    const before = f.graph.read(owner, executionContextRef(f.request.id, 1));
    assert.throws(f.project, /Immutable/);
    assert.deepEqual(f.graph.read(owner, before.ref), before, 'failed projection rolls back earlier context updates in the shared transaction');
  } finally { f.db.close(); }
});

test('attempts and late results preserve audit status without dispatch keys, tokens or raw result payloads', () => {
  const f = fixture();
  try {
    const intent = f.ledger.intents[0]!;
    const attempt: ExecutionAttempt = { id: 'attempt', intentId: intent.id, kind: 'dispatch', requestKey: 'PRIVATE_REQUEST_KEY', startedAt: at,
      claimToken: 'PRIVATE_CLAIM_TOKEN', requestRevision: 4, inputDigest: digest('arguments'), planDigest: f.plan.digest, ordinal: 1 };
    f.ledger.attempts.push(attempt); intent.state = 'effect_unknown';
    const result = { kind: 'confirmed' as const, eventId: 'PRIVATE_VENDOR_ID', sourceVersion: 1, output: { privateResponse: 'PRIVATE_PROVIDER_DATA' }, evidenceRefs: [] };
    f.ledger.observations.push({ id: 'late-result', intentId: intent.id, attemptId: attempt.id, receivedAt: at, digest: digest(result), applied: false, verified: true, result });
    f.project();
    const view = readExecutionContext(f.graph, owner, f.request.id, 1)!;
    const results = view.objects.filter(o => o.ref.type === 'ExecutionResult'), attempts = view.objects.filter(o => o.ref.type === 'ExecutionAttempt');
    assert.equal(results.length, 1); assert.equal(results[0]!.properties.applied, false); assert.equal(results[0]!.properties.output, undefined);
    assert.equal(attempts[0]!.properties.state, 'audit_only'); assert.equal(view.plans[0]!.steps[0]!.state, 'effect_unknown');
    assert.equal(attempts[0]!.properties.requestRevision, 1); assert.equal(attempts[0]!.properties.taskRevision, 4);
    assert(!JSON.stringify(view).includes('PRIVATE_'));
    assertAgentPlanProjection(f.graph, owner, f.plan);
  } finally { f.db.close(); }
});

test('verified normalized outputs have typed links and remain historical facts after a later unknown result', () => {
  const f = fixture();
  try {
    const receipt = { type: 'SourceReceipt', id: 'fixture-receipt' }, observation = { type: 'PaotuiObservation', id: 'fixture-observation' };
    f.graph.ingest(owner, { objects: [
      { ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'Synthetic source', safeSummary: 'Synthetic source receipt', evidenceLevel: 'synthetic' } },
      { ref: observation, properties: { id: observation.id, displayTitle: 'Safe address count', requestRevision: 1,
        summary: { action: 'ReadSavedAddresses', count: 2, observedAt: at, expiresAt: '2026-10-20T03:10:00.000Z', noOrder: true, noPayment: true },
        privateSnapshot: { secret: 'PRIVATE_FULL_ADDRESSES' } } },
    ], links: [
      { type: 'PaotuiObservationRequest', from: observation, to: { type: 'ServiceRequest', id: f.request.id } },
      { type: 'PaotuiObservationTask', from: observation, to: f.scope }, { type: 'PaotuiObservationEvidence', from: observation, to: receipt },
    ] }, { kind: 'synthetic', id: 'fixture', observedAt: at });
    const intent = f.ledger.intents[0]!, attempt: ExecutionAttempt = { id: 'attempt', intentId: intent.id, kind: 'dispatch', requestKey: 'PRIVATE_KEY', claimToken: 'PRIVATE_TOKEN',
      requestRevision: 1, inputDigest: digest('input'), planDigest: f.plan.digest, ordinal: 1, startedAt: at };
    intent.state = 'effect_confirmed'; intent.acceptedOutput = { object: observation }; intent.latestObservationId = 'accepted';
    f.state.observations.push(observation); f.ledger.attempts.push(attempt);
    const result = { kind: 'confirmed' as const, eventId: 'PRIVATE_SOURCE_EVENT', sourceVersion: 1, output: { source: 'PRIVATE_RAW_RESULT' }, evidenceRefs: ['fixture'] };
    f.ledger.observations.push({ id: 'accepted', intentId: intent.id, attemptId: attempt.id, receivedAt: at, digest: digest(result), applied: true, verified: true, result });
    f.project();
    let view = readExecutionContext(f.graph, owner, f.request.id, 1)!;
    assert.deepEqual(view.plans[0]!.steps[0]!.output, observation);
    assert(view.links.some(link => link.type === 'ExecutionResultOutputPaotuiObservation' && link.to.id === observation.id));
    assert(!JSON.stringify(view).includes('PRIVATE_'));
    intent.state = 'effect_unknown'; intent.latestObservationId = 'unknown';
    const later = { kind: 'unknown' as const, eventId: 'later-event', sourceVersion: 2, evidenceRefs: [] };
    f.ledger.observations.push({ id: 'unknown', intentId: intent.id, attemptId: attempt.id, receivedAt: at, digest: digest(later), applied: true, verified: false, result: later });
    f.project(); view = readExecutionContext(f.graph, owner, f.request.id, 1)!;
    assert.equal(view.plans[0]!.steps[0]!.output, undefined);
    assert.deepEqual(view.objects.find(o => o.ref.type === 'ExecutionResult' && o.properties.resultId === 'accepted')!.properties.output, observation);
    assert.equal(view.objects.find(o => o.ref.type === 'ExecutionResult' && o.properties.resultId === 'unknown')!.properties.output, undefined);
  } finally { f.db.close(); }
});

test('intent reuse is scoped by plan digest and request revisions retain historical graphs', () => {
  const f = fixture();
  try {
    f.project();
    const firstStep = executionStepRef(f.plan, 'book');
    const second = structuredClone(f.plan); second.id = 'second-plan'; second.sequence = 2;
    const { digest: _oldDigest, ...body } = second; second.digest = digest(body);
    f.state.plans.push(second); f.state.pendingPlanId = second.id;
    f.ledger.intents.push(...f.ledger.intents.map(intent => ({ ...intent, planDigest: second.digest, state: 'effect_confirmed' as const })));
    f.project();
    assert.notDeepEqual(firstStep, executionStepRef(second, 'book'));
    assert.equal(f.graph.read(owner, firstStep).properties.state, 'ready');
    assert.equal(f.graph.read(owner, executionStepRef(second, 'book')).properties.state, 'effect_confirmed');
    f.job.delegation!.agentHistory = [f.state]; delete f.job.delegation!.agent;
    f.request.revision = 2; f.request.messages.push({ id: 'correction', text: 'Only the current address book', receivedAt: '2026-10-20T03:01:00.000Z' });
    f.job.updatedAt = '2026-10-20T03:01:00.000Z'; projectTask(f.graph, owner, f.job); f.project();
    assert.throws(() => readExecutionContext(f.graph, owner, f.request.id, 1), /superseded/);
    assert.equal(readExecutionContext(f.graph, owner, f.request.id, 2)!.plans.length, 0);
    assert.equal(f.graph.read(owner, executionContextRef(f.request.id, 1)).properties.requestRevision, 1);
    assert.equal(f.graph.read(owner, executionPlanRef(f.plan)).properties.state, 'historical');
    assert.equal(readOntologyRequest(f.graph, owner, f.request.id).messages.length, 2);
  } finally { f.db.close(); }
});

test('execution context exposes bounded recent structure and explicit references to omitted history', () => {
  const f = fixture();
  try {
    for (let i = 2; i <= 5; i++) {
      const plan = structuredClone(f.plan); plan.id = `plan-${i}`; plan.sequence = i;
      const { digest: _oldDigest, ...body } = plan; plan.digest = digest(body);
      f.state.plans.push(plan);
      f.ledger.intents.push(...f.ledger.intents.slice(0, 2).map(intent => ({ ...intent, planDigest: plan.digest })));
    }
    f.state.pendingPlanId = 'plan-5'; f.project();
    const view = readExecutionContext(f.graph, owner, f.request.id, 1)!;
    assert.equal(view.history.planCount, 5); assert.equal(view.history.omittedPlanCount, 3); assert.equal(view.plans.length, 2);
    assert.deepEqual(view.plans.map(plan => plan.planId), ['plan-4', 'plan-5']);
    assert(view.unreadRefs.some(ref => sameRef(ref, executionPlanRef(f.plan))));
    assert(!view.objects.some(object => sameRef(object.ref, executionPlanRef(f.plan))));
    assert.equal(f.graph.query(owner, { object: view.history.olderPlanRefs[0]! }).items.length, 1);
  } finally { f.db.close(); }
});

test('instructions and unchanged assertions keep stable identities across request revisions with correction lineage', () => {
  const f = fixture();
  try {
    f.project(); f.job.delegation!.agentHistory = [f.state]; delete f.job.delegation!.agent;
    for (let revision = 2; revision <= 4; revision++) {
      f.request.revision = revision;
      const message = { id: `message-${revision}`, text: revision === 3 ? 'The explicit constraint is no payment' : `Follow-up ${revision}`, receivedAt: `2026-10-20T03:0${revision}:00.000Z` };
      f.request.messages.push(message); f.job.updatedAt = message.receivedAt;
      if (revision === 3) f.request.requirements[0] = { ...f.request.requirements[0]!, kind: 'condition', expected: { predicate: 'execution.no_payment' },
        provenance: { source: 'pa', interpretation: 'quoted_text', messageId: message.id, receivedAt: message.receivedAt, quote: message.text } };
      projectTask(f.graph, owner, f.job); f.project();
    }
    const instructions = f.graph.query(owner, { type: 'RequestInstruction' }).items;
    const constraints = f.graph.query(owner, { type: 'RequestConstraint' }).items;
    assert.equal(instructions.length, 4, 'four actual messages remain four instruction events');
    assert.equal(constraints.length, 2, 'only the actual correction creates a new assertion');
    assert.equal(readOntologyRequest(f.graph, owner, f.request.id).messages.length, 4);
    const active = constraints.find(c => c.properties.introducedRevision === 3)!;
    const predecessor = f.graph.related(owner, active.ref, 'supersedes', { remaining: 1000 })!;
    assert.equal(predecessor.length, 1); assert.deepEqual(predecessor[0]!.properties.expected, { predicate: 'execution.no_order' });
    assert.equal(f.graph.related(owner, active.ref, 'sourceInstruction', { remaining: 1000 })![0]!.properties.messageId, 'message-3');
    const specification = f.graph.query(owner, { from: { type: 'ServiceRequest', id: f.request.id }, link: 'specifications', where: [{ property: 'requestRevision', op: 'eq', value: 4 }] }).items[0]!;
    assert.equal(f.graph.related(owner, specification.ref, 'constraints', { remaining: 1000 })![0]!.ref.id, active.ref.id);
  } finally { f.db.close(); }
});

test('fixed operation aliases bind the registered semantic action and expose exact attempt submission checks', () => {
  const f = fixedFixture();
  try {
    f.project();
    const stepRef = executionStepRef(f.fixedPlan, 'fixed-step');
    assert.equal(f.graph.read(owner, stepRef).properties.intentId, undefined);
    f.ledger.intents.push(f.fixedIntent); f.project();
    assert.equal(f.graph.read(owner, stepRef).properties.intentId, f.fixedIntent.id, 'a unique ledger intent may bind an initially unprepared step once');
    assertFixedPlanProjection(f.graph, owner, f.fixedPlan, f.ledger.intents);
    const action = f.graph.related(owner, stepRef, 'actionType', { remaining: 1000 })![0]!;
    assert.equal(action.properties.actionId, 'RequestHotelReservation'); assert.equal(action.properties.contractKind, 'semantic_definition');
    const binding = f.graph.related(owner, stepRef, 'binding', { remaining: 1000 })![0]!;
    assert.equal(binding.properties.bindingDigest, bindingDigest(f.binding));
    assert.equal(binding.properties.configurationDigest, f.binding.configurationDigest, 'declared opaque configuration fingerprints are preserved exactly');
    const submission = assertSemanticSubmission(f.graph, owner, f.request, f.fixedPlan.steps[0]!, f.subject)!;
    f.ledger.attempts.push({ id: 'fixed-attempt', intentId: f.fixedIntent.id, kind: 'dispatch', requestKey: 'PRIVATE_KEY', claimToken: 'PRIVATE_TOKEN',
      requestRevision: 3, inputDigest: digest(f.fixedPlan.steps[0]!.input), planDigest: f.fixedPlan.digest, ordinal: 1, startedAt: at, submission });
    f.project();
    const attempt = f.graph.related(owner, stepRef, 'attempts', { remaining: 1000 })![0]!;
    assert.deepEqual(attempt.properties.submission, submission); assert.equal(attempt.properties.requestRevision, 1); assert.equal(attempt.properties.taskRevision, 3);
    assert(!JSON.stringify(attempt).includes('PRIVATE_'));
    f.fixedIntent.id = 'replacement-intent';
    assert.throws(f.project, /Immutable/); assert.throws(() => assertFixedPlanProjection(f.graph, owner, f.fixedPlan, f.ledger.intents), /sealed step/);
  } finally { f.db.close(); }
});

test('capability-only fixed actions are explicit adapter contracts and fixed graph tampering is rejected', () => {
  const f = fixedFixture(true);
  try {
    f.ledger.intents.push(f.fixedIntent); f.project();
    assertFixedPlanProjection(f.graph, owner, f.fixedPlan, f.ledger.intents);
    const stepRef = executionStepRef(f.fixedPlan, 'fixed-step');
    const action = f.graph.related(owner, stepRef, 'actionType', { remaining: 1000 })![0]!;
    assert.equal(action.properties.actionId, 'fixture.legacy.read'); assert.equal(action.properties.contractKind, 'adapter_operation');
    assert.deepEqual(action.properties.effects, ['read']); assert.deepEqual(action.properties.submissionCriteria, []); assert.deepEqual(action.properties.resultTypes, []);
    assert.equal(f.graph.model.actionForOperation('fixture.legacy.read'), undefined, 'a technical contract does not create business semantics');
    const link = { type: 'ExecutionStepAction', from: stepRef, to: action.ref };
    f.graph.ingest(owner, { objects: [], removeLinks: [link] }, { kind: 'task', id: f.request.id, observedAt: at });
    assert.throws(() => assertFixedPlanProjection(f.graph, owner, f.fixedPlan, f.ledger.intents), /relationships/);
    assert.throws(f.project, /relationships/);
  } finally { f.db.close(); }
});

test('fixed results expose only a normalized output pointer bound to their exact observation', () => {
  const f = fixedFixture();
  try {
    const normalized = projectDomainSnapshot(f.graph, owner, domainCapabilityId('hotel'), f.request, f.domain.parameters,
      { ...f.domain.snapshot, sourceEventId: 'confirmed-result', observation: f.domain.result });
    assert.equal(normalized.state, 'typed_result');
    f.fixedIntent.state = 'effect_confirmed'; f.fixedIntent.latestObservationId = 'current-observation';
    f.fixedIntent.acceptedOutput = { object: normalized.subject };
    f.ledger.intents.push(f.fixedIntent);
    const attempt: ExecutionAttempt = { id: 'output-attempt', intentId: f.fixedIntent.id, kind: 'dispatch', requestKey: 'PRIVATE_KEY', claimToken: 'PRIVATE_TOKEN',
      requestRevision: 1, inputDigest: digest(f.fixedPlan.steps[0]!.input), planDigest: f.fixedPlan.digest, ordinal: 1, startedAt: at };
    f.ledger.attempts.push(attempt);
    const result = { kind: 'confirmed' as const, eventId: 'provider-event', sourceVersion: 1, evidenceRefs: [] };
    f.ledger.observations.push({ id: 'current-observation', intentId: f.fixedIntent.id, attemptId: attempt.id, receivedAt: at,
      digest: digest(result), applied: true, verified: true, result });
    const output = () => f.graph.related(owner, executionStepRef(f.fixedPlan, 'fixed-step'), 'results', { remaining: 1000 })![0]!.properties.output;
    f.project(); assert.equal(output(), undefined, 'a raw provider object field is not a verified normalized output');
    f.fixedIntent.ontologyOutput = { object: normalized.subject!, observationId: 'older-observation' };
    f.project(); assert.equal(output(), undefined, 'an output pointer for another result is not reused');
    f.fixedIntent.ontologyOutput.observationId = 'current-observation';
    f.project(); assert.deepEqual(output(), normalized.subject);
  } finally { f.db.close(); }
});

test('JobStore retains both verified normalized outputs when a later verified result arrives', () => {
  const f = fixture(), store = new JobStore(':memory:');
  try {
    const initial = structuredClone(f.job); delete initial.delegation!.agent;
    store.save(owner, initial);
    const scope = f.graph.readPrivate(owner, f.scope);
    store.ontology.ingest(owner, { objects: [{ ref: f.scope, properties: scope.properties }], links: [
      { type: 'PaotuiTaskRequest', from: f.scope, to: { type: 'ServiceRequest', id: f.request.id } },
    ] }, { kind: 'task', id: f.request.id, observedAt: at });
    store.save(owner, f.job);
    for (const intent of f.ledger.intents) store.createIntent(owner, intent);
    for (const version of [1, 2]) {
      const object = { type: 'PaotuiObservation', id: `verified-observation-${version}` }, receipt = { type: 'SourceReceipt', id: `verified-receipt-${version}` };
      store.ontology.ingest(owner, { objects: [
        { ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'Synthetic receipt', safeSummary: 'Synthetic verified read', evidenceLevel: 'synthetic' } },
        { ref: object, properties: { id: object.id, displayTitle: 'Verified count', requestRevision: 1, summary: { action: 'ReadSavedAddresses', count: version,
          observedAt: at, expiresAt: new Date(Date.now() + 300000).toISOString(), noOrder: true, noPayment: true }, privateSnapshot: {} } },
      ], links: [
        { type: 'PaotuiObservationRequest', from: object, to: { type: 'ServiceRequest', id: f.request.id } },
        { type: 'PaotuiObservationTask', from: object, to: f.scope }, { type: 'PaotuiObservationEvidence', from: object, to: receipt },
      ] }, { kind: 'synthetic', id: 'fixture', observedAt: at });
      const attempt = store.startAttempt({ owner, job: f.job, token: 'INTERNAL_TEST_FENCE' }, f.ledger.intents[0]!.id, version === 1 ? 'dispatch' : 'reconcile', digest({ scope: f.scope }));
      const recorded = store.recordObservation(owner, f.ledger.intents[0]!.id, attempt.id,
        { kind: 'confirmed', eventId: `event-${version}`, sourceVersion: version, output: { object }, evidenceRefs: [] }, true);
      assert.equal(recorded.applied, true);
    }
    const results = store.ontology.related(owner, executionStepRef(f.plan, 'book'), 'results', { remaining: 1000 })!;
    assert.equal(results.length, 2); assert(results.every(result => result.properties.verification === 'verified'));
    assert.deepEqual(results.map(result => (result.properties.output as { id: string }).id).sort(), ['verified-observation-1', 'verified-observation-2']);
    assert.equal(store.intent(owner, f.ledger.intents[0]!.id).latestVersion, 2);
  } finally { store.close(); f.db.close(); }
});

function sameRef(a: { type: string; id: string }, b: { type: string; id: string }) { return a.type === b.type && a.id === b.id; }
