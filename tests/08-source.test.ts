import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedMoney } from '../packages/capabilities/didi/mapping.js';
import { provider } from './fixture.js';

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
