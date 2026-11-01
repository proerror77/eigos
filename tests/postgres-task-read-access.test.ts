import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { securityFixture } from './fixtures/security.js';
import { installPostgresAuthorityLock } from '../packages/postgres/authority-lock.js';
import { postgresBusinessTransaction } from '../packages/postgres/runtime-transaction.js';
import { postgresTaskReadGrant, postgresTaskReadOntology, withPostgresTaskReadGrant } from '../packages/postgres/task-read-access.js';

test('PostgreSQL task read admission preserves identity, revocation and grant fences', {skip:process.env.EIGOS_TEST_PG_LOCAL !== '1'}, async () => {
  // Remote fixture setup spans multiple round trips; keep its synthetic lease
  // ahead of the real clock so the copied projection remains valid during it.
  const clockOffset=process.env.EIGOS_TEST_PG_CA_FILE?300000:0;
  const f=securityFixture(()=>Date.now()+clockOffset), installation=f.installation('Synthetic read',3600000); f.approve(installation.id);
  const task=f.task(installation.id), principal={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
  const sqlite=new DatabaseSync(f.database), schema=`eigos_business_${randomUUID().replaceAll('-','')}`;
  const stored=sqlite.prepare('SELECT body FROM security_grants WHERE id=?').get(task.grant.id)!;
  const readGrant=JSON.parse(String(stored.body)); readGrant.operations.push('task.result.read'); readGrant.channels.push('agent_response');
  sqlite.prepare('UPDATE security_grants SET body=? WHERE id=?').run(JSON.stringify(readGrant),task.grant.id);
  const policy=f.jobs.security.policies.definitionDigest, authority={id:randomUUID(),revision:1,digest:'a'.repeat(64)};
  const client=new pg.Client(process.env.EIGOS_TEST_PG_CA_FILE?{ssl:{ca:readFileSync(process.env.EIGOS_TEST_PG_CA_FILE,'utf8'),rejectUnauthorized:true}}:{}); await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".runtime_authority(slot BIGINT PRIMARY KEY,id TEXT,revision BIGINT,configuration_digest TEXT)`);
    await client.query(`INSERT INTO "${schema}".runtime_authority VALUES(1,$1,$2,$3)`,[authority.id,authority.revision,authority.digest]); await installPostgresAuthorityLock(client,schema);
    await client.query(`CREATE FUNCTION "${schema}".eigos_try_jsonb(value TEXT) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE STRICT AS $$ BEGIN RETURN value::jsonb; EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR untranslatable_character THEN RETURN NULL; END $$`);
    for(const table of ['jobs','security_settings','security_manager','security_subjects','security_fences','security_grants','security_policy','security_policy_definitions','ontology_definition_releases','ontology_definition_release_aliases','ontology_definition_bootstrap','ontology_namespaces','ontology_task_read_projections']) {
      const cols=sqlite.prepare(`PRAGMA table_info("${table}")`).all();
      await client.query(`CREATE TABLE "${schema}"."${table}" (${cols.map(c=>`"${c.name}" ${String(c.type).toUpperCase()==='INTEGER'?'BIGINT':'TEXT'}`).join(',')})`);
      for(const row of sqlite.prepare(`SELECT * FROM "${table}"`).iterate()) await client.query(`INSERT INTO "${schema}"."${table}" VALUES (${cols.map((_,i)=>`$${i+1}`).join(',')})`,cols.map(c=>row[String(c.name)]));
    }
    const original=f.jobs.security.scope(f.jobs.security.agentContext(principal),task.job.id,'task.result.read').grant!;
    const read=()=>postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadGrant(c,principal,task.job.id,policy));
    assert.equal((await read()).grant.id,original.id);
    const model=await postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadOntology(c,principal,task.job.id,policy));
    assert.deepEqual(model.ref,task.job.delegation!.ontologyRelease);
    const wrong={...principal,subject:'someone-else'};
    assert.throws(()=>f.jobs.security.agentContext(wrong),/AUTHORIZATION_REQUIRED/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadGrant(c,wrong,task.job.id,policy)),/AUTHORIZATION_REQUIRED/);
    const alteredScopes={...principal,scopes:principal.scopes.filter(scope=>scope!=='tasks:read')};
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadGrant(c,alteredScopes,task.job.id,policy)),/Required scope: tasks:read/);
    sqlite.prepare('UPDATE security_subjects SET epoch=epoch+1 WHERE installation_id=?').run(installation.id);
    await client.query(`UPDATE "${schema}".security_subjects SET epoch=epoch+1 WHERE installation_id=$1`,[installation.id]);
    assert.throws(()=>f.jobs.security.agentContext(principal),/POLICY_CHANGED/); await assert.rejects(read(),/POLICY_CHANGED/);
    sqlite.prepare('UPDATE security_subjects SET epoch=epoch-1 WHERE installation_id=?').run(installation.id);
    await client.query(`UPDATE "${schema}".security_subjects SET epoch=epoch-1 WHERE installation_id=$1`,[installation.id]);
    const grantBody=JSON.stringify(readGrant),field=`"taskId":"${task.job.id}"`,duplicate=grantBody.replace(field,`${field},${field}`); assert.notEqual(duplicate,grantBody);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[duplicate,task.grant.id]);
    await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[grantBody,task.grant.id]);
    const fence:[string,string,string,string,number,string]=[randomUUID(),f.owner,'installation',installation.id,1,'pending'];
    sqlite.prepare('INSERT INTO security_fences VALUES(?,?,?,?,?,?)').run(...fence);
    await client.query(`INSERT INTO "${schema}".security_fences VALUES($1,$2,$3,$4,$5,$6)`,fence);
    assert.throws(()=>f.jobs.security.agentContext(principal),/ACCESS_REVOKED/); await assert.rejects(read(),/ACCESS_REVOKED/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadOntology(c,principal,task.job.id,policy)),/ACCESS_REVOKED/);
    sqlite.prepare('DELETE FROM security_fences WHERE id=?').run(fence[0]); await client.query(`DELETE FROM "${schema}".security_fences WHERE id=$1`,[fence[0]]);
    sqlite.prepare('UPDATE security_grants SET expires_at=0 WHERE id=?').run(task.grant.id); await client.query(`UPDATE "${schema}".security_grants SET expires_at=0 WHERE id=$1`,[task.grant.id]);
    assert.throws(()=>f.jobs.security.taskGrant(f.jobs.security.agentContext(principal),task.job.id),/AUTHORIZATION_REQUIRED/); await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    sqlite.prepare('UPDATE security_grants SET expires_at=? WHERE id=?').run(Date.parse(task.grant.expiresAt),task.grant.id); await client.query(`UPDATE "${schema}".security_grants SET expires_at=$1 WHERE id=$2`,[Date.parse(task.grant.expiresAt),task.grant.id]);
    const jobBody=String(sqlite.prepare('SELECT body FROM jobs WHERE id=?').get(task.job.id)!.body),changedJob=JSON.parse(jobBody); changedJob.delegation.request.revision++;
    sqlite.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(changedJob),task.job.id); await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[JSON.stringify(changedJob),task.job.id]);
    assert.throws(()=>f.jobs.security.taskGrant(f.jobs.security.agentContext(principal),task.job.id),/AUTHORIZATION_REQUIRED/); await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    sqlite.prepare('UPDATE jobs SET body=? WHERE id=?').run(jobBody,task.job.id); await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[jobBody,task.job.id]);
    const request=JSON.stringify(JSON.parse(jobBody).delegation.request), ambiguousRequest=request.replace('"revision":1','"revision":1,"revision":1');
    const ambiguousJob=jobBody.replace(`"request":${request}`,`"request":${ambiguousRequest}`); assert.notEqual(ambiguousJob,jobBody);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[ambiguousJob,task.job.id]); await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[jobBody,task.job.id]);
    const parent=f.jobs.security.agentGrant(installation.id);
    sqlite.prepare("UPDATE security_grants SET state='revoked' WHERE id=?").run(parent.id); await client.query(`UPDATE "${schema}".security_grants SET state='revoked' WHERE id=$1`,[parent.id]);
    assert.throws(()=>f.jobs.security.agentContext(principal),/AUTHORIZATION_REQUIRED/); await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    sqlite.prepare("UPDATE security_grants SET state='active' WHERE id=?").run(parent.id); await client.query(`UPDATE "${schema}".security_grants SET state='active' WHERE id=$1`,[parent.id]);
    const scoped=structuredClone(principal);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c=>withPostgresTaskReadGrant(c,scoped,task.job.id,policy,async()=>{scoped.subject='changed';return 'scoped';})),'scoped');
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>withPostgresTaskReadGrant(c,principal,task.job.id,policy,async()=>{
      await c.query(`UPDATE "${schema}".security_grants SET revision=revision+1 WHERE id=$1`,[task.grant.id]); return 'not exposed';
    })),/POLICY_CHANGED/);
    assert.equal((await read()).grant.revision,original.revision,'failed post-check rolls back the action');
  } finally {await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await client.end();sqlite.close();f.close();}
});
