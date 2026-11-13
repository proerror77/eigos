import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { EntityResolution, initializeEntityResolution } from '../packages/runtime/entity-resolution.js';
import { Objects } from '../packages/runtime/objects.js';

async function setup() {
  const f = await fixture();
  await initializeEntityResolution(f.db);
  const document = structuredClone(f.model.document);
  document.dataSources.push({ apiName: 'OtherPlaces', objectType: 'Place', function: 'searchPlaces', properties: { ...document.dataSources.find(source => source.apiName === 'DidiPlaces')!.properties } });
  const bindings = { describe: (model: Parameters<typeof f.capabilities.describe>[0]) => ({ functions: f.capabilities.functions.bindings(model), sources: Object.fromEntries([...model.sources.keys()].map(name => [name, name])) }) };
  const model = await f.metadata.publish(document, bindings, f.publisher);
  await setGrants(f.db, principal.owner, [...memberGrants(model), ...['DidiPlaces', 'OtherPlaces'].map(source => ({ resource: 'Eigos/datasource/' + source, permission: 'ingest_source' as const }))]);
  const access = await Access.load(f.db, principal), graph = new Objects(f.db, model, access), resolution = new EntityResolution(f.db);
  const ref = { type: 'Place', id: 'canonical-place' };
  const fields = { id: ref.id, name: 'Place', city: '上海', address: 'Address', coordinates: { lat: 31, lng: 121 }, coordinateSystem: 'GCJ-02', sourceBinding: 'fixture', observedAt: new Date().toISOString() };
  await graph.create(ref, fields);
  return { ...f, model, access, graph, resolution, ref, fields };
}
test('two published sources explicitly bind to one readable canonical entity with an audit trail', async () => {
  const f = await setup(); try {
    for (const source of ['DidiPlaces', 'OtherPlaces']) {
      await f.resolution.bind(f.access, f.model, { source, externalId: 'external-id', target: f.ref, expectedRevision: 0, reason: 'Verified same location' });
      assert.deepEqual((await f.resolution.lookup(f.access, f.model, { source, externalId: 'external-id' })).ref, f.ref);
    }
    const audit = await f.resolution.history(f.access, f.model, { source: 'OtherPlaces', externalId: 'external-id' });
    assert.equal(audit.items.length, 1); assert.equal(audit.items[0]!.before_target, null); assert.deepEqual(audit.items[0]!.after_target, f.ref);
    assert.equal((await f.graph.query({ type: 'Place' })).items.length, 1);
  } finally { await f.close(); }
});
test('binding revisions prevent stale or concurrent reassignment and provider lookup preserves existing fallback IDs', async () => {
  const f = await setup(); try {
    const input = { source: 'DidiPlaces', externalId: 'place-1', target: f.ref, expectedRevision: 0, reason: 'Reviewed match' };
    const first = await f.resolution.bind(f.access, f.model, input);
    await assert.rejects(f.resolution.bind(f.access, f.model, input), /revision changed/);
    const other = { type: 'Place', id: 'another-place' }; await f.graph.create(other, { ...f.fields, id: other.id });
    const outcomes = await Promise.allSettled([1,2].map(number => f.resolution.bind(f.access, f.model, { ...input, target: other, expectedRevision: first.revision, reason: 'Correction ' + number })));
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await f.resolution.history(f.access, f.model, {source:input.source,externalId:input.externalId})).items.length, 2);
    const fallback = await f.db.transaction(client => f.resolution.resolve(new Objects(f.db, f.model, f.access, client), 'DidiPlaces', 'unbound', 'existing-provider-hash'));
    assert.deepEqual(fallback, { type: 'Place', id: 'existing-provider-hash' });
    await assert.rejects(f.resolution.resolve(f.graph, 'DidiPlaces', 'unbound'), /transaction/);
  } finally { await f.close(); }
});
test('source authority, owner isolation and target type are enforced', async () => {
  const f = await setup(); try {
    const input = { source: 'DidiPlaces', externalId: 'place', target: f.ref, expectedRevision: 0, reason: 'Verified match' };
    await setGrants(f.db, 'reader', memberGrants(f.model));
    const reader = await Access.load(f.db, { ...principal, owner: 'reader' });
    await assert.rejects(f.resolution.bind(reader, f.model, input), /Permission/);
    await setGrants(f.db, 'reader', [...memberGrants(f.model), { resource: 'Eigos/datasource/DidiPlaces', permission: 'ingest_source' }]);
    const other = await Access.load(f.db, { ...principal, owner: 'reader' });
    await assert.rejects(f.resolution.bind(other, f.model, input), /unavailable/);
    await assert.rejects(f.resolution.bind(f.access, f.model, { ...input, target: { type: 'Route', id: 'route' } }), /type must match/);
    await f.resolution.bind(f.access, f.model, input);
    const hidden = await f.resolution.lookup(other, f.model, { source: input.source, externalId: input.externalId });
    assert.equal(hidden.bound, false); assert.notDeepEqual(hidden.ref, f.ref);
    await setGrants(f.db, principal.owner, memberGrants(f.model).filter(grant => grant.permission !== 'read_source'));
    await assert.rejects(f.resolution.lookup(await Access.load(f.db, principal), f.model, { source: input.source, externalId: input.externalId }), /Permission/);
  } finally { await f.close(); }
});

test('bindings survive publication replacement while historical writes and missing targets are rejected', async () => {
  const f = await setup(); try {
    const input = { source: 'DidiPlaces', externalId: 'stable-place', target: f.ref, expectedRevision: 0, reason: 'Verified location' };
    await f.resolution.bind(f.access, f.model, input);
    const bindings = { describe: (model: Parameters<typeof f.capabilities.describe>[0]) => ({ functions: f.capabilities.functions.bindings(model), sources: Object.fromEntries([...model.sources.keys()].map(name => [name, name])) }) };
    const next = await f.metadata.publish({ ...f.model.document, version: 'replacement' }, bindings, f.publisher);
    const resolved = await f.resolution.lookup(f.access, next, { source: input.source, externalId: input.externalId });
    assert.deepEqual(resolved.ref, f.ref); assert.equal(resolved.revision, 1);
    await assert.rejects(f.resolution.bind(f.access, f.model, { ...input, expectedRevision: 1 }), /read-only/);
    const live = new Objects(f.db, next, f.access); await live.remove(f.ref, 1);
    await assert.rejects(f.resolution.lookup(f.access, next, { source: input.source, externalId: input.externalId }), /unavailable/);
    const replacement = { type: 'Place', id: 'corrected-place' }; await live.create(replacement, { ...f.fields, id: replacement.id });
    const changed = await f.resolution.bind(f.access, next, { ...input, target: replacement, expectedRevision: 1 });
    assert.equal(changed.revision, 2); assert.deepEqual(changed.ref, replacement);
  } finally { await f.close(); }
});
