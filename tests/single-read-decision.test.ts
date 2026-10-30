import test from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../packages/core/store.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { CodexReasoner } from '../packages/coordinator/coordinator.js';
import { expandPromptData } from '../packages/coordinator/prompt-data.js';
import { assertGoalCoverage } from '../packages/ontology/goal-coverage.js';
import type { LegacyGrounding } from '../packages/core/delegation.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import { backend, evidence, owner } from './backend-fixture.js';
import { didiFixture, input } from './fixtures/didi.js';
import { didiDataflow, dataflowCompletion } from './fixtures/didi-dataflow.js';
import { runNativeDidiTask } from './fixtures/secured-didi.js';
import { DIDI_PROGRAM_REF } from '../packages/capabilities/didi/program.js';
import { DidiAgentProgram } from '../packages/capabilities/didi/program.js';
import { securityFixture } from './fixtures/security.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { bindPersonalSourceOwner } from '../packages/core/source-owner.js';
import { AuthorizationCoordinator } from '../packages/security/coordinator.js';
import { taskContextFields } from '../packages/security/task-context-contract.js';
import { TaskService } from '../packages/core/tasks.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { randomUUID } from 'node:crypto';

function readModel(mutate?: (decision: LegacyGrounding) => void) {
  let requests = 0;
  const model = { ontologyTransport: 'native-mcp' as const, ontologyContextPreparation: 'worker_snapshot' as const,
    runStructured: async (prompt: string, _schema: object, _signal: AbortSignal, options?: unknown) => {
      assert.equal(++requests, 1, 'No review, preparation, tool loop or completion model call');
      assert.deepEqual(options, { toolFree: true }, 'The executor must reject any hidden model tool loop');
      const packet = expandPromptData(JSON.parse(prompt.split('\n\n').at(-1)!)) as { request: ServiceRequest; ontology: { call: { tool: string }; result: unknown }[] };
      assert(packet.ontology.some(entry => entry.call.tool === 'read_task_context'));
      assert(packet.ontology.some(entry => entry.call.tool === 'describe_ontology'));
      assert(!packet.ontology.some(entry => entry.call.tool === 'discover_actions'));
      const request = packet.request;
      const decision: LegacyGrounding = { kind: 'resolve', requestRevision: request.revision, capabilityRef: DIDI_PROGRAM_REF,
        message: 'Use the registered read graph', inputJson: JSON.stringify(input), requirementsJson: '[]', conditionsJson: '[]',
        initialSteps: didiDataflow().map(step => ({ ...step, scopeInputs: ['scope'] })), plannedCompletion: dataflowCompletion,
        readPlan: { version: '1', criteria: request.messages.map((message, i) => ({ id: `estimate${i}`, description: 'Requested route estimate only',
          predicate: 'ride.estimate_observed', phase: 'quote', messageId: message.id, requirementIds: request.requirements.map(value => value.id) })) } };
      mutate?.(decision);
      return { output: { decisionJson: JSON.stringify(decision) }, evidence: evidence() };
    } };
  return { model, requests: () => requests };
}

function fixture(mutate?: (decision: LegacyGrounding) => void) {
  const source = didiFixture(), store = new JobStore(':memory:');
  const catalog = createExecutionCatalog({ store, didi: { ...source.binding, connector: source.connector } });
  const script = readModel(mutate), reasoner = new CodexReasoner(script.model), b = backend(catalog, reasoner, store);
  const task = b.submit({ goal: '查询北京西站到西二旗地铁站的车型估价，不下单、不付款。',
    locationContext: { city: input.city, origin: { name: input.origin, source: 'user_provided' }, destination: { name: input.destination, source: 'user_provided' } } });
  return { source, store, catalog, reasoner, b, task, requests: script.requests, close: () => { store.close(); source.close(); } };
}

test('one actual model invocation selects and completes a whole read graph through the Worker', { timeout: 120000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture();
  try {
    await runNativeDidiTask(f.store, f.b.coordinator, owner, f.task.id, t.signal, () => t.mock.timers.tick(20));
    const done = f.store.get(owner, f.task.id);
    assert.equal(done.state, 'completed', JSON.stringify({ error: done.error, recovery: done.delegation?.recovery, feedback: done.delegation?.agent?.feedback }));
    assert.equal(f.requests(), 1); assert.equal(done.runs!.length, 1);
    assert.deepEqual(done.runs![0]!.singleReadDecision, { version: '1', modelRequests: 1, toolsAvailable: false });
    assert.equal(done.delegation!.acceptance!.accepted, true);
    assert.equal(assertGoalCoverage(done, f.catalog.capability(DIDI_PROGRAM_REF)).reviewOrigin, 'ontology_read_contract');
    assert.deepEqual(f.source.calls.filter(call => call.method === 'tools/call').map(call => call.name).sort(), ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert(done.delegation!.agent!.plans.flatMap(plan => plan.steps).every(step => step.effect === 'read'));
    assert(!done.delegation!.ontologyReads!.some(read => read.tool === 'discover_actions'));
  } finally { f.close(); }
});

test('Foundation uses the same single decision with current source, field and channel authorization', { timeout: 180000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = securityFixture(), source = didiFixture(), program = new DidiAgentProgram(source.binding, { connector: source.connector });
  bindPersonalSourceOwner(program, f.owner);
  const catalog = new ExecutionCatalog([program.capability()], [], [], [], [program], undefined, f.jobs.security);
  f.coordinator.close();
  const manager = new AuthorizationCoordinator(f.jobs.security, f.members, f.jobs, catalog); manager.start();
  try {
    const installation = f.installation('single read'), policy = f.jobs.security.policies, profile = catalog.securityProfiles(f.owner)[0]!;
    const until = new Date(Date.now() + 3600000).toISOString(), channels = ['agent_response', 'registered_model'];
    const markings = ['member_private', 'personal_data', 'precise_location', 'financial', 'account_private'];
    const resources = [...new Set(['ServiceRequest', ...profile.outputTypes, ...Object.keys(taskContextFields)])].map(type => ({ type,
      fields: Object.keys(policy.fields(type)).filter(field => policy.fieldPolicy(type, field) !== 'internal_only') }));
    manager.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: [program.ref.id], resources, sourceBindingIds: [profile.bindingId], channels, expiresAt: until });
    policy.setRole({ subjectKind: 'installation', subjectId: installation.id, resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest }, role: 'Viewer',
      executeActions: program.actionIds, invokeFunctions: policy.model.definitionSnapshot().functions.map(fn => fn.id), expiresAt: until }, policy.revision());
    policy.setRecipient(installation.id, { classification: 'sensitive', markings, channels, expiresAt: until }, policy.revision());
    policy.setModelChannel('single-read-test', { classification: 'sensitive', markings, expiresAt: until }, policy.revision());
    policy.setSource(f.owner, { installationId: installation.id, bindingId: profile.bindingId, programId: program.ref.id, programDigest: program.configurationDigest,
      operations: program.actionIds, outputTypes: profile.outputTypes, expiresAt: until }, policy.revision());
    const principal = { ...f.principal, access: manager.authenticate(f.principal, installation.token) }, tasks = new TaskService(f.jobs, { catalog });
    const task = tasks.submit(principal, { service: 'eigos.delegate', requestId: randomUUID(), goal: '查询北京西站到西二旗地铁站的车型估价，不下单、不付款。' });
    const script = readModel(), reasoner = new CodexReasoner({ ...script.model, securityChannelId: 'single-read-test' });
    const coordinator = new Coordinator(f.jobs, reasoner, catalog);
    await runNativeDidiTask(f.jobs, coordinator, f.owner, task.id, t.signal, () => t.mock.timers.tick(20));
    const done = f.jobs.get(f.owner, task.id);
    assert.equal(done.state, 'completed', JSON.stringify({ error: done.error, recovery: done.delegation?.recovery, feedback: done.delegation?.agent?.feedback }));
    assert.equal(script.requests(), 1); assert.equal(done.runs!.length, 1);
    assert.equal(done.delegation!.acceptance!.accepted, true);
    assert.equal(source.calls.filter(call => call.method === 'tools/call').length, 3);
  } finally { manager.close(); f.close(); source.close(); }
});

for (const [name, mutate] of [
  ['a commitment disguised as a quote', (decision: LegacyGrounding) => { decision.readPlan!.criteria[0]!.phase = 'commitment'; }],
  ['an invented original message', (decision: LegacyGrounding) => { decision.readPlan!.criteria[0]!.messageId = 'invented'; }],
  ['an unregistered write', (decision: LegacyGrounding) => { decision.initialSteps![0]!.action = 'CreateDidiTestOrder'; }],
  ['a city that differs from current Ontology facts', (decision: LegacyGrounding) => { decision.inputJson = JSON.stringify({ ...input, city: '上海市' }); }],
  ['a missing original context message', (decision: LegacyGrounding) => { decision.readPlan!.criteria.pop(); }],
] as const) test(`programmatic read validation rejects ${name} before any provider call`, { timeout: 120000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture(mutate);
  try {
    await runNativeDidiTask(f.store, f.b.coordinator, owner, f.task.id, t.signal, () => t.mock.timers.tick(20));
    const done = f.store.get(owner, f.task.id);
    assert.notEqual(done.state, 'completed'); assert(!done.delegation?.acceptance?.accepted);
    assert.equal(f.requests(), 1);
    assert.equal(f.source.calls.filter(call => call.method === 'tools/call').length, 0);
  } finally { f.close(); }
});
