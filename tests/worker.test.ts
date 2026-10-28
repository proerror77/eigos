import { Worker } from '../apps/worker/worker.js';
import { ModelSessionError } from '../packages/capabilities/model-session.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { JobStore, type WorkClaim } from '../packages/core/store.js';
import { securityFixture } from './fixtures/security.js';
import { authorizationScope } from '../packages/security/context.js';
import { TaskService } from '../packages/core/tasks.js';
import { SCOPES, ownerKey, type Job, type Principal } from '../packages/core/domain.js';
import { readWorkerConfig } from '../packages/core/config.js';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import type { TaskSummary } from '../packages/core/task-summary.js';

const principal: Principal = { issuer: 'test', tenant: 'one', subject: 'alice', clientId: 'test', scopes: [...SCOPES] };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  while (true) {
    const value = await read(); if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for observable state: ${JSON.stringify(value)}`);
    await pause(25);
  }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await done; } finally { clearTimeout(timer); }
}

test('two database connections: exclusive claims, durable queue, expiry fencing and no replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-queue-')); const path = join(dir, 'tasks.sqlite');
  const a = new JobStore(path), b = new JobStore(path);
  const tasks = new TaskService(a, { catalog: createExecutionCatalog() });
  try {
    const job = tasks.submit(principal, { service: 'eigos.delegate', goal: 'fixture', requestId: 'one' });
    const claim = a.claim(['eigos.delegate'], 100, 1000)!; assert(claim);
    assert.equal(b.claim(['eigos.delegate'], 100, 1001), undefined);
    // The old lease is fenced; pre-dispatch technical recovery retains the original task.
    assert.equal(b.claim(['eigos.delegate'], 100, 1101), undefined);
    assert.equal(tasks.get(principal, job.id).state, 'working'); assert.equal(tasks.get(principal, job.id).delegation?.recovery?.state, 'scheduled');
    assert.equal(a.finish(claim, current => { current.state = 'completed'; }, 1102), false);
    assert.equal(a.renew(claim, 100, 1102), false);
    assert.equal(tasks.get(principal, job.id).artifact, undefined);
    const queued = tasks.submit(principal, { service: 'eigos.delegate', goal: 'queued', requestId: 'two' });
    assert.equal(b.get(ownerKey(principal), queued.id).state, 'submitted');
    assert.equal(b.claim(['eigos.delegate'], 100, 1200)?.job.id, queued.id);
    tasks.submit(principal, { service: 'eigos.delegate', goal: 'second slot', requestId: 'three' });
    tasks.submit(principal, { service: 'eigos.delegate', goal: 'waiting', requestId: 'four' });
    assert(a.claim(['eigos.delegate'], 100, 1201));
    assert.equal(b.claim(['eigos.delegate'], 100, 1202), undefined);

  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Queue lookup and queued-state persistence cannot consume the newly granted execution lease', t => {
  const store = new JobStore(':memory:'), tasks = new TaskService(store, { catalog: createExecutionCatalog() });
  let clock = 100000;
  t.mock.method(Date, 'now', () => clock);
  try {
    const job = tasks.submit(principal, { service: 'eigos.delegate', goal: 'fixture', requestId: 'delayed-claim' });
    const save = store.save.bind(store);
    t.mock.method(store, 'save', (...args: Parameters<JobStore['save']>) => { const result = save(...args); clock += 20000; return result; });
    const claim = store.claim(['eigos.delegate'], 15000)!;
    assert.equal(claim.job.id, job.id); assert(store.claimActive(claim)); assert(store.renew(claim, 15000));
  } finally { store.close(); }
});

test('A delayed renewal cannot revive a lease that expired while its task state was read', t => {
  const store = new JobStore(':memory:'), tasks = new TaskService(store, { catalog: createExecutionCatalog() });
  let clock = 100000, renewing = false;
  t.mock.method(Date, 'now', () => { const now = clock; if (renewing) clock += 20000; return now; });
  try {
    tasks.submit(principal, { service: 'eigos.delegate', goal: 'fixture', requestId: 'delayed-renewal' });
    const claim = store.claim(['eigos.delegate'], 15000)!;
    // Time passes after renewal starts, independently of whether task state is
    // read as a full Job or a scalar fence. The write must use a fresh deadline.
    renewing = true;
    assert.equal(store.renew(claim, 15000), false);
  } finally { store.close(); }
});

test('The actual idle Worker query uses its pending/recovery index instead of scanning historical task bodies', t => {
  const store = new JobStore(':memory:'), db = (store as unknown as { db: DatabaseSync }).db;
  const prepare = db.prepare.bind(db); let query = '';
  t.mock.method(db, 'prepare', (sql: string) => { if (sql.startsWith('SELECT owner,body FROM jobs WHERE')) query = sql; return prepare(sql); });
  try {
    assert.equal(store.claim(['eigos.delegate'], 15000), undefined); assert(query);
    const plan = prepare('EXPLAIN QUERY PLAN ' + query).all('eigos.delegate', BACKEND_VERSION, Date.now());
    assert(plan.some(row => String(row.detail).includes('jobs_worker_ready')), JSON.stringify(plan));
    assert(!plan.some(row => String(row.detail).includes('SCAN jobs')), JSON.stringify(plan));
  } finally { store.close(); }
});

test('synchronous progress keeps a second model-waiting claim alive without renewing revoked or expired work', async t => {
  const started = Date.now(); let clock = started;
  t.mock.method(Date, 'now', () => clock);
  const f = securityFixture(() => clock), active = new Map<string, { claim: WorkClaim; signal: AbortSignal; progress: () => void; release: () => void }>();
  const a = f.installation('Synchronous task'), b = f.installation('Waiting task');
  f.approve(a.id); f.approve(b.id);
  const heavy = f.task(a.id), waiting = f.task(b.id);
  const worker = new Worker(f.jobs, { leaseMs: 30000, pollMs: 60000, timeoutMs: 50000, coordinator: {
    run: async (claim, signal) => new Promise<void>(resolve => {
      active.set(claim.job.id, { claim, signal, progress: authorizationScope()!.assertCurrent, release: resolve });
    }),
  } });
  try {
    worker.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(active.size, 2);
    const busy = active.get(heavy.job.id)!, idle = active.get(waiting.job.id)!;
    // Native synchronous work still asserts its authority, while the event-loop
    // heartbeat for the other task cannot run. Advance time without timer ticks.
    for (const elapsed of [12000, 24000, 36000]) { clock = started + elapsed; busy.progress(); }
    assert.equal(f.jobs.claimActive(idle.claim), true, 'Progress must preserve the other unexpired claim before its timer can run');
    clock = started + 40000; f.coordinator.refresh();
    f.coordinator.revokeInstallation(f.member.id, b.id);
    clock = started + 48000; busy.progress();
    assert.equal(idle.signal.aborted, true); assert.equal(f.jobs.claimActive(idle.claim), false);
    assert.equal(busy.signal.aborted, false); assert.equal(f.jobs.claimActive(busy.claim), true);
    clock = started + 51000;
    assert.throws(busy.progress, /lease/i, 'Synchronous progress must also enforce the original execution timeout before its timer can run');
    assert.equal(busy.signal.aborted, true);
    clock = started + 79000;
    assert.throws(busy.progress, /ACCESS_REVOKED|lease/i);
    assert.equal(f.jobs.renew(busy.claim, 30000), false);
    assert.equal(f.jobs.finish(idle.claim, job => { job.state = 'completed'; }), false);
  } finally {
    for (const entry of active.values()) entry.release();
    await worker.close(); f.close();
  }
});

test('task projection binding reports progress before a long checkpoint loses its original lease', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const f = securityFixture(() => clock), install = f.installation('Projection progress');
  f.coordinator.approveAgentGrant(f.member.id, { installationId: install.id, capabilityIds: ['brief.prepare'],
    resources: [{ type: 'ServiceRequest', fields: ['requestId', 'originalGoal'] }, { type: 'RequestInstruction', fields: ['id', 'messageId', 'text'] }],
    sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt: new Date(clock + 3600000).toISOString() });
  const task = f.task(install.id), job = f.jobs.get(f.owner, task.job.id);
  job.delegation!.request.messages = ['first', 'second', 'third'].map(id => ({ id, text: `Synthetic ${id} instruction`, receivedAt: new Date(clock).toISOString() }));
  f.jobs.save(f.owner, job);
  const policy = f.jobs.security.policies, bind = policy.bind.bind(policy);
  let bindings = 0, applied = false;
  t.mock.method(policy, 'bind', (...args: Parameters<typeof policy.bind>) => { bind(...args); bindings++; clock += 6000; });
  const worker = new Worker(f.jobs, { leaseMs: 15000, pollMs: 60000, coordinator: { run: async claim => {
    applied = f.jobs.checkpoint(claim, () => {});
  } } });
  try {
    worker.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert(bindings >= 4, 'The checkpoint must bind the submission and all three instruction records');
    assert.equal(applied, true, 'Projection progress must renew the still-current claim before its timer can run');
  } finally { await worker.close(); f.close(); }
});

test('migration never automatically replays legacy in-flight work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-migration-')); const path = join(dir, 'tasks.sqlite');
  const a = new JobStore(path), now = new Date().toISOString();
  const job: Job = { id: randomUUID(), contextId: randomUUID(), service: 'retired.service', goal: 'legacy', state: 'working', messages: [], createdAt: now, updatedAt: now };
  a.save(ownerKey(principal), job); a.close();
  const legacy = new DatabaseSync(path); legacy.exec('DROP TABLE work_claims'); legacy.close();
  const migrated = new JobStore(path);
  try { assert.equal(migrated.get(ownerKey(principal), job.id).state, 'working'); assert.equal(migrated.claim(['eigos.delegate'], 100), undefined); }
  finally { migrated.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Worker configuration needs no Gateway token or OAuth secrets', () => {
  assert.equal(readWorkerConfig({ DATABASE_PATH: '/tmp/example.sqlite', EIGOS_EXECUTOR: 'codex' }).EIGOS_AUTH_MODE, 'jwt');
  assert.throws(() => readWorkerConfig({ EIGOS_PAOTUI_SKILL_DIR: '/tmp/skill' }), /restricted/);
});

test('separate Gateway and two Worker processes: MCP/A2A continuation, restart, isolation and late cancellation', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-processes-')); const path = join(dir, 'tasks.sqlite');
  const token = 'process-test-token-'.repeat(3);
  const config = readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, DATABASE_PATH: path, EIGOS_EXECUTOR: 'codex', EIGOS_CODEX_BIN: '/must-not-run-in-gateway' });
  let gateway = createApp(config);
  let gatewayClosed = false;
  const closeGateway = async () => {
    if (gatewayClosed) return;
    gatewayClosed = true;
    await gateway.close();
  };
  let server = gateway.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  let client = new Client({ name: 'process-test', version: '1' });
  const connect = () => client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }); assert(!result.isError, JSON.stringify(result)); return (result.structuredContent as { result: TaskSummary }).result;
  };
  const stored = (id: string): Job => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { const row = db.prepare('SELECT body FROM jobs WHERE id=?').get(id); assert(row); return JSON.parse(String(row.body)); }
    finally { db.close(); }
  };
  const rpc = async (method: string, params: object) => (await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) })).json();
  const children: ChildProcess[] = []; const events: { event: string; taskId?: string; pid?: number }[] = [];
  function launch() {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/worker.ts'], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_PATH: path }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child); child.stdout!.resume();
    let stderr = ''; child.stderr!.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
    return new Promise<void>((resolve, reject) => {
      // Cold TypeScript imports share CI CPU with other tests; readiness is still the child's IPC event.
      const timer = setTimeout(() => reject(new Error(`Worker ${child.pid} startup deadline exceeded after ${Date.now() - startedAt}ms: ${stderr}`)), 60000);
      const failed = (code: number | null) => { clearTimeout(timer); reject(new Error(`Worker exited before readiness (${code}): ${stderr}`)); };
      child.once('exit', failed);
      child.on('message', message => {
        const value = message as { event: string; taskId?: string }; events.push({ ...value, pid: child.pid });
        if (value.event === 'ready') { clearTimeout(timer); child.removeListener('exit', failed); resolve(); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
  }
  try {
    await connect();
    const input = { service: 'eigos.delegate', goal: 'document', requestId: 'queued' };
    const submitted = await call('submit_task', input);
    await pause(100); assert.equal((await call('get_task', { taskId: submitted.id })).state, 'submitted'); // Gateway never executes.
    await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); await closeGateway(); await pause(75);
    gateway = createApp(config); gatewayClosed = false; server = gateway.app.listen(address.port, '127.0.0.1'); await once(server, 'listening');
    client = new Client({ name: 'process-test-restart', version: '1' }); await connect();
    assert.equal((await call('get_task', { taskId: submitted.id })).state, 'submitted');
    await Promise.all([launch(), launch()]);
    const asked = await until(() => call('get_task', { taskId: submitted.id }), job => job.state === 'input-required');
    const askedLedger = stored(asked.id);
    assert.equal(asked.counts.modelRuns, askedLedger.runs!.length);
    assert.equal(askedLedger.runs?.filter(r => r.purpose === 'document').length, 1); assert.equal(asked.question, 'Fixture question?');
    assert.equal(Object.hasOwn(asked, 'runs'), false, 'Public task summaries expose counts without internal model receipts');
    await call('submit_task', input); assert.equal(events.filter(e => e.event === 'started' && e.taskId === submitted.id).length, 1);
    const reply = { messageId: 'answer', taskId: submitted.id, metadata: { expectedRevision: asked.revision }, role: 'ROLE_USER', parts: [{ text: '90 minutes' }] };
    const response = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: reply }); assert(!response.error, JSON.stringify(response));
    await rpc('SendMessage', { configuration: { returnImmediately: true }, message: reply });
    const done = await until(() => call('get_task', { taskId: submitted.id }), job => job.state === 'completed');
    const doneLedger = stored(done.id);
    assert.equal(done.counts.modelRuns, doneLedger.runs!.length);
    assert.equal(doneLedger.runs?.filter(r => r.purpose === 'document').length, 2); assert.equal(done.artifact?.data.markdown, '# Fixture document');
    const remote = await rpc('GetTask', { id: submitted.id }); assert.equal(remote.result.artifacts[0].parts[0].text, done.artifact!.data.markdown);
    const slow = await call('submit_task', { service: 'eigos.delegate', goal: 'slow', requestId: 'slow' });
    await until(() => events, value => value.some(e => e.event === 'started' && e.taskId === slow.id));
    assert.throws(() => gateway.tasks.get({ ...principal, subject: 'other' }, slow.id), /not found/);
    // Restarting only Gateway must preserve a live Worker's claim.
    await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); await closeGateway(); await pause(75);
    gateway = createApp(config); gatewayClosed = false; server = gateway.app.listen(address.port, '127.0.0.1'); await once(server, 'listening');
    client = new Client({ name: 'process-test-cancel', version: '1' }); await connect();
    assert.equal((await call('get_task', { taskId: slow.id })).state, 'working');
    await call('cancel_task', { taskId: slow.id });
    await until(() => events, value => value.some(e => e.event === 'aborted' && e.taskId === slow.id));
    for (const child of children) child.send({ event: 'release', taskId: slow.id });
    await until(() => events, value => value.some(e => e.event === 'returned' && e.taskId === slow.id));
    const canceled = await call('get_task', { taskId: slow.id }); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.artifact, undefined);
    assert.equal(events.filter(e => e.event === 'started' && e.taskId === slow.id).length, 1);
    const interrupted = await call('submit_task', { service: 'eigos.delegate', goal: 'slow', requestId: 'crash' });
    await until(() => events, value => value.some(e => e.event === 'started' && e.taskId === interrupted.id));
    const pid = events.find(e => e.event === 'started' && e.taskId === interrupted.id)!.pid;
    const crashed = children.find(child => child.pid === pid)!;
    const exited = once(crashed, 'exit'); crashed.kill('SIGKILL'); await exited;
    const failed = await until(() => call('get_task', { taskId: interrupted.id }), job => job.state === 'input-required');
    assert.match(failed.question!, /无法回查/);
    assert.equal(events.filter(e => e.event === 'started' && e.taskId === interrupted.id).length, 1);

  } finally {
    await client.close(); await Promise.all(children.map(stop));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await closeGateway();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Worker retains bounded model failure stages across technical recovery without leaking errors or dispatching business actions', async () => {
  for (const bounded of [true, false]) {
    const store = new JobStore(':memory:'), tasks = new TaskService(store, { catalog: createExecutionCatalog() });
    const job = tasks.submit(principal, { service: 'eigos.delegate', goal: 'fixture', requestId: 'bounded-failure' });
    let calls = 0;
    const worker = new Worker(store, { pollMs: 10, coordinator: { run: async () => {
      calls++; throw bounded ? new ModelSessionError('rpc_timeout', 'thread_start') : new Error('SYNTHETIC_UPSTREAM_SECRET');
    } } });
    try {
      worker.start(); const failed = await until(() => tasks.get(principal, job.id), value => value.state === 'paused');
      assert(!JSON.stringify(failed).includes('SYNTHETIC_UPSTREAM_SECRET'));
      const events = failed.delegation!.events.filter(event => event.event === 'worker_model_failed');
      assert.deepEqual(events.map(event => event.evidence), bounded ? Array(3).fill('thread_start/rpc_timeout') : []);
      assert.equal(failed.delegation!.recovery?.code, 'model_unavailable');
      assert.equal(failed.delegation!.recovery?.state, 'blocked');
      await pause(50); assert.equal(calls, 3); assert.equal(store.intents(ownerKey(principal), job.id).length, 0);
    } finally { await worker.close(); store.close(); }
  }
});
