import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedMoney } from '../packages/capabilities/didi/mapping.js';
import { fixture, principal, provider } from './fixture.js';
import { Objects } from '../packages/runtime/objects.js';

test('provider decimal mapping preserves uncertain prices and source tools reject writes', async () => {
  assert.deepEqual(estimatedMoney('73.05'), { minor: '7305', currency: 'CNY' });
  assert.equal(estimatedMoney('100-120元'), undefined);
  const f = await provider();
  try {
    const context = { requestId: 'x', requestRevision: 1 };
    await assert.rejects(f.source.connector.invoke(context, 'taxi_create_order' as never, {}, AbortSignal.timeout(1000)), /TOOL_NOT_ALLOWED/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('location readiness checks the exact current source receipt past 100 historic links', async () => {
  const f = await fixture();
  try {
    const graph = new Objects(f.db, f.model, f.access);
    const observedAt = new Date().toISOString();
    const place = { type: 'Place', id: 'popular-place' };
    await graph.create(place, {
      id: place.id, name: 'Public venue', city: '上海', address: '上海',
      coordinates: { lat: 31.2, lng: 121.5 }, coordinateSystem: 'GCJ-02', sourceBinding: 'synthetic', observedAt,
    });
    await f.db.transaction(async client => {
      const writer = new Objects(f.db, f.model, f.access, client);
      const timestamps = Array.from({ length: 101 }, (_, index) => new Date(Date.now() - (index + 1) * 10000).toISOString());
      for (const [index, time] of [...timestamps, observedAt].entries()) {
        const receipt = { type: 'SourceReceipt', id: `receipt-${String(index).padStart(3, '0')}` };
        await writer.create(receipt, { id: receipt.id, name: 'maps_textsearch', bindingId: 'synthetic',
          tool: 'maps_textsearch', observedAt: time, evidence: 'fixture', contentDigest: 'a'.repeat(64) });
        await writer.linkBatch([{ type: 'PlaceSource', from: place, to: receipt }]);
      }
    });
    const context = { principal, objects: graph, signal: AbortSignal.timeout(5000) };
    const input = { origin: place, destination: place };
    assert.equal(await f.capabilities.functions.invoke(f.model, 'locationsReady', input, context), true);
    await graph.unlink({ type: 'PlaceSource', from: place, to: { type: 'SourceReceipt', id: 'receipt-101' } });
    assert.equal(await f.capabilities.functions.invoke(f.model, 'locationsReady', input, context), false);
  } finally {
    await f.close();
  }
});
