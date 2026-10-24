import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { createApp } from '../apps/gateway/app.js';
import { createWorker } from '../apps/worker/runtime.js';
import { agentCard } from '../apps/gateway/a2a.js';

const development = {
  EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), DATABASE_PATH: ':memory:',
};

for (const [role, read] of [['Gateway', readConfig], ['Worker', readWorkerConfig]] as const) {
  test(`${role} keeps the Treasury reservation disabled with or without explicit configuration`, () => {
    for (const env of [development, { ...development, EIGOS_STRIPE_TREASURY_ENABLED: 'false', EIGOS_STRIPE_TREASURY_MCP_URL: 'https://mcp.stripe.com' }]) {
      const config = read(env);
      assert.equal(config.EIGOS_STRIPE_TREASURY_ENABLED, 'false');
      assert.equal(config.EIGOS_STRIPE_TREASURY_MCP_URL, 'https://mcp.stripe.com');
    }
  });

  test(`${role} rejects Treasury activation and does not silently ignore an enable request`, () => {
    for (const value of ['true', '1', 'read_only']) {
      assert.throws(() => read({ ...development, EIGOS_STRIPE_TREASURY_ENABLED: value }), /Treasury is reserved and disabled/);
    }
  });

  test(`${role} rejects alternate Treasury endpoints without echoing credentials`, () => {
    const privateMarker = 'private-endpoint-marker';
    for (const value of ['http://mcp.stripe.com', 'https://example.test', `https://${privateMarker}@mcp.stripe.com`, `https://mcp.stripe.com?token=${privateMarker}`]) {
      assert.throws(() => read({ ...development, EIGOS_STRIPE_TREASURY_MCP_URL: value }), error =>
        error instanceof Error && error.message.includes('official MCP endpoint') && !error.message.includes(privateMarker));
    }
  });
}

test('Reserved Treasury configuration starts Gateway/Worker without outbound fetch or advertised financial capabilities', async t => {
  const outbound = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected outbound request'); });
  const env = { ...development, EIGOS_STRIPE_TREASURY_ENABLED: 'false', EIGOS_STRIPE_TREASURY_MCP_URL: 'https://mcp.stripe.com' };
  const config = readConfig(env), gateway = createApp(config);
  let runtime: ReturnType<typeof createWorker> | undefined;
  try {
    runtime = createWorker(readWorkerConfig(env), { store: gateway.store });
    await setImmediate();
    const services = gateway.tasks.services();
    const publicCard = agentCard(config, services);
    const available = ['live', 'sandbox'].flatMap(environment => gateway.catalog.summaries('treasury-reservation-test', 32, environment as 'live' | 'sandbox'));
    assert.doesNotMatch(JSON.stringify({ services, publicCard, available }), /stripe|treasury/i);
    assert.equal(outbound.mock.callCount(), 0);
  } finally {
    await runtime?.close();
    gateway.members.close();
    gateway.store.close();
  }
});
