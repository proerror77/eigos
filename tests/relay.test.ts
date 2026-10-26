import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { CompactSign, createLocalJWKSet, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { DatabaseSync } from 'node:sqlite';
import { createRelayApp } from '../apps/relay/app.js';
import { readRelayConfig, relayJwtVerifier } from '../apps/relay/config.js';
import { RelayClient } from '../packages/agent-transport/client.js';
import { createNodeKeys, createProof, verifyEnvelope, type NodeKeys } from '../packages/agent-transport/crypto.js';
import { RelayError, sha256 } from '../packages/relay/contracts.js';
import { RelayStore } from '../packages/relay/store.js';

const ownerToken = 'fixture-owner-access-token-only';
const errorCode = (code: string) => (error: unknown) => error instanceof RelayError && error.code === code;
async function fixture(options: { limit?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-relay-')), server = createServer(), clients: RelayClient[] = [];
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`, databasePath = join(directory, 'relay.sqlite');
  const config = readRelayConfig({ EIGOS_RELAY_AUTH_MODE: 'development', EIGOS_RELAY_DEV_TOKEN: 'x'.repeat(32), EIGOS_RELAY_PUBLIC_URL: baseUrl, EIGOS_RELAY_DATABASE_PATH: databasePath });
  const verifyOwner = async (token: string) => {
    if (![ownerToken, 'other-fixture-owner'].includes(token)) throw new Error('Invalid owner');
    return { issuer: 'https://fixture.idp', subject: token === ownerToken ? 'alice' : 'bob', tenant: 'test' };
  };
  let store = new RelayStore(databasePath, Date.now, options.limit ? { maxInboxMessages: options.limit } : {});
  let relay = createRelayApp(config, { store, verifyOwner }); server.on('request', relay.app);
  async function client(name: string, customFetch?: typeof fetch, enrollToken = ownerToken) {
    const credentialPath = join(directory, `${name}.json`);
    const value = await RelayClient.open({ baseUrl, credentialPath, displayName: name, fetch: customFetch });
    clients.push(value); await value.register(enrollToken); return value;
  }
  const keys = (name: string, client: RelayClient): { keys: NodeKeys; secret: string } => {
    const raw = JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
    return { keys: { signingKey: raw.signingKey, encryptionKey: raw.encryptionKey, identity: client.identity }, secret: raw.secret };
  };
  async function request(name: string, client: RelayClient, path: string, method = 'GET', body?: unknown, proofOverride?: string) {
    const { keys: k, secret } = keys(name, client), proof = proofOverride ?? await createProof(k, secret, method, baseUrl + path);
    return fetch(baseUrl + path, { method, headers: { Authorization: 'DPoP ' + secret, DPoP: proof, 'X-EIGOS-Agent-ID': client.agentId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function connect(a: RelayClient, b: RelayClient) { const pending = await a.requestContact(b.agentId); await b.respondContact(pending.id, 'accept'); return pending.id; }
  return { directory, databasePath, baseUrl, client, connect, request, keys,
    store: () => store,
    restart() { server.removeListener('request', relay.app); relay.stop(); store.close(); store = new RelayStore(databasePath); relay = createRelayApp(config, { store, verifyOwner }); server.on('request', relay.app); },
    async close() { for (const c of clients) c.close(); relay.stop(); server.close(); await once(server, 'close'); store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('contact acceptance gates communication; node identity and registration survive restart without plaintext in the relay store', async () => {
  const f = await fixture();
  try {
    const a = await f.client('A'), b = await f.client('B');
    const pending = await a.requestContact(b.agentId), id = randomUUID();
    assert.equal((await a.requestContact(b.agentId, pending.id)).id, pending.id);
    await assert.rejects(a.respondContact(pending.id, 'accept'), errorCode('RECIPIENT_APPROVAL_REQUIRED'));
    await assert.rejects(a.send(b.agentId, pending.id, { privateText: 'schedule-private-fixture' }, { id }), errorCode('CONTACT_NOT_ACCEPTED'));
    await b.respondContact(pending.id, 'accept');
    const queued = await a.deliver(id); assert.equal(queued.status, 'queued');
    const stored = Buffer.concat(readdirSync(f.directory).filter(file => file.startsWith('relay.sqlite')).map(file => readFileSync(join(f.directory, file))));
    const { keys, secret } = f.keys('A', a);
    for (const value of ['schedule-private-fixture', ownerToken, secret, keys.signingKey.d!, keys.encryptionKey.d!]) assert(!stored.includes(Buffer.from(value)));
    f.restart(); assert.equal((await a.deliver(id)).id, id);
    const received = await b.poll(); assert.equal(received.length, 1); assert.deepEqual(received[0]!.content, { privateText: 'schedule-private-fixture' });
    assert.equal((await a.receipt(a.agentId, id)).status, 'received');
    assert.equal(f.store().inbox(b.agentId).length, 0);
    b.markHandled(a.agentId, id); assert.deepEqual(await b.poll(), []);
    assert.equal(statSync(f.databasePath).mode & 0o777, 0o600);
  } finally { await f.close(); }
});

test('a lost send response retries the exact stored envelope and cannot change the original message', async () => {
  const f = await fixture(); let lose = true;
  const fetcher: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).endsWith('/v1/messages') && init?.method === 'POST' && lose) { lose = false; throw new Error('fixture lost response'); }
    return response;
  };
  try {
    const a = await f.client('A', fetcher), b = await f.client('B'), contact = await f.connect(a, b), id = randomUUID();
    await assert.rejects(a.send(b.agentId, contact, { message: 'only once' }, { id }), /lost response/);
    assert.equal(a.outbox().length, 1); assert.equal(f.store().inbox(b.agentId).length, 1);
    a.close(); const reopened = await f.client('A'); assert.equal((await reopened.deliver(id)).status, 'queued');
    assert.equal(f.store().inbox(b.agentId).length, 1);
    await assert.rejects(reopened.queue(b.agentId, contact, { message: 'different' }, { id }), errorCode('MESSAGE_ID_CONFLICT'));
  } finally { await f.close(); }
});

test('a lost ACK keeps the private inbox durable and does not repeat handled application delivery', async () => {
  const f = await fixture(); let lose = true;
  const fetcher: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).endsWith('/ack') && lose) { lose = false; throw new Error('fixture lost ack'); }
    return response;
  };
  try {
    const a = await f.client('A'), b = await f.client('B', fetcher), connectionId = await f.connect(a, b);
    const sent = await a.send(b.agentId, connectionId, { status: 'candidate' });
    await assert.rejects(b.poll(), /lost ack/); assert.equal((await b.pending()).length, 1);
    b.close(); const reopened = await f.client('B');
    assert.equal((await reopened.poll())[0]!.id, sent.id);
    reopened.markHandled(a.agentId, sent.id); assert.deepEqual(await reopened.poll(), []);
    assert.equal((await a.deliver(sent.id)).status, 'received');
  } finally { await f.close(); }
});

test('contact revocation removes queued ciphertext and a new accepted contact cannot revive an old envelope', async () => {
  const f = await fixture();
  try {
    const a = await f.client('A'), b = await f.client('B'), connectionId = await f.connect(a, b);
    const sent = await a.send(b.agentId, connectionId, { message: 'withdraw queued' });
    await b.respondContact(connectionId, 'revoke'); assert.deepEqual(await b.poll(), []);
    assert.equal((await a.deliver(sent.id)).status, 'revoked');
    await assert.rejects(b.respondContact(connectionId, 'accept'), errorCode('CONNECTION_STATE_CONFLICT'));
    await f.connect(a, b); assert.equal((await a.deliver(sent.id)).status, 'revoked');
    await assert.rejects(a.send(b.agentId, connectionId, {}), errorCode('CONTACT_NOT_ACCEPTED'));
  } finally { await f.close(); }
});

test('owner and node isolation prevent foreign revoke, inbox ACK and receipt access; revoked keys cannot re-enroll', async () => {
  const f = await fixture();
  try {
    const a = await f.client('A'), b = await f.client('B'), c = await f.client('C', undefined, 'other-fixture-owner'), contact = await f.connect(a, b);
    const sent = await a.send(b.agentId, contact, { private: 'only B' });
    await assert.rejects(c.receipt(a.agentId, sent.id), errorCode('MESSAGE_NOT_FOUND'));
    assert.equal((await f.request('C', c, `/v1/messages/${a.agentId}/${sent.id}/ack`, 'POST', { digest: sent.digest })).status, 404);
    await assert.rejects(a.revoke('other-fixture-owner'), errorCode('AGENT_NOT_FOUND'));
    await a.revoke(ownerToken); assert.deepEqual(await b.poll(), []);
    await assert.rejects(a.contacts(), errorCode('AGENT_REVOKED_OR_EXPIRED'));
    await assert.rejects(a.register(ownerToken), errorCode('AGENT_REGISTRATION_CONFLICT'));
    await assert.rejects(a.renew(ownerToken), errorCode('AGENT_REVOKED_OR_EXPIRED'));
  } finally { await f.close(); }
});

test('DPoP replay is rejected across relay restart and a copied connection token cannot use another key', async () => {
  const f = await fixture();
  try {
    const a = await f.client('A'), b = await f.client('B'), { keys, secret } = f.keys('A', a);
    const proof = await createProof(keys, secret, 'GET', f.baseUrl + '/v1/contacts');
    assert.equal((await f.request('A', a, '/v1/contacts', 'GET', undefined, proof)).status, 200);
    f.restart(); const replay = await f.request('A', a, '/v1/contacts', 'GET', undefined, proof);
    assert.equal(replay.status, 401); assert.equal((await replay.json()).error, 'DPOP_PROOF_REPLAY');
    const wrong = await createProof(f.keys('B', b).keys, secret, 'GET', f.baseUrl + '/v1/contacts');
    assert.equal((await f.request('A', a, '/v1/contacts', 'GET', undefined, wrong)).status, 401);
  } finally { await f.close(); }
});

test('bounded long polling wakes on new messages and rechecks revocation during the wait', async () => {
  const f = await fixture();
  try {
    const a = await f.client('A'), b = await f.client('B'), contact = await f.connect(a, b);
    const poll = b.poll({ waitSeconds: 2 }); await sleep(80); await a.send(b.agentId, contact, { wake: true });
    const received = await poll; assert.equal(received.length, 1); b.markHandled(a.agentId, received[0]!.id);
    const waiting = assert.rejects(b.poll({ waitSeconds: 2 }), errorCode('AGENT_REVOKED_OR_EXPIRED'));
    await sleep(80); await b.revoke(ownerToken); await waiting;
  } finally { await f.close(); }
});

test('inbox quotas preserve idempotent retries and release capacity on durable receive', async () => {
  const f = await fixture({ limit: 1 });
  try {
    const a = await f.client('A'), b = await f.client('B'), contact = await f.connect(a, b);
    const first = await a.send(b.agentId, contact, { n: 1 }); assert.equal((await a.deliver(first.id)).id, first.id);
    const second = await a.queue(b.agentId, contact, { n: 2 });
    await assert.rejects(a.deliver(second), errorCode('INBOX_QUOTA'));
    await b.poll(); assert.equal((await a.deliver(second)).status, 'queued');
  } finally { await f.close(); }
});

test('a signed but undecryptable peer message is quarantined without waking the host or blocking the inbox', async () => {
  const f = await fixture();
  try {
    const a = await f.client('A'), b = await f.client('B'), contact = await f.connect(a, b);
    const id = await a.queue(b.agentId, contact, { message: 'poison fixture' });
    const db = new DatabaseSync(join(f.directory, 'A.json.sqlite'));
    const signed = String(db.prepare('SELECT envelope FROM node_outbox WHERE id=?').get(id)!.envelope); db.close();
    const e = await verifyEnvelope(signed, a.identity), parts = e.ciphertext.split('.'); parts[3] = 'a'.repeat(parts[3]!.length);
    const corrupted = await new CompactSign(Buffer.from(JSON.stringify({ ...e, ciphertext: parts.join('.') })))
      .setProtectedHeader({ alg: 'EdDSA', typ: 'eigos-envelope+jws', kid: a.agentId }).sign(await importJWK(f.keys('A', a).keys.signingKey, 'EdDSA'));
    assert.equal((await f.request('A', a, '/v1/messages', 'POST', { signedEnvelope: corrupted })).status, 200);
    assert.deepEqual(await b.poll(), []); assert.equal(b.rejected()[0]!.reason, 'INVALID_ENCRYPTED_CONTENT');
    assert.equal((await a.receipt(a.agentId, id)).status, 'received', 'Receipt means connector received, not business acceptance');
  } finally { await f.close(); }
});

test('relay configuration fails closed and dedicated databases cannot alias the business store', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-relay-isolation-'));
  try {
    assert.throws(() => readRelayConfig({ EIGOS_RELAY_DATABASE_PATH: join(directory, 'relay.sqlite') }), /JWT enrollment/);
    assert.throws(() => readRelayConfig({ EIGOS_RELAY_DATABASE_PATH: join(directory, 'relay.sqlite'), EIGOS_RELAY_AUTH_MODE: 'development', EIGOS_RELAY_DEV_TOKEN: 'x'.repeat(32), EIGOS_RELAY_HOST: '0.0.0.0' }), /loopback/);
    const path = join(directory, 'business.sqlite'); writeFileSync(path, '', { mode: 0o600 });
    const db = new DatabaseSync(path); db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY)'); db.close();
    assert.throws(() => new RelayStore(path), /another application/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('owner enrollment JWT verifies audience, issuer, tenant, scope, client and bounded lifetime', async () => {
  const key = await generateKeyPair('ES256'), publicKey = { ...await exportJWK(key.publicKey), kid: 'relay-owner' };
  const config = readRelayConfig({ EIGOS_RELAY_DATABASE_PATH: '/tmp/unused-relay-auth.sqlite', EIGOS_RELAY_PUBLIC_URL: 'https://relay.fixture',
    EIGOS_RELAY_OAUTH_ISSUER: 'https://issuer.fixture/', EIGOS_RELAY_OAUTH_AUDIENCE: 'relay-audience', EIGOS_RELAY_OAUTH_JWKS_URL: 'https://issuer.fixture/keys', EIGOS_RELAY_CLIENT_IDS: 'pa-client' });
  const verify = relayJwtVerifier(config, createLocalJWKSet({ keys: [publicKey] }));
  const sign = (claims: Record<string, unknown> = {}, audience = 'relay-audience', seconds = 300) => new SignJWT({ tenant_id: 'tenant-a', scope: 'relay:enroll', client_id: 'pa-client', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: publicKey.kid, typ: 'at+jwt' }).setIssuer(config.issuer!).setSubject('owner-a').setAudience(audience).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + seconds).sign(key.privateKey);
  assert.deepEqual(await verify(await sign()), { issuer: config.issuer, subject: 'owner-a', tenant: 'tenant-a' });
  for (const claims of [{ scope: 'tasks:write' }, { client_id: 'unknown-client' }, { tenant_id: undefined }]) await assert.rejects(verify(await sign(claims)));
  await assert.rejects(verify(await sign({}, 'business-audience'))); await assert.rejects(verify(await sign({}, 'relay-audience', 1800)));
});

test('expired connection credentials require explicit owner renewal; a repeated renewal cannot silently extend authority', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-relay-expiry-')); let now = Date.now();
  const store = new RelayStore(join(directory, 'relay.sqlite'), () => now), keys = await createNodeKeys('Expiry');
  const owner = { issuer: 'fixture', subject: 'owner', tenant: 'tenant' }, secret = 'fixture-connection-secret';
  try {
    const requestId = randomUUID(), registration = store.register(owner, keys.identity, sha256(secret), requestId);
    assert.equal(store.register(owner, keys.identity, sha256(secret), requestId).expiresAt, registration.expiresAt);
    now = registration.expiresAt + 1; assert.throws(() => store.authenticate(keys.identity.card.agentId, secret), /EXPIRED/);
    assert.throws(() => store.renew({ ...owner, subject: 'stranger' }, keys.identity.card.agentId, randomUUID()), /NOT_FOUND/);
    const renewalId = randomUUID(), renewed = store.renew(owner, keys.identity.card.agentId, renewalId);
    store.authenticate(keys.identity.card.agentId, secret); now += 60000;
    assert.equal(store.renew(owner, keys.identity.card.agentId, renewalId).expiresAt, renewed.expiresAt);
    store.revoke(owner, keys.identity.card.agentId);
    assert.throws(() => store.renew(owner, keys.identity.card.agentId, randomUUID()), /EXPIRED/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('host listener checks contact revocation before handling an already persisted pending message', async () => {
  const f = await fixture();
  try {
    const a = await f.client('A'), b = await f.client('B'), contact = await f.connect(a, b);
    await a.send(b.agentId, contact, { query: 'availability' }); await b.poll();
    await a.respondContact(contact, 'revoke'); let handled = 0;
    await assert.rejects(b.listen(async () => { handled++; }, AbortSignal.timeout(200)));
    assert.equal(handled, 0); assert.equal(b.rejected()[0]!.reason, 'CONTACT_REVOKED');
  } finally { await f.close(); }
});

test('a node is pinned to its private origin and state; opening it twice cannot race its inbox', async () => {
  const f = await fixture();
  try {
    const a = await f.client('A'), path = join(f.directory, 'A.json');
    await assert.rejects(RelayClient.open({ baseUrl: f.baseUrl, credentialPath: path, displayName: 'A' }), /already open/);
    a.close();
    await assert.rejects(RelayClient.open({ baseUrl: 'https://other-relay.fixture', credentialPath: path, displayName: 'A' }), /different relay/);
    const reopened = await f.client('A'); assert.equal(reopened.agentId, a.agentId);
  } finally { await f.close(); }
});

test('serializing or inspecting the connector cannot expose connection credentials or private keys', async () => {
  const f = await fixture();
  try {
    const a = await f.client('A'), { keys, secret } = f.keys('A', a);
    const output = JSON.stringify(a) + inspect(a, { depth: null, showHidden: true });
    for (const value of [secret, keys.signingKey.d!, keys.encryptionKey.d!]) assert(!output.includes(value));
  } finally { await f.close(); }
});

test('a message expiring during contact readback cannot reach the host handler', async t => {
  const f = await fixture(), controller = new AbortController(); let expireOnReadback = false, expiresAt = Date.now() + 30000, handled = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (expireOnReadback && String(input).includes('/v1/inbox?')) { controller.abort(); throw controller.signal.reason; }
    const response = await fetch(input, init);
    if (expireOnReadback && String(input).endsWith('/v1/contacts')) t.mock.method(Date, 'now', () => expiresAt + 1);
    return response;
  };
  try {
    const a = await f.client('A'), b = await f.client('B', fetcher), contact = await f.connect(a, b);
    await a.send(b.agentId, contact, { query: 'availability' }, { expiresAt }); await b.poll();
    expireOnReadback = true;
    await assert.rejects(b.listen(async () => { handled++; }, controller.signal));
    assert.equal(handled, 0); assert.equal(b.rejected()[0]!.reason, 'MESSAGE_EXPIRED_OR_INVALID');
  } finally { t.mock.restoreAll(); await f.close(); }
});

test('stopping the listener during contact readback preserves the inbox without invoking the handler', async () => {
  const f = await fixture(), controller = new AbortController(); let stopOnReadback = false, handled = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (stopOnReadback && String(input).endsWith('/v1/contacts')) controller.abort();
    return response;
  };
  try {
    const a = await f.client('A'), b = await f.client('B', fetcher), contact = await f.connect(a, b);
    await a.send(b.agentId, contact, { query: 'availability' }); await b.poll(); stopOnReadback = true;
    await assert.rejects(b.listen(async () => { handled++; }, controller.signal));
    assert.equal(handled, 0); assert.equal((await b.pending()).length, 1);
  } finally { await f.close(); }
});
