import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { observationRuntimeFixture } from './fixtures/observation-runtime.js';
import { sourceProof } from '../packages/ontology/object-evidence.js';
import { JobStore } from '../packages/core/store.js';
import { ObservationRuntime } from '../packages/coordinator/observation-runtime.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { Worker } from '../apps/worker/worker.js';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../apps/gateway/mcp.js';
import { A2AGateway, AgentUser } from '../apps/gateway/a2a.js';
import { AgentCard, GetTaskRequest, SendMessageRequest } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import type { TaskSummary } from '../packages/core/task-summary.js';

test('bound observations use the existing lease, update canonical facts, preserve completed tasks and avoid models', async () => {
  const f = observationRuntimeFixture();
  try {
    assert.equal(f.active.observation!.monitoring, false);
    const original = f.jobs.get(f.owner, f.original.id), first = await f.tick();
    assert.equal(first.observation!.monitoring, true, JSON.stringify(first)); assert.equal(first.observation!.targetIdentity, 'verified');
    assert.equal(f.reads(), 1); assert.equal(f.modelInputs.length, 0); assert.equal(f.sourceCalls(), 0);
    assert.equal(f.jobs.security.workAuthority(f.owner, f.guardian.id), undefined, 'Observer work never gains the generic business executor');
    const producer = f.jobs.observationProducer(f.release), fact = f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event)!;
    assert.equal(fact.health, 'fresh'); assert(sourceProof(producer, f.owner, f.event, { remaining: 1000 }));
    f.due(); await f.tick();
    const refreshed = f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event)!;
    assert.equal(refreshed.semanticRevision, fact.semanticRevision); assert.equal(producer.readPrivate(f.owner, f.event).revision, 1);
    f.change('New venue event'); f.due(); await f.tick();
    assert.equal(producer.readPrivate(f.owner, f.event).properties.title, 'New venue event');
    assert.deepEqual(f.jobs.get(f.owner, f.original.id), original);
    assert(f.jobs.pipelineFacts.changes(f.owner, f.guardian.id, 1).some(change => change.fields.includes('title')));
    assert.equal(f.jobs.watchContracts.get(f.owner, f.guardian.id).usage.reads, 3);
    assert.equal(f.modelInputs.length, 0);
  } finally { f.close(); }
});

test('lease expiry fences an old reader while a new Worker safely continues without resetting counters', async () => {
  const f = observationRuntimeFixture();
  try {
    f.gate(); const first = f.claim()!, pending = f.runtime.run(first, new AbortController().signal);
    await new Promise(done => setTimeout(done, 0));
    assert.equal(f.claim(), undefined, 'The same watch cannot be concurrently claimed');
    f.db.prepare('UPDATE work_claims SET expires_at=? WHERE job_id=?').run(Date.now() - 1, f.guardian.id);
    const second = f.claim()!; assert(second); assert.notEqual(first.token, second.token);
    f.unblock(); await pending;
    assert.equal(f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event), undefined);
    await f.runtime.run(second, new AbortController().signal); f.jobs.release(second);
    assert.equal(f.reads(), 2); assert.equal(f.jobs.watchContracts.get(f.owner, f.guardian.id).usage.reads, 2);
    assert.equal(f.tasks.get(f.p, f.guardian.id).observation!.monitoring, true);
  } finally { f.close(); }
});

test('source revocation during I/O prevents acceptance and leaves the controller able to cancel', async () => {
  const f = observationRuntimeFixture();
  try {
    f.gate(); const work = f.claim()!, pending = f.runtime.run(work, new AbortController().signal);
    await new Promise(done => setTimeout(done, 0));
    const contract = f.jobs.watchContracts.get(f.owner, f.guardian.id);
    f.policy.revokeSource(f.owner, f.a.id, contract.pins.sourceBindingId, f.policy.revision());
    f.unblock(); await pending; f.jobs.release(work);
    assert.equal(f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event), undefined);
    assert.equal(f.tasks.get(f.p, f.guardian.id).observation!.monitoring, false);
    assert.equal(f.tasks.cancel(f.p, f.guardian.id).state, 'canceled');
    assert.equal(f.jobs.get(f.owner, f.original.id).state, 'completed');
  } finally { f.close(); }
});

test('inbox acceptance, fact update, dependency wake and receipt commit atomically across a write failure', async () => {
  const f = observationRuntimeFixture();
  try {
    f.db.exec("CREATE TRIGGER fail_observation_receipt BEFORE INSERT ON observation_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
    await f.tick();
    assert.equal(f.reads(), 1); assert(f.jobs.watchContracts.queued(f.owner, f.guardian.id));
    assert.equal(f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event), undefined, 'Failed receipt rolls back the canonical fact');
    f.db.exec('DROP TRIGGER fail_observation_receipt'); f.due(); await f.tick();
    assert.equal(f.reads(), 1, 'The same durable inbox item is accepted without another source call');
    assert.equal(f.jobs.watchContracts.queued(f.owner, f.guardian.id), undefined);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM observation_receipts').get()!.n, 1);
  } finally { f.close(); }
});

test('lifetime read limits remain exhausted after explicit resume and do not become a new task window', async () => {
  const f = observationRuntimeFixture({ maxReads: 2 });
  try {
    await f.tick(); f.due(); await f.tick(); f.due(); await f.tick();
    const task = f.tasks.get(f.p, f.guardian.id), usage = f.jobs.watchContracts.get(f.owner, f.guardian.id).usage;
    assert.equal(task.state, 'paused'); assert.equal(f.reads(), 2); assert.equal(usage.reads, 2);
    assert.throws(() => f.tasks.activateObservationContract(f.p, { action: 'activate_observation_contract', taskId: task.id, expectedRevision: task.revision, requestId: randomUUID() }), /budget.*exhausted/i);
    assert.deepEqual(f.jobs.watchContracts.get(f.owner, f.guardian.id).usage, usage);
  } finally { f.close(); }
});

test('a wrong account or missing native ordering proof never becomes a canonical observation', async () => {
  const f = observationRuntimeFixture();
  try {
    f.flags.wrongAccount = true; await f.tick();
    assert.equal(f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event), undefined);
    f.flags.wrongAccount = false; f.flags.noVersion = true; f.due(); await f.tick();
    assert.equal(f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event), undefined);
    f.due(); await f.tick();
    assert.equal(f.tasks.get(f.p, f.guardian.id).state, 'paused', 'Three unchanged failures stop this retry path');
    assert.equal(f.modelInputs.length, 0);
  } finally { f.close(); }
});

test('the actual Worker routes guardian claims to the observer without entering its model coordinator', async () => {
  const f = observationRuntimeFixture(); let models = 0;
  const worker = new Worker(f.jobs, { coordinator: { run: async () => { models++; throw new Error('Observer may not plan'); } }, observation: f.runtime, pollMs: 20, leaseMs: 30000 });
  try {
    worker.start(); const deadline = Date.now() + 30000;
    while (!f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
    assert.equal(f.tasks.get(f.p, f.guardian.id).observation!.monitoring, true); assert.equal(models, 0);
    f.tasks.cancel(f.p, f.guardian.id);
  } finally { await worker.close(); f.close(); }
});

test('MCP and A2A hints, status and cancellation share one persistent active observer', async () => {
  const f = observationRuntimeFixture(), server = createMcpServer(f.tasks, f.p), client = new Client({ name: 'observer-runtime', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a); await f.tick();
    const gateway = new A2AGateway(f.tasks, AgentCard.fromJSON({})), ctx = new ServerCallContext({ user: new AgentUser(f.p) });
    const message = { action: 'report_observation_change', eventId: 'native-hint', contentDigest: 'c'.repeat(64) };
    await gateway.sendMessage(SendMessageRequest.fromJSON({ configuration: { returnImmediately: true }, message: { role: 'ROLE_USER', messageId: randomUUID(), taskId: f.guardian.id, parts: [{ data: message }] } }), ctx);
    const hinted = await client.callTool({ name: 'get_task', arguments: { taskId: f.guardian.id } });
    assert.equal((hinted.structuredContent as { result: TaskSummary }).result.observation!.monitoring, false);
    f.change('Readback after authenticated hint'); await f.tick();
    const native = await gateway.getTask(GetTaskRequest.fromJSON({ id: f.guardian.id }), ctx);
    assert.equal((native.metadata?.observation as { monitoring: boolean }).monitoring, true);
    const encoded = JSON.stringify(native); assert(!encoded.includes('PRIVATE_ACCOUNT')); assert(!encoded.includes('PRIVATE_NATIVE'));
    await client.callTool({ name: 'cancel_task', arguments: { taskId: f.guardian.id } });
    assert.equal(f.tasks.get(f.p, f.guardian.id).observation!.runtime!.state, 'revoked');
  } finally { await client.close(); await server.close(); f.close(); }
});

test('old native versions cannot overwrite current facts and same-version conflicts pause the observer', async () => {
  const f = observationRuntimeFixture();
  try {
    await f.tick(); f.change('Version two', 2); f.due(); await f.tick();
    f.change('Out-of-order older value', 1); f.due(); await f.tick();
    assert.equal(f.jobs.observationProducer(f.release).readPrivate(f.owner, f.event).properties.title, 'Version two');
    assert.equal(f.tasks.get(f.p, f.guardian.id).observation!.monitoring, false);
    f.change('Conflicting version two', 2); f.due(); await f.tick();
    const current = f.tasks.get(f.p, f.guardian.id);
    assert.equal(current.state, 'paused'); assert.equal(current.observation!.runtime!.health, 'conflicted');
    assert.equal(f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event)!.health, 'conflicted');
    assert.equal(f.jobs.get(f.owner, f.original.id).state, 'completed');
  } finally { f.close(); }
});

test('abort releases an unresponsive read and retains only a late audit when it eventually returns', async () => {
  const f = observationRuntimeFixture();
  try {
    f.gate(); const work = f.claim()!, controller = new AbortController(), pending = f.runtime.run(work, controller.signal);
    await new Promise(done => setTimeout(done, 0)); controller.abort(); await pending; f.jobs.release(work);
    assert.equal(f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event), undefined);
    f.unblock(); await new Promise(done => setTimeout(done, 0));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM observation_late_results').get()!.n, 1);
    assert.equal(f.jobs.watchContracts.get(f.owner, f.guardian.id).usage.reads, 1);
  } finally { f.unblock(); f.close(); }
});

test('missed polling and the original horizon show stale/ended without creating a successful business result', async t => {
  const f = observationRuntimeFixture();
  try {
    await f.tick(); const usage = f.jobs.watchContracts.get(f.owner, f.guardian.id).usage;
    f.coordinator.close(); t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 30000 }); f.coordinator.start();
    assert.equal(f.tasks.get(f.p, f.guardian.id).observation!.monitoring, false, 'A missed poll is stale even before the source TTL');
    f.coordinator.close(); t.mock.timers.setTime(Date.now() + 300000); f.coordinator.start(); f.runtime.maintain();
    const ended = f.tasks.get(f.p, f.guardian.id);
    assert.equal(ended.state, 'paused'); assert.equal(ended.observation!.status, 'expired'); assert.equal(ended.observation!.runtime!.state, 'ended');
    assert.equal(ended.artifact, undefined); assert.deepEqual(ended.observation!.usage, usage);
    assert.equal(f.jobs.get(f.owner, f.original.id).state, 'completed');
  } finally { f.close(); }
});

test('accepted changes wake dependent open tasks atomically while completed tasks retain their original state', async () => {
  const f = observationRuntimeFixture();
  try {
    await f.tick(); const consumer = f.task(f.a.id).job;
    consumer.state = 'working'; consumer.delegation!.nextAt = Date.now() + 600000; f.jobs.save(f.owner, consumer);
    f.jobs.transaction(() => f.jobs.pipelineFacts.track(f.owner, f.release.ontologyId, consumer.id, 1, 'calendar', f.event, ['title']));
    f.db.exec("CREATE TRIGGER fail_observer_wake BEFORE INSERT ON observation_receipts BEGIN SELECT RAISE(ABORT,'synthetic wake failure'); END");
    f.change('Changed event'); f.due(); await f.tick();
    assert.equal(f.jobs.get(f.owner, consumer.id).delegation!.nextAt, consumer.delegation!.nextAt);
    assert.equal(f.jobs.pipelineFacts.changes(f.owner, consumer.id, 1).length, 0);
    f.db.exec('DROP TRIGGER fail_observer_wake'); f.due(); await f.tick();
    assert.equal(f.jobs.get(f.owner, consumer.id).delegation!.nextAt, 0);
    assert(f.jobs.pipelineFacts.changes(f.owner, consumer.id, 1).some(change => change.componentId === 'calendar' && change.fields.includes('title')));
    assert.equal(f.reads(), 2); assert.equal(f.jobs.get(f.owner, f.original.id).state, 'completed');
  } finally { f.close(); }
});

test('a durable inbox survives a process restart without repeating a source read', async () => {
  const f = observationRuntimeFixture();
  try {
    const work = f.claim()!;
    const source = f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event);
    const ticket = f.jobs.transaction(() => f.jobs.watchContracts.begin(f.owner, f.guardian.id, work.token, source?.revision ?? 0, f.adapter.maximumCost));
    const sample = await f.adapter.read({ owner: f.owner, target: f.jobs.watchContracts.runtime(f.owner, f.guardian.id)!.target, input: f.input().read.input, operationId: ticket.id, startedAt: ticket.startedAt, assertAuthorized: () => {} }, new AbortController().signal);
    f.jobs.transaction(() => f.jobs.watchContracts.enqueue(ticket, sample)); f.jobs.release(work);
    const reader = new JobStore(f.database, { securityMode: 'foundation' });
    try {
      const catalog = new ExecutionCatalog([f.program.capability()], [], [], [], [f.program], undefined, reader.security), runtime = new ObservationRuntime(reader, catalog), resumed = reader.claim(['eigos.delegate'], 30000)!;
      assert(resumed); await runtime.run(resumed, new AbortController().signal); reader.release(resumed);
      assert.equal(f.reads(), 1); assert.equal(reader.watchContracts.queued(f.owner, f.guardian.id), undefined);
      assert.equal(reader.pipelineFacts.current(f.owner, f.release.ontologyId, f.event)!.health, 'fresh');
    } finally { reader.close(); }
  } finally { f.close(); }
});

test('cancellation fences a late response without changing current facts or resetting the lifetime budget', async () => {
  const f = observationRuntimeFixture();
  try {
    f.gate(); const work = f.claim()!, pending = f.runtime.run(work, new AbortController().signal);
    await new Promise(done => setTimeout(done, 0));
    const before = f.jobs.watchContracts.get(f.owner, f.guardian.id).usage;
    f.tasks.cancel(f.p, f.guardian.id); f.unblock(); await pending; f.jobs.release(work);
    assert.equal(f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event), undefined);
    assert.deepEqual(f.jobs.watchContracts.get(f.owner, f.guardian.id).usage, before);
    assert.equal(f.tasks.get(f.p, f.guardian.id).observation!.monitoring, false);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM observation_receipts WHERE json_extract(body,'$.kind')='late'").get()!.n, 1);
  } finally { f.close(); }
});

test('authenticated hints are deduplicated and only trigger independent source readback', async () => {
  const f = observationRuntimeFixture();
  try {
    await f.tick(); const old = f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event)!;
    const hint = { action: 'report_observation_change', taskId: f.guardian.id, requestId: randomUUID(), eventId: 'hint-1', contentDigest: 'a'.repeat(64) };
    f.tasks.reportObservationChange(f.p, hint); f.tasks.reportObservationChange(f.p, hint);
    assert.equal(f.jobs.watchContracts.runtime(f.owner, f.guardian.id)!.hintSequence, 1);
    assert.equal(f.tasks.get(f.p, f.guardian.id).observation!.monitoring, false);
    assert.equal(f.jobs.pipelineFacts.current(f.owner, f.release.ontologyId, f.event)!.semanticRevision, old.semanticRevision);
    assert.throws(() => f.tasks.reportObservationChange(f.p, { ...hint, requestId: randomUUID(), contentDigest: 'b'.repeat(64) }), /Conflicting/);
    f.change('Independent source confirms change'); await f.tick();
    assert.equal(f.reads(), 2); assert.equal(f.tasks.get(f.p, f.guardian.id).observation!.monitoring, true);
  } finally { f.close(); }
});
