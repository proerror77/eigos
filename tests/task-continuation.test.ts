import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setup, bookChoice } from './fixtures/paotui-agent.js';
import { owner, principal } from './backend-fixture.js';
import { scheduleTaskRecovery, canRecoverReadOnly } from '../packages/core/task-recovery.js';
import type { ExecutionPlan } from '../packages/ontology/execution.js';

test('versioned corrections reject stale replies and preserve source handoffs, ownership and idempotency', async () => {
  const f = setup(); try {
    const original = f.b.submit({ goal: '文件1公斤普通送，先选地址' }), asked = await f.finish(original.id);
    const input = { taskId: original.id, requestId: randomUUID(), expectedRevision: asked.revision!, answer: '重量改为500克' };
    const amended = f.b.tasks.amend(principal, input); assert.equal(amended.id, original.id);
    assert.deepEqual(f.b.tasks.amend(principal, input), amended);
    assert.equal(amended.delegation!.request.confirmedInputs!.paotui!.fields.weightKg!.value, 0.5);
    assert.throws(() => f.b.tasks.reply(principal, { ...input, requestId: randomUUID(), answer: '1寄到2' }), /older/);
    assert.throws(() => f.b.tasks.amend(principal, { ...input, requestId: randomUUID(), expectedRevision: amended.revision!, answer: '继续' }), /resume_task/);
    assert.throws(() => f.b.tasks.amend({ ...principal, subject: 'other' }, { ...input, requestId: randomUUID() }), /not found/);
    const waiting = f.store.get(owner, original.id); waiting.state = 'auth-required'; waiting.delegation!.phase = 'awaiting_authorization';
    waiting.delegation!.sourceAuthorization = { provider: 'meituan-paotui', nextAction: 'begin_source_connection', resumeAction: 'resume_source_task' }; f.store.save(owner, waiting);
    const corrected = f.b.tasks.amend(principal, { ...input, requestId: randomUUID(), expectedRevision: waiting.revision!, answer: '重量改为700克' });
    assert.equal(corrected.state, 'auth-required'); assert(corrected.delegation!.sourceAuthorization);
    f.b.tasks.cancel(principal, original.id);
    assert.throws(() => f.b.tasks.amend(principal, { ...input, requestId: randomUUID(), expectedRevision: corrected.revision! }), /open read-only/);
  } finally { f.store.close(); }
});

test('a correction during an in-flight read fences the old result and continues the same task', { timeout: 5000 }, async () => {
  const f = setup(bookChoice, 'addresses'); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.flags.before = async () => { enter(); await held; };
  try {
    const original = f.b.submit({ goal: '读取本人地址簿' });
    await f.b.run(); // Grounding; the next decision dispatches its selected read.
    const claim = f.store.claim(['eigos.delegate'], 15000)!;
    const reading = f.b.coordinator.run(claim, new AbortController().signal); await entered;
    const current = f.store.get(owner, original.id);
    const amended = f.b.tasks.amend(principal, { taskId: original.id, requestId: randomUUID(), expectedRevision: current.revision!, answer: '只需读取当前保存地址' });
    release(); await reading; f.store.release(claim);
    assert.equal(f.store.ontology.query(owner, { type: 'PaotuiObservation' }).items.length, 0, 'A superseded lease cannot project its old result');
    assert.equal(f.store.get(owner, original.id).revision, amended.revision);
    f.flags.before = undefined;
    const done = await f.finish(original.id); assert.equal(done.state, 'completed'); assert.equal(done.id, original.id);
    assert.equal(done.delegation!.request.messages.length, 2); assert.equal(f.calls.length, 2);
  } finally { release(); f.store.close(); }
});

test('technical continuation keeps business revision and refuses additional business effects', () => {
  const f = setup(bookChoice, 'addresses'); try {
    const job = f.b.submit({ goal: '读取本人地址簿' }); scheduleTaskRecovery(job, 'worker_timeout', 'Fixture pause', { automatic: false }); f.store.save(owner, job);
    const input = { taskId: job.id, requestId: randomUUID(), expectedRevision: job.revision! };
    assert.throws(() => f.b.tasks.resume({ ...principal, subject: 'other' }, input), /not found/);
    const resumed = f.b.tasks.resume(principal, input); assert.deepEqual(f.b.tasks.resume(principal, input), resumed);
    assert.equal(resumed.delegation!.request.revision, job.delegation!.request.revision); assert.equal(resumed.messages.length, 1);
    assert.throws(() => f.b.tasks.resume(principal, { ...input, requestId: randomUUID() }), /current technical pause/);
    const unsafe = structuredClone(job); unsafe.delegation!.plan = { steps: [{ effect: 'read', additionalEffects: ['order'] }] } as ExecutionPlan;
    assert.equal(canRecoverReadOnly(unsafe, []), false); assert.equal(canRecoverReadOnly(job, [{ effect: 'payment' }]), false);
  } finally { f.store.close(); }
});
