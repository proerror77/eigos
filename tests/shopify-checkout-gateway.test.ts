import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { checkoutMerchant, checkoutInput, setupCheckout } from './fixtures/shopify-checkout.js';
import { owner } from './backend-fixture.js';

const env = (directory: string) => ({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'test-private-checkout-token'.repeat(3), DATABASE_PATH: join(directory, 'tasks.sqlite'),
  EIGOS_SHOPIFY_CHECKOUT_MERCHANTS: JSON.stringify([checkoutMerchant]), EIGOS_SHOPIFY_CHECKOUT_AUDIT_DIR: join(directory, 'source') });

test('checkout configuration is absent by default and limited to persistent private loopback in both roles', () => {
  assert(!createExecutionCatalog().summaries(owner).some(value => value.ref.id === 'shopify.checkout.unpaid'));
  const settings = env('/tmp/eigos-checkout-fixture');
  assert.deepEqual(readConfig(settings).EIGOS_SHOPIFY_CHECKOUT_MERCHANTS, readWorkerConfig(settings).EIGOS_SHOPIFY_CHECKOUT_MERCHANTS);
  for (const override of [{ NODE_ENV: 'production' }, { EIGOS_AUTH_MODE: 'jwt' }, { HOST: '0.0.0.0' }, { PUBLIC_URL: 'https://public.example' }, { DATABASE_PATH: ':memory:' }, { DATABASE_PATH: 'relative.sqlite' }, { EIGOS_INVITE_BETA: 'true' }, { EIGOS_SHOPIFY_CHECKOUT_AUDIT_DIR: 'relative' }, { EIGOS_SHOPIFY_CHECKOUT_AUDIT_DIR: undefined }, { EIGOS_SHOPIFY_CHECKOUT_MERCHANTS: JSON.stringify([{ ...checkoutMerchant, accessToken: 'forbidden' }]) }]) {
    assert.throws(() => readConfig({ ...settings, ...override })); assert.throws(() => readWorkerConfig({ ...settings, ...override }));
  }
});

test('MCP submission and exact draft authorization share A2A ownership, context, idempotency and original readback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-checkout-gateway-')), server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, settings = env(directory);
  let fixture: ReturnType<typeof setupCheckout>;
  const gateway = createApp(readConfig({ ...settings, PUBLIC_URL: base }), undefined, store => { fixture = setupCheckout({ store }); return fixture.catalog; });
  server.on('request', gateway.app);
  const client = new Client({ name: 'mock-checkout-pa', version: '1' });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args }); assert(!response.isError, JSON.stringify(response)); return (response.structuredContent as any).result;
  };
  const send = async (taskId: string, contextId: string, permit: Record<string, unknown>) => {
    const response = await fetch(base + '/a2a', { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', Authorization: `Bearer ${settings.EIGOS_DEV_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'SendMessage', params: { configuration: { returnImmediately: true }, message: { taskId, contextId, messageId: permit.requestId, role: 'ROLE_USER', parts: [{ data: permit }] } } }) });
    return response.json();
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${settings.EIGOS_DEV_TOKEN}` } } }));
    const tools = (await client.listTools()).tools.map(value => value.name); assert(tools.includes('authorize_checkout_draft'));
    assert(!tools.includes('complete_checkout')); assert(!tools.includes('pay_checkout'));
    const submitted = await call('submit_task', { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Prepare the selected mock coffee in one unpaid checkout and return its link and current status. Do not purchase or pay.', requirements: [{ id: 'no_purchase', kind: 'condition', strength: 'hard', expected: { predicate: 'shopify.checkout.no_purchase' } }] });
    fixture!.inputs.set(submitted.id, checkoutInput); await fixture!.finish(submitted.id);
    const pending = await call('get_task', { taskId: submitted.id }), request = pending.delegation.authorizationRequest;
    assert.equal(request.kind, 'external_draft'); assert.equal(fixture!.countCreates(), 0);
    const permit = { requestId: randomUUID(), action: 'approve_external_draft', planDigest: request.planDigest, draft: request.draft, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'live' };
    assert((await send(submitted.id, randomUUID(), permit)).error);
    const { action: _action, environment: _environment, ...mcpPermit } = permit;
    await call('authorize_checkout_draft', { ...mcpPermit, taskId: submitted.id });
    assert(!(await send(submitted.id, submitted.contextId, permit)).error);
    assert((await send(submitted.id, randomUUID(), permit)).error, 'An idempotent replay still verifies task context');
    await fixture!.finish(submitted.id);
    const done = await call('get_task', { taskId: submitted.id }); assert.equal(done.state, 'completed'); assert.equal(fixture!.countCreates(), 1);
    assert.deepEqual(done.artifact, gateway.store.get(owner, submitted.id).artifact);
    assert.equal(done.delegation.agent, undefined);
  } finally { await client.close(); await gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
