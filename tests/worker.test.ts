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
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { SCOPES, ownerKey, type Job, type Principal } from '../packages/core/domain.js';
import { readWorkerConfig } from '../packages/core/config.js';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';

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

test('migration never automatically replays legacy in-flight work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-migration-')); const path = join(dir, 'tasks.sqlite');
  const a = new JobStore(path); const tasks = new TaskService(a, { catalog: createExecutionCatalog() });
  const job = tasks.submit(principal, { service: 'eigos.delegate', goal: 'legacy', requestId: 'one' }); job.service = 'retired.service'; job.state = 'working'; delete job.delegation; a.save(ownerKey(principal), job); a.close();
  const legacy = new DatabaseSync(path); legacy.exec('DROP TABLE work_claims'); legacy.close();
  const migrated = new JobStore(path);
  try { assert.equal(migrated.get(ownerKey(principal), job.id).state, 'working'); assert.equal(migrated.claim(['eigos.delegate'], 100), undefined); }
  finally { migrated.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Worker configuration needs no Gateway token or OAuth secrets', () => {
  assert.equal(readWorkerConfig({ DATABASE_PATH: '/tmp/example.sqlite', EIGOS_EXECUTOR: 'codex' }).EIGOS_AUTH_MODE, 'jwt');
  assert.throws(() => readWorkerConfig({ EIGOS_PAOTUI_SKILL_DIR: '/tmp/skill' }), /restricted/);
});

test('separate Gateway and two Worker processes: MCP/A2A continuation, restart, isolation and late cancellation', { timeout: 45000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-processes-')); const path = join(dir, 'tasks.sqlite');
  const token = 'process-test-token-'.repeat(3);
  const config = readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, DATABASE_PATH: path, EIGOS_EXECUTOR: 'codex', EIGOS_CODEX_BIN: '/must-not-run-in-gateway' });
  let gateway = createApp(config);
  let server = gateway.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  let client = new Client({ name: 'process-test', version: '1' });
  const connect = () => client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }); assert(!result.isError, JSON.stringify(result)); return (result.structuredContent as { result: Job }).result;
  };
  const rpc = async (method: string, params: object) => (await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) })).json();
  const children: ChildProcess[] = []; const events: { event: string; taskId?: string; pid?: number }[] = [];
  function launch() {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/worker.ts'], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_PATH: path }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child); child.stdout!.resume();
    let stderr = ''; child.stderr!.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker startup deadline exceeded: ${stderr}`)), 15000);
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
    await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); await gateway.close(); await pause(75);
    gateway = createApp(config); server = gateway.app.listen(address.port, '127.0.0.1'); await once(server, 'listening');
    client = new Client({ name: 'process-test-restart', version: '1' }); await connect();
    assert.equal((await call('get_task', { taskId: submitted.id })).state, 'submitted');
    await Promise.all([launch(), launch()]);
    const asked = await until(() => call('get_task', { taskId: submitted.id }), job => job.state === 'input-required');
    assert.equal(asked.runs?.filter(r => r.purpose === 'document').length, 1); assert.equal(asked.question, 'Fixture question?');
    await call('submit_task', input); assert.equal(events.filter(e => e.event === 'started' && e.taskId === submitted.id).length, 1);
    const reply = { messageId: 'answer', taskId: submitted.id, metadata: { expectedRevision: asked.revision }, role: 'ROLE_USER', parts: [{ text: '90 minutes' }] };
    const response = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: reply }); assert(!response.error, JSON.stringify(response));
    await rpc('SendMessage', { configuration: { returnImmediately: true }, message: reply });
    const done = await until(() => call('get_task', { taskId: submitted.id }), job => job.state === 'completed');
    assert.equal(done.runs?.filter(r => r.purpose === 'document').length, 2); assert.equal(done.artifact?.data.markdown, '# Fixture document');
    const remote = await rpc('GetTask', { id: submitted.id }); assert.equal(remote.result.artifacts[0].parts[0].text, done.artifact!.data.markdown);
    const slow = await call('submit_task', { service: 'eigos.delegate', goal: 'slow', requestId: 'slow' });
    await until(() => events, value => value.some(e => e.event === 'started' && e.taskId === slow.id));
    assert.throws(() => gateway.tasks.get({ ...principal, subject: 'other' }, slow.id), /not found/);
    // Restarting only Gateway must preserve a live Worker's claim.
    await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); await gateway.close(); await pause(75);
    gateway = createApp(config); server = gateway.app.listen(address.port, '127.0.0.1'); await once(server, 'listening');
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
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
