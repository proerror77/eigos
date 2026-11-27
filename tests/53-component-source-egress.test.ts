import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PermissionDenied } from '../packages/core/identity.js';
import { ComponentOAuthGrants, SourceOAuthReauthorization } from '../packages/runtime/component-source-oauth.js';
import { Database } from '../packages/runtime/database.js';
import { fixture } from './fixture.js';
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

function refreshConfiguration(seed = 'inventory-refresh') {
  return { Inventory: { baseUrl: 'https://inventory.example.com/v1/', methods: ['GET'], oauth: {
    grant: 'refresh_token', tokenUrl: 'https://tokens.example.com/oauth/token', clientId: 'warehouse-eigos',
    clientSecret: 'inventory-client', refreshTokenSecret: seed,
  } } };
}

async function oauthFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-component-oauth-grant-'));
  try {
    const key = join(directory, 'key'), bundle = join(directory, 'bundle');
    const encryptionKey = randomBytes(32);
    const seed = 'synthetic-inventory-refresh-0', fallbackSeed = 'synthetic-inventory-reauthorized', clientSecret = 'synthetic-inventory-client';
    await writeFile(key, encryptionKey, { mode: 0o600 });
    await writeFile(bundle, JSON.stringify(sealSourceSecrets({
      'inventory-refresh': seed, 'inventory-client': clientSecret, 'replacement-refresh': fallbackSeed,
    }, encryptionKey)), { mode: 0o600 });
    encryptionKey.fill(0);
    const f = await fixture();
    const secrets = new ComponentSourceSecrets(bundle, key);
    return { f, secrets, seed, clientSecret, fallbackSeed,
      async close() { try { await f.close(); } finally { await rm(directory, { recursive: true }); } },
    };
  } catch (error) {
    await rm(directory, { recursive: true });
    throw error;
  }
}

test('a refresh grant rotates once across PostgreSQL clients and survives process restart', async () => {
  const { f, secrets, seed, clientSecret, close } = await oauthFixture();
  let other: Database | undefined = new Database(process.env.EIGOS_TEST_DATABASE_URL!, f.schema);
  try {
    const events: unknown[] = [], exchanges: string[] = [], sent: string[] = [];
    const transport: NonNullable<ConstructorParameters<typeof ComponentSourceEgress>[1]> = async (url, options) => {
      if (url.hostname === 'tokens.example.com') {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.authorization, 'Basic ' + Buffer.from('warehouse-eigos:' + clientSecret).toString('base64'));
        const body = new URLSearchParams(options.body);
        assert.equal(body.get('grant_type'), 'refresh_token');
        assert.equal(body.has('scope'), false);
        exchanges.push(body.get('refresh_token')!);
        const revision = exchanges.length;
        await delay(60);
        return { status: 200, contentType: 'application/json', body: JSON.stringify({
          token_type: 'Bearer', access_token: 'synthetic-inventory-access-' + revision,
          ...(revision === 1 ? { refresh_token: 'synthetic-inventory-rotation-1' } : {}),
          expires_in: 600,
        }) };
      }
      sent.push(options.headers.authorization!);
      return { status: 200, contentType: 'application/json', body: '{"inventory":2}' };
    };
    const broker = (db: Database) => new ComponentSourceEgress(refreshConfiguration(), transport, event => events.push(event),
      new ComponentOAuthGrants(db, secrets));
    const ctx = { mode: 'read' as const, signal: AbortSignal.timeout(20_000), secret: (name: string) => secrets.get(name),
      async authorize(source: string) { assert.equal(source, 'Inventory'); } };
    const call = (egress: ComponentSourceEgress) => egress.send('Inventory', egress.binding('Inventory'), { path: '/v1/items' }, ctx);
    const a = broker(f.db), b = broker(other);
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => call(index % 2 ? a : b)));
    assert.deepEqual(exchanges, [seed]);
    assert.deepEqual(sent, Array(8).fill('Bearer synthetic-inventory-access-1'));
    assert(responses.every(response => response.body === '{"inventory":2}'));
    assert(!JSON.stringify(events).includes('synthetic-inventory'));

    const { rows: [row] } = await f.db.query<{ credential_key: string; sealed_grant: Buffer; attempt: string | null }>(
      `SELECT credential_key,sealed_grant,attempt FROM ${f.db.schema}.component_source_oauth_grants`);
    assert.equal(row!.attempt, null);
    assert(!row!.sealed_grant.toString().includes('synthetic-inventory'));
    await assert.rejects(secrets.openGrant('0'.repeat(64), row!.sealed_grant), /unavailable/);
    const grant = await secrets.openGrant(row!.credential_key, row!.sealed_grant);
    assert.equal(grant.refreshToken, 'synthetic-inventory-rotation-1');
    await other.close();
    other = undefined;
    const expired = await secrets.sealGrant(row!.credential_key, { ...grant, validUntil: 0 });
    await f.db.query(`UPDATE ${f.db.schema}.component_source_oauth_grants SET sealed_grant=$2 WHERE credential_key=$1`,
      [row!.credential_key, expired]);

    other = new Database(process.env.EIGOS_TEST_DATABASE_URL!, f.schema);
    await call(broker(other));
    assert.deepEqual(exchanges, [seed, 'synthetic-inventory-rotation-1']);
    assert.equal(sent.at(-1), 'Bearer synthetic-inventory-access-2');
    const { rows: [next] } = await f.db.query<{ sealed_grant: Buffer }>(
      `SELECT sealed_grant FROM ${f.db.schema}.component_source_oauth_grants WHERE credential_key=$1`, [row!.credential_key]);
    assert.equal((await secrets.openGrant(row!.credential_key, next!.sealed_grant)).refreshToken, 'synthetic-inventory-rotation-1');
  } finally { try { await other?.close(); } finally { await close(); } }
});

test('a rejected refresh can retry, while an uncertain attempt remains fenced until reauthorization', async () => {
  const { f, secrets, seed, fallbackSeed, close } = await oauthFixture();
  try {
    const exchanges: string[] = [];
    const transport: NonNullable<ConstructorParameters<typeof ComponentSourceEgress>[1]> = async (url, options) => {
      if (url.hostname !== 'tokens.example.com') return { status: 200, contentType: 'application/json', body: '{}' };
      const credential = new URLSearchParams(options.body).get('refresh_token')!;
      exchanges.push(credential);
      if (exchanges.length === 1) return { status: 400, contentType: 'application/json', body: '{"error":"temporarily_unavailable"}' };
      if (exchanges.length === 2) throw new Error('synthetic token response lost after the server rotated its token');
      assert.equal(credential, fallbackSeed);
      return { status: 200, contentType: 'application/json', body: '{"access_token":"synthetic-recovered","token_type":"bearer","expires_in":60}' };
    };
    const broker = (seedName?: string) => new ComponentSourceEgress(refreshConfiguration(seedName), transport, () => {},
      new ComponentOAuthGrants(f.db, secrets));
    let checks = 0, allow = false;
    const ctx = { mode: 'read' as const, signal: AbortSignal.timeout(20_000), secret: (name: string) => secrets.get(name),
      async authorize() { if (!allow && ++checks > 1) throw new PermissionDenied('Source grant was revoked'); } };
    const call = (egress: ComponentSourceEgress) => egress.send('Inventory', egress.binding('Inventory'), { path: '/v1/items' }, ctx);
    const original = broker();
    await assert.rejects(call(original), /Source grant was revoked/);
    assert.deepEqual(exchanges, []);
    allow = true;
    await assert.rejects(call(original), /Source request failed/);
    await assert.rejects(call(original), SourceOAuthReauthorization);
    await assert.rejects(call(broker()), SourceOAuthReauthorization);
    assert.deepEqual(exchanges, [seed, seed]);
    const replacement = broker('replacement-refresh');
    assert.notEqual(original.binding('Inventory'), replacement.binding('Inventory'));
    assert.equal((await call(replacement)).status, 200);
    assert.deepEqual(exchanges, [seed, seed, fallbackSeed]);
  } finally { await close(); }
});

test('cancellation after token dispatch persists the rotated grant for later callers', async () => {
  const { f, secrets, close } = await oauthFixture();
  try {
    const cancelled = new AbortController();
    let exchanges = 0, reads = 0;
    const egress = new ComponentSourceEgress(refreshConfiguration(), async (url, options) => {
      if (url.hostname === 'tokens.example.com') {
        exchanges++;
        cancelled.abort();
        assert(!options.signal.aborted);
        return { status: 200, contentType: 'application/json', body:
          '{"access_token":"synthetic-access","refresh_token":"synthetic-new-grant","token_type":"bearer","expires_in":60}' };
      }
      reads++;
      return { status: 200, contentType: 'application/json', body: '{}' };
    }, () => {}, new ComponentOAuthGrants(f.db, secrets));
    const binding = egress.binding('Inventory'), path = { path: '/v1/items' };
    const caller = { mode: 'read' as const, secret: (name: string) => secrets.get(name), async authorize() {} };
    await assert.rejects(egress.send('Inventory', binding, path, { ...caller, signal: cancelled.signal }), { name: 'AbortError' });
    assert.equal(reads, 0);
    assert.equal((await egress.send('Inventory', binding, path, { ...caller, signal: AbortSignal.timeout(10_000) })).status, 200);
    assert.equal(exchanges, 1);
    assert.equal(reads, 1);
  } finally { await close(); }
});

test('an OAuth endpoint blocked before HTTP dispatch keeps the existing grant recoverable', async () => {
  const { f, secrets, close } = await oauthFixture();
  try {
    const config = refreshConfiguration();
    config.Inventory.oauth.tokenUrl = 'https://127.0.0.1/token';
    const events: { outcome: string }[] = [];
    const egress = new ComponentSourceEgress(config, undefined, event => events.push(event), new ComponentOAuthGrants(f.db, secrets));
    const binding = egress.binding('Inventory');
    const ctx = { mode: 'read' as const, signal: AbortSignal.timeout(10_000),
      secret: (name: string) => secrets.get(name), async authorize() {} };
    for (let index = 0; index < 2; index++)
      await assert.rejects(egress.send('Inventory', binding, { path: '/v1/items' }, ctx), /outside its egress network/);
    assert.deepEqual(events.map(event => event.outcome), ['denied', 'denied']);
    const { rows: [row] } = await f.db.query(`SELECT attempt,sealed_grant FROM ${f.db.schema}.component_source_oauth_grants`);
    assert.deepEqual(row, { attempt: null, sealed_grant: null });
  } finally { await close(); }
});
