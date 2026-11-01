import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { securityFixture } from './fixtures/security.js';
import { installPostgresAuthorityLock } from '../packages/postgres/authority-lock.js';
import { postgresBusinessTransaction } from '../packages/postgres/runtime-transaction.js';
import { createStagedPostgresTaskReader, postgresTaskFieldClassification, postgresTaskReadClearance, postgresTaskReadGrant, postgresTaskReadOntology, postgresTaskResourceViewAllowed, withPostgresTaskReadGrant } from '../packages/postgres/task-read-access.js';
import { POLICY_VERSION, SECURITY_CONTRACT } from '../packages/security/contracts.js';
import { StagedKernelBuilder } from '../packages/ontology/seed-definition.js';

test('PostgreSQL task read admission preserves identity, revocation and grant fences', {skip:process.env.EIGOS_TEST_PG_LOCAL !== '1'}, async () => {
  // Remote setup and large-row validation may outlast the synthetic lease;
  // keep the fixture's copied projection valid throughout those checks.
  const clockOffset=process.env.EIGOS_TEST_PG_CA_FILE || process.env.EIGOS_TEST_LARGE_ROW==='1'?300000:0;
  const f=securityFixture(()=>Date.now()+clockOffset), installation=f.installation('Synthetic read',3600000); f.approve(installation.id);
  const task=f.task(installation.id), principal={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
  f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'objectType',id:'ServiceRequest',version:f.jobs.security.policies.resourceVersion('objectType','ServiceRequest')},role:'Viewer',expiresAt:new Date(Date.now()+3600000).toISOString()},f.jobs.security.policies.revision());
  const recipient={classification:'sensitive' as const,markings:['member_private','personal_data'] as const,channels:['agent_response'] as const,expiresAt:new Date(Date.now()+3600000).toISOString()};
  f.jobs.security.policies.setRecipient(installation.id,recipient,f.jobs.security.policies.revision());
  for(const field of ['*','originalGoal','requestId']) f.jobs.security.policies.restrictObject({ownerKey:f.owner,object:{type:'ServiceRequest',id:task.job.id},expectedObjectRevision:1,field,classification:'sensitive',requiredMarkings:['personal_data'],channels:['agent_response']},f.jobs.security.policies.revision());
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
    for(const table of ['jobs','security_settings','security_manager','security_subjects','security_fences','security_grants','security_policy','security_policy_definitions','security_roles','security_recipients','security_labels','ontology_objects','ontology_definition_releases','ontology_definition_release_aliases','ontology_definition_bootstrap','ontology_namespaces','ontology_task_read_projections']) {
      const cols=sqlite.prepare(`PRAGMA table_info("${table}")`).all();
      await client.query(`CREATE TABLE "${schema}"."${table}" (${cols.map(c=>`"${c.name}" ${String(c.type).toUpperCase()==='INTEGER'?'BIGINT':'TEXT'}`).join(',')})`);
      for(const row of sqlite.prepare(`SELECT * FROM "${table}"`).iterate()) await client.query(`INSERT INTO "${schema}"."${table}" VALUES (${cols.map((_,i)=>`$${i+1}`).join(',')})`,cols.map(c=>row[String(c.name)]));
    }
    const staged=new StagedKernelBuilder();
    assert.throws(()=>createStagedPostgresTaskReader(undefined as unknown as StagedKernelBuilder),/Invalid staged kernel builder/);
    assert.throws(()=>createStagedPostgresTaskReader(staged),/not ready/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadOntology(c,principal,task.job.id,policy,staged)),/not ready/);
    for(let stage=0;stage<StagedKernelBuilder.stages;stage++)staged.step(stage);
    const stagedReader=createStagedPostgresTaskReader(staged);
    if (process.env.EIGOS_TEST_LARGE_ROW==='1') {
      // Generate the synthetic large value inside PostgreSQL; it must never be
      // sent to the client by authorization or ontology-context reads.
      await client.query(`UPDATE "${schema}".jobs SET body=jsonb_set(body::jsonb,'{padding}',to_jsonb(repeat('x',108452531)))::text WHERE id=$1`,[task.job.id]);
      const observed=new Proxy(client,{get(target,property){
        if(property==='query')return async(sql:string,values?:unknown[])=>{
          const result=await target.query(sql,values);
          for(const row of result.rows)for(const value of Object.values(row))if(typeof value==='string')assert(Buffer.byteLength(value)<=8*1024*1024,'A database response returned an unbounded task field');
          return result;
        };
        const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
      }});
      const large=await postgresBusinessTransaction(observed,schema,authority,c=>postgresTaskReadOntology(c,principal,task.job.id,policy,staged));
      assert.deepEqual(large.ref,task.job.delegation!.ontologyRelease);
      await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[JSON.stringify(task.job),task.job.id]);
    }
    const original=f.jobs.security.scope(f.jobs.security.agentContext(principal),task.job.id,'task.result.read').grant!;
    const read=()=>postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadGrant(c,principal,task.job.id,policy));
    assert.equal((await read()).grant.id,original.id);
    const model=await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.ontology(c,principal,task.job.id,policy));
    assert.deepEqual(model.ref,task.job.delegation!.ontologyRelease);
    const ref={type:'ServiceRequest',id:task.job.id};
    const labels=await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal']));
    const expectedLabels=sqlite.prepare("SELECT field,body FROM security_labels WHERE owner=? AND type=? AND object_id=? AND field IN ('*','originalGoal') ORDER BY field").all(f.owner,ref.type,ref.id).map(row=>({field:row.field,...JSON.parse(String(row.body))}));
    assert.deepEqual(labels,expectedLabels);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,2,['originalGoal'])),/POLICY_CHANGED/);
    await client.query(`UPDATE "${schema}".security_labels SET body=repeat('x',65537) WHERE owner=$1 AND type=$2 AND object_id=$3 AND field='originalGoal'`,[f.owner,ref.type,ref.id]);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal'])),/OUTPUT_NOT_ALLOWED/);
    const originalLabel=sqlite.prepare("SELECT body FROM security_labels WHERE owner=? AND type=? AND object_id=? AND field='originalGoal'").get(f.owner,ref.type,ref.id)!;
    await client.query(`UPDATE "${schema}".security_labels SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND field='originalGoal'`,[originalLabel.body,f.owner,ref.type,ref.id]);
    const otherLabel=sqlite.prepare("SELECT body FROM security_labels WHERE owner=? AND type=? AND object_id=? AND field='requestId'").get(f.owner,ref.type,ref.id)!;
    await client.query(`UPDATE "${schema}".security_labels SET body='invalid' WHERE owner=$1 AND type=$2 AND object_id=$3 AND field='requestId'`,[f.owner,ref.type,ref.id]);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal'])),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_labels SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND field='requestId'`,[otherLabel.body,f.owner,ref.type,ref.id]);
    await client.query(`INSERT INTO "${schema}".security_labels(owner,type,object_id,field,body) SELECT $1,$2,$3,'synthetic'||n,$4 FROM generate_series(1,254) n`,[f.owner,ref.type,ref.id,originalLabel.body]);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal'])),/OUTPUT_NOT_ALLOWED/);
    await client.query(`DELETE FROM "${schema}".security_labels WHERE owner=$1 AND type=$2 AND object_id=$3 AND field LIKE 'synthetic%'`,[f.owner,ref.type,ref.id]);
    await client.query(`UPDATE "${schema}".security_labels SET body='{}' WHERE owner=$1 AND type=$2 AND object_id=$3 AND field='originalGoal'`,[f.owner,ref.type,ref.id]);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal'])),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_labels SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND field='originalGoal'`,[originalLabel.body,f.owner,ref.type,ref.id]);
    const projected={type:'RollingGoSearchObservation',id:'synthetic-label-projection'};
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,$2,$3,1,$4,'{}')`,[f.owner,projected.type,projected.id,'a'.repeat(64)]);
    await client.query(`INSERT INTO "${schema}".security_labels(owner,type,object_id,field,body) VALUES($1,$2,$3,'snapshot',$4)`,[f.owner,projected.type,projected.id,originalLabel.body]);
    const projectedLabels=await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,projected,1,['observedData']));
    assert.deepEqual(projectedLabels.map(label=>label.field),['snapshot']);
    for(const [type,field] of [['ServiceRequest','originalGoal'],['ServiceRequest','requestId'],['ServiceRequest','progress'],['ServiceRequest','unreviewed'],['NonexistentType','field']] as const) {
      const expected=f.jobs.security.policies.fieldPolicy(type,field);
      const actual=await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.fieldClassification(c,principal,task.job.id,policy,type,field));
      assert.equal(actual,expected);
    }
    const envelope={version:SECURITY_CONTRACT,ownerKey:f.owner,policyVersion:POLICY_VERSION,requiredMarkings:['member_private'] as const,classification:'private' as const,channels:['agent_response'] as const,lineage:[],lineageComplete:true};
    const sqliteScope=f.jobs.security.scope(f.jobs.security.agentContext(principal),task.job.id,'task.result.read');
    f.jobs.security.policies.requireRecipient(sqliteScope,{...envelope,requiredMarkings:[...envelope.requiredMarkings],channels:[...envelope.channels]},'agent_response');
    const clearance=()=>postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadClearance(c,principal,task.job.id,policy));
    assert.deepEqual(await clearance(),recipient);
    assert.deepEqual(await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.clearance(c,principal,task.job.id,policy)),recipient);
    const recipientBody=String(sqlite.prepare('SELECT body FROM security_recipients WHERE installation_id=?').get(installation.id)!.body);
    const expiredRecipient={...recipient,expiresAt:'2000-01-01T00:00:00.000Z'};
    sqlite.prepare('UPDATE security_recipients SET body=? WHERE installation_id=?').run(JSON.stringify(expiredRecipient),installation.id);
    assert.throws(()=>f.jobs.security.policies.requireRecipient(sqliteScope,{...envelope,requiredMarkings:[...envelope.requiredMarkings],channels:[...envelope.channels]},'agent_response'),/OUTPUT_NOT_ALLOWED/);
    sqlite.prepare('UPDATE security_recipients SET body=? WHERE installation_id=?').run(recipientBody,installation.id);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[JSON.stringify(expiredRecipient),installation.id]);
    assert.equal(await clearance(),undefined);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[recipientBody,installation.id]);
    sqlite.prepare('DELETE FROM security_recipients WHERE installation_id=?').run(installation.id);
    assert.throws(()=>f.jobs.security.policies.requireRecipient(sqliteScope,{...envelope,requiredMarkings:[...envelope.requiredMarkings],channels:[...envelope.channels]},'agent_response'),/OUTPUT_NOT_ALLOWED/);
    sqlite.prepare('INSERT INTO security_recipients VALUES(?,?)').run(installation.id,recipientBody);
    await client.query(`DELETE FROM "${schema}".security_recipients WHERE installation_id=$1`,[installation.id]); assert.equal(await clearance(),undefined);
    await client.query(`INSERT INTO "${schema}".security_recipients VALUES($1,$2)`,[installation.id,recipientBody]);
    await client.query(`UPDATE "${schema}".security_recipients SET body=repeat('x',65537) WHERE installation_id=$1`,[installation.id]);
    await assert.rejects(clearance(),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[recipientBody,installation.id]);
    for(const type of ['ServiceRequest','Place','NonexistentType']) {
      const expected=f.jobs.security.policies.resourceAllowedFor(f.member.id,installation.id,'objectType',type);
      const actual=await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.resourceViewAllowed(c,principal,task.job.id,policy,'objectType',type));
      assert.equal(actual,expected);
    }
    assert.equal(f.jobs.security.policies.resourceAllowedFor(f.member.id,installation.id,'objectType','ServiceRequest'),true);
    const role=sqlite.prepare('SELECT id,body FROM security_roles WHERE subject_id=?').get(installation.id)!;
    const expiredRole={...JSON.parse(String(role.body)),expiresAt:'2000-01-01T00:00:00.000Z'};
    sqlite.prepare('UPDATE security_roles SET body=? WHERE id=?').run(JSON.stringify(expiredRole),role.id!);
    assert.equal(f.jobs.security.policies.resourceAllowedFor(f.member.id,installation.id,'objectType','ServiceRequest'),false);
    sqlite.prepare('UPDATE security_roles SET body=? WHERE id=?').run(role.body!,role.id!);
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[JSON.stringify(expiredRole),role.id]);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c=>postgresTaskResourceViewAllowed(c,principal,task.job.id,policy,'objectType','ServiceRequest',staged)),false);
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[role.body,role.id]);
    // Historical task models must not revive a namespace role for an old
    // security policy version. SQLite evaluates roles against the reviewed
    // current security model, not the task's historical read model.
    const legacy=f.jobs.definitions.legacy(),historicalJob={...task.job,delegation:{...task.job.delegation!,backendVersion:'historical',ontologyRelease:legacy.ref}};
    assert.notEqual(legacy.model.ref.digest,f.jobs.security.model.ref.digest);
    const historicalRole={...JSON.parse(String(role.body)),resource:{kind:'namespace',id:legacy.model.ref.id,version:legacy.model.ref.digest}};
    sqlite.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(historicalJob),task.job.id);
    sqlite.prepare('UPDATE security_roles SET body=? WHERE id=?').run(JSON.stringify(historicalRole),role.id!);
    assert.equal(f.jobs.security.policies.resourceAllowedFor(f.member.id,installation.id,'objectType','ServiceRequest'),false);
    sqlite.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(task.job),task.job.id);
    sqlite.prepare('UPDATE security_roles SET body=? WHERE id=?').run(role.body!,role.id!);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[JSON.stringify(historicalJob),task.job.id]);
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[JSON.stringify(historicalRole),role.id]);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c=>postgresTaskResourceViewAllowed(c,principal,task.job.id,policy,'objectType','ServiceRequest',staged)),false);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[JSON.stringify(task.job),task.job.id]);
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[role.body,role.id]);
    await client.query(`INSERT INTO "${schema}".security_roles SELECT 'synthetic-'||n,$1,'{}' FROM generate_series(1,257) n`,[installation.id]);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskResourceViewAllowed(c,principal,task.job.id,policy,'objectType','ServiceRequest')),/OUTPUT_NOT_ALLOWED/);
    await client.query(`DELETE FROM "${schema}".security_roles WHERE id LIKE 'synthetic-%'`);
    await client.query(`UPDATE "${schema}".security_roles SET body=repeat('x',65537) WHERE id=$1`,[role.id]);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskResourceViewAllowed(c,principal,task.job.id,policy,'objectType','ServiceRequest')),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[role.body,role.id]);
    const wrong={...principal,subject:'someone-else'};
    assert.throws(()=>f.jobs.security.agentContext(wrong),/AUTHORIZATION_REQUIRED/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadGrant(c,wrong,task.job.id,policy)),/AUTHORIZATION_REQUIRED/);
    const alteredScopes={...principal,scopes:principal.scopes.filter(scope=>scope!=='tasks:read')};
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadGrant(c,alteredScopes,task.job.id,policy)),/Required scope: tasks:read/);
    sqlite.prepare('UPDATE security_subjects SET epoch=epoch+1 WHERE installation_id=?').run(installation.id);
    assert.throws(()=>f.jobs.security.agentContext(principal),/POLICY_CHANGED/);
    sqlite.prepare('UPDATE security_subjects SET epoch=epoch-1 WHERE installation_id=?').run(installation.id);
    await client.query(`UPDATE "${schema}".security_subjects SET epoch=epoch+1 WHERE installation_id=$1`,[installation.id]);
    await assert.rejects(read(),/POLICY_CHANGED/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.ontology(c,principal,task.job.id,policy)),/POLICY_CHANGED/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal'])),/POLICY_CHANGED/);
    await client.query(`UPDATE "${schema}".security_subjects SET epoch=epoch-1 WHERE installation_id=$1`,[installation.id]);
    const grantBody=JSON.stringify(readGrant),field=`"taskId":"${task.job.id}"`,duplicate=grantBody.replace(field,`${field},${field}`); assert.notEqual(duplicate,grantBody);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[duplicate,task.grant.id]);
    await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[grantBody,task.grant.id]);
    const fence:[string,string,string,string,number,string]=[randomUUID(),f.owner,'installation',installation.id,1,'pending'];
    sqlite.prepare('INSERT INTO security_fences VALUES(?,?,?,?,?,?)').run(...fence);
    assert.throws(()=>f.jobs.security.agentContext(principal),/ACCESS_REVOKED/);
    sqlite.prepare('DELETE FROM security_fences WHERE id=?').run(fence[0]);
    await client.query(`INSERT INTO "${schema}".security_fences VALUES($1,$2,$3,$4,$5,$6)`,fence);
    await assert.rejects(read(),/ACCESS_REVOKED/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadOntology(c,principal,task.job.id,policy)),/ACCESS_REVOKED/);
    await client.query(`DELETE FROM "${schema}".security_fences WHERE id=$1`,[fence[0]]);
    sqlite.prepare('UPDATE security_grants SET expires_at=0 WHERE id=?').run(task.grant.id);
    assert.throws(()=>f.jobs.security.taskGrant(f.jobs.security.agentContext(principal),task.job.id),/AUTHORIZATION_REQUIRED/);
    sqlite.prepare('UPDATE security_grants SET expires_at=? WHERE id=?').run(Date.parse(task.grant.expiresAt),task.grant.id);
    await client.query(`UPDATE "${schema}".security_grants SET expires_at=0 WHERE id=$1`,[task.grant.id]); await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    await client.query(`UPDATE "${schema}".security_grants SET expires_at=$1 WHERE id=$2`,[Date.parse(task.grant.expiresAt),task.grant.id]);
    const jobBody=String(sqlite.prepare('SELECT body FROM jobs WHERE id=?').get(task.job.id)!.body),changedJob=JSON.parse(jobBody); changedJob.delegation.request.revision++;
    sqlite.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(changedJob),task.job.id);
    assert.throws(()=>f.jobs.security.taskGrant(f.jobs.security.agentContext(principal),task.job.id),/AUTHORIZATION_REQUIRED/);
    sqlite.prepare('UPDATE jobs SET body=? WHERE id=?').run(jobBody,task.job.id);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[JSON.stringify(changedJob),task.job.id]); await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[jobBody,task.job.id]);
    const request=JSON.stringify(JSON.parse(jobBody).delegation.request), ambiguousRequest=request.replace('"revision":1','"revision":1,"revision":1');
    const ambiguousJob=jobBody.replace(`"request":${request}`,`"request":${ambiguousRequest}`); assert.notEqual(ambiguousJob,jobBody);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[ambiguousJob,task.job.id]); await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[jobBody,task.job.id]);
    const parent=f.jobs.security.agentGrant(installation.id);
    sqlite.prepare("UPDATE security_grants SET state='revoked' WHERE id=?").run(parent.id);
    assert.throws(()=>f.jobs.security.agentContext(principal),/AUTHORIZATION_REQUIRED/);
    sqlite.prepare("UPDATE security_grants SET state='active' WHERE id=?").run(parent.id);
    await client.query(`UPDATE "${schema}".security_grants SET state='revoked' WHERE id=$1`,[parent.id]); await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    await client.query(`UPDATE "${schema}".security_grants SET state='active' WHERE id=$1`,[parent.id]);
    const scoped=structuredClone(principal);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c=>withPostgresTaskReadGrant(c,scoped,task.job.id,policy,async()=>{scoped.subject='changed';return 'scoped';})),'scoped');
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>withPostgresTaskReadGrant(c,principal,task.job.id,policy,async()=>{
      await c.query(`UPDATE "${schema}".security_grants SET revision=revision+1 WHERE id=$1`,[task.grant.id]); return 'not exposed';
    })),/POLICY_CHANGED/);
    assert.equal((await read()).grant.revision,original.revision,'failed post-check rolls back the action');
  } finally {await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await client.end();sqlite.close();f.close();}
});
