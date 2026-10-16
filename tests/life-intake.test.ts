import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { ownerKey, SCOPES, type Job } from '../packages/core/domain.js';

const exec = promisify(execFile);
const principal = { issuer: 'local-development', tenant: 'local', subject: 'developer', clientId: 'test', scopes: [...SCOPES] };
const goals = ['想买一副降噪耳机，预算800元。', '周末去杭州住两晚，帮我找酒店。', '下周三上海去北京的机票。', '把文件从家里送到办公室。', '今晚想叫两个人的外送。', '周末想预约一次家政保洁。'];

async function fixture(enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-life-'));
  const token = randomUUID() + randomUUID();
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token,
    DATABASE_PATH: join(directory, 'tasks.sqlite'), PUBLIC_URL: base, EIGOS_LIFE_INTAKE: enabled ? 'true' : 'false' }));
  server.on('request', gateway.app);
  async function rpc(method: string, params: object) {
    const response = await fetch(`${base}/a2a`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), signal: AbortSignal.timeout(5000) });
    return response.json();
  }
  return { gateway, directory, token, base, rpc, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await gateway.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('life intake is opt-in and a concise discoverable skill, not an execution promise', async () => {
  const disabled = await fixture(false);
  try {
    const card = await (await fetch(`${disabled.base}/.well-known/agent-card.json`)).json();
    assert(!card.skills.some((s: { id: string }) => s.id === 'life.request'));
    assert.throws(() => disabled.gateway.tasks.submit(principal, { service: 'life.request', goal: goals[0], requestId: 'disabled' }), /not configured/);
  } finally { await disabled.close(); }
  const f = await fixture();
  try {
    const card = await (await fetch(`${f.base}/.well-known/agent-card.json`)).json();
    const skill = card.skills.find((s: { id: string }) => s.id === 'life.request');
    assert(skill); assert(skill.description.includes('intake-only')); assert(skill.description.length < 1000);
    // Default A2A text is acknowledged without waiting for a nonexistent Worker/provider.
    const result = await f.rpc('SendMessage', { message: { role: 'ROLE_USER', messageId: 'text-handoff', parts: [{ text: goals[3] }] } });
    assert.equal(result.result.task.status.state, 'TASK_STATE_SUBMITTED');
    assert.equal(result.result.task.metadata.intake.originalGoal, goals[3]);
    assert.equal(result.result.task.metadata.intake.businessCompleted, false);
  } finally { await f.close(); }
});

test('real Python PA transport forwards six natural-language domains and reads receipts through MCP', async () => {
  const f = await fixture();
  const client = new Client({ name: 'life-intake-test', version: '1.0.0' });
  try {
    const tokenPath = join(f.directory, 'token'); writeFileSync(tokenPath, f.token, { mode: 0o600 });
    const profile = join(f.directory, 'profile.json');
    const script = 'integrations/grok/eigos-delegate/scripts/eigos_a2a.py';
    await exec('python3', [script, '--config', profile, 'configure', '--card-url', `${f.base}/.well-known/agent-card.json`, '--token-file', tokenPath,
      '--allow-loopback-http', '--allow-service', 'life.request', '--default-service', 'life.request']);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${f.token}` } } }));
    const ids = new Set<string>();
    for (const [index, goal] of goals.entries()) {
      const path = join(f.directory, `goal-${index}.txt`); writeFileSync(path, goal);
      const args = [script, '--config', profile, 'send', '--text-file', path, '--request-id', `domain-${index}`];
      const task = JSON.parse((await exec('python3', args)).stdout);
      assert.equal(task.status.state, 'TASK_STATE_SUBMITTED'); ids.add(task.id);
      assert.equal(task.metadata.intake.originalGoal, goal);
      assert.equal(task.metadata.intake.execution, 'not_started');
      const retry = JSON.parse((await exec('python3', args)).stdout); assert.equal(retry.id, task.id);
      const polled = JSON.parse((await exec('python3', [script, '--config', profile, 'poll', '--task-id', task.id, '--seconds', '0'])).stdout);
      assert.equal(polled.handoffAccepted, true); assert.equal(polled.resumeRequired, false); assert.equal(polled.businessCompleted, false);
      const read = await client.callTool({ name: 'get_task', arguments: { taskId: task.id } });
      const job = (read.structuredContent as { result: Job }).result;
      assert.equal(job.goal, goal); assert.equal(job.state, 'submitted'); assert.deepEqual(job.intake, task.metadata.intake);
    }
    assert.equal(ids.size, 6);
    assert.equal(f.gateway.store.claim(['life.request'], 1000), undefined);
  } finally { await client.close(); await f.close(); }
});

test('intake survives restart, updates idempotently and cancels without converting to execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-life-store-')); const path = join(directory, 'tasks.sqlite');
  let store = new JobStore(path); let tasks = new TaskService(store, { lifeIntake: true });
  try {
    const submitted = tasks.submit(principal, { service: 'life.request', goal: '  用户原始需求：周末保洁  ', domain: 'household', requestId: 'first' });
    assert.equal(submitted.goal, '  用户原始需求：周末保洁  ');
    store.close(); store = new JobStore(path); tasks = new TaskService(store, { lifeIntake: true });
    assert.equal(tasks.get(principal, submitted.id).intake?.status, 'waiting_provider');
    const input = { taskId: submitted.id, answer: '只登记需求，不执行。', requestId: 'update' };
    tasks.reply(principal, input); tasks.reply(principal, input);
    const updated = tasks.get(principal, submitted.id);
    assert.equal(updated.messages.filter(m => m.id === 'update').length, 1);
    assert.equal(updated.goal, submitted.goal); assert.equal(updated.state, 'submitted');
    const canceled = tasks.cancel(principal, submitted.id);
    assert.equal(canceled.intake?.status, 'canceled'); assert.equal(canceled.artifact?.data.execution, 'not_started');
    assert.equal((canceled.artifact?.data.result as { status: string }).status, 'canceled');
    assert.throws(() => tasks.reply(principal, { ...input, requestId: 'after-cancel' }), /not open/);
    assert.equal(store.claim(['life.request'], 1000), undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('intake ownership, scopes and caller-supplied completion claims are enforced', () => {
  const store = new JobStore(':memory:'); const tasks = new TaskService(store, { lifeIntake: true });
  try {
    const args = { service: 'life.request', goal: goals[0], requestId: 'owned' };
    assert.throws(() => tasks.submit({ ...principal, scopes: ['tasks:read'] }, args), /scope/);
    assert.throws(() => tasks.submit(principal, { ...args, state: 'completed' }));
    const task = tasks.submit(principal, args); const other = { ...principal, subject: 'other' };
    assert.throws(() => tasks.get(other, task.id), /not found/);
    assert.throws(() => tasks.reply(other, { taskId: task.id, answer: 'change', requestId: 'other' }), /not found/);
    assert.throws(() => tasks.cancel(other, task.id), /not found/);
    assert.throws(() => tasks.authorize(principal, task.id, { requestId: 'execute-now' }), /No pending/);
    assert.equal(store.get(ownerKey(principal), task.id).intake?.businessCompleted, false);
  } finally { store.close(); }
});
