import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ComponentSourceEgress } from '../packages/runtime/component-source-egress.js';
import { ComponentSourceSecrets, sealSourceSecrets } from '../packages/runtime/component-source-secrets.js';

test('a declared component Source passes only admitted methods and paths with scoped credentials', async () => {
  const secret = 'synthetic-source-token';
  const observed: string[][] = [];
  const audit: unknown[] = [];
  const broker = new ComponentSourceEgress({
    Inventory: { baseUrl: 'https://inventory.example.com/v1/', methods: ['GET', 'POST'], bearerSecret: 'inventory' },
  }, async (url, options) => {
    observed.push([url.href, options.method, options.headers.authorization!]);
    return { status: 200, contentType: 'application/json', body: '{"available":true}' };
  }, event => audit.push(event));
  const binding = broker.binding('Inventory');
  const ctx = {
    mode: 'read' as const,
    signal: AbortSignal.timeout(10_000),
    async authorize(source: string) { assert.equal(source, 'Inventory'); },
    async secret(name: string) { assert.equal(name, 'inventory'); return secret; },
  };
  await assert.rejects(broker.send('Missing', binding, { path: '/v1/items' }, ctx), /no HTTP connection/);
  await assert.rejects(broker.send('Inventory', 'changed', { path: '/v1/items' }, ctx), /connection changed/);
  await assert.rejects(broker.send('Inventory', binding, { path: '/outside' }, ctx), /allowed base/);
  await assert.rejects(broker.send('Inventory', binding, { path: '/v1/items', method: 'POST' }, ctx), /not allowed/);
  assert.deepEqual(observed, []);
  const recovered = await broker.send('Inventory', binding, { path: '/v1/items' }, ctx);
  assert.equal(recovered.body, '{"available":true}');
  assert.deepEqual(observed, [['https://inventory.example.com/v1/items', 'GET', 'Bearer ' + secret]]);
  assert.deepEqual(audit.map(record => (record as { outcome: string }).outcome), ['denied', 'denied', 'denied', 'denied', 'returned']);
  assert(!JSON.stringify(audit).includes(secret));
});

test('Source egress rejects an unapproved private address and blocks reflected credentials', async () => {
  const config = { Private: { baseUrl: 'https://127.0.0.1/inventory/', methods: ['GET'] } };
  const audit: unknown[] = [];
  const broker = new ComponentSourceEgress(config, undefined, entry => audit.push(entry));
  const ctx = { mode: 'read' as const, signal: AbortSignal.timeout(10000), async authorize() {}, async secret() { return 'synthetic-token'; } };
  await assert.rejects(broker.send('Private', broker.binding('Private'), { path: '/inventory/items' }, ctx), /outside its egress network/);
  const reflected = new ComponentSourceEgress({
    Inventory: { baseUrl: 'https://inventory.example.com/v1/', methods: ['GET'], bearerSecret: 'inventory' },
  }, async () => ({ status: 200, contentType: 'application/json', body: '{"echo":"synthetic-token"}' }), entry => audit.push(entry));
  await assert.rejects(reflected.send('Inventory', reflected.binding('Inventory'), { path: '/v1/items' }, ctx), /request failed/);
  assert(!JSON.stringify(audit).includes('synthetic-token'));
});

test('Source credentials read from authenticated ciphertext and reject a wrong key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-component-source-secrets-'));
  try {
    const key = join(directory, 'key'), bundle = join(directory, 'bundle');
    const secret = 'synthetic-provider-token', keyBytes = randomBytes(32);
    const ciphertext = JSON.stringify(sealSourceSecrets({ inventory: secret }, keyBytes));
    assert(!ciphertext.includes(secret));
    await writeFile(key, keyBytes, { mode: 0o600 });
    await writeFile(bundle, ciphertext, { mode: 0o600 });
    const secrets = new ComponentSourceSecrets(bundle, key);
    assert.equal(await secrets.get('inventory'), secret);
    await assert.rejects(secrets.get('missing'), /unavailable/);
    await writeFile(key, randomBytes(32));
    await assert.rejects(secrets.get('inventory'), /unavailable/);
  } finally { await rm(directory, { recursive: true }); }
});

test('OAuth client credentials are exchanged once per Source and the Function receives only its resource result', async () => {
  let reads = 0, exchanges = 0;
  const events: unknown[] = [];
  const broker = new ComponentSourceEgress({
    Inventory: { baseUrl: 'https://inventory.example.com/v1/', methods: ['GET'], oauth: {
      grant: 'client_credentials', tokenUrl: 'https://tokens.example.com/oauth/token',
      clientId: 'eigos-test', clientSecret: 'inventory-client', scope: 'inventory.read',
    } },
  }, async (url, options) => {
    if (url.hostname === 'tokens.example.com') {
      exchanges++;
      assert.equal(options.method, 'POST');
      assert.equal(options.body, 'grant_type=client_credentials&scope=inventory.read');
      assert.equal(options.headers.authorization, 'Basic ' + Buffer.from('eigos-test:synthetic-client-secret').toString('base64'));
      return { status: 200, contentType: 'application/json', body: '{"access_token":"synthetic-access-token","token_type":"Bearer","expires_in":600}' };
    }
    reads++;
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.authorization, 'Bearer synthetic-access-token');
    return { status: 200, contentType: 'application/json', body: '{"available":true}' };
  }, entry => events.push(entry));
  const ctx = { mode: 'read' as const, signal: AbortSignal.timeout(10000),
    async authorize() {}, async secret() { return 'synthetic-client-secret'; } };
  const binding = broker.binding('Inventory');
  const responses = await Promise.all([1, 2, 3].map(() => broker.send('Inventory', binding, { path: '/v1/items' }, ctx)));
  assert.equal(exchanges, 1);
  assert.equal(reads, 3);
  assert(responses.every(response => response.body === '{"available":true}'));
  assert(!JSON.stringify(events).includes('synthetic-'));
});
