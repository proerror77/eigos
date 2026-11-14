import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from '../apps/worker/worker.js';
import { PARequests } from '../packages/runtime/pa.js';
import { Clarification } from '../packages/runtime/clarification.js';
import { fixture, principal, route } from './fixture.js';

const message = (requestId: string, conversationId = 'chat') => ({ requestId, conversationId, message: requestId });

test('inbox retains individually deduplicated deliveries in one original task', async () => {
  const f = await fixture();
  try {
    const first = await f.tasks.submit(principal, message('first'));
    const [second, redelivery] = await Promise.all([
      f.tasks.submit(principal, message('second')), f.tasks.submit(principal, message('second')),
    ]);
    assert.equal(second.id, first.id);
    assert.equal(redelivery.id, first.id);
    assert.equal(await f.tasks.claim(), undefined);
    const events = (await f.db.query(`SELECT request_id,message,position FROM ${f.db.schema}.task_inbox_events WHERE task_id=$1 ORDER BY position`, [first.id])).rows;
    assert.deepEqual(events.map(event => [event.request_id, event.message, event.position]), [['first', 'first', 1], ['second', 'second', 2]]);
    await assert.rejects(f.tasks.submit(principal, { ...message('second'), message: 'different' }), /already used/);
    await assert.rejects(f.tasks.submit(principal, message('second', 'other-chat')), /already used/);
    await assert.rejects(f.tasks.submit(principal, { requestId: 'second', message: 'second' }), /already used/);
    const otherOwner = await f.tasks.submit({ ...principal, owner: 'other' }, message('second'));
    assert.notEqual(otherOwner.id, first.id);
    await assert.rejects(f.tasks.get({ ...principal, owner: 'other' }, first.id), /unavailable/);
    await f.db.query(`UPDATE ${f.db.schema}.tasks SET available_at=now() WHERE id=$1`, [first.id]);
    const claimed = await f.tasks.claim();
    assert.equal(claimed?.id, first.id);
    assert.equal(claimed?.input.message, 'first\nsecond');
    await f.tasks.finish(claimed!, 'completed', { accepted: true });
    const completed = await f.tasks.submit(principal, message('second'));
    assert.equal(completed.id, first.id);
    assert.equal(completed.state, 'completed');
  } finally { await f.close(); }
});

test('a new lease reuses finished reads and rejects results from the superseded Worker', async () => {
  const f = await fixture();
  let returnLate!: () => void;
  const blocked = new Promise<void>(resolve => { returnLate = resolve; });
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  try {
    const task = await f.tasks.submit(principal, message('lease-first'));
    await f.db.query(`UPDATE ${f.db.schema}.tasks SET available_at=now() WHERE id=$1`, [task.id]);
    const old = await f.tasks.claim(); assert(old);
    await f.tasks.readSource(old, 'finished', {}, async () => ({ value: 'prior' }));
    const late = f.tasks.readSource(old, 'interrupted', {}, async () => { started(); await blocked; return { value: 'stale' }; });
    const rejected = assert.rejects(late, /lease ended/);
    await reading;
    const next = await f.tasks.submit(principal, message('lease-follow-up'));
    await f.db.query(`UPDATE ${f.db.schema}.tasks SET available_at=now() WHERE id=$1`, [next.id]);
    assert.equal(await f.tasks.claim(), undefined);
    await f.db.query(`UPDATE ${f.db.schema}.tasks SET lease_until=now()-interval '1 second' WHERE id=$1`, [task.id]);
    const [reclaimed, pending] = await Promise.all([f.tasks.claim(), f.tasks.claim()]);
    const current = reclaimed ?? pending;
    assert.equal(current?.id, task.id);
    assert(!(reclaimed && pending));
    assert.notEqual(current!.token, old.token);
    assert.deepEqual(await f.tasks.readSource(current!, 'finished', {}, async () => assert.fail('completed read replayed')), { value: 'prior' });
    assert.deepEqual(await f.tasks.readSource(current!, 'interrupted', {}, async () => ({ value: 'fresh' })), { value: 'fresh' });
    returnLate();
    await rejected;
    await assert.rejects(f.tasks.finish(old, 'completed', { value: 'stale' }), /lease ended/);
    await f.tasks.finish(current!, 'completed', { value: 'fresh' });
    assert.equal((await f.tasks.claim())?.id, next.id);
  } finally { returnLate(); await f.close(); }
});

test('different conversation heads run concurrently in one Worker and preserve order within a conversation', async () => {
  const f = await fixture();
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const worker = new Worker(f.tasks, { async run(task) {
    started.push(task.input.message);
    if (task.input.message === 'first') await gate;
    return { message: task.input.message };
  } });
  let running: Promise<void> | undefined;
  let workerError: unknown;
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (workerError) throw workerError;
      assert(Date.now() < deadline, `Timed out with ${started.join(', ')}`);
      await delay(15);
    }
  };
  try {
    const first = await f.tasks.submit(principal, message('first'));
    running = worker.run().catch(error => { workerError = error; });
    await waitFor(() => started.includes('first'));
    const second = await f.tasks.submit(principal, message('follow-up'));
    const independent = await f.tasks.submit(principal, message('independent', 'another-chat'));
    assert.notEqual(second.id, first.id);
    await waitFor(() => started.includes('independent'));
    assert.equal((await f.tasks.get(principal, second.id)).state, 'submitted');
    assert.deepEqual(started, ['first', 'independent']);
    release();
    await waitFor(() => started.includes('follow-up'));
    assert.equal((await f.tasks.get(principal, first.id)).state, 'completed');
    assert.equal((await f.tasks.get(principal, independent.id)).state, 'completed');
  } finally {
    release(); worker.stop(); await running; await f.close();
  }
});

test('incompatible options and scopes start later batches and PA continuation keeps its place', async () => {
  const f = await fixture(), pa = new PARequests(f.tasks);
  try {
    const first = await f.tasks.submit(principal, { ...message('first'), route });
    const second = await f.tasks.submit(principal, message('different-options'));
    const limited = { owner: principal.owner, scopes: ['tasks:write', 'tasks:read'] };
    const third = await f.tasks.submit(limited, message('different-scopes'));
    assert.equal(new Set([first.id, second.id, third.id]).size, 3);
    await f.db.query(`UPDATE ${f.db.schema}.tasks SET available_at=now()`);
    const claim = await f.tasks.claim();
    assert.equal(claim?.id, first.id);
    const schema = { type: 'object', properties: { available: { type: 'boolean' } }, required: ['available'], additionalProperties: false };
    let request: { requestId: string } | undefined;
    try { await pa.request(claim!, 'test-read', 'test.read', {}, schema); }
    catch (error) {
      assert(error instanceof Clarification);
      request = { requestId: (error.choices as { requestId: string }).requestId };
    }
    assert(request);
    await f.tasks.finish(claim!, 'input-required', { kind: 'pa-request', ...request });
    assert.equal(await f.tasks.claim(), undefined);
    const response = { ...request, response: { available: true } };
    await assert.rejects(pa.respond(principal, first.id, response, 'wrong'), /does not match/);
    await pa.respond(principal, first.id, response, 'chat');
    const resumed = await f.tasks.claim();
    assert.equal(resumed?.id, first.id);
    assert.deepEqual(await pa.request(resumed!, 'test-read', 'test.read', {}, schema), response.response);
    await f.tasks.finish(resumed!, 'completed', {});
    const next = await f.tasks.claim(); assert.equal(next?.id, second.id);
    await f.tasks.cancel(principal, second.id);
    assert.equal((await f.tasks.claim())?.id, third.id);
  } finally { await f.close(); }
});
