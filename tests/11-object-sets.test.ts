import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { ObjectSets, initializeObjectSets, type SetExpression } from '../packages/runtime/object-sets.js';
import { Objects } from '../packages/runtime/objects.js';
import { Scenarios } from '../packages/runtime/scenarios.js';

const routes: SetExpression = { op: 'query', query: { type: 'Route' } };
const refs = (...ids: string[]): SetExpression => ({ op: 'refs', objects: ids.map(id => ({ type: 'Route', id })) });
async function setup() {
  const f = await fixture();
  await initializeObjectSets(f.db);
  return { ...f, sets: new ObjectSets(f.db), objects: new Objects(f.db, f.model, f.access) };
}

test('sets compose complete paginated memberships with deterministic cursors and explicit bounds', async () => {
  const f = await setup();
  try {
    await f.db.transaction(async client => {
      const objects = new Objects(f.db, f.model, f.access, client);
      for (let index = 0; index < 105; index++) await objects.create({ type: 'Route', id: String(index) }, { id: String(index), name: index < 103 ? 'local' : 'other' });
    });
    const union: SetExpression = { op: 'union', sets: [routes, refs('1', '2', 'missing')] };
    const first = await f.sets.evaluate(f.access, f.model, { set: union, limit: 100 });
    assert.equal(first.total, 105); assert.equal(first.items.length, 100); assert(first.cursor);
    const second = await f.sets.evaluate(f.access, f.model, { set: union, limit: 100, cursor: first.cursor });
    assert.equal(second.items.length, 5); assert.equal(second.cursor, undefined);
    assert.equal(new Set([...first.items, ...second.items].map(object => object.ref.id)).size, 105);
    const composed: SetExpression = { op: 'difference', left: { op: 'intersection', sets: [routes, refs('1', '2', '104')] }, right: refs('104') };
    assert.equal((await f.sets.evaluate(f.access, f.model, { set: composed })).total, 2);
    const aggregate = await f.sets.aggregate(f.access, f.model, { set: routes, groupBy: ['name'], metrics: { total: { op: 'count' } } });
    assert.deepEqual(aggregate.items.map(item => item.metrics.total).sort((a,b) => Number(a) - Number(b)), [2, 103]);
    await assert.rejects(new ObjectSets(f.db, 100).aggregate(f.access, f.model, { set: routes, metrics: { total: { op: 'count' } } }), /complete evaluation limit/);
    await f.objects.edit({ type: 'Route', id: '1' }, 1, { name: 'changed' });
    await assert.rejects(f.sets.evaluate(f.access, f.model, { set: union, cursor: first.cursor }));
  } finally { await f.close(); }
});

test('multi-hop sets navigate Interfaces and honor Scenario views', async () => {
  const f = await setup();
  try {
    const request = { type: 'RideRequest', id: 'request' }, route = { type: 'Route', id: 'route' };
    const place = { type: 'Place', id: 'place' };
    await f.objects.create(request, { id: request.id, name: 'Inquiry', status: 'requested', requestedAt: new Date().toISOString() });
    await f.objects.create(route, { id: route.id, name: 'Route' });
    await f.objects.create(place, { id: place.id, name: 'Place', city: 'Shanghai', address: 'A', coordinates: { lat: 31, lng: 121 }, coordinateSystem: 'GCJ02', sourceBinding: 'test', observedAt: new Date().toISOString() });
    await f.objects.link({ type: 'RequestRoute', from: request, to: route });
    await f.objects.link({ type: 'RouteOrigin', from: route, to: place });
    const set: SetExpression = { op: 'traverse', set: { op: 'refs', objects: [request] }, path: [{ link: 'route' }, { link: 'origin', as: 'RideEstimatable' }] };
    const result = await f.sets.evaluate(f.access, f.model, { set, view: 'Location' });
    assert.equal(result.total, 1); assert.equal(result.items[0]!.properties.name, 'Place');
    const scenario = await new Scenarios(f.db).create(f.access, f.model, { requestId: 'set-scenario', name: 'Alternative' });
    const view = await new Scenarios(f.db).view(f.access, f.model, scenario.id);
    await new Objects(f.db, view, f.access).edit(route, 1, { name: 'Proposal' });
    const scenarioResult = await f.sets.evaluate(f.access, view, { set: routes, view: 'RideEstimatable' });
    assert.equal(scenarioResult.items[0]!.properties.name, 'Proposal');
    assert.equal((await f.sets.evaluate(f.access, f.model, { set: routes })).items[0]!.properties.name, 'Route');
  } finally { await f.close(); }
});

test('aggregates compute numeric values and mask hidden properties before grouping or reduction', async () => {
  const f = await setup();
  try {
    for (const [index, duration] of [10, 20, 30].entries()) {
      const id = String(index);
      await f.objects.create({ type: 'SchedulePlan', id }, { id, name: index < 2 ? 'A' : 'B', start: '2026-11-20T01:00:00Z', end: '2026-11-20T03:00:00Z', timeZone: 'Asia/Shanghai', durationMinutes: duration });
    }
    const set: SetExpression = { op: 'query', query: { type: 'SchedulePlan' } };
    const metrics = { count: { op: 'count' }, total: { op: 'sum', property: 'durationMinutes' }, minimum: { op: 'min', property: 'durationMinutes' }, maximum: { op: 'max', property: 'durationMinutes' }, average: { op: 'avg', property: 'durationMinutes' } };
    assert.deepEqual((await f.sets.aggregate(f.access, f.model, { set, metrics })).items[0]!.metrics, { count: 3, total: 60, minimum: 10, maximum: 30, average: 20 });
    await f.db.query(`INSERT INTO ${f.db.schema}.property_security VALUES('Eigos','SchedulePlan','durationMinutes')`);
    const access = await Access.load(f.db, principal);
    const result = await f.sets.aggregate(access, f.model, { set, groupBy: ['durationMinutes'], metrics });
    assert.deepEqual(result.items, [{ group: { durationMinutes: null }, metrics: { count: 3, total: null, minimum: null, maximum: null, average: null } }]);
    await assert.rejects(f.sets.aggregate(access, f.model, { set, metrics: { wrong: { op: 'sum', property: 'name' } } }), /finite numeric/);
  } finally { await f.close(); }
});

test('saved static membership stays fixed while dynamic membership changes and shared readers keep their data permissions', async () => {
  const f = await setup();
  try {
    await f.objects.create({ type: 'Route', id: 'private' }, { id: 'private', name: 'Private route' });
    const staticSet = await f.sets.save(f.access, f.model, { requestId: 'static', name: 'Static', mode: 'static', set: routes, readers: ['reader'] });
    const dynamicSet = await f.sets.save(f.access, f.model, { requestId: 'dynamic', name: 'Dynamic', mode: 'dynamic', set: routes, readers: ['reader'] });
    await f.objects.create({ type: 'Route', id: 'new' }, { id: 'new', name: 'New route' });
    assert.equal((await f.sets.evaluate(f.access, f.model, { set: { op: 'saved', id: staticSet.id } })).total, 1);
    assert.equal((await f.sets.evaluate(f.access, f.model, { set: { op: 'saved', id: dynamicSet.id } })).total, 2);
    await setGrants(f.db, 'reader', memberGrants(f.model));
    const reader = await Access.load(f.db, { owner: 'reader', scopes: [] });
    assert.equal((await f.sets.list(reader, f.model)).items.length, 2);
    assert.equal((await f.sets.get(reader, f.model, staticSet.id)).set, undefined);
    assert.equal((await f.sets.evaluate(reader, f.model, { set: { op: 'saved', id: staticSet.id } })).total, 0);
    await new Objects(f.db, f.model, reader).create({ type: 'Route', id: 'reader-route' }, { id: 'reader-route', name: 'Reader route' });
    const shared = await f.sets.evaluate(reader, f.model, { set: { op: 'saved', id: dynamicSet.id } });
    assert.deepEqual(shared.items.map(object => object.ref.id), ['reader-route']);
    await assert.rejects(f.sets.remove(reader, f.model, dynamicSet.id, 1), /Only the owner/);
    await f.sets.save(f.access, f.model, { id: dynamicSet.id, revision: 1, requestId: 'update', name: 'Dynamic', mode: 'dynamic', set: routes, readers: [] });
    await assert.rejects(f.sets.get(reader, f.model, dynamicSet.id), /unavailable/);
  } finally { await f.close(); }
});

test('saved set mutations enforce retries, revisions, ownership and acyclic references', async () => {
  const f = await setup();
  try {
    const input = { requestId: 'idempotent', name: 'Set A', mode: 'dynamic', set: routes };
    const [a, duplicate] = await Promise.all([f.sets.save(f.access, f.model, input), f.sets.save(await Access.load(f.db, principal), f.model, input)]);
    assert.equal(a.id, duplicate.id);
    assert.equal((await f.sets.save(f.access, f.model, input)).id, a.id);
    await assert.rejects(f.sets.save(f.access, f.model, { ...input, name: 'Different' }), /different input/);
    const b = await f.sets.save(f.access, f.model, { requestId: 'b', name: 'Set B', mode: 'dynamic', set: { op: 'saved', id: a.id } });
    await assert.rejects(f.sets.save(f.access, f.model, { ...input, id: a.id, revision: 1, set: { op: 'saved', id: b.id } }), /cycle/);
    const updated = await f.sets.save(f.access, f.model, { ...input, id: a.id, revision: 1, name: 'Updated' });
    assert.equal(updated.revision, 2);
    await assert.rejects(f.sets.save(f.access, f.model, { ...input, id: a.id, revision: 1, name: 'Stale' }), /revision changed/);
    await assert.rejects(f.sets.remove(f.access, f.model, a.id, 1), /revision changed/);
    await f.sets.remove(f.access, f.model, a.id, 2);
    await assert.rejects(f.sets.evaluate(f.access, f.model, { set: { op: 'saved', id: b.id } }), /unavailable/);
  } finally { await f.close(); }
});

test('publication checks dynamic set dependencies at preparation and again at activation', async () => {
  const f = await setup();
  try {
    const ref = { type: 'Route', id: 'versioned' };
    await f.objects.create(ref, { id: ref.id, name: 'Route' });
    const oldBody = structuredClone(f.model.document);
    oldBody.version = 'sets-with-legacy-filter';
    oldBody.objectTypes.find(type => type.apiName === 'Route')!.properties.region =
      { description: 'Filter used by saved sets', schema: { type: 'string' }, required: false };
    const old = await f.metadata.publish(oldBody, f.capabilities, f.publisher);
    const oldGraph = new Objects(f.db, old, f.access);
    await oldGraph.edit(ref, 1, { region: 'east' });
    const next = structuredClone(oldBody);
    next.version = 'sets-without-legacy-filter';
    delete next.objectTypes.find(type => type.apiName === 'Route')!.properties.region;
    const candidate = await f.metadata.prepare(next, f.capabilities, f.publisher);

    const expression: SetExpression = { op: 'query', query: { type: 'Route', where: { region: 'east' } } };
    const fixed = await f.sets.save(f.access, old, { requestId: 'fixed-v1', name: 'Fixed', mode: 'static', set: expression });
    const dynamic = await f.sets.save(f.access, old, { requestId: 'dynamic-v1', name: 'Dynamic', mode: 'dynamic', set: expression });
    const saved = (id: string) => ({ op: 'saved', id });
    const composed = await f.sets.save(f.access, old, { requestId: 'composed-v1', name: 'Composed', mode: 'dynamic', set: saved(dynamic.id) });
    await assert.rejects(f.metadata.prepare(next, f.capabilities, f.publisher), /break 2 saved dynamic object set.*Route.region/);
    await assert.rejects(f.metadata.activate(candidate.release, f.capabilities, f.publisher), /break 2 saved dynamic object set/);
    assert.equal((await f.metadata.active()).release, old.release);
    assert.equal((await f.sets.evaluate(f.access, old, { set: saved(composed.id) })).total, 1);

    const changedType = structuredClone(oldBody);
    changedType.objectTypes.find(type => type.apiName === 'Route')!.properties.region!.schema = { type: 'number' };
    await assert.rejects(f.metadata.prepare(changedType, f.capabilities, f.publisher), /Property type changed: Route.region/);
    await f.sets.save(f.access, old, { id: dynamic.id, revision: 1, requestId: 'update-filter', name: 'Dynamic', mode: 'dynamic', set: routes });
    await f.metadata.activate(candidate.release, f.capabilities, f.publisher);
    assert.equal((await f.sets.evaluate(f.access, candidate, { set: saved(fixed.id) })).total, 1);
    assert.equal((await f.sets.evaluate(f.access, candidate, { set: saved(composed.id) })).total, 1);
    await assert.rejects(f.sets.save(f.access, old, { requestId: 'late-old-save', name: 'Old', mode: 'dynamic', set: expression }), /publication changed/);
  } finally { await f.close(); }
});
