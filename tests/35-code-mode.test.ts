import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodeMode } from '../apps/gateway/code-mode.js';
import { PermissionDenied } from '../packages/core/identity.js';

test('Code Mode keeps intermediate results in the isolate and exposes only the query bridge', async () => {
  const seen: string[] = [];
  const result = await new CodeMode().execute(`async ({ query }) => {
    const first = await query({ type: "TableCheckReservation" });
    const second = await query({
      type: "TableCheckReservationStateLog",
      where: { processId: first.items[0].id },
    });
    return {
      count: second.items.length,
      host: [typeof fetch, typeof require, typeof process],
    };
  }`, async input => {
    seen.push(input.type);
    if (input.type === 'TableCheckReservation') return { items: [{ id: 'reservation', intermediate: 'private payload' }] };
    assert.equal(input.where?.processId, 'reservation');
    return { items: [{ state: 'unknown', intermediate: 'private log' }] };
  }, new AbortController().signal);
  assert.deepEqual(seen, ['TableCheckReservation', 'TableCheckReservationStateLog']);
  assert.deepEqual(result, { count: 1, host: ['undefined', 'undefined', 'undefined'] });
});

test('Code Mode enforces input and output limits and fails closed on a forbidden read', async () => {
  const mode = new CodeMode(), signal = new AbortController().signal;
  const execute = (code: string, query = async () => ({ items: [] as unknown[] })) => mode.execute(code, query, signal);
  await assert.rejects(execute('async ({ query }) => { await query({type:"RideRequest"}); }}'), /Code Mode program:/);
  await assert.rejects(execute('async ({ query }) => query({type:"RideRequest",limit:101})'), /query 1 \(limit\)/);
  await assert.rejects(execute(`async ({ query }) => {
    await query({type:"RideRequest"});
    return "x".repeat(65_537);
  }`), /result is too large/);
  await assert.rejects(execute(`async ({ query }) => {
    try { await query({type:"RideRequest"}); } catch {}
    return { count: 0 };
  }`, async () => { throw new PermissionDenied('Read denied'); }), PermissionDenied);
  await assert.rejects(execute('async ({ query }) => Promise.all(Array.from({ length: 13 }, () => query({type:"RideRequest"})))'),
    /up to 12 queries/);
  await assert.rejects(execute('async () => ({ count: 0 })'), /Await all queries/);
});

test('Code Mode cancels running JavaScript when its caller disconnects and frees capacity', async () => {
  const mode = new CodeMode(), cancel = new AbortController();
  const reason = new Error('client disconnected');
  const running = mode.execute('async () => { while (true) {} }', async () => ({}), cancel.signal);
  const timer = setTimeout(() => cancel.abort(reason), 250);
  try { await assert.rejects(running, reason); }
  finally { clearTimeout(timer); }
});
