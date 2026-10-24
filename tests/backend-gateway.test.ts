import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
// Real MCP/A2A transports with synthetic model decisions, no live merchant or payment.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { Coordinator, type Reasoner } from '../packages/coordinator/coordinator.js';
import { CSV_CHECKS } from '../packages/ontology/csv-audit.js';
import { readConfig } from '../packages/core/config.js';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import type { Job } from '../packages/core/domain.js';
import { principal, owner, reasoner, interpretation } from './backend-fixture.js';
import { scheduleTaskRecovery } from '../packages/core/task-recovery.js';
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const exec = promisify(execFile);

async function fixture(model: Reasoner = reasoner(r => r.messages.some(m => m.text.includes('sample.csv')) ? interpretation(r, 'data.quality.audit.simulated', { fileName: 'sample.csv', checks: [...CSV_CHECKS] }) : { ...interpretation(r), kind: 'clarify', message: '请提供 CSV 文件名。' })) {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-v2-gateway-')); writeFileSync(join(dir, 'sample.csv'), 'record_id,email,amount_cny,event_date\nA,bad,-1,2026-02-30\n');
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const token = 'backend-fixture-token-'.repeat(3);
  const config = readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, PUBLIC_URL: base, PORT: String(address.port), DATABASE_PATH: ':memory:', EIGOS_COORDINATOR: 'codex', EIGOS_CSV_PILOT: 'true', EIGOS_CSV_INPUT_DIR: dir });
  const gateway = createApp(config); server.on('request', gateway.app);
  const worker = new Worker(gateway.store, { coordinator: new Coordinator(gateway.store, model, gateway.catalog), pollMs: 10 }); worker.start();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
  const rpc = async (method: string, params: object) => (await fetch(base + '/a2a', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) })).json();
  const send = (text: string, taskId?: string, returnImmediately = true) => rpc('SendMessage', { configuration: { returnImmediately }, message: { messageId: randomUUID(), role: 'ROLE_USER', ...(taskId ? { taskId, metadata: { expectedRevision: gateway.tasks.get(principal, taskId).revision } } : {}), parts: [{ text }] } });
  const wait = async (id: string, state: Job['state']) => { for (let i = 0; i < 400; i++) { const j = gateway.tasks.get(principal, id); if (j.state === state) return j; await pause(10); } assert.fail(JSON.stringify(gateway.tasks.get(principal, id))); };
  const approval = (j: Job) => ({ action: 'confirm_simulated_payment', requestId: 'approve-' + j.id, quoteId: j.delegation!.plan!.quote!.id, quoteDigest: j.delegation!.plan!.quote!.digest });
  const approve = (j: Job, extra = {}) => fetch(base + `/tasks/${j.id}/authorize`, { method: 'POST', headers, body: JSON.stringify({ ...approval(j), ...extra }) });
  return { dir, base, token, gateway, worker, rpc, send, wait, approve, approval, close: async () => { await worker.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await gateway.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('new backend uses existing A2A/MCP intake, clarification, exact approval and independently accepted delivery', async () => {
  const f = await fixture(); const mcp = new Client({ name: 'backend-test', version: '2' });
  try {
    const first = await f.send('审计 CSV'); const id = first.result.task.id;
    assert.equal(first.result.task.status.state, 'TASK_STATE_SUBMITTED'); await f.wait(id, 'input-required');
    const reply = { configuration: { returnImmediately: true }, message: { messageId: 'stable-answer', taskId: id, metadata: { expectedRevision: f.gateway.tasks.get(principal, id).revision }, role: 'ROLE_USER', parts: [{ text: 'sample.csv，全部已注册检查' }] } };
    assert(!(await f.rpc('SendMessage', reply)).error); const ready = await f.wait(id, 'auth-required');
    assert(!(await f.rpc('SendMessage', reply)).error); assert((await f.send('yes', id)).error);
    assert.equal((await f.approve(ready, { quoteDigest: '0'.repeat(64) })).status, 409);
    assert.equal((await f.approve(ready)).status, 200); assert.equal((await f.approve(ready)).status, 200);
    const done = await f.wait(id, 'completed'); assert.equal(done.runs!.length, 3); assert.equal(done.delegation!.request.revision, 2);
    assert.equal(done.delegation!.phase, 'accepted');  assert(done.delegation!.acceptance!.accepted);
    await mcp.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${f.token}` } } }));
    const response = await mcp.callTool({ name: 'get_task', arguments: { taskId: id } }); assert(!response.isError);
    assert.deepEqual((response.structuredContent as { result: Job }).result.artifact, done.artifact);
    const submitted = await mcp.callTool({ name: 'submit_task', arguments: { goal: '审计 sample.csv', requestId: 'mcp-default-service' } });
    assert(!submitted.isError); const viaMcp = (submitted.structuredContent as { result: Job }).result;
    assert.equal(viaMcp.service, 'eigos.delegate'); await f.wait(viaMcp.id, 'auth-required');
    f.gateway.tasks.cancel(principal, viaMcp.id);
    assert.throws(() => f.gateway.tasks.get({ ...principal, subject: 'other' }, id), /not found/);
    assert((await f.send('change it', id)).error);
    const card = await (await fetch(f.base + '/.well-known/agent-card.json')).json();
    assert(card.skills.find((s: { id: string }) => s.id === 'eigos.delegate').description.includes('record_id'));
  } finally { await mcp.close(); await f.close(); }
});

test('unsupported outcomes and invented capabilities fail without fallback or simulated payment', async () => {
  for (const mode of ['unsupported', 'invented'] as const) {
    const f = await fixture(reasoner(r => ({ ...interpretation(r), ...(mode === 'unsupported' ? { kind: 'unsupported', message: 'No supported coffee purchasing capability.' } : { capabilityRef: { id: 'invented', version: '2' } }) })));
    try { const response = await f.send('买咖啡'); const j = await f.wait(response.result.task.id, mode === 'unsupported' ? 'rejected' : 'paused'); assert.equal(j.artifact, undefined); assert.equal(j.delegation!.intentId, undefined); }
    finally { await f.close(); }
  }
});

test('altered plan cannot be approved; cancellation of a prepared plan prevents dispatch', async () => {
  const f = await fixture();
  try {
    const first = await f.send('审计 sample.csv'); const ready = await f.wait(first.result.task.id, 'auth-required');
    ready.delegation!.plan!.details.checks = ['invalid_email']; f.gateway.store.save(owner, ready);
    assert.equal((await f.approve(ready)).status, 409);
    const next = await f.send('审计 sample.csv'); const pending = await f.wait(next.result.task.id, 'auth-required');
    assert(!(await f.rpc('CancelTask', { id: pending.id })).error); assert.equal((await f.approve(pending)).status, 409);
    assert.equal(f.gateway.store.intent(owner, pending.delegation!.intentId!).state, 'canceled_before_dispatch');
    assert.equal(f.gateway.store.observations(owner, pending.delegation!.intentId!).length, 0);
  } finally { await f.close(); }
});

test('blocking A2A stops at clarification/authorization and active waits reject timeout or shutdown', async () => {
  const f = await fixture();
  try {
    const first = await f.send('审计 CSV', undefined, false); assert.equal(first.result.task.status.state, 'TASK_STATE_INPUT_REQUIRED');
    const next = await f.send('sample.csv', first.result.task.id, false); assert.equal(next.result.task.status.state, 'TASK_STATE_AUTH_REQUIRED');
  } finally { await f.close(); }
  const store = new JobStore(':memory:'); const tasks = new TaskService(store, { catalog: createExecutionCatalog(), waitTimeoutMs: 10 });
  try { const j = tasks.submit(principal, { service: 'eigos.delegate', goal: 'fixture', requestId: 'wait' }); await assert.rejects(tasks.wait(principal, j.id), /Blocking task wait/); await tasks.close(); await assert.rejects(tasks.wait(principal, j.id), /Blocking task wait/); }
  finally { store.close(); }
});

test('existing Personal Agent Python client still discovers, resumes, approves and reads the new backend', async () => {
  const f = await fixture(); const script = resolve('integrations/grok/eigos-delegate/scripts/eigos_a2a.py');
  const profile = join(f.dir, 'profile.json'); const tokenFile = join(f.dir, 'token'); writeFileSync(tokenFile, f.token, { mode: 0o600 }); chmodSync(tokenFile, 0o600);
  const run = async (...args: string[]) => { const r = await exec('python3', [script, '--config', profile, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, maxBuffer: 1024 * 1024 }); assert(!r.stdout.includes(f.token)); assert(!r.stderr.includes(f.token)); return JSON.parse(r.stdout); };
  try {
    await run('configure', '--card-url', f.base + '/.well-known/agent-card.json', '--token-file', tokenFile, '--allow-loopback-http'); assert(!readFileSync(profile, 'utf8').includes(f.token));
    const input = join(f.dir, 'goal.txt'); writeFileSync(input, '审计 sample.csv');
    const sent = await run('send', '--text-file', input, '--request-id', 'one'); const retry = await run('send', '--text-file', input, '--request-id', 'one'); assert.equal(retry.id, sent.id);
    const ready = await f.wait(sent.id, 'auth-required'); const approval = join(f.dir, 'approve.json'); writeFileSync(approval, JSON.stringify(f.approval(ready)));
    await run('authorize', '--task-id', ready.id, '--input-file', approval); await f.wait(ready.id, 'completed');
    assert.equal((await run('get', '--task-id', ready.id)).status.state, 'TASK_STATE_COMPLETED');
    writeFileSync(input, 'changed goal'); await assert.rejects(run('send', '--text-file', input, '--request-id', 'one'));
  } finally { await f.close(); }
});

test('MCP and A2A bind continuation versions and expose technical recovery and member accounting', async () => {
  const f = await fixture(), mcp = new Client({ name: 'continuation-test', version: '1' });
  try {
    const sent = await f.send('审计 CSV'), id = sent.result.task.id, asked = await f.wait(id, 'input-required');
    await f.worker.close();
    await mcp.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${f.token}` } } }));
    const call = (name: string, args: Record<string, unknown>) => mcp.callTool({ name, arguments: args });
    const send = (data: object, operation = 'reply', requestId = randomUUID()) => f.rpc('SendMessage', { configuration: { returnImmediately: true }, message: { taskId: id, messageId: requestId, role: 'ROLE_USER', metadata: { taskOperation: operation }, parts: [{ data }] } });
    const missing = { taskId: id, requestId: randomUUID(), answer: 'sample.csv' };
    assert((await call('reply_to_task', missing)).isError);
    assert((await send({ answer: 'sample.csv' })).error);
    assert((await f.rpc('SendMessage', { configuration: { returnImmediately: true }, message: { taskId: id, messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'sample.csv' }] } })).error);
    const correction = { ...missing, expectedRevision: asked.revision!, answer: '文件改为corrected.csv' };
    assert(!(await call('amend_task', correction)).isError);
    assert(!(await call('amend_task', correction)).isError, 'An exact retry returns the original receipt');
    assert((await send({ answer: 'sample.csv', expectedRevision: asked.revision! })).error, 'A delayed reply cannot answer the revised task');
    const amended = f.gateway.store.get(owner, id), businessRevision = amended.delegation!.request.revision;
    scheduleTaskRecovery(amended, 'worker_timeout', 'Runtime repair required', { automatic: false }); f.gateway.store.save(owner, amended);
    const read = await f.rpc('GetTask', { id }); assert.equal(read.result.status.state, 'TASK_STATE_WORKING'); assert.equal(read.result.metadata.internalState, 'paused');
    assert.equal(read.result.metadata.delegation.recovery.ownerInputRequired, false); assert.equal(read.result.metadata.memberUsage.limitsEnforced, false);
    assert(!(await call('get_member_usage', {})).isError);
    assert(!(await call('resume_task', { taskId: id, requestId: randomUUID(), expectedRevision: amended.revision! })).isError);
    const pausedAgain = f.gateway.store.get(owner, id); scheduleTaskRecovery(pausedAgain, 'worker_timeout', 'Runtime repaired again', { automatic: false }); f.gateway.store.save(owner, pausedAgain);
    const resumeId = randomUUID(), resume = { expectedRevision: pausedAgain.revision! };
    assert(!(await send(resume, 'resume', resumeId)).error); assert(!(await send(resume, 'resume', resumeId)).error);
    const done = f.gateway.store.get(owner, id); assert.equal(done.state, 'working'); assert.equal(done.delegation!.request.messages.length, 2); assert.equal(done.delegation!.request.revision, businessRevision);
    assert((await send({ ...resume, answer: '继续' }, 'resume')).error, 'Technical continuation has no business answer');
  } finally { await mcp.close(); await f.close(); }
});
