import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { RelayStore } from '../packages/relay/store.js';
import { importRelaySnapshot } from '../packages/relay/postgres-import.js';
import { PostgresRelayStore } from '../packages/relay/postgres-store.js';
import { RELAY_PROTOCOL, type Envelope, RelayError, sha256 } from '../packages/relay/contracts.js';
import { createRelayApp } from '../apps/relay/app.js';
import { readRelayConfig } from '../apps/relay/config.js';
import { RelayClient } from '../packages/agent-transport/client.js';

// Set these only for a dedicated disposable test database. No application data
// is read, and the uniquely named test schema is removed after the test.
const enabled = process.env.EIGOS_TEST_RELAY_POSTGRES === '1';
const fileDigest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
test('offline Relay import preserves queued data, uniqueness and sequence, and refuses an existing target', { skip: !enabled }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-pg-import-'));
  const path = join(dir, 'relay.sqlite');
  const initial = new RelayStore(path); initial.close();
  const db = new DatabaseSync(path);
  db.exec(`INSERT INTO relay_agents VALUES ('a','owner','card-a','{}','hash-a','active',2000000000000,1000000000000),('b','owner','card-b','{}','hash-b','active',2000000000000,1000000000000);
    INSERT INTO relay_connections VALUES ('connection','a','b','accepted',1000000000000);
    INSERT INTO relay_messages VALUES (27,'message','a','b','connection','digest','ciphertext',10,'queued',2000000000000,1000000000000);
    INSERT INTO relay_proofs VALUES ('a','proof',2000000000000);
    INSERT INTO relay_limits VALUES ('node:a',1234567890,7),('large-bucket',9007199254740993,2);
    INSERT INTO relay_commands VALUES ('owner','register','request-1','fingerprint','{}',1000000000000);`);
  db.exec('PRAGMA journal_mode=DELETE'); db.close();
  const schema = `eigos_relay_test_${randomBytes(8).toString('hex')}`;
  const ca = process.env.EIGOS_TEST_PG_CA_FILE;
  const local = process.env.EIGOS_TEST_PG_LOCAL === '1';
  if (local && process.env.PGHOST !== '127.0.0.1') throw new Error('Local test mode requires 127.0.0.1');
  if (!local && !ca) throw new Error('EIGOS_TEST_PG_CA_FILE is required');
  const ssl = local ? false : { ca: readFileSync(ca!, 'utf8'), rejectUnauthorized: true };
  const client = new pg.Client({ ssl, connectionTimeoutMillis: 15000 });
  let connected = false, imported = false;
  try {
    await client.connect(); connected = true;
    const counts = await importRelaySnapshot(client, path, schema, fileDigest(path)); imported = true;
    assert.deepEqual(counts, { relay_agents: 2, relay_commands: 1, relay_proofs: 1, relay_limits: 2, relay_connections: 1, relay_messages: 1 });
    const receipt = (await client.query(`SELECT body FROM "${schema}".relay_migration_receipt WHERE slot=1`)).rows[0].body;
    assert.equal(receipt.status,'imported-not-activated'); assert.equal(receipt.sourceFileDigest,fileDigest(path));
    assert.equal(receipt.tables.relay_messages.rows,1); assert.match(receipt.tables.relay_messages.digest,/^[a-f0-9]{64}$/);
    await assert.rejects(client.query(`DELETE FROM "${schema}".relay_migration_receipt`), /immutable/);
    await assert.rejects(importRelaySnapshot(client,path,`${schema}_digest`,'0'.repeat(64)), /digest does not match/);
    assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[`${schema}_digest`])).rowCount,0);
    const selected = await client.query(`SELECT seq, envelope, expires_at FROM "${schema}".relay_messages`);
    assert.deepEqual(selected.rows[0], { seq: '27', envelope: 'ciphertext', expires_at: '2000000000000' });
    const exactInteger = await client.query(`SELECT bucket FROM "${schema}".relay_limits WHERE subject='large-bucket'`);
    assert.equal(exactInteger.rows[0].bucket, '9007199254740993');
    await assert.rejects(importRelaySnapshot(client, path, schema, fileDigest(path)), /already exists/);
    await assert.rejects(client.query(`INSERT INTO "${schema}".relay_messages (id,sender,recipient,connection_id,digest,envelope,bytes,state,expires_at,created_at) VALUES ('message','a','b','connection','new','x',1,'queued',2000000000000,1000000000000)`), /unique constraint/i);
    const next = await client.query(`INSERT INTO "${schema}".relay_messages (id,sender,recipient,connection_id,digest,envelope,bytes,state,expires_at,created_at) VALUES ('message2','a','b','connection','new','x',1,'queued',2000000000000,1000000000000) RETURNING seq`);
    assert.equal(next.rows[0].seq, '29'); // the failed insert consumes 28, but may not reuse 27
    const pool = new pg.Pool({ ssl, max: 4 });
    let clock = 1800000000000;
    const store = new PostgresRelayStore(pool, schema, () => clock);
    try {
      const shadow = await pool.connect();
      try { await shadow.query('CREATE TEMP TABLE relay_agents(id TEXT)'); } finally { shadow.release(); }
      assert.equal((await store.publicAgent('a')).signedCard, 'card-a');
      // Saturate the shared ingress bucket without 2,048 network round trips.
      const bucket = Math.floor(1800000000000 / 60000);
      await client.query(`INSERT INTO "${schema}".relay_limits SELECT 'ingress:test-' || n, $1, 1 FROM generate_series(1,2048) n`, [bucket]);
      await assert.rejects(store.rateIngress('new-client'), error => error instanceof RelayError && error.code === 'RATE_LIMITED');
      await client.query(`DELETE FROM "${schema}".relay_limits WHERE subject='ingress:test-1'`);
      await client.query(`INSERT INTO "${schema}".relay_limits VALUES ($1,$2,1)`, ['ingress:' + sha256('test-1'), bucket]);
      await store.rateIngress('test-1');
      await client.query(`DELETE FROM "${schema}".relay_limits WHERE subject LIKE 'ingress:%'`);
      const leases = await Promise.all([store.acquirePoll('b'), store.acquirePoll('b')]);
      await assert.rejects(store.acquirePoll('b'), error => error instanceof RelayError && error.code === 'POLL_LIMIT');
      await Promise.all(leases.map(lease => store.releasePoll(lease)));
      const envelope: Envelope = { version: RELAY_PROTOCOL, id: 'concurrent-message', senderId: 'a', recipientId: 'b', connectionId: 'connection', createdAt: 1800000000000, expiresAt: 1800000010000, ciphertext: 'x'.repeat(100) };
      const [first, second] = await Promise.all([store.send('a', envelope, 'signed-envelope'), store.send('a', envelope, 'signed-envelope')]);
      assert.deepEqual(first, second); assert.equal(first.status, 'queued');
      assert.equal((await store.inbox('b')).filter(item => item.receipt.id === envelope.id).length, 1);
      const expiring = { ...envelope, id: 'expiring-message', expiresAt: clock + 100 };
      await store.send('a', expiring, 'short-lived-envelope'); clock += 101;
      assert.equal((await store.inbox('b')).some(item => item.receipt.id === expiring.id), false);
      assert.equal((await store.messageReceipt('a', 'a', expiring.id)).status, 'expired');
      await store.consumeProof('a', 'fresh-proof', 1800000060000);
      await assert.rejects(store.consumeProof('a', 'fresh-proof', 1800000060000), error => error instanceof RelayError && error.code === 'DPOP_PROOF_REPLAY');
      await store.respondContact('b', 'connection', 'revoke');
      assert.equal((await store.messageReceipt('a', 'a', envelope.id)).status, 'revoked');
      await assert.rejects(store.send('a', { ...envelope, id: 'after-revoke' }, 'new-envelope'), error => error instanceof RelayError && error.code === 'CONTACT_NOT_ACCEPTED');
    } finally { await store.close(); }
    // Exercise actual HTTP authentication, signatures and client delivery against
    // PostgreSQL, not only the storage class directly.
    const httpPool = new pg.Pool({ ssl, max: 4 });
    const httpStore = new PostgresRelayStore(httpPool, schema);
    const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const config = readRelayConfig({ EIGOS_RELAY_AUTH_MODE: 'development', EIGOS_RELAY_DEV_TOKEN: 'x'.repeat(32), EIGOS_RELAY_PUBLIC_URL: baseUrl, EIGOS_RELAY_DATABASE_PATH: path });
    const app = createRelayApp(config, { store: httpStore, trustedIngressAddress: '203.0.113.8', verifyOwner: async () => ({ issuer: 'fixture', tenant: 'test', subject: 'owner' }) });
    server.on('request', app.app);
    const a = await RelayClient.open({ baseUrl, credentialPath: join(dir, 'a.json'), displayName: 'A' });
    const b = await RelayClient.open({ baseUrl, credentialPath: join(dir, 'b.json'), displayName: 'B' });
    try {
      await a.register('fixture-token'); await b.register('fixture-token');
      const contact = await a.requestContact(b.agentId); await b.respondContact(contact.id, 'accept');
      const messageId = randomUUID(); const delivered = await a.send(b.agentId, contact.id, { hello: 'synthetic' }, { id: messageId });
      assert.equal(delivered.status, 'queued'); assert.equal((await a.deliver(messageId)).id, messageId);
      assert.deepEqual((await b.poll()).map(item => item.content), [{ hello: 'synthetic' }]);
      assert.equal((await a.receipt(a.agentId, messageId)).status, 'received');
      await b.respondContact(contact.id, 'revoke');
      await assert.rejects(a.send(b.agentId, contact.id, { hello: 'after revoke' }), error => error instanceof RelayError && error.code === 'CONTACT_NOT_ACCEPTED');
    } finally { a.close(); b.close(); app.stop(); server.close(); await once(server, 'close'); await httpStore.close(); }
    // A lost COMMIT response may follow a successful server-side commit.
    // The caller must inspect that schema instead of assuming rollback.
    const uncertainSchema = `${schema}_uncertain`;
    let observedCommitted = false;
    try {
      const disconnected = { query: async (sql: string, params?: unknown[]) => {
        const value = await client.query(sql, params);
        if (sql === 'COMMIT') throw new Error('simulated lost commit response');
        return value;
      } } as unknown as pg.Client;
      await assert.rejects(importRelaySnapshot(disconnected, path, uncertainSchema, fileDigest(path)), /commit outcome is unknown/);
      observedCommitted = (await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [uncertainSchema])).rowCount === 1;
      assert(observedCommitted);
      assert.equal((await client.query(`SELECT body FROM "${uncertainSchema}".relay_migration_receipt`)).rows[0].body.sourceFileDigest,fileDigest(path));
    } finally { if (observedCommitted) await client.query(`DROP SCHEMA "${uncertainSchema}" CASCADE`); }
    const changed = join(dir,'changed.sqlite'); copyFileSync(path,changed);
    const changedDigest = fileDigest(changed), changedSchema = `${schema}_changed`;
    const changingClient = { query: async (sql: string, params?: unknown[]) => {
      const value = await client.query(sql,params);
      if (sql.startsWith('SELECT setval(')) appendFileSync(changed,Buffer.from([0]));
      return value;
    } } as unknown as pg.Client;
    await assert.rejects(importRelaySnapshot(changingClient,changed,changedSchema,changedDigest), /snapshot changed/);
    assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[changedSchema])).rowCount,0);
    for (const [label, expression] of [['nul', "'bad' || char(0) || 'tail'"], ['utf8', "CAST(x'80' AS TEXT)"]] as const) {
      const invalidPath = join(dir,`${label}.sqlite`); copyFileSync(path,invalidPath);
      const invalid = new DatabaseSync(invalidPath); invalid.exec(`UPDATE relay_agents SET signed_card=${expression} WHERE id='a'; PRAGMA journal_mode=DELETE;`); invalid.close();
      const invalidSchema = `${schema}_${label}`;
      await assert.rejects(importRelaySnapshot(client,invalidPath,invalidSchema,fileDigest(invalidPath)),/Invalid Relay text/);
      assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[invalidSchema])).rowCount,0);
    }
    const batchPath = join(dir,'batch.sqlite'); copyFileSync(path,batchPath);
    const batchDb = new DatabaseSync(batchPath); batchDb.exec('BEGIN');
    const addCommand = batchDb.prepare('INSERT INTO relay_commands VALUES(?,?,?,?,?,?)');
    for (let i=0;i<130;i++) addCommand.run(`owner-${i}`,'register',`request-${i}`,'fingerprint','{}',1000);
    for (const actor of ['a','ä','😀','\uE000']) addCommand.run(actor,'register','unicode','fingerprint','{}',1000);
    batchDb.exec('COMMIT; PRAGMA journal_mode=DELETE'); batchDb.close();
    const batchSchema = `${schema}_batch`;
    try {
      const batchCounts = await importRelaySnapshot(client,batchPath,batchSchema,fileDigest(batchPath));
      assert.equal(batchCounts.relay_commands,135);
      assert.equal((await client.query(`SELECT body FROM "${batchSchema}".relay_migration_receipt`)).rows[0].body.tables.relay_commands.rows,135);
    } finally { await client.query(`DROP SCHEMA IF EXISTS "${batchSchema}" CASCADE`); }
    const largePath = join(dir,'large.sqlite'); copyFileSync(path,largePath);
    const largeDb = new DatabaseSync(largePath); largeDb.prepare("UPDATE relay_agents SET signed_card=? WHERE id='a'").run('x'.repeat(2*1024*1024)); largeDb.exec('PRAGMA journal_mode=DELETE'); largeDb.close();
    const largeSchema = `${schema}_large`;
    await assert.rejects(importRelaySnapshot(client,largePath,largeSchema,fileDigest(largePath)),/Relay row exceeds migration limit/);
    assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[largeSchema])).rowCount,0);
    const utf16Path = join(dir,'utf16.sqlite');
    const utf16Init = new DatabaseSync(utf16Path); utf16Init.exec("PRAGMA encoding='UTF-16le'; CREATE TABLE init(id INTEGER); DROP TABLE init"); utf16Init.close(); chmodSync(utf16Path,0o600);
    const utf16Store = new RelayStore(utf16Path); utf16Store.close();
    const utf16 = new DatabaseSync(utf16Path); utf16.exec('PRAGMA journal_mode=DELETE'); utf16.close();
    const utf16Schema = `${schema}_utf16`;
    await assert.rejects(importRelaySnapshot(client,utf16Path,utf16Schema,fileDigest(utf16Path)),/UTF-8 encoding/);
    assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[utf16Schema])).rowCount,0);
    const corrupt = join(dir, 'corrupt.sqlite');
    const broken = new RelayStore(corrupt); broken.close();
    const brokenDb = new DatabaseSync(corrupt, { enableForeignKeyConstraints: false });
    brokenDb.exec("INSERT INTO relay_connections VALUES ('bad','missing-a','missing-b','accepted',1); PRAGMA journal_mode=DELETE;");
    brokenDb.close();
    const rejectedSchema = `${schema}_bad`;
    await assert.rejects(importRelaySnapshot(client, corrupt, rejectedSchema, fileDigest(corrupt)), /foreign key constraint/i);
    const rolledBack = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [rejectedSchema]);
    assert.equal(rolledBack.rowCount, 0);
  } finally {
    if (connected && imported) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end(); rmSync(dir, { recursive: true, force: true });
  }
});
