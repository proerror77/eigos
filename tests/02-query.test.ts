import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

test('Interface filtering and pagination use one SQL query and preserve owner boundaries', async () => {
  const f = await fixture();
  try {
    const objects = new Objects(f.db, f.model, principal.owner);
    for (let i = 0; i < 4; i++) await objects.create({ type: 'Route', id: String(i) }, { id: String(i), name: i < 3 ? 'route' : 'elsewhere' });
    const before = f.db.queries;
    const page = await objects.query({ type: 'RideEstimatable', where: { name: 'route' }, limit: 2 });
    assert.equal(f.db.queries - before, 1);
    assert.equal(page.items.length, 2); assert(page.cursor);
    assert.equal((await objects.query({ type: 'RideEstimatable', where: { name: 'route' }, limit: 2, cursor: page.cursor })).items.length, 1);
    assert.equal((await new Objects(f.db, f.model, 'different-owner').query({ type: 'RideEstimatable' })).items.length, 0);
    await assert.rejects(objects.query({ type: 'RideEstimatable', where: { name: 'elsewhere' }, cursor: page.cursor }));
  } finally { await f.close(); }
});
