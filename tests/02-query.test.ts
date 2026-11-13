import { Access, setGrants } from '../packages/runtime/access.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

test('Interface filtering and pagination use one SQL query and preserve owner boundaries', async () => {
  const f = await fixture();
  try {
    const objects = new Objects(f.db, f.model, f.access);
    for (let i = 0; i < 4; i++) await objects.create({ type: 'Route', id: String(i) }, { id: String(i), name: i < 3 ? 'route' : 'elsewhere' });
    const before = f.db.queries;
    const page = await objects.query({ type: 'RideEstimatable', where: { name: 'route' }, limit: 2 });
    assert.equal(f.db.queries - before, 1);
    assert.equal(page.items.length, 2); assert(page.cursor);
    assert.equal((await objects.query({ type: 'RideEstimatable', where: { name: 'route' }, limit: 2, cursor: page.cursor })).items.length, 1);
    await setGrants(f.db, 'different-owner', [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.equal((await new Objects(f.db, f.model, await Access.load(f.db, { owner: 'different-owner', scopes: [] })).query({ type: 'RideEstimatable' })).items.length, 0);
    await assert.rejects(objects.query({ type: 'RideEstimatable', where: { name: 'elsewhere' }, cursor: page.cursor }));
  } finally { await f.close(); }
});

test('definition administration does not grant object data or Action execution', async () => {
  const f = await fixture();
  try {
    const ref = { type: 'Route', id: 'private' };
    await new Objects(f.db, f.model, f.access).create(ref, { id: ref.id, name: 'private' });
    await setGrants(f.db, principal.owner, [{ resource: 'Eigos', permission: 'manage_definition' }]);
    const access = await Access.load(f.db, principal), objects = new Objects(f.db, f.model, access);
    assert.equal(access.describe(f.model).objectTypes.length, 9);
    assert.equal((await objects.query({ type: 'RideEstimatable' })).items.length, 0);
    await assert.rejects(objects.read(ref), /Permission/);
    await assert.rejects(f.capabilities.actions.apply(access, f.model, 'EstimateRide', { city: '上海', origin: 'A', destination: 'B' }, 'denied'), /Permission/);
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('property policies return null and Interface filters cannot inspect hidden values', async () => {
  const f = await fixture();
  try {
    const ref = { type: 'Route', id: 'hidden-title' };
    await new Objects(f.db, f.model, f.access).create(ref, { id: ref.id, name: 'Secret destination' });
    await f.db.query(`INSERT INTO ${f.db.schema}.property_security VALUES('Eigos','Route','name')`);
    const access = await Access.load(f.db, principal), objects = new Objects(f.db, f.model, access);
    assert.equal((await objects.read(ref)).properties.name, null);
    assert.equal((await objects.query({ type: 'RideEstimatable', where: { name: 'Secret destination' } })).items.length, 0);
    const visible = await objects.query({ type: 'RideEstimatable', where: { name: null } });
    assert.equal(visible.items.length, 1); assert.equal(visible.items[0]!.properties.name, null);
    await f.db.query(`INSERT INTO ${f.db.schema}.resource_grants VALUES($1,'Eigos/property/Route/name','view_property')`, [principal.owner]);
    const granted = new Objects(f.db, f.model, await Access.load(f.db, principal));
    assert.equal((await granted.read(ref)).properties.name, 'Secret destination');
  } finally { await f.close(); }
});
