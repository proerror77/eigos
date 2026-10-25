import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Worker } from '../apps/worker/worker.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { AgentReadError } from '../packages/core/agent-program.js';
import { setup, bookChoice, paotuiModel } from './fixtures/paotui-agent.js';
import { owner, principal } from './backend-fixture.js';

// These cases exercise recovery, not lease expiry (covered by dispatch-lease-fence).
// Bound waiting even when a regression prevents the intended state.
async function waitFor(predicate: () => boolean, describe: () => string, timeout = 30000) {
  const until = Date.now() + timeout;
  while (!predicate() && Date.now() < until) await delay(10);
  assert(predicate(), describe());
}

async function settle(f: ReturnType<typeof setup>, id: string, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const job = f.store.get(owner, id);
    if (!['submitted', 'working'].includes(job.state)) return job;
    await delay(20);
  }
  throw new Error('Technical recovery did not settle');
}

test('graceful Worker interruption continues the original task after restart without owner messages', async () => {
  const f = setup(bookChoice, 'addresses'), normal = paotuiModel(bookChoice, 'addresses'); let entered = false;
  const interrupted = { ...normal, ground: async (...args: Parameters<typeof normal.ground>) => {
    entered = true; await new Promise<void>((_resolve, reject) => args[2].addEventListener('abort', () => reject(new Error('Interrupted fixture')), { once: true }));
    return normal.ground(...args);
  } };
  const one = new Worker(f.store, { coordinator: new Coordinator(f.store, interrupted, f.catalog), pollMs: 10, leaseMs: 30000 });
  let two: Worker | undefined;
  try {
    const job = f.b.submit({ goal: '读取本人地址簿' }); one.start();
    await waitFor(() => entered, () => JSON.stringify({ state: f.store.get(owner, job.id).state, recovery: f.store.get(owner, job.id).delegation?.recovery }));
    await one.close();
    const retained = f.store.get(owner, job.id); assert.equal(retained.state, 'working'); assert.equal(retained.delegation!.recovery!.code, 'worker_interrupted'); assert(!retained.question);
    two = new Worker(f.store, { coordinator: new Coordinator(f.store, normal, f.catalog), pollMs: 10, leaseMs: 30000 }); two.start();
    const done = await settle(f, job.id); assert.equal(done.state, 'completed'); assert.equal(done.id, job.id); assert.equal(done.delegation!.request.messages.length, 1);
    assert.equal(done.delegation!.recovery!.state, 'resolved'); assert.equal(f.calls.length, 1);
  } finally { await one.close(); await two?.close(); f.store.close(); }
});

test('a transient provider read is recorded and a new model-selected read continues the SAME task', async () => {
  const f = setup(bookChoice, 'addresses'); let failures = 0;
  f.flags.before = async () => { if (!failures++) throw new AgentReadError('Transient fixture transport'); };
  const worker = new Worker(f.store, { coordinator: new Coordinator(f.store, paotuiModel(bookChoice, 'addresses'), f.catalog), pollMs: 10, leaseMs: 30000 });
  try {
    const job = f.b.submit({ goal: '读取本人地址簿' }); worker.start(); const done = await settle(f, job.id);
    assert.equal(done.state, 'completed'); assert.equal(done.delegation!.request.messages.length, 1); assert(!done.question);
    assert.equal(done.delegation!.recovery!.state, 'resolved'); assert.equal(f.calls.length, 2);
    const intents = f.store.intents(owner, job.id); assert.equal(intents.length, 2);
    assert.equal(intents.filter(i => i.state === 'effect_confirmed').length, 1); assert.equal(intents.flatMap(i => f.store.attempts(owner, i.id)).length, 2);
  } finally { await worker.close(); f.store.close(); }
});

test('three unchanged source failures pause technically; restoring the source resumes without a fake answer', async () => {
  const f = setup(bookChoice, 'addresses'); let unavailable = true;
  f.flags.before = async () => { if (unavailable) throw new AgentReadError('Unchanged fixture transport'); };
  const worker = new Worker(f.store, { coordinator: new Coordinator(f.store, paotuiModel(bookChoice, 'addresses'), f.catalog), pollMs: 10, leaseMs: 30000 });
  try {
    const job = f.b.submit({ goal: '读取本人地址簿' }); worker.start(); const paused = await settle(f, job.id);
    assert.equal(paused.state, 'paused'); assert(!paused.question); assert.equal(paused.delegation!.recovery!.attempts, 3); assert.equal(f.calls.length, 3);
    assert.throws(() => f.b.tasks.reply(principal, { taskId: job.id, answer: '继续', requestId: randomUUID() }), /not waiting/);
    unavailable = false;
    const input = { taskId: job.id, requestId: randomUUID(), expectedRevision: paused.revision! }, resumed = f.b.tasks.resume(principal, input);
    assert.deepEqual(f.b.tasks.resume(principal, input), resumed);
    const done = await settle(f, job.id); assert.equal(done.state, 'completed'); assert.equal(done.delegation!.request.messages.length, 1); assert.equal(f.calls.length, 4);
  } finally { await worker.close(); f.store.close(); }
});

test('canceling a scheduled technical recovery prevents all later reads and resumes', async () => {
  const f = setup(bookChoice, 'addresses');
  f.flags.before = async () => { throw new AgentReadError('Unavailable fixture'); };
  const worker = new Worker(f.store, { coordinator: new Coordinator(f.store, paotuiModel(bookChoice, 'addresses'), f.catalog), pollMs: 10, leaseMs: 30000 });
  try {
    const job = f.b.submit({ goal: '读取本人地址簿' }); worker.start();
    await waitFor(() => f.store.get(owner, job.id).delegation?.recovery?.state === 'scheduled', () => JSON.stringify({ state: f.store.get(owner, job.id).state, recovery: f.store.get(owner, job.id).delegation?.recovery }));
    f.b.tasks.cancel(principal, job.id); await delay(1200);
    assert.equal(f.store.get(owner, job.id).state, 'canceled'); assert.equal(f.calls.length, 1);
    assert.throws(() => f.b.tasks.resume(principal, { taskId: job.id, requestId: randomUUID(), expectedRevision: job.revision! }));
  } finally { await worker.close(); f.store.close(); }
});
