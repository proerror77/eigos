import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { RelayStore } from '../packages/relay/store.js';
import { importRelaySnapshot, relayCleanupSql } from '../packages/relay/postgres-import.js';
import { grantImportedRelayRuntime } from '../packages/relay/postgres-grants.js';
import { PostgresRelayStore } from '../packages/relay/postgres-store.js';
import { RELAY_PROTOCOL } from '../packages/relay/contracts.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Relay grant CLI requires an explicit reviewed target without printing connection credentials', () => {
  const path=fileURLToPath(new URL('../scripts/relay-postgres-grant.mjs',import.meta.url)), secret='synthetic-secret-not-for-output';
  const result=spawnSync(process.execPath,[path,'--apply','--source-stopped','--schema','unsafe','--role','unsafe','--source-digest','0'.repeat(64)],{encoding:'utf8',env:{...process.env,EIGOS_RELAY_POSTGRES_URL:`postgresql://user:${secret}@localhost/db`,EIGOS_RELAY_POSTGRES_CA_FILE:'/tmp/ca.pem'}});
  assert.equal(result.status,2);assert(!result.stdout.includes(secret));assert(!result.stderr.includes(secret));
  const missing=spawnSync(process.execPath,[path,'--apply','--schema','eigos_relay_live_aaaaaaaaaaaa','--role','eigos_relay_live_aaaaaaaaaaaa','--source-digest','0'.repeat(64)],{encoding:'utf8'});
  assert.equal(missing.status,2);
  const insecure=spawnSync(process.execPath,[path,'--apply','--source-stopped','--schema','eigos_relay_live_aaaaaaaaaaaa','--role','eigos_relay_live_aaaaaaaaaaaa','--source-digest','0'.repeat(64)],{encoding:'utf8',env:{...process.env,EIGOS_RELAY_POSTGRES_URL:`postgresql://user:${secret}@localhost/db?sslmode=disable`,EIGOS_RELAY_POSTGRES_CA_FILE:'/tmp/ca.pem'}});
  assert.equal(insecure.status,2);assert(!insecure.stdout.includes(secret));assert(!insecure.stderr.includes(secret));
});

test('Relay runtime grant is tied to an unchanged import and excludes unrelated privileges', {skip:process.env.EIGOS_TEST_RELAY_POSTGRES !== '1',timeout:180000}, async () => {
  const directory=mkdtempSync(join(tmpdir(),'relay-grant-')),path=join(directory,'relay.sqlite');
  const initial=new RelayStore(path); initial.close();
  const source=new DatabaseSync(path);
  source.exec(`INSERT INTO relay_agents VALUES('a','synthetic-owner','synthetic-card','{}','hash-a','active',2000000000000,1000000000000),('b','synthetic-owner','second-card','{}','hash-b','active',2000000000000,1000000000000);
    INSERT INTO relay_connections VALUES('connection','a','b','accepted',1000000000000);
    INSERT INTO relay_messages VALUES(27,'message','a','b','connection','digest','ciphertext',10,'queued',2000000000000,1000000000000);
    PRAGMA journal_mode=DELETE`); source.close();
  const digest=createHash('sha256').update(readFileSync(path)).digest('hex'),role=`eigos_relay_test_${randomBytes(8).toString('hex')}`,password=randomBytes(32).toString('hex');
  const local=process.env.EIGOS_TEST_PG_LOCAL==='1',ca=process.env.EIGOS_TEST_PG_CA_FILE;
  if (local && process.env.PGHOST!=='127.0.0.1') throw new Error('Local test mode requires 127.0.0.1');
  if (!local && !ca) throw new Error('EIGOS_TEST_PG_CA_FILE is required');
  const ssl=local?false:{ca:readFileSync(ca!,'utf8'),rejectUnauthorized:true},admin=new pg.Client({ssl,connectionTimeoutMillis:15000});
  let connected=false,createdRole=false,createdSchema=false,createdForeign=false;
  try {
    await admin.connect(); connected=true;
    await admin.query(`CREATE ROLE "${role}" WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);createdRole=true;
    await importRelaySnapshot(admin,path,role,digest);createdSchema=true;
    const usage=async()=> (await admin.query('SELECT has_schema_privilege($1,$2,$3) AS allowed',[role,role,'USAGE'])).rows[0].allowed;
    await admin.query(`CREATE SCHEMA "${role}_foreign"; CREATE TABLE "${role}_foreign".private_data(id int); GRANT USAGE ON SCHEMA "${role}_foreign" TO "${role}"; GRANT SELECT(id) ON "${role}_foreign".private_data TO "${role}"`);createdForeign=true;
    await assert.rejects(grantImportedRelayRuntime(admin,role,role,digest),/outside the target schema/);assert.equal(await usage(),false);
    await admin.query(`DROP SCHEMA "${role}_foreign" CASCADE`);createdForeign=false;
    await assert.rejects(grantImportedRelayRuntime(admin,role,role,'0'.repeat(64)),/receipt/);assert.equal(await usage(),false);
    await admin.query(`UPDATE "${role}".relay_agents SET owner='altered' WHERE id='a'`);
    await assert.rejects(grantImportedRelayRuntime(admin,role,role,digest),/differs/);assert.equal(await usage(),false);
    await admin.query(`UPDATE "${role}".relay_agents SET owner='synthetic-owner' WHERE id='a'`);
    await admin.query(`ALTER TABLE "${role}".relay_agents ALTER COLUMN owner DROP NOT NULL`);
    await assert.rejects(grantImportedRelayRuntime(admin,role,role,digest),/target columns differ/);assert.equal(await usage(),false);
    await admin.query(`ALTER TABLE "${role}".relay_agents ALTER COLUMN owner SET NOT NULL`);
    await admin.query(`ALTER TABLE "${role}".relay_messages DROP CONSTRAINT relay_messages_sender_id_key`);
    await assert.rejects(grantImportedRelayRuntime(admin,role,role,digest),/constraints differ/);assert.equal(await usage(),false);
    await admin.query(`ALTER TABLE "${role}".relay_messages ADD UNIQUE(sender,id)`);
    await admin.query(`ALTER TABLE "${role}".relay_agents DROP CONSTRAINT relay_agents_state_check`);
    await assert.rejects(grantImportedRelayRuntime(admin,role,role,digest),/check constraints differ/);assert.equal(await usage(),false);
    await admin.query(`ALTER TABLE "${role}".relay_agents ADD CHECK(state IN ('active','revoked'))`);
    await admin.query(`DROP TRIGGER relay_migration_receipt_immutable ON "${role}".relay_migration_receipt`);
    await assert.rejects(grantImportedRelayRuntime(admin,role,role,digest),/receipt protection/);assert.equal(await usage(),false);
    await admin.query(`CREATE TRIGGER relay_migration_receipt_immutable BEFORE UPDATE OR DELETE ON "${role}".relay_migration_receipt FOR EACH ROW EXECUTE FUNCTION "${role}".relay_migration_receipt_immutable()`);
    await admin.query(`CREATE OR REPLACE FUNCTION "${role}".relay_cleanup(current_ms bigint,max_message_ms bigint,retention_ms bigint) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = "${role}",pg_catalog,pg_temp AS $$ BEGIN RETURN; END $$`);
    await assert.rejects(grantImportedRelayRuntime(admin,role,role,digest),/target functions/);assert.equal(await usage(),false);
    await admin.query(`DROP FUNCTION "${role}".relay_cleanup(bigint,bigint,bigint); SET search_path TO "${role}",pg_catalog,pg_temp`);
    try {await admin.query(relayCleanupSql);} finally {await admin.query('RESET search_path');}
    await admin.query(`SELECT setval('"${role}".relay_messages_seq_seq',1,false)`);
    await assert.rejects(grantImportedRelayRuntime(admin,role,role,digest),/sequence could reuse/);assert.equal(await usage(),false);
    await admin.query(`SELECT setval('"${role}".relay_messages_seq_seq',27,true)`);
    await admin.query(`GRANT SELECT(body) ON "${role}".relay_migration_receipt TO "${role}"`);
    await assert.rejects(grantImportedRelayRuntime(admin,role,role,digest),/already has table or column privileges/);assert.equal(await usage(),false);
    await admin.query(`REVOKE SELECT(body) ON "${role}".relay_migration_receipt FROM "${role}"`);
    await grantImportedRelayRuntime(admin,role,role,digest);assert.equal(await usage(),true);
    await assert.rejects(grantImportedRelayRuntime(admin,role,role,digest),/already granted/);
    const user=local?role:`${role}.${process.env.PGUSER!.split('.').slice(1).join('.')}`;
    const config={user,password,ssl,connectionTimeoutMillis:15000};
    const db=new pg.Client(config);await db.connect();
    try {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM "${role}".relay_agents`)).rows[0].n,2);
      await assert.rejects(db.query(`SELECT * FROM "${role}".relay_migration_receipt`),/permission denied/i);
      await assert.rejects(db.query(`DELETE FROM "${role}".relay_agents`),/permission denied/i);
      await assert.rejects(db.query(`CREATE TABLE "${role}".unauthorized(id int)`),/permission denied/i);
    } finally {await db.end();}
    const pool=new pg.Pool(config),store=new PostgresRelayStore(pool,role,()=>1800000000000);
    try {
      await store.rateIngress('203.0.113.9');assert.equal((await store.publicAgent('a')).signedCard,'synthetic-card');
      const envelope={version:RELAY_PROTOCOL,id:'new-message',senderId:'a',recipientId:'b',connectionId:'connection',createdAt:1800000000000,expiresAt:1800000010000,ciphertext:'x'.repeat(100)};
      const sent=await store.send('a',envelope,'synthetic-envelope');assert.deepEqual(await store.send('a',envelope,'synthetic-envelope'),sent);
      assert((await store.inbox('b')).some(item=>item.receipt.id==='new-message'));
      assert.equal((await store.acknowledge('b','a','new-message',sent.digest)).status,'received');
      await store.respondContact('b','connection','revoke');
      await assert.rejects(store.send('a',{...envelope,id:'after-revoke'},'synthetic-envelope'),/CONTACT_NOT_ACCEPTED/);
    }
    finally {await store.close();}
  } finally {
    if(connected){if(createdForeign)await admin.query(`DROP SCHEMA IF EXISTS "${role}_foreign" CASCADE`);if(createdSchema)await admin.query(`DROP SCHEMA IF EXISTS "${role}" CASCADE`);if(createdRole)await admin.query(`DROP ROLE IF EXISTS "${role}"`);await admin.end();}
    rmSync(directory,{recursive:true,force:true});
  }
});
