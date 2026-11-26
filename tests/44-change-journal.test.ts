import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Access } from '../packages/runtime/access.js';
import { Database } from '../packages/runtime/database.js';
import { Objects } from '../packages/runtime/objects.js';
import { installOwnerIsolation } from '../packages/runtime/owner-isolation.js';
import { fixture, principal } from './fixture.js';

const route = (id: string) => ({ type: 'Route', id });
const place = (id: string) => ({ type: 'Place', id });
const placeFields = (id: string) => ({ id, name: id, city: 'Shanghai', address: 'A', coordinates: { lat: 31, lng: 121 },
  coordinateSystem: 'GCJ02', sourceBinding: 'test', observedAt: new Date().toISOString() });

test('committed changes are ordered by commit, not by when their history rows were written', async () => {
  const f = await fixture();
  try {
    // Object-scoped commits share the owner lock, so a later writer can commit first.
    const create = (id: string, name: string, hold?: () => Promise<void>) => f.db.objectScopedTransaction(async client => {
      await new Objects(f.db, f.model, f.access, client).create(route(id), { id, name });
      await hold?.();
    }, 'test');
    let release!: () => void, written!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; }), inside = new Promise<void>(resolve => { written = resolve; });
    const first = create('written-first', 'First', async () => { written(); await released; });
    await inside;
    await create('committed-first', 'Second');
    release(); await first;
    const { rows } = await f.db.query(`SELECT h.id, h.sequence::int AS sequence, c.commit_seq::int AS commit FROM ${f.db.schema}.edit_history h
      JOIN ${f.db.schema}.change_commits c ON c.owner=h.owner AND c.xact=h.xact WHERE h.owner=$1 AND h.type='Route' ORDER BY c.commit_seq`, [principal.owner]);
    assert.deepEqual(rows.map(row => row.id), ['committed-first', 'written-first']);
    const [later, earlier] = [rows[0]!, rows[1]!];
    assert(earlier.sequence < later.sequence, 'the first transaction wrote its history row first');
  } finally { await f.close(); }
});

test('relationship changes are journaled in the transaction that makes them, including cascades', async () => {
  const f = await fixture();
  try {
    const graph = new Objects(f.db, f.model, f.access);
    await graph.create(route('journey'), { id: 'journey', name: 'Journey' });
    await graph.create(place('start'), placeFields('start'));
    const edge = { type: 'RouteOrigin', from: route('journey'), to: place('start') };
    await graph.link(edge);
    await graph.link(edge);
    await assert.rejects(f.db.transaction(async client => {
      await new Objects(f.db, f.model, f.access, client).unlink(edge);
      throw new Error('roll back');
    }), /roll back/);
    await graph.unlink(edge);
    await graph.link(edge);
    await graph.remove(route('journey'), (await graph.read(route('journey'))).revision);
    const { rows } = await f.db.query(`SELECT l.operation, l.type, l.from_id, l.to_id, l.actor, c.commit_seq IS NOT NULL AS committed
      FROM ${f.db.schema}.link_history l LEFT JOIN ${f.db.schema}.change_commits c ON c.owner=l.owner AND c.xact=l.xact
      WHERE l.owner=$1 ORDER BY l.sequence`, [principal.owner]);
    assert.deepEqual(rows.map(row => row.operation), ['link', 'unlink', 'link', 'unlink'],
      'an unchanged relink is not journaled and a rolled-back unlink leaves no record');
    assert(rows.every(row => row.type === 'RouteOrigin' && row.from_id === 'journey' && row.to_id === 'start' && row.actor === principal.owner && row.committed));
  } finally { await f.close(); }
});

test('a source deletion journals the relationships it removes under that source', async () => {
  const f = await fixture();
  try {
    const graph = new Objects(f.db, f.model, f.access);
    await graph.create(route('trip'), { id: 'trip', name: 'Trip' });
    await graph.ingestBatch([{ ref: place('gate'), properties: placeFields('gate') }], 'Feed', '2026-01-01T00:00:00Z');
    await graph.link({ type: 'RouteOrigin', from: route('trip'), to: place('gate') });
    await graph.ingestBatch([{ ref: place('gate'), properties: null }], 'Feed', '2026-02-01T00:00:00Z');
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.db.schema}.links WHERE owner=$1`, [principal.owner])).rowCount, 0);
    const { rows } = await f.db.query(`SELECT operation, source FROM ${f.db.schema}.link_history WHERE owner=$1 ORDER BY sequence`, [principal.owner]);
    assert.deepEqual(rows, [{ operation: 'link', source: null }, { operation: 'unlink', source: 'Feed' }]);
  } finally { await f.close(); }
});

test('owner isolation still records a commit after the transaction restored its owner context', async () => {
  const f = await fixture();
  const role = 'eigos_rls_' + f.schema.slice(-32);
  let limited: Database | undefined;
  try {
    await f.db.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'synthetic-only';
      GRANT USAGE ON SCHEMA ${f.db.schema} TO "${role}";
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${f.db.schema} TO "${role}";
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${f.db.schema} TO "${role}"`);
    await installOwnerIsolation(f.db);
    const url = new URL(process.env.EIGOS_TEST_DATABASE_URL!);
    url.username = role;
    const db = limited = new Database(url.href, f.schema, f.db.runtimeId, url.href, true);
    // Connector follow-ups write for one owner inside a transaction that has none, and commit after restoring it.
    await db.transaction(client => db.withTransactionOwner(client, principal.owner, async () => {
      const graph = new Objects(db, f.model, await Access.load(db, principal, client), client);
      await graph.create(route('isolated'), { id: 'isolated', name: 'Isolated' });
      await graph.create(place('isolated-start'), placeFields('isolated-start'));
      await graph.link({ type: 'RouteOrigin', from: route('isolated'), to: place('isolated-start') });
    }));
    const { rows } = await f.db.query(`SELECT count(DISTINCT c.commit_seq)::int AS commits, count(*)::int AS rows
      FROM ${f.db.schema}.edit_history h JOIN ${f.db.schema}.change_commits c ON c.owner=h.owner AND c.xact=h.xact WHERE h.owner=$1`, [principal.owner]);
    assert.deepEqual(rows[0], { commits: 1, rows: 2 });
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.db.schema}.link_history l JOIN ${f.db.schema}.change_commits c
      ON c.owner=l.owner AND c.xact=l.xact WHERE l.owner=$1`, [principal.owner])).rowCount, 1);
  } finally {
    await limited?.close();
    await f.db.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    await f.close();
  }
});
