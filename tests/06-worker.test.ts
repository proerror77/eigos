import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Objects } from '../packages/runtime/objects.js';
import { digest } from '../packages/core/identity.js';
import { fixture, principal, route } from './fixture.js';

test('message to Interface, Links, Function, Action and quoted result completes under 20 seconds', async t => {
  const f = await fixture();
  try {
    const task = await f.submit(), before = f.db.queries;
    assert(await f.worker.runOne());
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state, 'completed', done.error ?? undefined);
    const result = done.result as { estimates: { properties: { amount: string | null } }[]; accepted: boolean; elapsedMs: number; evidence: string[] };
    assert.equal(result.estimates.length, 2); assert.equal(result.accepted, false); assert.deepEqual(result.evidence, ['fixture']);
    assert(result.estimates.some(item => item.properties.amount === '73.05'));
    assert(result.estimates.some(item => item.properties.amount === null));
    assert(result.elapsedMs < 20000);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert(!JSON.stringify(done.result).includes('PRIVATE_ORDER_TOKEN'));
    const objects = new Objects(f.db, f.model, principal.owner);
    const routes = await objects.query({ type: 'RideEstimatable' }); assert.equal(routes.items.length, 1);
    assert.equal((await objects.follow(routes.items[0]!.ref, 'origin', 'RideEstimatable'))[0]!.properties.name, route.origin);
    assert.equal(Number((await f.db.query(`SELECT count(*) FROM ${f.db.schema}.actions`)).rows[0]!.count), 1);
    assert.equal(await f.worker.runOne(), false);
    t.diagnostic(JSON.stringify({ elapsedMs: result.elapsedMs, sqlStatements: f.db.queries - before, providerCalls: f.provider.calls.length }));
  } finally { await f.close(); }
});
test('ambiguous places ask for the original address before requesting a quote', async () => {
  const f = await fixture();
  try {
    f.provider.flags.ambiguous = true;
    const task = await f.submit(); await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'input-required');
    assert.equal(f.provider.calls.length, 2);
    const rows = await f.db.query(`SELECT name,result FROM ${f.db.schema}.source_calls WHERE task_id=$1`, [task.id]);
    const choose = (name: string) => {
      const result = rows.rows.find(row => row.name === name)!.result;
      return { type: 'Place', id: digest([result.receipt.bindingId, result.data.places[0].id]) };
    };
    await f.tasks.selectPlaces(principal, task.id, { origin: choose('origin'), destination: choose('destination') });
    await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'completed');
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
  } finally { await f.close(); }
});

test('revocation during the real connector callback cannot produce an accepted inquiry', async () => {
  const f = await fixture();
  try {
    f.provider.flags.before = async () => { f.provider.flags.active = false; };
    const task = await f.submit(); await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'failed');
    assert.equal((await new Objects(f.db, f.model, principal.owner).query({ type: 'PriceEstimate' })).items.length, 0);
  } finally { await f.close(); }
});
