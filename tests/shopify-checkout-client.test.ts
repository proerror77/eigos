import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, readdirSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OfficialShopCheckoutConnector } from '../packages/capabilities/shopify/checkout-client.js';
import { SHOP_MCP_ENDPOINT, SHOP_MCP_PROTOCOL, shopCreateArguments, shopLookupArguments, type ShopCallContext } from '../packages/capabilities/shopify/checkout-contracts.js';
import { checkoutMerchant, checkoutInput } from './fixtures/shopify-checkout.js';
import { digest } from '../packages/core/delegation.js';

function transport() {
  const calls: any[] = [], flags = { loseResponse: false, initialize: undefined as (() => void) | undefined };
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(new URL(input instanceof Request ? input.url : String(input)).origin, SHOP_MCP_ENDPOINT);
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    for (const key of ['authorization', 'cookie', 'shopify-buyer-ip']) assert.equal(headers.has(key), false);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (!body) return new Response(null, { status: 405 });
    calls.push(body);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'server/discover') {
      assert.equal(body.params._meta['io.modelcontextprotocol/protocolVersion'], SHOP_MCP_PROTOCOL); flags.initialize?.();
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { supportedVersions: [SHOP_MCP_PROTOCOL], ttlMs: 0, cacheScope: 'private', capabilities: { tools: {} } } });
    }
    assert.equal(body.method, 'tools/call');
    if (flags.loseResponse) throw new Error('Synthetic connection loss');
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', content: [], structuredContent: { id: 'gid://shopify/Checkout/mock?key=private-source-key', status: 'requires_escalation' } } });
  };
  return { calls, flags, fetcher };
}
function context(assertDispatchAllowed = () => {}) : ShopCallContext {
  return { ownerDigest: digest('mock-owner'), requestId: randomUUID(), intentId: randomUUID(), operationKey: digest(randomUUID()), assertDispatchAllowed };
}

test('official transport pins protocol, preserves exact unpaid arguments and recovers from a private original receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-checkout-')), mock = transport(), ctx = context();
  try {
    const args = shopCreateArguments(checkoutMerchant, checkoutInput.items, ctx.operationKey);
    const connector = new OfficialShopCheckoutConnector({ auditDirectory: directory, fetcher: mock.fetcher });
    const result = await connector.call('create_checkout', args, ctx, new AbortController().signal);
    assert.equal(result.receipt.tool, 'create_checkout');
    assert.deepEqual(mock.calls.filter(value => value.method === 'tools/call').map(value => ({ name: value.params.name, arguments: value.params.arguments })), [{ name: 'create_checkout', arguments: args }]);
    assert.deepEqual(connector.originalCreation(ctx, digest(args)), result);
    const restarted = new OfficialShopCheckoutConnector({ auditDirectory: directory, fetcher: mock.fetcher });
    assert.deepEqual(restarted.originalCreation(ctx, digest(args)), result);
    await assert.rejects(restarted.call('create_checkout', args, ctx, new AbortController().signal), /instead of creating again/);
    assert.equal(mock.calls.filter(value => value.method === 'tools/call').length, 1);
    assert.throws(() => restarted.originalCreation({ ...ctx, requestId: randomUUID() }, digest(args)), /owned operation/);
    for (const file of readdirSync(directory)) assert.equal(lstatSync(join(directory, file)).mode & 0o077, 0);
    const raw = readdirSync(directory).find(file => !file.endsWith('.creation.json'))!;
    assert.equal(Buffer.byteLength(readFileSync(join(directory, raw))), result.receipt.responseBytes);
    const gateway = new OfficialShopCheckoutConnector({ auditDirectory: directory, execute: false, fetcher: mock.fetcher });
    assert.throws(() => gateway.originalCreation(ctx, digest(args)), /Only Worker/);
    await assert.rejects(gateway.call('get_checkout', { shop: checkoutMerchant.domain, id: (result.value as any).id }, ctx, new AbortController().signal), /Only Worker/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('revocation during MCP initialization is checked before the actual creation POST', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-checkout-')), mock = transport(); let revoked = false;
  const ctx = context(() => { if (revoked) throw new Error('Synthetic revoked authority'); }); mock.flags.initialize = () => { revoked = true; };
  try {
    const connector = new OfficialShopCheckoutConnector({ auditDirectory: directory, fetcher: mock.fetcher });
    await assert.rejects(connector.call('create_checkout', shopCreateArguments(checkoutMerchant, checkoutInput.items, ctx.operationKey), ctx, new AbortController().signal));
    assert.equal(mock.calls.filter(value => value.method === 'tools/call').length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('transport rejects payment tools, buyer fields, wrong operation keys and insecure recovery storage before network calls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-checkout-')), mock = transport(), ctx = context();
  try {
    const connector = new OfficialShopCheckoutConnector({ auditDirectory: directory, fetcher: mock.fetcher });
    const args = shopCreateArguments(checkoutMerchant, checkoutInput.items, ctx.operationKey);
    await assert.rejects(connector.call('complete_checkout' as any, {}, ctx, new AbortController().signal), /cannot place orders/);
    await assert.rejects(connector.call('create_checkout', { ...args, checkout: { ...args.checkout, buyer: { email: 'fixture@example.invalid' } } }, ctx, new AbortController().signal));
    await assert.rejects(connector.call('create_checkout', { ...args, meta: { 'idempotency-key': randomUUID() } }, ctx, new AbortController().signal), /authority and idempotency/);
    const unjournaled = new OfficialShopCheckoutConnector({ fetcher: mock.fetcher });
    await assert.rejects(unjournaled.call('create_checkout', args, ctx, new AbortController().signal), /durable private/);
    chmodSync(directory, 0o755);
    await assert.rejects(connector.call('lookup_catalog', shopLookupArguments(checkoutMerchant, checkoutInput.items), ctx, new AbortController().signal), /owned and private/);
    assert.equal(mock.calls.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unknown creation response makes exactly one business request and exposes no invented original identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-checkout-')), mock = transport(), ctx = context(); mock.flags.loseResponse = true;
  try {
    const connector = new OfficialShopCheckoutConnector({ auditDirectory: directory, fetcher: mock.fetcher });
    const args = shopCreateArguments(checkoutMerchant, checkoutInput.items, ctx.operationKey);
    await assert.rejects(connector.call('create_checkout', args, ctx, new AbortController().signal));
    assert.equal(mock.calls.filter(value => value.method === 'tools/call').length, 1);
    assert.equal(connector.originalCreation(ctx, digest(args)), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
