import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Job } from '../../packages/core/domain.js';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15000; let last: T | undefined;
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await pause(30); }
  const diagnosticInput: unknown = last;
  const job = diagnosticInput && typeof diagnosticInput === 'object' && 'delegation' in diagnosticInput ? diagnosticInput as Job : undefined;
  const diagnostic = job ? { id: job.id, state: job.state, revision: job.revision, error: job.error, question: job.question,
    phase: job.delegation?.phase, recovery: job.delegation?.recovery, actions: job.delegation?.actions,
    authorizationBudget: job.delegation?.authorizationBudget, events: job.delegation?.events.slice(-12) } : last;
  assert.fail(label + ': ' + JSON.stringify(diagnostic));
}
async function child(file: string, env: NodeJS.ProcessEnv) {
  const process = spawn(globalThis.process.execPath, [resolve('dist/tests/fixtures', file + '.js')], { env: { PATH: globalThis.process.env.PATH, HOME: globalThis.process.env.HOME, NODE_NO_WARNINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; process.stderr!.on('data', data => { error = (error + data.toString()).slice(-12000); });
  const ready = await new Promise<{ port?: number }>((resolveReady, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Child did not become ready: ' + error)), 10000);
    process.stdout!.on('data', data => { output += data; const lines = output.split('\n'); output = lines.pop()!; for (const line of lines) { try { const value = JSON.parse(line); clearTimeout(timer); resolveReady(value); } catch { /* Non-protocol diagnostics. */ } } });
    process.once('exit', code => { clearTimeout(timer); reject(new Error('Child exited before ready ' + code + ': ' + error)); });
  });
  return { process, ready, error: () => error };
}
async function stop(process: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = new Promise<void>(r => process.once('exit', () => r())); process.kill(signal); await exited;
}
async function fixture(t: TestContext, fault: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-full-e2e-')); const paths: Record<string, string> = {};
  for (const name of ['gateway', 'alternate', 'provider', 'control']) { const path = join(dir, name + '.token'); writeFileSync(path, randomUUID() + randomUUID(), { mode: 0o600 }); paths[name] = path; }
  const provider = await child('business-provider', { PROVIDER_DATABASE: join(dir, 'provider.sqlite'), PROVIDER_TOKEN_FILE: paths.provider, PROVIDER_CONTROL_TOKEN_FILE: paths.control });
  const providerUrl = `http://127.0.0.1:${provider.ready.port}`; const workers: Awaited<ReturnType<typeof child>>[] = [];
  const common = { EIGOS_AUTH_MODE: 'development', HOST: '127.0.0.1', EIGOS_COORDINATOR: 'codex', EIGOS_EXECUTOR: 'disabled', EIGOS_ACTION_SANDBOX: 'true', EIGOS_SANDBOX_PROVIDER_URL: providerUrl, EIGOS_SANDBOX_TOKEN_FILE: paths.provider, DATABASE_PATH: join(dir, 'tasks.sqlite') };
  const gateway = await child('ontology-gateway', { ...common, GATEWAY_TOKEN_FILE: paths.gateway, ALTERNATE_TOKEN_FILE: paths.alternate });
  const base = `http://127.0.0.1:${gateway.ready.port}`; const bearer = readFileSync(paths.gateway!, 'utf8'); const alternate = readFileSync(paths.alternate!, 'utf8');
  const mcp = new Client({ name: 'full-backend-e2e', version: '3' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  const api = async (path: string, value?: object) => { const r = await fetch(providerUrl + '/_control/' + path, { method: value ? 'POST' : 'GET', headers: { Authorization: `Bearer ${readFileSync(paths.control!, 'utf8')}`, 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) }); assert(r.ok); return r.json(); };
  await api('faults', fault);
  const startWorker = async () => { const w = await child('ontology-worker', { ...common, PUBLIC_URL: base }); workers.push(w); return w; };
  await startWorker();
  const rpc = async (method: string, params: object, token = bearer) => { const r = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) }); return r.json(); };
  const get = async (id: string) => { const r = await mcp.callTool({ name: 'get_task', arguments: { taskId: id } }); assert(!r.isError); return (r.structuredContent as { result: Job }).result; };
  const task = async (extra: object = {}) => {
    const deadline = new Date(Date.now() + 600000).toISOString(); const requestId = randomUUID();
    const args = { executionEnvironment: 'sandbox', goal: JSON.stringify({ sandbox: true, quantity: 20, unit: '杯', deadline }), requestId, requirements: [{ id: 'cups', kind: 'quantity', strength: 'hard', expected: { amount: '20', unit: '杯' } }, { id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '50000', currency: 'CNY' } }, { id: 'deadline', kind: 'deadline', strength: 'hard', expected: { at: deadline, timezone: 'Asia/Shanghai', original: deadline } }, { id: 'delivery', kind: 'condition', strength: 'hard', expected: { predicate: 'delivery.confirmed' } }], ...extra };
    const sent = await mcp.callTool({ name: 'submit_task', arguments: args }); assert(!sent.isError); const j = (sent.structuredContent as { result: Job }).result;
    const repeated = await mcp.callTool({ name: 'submit_task', arguments: args }); assert.equal((repeated.structuredContent as { result: Job }).result.id, j.id);
    return waitFor(() => get(j.id), x => x.state === 'auth-required', 'plan authorization');
  };
  const appPost = async (id: string, action: string, body: object) => { const r = await fetch(base + `/tasks/${id}/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const approve = async (j: Job, extra: object = {}) => {
    const request = j.delegation!.authorizationRequest!;
    const body = { action: 'approve_plan', requestId: randomUUID(), planDigest: request.planDigest, allowedEffects: request.effects, maxAmount: request.maxAmount, payeeIds: request.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox', ...extra };
    const r = await appPost(j.id, 'authorize', body); assert.equal(r.status, 200, JSON.stringify(r)); const retry = await appPost(j.id, 'authorize', body); assert.equal(retry.status, 200);
  };
  t.after(async () => { await mcp.close(); for (const w of workers) await stop(w.process); await stop(gateway.process); await stop(provider.process); rmSync(dir, { recursive: true, force: true }); });
  return { dir, base, workers, task, get, approve, api, rpc, alternate, appPost, startWorker, mcp };
}

for (const crashAfter of ['order', 'payment'] as const) test(`E2E: remote ${crashAfter} success + Worker crash recovers by original key; two Workers never replay effects`, { timeout: 45000 }, async t => {
  const f = await fixture(t, crashAfter === 'order' ? { holdOrder: true } : { holdPayment: true });
  const offered = await f.task(); await f.approve(offered);
  const paid = await waitFor(() => f.api('ledger'), x => crashAfter === 'order' ? x.counters.ordersCreated === 1 : x.counters.charges === 1, 'remote business effect accepted');
  assert.equal((await f.get(offered.id)).state, 'working');
  await stop(f.workers[0]!.process, 'SIGKILL');
  await f.startWorker(); await f.startWorker();
  await waitFor(() => f.get(offered.id), x => x.delegation!.actions?.find(a => a.stepId === 'payment')?.state === 'effect_confirmed', 'original payment reconciliation');
  const before = await f.get(offered.id); assert.equal(before.state, 'working'); assert.equal(before.artifact, undefined);
  await f.api('advance', { orderId: paid.orders[0].id, fulfillment: 'delivered' });
  const done = await waitFor(() => f.get(offered.id), x => x.state === 'completed', 'whole outcome accepted');
  assert.equal(done.delegation!.outcome!.status, 'satisfied'); assert(done.delegation!.acceptance!.checks.every(c => c.result === 'pass'));
  const last = await f.api('ledger'); assert.equal(last.counters.ordersCreated, 1); assert.equal(last.counters.charges, 1); assert.equal(last.counters.orderPostCalls, 1); assert.equal(last.counters.payPostCalls, 1); assert(last.counters.reconcileCalls >= 1);
  const a2a = await f.rpc('GetTask', { id: done.id }); assert.equal(a2a.result.status.state, 'TASK_STATE_COMPLETED');
  const other = await f.rpc('GetTask', { id: done.id }, f.alternate); assert(other.error); assert.equal(other.result, undefined);
});

test('E2E: revoked permits preserve in-flight facts and stop later payment until exact reauthorization', { timeout: 45000 }, async t => {
  const f = await fixture(t, { holdOrder: true }); const offered = await f.task(); await f.approve(offered);
  const created = await waitFor(() => f.api('ledger'), x => x.counters.ordersCreated === 1, 'remote order accepted');
  assert.equal((await f.appPost(offered.id, 'revoke-authorization', { requestId: randomUUID() })).status, 200);
  await waitFor(() => f.get(offered.id), x => x.delegation!.actions?.find(a => a.stepId === 'order')?.state === 'effect_confirmed', 'in-flight fact retained');
  assert.equal((await f.get(offered.id)).state, 'auth-required'); assert.equal((await f.api('ledger')).counters.charges ?? 0, 0);
  await f.approve(await f.get(offered.id)); await waitFor(() => f.api('ledger'), x => x.counters.charges === 1, 'reauthorized payment');
  await f.api('advance', { orderId: created.orders[0].id, fulfillment: 'delivered' }); await waitFor(() => f.get(offered.id), x => x.state === 'completed', 'accepted after reauthorization');
  const final = await f.api('ledger'); assert.equal(final.counters.ordersCreated, 1); assert.equal(final.counters.charges, 1);
});

test('E2E: a real/default-environment request cannot be satisfied by a sandbox provider', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const result = await f.mcp.callTool({ name: 'submit_task', arguments: { goal: JSON.stringify({ sandbox: true, quantity: 20, unit: '杯' }), requestId: randomUUID() } }); assert(!result.isError);
  const job = (result.structuredContent as { result: Job }).result;
  const rejected = await waitFor(() => f.get(job.id), j => j.state === 'rejected', 'no synthetic fulfillment for real request');
  assert.equal(rejected.artifact, undefined); assert.equal(rejected.delegation!.intentId, undefined); assert.equal((await f.api('ledger')).counters.ordersCreated ?? 0, 0);
});

test('E2E: partial delivery fails, refund application is pending, receipt resolves linked task without rewriting original', { timeout: 45000 }, async t => {
  const f = await fixture(t); const offered = await f.task(); await f.approve(offered);
  const ledger = await waitFor(() => f.api('ledger'), x => x.counters.charges === 1, 'simulated payment');
  await f.api('advance', { orderId: ledger.orders[0].id, fulfillment: 'partial', quantity: 15 });
  const failed = await waitFor(() => f.get(offered.id), x => x.state === 'failed', 'partial must fail'); assert.equal(failed.artifact, undefined);
  const asked = await f.mcp.callTool({ name: 'request_remediation', arguments: { originalTaskId: failed.id, action: 'refund', reason: '数量不足', requestId: 'refund-once' } }); assert(!asked.isError);
  const remedy = (asked.structuredContent as { result: Job }).result; assert.notEqual(remedy.id, failed.id); await f.approve(remedy);
  await waitFor(() => f.api('ledger'), x => x.counters.refundRequests === 1, 'refund submitted');
  const pending = await f.get(remedy.id); assert.notEqual(pending.state, 'completed'); assert.equal(pending.artifact, undefined);
  await f.api('advance', { orderId: ledger.orders[0].id, refund: 'refunded' });
  const refunded = await waitFor(() => f.get(remedy.id), x => x.state === 'completed', 'refund actually observed'); assert.equal(refunded.delegation!.outcome!.status, 'satisfied');
  const original = await f.get(failed.id); assert.equal(original.state, 'failed'); assert.equal(original.afterSales![0]!.state, 'resolved');
  const retry = await f.mcp.callTool({ name: 'request_remediation', arguments: { originalTaskId: failed.id, action: 'refund', reason: '重新查询', requestId: 'another-message' } }); assert.equal((retry.structuredContent as { result: Job }).result.id, remedy.id);
  const last = await f.api('ledger'); assert.equal(last.counters.refundRequests, 1); assert.equal(last.counters.refundPayments, 1);
});

test('E2E: cancel records late facts, prevents payment and uses a separately authorized business cancellation', { timeout: 45000 }, async t => {
  const f = await fixture(t, { holdOrder: true }); const offered = await f.task(); await f.approve(offered);
  const created = await waitFor(() => f.api('ledger'), x => x.counters.ordersCreated === 1, 'remote order accepted');
  const canceled = await f.rpc('CancelTask', { id: offered.id }); assert.equal(canceled.result.status.state, 'TASK_STATE_CANCELED');
  await waitFor(() => f.get(offered.id), x => x.delegation!.actions?.find(a => a.stepId === 'order')?.state === 'effect_confirmed', 'late order fact reconciled');
  const last = await f.api('ledger'); assert.equal(last.counters.charges ?? 0, 0); assert.equal(last.orders[0].orderState, 'confirmed'); assert.equal((await f.get(offered.id)).state, 'canceled');
  const requested = await f.appPost(offered.id, 'aftersales', { action: 'cancel', reason: '撤回订单', requestId: randomUUID() }); assert.equal(requested.status, 200); const remedy = requested.body.task as Job;
  await f.approve(remedy); await waitFor(() => f.get(remedy.id), x => x.state === 'completed', 'business cancellation confirmed');
  const final = await f.api('ledger'); assert.equal(final.orders[0].id, created.orders[0].id); assert.equal(final.orders[0].orderState, 'canceled'); assert.equal(final.counters.cancellations, 1); assert.equal(final.counters.charges ?? 0, 0);
});

test('E2E: cancellation during an unknown payment retains its budget until reconciliation and never completes the canceled goal', { timeout: 45000 }, async t => {
  const f = await fixture(t, { holdPayment: true }); const offered = await f.task(); await f.approve(offered);
  const paid = await waitFor(() => f.api('ledger'), x => x.counters.charges === 1, 'remote payment committed');
  const inFlight = await f.get(offered.id); assert.equal(inFlight.delegation!.authorizationBudget!.find(b => b.minor === '45000')!.state, 'held');
  assert.equal((await f.rpc('CancelTask', { id: offered.id })).result.status.state, 'TASK_STATE_CANCELED');
  const known = await waitFor(() => f.get(offered.id), x => x.delegation!.actions?.find(a => a.stepId === 'payment')?.state === 'effect_confirmed', 'payment result reconciled after cancellation');
  assert.equal(known.state, 'canceled'); assert.equal(known.artifact, undefined); assert.equal(known.delegation!.authorizationBudget!.find(b => b.minor === '45000')!.state, 'consumed');
  assert(known.delegation!.businessFacts!.some(fact => fact.snapshot.payment === 'paid'));
  await f.api('advance', { orderId: paid.orders[0].id, fulfillment: 'delivered' }); assert.equal((await f.get(offered.id)).state, 'canceled');
  const ledger = await f.api('ledger'); assert.equal(ledger.counters.charges, 1); assert.equal(ledger.counters.payPostCalls, 1);
});
