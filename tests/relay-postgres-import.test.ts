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
import { idleRelayFixture } from './fixtures/relay-idle.js';
import { MemoryRelayNotifications, type RelayNotifications } from '../packages/relay/notifications.js';

// Set these only for a dedicated disposable test database. No application data
// is read, and the uniquely named test schema is removed after the test.
const enabled = process.env.EIGOS_TEST_RELAY_POSTGRES === '1';
const fileDigest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('idle Relay uses committed PG facts with bounded wire statements and recoverable notifications', { skip: !enabled, timeout: 180000 }, async t => {
  await t.test('four real wire statements, with no connection or transaction held during the wait', async () => {
    const memory = new MemoryRelayNotifications(); let ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const channel: RelayNotifications = { snapshot: () => memory.snapshot(), notify: () => memory.notify(), wait: (...args) => { ready(); return memory.wait(...args); } };
    const f = await idleRelayFixture(channel);
    try {
      const node = await f.client('idle'); f.wire.length = 0;
      const response = f.request(node, 1); await waiting;
      assert.equal(f.wire.length, 3);
      const sessions = (await f.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE application_name=$1', [f.schema])).rows;
      assert(sessions.length > 0); assert(sessions.every(row => row.state === 'idle' && row.xact_start === null));
      assert.deepEqual(await (await response).json(), { items: [] });
      assert.equal(f.wire.length, 4);
      assert(f.wire.every(sql => /^SELECT /.test(sql) && !sql.includes(';')));
      assert.equal(3 * (86400 / 25) * f.wire.length, 41472);
    } finally { await f.close(); }
  });
  await t.test('commit between first read and wait registration wakes, preserves queued receipt, and survives restart', async () => {
    const memory = new MemoryRelayNotifications(); let between: (() => Promise<void>) | undefined;
    const channel: RelayNotifications = { snapshot: () => memory.snapshot(), notify: () => memory.notify(), wait: async (...args) => { await between?.(); await memory.wait(...args); } };
    const f = await idleRelayFixture(channel);
    try {
      const a = await f.client('sender'), b = await f.client('recipient'), connection = await f.connect(a, b); let id = '';
      between = async () => { between = undefined; id = await f.externallySend(a, b, connection); await memory.notify(); };
      const started = Date.now();
      const result = await (await f.request(b, 25)).json() as { items: { receipt: { id: string } }[] };
      assert(Date.now() - started < 10000, 'A registered revision must wake before the 25-second fallback');
      assert.equal(result.items[0]?.receipt.id, id);
      assert.equal((await f.external.messageReceipt(a.agentId, a.agentId, id)).status, 'queued');
      await f.restart();
      assert.deepEqual((await b.poll()).map(item => item.content), [{ fixture: 'external-commit' }]);
      assert.equal((await f.external.messageReceipt(a.agentId, a.agentId, id)).status, 'received');
      await b.markHandled(a.agentId, id); assert.deepEqual(await b.poll(), []);
    } finally { await f.close(); }
  });
  await t.test('a false hint supplies no facts and a queued message that expires before the final read is withheld', async () => {
    const memory = new MemoryRelayNotifications(); let between: (() => Promise<void>) | undefined;
    const channel: RelayNotifications = { snapshot: () => memory.snapshot(), notify: () => memory.notify(), wait: async (...args) => { await between?.(); await memory.wait(...args); } };
    const f = await idleRelayFixture(channel);
    try {
      const a = await f.client('sender'), b = await f.client('recipient'), connection = await f.connect(a, b);
      between = () => memory.notify();
      assert.deepEqual(await (await f.request(b, 25)).json(), { items: [] });
      let id = '';
      between = async () => { id = await f.externallySend(a, b, connection, Date.now() + 1000); f.advance(2000); await memory.notify(); };
      assert.deepEqual(await (await f.request(b, 25)).json(), { items: [] });
      assert.equal((await f.external.messageReceipt(a.agentId, a.agentId, id)).status, 'expired');
    } finally { await f.close(); }
  });
  await t.test('revocation committed while final read waits for the table lock prevents delivery', async () => {
    const memory = new MemoryRelayNotifications(); let ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const f = await idleRelayFixture({ snapshot: () => memory.snapshot(), notify: () => memory.notify(), wait: (...args) => { ready(); return memory.wait(...args); } });
    try {
      const node = await f.client('revoked'); const response = f.request(node, 25); await waiting;
      await f.admin.query('BEGIN'); await f.admin.query(`LOCK TABLE "${f.schema}".relay_agents IN EXCLUSIVE MODE`);
      await memory.notify();
      await f.admin.query(`UPDATE "${f.schema}".relay_agents SET state='revoked' WHERE id=$1`, [node.agentId]); await f.admin.query('COMMIT');
      const revoked = await response; assert.equal(revoked.status, 401); assert.deepEqual(await revoked.json(), { error: 'AGENT_REVOKED_OR_EXPIRED' });
      assert.equal((await f.admin.query(`SELECT count(*)::int AS n FROM "${f.schema}".relay_poll_leases`)).rows[0].n, 0);
    } finally { await f.close(); }
  });
  await t.test('expiry during wait fails closed and releases its lease', async () => {
    const memory = new MemoryRelayNotifications(); let f: Awaited<ReturnType<typeof idleRelayFixture>>;
    f = await idleRelayFixture({ snapshot: () => memory.snapshot(), notify: () => memory.notify(), wait: async () => { f.advance(86400001); await memory.notify(); } });
    try {
      const node = await f.client('expires'); const expired = await f.request(node, 25);
      assert.equal(expired.status, 401); assert.equal((await f.admin.query(`SELECT count(*)::int AS n FROM "${f.schema}".relay_poll_leases`)).rows[0].n, 0);
    } finally { await f.close(); }
  });
  await t.test('proof replay, node rate, concurrent polls, and abandoned lease expiry remain enforced', async () => {
    const f = await idleRelayFixture();
    try {
      const node = await f.client('limited'), headers = await f.headers(node);
      assert.equal((await f.request(node, 0, headers)).status, 200);
      const replay = await f.request(node, 0, headers); assert.equal(replay.status, 401); assert.equal((await replay.json() as { error: string }).error, 'DPOP_PROOF_REPLAY');
      const malformedHeaders=await f.headers(node);
      assert.equal((await fetch(f.baseUrl+'/v1/inbox?wait=26',{headers:malformedHeaders})).status,400);
      assert.equal((await f.request(node,0,malformedHeaders)).status,401);
      await f.admin.query(`INSERT INTO "${f.schema}".relay_poll_leases VALUES($1,$3,$4),($2,$3,$4)`, [randomUUID(), randomUUID(), node.agentId, Date.now() + 120000]);
      const concurrent = await f.request(node, 0); assert.equal(concurrent.status, 429); assert.equal((await concurrent.json() as { error: string }).error, 'POLL_LIMIT');
      await f.admin.query(`UPDATE "${f.schema}".relay_poll_leases SET expires_at=0`);
      assert.equal((await f.request(node, 0)).status, 200);
      f.store.limits.requestsPerMinute = 1; await f.admin.query(`DELETE FROM "${f.schema}".relay_limits WHERE subject=$1`, ['node:' + node.agentId]);
      assert.equal((await f.request(node, 0)).status, 200);
      const limited = await f.request(node, 0); assert.equal(limited.status, 429); assert.equal((await limited.json() as { error: string }).error, 'RATE_LIMITED');
    } finally { await f.close(); }
  });
  for (const target of ['agent', 'message'] as const) for (const phase of ['before-send', 'after-read'] as const) {
    await t.test(`${target} expiry survives a delayed ${phase} final query without another wire statement`, async () => {
      const f = await idleRelayFixture();
      try {
        const a = await f.client('sender'), b = await f.client('recipient'), connection = await f.connect(a, b);
        const original = f.pool.query.bind(f.pool);
        let databaseResult: { error?: string; items?: unknown[] } | undefined;
        // Delay after the store has already captured requested_ms. Real PG
        // still executes the query, and its wire parse/query is still counted.
        f.pool.query = (async (...args: unknown[]) => {
          const text = args[0], values = args[1] as unknown[] | undefined;
          const final = typeof text === 'string' && text.includes('relay_idle_poll') && JSON.parse(String(values?.[0])).finished;
          if (final) {
            if (target === 'message') await f.expiringExternalMessage(a, b, connection);
            else await f.admin.query(`UPDATE "${f.schema}".relay_agents SET expires_at=$2 WHERE id=$1`, [b.agentId, Date.now() + 2000]);
          }
          if (final && phase === 'before-send') await new Promise(resolve => setTimeout(resolve, 2500));
          const result = await Reflect.apply(original, f.pool, args);
          if (final) databaseResult = result.rows[0]?.result;
          if (final && phase === 'after-read') await new Promise(resolve => setTimeout(resolve, 2500));
          return result;
        }) as typeof f.pool.query;
        f.wire.length = 0;
        const response = await f.request(b, 0);
        assert.equal(response.status, target === 'agent' ? 401 : 200);
        assert.deepEqual(await response.json(), target === 'agent' ? { error: 'AGENT_REVOKED_OR_EXPIRED' } : { items: [] });
        if (phase === 'before-send') {
          if (target === 'agent') assert.equal(databaseResult?.error, 'AGENT_REVOKED_OR_EXPIRED');
          else assert.deepEqual(databaseResult?.items, []);
        } else {
          assert.equal(databaseResult?.error, undefined);
          if (target === 'message') assert.equal(databaseResult?.items?.length, 1, 'The delayed reply must test the post-read expiry fence');
        }
        assert.equal(f.wire.length, 4);
        assert.equal((await f.admin.query(`SELECT count(*)::int AS n FROM "${f.schema}".relay_poll_leases`)).rows[0].n, 0);
      } finally { await f.close(); }
    });
  }
  await t.test('an external commit at 35 seconds with all hints lost is recovered by a later final PG read', { timeout: 70000 }, async () => {
    const f = await idleRelayFixture(); let write: Promise<string> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const a = await f.client('sender'), b = await f.client('recipient'), connection = await f.connect(a, b);
      const queued = await f.prepareExternal(a, b, connection);
      const committed = new Promise<string>((resolve, reject) => { timer = setTimeout(() => { write = queued.commit(); write.then(resolve, reject); }, 35000); });
      void committed.catch(() => {});
      const first = await f.request(b, 25); assert.deepEqual(await first.json(), { items: [] });
      f.wire.length = 0;
      const second = await f.request(b, 25), id = await committed;
      const body = await second.json() as { items: { receipt: { id: string } }[] };
      assert.equal(body.items[0]?.receipt.id, id); assert.equal(f.wire.length, 4);
      assert.equal((await f.external.messageReceipt(a.agentId, a.agentId, id)).status, 'queued');
    } finally { if (timer) clearTimeout(timer); await write; await f.close(); }
  });
});

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
