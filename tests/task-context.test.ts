import { businessModel } from '../packages/ontology/business-model.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CatalogAgentProgram } from '../packages/capabilities/catalog-agent.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { digest } from '../packages/core/delegation.js';
import { DomainError } from '../packages/core/domain.js';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { OntologyPlanningSession, validatePlanningSnapshot, type PlanningSessionOptions } from '../packages/coordinator/planning-session.js';
import { reasonWithOntology as nativeReasonWithOntology } from '../packages/coordinator/reasoning-loop.js';
import { scriptedMcpModel } from './fixtures/native-ontology-model.js';
const reasonWithOntology: typeof nativeReasonWithOntology = (model, ...args) => nativeReasonWithOntology(scriptedMcpModel(model), ...args);
import type { TaskContextPayload } from '../packages/coordinator/task-context.js';
import { projectCapabilityCatalog, projectPreparedResolution, readPreparedResolution, type PreparedResolution } from '../packages/ontology/capability-catalog.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import type { PlanningReadReceipt } from '../packages/ontology/planning-contract.js';
import { templatePlanning } from '../packages/ontology/planning-contract.js';
import type { AgentActionPlan } from '../packages/ontology/agent-actions.js';
import { readOntologyRequest } from '../packages/ontology/execution-projection.js';
import { domainCapabilityId, projectDomainSnapshot } from '../packages/ontology/domain-projection.js';
import { domainCapability } from '../packages/capabilities/domain-service.js';
import { domainFixture } from './fixtures/service-domains.js';
import { serviceDomain } from '../packages/ontology/service-domains.js';
import { drillCase } from './fixtures/ontology-drill.js';
import { evidence, fixtureBinding, owner, principal } from './backend-fixture.js';

const merchant = { id: 'coffee', name: 'Coffee', shopId: 'gid://shopify/Shop/12', domain: 'coffee.myshopify.com' };
type ContextResponse = { data: TaskContextPayload; receipt: { id: string; tool: string; outputDigest: string; status: string } };
function fixture(goal?: string) {
  const store = new JobStore(':memory:'), program = new CatalogAgentProgram([merchant]);
  const catalog = new ExecutionCatalog([program.capability()], [], [], [], [program]);
  const tasks = new TaskService(store, { catalog });
  const submit = (goal = 'CURRENT_OWNER_GOAL: compare two public coffee variants') => {
    const job = tasks.submit(principal, { service: 'eigos.delegate', goal, requestId: randomUUID(), requirements: [{ id: 'no-order', kind: 'condition', strength: 'hard', expected: { predicate: 'execution.no_order' } }] });
    projectCapabilityCatalog(store.ontology, owner, job.id, catalog.summaries(owner));
    return job;
  };
  const job = submit(goal);
  const session = (options: PlanningSessionOptions = { taskContext: { purpose: 'grounding' } }, active: () => void = () => {}, onRead: (receipt: PlanningReadReceipt) => void = () => {}) =>
    new OntologyPlanningSession(store.ontology, owner, store.get(owner, job.id).delegation!.request, [], active, onRead, 'request', [], options);
  const agent = () => {
    const current = store.get(owner, job.id), request = current.delegation!.request;
    const initialized = program.initialize(store.ontology, owner, request, { merchantIds: ['coffee'], country: 'US' });
    current.delegation!.agent = { version: '1', programRef: program.ref, programDigest: program.configurationDigest, ...initialized, requestRevision: request.revision, plans: [], observations: [], feedback: [] };
    current.delegation!.phase = 'planning';
    store.save(owner, current);
    return { taskContext: { purpose: 'agent' as const, program: { ref: program.ref, configurationDigest: program.configurationDigest, actionIds: program.actionIds }, refs: [initialized.scope] } };
  };
  return { store, catalog, program, tasks, job, submit, session, agent };
}
function read(session: OntologyPlanningSession): ContextResponse {
  const response = session.call('read_task_context', {}) as ContextResponse;
  assert(response.data, JSON.stringify(response));
  return response;
}
function accept(session: OntologyPlanningSession) { session.acceptReceipts(session.receipts().filter(receipt => receipt.status === 'ok').map(receipt => receipt.id)); }

test('task-context read reconstructs owner instructions and constraints from Ontology without Job payloads', t => {
  const f = fixture();
  try {
    const current = f.store.get(owner, f.job.id);
    current.runs = [{ ...evidence(), outputSha256: 'PRIVATE_JOB_RUNTIME_MARKER' }];
    f.store.save(owner, current);
    const query=f.store.ontology.query.bind(f.store.ontology),reads=new Map<string,number>();
    t.mock.method(f.store.ontology,'query',(...args:Parameters<typeof query>)=>{
      const input=args[1];
      if('from' in input && ['specifications','instructions','constraints'].includes(input.link))reads.set(input.link,(reads.get(input.link)??0)+1);
      return query(...args);
    });
    const session = f.session(), response = read(session);
    assert.equal(response.data.request.id, current.id);
    assert.equal(response.data.request.messages[0]!.text, current.goal);
    assert.equal(response.data.request.requirements[0]!.id, 'no-order');
    assert.equal(response.data.capabilities[0]!.ref.id, f.program.ref.id);
    assert(response.data.graph.objects.some(object => object.ref.type === 'RequestInstruction'));
    assert(response.data.graph.objects.some(object => object.ref.type === 'RequestConstraint'));
    assert(!JSON.stringify(response).includes('PRIVATE_JOB_RUNTIME_MARKER'));
    assert.deepEqual(Object.fromEntries(reads),{specifications:1,instructions:1,constraints:1},'Context assembly reuses the exact records from its sealed request read');
    assert.equal(response.receipt.outputDigest, digest(response.data));
    assert.throws(() => session.finish(), /acknowledge/);
    accept(session);
    const snapshot = session.finish();
    assert.equal(snapshot.context!.receiptId, response.receipt.id);
    assert(snapshot.deliveredObjects!.some(object => object.ref.type === 'ExecutionContext'));
    assert(!snapshot.objects.some(object => object.ref.type === 'ExecutionContext'), 'Runtime context is fenced at decision acceptance, not after its plan changes');
  } finally { f.store.close(); }
});

test('native reasoning starts with only a reference and explicitly cites the returned context receipt', async () => {
  const f = fixture(), prompts: string[] = [];
  try {
    const session = f.session();
    const model = { runStructured: async (prompt: string) => {
      prompts.push(prompt);
      const packet = JSON.parse(prompt.split('\n\n').at(-1)!) as { conversation: { result: ContextResponse }[]; request?: unknown };
      assert.equal(packet.request, undefined, 'No native prompt bypasses Ontology with a raw request');
      const output = packet.conversation.length
        ? { kind: 'final', calls: [], receiptIds: [packet.conversation[0]!.result.receipt.id], finalJson: JSON.stringify({ requestRevision: packet.conversation[0]!.result.data.request.revision }) }
        : { kind: 'read', calls: [{ tool: 'read_task_context', argumentsJson: '{}' }], receiptIds: [], finalJson: '' };
      return { output, evidence: evidence() };
    } };
    const result = await reasonWithOntology(model, 'Decide using the task reference.', {}, session, new AbortController().signal, () => {});
    assert.equal((result.output as { requestRevision: number }).requestRevision, 1);
    assert(!prompts[0]!.includes(f.job.goal));
    assert(prompts[1]!.includes(f.job.goal));
    assert.equal(session.receipts().length, 1, 'One real context read replaces repeated describe/query discovery');
    session.finish();
  } finally { f.store.close(); }
});

test('final decisions cannot invent receipts, cite another session or skip the current context read', async () => {
  const f = fixture();
  try {
    const previous = f.session(), old = read(previous);
    for (const receiptIds of [[], ['invented-receipt'], [old.receipt.id]]) {
      const session = f.session();
      await assert.rejects(reasonWithOntology({ runStructured: async () => ({ output: { kind: 'final', calls: [], receiptIds, finalJson: '{}' }, evidence: evidence() }) }, 'Task bootstrap.', {}, session, new AbortController().signal, () => {}), /cite|receipt/i);
      assert.equal(session.receipts().length, 0);
    }
    const session = f.session(), response = read(session);
    session.call('query_ontology', { object: response.data.requestRef });
    assert.throws(() => session.acceptReceipts([session.lastReceipt()!.id]), /task-context receipt/);
    assert.throws(() => session.acceptReceipts([response.receipt.id, response.receipt.id]), /successful receipts/);
    accept(session); session.call('describe_ontology', { search: 'ServiceRequest' });
    assert.throws(() => session.finish(), /after its last read/);
  } finally { f.store.close(); }
});

test('definition reuse returns the verified bundle and original receipt, with a fresh actual context receipt', () => {
  const f = fixture();
  try {
    const binding = f.agent(), first = f.session(binding), original = read(first);
    const actions = original.data.definitions.bundle.actions as { id: string; execution: string }[];
    assert.deepEqual(actions.map(action => action.id).sort(), [...f.program.actionIds].sort());
    assert(actions.every(action => action.execution === 'definition_only'));
    const repeated = f.session({ ...binding, priorReads: first.receipts() }), response = repeated.call('read_task_context', { definitionReceiptId: original.receipt.id }) as ContextResponse;
    assert(response.data, JSON.stringify(response));
    assert.equal(response.data.definitions.reused, true);
    assert.equal(response.data.definitions.originalReceiptId, original.receipt.id);
    assert.deepEqual(response.data.definitions.bundle, original.data.definitions.bundle);
    assert.notEqual(response.receipt.id, original.receipt.id);
    assert.equal(repeated.receipts().length, 1);
    assert.equal(repeated.receipts()[0]!.id, response.receipt.id);
    accept(repeated); repeated.finish();
    const corrupt = first.receipts();
    corrupt[0]!.definitions!.payload.actions = [];
    const rejected = f.session({ ...binding, priorReads: corrupt }).call('read_task_context', { definitionReceiptId: original.receipt.id }) as { error: string };
    assert.equal(rejected.error, 'CONFLICT');
    const changedBinding = f.session({ taskContext: { ...binding.taskContext, program: { ...binding.taskContext.program, configurationDigest: digest('changed') } }, priorReads: first.receipts() });
    assert.equal((changedBinding.call('read_task_context', {}) as { error: string }).error, 'CONFLICT');
  } finally { f.store.close(); }
});

test('a fresh native reasoning session receives full reused definitions in its own actual context result', async () => {
  const f = fixture();
  try {
    const binding = f.agent(), previous = f.session(binding), original = read(previous);
    const session = f.session({ ...binding, priorReads: previous.receipts() });
    let calls = 0;
    const result = await reasonWithOntology({ runStructured: async (prompt: string) => {
      calls++;
      const packet = JSON.parse(prompt.split('\n\n').at(-1)!) as { conversation: { result: ContextResponse }[] };
      if (!packet.conversation.length) return { output: { kind: 'read', calls: [{ tool: 'read_task_context', argumentsJson: '{}' }], receiptIds: [], finalJson: '' }, evidence: evidence() };
      const response = packet.conversation[0]!.result;
      assert.equal(response.data.definitions.reused, true);
      assert.equal(digest(response.data.definitions.bundle), digest(original.data.definitions.bundle));
      const actions = response.data.definitions.bundle.actions as { read: { inputSchema: object } }[];
      assert(actions.length > 0 && actions.every(action => Object.keys(action.read.inputSchema).length > 0));
      assert.notEqual(response.receipt.id, original.receipt.id);
      return { output: { kind: 'final', calls: [], receiptIds: [response.receipt.id], finalJson: JSON.stringify({ requestRevision: response.data.request.revision }) }, evidence: evidence() };
    } }, 'A new decision with no prior transcript.', {}, session, new AbortController().signal, () => {});
    assert.equal(calls, 2);
    assert.equal((result.output as { requestRevision: number }).requestRevision, 1);
    session.finish();
  } finally { f.store.close(); }
});

test('context budget rejection is a small receipt and native reasoning finalizes from previously delivered evidence', async () => {
  const f = fixture('Current requested outcome: ' + '原'.repeat(9000));
  try {
    const session = f.session();
    let calls = 0, deliveredBytes = 0, successfulReads = 0;
    const result = await reasonWithOntology({ runStructured: async (prompt: string, schema: object) => {
      calls++;
      const packet = JSON.parse(prompt.split('\n\n').at(-1)!) as { interface: { finalResponseRequired: boolean }; conversation: { result: any; receipt: { id: string; status: string } }[] };
      const rejected = packet.conversation.find(turn => turn.result.nextAction === 'finalize_with_available_evidence');
      if (!rejected) return { output: { kind: 'read', calls: [{ tool: 'read_task_context', argumentsJson: '{}' }], receiptIds: [], finalJson: '' }, evidence: evidence() };
      assert.equal(packet.interface.finalResponseRequired, true);
      assert.equal((schema as { properties: { kind: { const: string }; calls: { maxItems: number } } }).properties.kind.const, 'final');
      assert.equal((schema as { properties: { calls: { maxItems: number } } }).properties.calls.maxItems, 0);
      assert(Buffer.byteLength(JSON.stringify(rejected.result)) < 512);
      assert.equal(rejected.receipt.status, 'rejected');
      deliveredBytes = packet.conversation.reduce((total, turn) => total + Buffer.byteLength(JSON.stringify(turn.result.data ?? turn.result)), 0);
      const successful = packet.conversation.filter(turn => turn.receipt.status === 'ok');
      successfulReads = successful.length;
      assert(successfulReads > 0);
      return { output: { kind: 'final', calls: [], receiptIds: successful.map(turn => turn.receipt.id), finalJson: JSON.stringify({ requestRevision: successful.at(-1)!.result.data.request.revision }) }, evidence: evidence() };
    } }, 'Read the current context and decide.', {}, session, new AbortController().signal, () => {});
    assert(calls <= 8);
    assert(deliveredBytes <= 200000, 'The error receipt stays inside the original cumulative result budget');
    assert.equal((result.output as { requestRevision: number }).requestRevision, 1);
    const rejected = session.receipts().find(receipt => receipt.status === 'rejected')!;
    assert.deepEqual(rejected.objects, []); assert.deepEqual(rejected.deliveredObjects, []);
    assert.equal(rejected.context, undefined); assert.equal(rejected.definitions, undefined);
    const snapshot = session.finish();
    assert.equal(snapshot.reads.length, successfulReads);
    assert(snapshot.reads.every(receipt => receipt.status === 'ok'));
    assert.equal(snapshot.context!.receiptId, snapshot.reads.at(-1)!.id);
  } finally { f.store.close(); }
});

test('shared metadata cannot be traversed into another task, but retrieved task-owned nodes remain navigable', () => {
  const f = fixture();
  try {
    const other = f.submit('PRIVATE_OTHER_TASK_MARKER'), session = f.session(), response = read(session);
    const capability = response.data.graph.unreadRefs.find(ref => ref.type === 'RegisteredCapability')!;
    const instruction = response.data.graph.objects.find(object => object.ref.type === 'RequestInstruction')!;
    const exact = session.call('query_ontology', { object: capability }) as { items: { ref: { id: string } }[] };
    assert.equal(exact.items[0]!.ref.id, capability.id);
    const reverse = session.call('query_ontology', { from: capability, link: 'requests' }) as { error: string };
    assert.equal(reverse.error, 'FORBIDDEN');
    const parent = session.call('query_ontology', { from: instruction.ref, link: 'request' }) as { items: { ref: { id: string } }[] };
    assert.deepEqual(parent.items.map(item => item.ref.id), [f.job.id]);
    const foreign = session.call('query_ontology', { object: { type: 'ServiceRequest', id: other.id } }) as { error: string };
    assert.equal(foreign.error, 'FORBIDDEN');
    assert(!JSON.stringify([response, reverse, foreign]).includes('PRIVATE_OTHER_TASK_MARKER'));
    const anotherOwner = new OntologyPlanningSession(f.store.ontology, 'different-owner', f.job.delegation!.request, [], undefined, undefined, 'request', [], { taskContext: { purpose: 'grounding' }, priorReads: session.receipts() });
    assert.equal((anotherOwner.call('read_task_context', {}) as { error: string }).error, 'NOT_FOUND');
  } finally { f.store.close(); }
});

test('current context is checked when deciding, while later execution status changes do not invalidate business snapshots', () => {
  const f = fixture();
  try {
    const session = f.session(), response = read(session);
    const changed = f.store.get(owner, f.job.id); changed.delegation!.phase = 'planning'; f.store.save(owner, changed);
    assert.throws(() => session.acceptReceipts([response.receipt.id]), /execution context changed/);
    const next = f.session(); read(next); accept(next); const snapshot = next.finish();
    changed.delegation!.phase = 'executing'; f.store.save(owner, changed);
    validatePlanningSnapshot(f.store.ontology, owner, changed.delegation!.request, snapshot, true);
    changed.delegation!.request.revision++; changed.revision!++; f.store.save(owner, changed);
    assert.throws(() => validatePlanningSnapshot(f.store.ontology, owner, changed.delegation!.request, snapshot, true), /contract changed/);
  } finally { f.store.close(); }
});

test('read receipt bookkeeping does not change the task context or invalidate its own acknowledgement', () => {
  const f = fixture();
  try {
    const before = f.store.ontology.revision(owner);
    const session = f.session(undefined, undefined, receipt => {
      const job = f.store.get(owner, f.job.id); job.updatedAt = new Date(Date.now() + 1000).toISOString();
      job.delegation!.ontologyReads = [...(job.delegation!.ontologyReads ?? []), receipt];
      f.store.save(owner, job);
    });
    read(session); accept(session); session.finish();
    assert.equal(f.store.ontology.revision(owner), before);
  } finally { f.store.close(); }
});

test('cancellation or source-authority loss while the model responds cannot create a context read receipt', async () => {
  const f = fixture();
  try {
    let active = true, begin!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { begin = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
    const session = f.session(undefined, () => { if (!active) throw new DomainError('FORBIDDEN', 'Current claim or source authority lost'); });
    const pending = reasonWithOntology({ runStructured: async () => {
      begin(); await waiting;
      return { output: { kind: 'read', calls: [{ tool: 'read_task_context', argumentsJson: '{}' }], receiptIds: [], finalJson: '' }, evidence: evidence() };
    } }, 'Task bootstrap.', {}, session, new AbortController().signal, () => {});
    await entered; active = false; release();
    await assert.rejects(pending, /authority lost/);
    assert.deepEqual(session.receipts(), []);
  } finally { f.store.close(); }
});

test('delivered-object tracking does not turn hidden evaluator dependencies into model reads', () => {
  const data = drillCase('QD-1'), db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, undefined, () => data.now);
  try {
    graph.ingest(owner, data.batch, data.source);
    const session = new OntologyPlanningSession(graph, owner, data.request);
    session.call('query_ontology', { object: data.ids['quote-D'] });
    const readReceipt = session.lastReceipt()!;
    assert.equal(readReceipt.deliveredObjects!.length, 1);
    session.call('evaluate_ontology', { function: 'offerFreshness', object: data.ids['quote-D'] });
    const evaluation = session.lastReceipt()!;
    assert(evaluation.objects.length > 0);
    assert.deepEqual(evaluation.deliveredObjects, [], 'Evidence references alone are not delivery of the referenced properties');
    session.call('query_ontology', { object: data.ids['quote-D'] });
    assert.equal(session.lastReceipt()!.deliveredObjects!.length, 1, 'Repeated delivery is recorded even when the object was already seen');
  } finally { db.close(); }
});

test('prepared resolution is typed graph context, preserving candidate order and excluding private execution payloads', () => {
  const f = fixture();
  try {
    const request = f.store.get(owner, f.job.id).delegation!.request, now = new Date().toISOString();
    const candidate = { id: 'second', binding: { ...fixtureBinding('synthetic'), capabilityRef: f.program.ref, configurationDigest: 'registered-opaque-config-v1', accessToken: 'PRIVATE_BINDING_SECRET' }, status: 'ready' as const,
      input: { goal: request.originalGoal }, details: { source: 'synthetic public preparation' }, facts: { conditions: ['execution.no_order'] }, evidenceRefs: ['synthetic-source'],
      requirementChecks: [{ requirementId: 'no-order', result: 'pass' as const, reason: 'Read only', evidenceRefs: ['synthetic-source'] }], observedAt: now, expiresAt: new Date(Date.now() + 600000).toISOString(),
      privateData: { secret: 'PRIVATE_ADAPTER_PAYLOAD' } };
    const prepared = { candidates: [candidate, { ...candidate, id: 'first' }], scope: { capabilityRef: f.program.ref, searchedBindingRefs: [candidate.binding.ref, candidate.binding.ref], observedAt: now, realSupply: false },
      privateData: new Map([['second', 'PRIVATE_RESOLUTION_PAYLOAD']]) };
    projectPreparedResolution(f.store.ontology, owner, request, prepared, f.program.capability());
    const actual = readPreparedResolution(f.store.ontology, owner, f.job.id)!;
    assert.deepEqual(actual.candidates.map(item => item.id), ['second', 'first']);
    assert.equal(actual.candidates[0]!.input!.goal, request.originalGoal);
    assert.equal(actual.candidates[0]!.binding.configurationDigest, 'registered-opaque-config-v1');
    const session = f.session({ taskContext: { purpose: 'planning' } }), context = read(session);
    assert.deepEqual(context.data.resolution, actual);
    assert.deepEqual(context.data.capability!.actions, f.program.capability().actions);
    assert.deepEqual(context.data.capability!.ontologyRef, f.program.capability().ontologyRef);
    assert(context.data.graph.objects.some(object => object.ref.type === 'ResolutionContext'));
    assert.equal(context.data.graph.objects.filter(object => object.ref.type === 'PreparedCandidate').length, 2);
    assert(!JSON.stringify(context).includes('PRIVATE_'));
    accept(session); session.finish();
    const next: PreparedResolution = { candidates: [{ ...actual.candidates[0]!, id: 'new-candidate' }], scope: { ...actual.scope, searchedBindingRefs: [actual.candidates[0]!.binding.ref] } };
    projectPreparedResolution(f.store.ontology, owner, request, next, f.program.capability());
    assert.deepEqual(readPreparedResolution(f.store.ontology, owner, f.job.id)!.candidates.map(item => item.id), ['new-candidate']);
    assert.equal(read(f.session({ taskContext: { purpose: 'planning' } })).data.graph.objects.filter(object => object.ref.type === 'PreparedCandidate').length, 1, 'Current context does not re-import historical prepared alternatives');
  } finally { f.store.close(); }
});

test('prepared resolution rejects cross-task references and detects changed public candidate evidence', () => {
  const f = fixture();
  try {
    const request = f.store.get(owner, f.job.id).delegation!.request, other = f.submit('PRIVATE_PREPARATION_OTHER_TASK'), now = new Date().toISOString();
    const candidate = { id: 'candidate', binding: { ...fixtureBinding('synthetic'), capabilityRef: f.program.ref }, status: 'ready' as const,
      input: { reference: { type: 'ServiceRequest', id: other.id } }, details: {}, facts: {}, evidenceRefs: [], requirementChecks: [], observedAt: now, expiresAt: now };
    const prepared: PreparedResolution = { candidates: [candidate], scope: { capabilityRef: f.program.ref, searchedBindingRefs: [candidate.binding.ref], observedAt: now, realSupply: false } };
    assert.throws(() => projectPreparedResolution(f.store.ontology, owner, request, prepared), /another task/);
    candidate.input.reference.id = f.job.id;
    projectPreparedResolution(f.store.ontology, owner, request, prepared);
    const context = f.store.ontology.related(owner, { type: 'ServiceRequest', id: f.job.id }, 'currentResolution', { remaining: 1000 })![0]!;
    const object = f.store.ontology.related(owner, context.ref, 'candidates', { remaining: 1000 })![0]!;
    f.store.ontology.ingest(owner, { objects: [{ ref: object.ref, expectedRevision: object.revision, properties: { ...object.properties, facts: { conditions: ['invented'] } } }] }, object.source);
    assert.throws(() => readPreparedResolution(f.store.ontology, owner, f.job.id), /evidence changed/);
  } finally { f.store.close(); }
});

test('a long task reads a compact business context and can explicitly inspect older plan nodes', t => {
  const f = fixture();
  try {
    const binding = f.agent(), job = f.store.get(owner, f.job.id), state = job.delegation!.agent!, request = job.delegation!.request;
    for (let sequence = 1; sequence <= 24; sequence++) {
      const input = { scope: state.scope, merchantId: 'coffee', query: `query-${sequence}`, limit: 1 };
      const chosen = { id: 'search', action: 'SearchPublicCatalog', argumentsJson: JSON.stringify(input), dependsOn: [], inputRefs: [] };
      const body: Omit<AgentActionPlan, 'digest'> = { id: `plan-${sequence}`, version: '2', sequence, requestId: request.id, requestRevision: request.revision,
        programRef: state.programRef, programDigest: state.programDigest, scope: state.scope, scopeDigest: digest(f.store.ontology.read(owner, state.scope).properties),
        modelRunId: `synthetic-run-${sequence}`, modelDecision: { kind: 'execute', requestRevision: request.revision, message: 'Synthetic historical choice', steps: [chosen], completionJson: '' },
        reasoning: 'Synthetic historical choice', createdAt: job.createdAt, steps: [{ ...chosen, input, effect: 'read', operationKey: `operation-${sequence}`, definitionDigest: digest(f.store.ontology.model.action(chosen.action)), intentId: `intent-${sequence}` }],
        ontologyPlanning: templatePlanning(request, businessModel.ref) };
      state.plans.push({ ...body, digest: digest(body) });
    }
    state.pendingPlanId = 'plan-24'; f.store.save(owner, job);
    const query=f.store.ontology.query.bind(f.store.ontology);let planReads=0;
    t.mock.method(f.store.ontology,'query',(...args:Parameters<typeof query>)=>{
      const input=args[1];if('from' in input && input.from.type==='ExecutionContext' && input.link==='plans')planReads++;
      return query(...args);
    });
    const session = f.session(binding), context = read(session);
    assert.equal(planReads,1,'Selecting recent plans does not read the complete history twice');
    assert.equal(context.data.execution!.history.planCount, 24);
    assert.equal(context.data.execution!.history.omittedPlanCount, 22);
    assert.equal(context.data.execution!.plans.length, 2);
    assert(!context.data.graph.objects.some(object => ['ExecutionAttempt', 'ExecutionResult', 'ExecutionInput', 'RegisteredActionType', 'ActionBinding'].includes(object.ref.type)));
    assert(Buffer.byteLength(JSON.stringify(context.data)) < 100000, 'Audit history must not consume the default context');
    const older = context.data.execution!.history.olderPlanRefs[0]!;
    assert(!session.lastReceipt()!.deliveredObjects!.some(object => object.ref.id === older.id));
    const queried = session.call('query_ontology', { object: older }) as { items: { ref: { id: string } }[] };
    assert.equal(queried.items[0]!.ref.id, older.id);
    const steps = session.call('query_ontology', { from: older, link: 'steps' }) as { items: { ref: { type: string } }[] };
    assert.equal(steps.items[0]!.ref.type, 'ExecutionStep');
    accept(session); const snapshot = session.finish();
    assert(snapshot.deliveredObjects!.some(object => object.ref.id === older.id), 'Only the explicit model query makes omitted history a delivered read');
  } finally { f.store.close(); }
});

test('mutable source readiness does not create a different registered capability definition or grant authority', () => {
  const f = fixture();
  try {
    const summaries = f.catalog.summaries(owner), request = { type: 'ServiceRequest', id: f.job.id };
    const before = f.store.ontology.related(owner, request, 'capabilities', { remaining: 1000 })![0]!;
    for (const state of ['connected', 'expired']) {
      projectCapabilityCatalog(f.store.ontology, owner, f.job.id, summaries.map(summary => ({ ...summary, sourceAuthorization: { provider: 'synthetic', state, nextAction: 'runtime_check' } })));
      const after = f.store.ontology.related(owner, request, 'capabilities', { remaining: 1000 })![0]!;
      assert.deepEqual(after.ref, before.ref); assert.equal(after.revision, before.revision);
      assert.equal(after.properties.sourceAuthorization, undefined);
      assert.equal(read(f.session()).data.capabilities[0]!.sourceAuthorization, undefined);
    }
  } finally { f.store.close(); }
});

test('active request context follows specification membership without reviving superseded assertions', () => {
  const f = fixture();
  try {
    const before = read(f.session()), instruction = before.data.graph.objects.find(object => object.ref.type === 'RequestInstruction')!.ref;
    const job = f.store.get(owner, f.job.id), requirement = job.delegation!.request.requirements[0]!;
    assert.equal(requirement.kind, 'condition');
    if (requirement.kind === 'condition') requirement.expected.predicate = 'catalog.public_only';
    f.store.save(owner, job);
    const after = read(f.session());
    const constraints = after.data.graph.objects.filter(object => object.ref.type === 'RequestConstraint');
    assert.equal(constraints.length, 1);
    assert.deepEqual(constraints[0]!.properties.expected, { predicate: 'catalog.public_only' });
    assert.deepEqual(after.data.graph.objects.find(object => object.ref.type === 'RequestInstruction')!.ref, instruction);
    assert(f.store.ontology.query(owner, { from: after.data.requestRef, link: 'constraints' }).items.length > 1, 'Superseded assertions remain queryable as history but not current facts');
  } finally { f.store.close(); }
});

test('task context verifies projected action semantics against the registered definition', () => {
  const f = fixture();
  try {
    const binding = f.agent(), original = read(f.session(binding));
    const action = original.data.graph.unreadRefs.find(ref => ref.type === 'RegisteredActionType')!;
    const value = f.store.ontology.read(owner, action);
    f.store.ontology.ingest(owner, { objects: [{ ref: action, expectedRevision: value.revision, properties: { ...value.properties, description: 'Invented executable authority' } }] }, value.source);
    const rejected = f.session(binding).call('read_task_context', {}) as { error: string; message: string };
    assert.equal(rejected.error, 'CONFLICT');
    assert.match(rejected.message, /definition.*changed/);
  } finally { f.store.close(); }
});

test('prepared candidates expose their exact business subject through typed traversal and reject foreign subjects', () => {
  const f = fixture();
  try {
    const domain = domainFixture('hotel'), request = f.store.get(owner, f.job.id).delegation!.request, capability = domainCapability('hotel');
    const projected = projectDomainSnapshot(f.store.ontology, owner, domainCapabilityId('hotel'), request, domain.parameters, { ...domain.snapshot, requestId: request.id });
    assert(projected.subject);
    const now = new Date().toISOString(), candidate = { id: 'hotel', binding: { ...fixtureBinding('hotel'), capabilityRef: capability.ref }, status: 'ready' as const,
      input: domain.parameters, details: {}, facts: {}, evidenceRefs: ['synthetic-hotel'], requirementChecks: [], observedAt: now, expiresAt: new Date(Date.now() + 600000).toISOString(), ontologySubject: projected.subject };
    const resolution: PreparedResolution = { candidates: [candidate], scope: { capabilityRef: capability.ref, searchedBindingRefs: [candidate.binding.ref], observedAt: now, realSupply: false } };
    projectPreparedResolution(f.store.ontology, owner, request, resolution, capability);
    const session = f.session({ taskContext: { purpose: 'planning' } }), context = read(session);
    const actions = context.data.definitions.bundle.actions as { id: string; providerOperation?: string; submissionCriteria: string[] }[];
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.id, serviceDomain('hotel').action);
    assert.equal(actions[0]!.providerOperation, 'domain.hotel.submit');
    assert(actions[0]!.submissionCriteria.includes('eligible_option'));
    const wrapper = context.data.graph.objects.find(object => object.ref.type === 'PreparedCandidate')!;
    const related = session.call('query_ontology', { from: wrapper.ref, link: 'subject' }) as { items: { ref: { type: string; id: string } }[] };
    assert.deepEqual(related.items[0]!.ref, projected.subject);
    const evaluation = session.call('evaluate_ontology', { function: serviceDomain('hotel').eligibleFunction, object: projected.subject }) as { status: string; value: { status: string } };
    assert.equal(evaluation.status, 'known'); assert.equal(evaluation.value.status, 'satisfied');
    const foreign = f.submit('Other hotel request'), original = f.store.ontology.read(owner, projected.subject), foreignRef = { type: original.ref.type, id: randomUUID() };
    const links = f.store.ontology.model.sides(original.ref.type).filter(side => side.direction === 'forward').flatMap(side =>
      (f.store.ontology.related(owner, original.ref, side.side.name, { remaining: 1000 }) ?? []).map(target => ({ type: side.link.id, from: foreignRef,
        to: side.side.name === 'request' ? { type: 'ServiceRequest', id: foreign.id } : target.ref })));
    f.store.ontology.ingest(owner, { objects: [{ ref: foreignRef, properties: { ...original.properties, [f.store.ontology.model.object(original.ref.type).primaryKey]: foreignRef.id } }], links }, original.source);
    assert.throws(() => projectPreparedResolution(f.store.ontology, owner, request, { ...resolution, candidates: [{ ...candidate, ontologySubject: foreignRef }] }, capability), /another task/);
  } finally { f.store.close(); }
});

test('a valid long request is read incrementally with exact source coverage, without reducing current facts', async () => {
  const f = fixture();
  try {
    const goal = 'GOAL:  ' + '初'.repeat(9000);
    let job = f.submit(goal);
    for (let index = 0; index < 24; index++) job = f.tasks.amend(principal, { taskId: job.id, requestId: randomUUID(), expectedRevision: job.revision!,
      answer: 'EDIT:  ' + '改'.repeat(3798) + String(index).padStart(2, '0') });
    const full = readOntologyRequest(f.store.ontology, owner, job.id);
    assert.equal(goal.length, 9007); assert.equal(full.messages.length, 25); assert.equal(full.messages[1]!.text.length, 3807);
    const makeSession = () => new OntologyPlanningSession(f.store.ontology, owner, full, [], undefined, undefined, 'request', [], { taskContext: { purpose: 'grounding' } });
    const initialSession = makeSession(), initial = read(initialSession);
    assert.equal(initial.data.request.originalGoal, goal);
    assert.deepEqual(initial.data.request.requirements, full.requirements);
    assert.equal(initial.data.instructions.complete, false);
    assert(initial.data.request.messages.length < full.messages.length);
    assert(Buffer.byteLength(JSON.stringify(initial.data)) < 180000);
    assert.throws(() => initialSession.acceptReceipts([initial.receipt.id]), /remaining original instruction pages/);
    const metadataRef = initial.data.graph.unreadRefs.find(ref => ref.type === 'RequestInstruction')!;
    initialSession.call('query_ontology', { object: metadataRef, select: ['messageId'] });
    assert.deepEqual(initialSession.lastReceipt()!.instructionRefs, []);
    assert.throws(() => accept(initialSession), /remaining original instruction pages/, 'Metadata-only reads cannot claim instruction coverage');
    const foreignSession = f.session(); read(foreignSession);
    assert.equal((foreignSession.call('read_task_instructions', { cursor: initial.data.instructions.nextCursor }) as { error: string }).error, 'FORBIDDEN');

    const delivered = new Map<string, string>(), session = makeSession(); let calls = 0;
    const model = { runStructured: async (prompt: string) => {
      calls++;
      const packet = JSON.parse(prompt.split('\n\n').at(-1)!) as { conversation: { call: { tool: string }; result: any; receipt: { id: string } }[] };
      let output: unknown;
      if (!packet.conversation.length) output = { kind: 'read', calls: [{ tool: 'read_task_context', argumentsJson: '{}' }], receiptIds: [], finalJson: '' };
      else {
        const context = packet.conversation[0]!.result.data as TaskContextPayload;
        for (const message of context.request.messages) delivered.set(message.id, message.text);
        if (context.instructions.originalGoalSource) delivered.set(context.instructions.originalGoalSource.messageId, context.request.originalGoal);
        const pages = packet.conversation.filter(turn => turn.call.tool === 'read_task_instructions');
        for (const page of pages) for (const item of page.result.items) delivered.set(item.properties.messageId, item.properties.text);
        const cursor = pages.length ? pages.at(-1)!.result.page.nextCursor : context.instructions.nextCursor;
        output = cursor ? { kind: 'read', calls: [{ tool: 'read_task_instructions', argumentsJson: JSON.stringify({ cursor, limit: 20 }) }], receiptIds: [], finalJson: '' }
          : { kind: 'final', calls: [], receiptIds: packet.conversation.map(turn => turn.receipt.id), finalJson: JSON.stringify({ requestRevision: context.request.revision }) };
      }
      return { output, evidence: evidence() };
    } };
    await reasonWithOntology(model, 'Interpret the entire owned request through the current Ontology context and original instruction pages.', {}, session, new AbortController().signal, () => {});
    assert(calls <= 8, `Long request should fit the existing reasoning bound, used ${calls}`);
    assert.deepEqual([...delivered].sort(), full.messages.map(message => [message.id, message.text]).sort());
    const snapshot = session.finish();
    assert.equal(snapshot.context!.instructionCount, 25);
    assert(snapshot.reads.some(receipt => receipt.tool === 'read_task_instructions'));
  } finally { f.store.close(); }
});
