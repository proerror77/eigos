import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { evidence, owner, principal } from './backend-fixture.js';
import { setup, bookChoice, observe, decide, step, type Choice } from './fixtures/paotui-agent.js';
import { executionBudgetStatus, ReasoningBudgetExhausted } from '../packages/core/execution-budget.js';
import { Worker } from '../apps/worker/worker.js';

const askForInput: Choice = (ctx, access) => {
  const items = observe(ctx, access);
  if (!items.length) return decide(ctx, [step('book', 'ReadSavedAddresses', { scope: ctx.state.scope })]);
  return ctx.request.messages.at(-1)!.text === '完成'
    ? decide(ctx, [], { observation: items[0]!.ref, rationale: 'Owner finished supplying information' })
    : { ...decide(ctx), kind: 'clarify', message: '请补充说明。此前信息已保留。' };
};

test('accepted input opens bounded windows in the SAME task beyond 32 cumulative calls without deleting history', async () => {
  const f = setup(askForInput, 'addresses');
  try {
    const job = f.b.submit({ goal: '本人地址簿查询' });
    let paused = await f.finish(job.id);
    const firstRuns = paused.runs!.map(r => r.id);
    for (let n = 0; n < 17; n++) {
      assert.equal(paused.state, 'input-required');
      f.b.tasks.reply(principal, { taskId: job.id, requestId: randomUUID(), answer: `补充信息${n}` });
      paused = await f.finish(job.id);
    }
    assert.equal(paused.runs!.length, 54);
    assert.deepEqual(paused.runs!.slice(0, firstRuns.length).map(r => r.id), firstRuns);
    assert.equal(executionBudgetStatus(paused).windowUsed.modelTurns, 3);
    f.b.tasks.reply(principal, { taskId: job.id, requestId: randomUUID(), answer: '完成' });
    const done = await f.finish(job.id);
    assert.equal(done.state, 'completed'); assert.equal(done.id, job.id); assert.equal(done.runs!.length, 57);
    assert.equal(f.b.tasks.list(principal, { limit: 10, offset: 0 }).total, 1);
    assert(f.store.intents(owner, job.id).every(i => i.state === 'effect_confirmed'), 'Replies retain verified historical read receipts');
  } finally { f.store.close(); }
});

test('a continuous window stops at its limit and an owned reply continues the original task', async () => {
  const f = setup(bookChoice, 'addresses');
  try {
    const job = f.b.submit({ goal: '读取本人地址簿' }); await f.b.run(); await f.b.run();
    const saved = f.store.get(owner, job.id); while (saved.runs!.length < 31) saved.runs!.push(evidence()); f.store.save(owner, saved);
    const paused = await f.b.run();
    assert.equal(paused.state, 'input-required'); assert.equal(paused.delegation!.executionBudget!.paused!.scope, 'window');
    assert.equal(paused.runs!.length, 31); assert.equal(f.calls.length, 1, 'One remaining turn cannot cover required ontology reads plus a final decision');
    f.b.tasks.reply(principal, { taskId: job.id, requestId: randomUUID(), answer: '继续' });
    const done = await f.finish(job.id);
    assert.equal(done.state, 'completed'); assert.equal(done.runs!.length, 34); assert.equal(done.id, job.id);
  } finally { f.store.close(); }
});

test('a bounded reasoning loop without a final decision pauses the original task instead of failing it', async () => {
  const f = setup(bookChoice, 'addresses');
  const worker = new Worker(f.store, { coordinator: { run: async () => { throw new ReasoningBudgetExhausted(); } }, pollMs: 10 });
  try {
    const job = f.b.submit({ goal: '读取本人地址簿' }); worker.start();
    const deadline = Date.now() + 2000;
    while (['submitted', 'working'].includes(f.store.get(owner, job.id).state) && Date.now() < deadline) await delay(10);
    const paused = f.store.get(owner, job.id); assert.equal(paused.state, 'input-required'); assert(!paused.error);
    assert.equal(paused.delegation!.executionBudget!.paused!.resource, 'reasoning'); assert.equal(f.calls.length, 0);
  } finally { await worker.close(); f.store.close(); }
});

test('cumulative limits cannot be reset by repeated replies; an authorized extended profile continues the SAME task', async () => {
  const f = setup(bookChoice, 'addresses');
  try {
    const job = f.b.submit({ goal: '读取本人地址簿' }); await f.b.run(); await f.b.run();
    const saved = f.store.get(owner, job.id); while (saved.runs!.length < 128) saved.runs!.push(evidence()); f.store.save(owner, saved);
    assert.equal((await f.b.run()).state, 'input-required');
    const reply = { taskId: job.id, requestId: randomUUID(), answer: '继续' };
    const paused = f.b.tasks.reply(principal, reply); assert.equal(paused.state, 'input-required');
    assert.equal(paused.delegation!.executionBudget!.paused!.scope, 'task');
    assert.deepEqual(f.b.tasks.reply(principal, reply), paused, 'Idempotent reply does not allocate another window');
    assert.equal(f.store.get(owner, job.id).runs!.length, 128);
    assert.throws(() => f.b.tasks.reply({ ...principal, subject: 'someone-else' }, { ...reply, requestId: randomUUID(), executionBudget: 'extended' }));
    f.b.tasks.reply(principal, { taskId: job.id, requestId: randomUUID(), answer: '使用扩展预算继续', executionBudget: 'extended' });
    const done = await f.finish(job.id);
    assert.equal(done.state, 'completed'); assert.equal(done.id, job.id); assert.equal(done.runs!.length, 131);
    const status = f.b.tasks.get(principal, job.id).delegation!.executionBudgetStatus!;
    assert.equal(status.profile, 'extended'); assert.equal(status.limits.task.modelTurns, 256);
    assert.equal(status.used.modelTurns, 131); assert.equal(status.windowUsed.modelTurns, 3);
  } finally { f.store.close(); }
});

test('long tasks can select a larger continuous allowance at submission', async () => {
  const f = setup(bookChoice, 'addresses');
  try {
    const job = f.b.submit({ goal: '读取本人地址簿', executionBudget: 'extended' }); await f.b.run(); await f.b.run();
    const saved = f.store.get(owner, job.id); while (saved.runs!.length < 40) saved.runs!.push(evidence()); f.store.save(owner, saved);
    const done = await f.b.run(); assert.equal(done.state, 'completed'); assert.equal(done.runs!.length, 41);
    assert.equal(f.calls.length, 1); assert.equal(done.delegation!.executionBudget!.window.sequence, 1);
  } finally { f.store.close(); }
});

test('waiting for owner input does not consume the next execution window time; original creation time is retained', async () => {
  const f = setup(askForInput, 'addresses');
  try {
    const job = f.b.submit({ goal: '读取本人地址簿' }); await f.finish(job.id);
    const saved = f.store.get(owner, job.id), old = new Date(Date.now() - 7 * 86400000).toISOString();
    saved.createdAt = old; saved.delegation!.executionBudget!.window.startedAt = old; f.store.save(owner, saved);
    f.b.tasks.reply(principal, { taskId: job.id, requestId: randomUUID(), answer: '完成' });
    const done = await f.finish(job.id); assert.equal(done.state, 'completed'); assert.equal(done.createdAt, old);
    assert(Date.parse(done.delegation!.executionBudget!.window.startedAt) > Date.parse(old));
  } finally { f.store.close(); }
});
