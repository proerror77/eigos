import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
const clientOptions = () => process.env.EIGOS_TEST_PG_CA_FILE ? { ssl: { ca: readFileSync(process.env.EIGOS_TEST_PG_CA_FILE, 'utf8'), rejectUnauthorized: true } } : {};
import { postgresBusinessTransaction, postgresConstrainReadDeadline } from '../packages/postgres/runtime-transaction.js';
import { installPostgresAuthorityLock,postgresBusinessMutexValid } from '../packages/postgres/authority-lock.js';
import { PostgresDatabase } from '../packages/postgres/database.js';
import type {WorkClaim} from '../packages/core/store.js';
import {BACKEND_VERSION} from '../packages/ontology/execution.js';

test('PostgreSQL business mutations fence authority, roll back and report uncertain commits', { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
  const client = new pg.Client(clientOptions()); await client.connect();
  const schema = `eigos_business_${randomUUID().replaceAll('-','')}`;
  const authority = { id: randomUUID(), revision: 1, digest: 'a'.repeat(64) };
  try {
    await client.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".runtime_authority(slot BIGINT PRIMARY KEY,id TEXT,revision BIGINT,configuration_digest TEXT); CREATE TABLE "${schema}".example(id BIGINT PRIMARY KEY,value BIGINT)`);
    await client.query(`INSERT INTO "${schema}".runtime_authority VALUES(1,$1,$2,$3)`, [authority.id,authority.revision,authority.digest]);
    await installPostgresAuthorityLock(client, schema);
    assert.equal(await postgresBusinessMutexValid(client,schema),true);
    await assert.rejects(client.query(`INSERT INTO "${schema}".eigos_business_mutex VALUES(true)`),/check constraint/);
    await postgresBusinessTransaction(client,schema,authority,async c => { await c.query('INSERT INTO example VALUES(1,10)'); });
    await client.query('BEGIN');
    await client.query(`UPDATE "${schema}".example SET value=11`);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,async () => undefined), /idle, non-pipelined/);
    assert.equal(client.getTransactionStatus(),'T'); await client.query('ROLLBACK');
    assert.equal((await client.query(`SELECT value FROM "${schema}".example`)).rows[0].value,'10');
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,async c => {
      await c.query('UPDATE example SET value=20'); await c.query("UPDATE runtime_authority SET configuration_digest='changed'");
    }), /authority changed/);
    assert.equal((await client.query(`SELECT value FROM "${schema}".example`)).rows[0].value,'10');
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,async c => { await c.query('UPDATE example SET value=99'); await c.query('SELECT 1/0'); }), /division by zero/);
    assert.equal(client.getTransactionStatus(),'I'); assert.equal((await client.query(`SELECT value FROM "${schema}".example`)).rows[0].value,'10');
    const mutable = { ...authority };
    await assert.rejects(postgresBusinessTransaction(client,schema,mutable,async c => { await c.query("UPDATE runtime_authority SET configuration_digest=$1", ['b'.repeat(64)]); mutable.digest='b'.repeat(64); }), /authority changed/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,async c => postgresBusinessTransaction(c,schema,authority,async () => undefined)), /Nested/);
    await assert.rejects(postgresBusinessTransaction(client,schema,{...authority,digest:'b'.repeat(64)},async () => undefined), /authority changed/);
    const uncertain = { pipeline: false, getTransactionStatus: () => client.getTransactionStatus(), query: async (sql: string, values?: unknown[]) => { const result = await client.query(sql,values); if (sql === 'COMMIT') throw new Error('lost response'); return result; } } as unknown as pg.Client;
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
    assert.equal(successful,2,'a queued writer must take its snapshot after acquiring serialization');
    assert.equal(Number((await first.query(`SELECT value FROM "${schema}".example`)).rows[0].value),successful);
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert.match(String(outcome.reason), /serializ|commit outcome is unknown/i);
  } finally { await first.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await first.end(); await second.end(); }
});

test('transaction discards connections when rollback or commit responses fail', async () => {
  const authority = { id: 'authority', revision: 1, digest: 'a'.repeat(64) };
  for (const failure of ['ROLLBACK','COMMIT']) {
    let discarded = false, started = false;
    const client = {
      pipeline: false, getTransactionStatus: () => started ? 'T' : 'I',
      query: async (sql: string) => {
        if (sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE') started = true;
        if (sql === failure) throw new Error('connection failed');
        if (sql.startsWith('SELECT pg_catalog.pg_current_xact_id')) return { rowCount: 1, rows: [{ id: '42' }] };
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
  let evicted = false, started = false;
  const authority = { id: 'authority', revision: 1, digest: 'a'.repeat(64) };
  const client = {
    pipeline: false, getTransactionStatus: () => started ? 'T' : 'I',
    query: async (sql: string) => {
      if (sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE') started = true;
      if (sql === 'ROLLBACK') throw new Error('lost connection');
      if (sql.startsWith('SELECT pg_catalog.pg_current_xact_id')) return { rowCount: 1, rows: [{ id: '42' }] };
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
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"; GRANT EXECUTE ON FUNCTION "${schema}".eigos_lock_runtime_authority() TO "${role}"; GRANT UPDATE ON "${schema}".eigos_business_mutex TO "${role}"; GRANT SELECT,UPDATE ON "${schema}".example TO "${role}"; SET ROLE "${role}"`);
    const privileges = await admin.query('SELECT has_table_privilege(current_user,$1,\'SELECT\') AS can_read, has_table_privilege(current_user,$1,\'UPDATE\') AS can_update', [`"${schema}".runtime_authority`]);
    assert.equal(privileges.rows[0].can_read,false); assert.equal(privileges.rows[0].can_update,false);
    await assert.rejects(admin.query(`SELECT * FROM "${schema}".runtime_authority`), /permission denied/);
    await admin.query('CREATE TEMP TABLE runtime_authority(slot BIGINT, id TEXT, revision BIGINT, configuration_digest TEXT)');
    await postgresBusinessTransaction(admin,schema,authority,async c => { await c.query('UPDATE example SET value=1'); });
    assert.equal((await admin.query(`SELECT value FROM "${schema}".example`)).rows[0].value,'1');
    await assert.rejects(admin.query(`UPDATE "${schema}".runtime_authority SET revision=2`), /permission denied/);
  } finally { await admin.query('RESET ROLE'); await admin.query('DROP TABLE IF EXISTS pg_temp.runtime_authority'); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP ROLE IF EXISTS "${role}"`); await admin.end(); }
});


test('a lost transaction boundary is reported as uncertain and the connection is discarded', { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
  const owner = new pg.Client(clientOptions()), worker = new pg.Client(clientOptions()); await owner.connect(); await worker.connect();
  const schema = `eigos_business_${randomUUID().replaceAll('-','')}`, authority = { id: randomUUID(), revision: 1, digest: 'a'.repeat(64) };
  try {
    await owner.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".runtime_authority(slot BIGINT PRIMARY KEY,id TEXT,revision BIGINT,configuration_digest TEXT); CREATE TABLE "${schema}".example(value BIGINT)`);
    await owner.query(`INSERT INTO "${schema}".runtime_authority VALUES(1,$1,$2,$3)`,[authority.id,authority.revision,authority.digest]);
    await installPostgresAuthorityLock(owner,schema);
    await assert.rejects(postgresBusinessTransaction(worker,schema,authority,async c => { await c.query('INSERT INTO example VALUES(42)'); await c.query('COMMIT'); }), /commit outcome is unknown/);
    assert.equal((await owner.query(`SELECT value FROM "${schema}".example`)).rows[0].value,'42');
    await assert.rejects(worker.query('SELECT 1'));
    const replacement = new pg.Client(clientOptions()); await replacement.connect();
    await assert.rejects(postgresBusinessTransaction(replacement,schema,authority,async c => { await c.query('INSERT INTO example VALUES(43)'); await c.query('COMMIT; BEGIN'); }), /commit outcome is unknown/);
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "${schema}".example`)).rows[0].n,2);
    await assert.rejects(replacement.query('SELECT 1'));
    const thrown = new pg.Client(clientOptions()); await thrown.connect();
    await assert.rejects(postgresBusinessTransaction(thrown,schema,authority,async c => { await c.query('INSERT INTO example VALUES(44)'); await c.query('COMMIT'); throw new Error('after commit'); }), /commit outcome is unknown/);
    await assert.rejects(thrown.query('SELECT 1'));
    const aborted = new pg.Client(clientOptions()); await aborted.connect();
    await assert.rejects(postgresBusinessTransaction(aborted,schema,authority,async c => { await c.query('INSERT INTO example VALUES(45)'); await c.query('COMMIT; BEGIN; SELECT 1/0'); }), /commit outcome is unknown/);
    await assert.rejects(aborted.query('SELECT 1'));
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "${schema}".example`)).rows[0].n,4);
  } finally { await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await owner.end(); }
});

test('pipelined or unverified connections are rejected', async () => {
  const authority = { id: 'authority', revision: 1, digest: 'a'.repeat(64) };
  const pipelined = { pipeline: true, getTransactionStatus: () => 'I' } as unknown as pg.Client;
  const unknown = { pipeline: false, getTransactionStatus: () => null } as unknown as pg.Client;
  const unspecified = { getTransactionStatus: () => 'I' } as unknown as pg.Client;
  for (const client of [pipelined,unknown,unspecified]) await assert.rejects(postgresBusinessTransaction(client,'eigos_business_fixture',authority,async () => undefined), /idle, non-pipelined/);
});

test('protected reads are withheld if authority expires before or during commit acknowledgment', async () => {
  const authority={id:'authority',revision:1,digest:'a'.repeat(64)};
  for(const phase of ['before','during']) {
    const originalNow=Date.now,start=originalNow();let now=start,started=false,committed=false,rolledBack=false,discarded=false;
    const client={pipeline:false,getTransactionStatus:()=>started?'T':'I',
      query:async(sql:string)=>{
        if(sql==='BEGIN ISOLATION LEVEL SERIALIZABLE')started=true;
        if(sql==='ROLLBACK'){started=false;rolledBack=true;}
        if(sql==='COMMIT'){started=false;committed=true;now=start+20;}
        if(sql.startsWith('SELECT pg_catalog.pg_current_xact_id'))return {rowCount:1,rows:[{id:'42'}]};
        if(sql.startsWith('SELECT id,revision'))return {rowCount:1,rows:[{id:authority.id,revision:'1',configuration_digest:authority.digest}]};
        return {rowCount:0,rows:[]};
      },end:async()=>{discarded=true;}} as unknown as pg.Client;
    Date.now=()=>now;
    try {
      await assert.rejects(postgresBusinessTransaction(client,'eigos_business_fixture',authority,async c=>{
        postgresConstrainReadDeadline(c,start+10);
        if(phase==='before')now=start+20;
        return 'protected response';
      }),error=>error instanceof Error && error.message==='OUTPUT_NOT_ALLOWED');
      assert.equal(committed,phase==='during');assert.equal(rolledBack,phase==='before');assert.equal(discarded,false);
      assert.throws(()=>postgresConstrainReadDeadline(client,start+1000),/active PostgreSQL business transaction/);
    } finally {Date.now=originalNow;}
  }
});

test('database runtime releases each lease once and evicts an uncertain connection without retrying', async () => {
  for(const uncertain of [false,true]) {
    let started=false,releases=0,evicted=false,connects=0,ends=0,writes=0,nextLeaseReleases=0;
    const authority={id:'authority',revision:1,digest:'a'.repeat(64)};
    const client={pipeline:false,getTransactionStatus:()=>started?'T':'I',release:(error?:Error|boolean)=>{releases++;evicted=error instanceof Error;client.release=()=>{nextLeaseReleases++;};},
      query:async(sql:string)=>{
        if(sql==='BEGIN ISOLATION LEVEL SERIALIZABLE')started=true;
        if(sql==='COMMIT'){started=false;if(uncertain)throw new Error('lost commit response');}
        if(sql==='ROLLBACK')started=false;
        if(sql==='INSERT synthetic_task')writes++;
        if(sql.startsWith('SELECT pg_catalog.pg_current_xact_id'))return {rowCount:1,rows:[{id:'42'}]};
        if(sql.startsWith('SELECT id,revision'))return {rowCount:1,rows:[{id:'authority',revision:'1',configuration_digest:'a'.repeat(64)}]};
        return {rowCount:0,rows:[]};
      }} as unknown as pg.PoolClient;
    const pool={connect:async()=>{connects++;return client;},end:async()=>{ends++;}} as unknown as Pick<pg.Pool,'connect'|'end'>;
    const database=new PostgresDatabase(pool,'eigos_business_fixture',authority);authority.digest='b'.repeat(64);
    const operation=()=>database.run(async c=>{await c.query('INSERT synthetic_task');return 'receipt';});
    if(uncertain)await assert.rejects(operation(),/commit outcome is unknown/);else assert.equal(await operation(),'receipt');
    assert.equal(releases,1);assert.equal(evicted,uncertain);assert.equal(connects,1);assert.equal(writes,1);assert.equal(nextLeaseReleases,0);
    await database.close();await database.close();assert.equal(ends,1);
    await assert.rejects(database.run(async()=>undefined),/runtime is closing/);assert.equal(connects,1);
  }
});

test('Worker heartbeat capacity is separate and both owned pools close once',async()=>{
  let businessEnds=0,leaseEnds=0;
  const business={connect:async()=>{throw new Error('unused');},end:async()=>{businessEnds++;}} as unknown as Pick<pg.Pool,'connect'|'end'>;
  const lease={connect:async()=>{throw new Error('unused');},end:async()=>{leaseEnds++;}} as unknown as Pick<pg.Pool,'connect'|'end'>;
  const authority={id:'authority',revision:1,digest:'a'.repeat(64)};
  assert.throws(()=>new PostgresDatabase(business,'eigos_business_fixture',authority,{leasePool:business}),/separate/);
  const database=new PostgresDatabase(business,'eigos_business_fixture',authority,{leasePool:lease});
  await database.close();await database.close();assert.equal(businessEnds,1);assert.equal(leaseEnds,1);
});

test('heartbeat headers are captured before waiting for its connection lease',async()=>{
  let connected!:(client:pg.PoolClient)=>void,started=false,released=0,token:unknown,revision:unknown;
  const authority={id:'authority',revision:1,digest:'a'.repeat(64)},id=randomUUID(),at=new Date().toISOString();
  const claim:WorkClaim={owner:JSON.stringify(['issuer','tenant','subject']),token:'original-token',securityAuthorityId:randomUUID(),securityEpoch:1,securityPolicyRevision:1,
    job:{id,contextId:randomUUID(),service:'eigos.delegate',goal:'Synthetic',state:'working',revision:1,messages:[],createdAt:at,updatedAt:at,
      delegation:{backendVersion:BACKEND_VERSION,phase:'grounding',events:[],request:{id,revision:1,originalGoal:'Synthetic',messages:[],requirements:[]}}}};
  const client={pipeline:false,getTransactionStatus:()=>started?'T':'I',release:()=>{released++;},query:async(sql:string,values?:unknown[])=>{
    if(sql==='BEGIN ISOLATION LEVEL READ COMMITTED')started=true;if(sql==='ROLLBACK')started=false;
    if(sql.startsWith('WITH scope AS')){token=values?.[4];revision=values?.[5];}
    return {rowCount:0,rows:[]};
  }} as unknown as pg.PoolClient;
  const business={connect:async()=>{throw new Error('unused');},end:async()=>{}} as unknown as Pick<pg.Pool,'connect'|'end'>;
  const lease={connect:()=>new Promise<pg.PoolClient>(resolve=>{connected=resolve;}),end:async()=>{}};
  const database=new PostgresDatabase(business,'eigos_business_fixture',authority,{leasePool:lease});
  const renewal=database.renewClaim(claim,1000,'a'.repeat(64));claim.token='replacement-token';claim.job.revision=2;connected(client);
  assert.equal(await renewal,false);assert.equal(token,'original-token');assert.equal(revision,1);assert.equal(released,1);await database.close();
});
