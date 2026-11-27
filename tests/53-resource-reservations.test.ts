import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceReservations } from '../packages/runtime/resource-reservations.js';
import { fixture } from './fixture.js';

test('two concurrent Actions cannot reserve the same resource and interval', async () => {
  const f = await fixture();
  try {
    const ledger = new ResourceReservations(f.db);
    const same = { resource: 'synthetic-shared-resource', allocation: 'activity',
      start: '2026-12-01T09:00:00Z', end: '2026-12-01T10:00:00Z' };
    const requests = await Promise.allSettled(['owner-a','owner-b'].map(owner =>
      f.db.transaction(client => ledger.replace(owner, 'holder', [same], 'committed', client))));
    assert.equal(requests.filter(result => result.status === 'fulfilled').length, 1);
    const loser = requests.find(result => result.status === 'rejected');
    assert(loser && /reserved in that interval/.test(String(loser.reason)));
    const active = await f.db.query(`SELECT owner,state FROM ${f.db.schema}.resource_reservations WHERE state='committed'`);
    assert.equal(active.rows.length, 1);
    const winner = active.rows[0]!.owner as string;
    await f.db.transaction(client => ledger.replace(winner, 'holder', [same], 'committed', client));
    await f.db.transaction(client => ledger.replace('owner-c', 'next-holder',
      [{ ...same, start: same.end, end: '2026-12-01T11:00:00Z' }], 'held', client));
    await assert.rejects(f.db.transaction(client => ledger.replace(winner, 'holder',
      [{ ...same, end: '2026-12-01T10:30:00Z' }], 'committed', client)), /reserved in that interval/);
    const after = await f.db.query(`SELECT owner,state,upper(occupied_at) AS finish
      FROM ${f.db.schema}.resource_reservations WHERE state IN ('held','committed') ORDER BY owner`);
    assert.equal(after.rows.length, 2);
    assert.equal(after.rows.find(row => row.owner === winner)?.finish.toISOString(), '2026-12-01T10:00:00.000Z');
    await f.db.transaction(client => ledger.replace(winner, 'holder', [], 'committed', client));
    await f.db.transaction(client => ledger.replace('owner-d', 'released-slot', [same], 'committed', client));
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.db.schema}.resource_reservations WHERE owner=$1 AND state='released'`, [winner])).rowCount, 1);
  } finally { await f.close(); }
});
