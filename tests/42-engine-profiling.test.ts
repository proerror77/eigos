import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { profileDatabase, type DatabaseProfile } from '../packages/core/database-profile.js';
import { Access, businessGrants, setGrants, type Permission } from '../packages/runtime/access.js';
import { initializeEditHistory } from '../packages/runtime/edit-history.js';
import { Indexing, initializeIndexing } from '../packages/runtime/indexing.js';
import { initializeMaterializations } from '../packages/runtime/materializations.js';
import { lockEdits } from '../packages/runtime/scenario-store.js';
import { fixture, principal } from './fixture.js';

test('a nested profile counts its own statements and also charges the enclosing operation', async () => {
  const f = await fixture();
  try {
    let outer!: DatabaseProfile, inner!: DatabaseProfile;
    await profileDatabase(async profile => {
      outer = profile;
      await f.db.query('SELECT 1');
      await f.db.query('SELECT 2');
      await profileDatabase(async nested => {
        inner = nested;
        for (let index = 0; index < 3; index++) await f.db.query('SELECT $1::int', [index]);
      });
    });
    assert.equal(inner.statements, 3);
    assert.equal(outer.statements, 5);
    assert(inner.durationMs > 0 && outer.durationMs >= inner.durationMs);
  } finally { await f.close(); }
});

test('edit lock waits are charged to the waiting operation and hold time to the holder', async () => {
  const f = await fixture();
  try {
    let holder!: DatabaseProfile, waiter!: DatabaseProfile, acquired!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const first = profileDatabase(async profile => {
      holder = profile;
      await f.db.transaction(async client => {
        await lockEdits(f.db, f.model, principal.owner, client);
        acquired();
        await delay(300);
      });
    });
    await locked;
    const second = profileDatabase(async profile => {
      waiter = profile;
      await f.db.transaction(client => lockEdits(f.db, f.model, principal.owner, client));
    });
    await Promise.all([first, second]);
    assert(waiter.editLockWaitMs >= 200, `waited ${waiter.editLockWaitMs} ms`);
    assert(holder.editLockHoldMs >= 250, `held ${holder.editLockHoldMs} ms`);
    assert(holder.editLockWaitMs < 200, `holder waited ${holder.editLockWaitMs} ms`);
    assert.equal(waiter.lockTimeouts, 0);
  } finally { await f.close(); }
});

test('a lock timeout is counted for the operation that gave up waiting', async () => {
  const f = await fixture();
  try {
    let waiter!: DatabaseProfile, acquired!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const holding = f.db.transaction(async client => {
      await lockEdits(f.db, f.model, principal.owner, client);
      acquired();
      await released;
    });
    await locked;
    try {
      await assert.rejects(profileDatabase(async profile => {
        waiter = profile;
        await f.db.transaction(client => lockEdits(f.db, f.model, principal.owner, client));
      }), (error: { code?: string }) => error.code === '55P03');
    } finally { release(); await holding; }
    assert.equal(waiter.lockTimeouts, 1);
    assert(waiter.editLockWaitMs >= 1500, `the abandoned wait lasted ${waiter.editLockWaitMs} ms`);
  } finally { await f.close(); }
});

test('applying a source transaction logs its object count and database profile without row content', async t => {
  const f = await fixture();
  try {
    await initializeEditHistory(f.db); await initializeIndexing(f.db); await initializeMaterializations(f.db);
    await setGrants(f.db, principal.owner, [...businessGrants(f.model), { resource: 'Eigos/datasource/DidiPlaces', permission: 'ingest_source' as Permission }]);
    const access = await Access.load(f.db, principal), indexing = new Indexing(f.db, f.metadata);
    const observedAt = new Date(Date.now() - 60000).toISOString();
    const row = (id: string) => ({ id, name: 'private-place-' + id, city: '上海', address: '上海', coordinates: { lat: 31.2, lng: 121.5 },
      coordinateSystem: 'GCJ-02', sourceBinding: 'synthetic', observedAt });
    const submitted = await indexing.submit(access, f.model, { source: 'DidiPlaces', stream: 'synthetic-stream', offset: 1, mode: 'stream',
      observedAt, rows: ['a', 'b', 'c'].map(row) });
    const logger = t.mock.method(console, 'info', (_line: string) => {});
    assert.equal(await indexing.runOne(), true);
    const records = logger.mock.calls.map(call => JSON.parse(call.arguments[0])).filter(entry => entry.event === 'index_apply');
    assert.equal(records.length, 1);
    const [entry] = records;
    assert.equal(entry.transactionId, submitted.id);
    assert.equal(entry.source, 'DidiPlaces');
    assert.equal(entry.objects, 3);
    assert.equal(entry.state, 'applied');
    assert(entry.durationMs >= 0 && entry.db.statements > 3 && entry.db.editLockHoldMs >= 0);
    assert(!JSON.stringify(records).includes('private-place'));
  } finally { await f.close(); }
});
