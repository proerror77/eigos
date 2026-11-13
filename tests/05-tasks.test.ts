import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal, route } from './fixture.js';

test('concurrent submissions retain one task and cancellation fences late results', async () => {
  const f = await fixture();
  try {
    const input = { requestId: 'same-request', message: '只询价', route };
    const [a, b] = await Promise.all([f.tasks.submit(principal, input), f.tasks.submit(principal, input)]);
    assert.equal(a.id, b.id);
    await assert.rejects(f.tasks.submit(principal, { ...input, message: 'different' }), /already used/);
    const [first, second] = await Promise.all([f.tasks.claim(), f.tasks.claim()]);
    assert.equal([first, second].filter(Boolean).length, 1);
    const claim = first ?? second; assert(claim);
    await f.tasks.cancel(principal, claim.id);
    await assert.rejects(f.tasks.finish(claim, 'completed', { fabricated: true }), /canceled/);
    assert.equal((await f.tasks.get(principal, claim.id)).state, 'canceled');
    await assert.rejects(f.tasks.get({ ...principal, owner: 'other' }, claim.id));
  } finally { await f.close(); }
});
