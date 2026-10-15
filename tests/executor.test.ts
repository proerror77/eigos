// State-machine regression fixtures only. These are not evidence of live model or Grok execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../src/store.js';
import { TaskService } from '../src/tasks.js';
import { decisionSchema, type Executor, type ExecutionResult } from '../src/executor.js';
import { SCOPES, ownerKey, type Principal, type Job } from '../src/domain.js';

const p: Principal = { issuer: 'test', subject: 'alice', tenant: 'org', clientId: 'test', scopes: [...SCOPES] };
function result(decision: 'ask_user' | 'complete'): ExecutionResult {
  return { output: { decision, message: decision === 'ask_user' ? 'Fixture question' : 'Fixture done', artifact: decision === 'complete' ? '# Fixture output' : '' },
    evidence: { id: randomUUID(), runtime: 'test-fixture', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', outputSha256: 'test-only' } };
}

test('real executor must be explicitly enabled; reference brief remains separate', () => {
  const store = new JobStore(':memory:');
  try {
    const tasks = new TaskService(store);
    assert.throws(() => tasks.submit(p, { service: 'agent.execute', goal: 'test', requestId: '1' }), /not configured/);
    assert.equal(tasks.list(p, { limit: 10, offset: 0 }).total, 0);
  } finally { store.close(); }
});

test('async model decisions persist; retry does not run again; reply carries full history', async () => {
  const seen: Job[] = [];
  const executor: Executor = { run: async job => { seen.push(job); return result(seen.length === 1 ? 'ask_user' : 'complete'); } };
  const store = new JobStore(':memory:');
  const tasks = new TaskService(store, executor);
  try {
    const input = { service: 'agent.execute', goal: 'Create agenda', requestId: 'submit' };
    const submitted = tasks.submit(p, input);
    assert.equal(submitted.state, 'working');
    tasks.submit(p, input);
    const waiting = await tasks.wait(p, submitted.id);
    assert.equal(waiting.state, 'input-required');
    assert.equal(seen.length, 1);
    tasks.submit(p, input);
    assert.equal(seen.length, 1);
    assert.throws(() => tasks.reply({ ...p, subject: 'bob' }, { taskId: submitted.id, answer: 'bad', requestId: 'x' }), /not found/);
    const answer = { taskId: submitted.id, answer: '90 minutes, 12 people', requestId: 'answer' };
    tasks.reply(p, answer); tasks.reply(p, answer);
    const completed = await tasks.wait(p, submitted.id);
    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.messages.at(-1)?.text, answer.answer);
    assert.equal(seen[1]?.messages[0]?.text, input.goal);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.runs?.length, 2);
    assert.equal(completed.artifact?.data.markdown, '# Fixture output');
    assert.equal(completed.artifact?.data.execution, 'completed');
  } finally { await tasks.close(); store.close(); }
});

test('cancel aborts execution and late model results cannot complete canceled tasks', async () => {
  let release!: (value: ExecutionResult) => void;
  let signal!: AbortSignal;
  const executor: Executor = { run: async (_job, s) => { signal = s; return new Promise(resolve => { release = resolve; }); } };
  const store = new JobStore(':memory:'); const tasks = new TaskService(store, executor);
  try {
    const job = tasks.submit(p, { service: 'agent.execute', goal: 'test', requestId: 'x' });
    await Promise.resolve();
    tasks.cancel(p, job.id);
    assert(signal.aborted);
    release(result('complete'));
    await tasks.close();
    assert.equal(tasks.get(p, job.id).state, 'canceled');
    assert.equal(tasks.get(p, job.id).artifact, undefined);
  } finally { store.close(); }
});

test('failed execution is visible and never silently replaced with a template', async () => {
  const store = new JobStore(':memory:');
  const tasks = new TaskService(store, { run: async () => { throw new Error('Test provider unavailable'); } });
  try {
    const job = tasks.submit(p, { service: 'agent.execute', goal: 'test', requestId: 'x' });
    const failed = await tasks.wait(p, job.id);
    assert.equal(failed.state, 'failed'); assert.equal(failed.artifact, undefined);
    assert.match(failed.error!, /provider unavailable/);
  } finally { await tasks.close(); store.close(); }
});

test('restart marks interrupted work failed instead of replaying a billed model call', () => {
  const store = new JobStore(':memory:');
  const tasks = new TaskService(store);
  try {
    const job = tasks.submit(p, { goal: 'test', requestId: 'x' });
    store.save(ownerKey(p), { ...job, service: 'agent.execute', state: 'working' });
    store.interruptWorking();
    assert.equal(tasks.get(p, job.id).state, 'failed');
    assert.match(tasks.get(p, job.id).error!, /restart/);
  } finally { store.close(); }
});

test('executor rejects empty completion and mixed clarification/output', () => {
  assert.throws(() => decisionSchema.parse({ decision: 'complete', message: 'done', artifact: '' }));
  assert.throws(() => decisionSchema.parse({ decision: 'ask_user', message: 'question', artifact: 'premature output' }));
});
