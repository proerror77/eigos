// Actual MCP/A2A HTTP transports; all source data and model decisions are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { Worker } from '../apps/worker/worker.js';
import { situationFixture } from './fixtures/situation.js';
import { owner, principal } from './backend-fixture.js';
import type { Job } from '../packages/core/domain.js';
import { paFactsFixture } from './fixtures/pa-questions.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';

test('SA11/16 A2A and MCP share observation controls, source-only updates, exact grants and final same-task acceptance', { timeout: 90000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = situationFixture({ calendar: true }), server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, token = 'situation-protocol-fixture-token-only';
  const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, EIGOS_ACTION_SANDBOX: 'true', DATABASE_PATH: ':memory:', PUBLIC_URL: base }), undefined, () => f.catalog);
  server.on('request', gateway.app);
  const worker = new Worker(gateway.store, { coordinator: new Coordinator(gateway.store, f.model, f.catalog, { allowSandbox: true }), pollMs: 10 }); worker.start();
  const client = new Client({ name: 'situation-protocol-test', version: '1' }), headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'A2A-Version': '1.0' };
  const rpc = async (method: string, params: object) => {
    const response = await fetch(base + '/a2a', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    assert.equal(response.status, 200); return response.json();
  };
  const wait = async (id: string, predicate: (job: Job) => boolean) => {
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) {
      const job = gateway.tasks.get(principal, id); if (predicate(job)) return job;
      if (job.state === 'auth-required') {
        const a = job.delegation!.authorizationRequest!;
        const response = await fetch(`${base}/tasks/${id}/authorize`, { method: 'POST', headers, body: JSON.stringify({ action: 'approve_plan', requestId: randomUUID(), planDigest: a.planDigest,
          allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 300000).toISOString(), environment: 'sandbox' }) }); assert.equal(response.status, 200);
      } else if (['failed', 'rejected', 'input-required'].includes(job.state)) assert.fail(job.error ?? job.question);
      await new Promise(done => setTimeout(done, 10));
    }
    assert.fail('Bounded protocol wait expired');
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const sent = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', goal: '合成验证报名、日历与交通，并守护到约定期限。', executionEnvironment: 'sandbox', monitoring: { until: new Date(Date.now() + 120000).toISOString(), maxQueries: 32 } } }] } });
    assert(!sent.error); const id = sent.result.task.id as string;
    const initial = await wait(id, job => job.delegation?.phase === 'watching');
    const watchId = initial.delegation!.situation!.watches.find(w => w.componentId === 'registration')!.id;
    assert.throws(() => gateway.tasks.reportSourceChange({ ...principal, subject: 'other-member' }, { action: 'report_source_change', taskId: id, watchId, eventId: 'foreign', note: 'Untrusted update', requestId: randomUUID() }), /not found/);
    f.event.venueAddress = '北京市场馆 B';
    const changed = await client.callTool({ name: 'report_source_change', arguments: { action: 'report_source_change', taskId: id, watchId, eventId: 'owned-event-move', note: '活动地点可能改变，请向来源复核。', requestId: randomUUID() } });
    assert(!changed.isError);
    const repaired = await wait(id, job => job.delegation?.phase === 'watching' && job.delegation.agent!.components!.calendar!.generation === 2);
    assert.equal(repaired.delegation!.agent!.components!.calendar!.input!.location, '北京市场馆 B');
    const currentWatch = repaired.delegation!.situation!.watches.find(w => w.componentId === 'registration' && w.status === 'active')!;
    const revoked = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { taskId: id, messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { action: 'revoke_observation', watchId: currentWatch.id } }] } });
    assert(!revoked.error); await wait(id, job => job.state === 'input-required');
    const resumed = await client.callTool({ name: 'resume_observation', arguments: { action: 'resume_observation', taskId: id, watchId: currentWatch.id, requestId: randomUUID() } }); assert(!resumed.isError);
    await wait(id, job => job.delegation?.phase === 'watching');
    t.mock.timers.tick(120001);
    const done = await wait(id, job => job.state === 'completed');
    const a2a = (await rpc('GetTask', { id })).result;
    const read = await client.callTool({ name: 'get_task', arguments: { taskId: id } }); assert(!read.isError);
    const mcp = (read.structuredContent as { result: Job }).result;
    assert.equal(a2a.id, id); assert.deepEqual(a2a.artifacts[0].parts[0].data, mcp.artifact!.data);
    assert.deepEqual(a2a.metadata.delegation.situation, mcp.delegation!.situation);
    assert.equal(done.delegation!.outcome!.evidenceLevel, 'synthetic'); assert.equal(f.registration.counters().submits, 1);
    assert.equal(f.calendarCalls.filter(action => action === 'CreateCalendarEntrySandbox').length, 1);
    assert.equal(gateway.store.list(owner, { offset: 0, limit: 10 }).total, 1);
  } finally { await client.close(); await worker.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await gateway.close(); f.close(); t.mock.timers.reset(); }
});

test('MCP and A2A exchange the same factual PA question without a calendar connection or authority transfer', { timeout: 30000 }, async () => {
  const f = paFactsFixture(), server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, token = 'pa-factual-protocol-fixture-token-only';
  const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, DATABASE_PATH: ':memory:', PUBLIC_URL: base }), undefined, store => createExecutionCatalog({ store }));
  server.on('request', gateway.app);
  const worker = new Worker(gateway.store, { coordinator: new Coordinator(gateway.store, f.model, gateway.catalog), pollMs: 10 }); worker.start();
  const client = new Client({ name: 'pa-facts-test', version: '1' }), headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'A2A-Version': '1.0' };
  const directory = mkdtempSync(join(tmpdir(), 'eigos-pa-factual-client-')), profile = join(directory, 'profile.json'), tokenFile = join(directory, 'token'), answerFile = join(directory, 'answer.json');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const python = async (...args: string[]) => {
    const result = await promisify(execFile)('python3', [resolve('integrations/grok/eigos-delegate/scripts/eigos_a2a.py'), '--config', profile, ...args], { maxBuffer: 8 * 1024 * 1024 });
    assert(!result.stdout.includes(token)); return JSON.parse(result.stdout);
  };
  const rpc = async (method: string, params: object) => {
    const response = await fetch(base + '/a2a', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    assert.equal(response.status, 200); const result = await response.json(); assert(!result.error, JSON.stringify(result.error)); return result.result;
  };
  const wait = async (id: string, predicate: (job: Job) => boolean) => {
    for (let i = 0; i < 300; i++) { const job = gateway.tasks.get(principal, id); if (predicate(job)) return job; await new Promise(done => setTimeout(done, 10)); }
    assert.fail('Factual question transport wait expired');
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const sent = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', goal: '向我的 PA 核实活动安排。只交换事实。' } }] } });
    const id = sent.task.id, waiting = await wait(id, job => job.delegation?.phase === 'awaiting_pa_answer');
    const read = await client.callTool({ name: 'get_task', arguments: { taskId: id } });
    const question = (read.structuredContent as { result: Job }).result.delegation!.paQuestion!;
    assert.deepEqual(question, waiting.delegation!.paQuestion); assert.equal(question.question.grantsActionAuthority, false);
    await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { taskId: id, contextId: waiting.contextId, messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: {
      action: 'answer_pa_question', questionId: question.question.id, questionDigest: question.question.digest, expectedAnswerRevision: 0,
      answer: { status: 'unknown', reason: 'No current confirmed facts yet', observedAt: new Date().toISOString() },
    } }] } });
    await python('configure', '--card-url', base + '/.well-known/agent-card.json', '--token-file', tokenFile, '--allow-loopback-http');
    writeFileSync(answerFile, JSON.stringify({ questionId: question.question.id, questionDigest: question.question.digest, expectedAnswerRevision: 1,
      answer: { status: 'needs_user', reason: 'Waiting for the user to confirm the current information', observedAt: new Date().toISOString() } }));
    const answerRequestId = randomUUID();
    await python('answer-pa-question', '--task-id', id, '--input-file', answerFile, '--request-id', answerRequestId);
    await python('answer-pa-question', '--task-id', id, '--input-file', answerFile, '--request-id', answerRequestId);
    const answered = await client.callTool({ name: 'answer_pa_question', arguments: { ...f.report(waiting), expectedAnswerRevision: 2 } }); assert(!answered.isError, JSON.stringify(answered));
    const done = await wait(id, job => job.state === 'completed'), a2a = await rpc('GetTask', { id });
    assert.deepEqual(a2a.artifacts[0].parts[0].data, done.artifact!.data);
    assert.equal(gateway.store.grants(owner, id).length, 0); assert(gateway.store.intents(owner, id).every(i => i.effect === 'read'));
  } finally { await client.close(); await worker.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await gateway.close(); f.close(); rmSync(directory, { recursive: true, force: true }); }
});
