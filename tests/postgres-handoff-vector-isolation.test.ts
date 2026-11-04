import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertPostgresRuntimeRole,postgresRuntimeGrantPlan} from '../packages/deployment/postgres-handoff.js';
import type {PostgresBinding} from '../packages/deployment/postgres-binding.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;
const connection=()=>({host:'127.0.0.1',port:Number(process.env.PGPORT??52744),database:'postgres',user:'postgres',password:process.env.PGPASSWORD,ssl:false as const});

/** A fresh LOCAL test database gives this suite its own literal `extensions`
 * namespace. It never edits a shared extension, global PUBLIC grants or any
 * production schema. No vector package/DDL/grant is installed by EIGOS code. */
async function fixture(){
  const nonce=randomUUID().replaceAll('-',''),name=`eigos_vector_acl_${nonce}`,role=`eigos_vector_runtime_${nonce}`,control=new pg.Client(connection());await control.connect();let client:pg.Client|undefined,databaseCreated=false,roleCreated=false;
  const close=async()=>{try{await client?.end();if(databaseCreated)await control.query(`DROP DATABASE ${quote(name)} WITH(FORCE)`);if(roleCreated)await control.query(`DROP ROLE ${quote(role)}`);}finally{await control.end();}};
  try{
    await control.query(`CREATE DATABASE ${quote(name)}`);databaseCreated=true;
    await control.query(`CREATE ROLE ${quote(role)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);roleCreated=true;
    client=new pg.Client({...connection(),database:name});await client.connect();
    const business='eigos_business_acl_fixture',membership='eigos_membership_acl_fixture';
    for(const schema of [business,membership,'extensions'])await client.query(`CREATE SCHEMA ${quote(schema)}; REVOKE ALL ON SCHEMA ${quote(schema)} FROM PUBLIC`);
    for(const table of ['eigos_migration_receipt','eigos_business_mutex'])await client.query(`CREATE TABLE ${quote(business)}.${quote(table)}(id integer)`);
    for(const table of ['members','member_sessions','member_connections','agent_registrations','agent_access_tokens','member_invitations','eigos_membership_migration_receipt'])await client.query(`CREATE TABLE ${quote(membership)}.${quote(table)}(id integer)`);
    const reference={id:randomUUID(),revision:1,digest:'a'.repeat(64)};
    const binding:PostgresBinding={version:1,kind:'eigos.postgres-binding',authority:reference,sourceAuthority:reference,policyDigest:'b'.repeat(64),business:{schema:business,sourceFileDigest:'c'.repeat(64),schemaDigest:'d'.repeat(64),importPolicyDigest:'b'.repeat(64),receiptDigest:'e'.repeat(64)},membership:{schema:membership,sourceFileDigest:'f'.repeat(64),receiptDigest:'e'.repeat(64)},connection:{host:'127.0.0.1',port:connection().port,database:name,user:role,role,passwordEnv:'EIGOS_POSTGRES_PASSWORD',tls:{ca:{path:'/synthetic/not-opened-ca.pem',sha256:'a'.repeat(64)}}}};
    const grants=postgresRuntimeGrantPlan(binding,[]),checked=client;
    const verify=async()=>{await checked.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{await assertPostgresRuntimeRole(checked,binding,grants,'ungranted');}finally{await checked.query('ROLLBACK');}};
    return {client:checked,role,verify,close};
  }catch(error){await close();throw error;}
}

test('runtime isolation permits unreachable PUBLIC extension routines only when the role lacks namespace USAGE',local,async()=>{
  const f=await fixture();try{
    // Same names alone are never evidence of pgvector extension membership.
    // Both default PUBLIC EXECUTE entries are genuinely present in pg_proc.
    await f.client.query("CREATE FUNCTION extensions.vector_dims(integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS 'SELECT $1'; CREATE FUNCTION extensions.hnswhandler(integer) RETURNS integer LANGUAGE sql VOLATILE AS 'SELECT $1'");
    const flags=(await f.client.query(`SELECT pg_catalog.has_schema_privilege($1,'extensions','USAGE') AS usage,pg_catalog.has_schema_privilege($1,'extensions','CREATE') AS create,pg_catalog.has_function_privilege($1,'extensions.vector_dims(integer)','EXECUTE') AS immutable_execute,pg_catalog.has_function_privilege($1,'extensions.hnswhandler(integer)','EXECUTE') AS volatile_execute`,[f.role])).rows[0];
    assert.deepEqual(flags,{usage:false,create:false,immutable_execute:true,volatile_execute:true});await f.verify();
    await f.client.query('BEGIN');try{await f.client.query(`SET LOCAL ROLE ${quote(f.role)}`);await assert.rejects(f.client.query('SELECT extensions.vector_dims(1)'),/permission denied for schema extensions/);}finally{await f.client.query('ROLLBACK');}
    // Namespace access makes the same PUBLIC routines reachable. Neither an
    // immutable SQL spoof nor a volatile routine becomes a safe exception.
    await f.client.query(`GRANT USAGE ON SCHEMA extensions TO ${quote(f.role)}`);await assert.rejects(f.verify(),/effective capabilities outside/);
    await f.client.query('REVOKE EXECUTE ON FUNCTION extensions.hnswhandler(integer) FROM PUBLIC');await assert.rejects(f.verify(),/effective capabilities outside/);
    await f.client.query('REVOKE EXECUTE ON FUNCTION extensions.vector_dims(integer) FROM PUBLIC');await f.verify();
    await f.client.query('GRANT EXECUTE ON FUNCTION extensions.hnswhandler(integer) TO PUBLIC');await assert.rejects(f.verify(),/effective capabilities outside/);
  }finally{await f.close();}
});

test('an extensions namespace never exempts table, sequence, CREATE or unreviewed routine privileges',local,async()=>{
  const f=await fixture();try{
    await f.client.query(`GRANT USAGE ON SCHEMA extensions TO ${quote(f.role)}; CREATE TABLE extensions.private_rows(id integer); CREATE SEQUENCE extensions.private_sequence`);await f.verify();
    await f.client.query(`GRANT SELECT ON extensions.private_rows TO ${quote(f.role)}`);await assert.rejects(f.verify(),/effective capabilities outside/);await f.client.query(`REVOKE SELECT ON extensions.private_rows FROM ${quote(f.role)}`);
    await f.client.query(`GRANT USAGE ON SEQUENCE extensions.private_sequence TO ${quote(f.role)}`);await assert.rejects(f.verify(),/effective capabilities outside/);await f.client.query(`REVOKE USAGE ON SEQUENCE extensions.private_sequence FROM ${quote(f.role)}`);
    await f.client.query(`GRANT CREATE ON SCHEMA extensions TO ${quote(f.role)}`);await assert.rejects(f.verify(),/effective capabilities outside/);await f.client.query(`REVOKE CREATE ON SCHEMA extensions FROM ${quote(f.role)}`);
    await f.client.query("CREATE FUNCTION extensions.unreviewed_vector_helper(integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT $1'");await assert.rejects(f.verify(),/effective capabilities outside/);
    await f.client.query(`REVOKE USAGE ON SCHEMA extensions FROM ${quote(f.role)}`);await f.verify();
  }finally{await f.close();}
});
