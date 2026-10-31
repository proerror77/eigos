import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { CompactSign, createLocalJWKSet, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { DatabaseSync } from 'node:sqlite';
import { createRelayApp } from '../apps/relay/app.js';
import { readRelayConfig, relayJwtVerifier } from '../apps/relay/config.js';
import { RelayClient } from '../packages/agent-transport/client.js';
import { createNodeKeys, createProof, signEnvelope, verifyEnvelope, type NodeKeys } from '../packages/agent-transport/crypto.js';
import { RelayError, sha256 } from '../packages/relay/contracts.js';
import { RelayStore } from '../packages/relay/store.js';

const ownerToken = 'fixture-owner-access-token-only';
const errorCode = (code: string) => (error: unknown) => error instanceof RelayError && error.code === code;
async function fixture(options: { limit?: number; trustLoopbackProxy?: boolean; now?: () => number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-relay-')), server = createServer(), clients: RelayClient[] = [];
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`, databasePath = join(directory, 'relay.sqlite');
  const config = readRelayConfig({ EIGOS_RELAY_AUTH_MODE: 'development', EIGOS_RELAY_DEV_TOKEN: 'x'.repeat(32), EIGOS_RELAY_PUBLIC_URL: baseUrl, EIGOS_RELAY_DATABASE_PATH: databasePath,
    EIGOS_RELAY_TRUST_LOOPBACK_PROXY: String(options.trustLoopbackProxy ?? false) });
  const verifyOwner = async (token: string) => {
    if (![ownerToken, 'other-fixture-owner'].includes(token)) throw new Error('Invalid owner');
    return { issuer: 'https://fixture.idp', subject: token === ownerToken ? 'alice' : 'bob', tenant: 'test' };
  };
  let store = new RelayStore(databasePath, options.now ?? Date.now, options.limit ? { maxInboxMessages: options.limit } : {});
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

test('simultaneous contact discovery and node restart reuse one connection without accepting it', async () => {
  const f = await fixture(); let lookups = 0, release!: () => void;
  const bothListed = new Promise<void>(resolve => { release = resolve; });
  const fetcher: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/v1/contacts') && init?.method === 'GET' && lookups < 2) {
      if (++lookups === 2) release();
      await bothListed;
    }
    return response;
  };
  try {
    const a = await f.client('A', fetcher), b = await f.client('B', fetcher);
    const [first, raced] = await Promise.all([a.ensureContact(b.agentId), b.ensureContact(a.agentId)]);
    assert.equal(first.id, raced.id); assert.equal(first.state, 'pending'); assert.equal(raced.state, 'pending');
    assert.equal((await a.contacts()).length, 1);
    await assert.rejects(a.send(b.agentId, first.id, { value: 'not-yet-authorized' }), errorCode('CONTACT_NOT_ACCEPTED'));
    const recipient = first.recipient === a.agentId ? a : b;
    await recipient.respondContact(first.id, 'accept');
    assert.equal((await a.ensureContact(b.agentId)).state, 'accepted');
    b.close(); const reopened = await f.client('B');
    assert.equal((await reopened.ensureContact(a.agentId)).id, first.id);
    await a.respondContact(first.id, 'revoke');
    const replacement = await reopened.ensureContact(a.agentId);
    assert.notEqual(replacement.id, first.id); assert.equal(replacement.state, 'pending');
    await assert.rejects(reopened.send(a.agentId, replacement.id, { value: 'still-needs-approval' }), errorCode('CONTACT_NOT_ACCEPTED'));
    await a.revoke(ownerToken);
    await assert.rejects(reopened.ensureContact(a.agentId), errorCode('PEER_REVOKED_OR_EXPIRED'));
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

test('concurrent stale-lock recovery cannot remove the winning process lock', { timeout: 30000 }, async () => {
  const f = await fixture(), children: { child: ReturnType<typeof spawn>; exited: Promise<unknown>; gate: string; state?: string }[] = [];
  const until = async (predicate: () => boolean) => { const end = Date.now() + 12000; while (!predicate() && Date.now() < end) await sleep(10); assert(predicate(), JSON.stringify(children.map(c => c.state))); };
  try {
    const client = await f.client('A'), credentialPath = join(f.directory, 'A.json'); client.close();
    const dead = spawnSync(process.execPath, ['-e', '']); assert.equal(dead.status, 0);
    writeFileSync(credentialPath + '.lock', JSON.stringify({ pid: dead.pid }), { mode: 0o600 });
    const script = fileURLToPath(new URL(`./fixtures/relay-lock-child.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url));
    for (let i = 0; i < 2; i++) {
      const gate = join(f.directory, `lock-gate-${i}`), child = spawn(process.execPath, ['--import', 'tsx', script, credentialPath, f.baseUrl, gate, process.env.EIGOS_TEST_RELAY_LOCK_IMPLEMENTATION ?? ''], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const entry = { child, exited: once(child, 'exit'), gate, state: undefined as string | undefined };
      child.on('message', message => { if (message && typeof message === 'object' && 'state' in message) entry.state = String(message.state); }); children.push(entry);
    }
    await until(() => children.every(c => c.state));
    const winner = children.find(c => c.state === 'recovering'); assert(winner);
    writeFileSync(winner.gate, 'continue'); await until(() => winner.state === 'opened' || winner.state === 'rejected');
    for (const other of children.filter(c => c !== winner)) if (other.state === 'recovering') writeFileSync(other.gate, 'continue');
    await until(() => children.every(c => c.state === 'opened' || c.state === 'rejected'));
    assert.equal(children.filter(c => c.state === 'opened').length, 1, 'A stale remover must not unlink a new live owner');
    const owner = children.find(c => c.state === 'opened')!; owner.child.kill('SIGKILL'); await owner.exited;
    assert.equal((await f.client('A')).agentId, client.agentId, 'An actual process crash releases the OS lock without losing node identity');
  } finally {
    for (const { child, gate } of children) { writeFileSync(gate, 'continue'); if (child.connected) child.send('close'); }
    await Promise.all(children.map(async ({ child, exited }) => { const timer = setTimeout(() => child.kill('SIGKILL'), 1000); try { await exited; } finally { clearTimeout(timer); } }));
    await f.close();
  }
});

test('outbox recovery paginates beyond a thousand delivered messages and finds a new unsent envelope after restart', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.client('A'), b = await f.client('B'), contact = await f.connect(a, b), receipt = await a.send(b.agentId, contact, { old: true });
    for (const item of await b.poll()) b.markHandled(item.senderId, item.id);
    const keys = f.keys('A', a).keys, database = new DatabaseSync(join(f.directory, 'A.json.sqlite'));
    try {
      const insert = database.prepare('INSERT INTO node_outbox VALUES(?,?,?,?,?,?)');
      for (let i = 0; i < 1000; i++) {
        const id = randomUUID(), content = { historical: i }, envelope = await signEnvelope(keys, b.identity, contact, content, { id });
        insert.run(id, b.agentId, contact, sha256(JSON.stringify(content)), envelope, JSON.stringify({ ...receipt, id, digest: sha256(envelope), status: 'received' }));
      }
    } finally { database.close(); }
    const fresh = await a.queue(b.agentId, contact, { fresh: true }); a.close();
    const reopened = await f.client('A'), first = reopened.outbox(), second = reopened.outbox({ after: first.at(-1)!.cursor });
    assert.equal(first.length, 1000); assert(second.some(item => item.id === fresh));
    assert.equal(new Set([...first, ...second].map(item => item.id)).size, 1002);
    assert.deepEqual(reopened.outbox({ pendingOnly: true }).map(item => item.id), [fresh]);
    assert.deepEqual(reopened.outbox({ after: second.at(-1)!.cursor }), []);
    await reopened.deliver(fresh); assert.deepEqual((await b.poll()).map(item => item.content), [{ fresh: true }]);
  } finally { await f.close(); }
});

test('trusted loopback TLS proxies retain per-client ingress buckets without trusting a spoofed earlier hop', async () => {
  const now = Date.now(), f = await fixture({ trustLoopbackProxy: true, now: () => now });
  const request = async (forwarded: string) => { const response = await fetch(f.baseUrl + '/health', { headers: { 'X-Forwarded-For': forwarded } }); await response.arrayBuffer(); return response.status; };
  try {
    for (let batch = 0; batch < 20; batch++) assert((await Promise.all(Array.from({ length: 30 }, () => request('198.51.100.20')))).every(status => status === 200));
    assert.equal(await request('198.51.100.20'), 429);
    assert.equal(await request('198.51.100.21'), 200);
    assert.equal(await request('192.0.2.123, 198.51.100.20'), 429, 'A client-supplied earlier hop cannot replace the address appended by the trusted proxy');
    assert.throws(() => readRelayConfig({ EIGOS_RELAY_HOST: '0.0.0.0', EIGOS_RELAY_TRUST_LOOPBACK_PROXY: 'true', EIGOS_RELAY_DATABASE_PATH: join(f.directory, 'unused.sqlite') }), /loopback-only/);
  } finally { await f.close(); }
});

test('forwarded addresses cannot evade ingress limits when no trusted proxy is configured', async () => {
  const now = Date.now(), f = await fixture({ now: () => now });
  const request = async (i: number) => { const response = await fetch(f.baseUrl + '/health', { headers: { 'X-Forwarded-For': `198.51.100.${i % 254 + 1}` } }); await response.arrayBuffer(); return response.status; };
  try {
    for (let batch = 0; batch < 20; batch++) assert((await Promise.all(Array.from({ length: 30 }, (_, i) => request(batch * 30 + i)))).every(status => status === 200));
    assert.equal(await request(601), 429);
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

test('bounded concurrent listeners drain started handlers before retry and leave unstarted messages pending',{timeout:15000},async t=>{
  const f=await fixture(),stop=new AbortController();let releaseSecond!:()=>void,startedBoth!:()=>void,releaseFirstContact!:()=>void;
  const secondGate=new Promise<void>(resolve=>{releaseSecond=resolve;}),both=new Promise<void>(resolve=>{startedBoth=resolve;}),firstContact=new Promise<void>(resolve=>{releaseFirstContact=resolve;});
  const started:number[]=[],finished:number[]=[];let active=0,maximum=0,settled=false;
  const deadline=setTimeout(()=>{stop.abort();releaseSecond();startedBoth();releaseFirstContact();},10000);
  try{
    const a=await f.client('Concurrent A'),b=await f.client('Concurrent B'),contact=await f.connect(a,b);
    for(const index of [1,2,3])await a.send(b.agentId,contact,{index});
    await b.poll();let contacts=0;const readContacts=b.contacts.bind(b);
    t.mock.method(b,'contacts',async()=>{
      const order=++contacts,result=await readContacts();
      if(order===1)await firstContact;
      return result;
    });
    const listening=b.listen(async message=>{
      const index=(message.content as {index:number}).index;
      started.push(index);maximum=Math.max(maximum,++active);
      if(index===2)releaseFirstContact();
      if(started.length===2)startedBoth();
      try{
        if(index===1){await both;throw new Error('Synthetic handler failure');}
        await secondGate;finished.push(index);
      }finally{active--;}
    },stop.signal,{concurrency:2});
    const observed=listening.then(()=>{settled=true;},error=>{settled=true;throw error;});
    const rejected=assert.rejects(observed,/Synthetic handler failure/);
    await both;await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(started,[2,1],'Independent contact readbacks may finish out of send order');assert.equal(maximum,2);assert.equal(settled,false,'A rejected handler must not release the listener while a sibling still runs');
    releaseSecond();await rejected;
    assert.deepEqual(finished,[2]);assert.deepEqual(started,[2,1]);
    assert.deepEqual((await b.pending()).map(message=>(message.content as {index:number}).index),[1,3]);
  }finally{clearTimeout(deadline);stop.abort();releaseSecond();startedBoth();releaseFirstContact();await f.close();}
});

test('a free listener slot receives later arrivals without waiting for an earlier handler or repeating it',{timeout:15000},async()=>{
  const f=await fixture(),stop=new AbortController();
  let releaseFirst!:()=>void,enteredFirst!:()=>void,enteredSecond!:()=>void,enteredThird!:()=>void;
  const firstGate=new Promise<void>(r=>{releaseFirst=r;}),first=new Promise<void>(r=>{enteredFirst=r;}),second=new Promise<void>(r=>{enteredSecond=r;}),third=new Promise<void>(r=>{enteredThird=r;});
  const within=async(promise:Promise<void>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('A later message was blocked by an active handler')),3000);})]);}finally{clearTimeout(timer);}};
  const seen:number[]=[],errors:unknown[]=[];let active=0,maximum=0,listening:Promise<void>|undefined;
  try{
    const a=await f.client('Rolling A'),b=await f.client('Rolling B'),contact=await f.connect(a,b);
    listening=b.listen(async message=>{
      const index=(message.content as {index:number}).index;seen.push(index);maximum=Math.max(maximum,++active);
      try{if(index===1){enteredFirst();await firstGate;}else if(index===2)enteredSecond();else enteredThird();}finally{active--;}
    },stop.signal,{concurrency:2}).catch(error=>{if(!stop.signal.aborted)errors.push(error);});
    await a.send(b.agentId,contact,{index:1});await within(first);
    await a.send(b.agentId,contact,{index:2});await within(second);
    await a.send(b.agentId,contact,{index:3});await within(third);
    assert.deepEqual(seen,[1,2,3]);assert.equal(maximum,2);assert.equal(active,1);assert.deepEqual(errors,[]);
  }finally{stop.abort();releaseFirst();await listening;await f.close();}
});

test('handler failure wakes an active receive and retains the exact message for a non-overlapping retry',{timeout:15000},async()=>{
  const f=await fixture(),stop=new AbortController();let rejectHandler!:(error:Error)=>void,enteredHandler!:()=>void,enteredPoll!:()=>void,polls=0,calls=0;
  const handlerGate=new Promise<void>((_,reject)=>{rejectHandler=reject;}),entered=new Promise<void>(r=>{enteredHandler=r;}),polling=new Promise<void>(r=>{enteredPoll=r;});
  const failure=new Error('Synthetic rolling handler failure');let observed:unknown,listening:Promise<void>|undefined;
  const within=async(promise:Promise<void>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Listener did not react to its handler')),3000);})]);}finally{clearTimeout(timer);}};
  try{
    const a=await f.client('Failure A'),b=await f.client('Failure B',async(input,init)=>{
      if(String(input).endsWith('/v1/inbox?wait=25')&&++polls===2)enteredPoll();
      return fetch(input,init);
    }),contact=await f.connect(a,b);
    listening=b.listen(async()=>{calls++;enteredHandler();await handlerGate;},stop.signal,{concurrency:2}).catch(error=>{observed=error;});
    const sent=await a.send(b.agentId,contact,{index:1});await within(entered);await within(polling);
    rejectHandler(failure);await within(listening);
    assert.equal(observed,failure);assert.equal(calls,1);assert.deepEqual((await b.pending()).map(message=>message.id),[sent.id]);
    const retry=new AbortController();
    await b.listen(async message=>{assert.equal(message.id,sent.id);calls++;retry.abort();},retry.signal,{concurrency:2}).catch(error=>{if(!retry.signal.aborted)throw error;});
    assert.equal(calls,2);assert.deepEqual(await b.pending(),[]);
  }finally{stop.abort();rejectHandler(failure);await listening;await f.close();}
});
