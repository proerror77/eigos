import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { RelayStore } from '../packages/relay/store.js';
import { importRelaySnapshot } from '../packages/relay/postgres-import.js';

// Set these only for a dedicated disposable test database. No application data
// is read, and the uniquely named test schema is removed after the test.
const enabled = process.env.EIGOS_TEST_RELAY_POSTGRES === '1';
test('offline Relay import preserves queued data, uniqueness and sequence, and refuses an existing target', { skip: !enabled }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-pg-import-'));
  const path = join(dir, 'relay.sqlite');
  const initial = new RelayStore(path); initial.close();
  const db = new DatabaseSync(path);
  db.exec(`INSERT INTO relay_agents VALUES ('a','owner','card-a','{}','hash-a','active',2000000000000,1000000000000),('b','owner','card-b','{}','hash-b','active',2000000000000,1000000000000);
    INSERT INTO relay_connections VALUES ('connection','a','b','accepted',1000000000000);
    INSERT INTO relay_messages VALUES (27,'message','a','b','connection','digest','ciphertext',10,'queued',2000000000000,1000000000000);
    INSERT INTO relay_proofs VALUES ('a','proof',2000000000000);`);
  db.exec('PRAGMA journal_mode=DELETE'); db.close();
  const schema = `eigos_relay_test_${randomBytes(8).toString('hex')}`;
  const ca = process.env.EIGOS_TEST_PG_CA_FILE;
  if (!ca) throw new Error('EIGOS_TEST_PG_CA_FILE is required');
  const client = new pg.Client({ ssl: { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
  let connected = false;
  try {
    await client.connect(); connected = true;
    const counts = await importRelaySnapshot(client, path, schema);
    assert.equal(counts.relay_agents, 2); assert.equal(counts.relay_messages, 1); assert.equal(counts.relay_proofs, 1);
    const selected = await client.query(`SELECT seq, envelope, expires_at FROM "${schema}".relay_messages`);
    assert.deepEqual(selected.rows[0], { seq: '27', envelope: 'ciphertext', expires_at: '2000000000000' });
    await assert.rejects(importRelaySnapshot(client, path, schema), /already exists/);
    await assert.rejects(client.query(`INSERT INTO "${schema}".relay_messages (id,sender,recipient,connection_id,digest,envelope,bytes,state,expires_at,created_at) VALUES ('message','a','b','connection','new','x',1,'queued',2000000000000,1000000000000)`), /unique constraint/i);
    const next = await client.query(`INSERT INTO "${schema}".relay_messages (id,sender,recipient,connection_id,digest,envelope,bytes,state,expires_at,created_at) VALUES ('message2','a','b','connection','new','x',1,'queued',2000000000000,1000000000000) RETURNING seq`);
    assert.equal(next.rows[0].seq, '29'); // the failed insert consumes 28, but may not reuse 27
    const corrupt = join(dir, 'corrupt.sqlite');
    const broken = new RelayStore(corrupt); broken.close();
    const brokenDb = new DatabaseSync(corrupt, { enableForeignKeyConstraints: false });
    brokenDb.exec("INSERT INTO relay_connections VALUES ('bad','missing-a','missing-b','accepted',1); PRAGMA journal_mode=DELETE;");
    brokenDb.close();
    const rejectedSchema = `${schema}_bad`;
    await assert.rejects(importRelaySnapshot(client, corrupt, rejectedSchema), /foreign key constraint/i);
    const rolledBack = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [rejectedSchema]);
    assert.equal(rolledBack.rowCount, 0);
  } finally {
    if (connected) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end(); rmSync(dir, { recursive: true, force: true });
  }
});
