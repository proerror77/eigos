import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { Coordinator, type Reasoner } from '../packages/coordinator/coordinator.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { principal as basePrincipal, owner } from './backend-fixture.js';
import { publishManagedFixture } from './fixtures/dynamic-ontology.js';
import { executionReferenceLink } from '../packages/ontology/execution-model.js';
import type { Job } from '../packages/core/domain.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { createDynamicOntologyProgram } from '../packages/capabilities/dynamic-ontology.js';

const principal = { ...basePrincipal, scopes: basePrincipal.scopes.filter(scope => scope !== 'ontology:admin') };
const noModel: Reasoner = { ground: async () => { throw new Error('Caller managed actions must not fabricate a model decision'); }, plan: async () => { throw new Error('Caller managed actions must not invoke a model'); }, act: async () => { throw new Error('Caller managed actions must use their original caller envelope'); } };
function runtime(store: JobStore, selectedCatalog?: ExecutionCatalog) {
  const catalog = selectedCatalog ?? createExecutionCatalog({ store }), tasks = new TaskService(store, { catalog }), coordinator = new Coordinator(store, noModel, catalog);
  const approve = (job: Job) => {
    const authorization = job.delegation!.authorizationRequest!;
    assert.equal(authorization.environment, 'managed');
    if (!('objectWrite' in authorization)) throw new Error('Expected nonfinancial authorization');
    return tasks.authorize(principal, job.id, { action: 'approve_object_write', requestId: randomUUID(), planDigest: authorization.planDigest, objectWrite: authorization.objectWrite, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'managed' });
  };
  const run = async () => {
    const claim = store.claim(['eigos.delegate'], 15000); assert(claim, 'An authorized managed task must have a durable claim');
    await coordinator.run(claim, new AbortController().signal); return store.get(owner, claim.job.id);
  };
  return { tasks, coordinator, approve, run };
}

test('new action executes through caller plan, existing grant, Intent and independent managed readback', async () => {
  const store = new JobStore(':memory:');
  try {
    const f = publishManagedFixture(store, owner), r = runtime(store), command = { ontologyId: f.ontologyId, action: 'CreateOfficeAsset', input: { id: 'camera', label: 'Camera' }, requestId: randomUUID() };
    const waiting = r.tasks.prepareOntologyAction(principal, command);
    assert.equal(waiting.state, 'auth-required'); assert.equal(waiting.runs?.length, 0);
    assert.equal(f.graph.query(owner, { type: 'OfficeAsset' }).items.length, 0);
    assert.equal(r.tasks.prepareOntologyAction(principal, command).id, waiting.id, 'Preparation retry preserves original task and Intent');
    r.approve(waiting);
    const done = await r.run();
    assert.equal(done.state, 'completed', JSON.stringify({ error: done.error, feedback: done.delegation?.agent?.feedback, intents: store.intents(owner, done.id) }));
    assert.equal(done.runs?.length, 0); assert.equal(done.delegation!.acceptance!.accepted, true);
    assert.equal(f.graph.read(owner, { type: 'OfficeAsset', id: 'camera' }).revision, 1);
    const intent = store.intents(owner, done.id)[0]!; assert.equal(intent.state, 'effect_confirmed'); assert.equal(store.attempts(owner, intent.id).length, 1);
    assert.equal(store.grants(owner, done.id)[0]!.kind, 'object_write'); assert.equal(store.budget(owner, done.id).length, 0);
    const step = f.graph.query(owner, { type: 'ExecutionStep', where: [{ property: 'intentId', op: 'eq', value: intent.id }] }).items[0]!;
    assert(step); const result = f.graph.query(owner, { from: step.ref, link: 'results' }).items[0]!;
    const output = f.graph.query(owner, { from: result.ref, link: executionReferenceLink('output', 'OfficeAsset').name });
    assert.equal(output.items[0]?.ref.id, 'camera', 'Custom type output participates in the ordinary execution graph');
    assert.equal((done.artifact!.data.result as { managedChanges: unknown[] }).managedChanges.length, 1);
    assert.equal(store.claim(['eigos.delegate'], 15000), undefined);
  } finally { store.close(); }
});

test('managed authorization cannot survive target changes or cross-owner access', async () => {
  const store = new JobStore(':memory:');
  try {
    const f = publishManagedFixture(store, owner), r = runtime(store);
    const first = r.tasks.prepareOntologyAction(principal, { ontologyId: f.ontologyId, action: 'CreateOfficeAsset', input: { id: 'camera', label: 'Camera' }, requestId: randomUUID() }); r.approve(first); await r.run();
    const command = { ontologyId: f.ontologyId, action: 'SetOfficeAssetStatus', input: { asset: { type: 'OfficeAsset', id: 'camera' }, expectedRevision: 1, status: 'requested' }, requestId: randomUUID() };
    assert.throws(() => r.tasks.prepareOntologyAction({ ...principal, subject: 'other' }, command), /access|available|owner/i);
    const waiting = r.tasks.prepareOntologyAction(principal, command);
    f.graph.ingest(owner, { objects: [{ ref: command.input.asset, properties: { id: 'camera', label: 'Renamed by owner', status: 'available' }, expectedRevision: 1 }] }, { kind: 'user', id: 'owner-change', observedAt: new Date().toISOString() });
    assert.throws(() => r.approve(waiting), /revision changed|changed/);
    assert.equal(f.graph.read(owner, command.input.asset).properties.status, 'available');
    assert.equal(store.intents(owner, waiting.id)[0]!.state, 'ready');
  } finally { store.close(); }
});

test('a committed managed action survives process restart without a repeated write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-managed-restart-')), path = join(directory, 'store.sqlite');
  let store = new JobStore(path);
  try {
    const f = publishManagedFixture(store, owner), r = runtime(store), command = { ontologyId: f.ontologyId, action: 'CreateOfficeAsset', input: { id: 'camera', label: 'Camera' }, requestId: randomUUID() };
    const waiting = r.tasks.prepareOntologyAction(principal, command); r.approve(waiting); const done = await r.run(); assert.equal(done.state, 'completed');
    const intentId = store.intents(owner, done.id)[0]!.id; store.close(); store = new JobStore(path);
    const restarted = runtime(store);
    assert.equal(restarted.tasks.prepareOntologyAction(principal, command).id, waiting.id);
    assert.equal(store.get(owner, waiting.id).state, 'completed');
    assert.equal(store.ontologyForJob(owner, waiting.id).read(owner, { type: 'OfficeAsset', id: 'camera' }).revision, 1);
    assert.equal(store.attempts(owner, intentId).length, 1); assert.equal(store.claim(['eigos.delegate'], 15000), undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('tombstoning a runtime-created managed object retains old execution evidence and current absence', async () => {
  const store = new JobStore(':memory:');
  try {
    const f = publishManagedFixture(store, owner), r = runtime(store);
    const first = r.tasks.prepareOntologyAction(principal, { ontologyId: f.ontologyId, action: 'CreateOfficeAsset', input: { id: 'camera', label: 'Camera' }, requestId: randomUUID() }); r.approve(first); const created = await r.run(); assert.equal(created.state, 'completed');
    const deletion = r.tasks.prepareOntologyAction(principal, { ontologyId: f.ontologyId, action: 'DeleteOfficeAsset', input: { asset: { type: 'OfficeAsset', id: 'camera' }, expectedRevision: 1 }, requestId: randomUUID() }); r.approve(deletion); const deleted = await r.run();
    assert.equal(deleted.state, 'completed', JSON.stringify({ error: deleted.error, feedback: deleted.delegation?.agent?.feedback, intents: store.intents(owner, deleted.id) }));
    assert.equal(f.graph.query(owner, { type: 'OfficeAsset' }).items.length, 0); assert.equal(f.graph.tombstone(owner, { type: 'OfficeAsset', id: 'camera' })?.revision, 2);
    assert.equal(store.get(owner, created.id).state, 'completed'); assert.equal(store.intents(owner, created.id)[0]!.state, 'effect_confirmed');
    assert.doesNotThrow(() => store.save(owner, store.get(owner, created.id)), 'Reprojecting original history preserves its protected tombstone reference');
  } finally { store.close(); }
});

test('interruption between managed apply and ledger commit rolls back effects and never replays during recovery', async () => {
  const store = new JobStore(':memory:');
  try {
    const f = publishManagedFixture(store, owner), r = runtime(store), command = { ontologyId: f.ontologyId, action: 'CreateOfficeAsset', input: { id: 'camera', label: 'Camera' }, requestId: randomUUID() };
    const waiting = r.tasks.prepareOntologyAction(principal, command); r.approve(waiting);
    const original = f.graph.applyManaged.bind(f.graph);
    f.graph.applyManaged = (...args) => { original(...args); throw new Error('Injected process interruption before observation commit'); };
    await r.run(); f.graph.applyManaged = original;
    assert.equal(f.graph.managedObject(owner, { type: 'OfficeAsset', id: 'camera' }), undefined);
    const intent = store.intents(owner, waiting.id)[0]!;
    assert.equal(intent.state, 'rejected'); assert.equal(store.attempts(owner, intent.id).length, 1);
    assert.equal(f.graph.managedObject(owner, { type: 'OfficeAsset', id: 'camera' }), undefined);
    assert.equal(r.tasks.prepareOntologyAction(principal, command).id, waiting.id);
  } finally { store.close(); }
});

test('committed mutation resumes after a lost completion lease using the original Intent only', async () => {
  const store = new JobStore(':memory:');
  try {
    const f = publishManagedFixture(store, owner), r = runtime(store);
    const waiting = r.tasks.prepareOntologyAction(principal, { ontologyId: f.ontologyId, action: 'CreateOfficeAsset', input: { id: 'camera', label: 'Camera' }, requestId: randomUUID() }); r.approve(waiting);
    const original = store.finish.bind(store); let interrupted = false;
    store.finish = (...args) => {
      if (!interrupted && store.intents(owner, waiting.id)[0]!.state === 'effect_confirmed') { interrupted = true; throw new Error('Injected interruption after observation commit'); }
      return original(...args);
    };
    await assert.rejects(r.run(), /after observation commit/); store.finish = original;
    assert.equal(f.graph.read(owner, { type: 'OfficeAsset', id: 'camera' }).revision, 1);
    const recoveredClaim = store.claim(['eigos.delegate'], 15000, Date.now() + 16000); assert(recoveredClaim);
    await r.coordinator.run(recoveredClaim, new AbortController().signal);
    const done = store.get(owner, waiting.id), intent = store.intents(owner, waiting.id)[0]!;
    assert.equal(done.state, 'completed'); assert.equal(intent.state, 'effect_confirmed'); assert.equal(store.attempts(owner, intent.id).length, 1);
    assert.equal(f.graph.read(owner, { type: 'OfficeAsset', id: 'camera' }).revision, 1);
  } finally { store.close(); }
});

test('cancellation after preview prevents graph commit and keeps the late response audit-only', async () => {
  const store = new JobStore(':memory:');
  try {
    const f = publishManagedFixture(store, owner); let tasks: TaskService;
    const catalog = new ExecutionCatalog([], [], [], [], [], (graph, caller) => {
      const program = createDynamicOntologyProgram(graph, caller);
      if (program) {
        const original = program.invoke.bind(program);
        program.invoke = async (...args) => { const response = await original(...args); tasks.cancel(principal, args[0].request.id); return response; };
      }
      return program;
    });
    const r = runtime(store, catalog); tasks = r.tasks;
    const waiting = tasks.prepareOntologyAction(principal, { ontologyId: f.ontologyId, action: 'CreateOfficeAsset', input: { id: 'camera', label: 'Camera' }, requestId: randomUUID() }); r.approve(waiting);
    const canceled = await r.run();
    assert.equal(canceled.state, 'canceled'); assert.equal(f.graph.managedObject(owner, { type: 'OfficeAsset', id: 'camera' }), undefined);
    const intent = store.intents(owner, canceled.id)[0]!; assert.notEqual(intent.state, 'effect_confirmed');
    assert.equal(store.observations(owner, intent.id).length, 1);
    if (canceled.delegation!.recoveryPending) {
      const recovery = store.claim(['eigos.delegate'], 15000, Date.now() + 16000); assert(recovery);
      await r.coordinator.run(recovery, new AbortController().signal);
    }
    assert.equal(store.get(owner, canceled.id).state, 'canceled'); assert.equal(f.graph.managedObject(owner, { type: 'OfficeAsset', id: 'camera' }), undefined);
  } finally { store.close(); }
});

test('an orphaned dispatch marker is reconciled as uncommitted without replaying a data write', async () => {
  const store = new JobStore(':memory:');
  try {
    const f = publishManagedFixture(store, owner), r = runtime(store);
    const waiting = r.tasks.prepareOntologyAction(principal, { ontologyId: f.ontologyId, action: 'CreateOfficeAsset', input: { id: 'camera', label: 'Camera' }, requestId: randomUUID() }); r.approve(waiting);
    const abandoned = store.claim(['eigos.delegate'], 15000); assert(abandoned);
    const original = store.intents(owner, waiting.id)[0]!;
    store.checkpoint(abandoned, () => { store.startAttempt(abandoned, original.id, 'dispatch', original.inputDigest); });
    assert.equal(store.intent(owner, original.id).state, 'dispatching');
    const recovery = store.claim(['eigos.delegate'], 15000, Date.now() + 16000); assert(recovery);
    await r.coordinator.run(recovery, new AbortController().signal);
    assert.equal(store.intent(owner, original.id).state, 'rejected'); assert.equal(store.attempts(owner, original.id).length, 1);
    assert.equal(f.graph.managedObject(owner, { type: 'OfficeAsset', id: 'camera' }), undefined);
    assert.equal(store.get(owner, waiting.id).delegation!.agent!.feedback.some(item => /did not commit/.test(item.message)), true);
  } finally { store.close(); }
});
