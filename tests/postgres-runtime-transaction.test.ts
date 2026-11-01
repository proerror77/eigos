import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
const clientOptions = () => process.env.EIGOS_TEST_PG_CA_FILE ? { ssl: { ca: readFileSync(process.env.EIGOS_TEST_PG_CA_FILE, 'utf8'), rejectUnauthorized: true } } : {};
import { postgresBusinessTransaction } from '../packages/postgres/runtime-transaction.js';
import { installPostgresAuthorityLock } from '../packages/postgres/authority-lock.js';

test('PostgreSQL business mutations fence authority, roll back and report uncertain commits', { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
  const client = new pg.Client(clientOptions()); await client.connect();
  const schema = `eigos_business_${randomUUID().replaceAll('-','')}`;
  const authority = { id: randomUUID(), revision: 1, digest: 'a'.repeat(64) };
  try {
    await client.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".runtime_authority(slot BIGINT PRIMARY KEY,id TEXT,revision BIGINT,configuration_digest TEXT); CREATE TABLE "${schema}".example(id BIGINT PRIMARY KEY,value BIGINT)`);
    await client.query(`INSERT INTO "${schema}".runtime_authority VALUES(1,$1,$2,$3)`, [authority.id,authority.revision,authority.digest]);
    await installPostgresAuthorityLock(client, schema);
    await postgresBusinessTransaction(client,schema,authority,async c => { await c.query('INSERT INTO example VALUES(1,10)'); });
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,async c => {
      await c.query('UPDATE example SET value=20'); await c.query("UPDATE runtime_authority SET configuration_digest='changed'");
    }), /authority changed/);
    assert.equal((await client.query(`SELECT value FROM "${schema}".example`)).rows[0].value,'10');
    const mutable = { ...authority };
    await assert.rejects(postgresBusinessTransaction(client,schema,mutable,async c => { await c.query("UPDATE runtime_authority SET configuration_digest=$1", ['b'.repeat(64)]); mutable.digest='b'.repeat(64); }), /authority changed/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,async c => postgresBusinessTransaction(c,schema,authority,async () => undefined)), /Nested/);
    await assert.rejects(postgresBusinessTransaction(client,schema,{...authority,digest:'b'.repeat(64)},async () => undefined), /authority changed/);
    const uncertain = { query: async (sql: string, values?: unknown[]) => { const result = await client.query(sql,values); if (sql === 'COMMIT') throw new Error('lost response'); return result; } } as unknown as pg.Client;
    await assert.rejects(postgresBusinessTransaction(uncertain,schema,authority,async c => { await c.query('UPDATE example SET value=30'); }), /commit outcome is unknown/);
    assert.equal((await client.query(`SELECT value FROM "${schema}".example`)).rows[0].value,'30');
  } finally { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end(); }
});

test('concurrent PostgreSQL writers cannot silently lose an update', { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
  const first = new pg.Client(clientOptions()), second = new pg.Client(clientOptions()); await first.connect(); await second.connect();
  const schema = `eigos_business_${randomUUID().replaceAll('-','')}`, authority = { id: randomUUID(), revision: 1, digest: 'a'.repeat(64) };
  try {
    await first.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".runtime_authority(slot BIGINT PRIMARY KEY,id TEXT,revision BIGINT,configuration_digest TEXT); CREATE TABLE "${schema}".example(id BIGINT PRIMARY KEY,value BIGINT)`);
    await first.query(`INSERT INTO "${schema}".runtime_authority VALUES(1,$1,$2,$3)`, [authority.id,authority.revision,authority.digest]);
    await installPostgresAuthorityLock(first, schema);
    await first.query(`INSERT INTO "${schema}".example VALUES(1,0)`);
    const write = (client: pg.Client) => postgresBusinessTransaction(client,schema,authority,async c => {
      const n = BigInt((await c.query('SELECT value FROM example WHERE id=1')).rows[0].value);
      await c.query('SELECT pg_sleep(0.1)'); await c.query('UPDATE example SET value=$1 WHERE id=1', [(n+1n).toString()]);
    });
    const outcomes = await Promise.allSettled([write(first),write(second)]);
    const successful = outcomes.filter(result => result.status === 'fulfilled').length;
    assert(successful >= 1);
    assert.equal(Number((await first.query(`SELECT value FROM "${schema}".example`)).rows[0].value),successful);
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert.match(String(outcome.reason), /serializ|commit outcome is unknown/i);
  } finally { await first.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await first.end(); await second.end(); }
});

test('transaction discards connections when rollback or commit responses fail', async () => {
  const authority = { id: 'authority', revision: 1, digest: 'a'.repeat(64) };
  for (const failure of ['ROLLBACK','COMMIT']) {
    let discarded = false;
    const client = {
      query: async (sql: string) => {
        if (sql === failure) throw new Error('connection failed');
        if (sql.startsWith('SELECT id,revision')) return { rowCount: 1, rows: [{ id: authority.id, revision: '1', configuration_digest: authority.digest }] };
        return { rowCount: 0, rows: [] };
      },
      end: async () => { discarded = true; },
    } as unknown as pg.Client;
    await assert.rejects(postgresBusinessTransaction(client,'eigos_business_fixture',authority,async () => { if (failure === 'ROLLBACK') throw new Error('action failed'); }), failure === 'ROLLBACK' ? /rollback failed/ : /commit outcome is unknown/);
    assert.equal(discarded,true);
  }
});

test('pooled connection is evicted after a failed rollback', async () => {
  let evicted = false;
  const authority = { id: 'authority', revision: 1, digest: 'a'.repeat(64) };
  const client = {
    query: async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('lost connection');
      if (sql.startsWith('SELECT id,revision')) return { rowCount: 1, rows: [{ id: authority.id, revision: '1', configuration_digest: authority.digest }] };
      return { rowCount: 0, rows: [] };
    },
    release: (error?: Error) => { evicted = error instanceof Error; },
  } as unknown as pg.Client;
  await assert.rejects(postgresBusinessTransaction(client,'eigos_business_fixture',authority,async () => { throw new Error('action failed'); }), /rollback failed/);
  assert.equal(evicted,true);
});

test('restricted runtime can lock authority without reading or updating its table', { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' || !!process.env.EIGOS_TEST_PG_CA_FILE }, async () => {
  const admin = new pg.Client(clientOptions()); await admin.connect();
  const suffix = randomUUID().replaceAll('-',''), schema = `eigos_business_${suffix}`, role = `eigos_test_${suffix}`, authority = { id: randomUUID(), revision: 1, digest: 'a'.repeat(64) };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".runtime_authority(slot BIGINT PRIMARY KEY,id TEXT,revision BIGINT,configuration_digest TEXT); CREATE TABLE "${schema}".example(id BIGINT PRIMARY KEY,value BIGINT); CREATE ROLE "${role}" NOLOGIN`);
    await admin.query(`INSERT INTO "${schema}".runtime_authority VALUES(1,$1,$2,$3)`, [authority.id,authority.revision,authority.digest]);
    await admin.query(`INSERT INTO "${schema}".example VALUES(1,0)`);
    await installPostgresAuthorityLock(admin,schema);
    assert.equal((await admin.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed', [role, `"${schema}".eigos_lock_runtime_authority()`])).rows[0].allowed,false);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"; GRANT EXECUTE ON FUNCTION "${schema}".eigos_lock_runtime_authority() TO "${role}"; GRANT SELECT,UPDATE ON "${schema}".example TO "${role}"; SET ROLE "${role}"`);
    const privileges = await admin.query('SELECT has_table_privilege(current_user,$1,\'SELECT\') AS can_read, has_table_privilege(current_user,$1,\'UPDATE\') AS can_update', [`"${schema}".runtime_authority`]);
    assert.equal(privileges.rows[0].can_read,false); assert.equal(privileges.rows[0].can_update,false);
    await assert.rejects(admin.query(`SELECT * FROM "${schema}".runtime_authority`), /permission denied/);
    await admin.query('CREATE TEMP TABLE runtime_authority(slot BIGINT, id TEXT, revision BIGINT, configuration_digest TEXT)');
    await postgresBusinessTransaction(admin,schema,authority,async c => { await c.query('UPDATE example SET value=1'); });
    assert.equal((await admin.query(`SELECT value FROM "${schema}".example`)).rows[0].value,'1');
    await assert.rejects(admin.query(`UPDATE "${schema}".runtime_authority SET revision=2`), /permission denied/);
  } finally { await admin.query('RESET ROLE'); await admin.query('DROP TABLE IF EXISTS pg_temp.runtime_authority'); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP ROLE IF EXISTS "${role}"`); await admin.end(); }
});
