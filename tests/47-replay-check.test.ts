import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Access } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { replayCheck } from '../packages/runtime/replay-check.js';
import { fixture, principal } from './fixture.js';

const route = (id: string) => ({ type: 'Route', id });
const place = (id: string) => ({ type: 'Place', id });
const placeFields = (id: string) => ({ id, name: id, city: 'Shanghai', address: 'A', coordinates: { lat: 31, lng: 121 }, coordinateSystem: 'GCJ02',
  sourceBinding: 'test', observedAt: new Date().toISOString() });

test('the commit log explains every row written in the projection, and the check finds writes outside it', async () => {
  const f = await fixture();
  try {
    const graph = new Objects(f.db, f.model, await Access.load(f.db, principal));
    for (const id of ['p1', 'p2', 'p3']) await graph.create(place(id), placeFields(id));
    await graph.create(route('r1'), { id: 'r1', name: 'first' });
    await graph.create(route('r2'), { id: 'r2', name: 'second' });
    await graph.link({ type: 'RouteOrigin', from: route('r1'), to: place('p1') });
    await graph.link({ type: 'RouteOrigin', from: route('r2'), to: place('p2') });
    await graph.edit(route('r1'), (await graph.read(route('r1'))).revision, { name: 'first, renamed' });
    await graph.unlink({ type: 'RouteOrigin', from: route('r2'), to: place('p2') });
    await graph.remove(route('r2'), (await graph.read(route('r2'))).revision);
    const entry = (result: Awaited<ReturnType<typeof replayCheck>>, kind: 'types' | 'links', name: string) =>
      result[kind].find(item => item.owner === principal.owner && item.name === name)!;
    const clean = await replayCheck(f.db, f.model.projection);
    assert.equal(clean.consistent, true, JSON.stringify(clean.differences));
    // r1 holds its last edit; r2 was deleted and is absent; both origin edges hold their last operation.
    assert.deepEqual(entry(clean, 'types', 'Route'), { owner: principal.owner, name: 'Route', matched: 2, differs: 0, missing: 0, resurrected: 0, carried: 0 });
    assert.deepEqual(entry(clean, 'types', 'Place'), { owner: principal.owner, name: 'Place', matched: 3, differs: 0, missing: 0, resurrected: 0, carried: 0 });
    assert.deepEqual(entry(clean, 'links', 'RouteOrigin'), { owner: principal.owner, name: 'RouteOrigin', matched: 2, differs: 0, missing: 0, resurrected: 0, carried: 0 });

    // Writes outside the commit log.
    const s = f.db.schema, p = f.model.projection, o = principal.owner;
    await f.db.query(`UPDATE ${s}.objects SET properties=properties || '{"name":"changed by SQL"}' WHERE projection=$1 AND owner=$2 AND type='Route' AND id='r1'`, [p, o]);
    await f.db.query(`DELETE FROM ${s}.objects WHERE projection=$1 AND owner=$2 AND type='Place' AND id='p3'`, [p, o]);
    for (const id of ['r2', 'r9']) await f.db.query(`INSERT INTO ${s}.objects(projection,owner,type,id,revision,properties) VALUES($1,$2,'Route',$3,1,$4)`,
      [p, o, id, { id, name: 'inserted by SQL' }]);
    await f.db.query(`DELETE FROM ${s}.links WHERE projection=$1 AND owner=$2 AND type='RouteOrigin' AND from_id='r1'`, [p, o]);
    const broken = await replayCheck(f.db, f.model.projection);
    assert.equal(broken.consistent, false);
    assert.equal(broken.problems, 4);
    assert.deepEqual(entry(broken, 'types', 'Route'), { owner: o, name: 'Route', matched: 0, differs: 1, missing: 0, resurrected: 1, carried: 1 });
    assert.deepEqual(entry(broken, 'types', 'Place'), { owner: o, name: 'Place', matched: 2, differs: 0, missing: 1, resurrected: 0, carried: 0 });
    assert.deepEqual(entry(broken, 'links', 'RouteOrigin'), { owner: o, name: 'RouteOrigin', matched: 1, differs: 0, missing: 1, resurrected: 0, carried: 0 });
    assert.deepEqual(broken.differences.map(item => `${item.kind} ${item.name} ${item.id} ${item.problem}`).sort(), [
      'link RouteOrigin r1 -> p1 missing', 'object Place p3 missing', 'object Route r1 differs', 'object Route r2 resurrected',
    ]);
  } finally { await f.close(); }
});

test('a later projection compares only what was written in it', async () => {
  const f = await fixture();
  try {
    const graph = new Objects(f.db, f.model, await Access.load(f.db, principal));
    await graph.create(route('old'), { id: 'old', name: 'before the publication' });
    // A new publication copies the rows into its own projection, without history there.
    const next = await f.metadata.publish(structuredClone(f.model.document), f.capabilities, f.publisher);
    assert.notEqual(next.projection, f.model.projection);
    const later = new Objects(f.db, next, await Access.load(f.db, principal));
    await later.create(route('new'), { id: 'new', name: 'after the publication' });
    const result = await replayCheck(f.db, next.projection);
    assert.equal(result.consistent, true, JSON.stringify(result.differences));
    const routes = result.types.find(item => item.owner === principal.owner && item.name === 'Route')!;
    assert.equal(routes.matched, 1);
    assert(routes.carried >= 1, 'the copied row is carried over, not compared');
  } finally { await f.close(); }
});
