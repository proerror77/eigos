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
import { sourceMatchesObservation } from '../packages/security/source-policy.js';
import { taskContextMembers } from '../packages/security/task-context.js';
import { postgresTaskContextMembers } from '../packages/postgres/task-context-membership.js';
import { postgresTaskContextBindingCandidate } from '../packages/postgres/task-context-binding.js';
import { digest } from '../packages/core/delegation.js';
import { submissionDigest } from '../packages/security/submission-digest.js';

test('PostgreSQL task read admission preserves identity, revocation and grant fences', {skip:process.env.EIGOS_TEST_PG_LOCAL !== '1'}, async () => {
  // Remote setup and large-row validation may outlast the synthetic lease;
  // keep the fixture's copied projection valid throughout those checks.
  const clockOffset=1200000;
  const f=securityFixture(()=>Date.now()+clockOffset), installation=f.installation('Synthetic read',3600000),sourceExpiry=new Date(Date.now()+3600000).toISOString();
  f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:['brief.prepare'],resources:[{type:'ServiceRequest',fields:['requestId','originalGoal']},{type:'Place',fields:['placeId','name','address']},{type:'RequestSpecification',fields:['id','displayTitle','requestRevision']},{type:'RegisteredCapability',fields:['id','name','capabilityRef','contextRequestId']},{type:'RegisteredActionType',fields:['id','displayTitle','actionId']}],sourceBindingIds:['synthetic-source'],channels:['agent_response','registered_model'],expiresAt:sourceExpiry});
  f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId:'synthetic-source',programId:'brief.prepare',programDigest:'b'.repeat(64),operations:['synthetic.read'],outputTypes:['ServiceRequest','Place'],expiresAt:sourceExpiry},f.jobs.security.policies.revision());
  const task=f.task(installation.id), principal={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
  assert(principal.access.actorKind==='agent');const parentGrantId=principal.access.agentGrant.id;
  f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'objectType',id:'ServiceRequest',version:f.jobs.security.policies.resourceVersion('objectType','ServiceRequest')},role:'Viewer',expiresAt:new Date(Date.now()+3600000).toISOString()},f.jobs.security.policies.revision());
  for(const type of ['Place','RequestSpecification','RegisteredCapability','RegisteredActionType'])f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'objectType',id:type,version:f.jobs.security.policies.resourceVersion('objectType',type)},role:'Viewer',expiresAt:new Date(Date.now()+3600000).toISOString()},f.jobs.security.policies.revision());
  f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'actionType',id:'ReadCommerceContext',version:f.jobs.security.policies.resourceVersion('actionType','ReadCommerceContext')},role:'Viewer',expiresAt:sourceExpiry},f.jobs.security.policies.revision());
  const recipient={classification:'sensitive' as const,markings:['member_private','personal_data'] as const,channels:['agent_response'] as const,expiresAt:new Date(Date.now()+3600000).toISOString()};
  f.jobs.security.policies.setRecipient(installation.id,recipient,f.jobs.security.policies.revision());
  for(const field of ['*','originalGoal','requestId']) f.jobs.security.policies.restrictObject({ownerKey:f.owner,object:{type:'ServiceRequest',id:task.job.id},expectedObjectRevision:1,field,classification:'sensitive',requiredMarkings:['personal_data'],channels:['agent_response']},f.jobs.security.policies.revision());
  const sqlite=new DatabaseSync(f.database), schema=`eigos_business_${randomUUID().replaceAll('-','')}`;
  if(process.env.EIGOS_TEST_REPORT_SCHEMA==='1')console.log(`Synthetic PostgreSQL schema: ${schema}`);
  const stored=sqlite.prepare('SELECT body FROM security_grants WHERE id=?').get(task.grant.id)!;
  const readGrant=JSON.parse(String(stored.body)); readGrant.operations.push('task.result.read'); readGrant.channels.push('agent_response');
  readGrant.outputs.push({programId:'brief.prepare',programDigest:'b'.repeat(64),sourceBindingId:'synthetic-source',type:'Place',fields:['placeId','name']});
  sqlite.prepare('UPDATE security_grants SET body=? WHERE id=?').run(JSON.stringify(readGrant),task.grant.id);
  // Preserve a realistic order: two prior task grants precede the current one.
  sqlite.prepare('UPDATE security_grants SET rowid=100 WHERE id=?').run(task.grant.id);
  const priorIds=[randomUUID(),randomUUID()];
  for(const [index,id] of priorIds.entries())sqlite.prepare(`INSERT INTO security_grants(rowid,id,kind,owner,member_id,installation_id,parent_id,parent_revision,revision,state,expires_at,body)
    SELECT ?,?,kind,owner,member_id,installation_id,parent_id,parent_revision,revision,'revoked',expires_at,json_set(body,'$.id',?,'$.status','revoked') FROM security_grants WHERE id=?`)
    .run(10+index,id,id,task.grant.id);
  const policy=f.jobs.security.policies.definitionDigest, authority={id:randomUUID(),revision:1,digest:'a'.repeat(64)};
  const client=new pg.Client(process.env.EIGOS_TEST_PG_CA_FILE?{ssl:{ca:readFileSync(process.env.EIGOS_TEST_PG_CA_FILE,'utf8'),rejectUnauthorized:true}}:{}); await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".runtime_authority(slot BIGINT PRIMARY KEY,id TEXT,revision BIGINT,configuration_digest TEXT)`);
    await client.query(`INSERT INTO "${schema}".runtime_authority VALUES(1,$1,$2,$3)`,[authority.id,authority.revision,authority.digest]); await installPostgresAuthorityLock(client,schema);
    await client.query(`CREATE FUNCTION "${schema}".eigos_try_jsonb(value TEXT) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE STRICT AS $$ BEGIN RETURN value::jsonb; EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR untranslatable_character THEN RETURN NULL; END $$`);
    for(const table of ['jobs','security_settings','security_manager','security_subjects','security_fences','security_grants','security_policy','security_policy_definitions','security_roles','security_recipients','security_sources','security_object_origins','security_labels','security_bindings','ontology_objects','ontology_links','ontology_definition_releases','ontology_definition_release_aliases','ontology_definition_bootstrap','ontology_namespaces','ontology_task_read_projections']) {
      const cols=sqlite.prepare(`PRAGMA table_info("${table}")`).all();
      const rowIdentity=table==='security_grants';
      await client.query(`CREATE TABLE "${schema}"."${table}" (${cols.map(c=>`"${c.name}" ${String(c.type).toUpperCase()==='INTEGER'?'BIGINT':'TEXT'}`).join(',')}${rowIdentity?',"__eigos_rowid" BIGINT NOT NULL':''})`);
      const select=rowIdentity?`SELECT rowid AS __eigos_rowid,* FROM "${table}" ORDER BY rowid`:`SELECT * FROM "${table}"`;
      for(const row of sqlite.prepare(select).iterate()) {
        const values=cols.map(c=>row[String(c.name)]);if(rowIdentity)values.push(row.__eigos_rowid);
        await client.query(`INSERT INTO "${schema}"."${table}" VALUES (${values.map((_,i)=>`$${i+1}`).join(',')})`,values);
      }
    }
    const staged=new StagedKernelBuilder();
    assert.throws(()=>createStagedPostgresTaskReader(undefined as unknown as StagedKernelBuilder),/Invalid staged kernel builder/);
    assert.throws(()=>createStagedPostgresTaskReader(staged),/not ready/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadOntology(c,principal,task.job.id,policy,staged)),/not ready/);
    for(let stage=0;stage<StagedKernelBuilder.stages;stage++)staged.step(stage);
    const stagedReader=createStagedPostgresTaskReader(staged);
    const contextObjects=[
      {type:'RequestSpecification',id:'synthetic-spec',properties:{requestRevision:1}},
      {type:'RequestInstruction',id:'synthetic-instruction',properties:{introducedRevision:1}},
      {type:'RequestInstruction',id:'synthetic-future',properties:{introducedRevision:2}},
      {type:'ExecutionContext',id:'synthetic-context',properties:{requestRevision:1}},
      {type:'RequestInstruction',id:'synthetic-unlinked',properties:{introducedRevision:1}},
      {type:'RegisteredCapability',id:`capability:${'a'.repeat(64)}`,properties:{definitionDigest:'a'.repeat(64),capabilityRef:{id:'brief.prepare'}}},
      {type:'RegisteredActionType',id:'synthetic-action',properties:{actionId:'ReadCommerceContext'}},
    ];
    for(const object of contextObjects){
      const body=JSON.stringify({source:{kind:'task',id:object.type==='RegisteredCapability'?'another-task':task.job.id},properties:object.properties});
      sqlite.prepare('INSERT INTO ontology_objects(owner,type,id,revision,definition_digest,body) VALUES(?,?,?,?,?,?)').run(f.owner,object.type,object.id,1,'a'.repeat(64),body);
      await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,$2,$3,1,$4,$5)`,[f.owner,object.type,object.id,'a'.repeat(64),body]);
    }
    const contextLinks=[['RequestSpecificationInstruction','RequestSpecification','synthetic-spec','RequestInstruction','synthetic-instruction'],['RequestSpecificationInstruction','RequestSpecification','synthetic-spec','RequestInstruction','synthetic-future'],['ExecutionStepAction','RequestSpecification','synthetic-spec','RegisteredActionType','synthetic-action'],['CapabilityRequest','RegisteredCapability',`capability:${'a'.repeat(64)}`,'ServiceRequest',task.job.id]];
    for(const [type,fromType,fromId,toType,toId] of contextLinks){
      sqlite.prepare('INSERT INTO ontology_links(owner,type,from_type,from_id,to_type,to_id,definition_digest) VALUES(?,?,?,?,?,?,?)').run(f.owner,type!,fromType!,fromId!,toType!,toId!,'a'.repeat(64));
      await client.query(`INSERT INTO "${schema}".ontology_links(owner,type,from_type,from_id,to_type,to_id,definition_digest) VALUES($1,$2,$3,$4,$5,$6,$7)`,[f.owner,type,fromType,fromId,toType,toId,'a'.repeat(64)]);
    }
    const members=()=>postgresBusinessTransaction(client,schema,authority,c=>postgresTaskContextMembers(c,principal,task.job.id,policy,staged));
    const sortRefs=(refs:{type:string;id:string}[])=>refs.map(ref=>JSON.stringify([ref.type,ref.id])).sort();
    assert.deepEqual(sortRefs(await members()),sortRefs([...taskContextMembers(sqlite,f.owner,task.job.id,1).values()]));
    const memberKeys=sortRefs(await members());assert(memberKeys.includes(JSON.stringify(['RequestInstruction','synthetic-instruction'])));assert(memberKeys.includes(JSON.stringify(['RegisteredCapability',`capability:${'a'.repeat(64)}`])));assert(!memberKeys.includes(JSON.stringify(['RequestInstruction','synthetic-future'])));assert(!memberKeys.includes(JSON.stringify(['RequestInstruction','synthetic-unlinked'])));
    const duplicateSource=`{"source":{"kind":"task","id":"another-task","id":${JSON.stringify(task.job.id)}},"properties":{"requestRevision":1}}`;
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,'RequestSpecification','ambiguous-source',1,$2,$3)`,[f.owner,'a'.repeat(64),duplicateSource]);
    await assert.rejects(members(),/POLICY_CHANGED/);
    await client.query(`DELETE FROM "${schema}".ontology_objects WHERE owner=$1 AND type='RequestSpecification' AND id='ambiguous-source'`,[f.owner]);
    await client.query(`UPDATE "${schema}".ontology_objects SET body='invalid' WHERE owner=$1 AND type='RequestInstruction' AND id='synthetic-instruction'`,[f.owner]);
    await assert.rejects(members(),/POLICY_CHANGED/);
    const instruction=JSON.stringify({source:{kind:'task',id:task.job.id},properties:{introducedRevision:1}});
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type='RequestInstruction' AND id='synthetic-instruction'`,[instruction,f.owner]);
    const oversized=JSON.stringify({source:{kind:'task',id:task.job.id},properties:{introducedRevision:1},padding:'x'.repeat(1048577)});
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type='RequestInstruction' AND id='synthetic-instruction'`,[oversized,f.owner]);
    await assert.rejects(members(),/INSUFFICIENT_ACCESS/);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type='RequestInstruction' AND id='synthetic-instruction'`,[instruction,f.owner]);
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,'RequestInstruction',$2,1,$3,$4)`,[f.owner,'x'.repeat(801),'a'.repeat(64),instruction]);
    await assert.rejects(members(),/INSUFFICIENT_ACCESS/);
    await client.query(`DELETE FROM "${schema}".ontology_objects WHERE owner=$1 AND type='RequestInstruction' AND id=$2`,[f.owner,'x'.repeat(801)]);
    await client.query(`INSERT INTO "${schema}".ontology_links(owner,type,from_type,from_id,to_type,to_id,definition_digest) VALUES($1,'RequestSpecificationInstruction','RequestSpecification','synthetic-spec','RequestInstruction',$2,$3)`,[f.owner,'x'.repeat(801),'a'.repeat(64)]);
    await assert.rejects(members(),/INSUFFICIENT_ACCESS/);
    await client.query(`DELETE FROM "${schema}".ontology_links WHERE owner=$1 AND type='RequestSpecificationInstruction' AND to_id=$2`,[f.owner,'x'.repeat(801)]);
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) SELECT $1,'RequestInstruction','overflow-'||n,1,$2,$3 FROM generate_series(1,2001) n`,[f.owner,'a'.repeat(64),instruction]);
    await assert.rejects(members(),/INSUFFICIENT_ACCESS/);
    await client.query(`DELETE FROM "${schema}".ontology_objects WHERE owner=$1 AND type='RequestInstruction' AND id LIKE 'overflow-%'`,[f.owner]);
    await client.query(`INSERT INTO "${schema}".ontology_links(owner,type,from_type,from_id,to_type,to_id,definition_digest) SELECT $1,'RequestSpecificationInstruction','RequestSpecification','synthetic-spec','RequestInstruction','overflow-'||n,$2 FROM generate_series(1,4001) n`,[f.owner,'a'.repeat(64)]);
    await assert.rejects(members(),/INSUFFICIENT_ACCESS/);
    await client.query(`DELETE FROM "${schema}".ontology_links WHERE owner=$1 AND type='RequestSpecificationInstruction' AND to_id LIKE 'overflow-%'`,[f.owner]);
    const rootBinding=JSON.parse(String(sqlite.prepare("SELECT body FROM security_bindings WHERE grant_id=? AND type='ServiceRequest' AND object_id=?").get(task.grant.id,task.job.id)!.body));
    const metadataEnvelope={...rootBinding.envelope,channels:['agent_response','registered_model'],lineage:[],lineageComplete:true};
    const specRef={type:'RequestSpecification',id:'synthetic-spec'},capRef={type:'RegisteredCapability',id:`capability:${'a'.repeat(64)}`},actionRef={type:'RegisteredActionType',id:'synthetic-action'};
    const specBody=String(sqlite.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(f.owner,specRef.type,specRef.id)!.body);
    const specBinding={object:specRef,revision:1,fields:['id','displayTitle','requestRevision'],sourceBindingId:'task_context',envelope:rootBinding.envelope,inputEnvelope:metadataEnvelope,
      projectionOrigin:{version:1,contentDigest:digest(['a'.repeat(64),JSON.parse(specBody)]),linksDigest:'b'.repeat(64),inputDigest:digest(metadataEnvelope)}};
    const capBinding={object:capRef,revision:1,fields:['id','name','capabilityRef','contextRequestId'],sourceBindingId:'task_context',envelope:rootBinding.envelope};
    const actionBinding={object:actionRef,revision:1,fields:['id','displayTitle','actionId'],sourceBindingId:'task_context',envelope:rootBinding.envelope};
    for(const value of [specBinding,capBinding,actionBinding]){
      sqlite.prepare('INSERT INTO security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES(?,?,?,?,?,?,?,?)').run(task.grant.id,f.owner,task.job.id,1,value.object.type,value.object.id,1,JSON.stringify(value));
      await client.query(`INSERT INTO "${schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4,$5,1,$6)`,[task.grant.id,f.owner,task.job.id,value.object.type,value.object.id,JSON.stringify(value)]);
    }
    const contextCandidate=(item:{type:string;id:string})=>postgresBusinessTransaction(client,schema,authority,c=>postgresTaskContextBindingCandidate(c,principal,task.job.id,policy,item,staged));
    const sqliteContext=(item:{type:string;id:string})=>f.jobs.security.withAgent(principal,task.job.id,'task.result.read',scope=>f.jobs.security.policies.binding(scope,item));
    for(const item of [specRef,capRef,actionRef]){
      const expected=sqliteContext(item);assert(expected?.fields.length,item.type);
      const actual=await contextCandidate(item);assert(actual);assert.deepEqual(actual.fields,expected.fields);assert.deepEqual(actual.object,item);
      if(item.type==='RegisteredCapability')assert(!actual.fields.includes('contextRequestId'));
    }
    const alteredSpec={...specBinding,projectionOrigin:{...specBinding.projectionOrigin,contentDigest:'c'.repeat(64)}};
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(JSON.stringify(alteredSpec),task.grant.id,specRef.type,specRef.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(alteredSpec),task.grant.id,specRef.type,specRef.id]);
    assert.throws(()=>sqliteContext(specRef),/POLICY_CHANGED/);await assert.rejects(contextCandidate(specRef),/POLICY_CHANGED/);
    const alteredInput={...specBinding,projectionOrigin:{...specBinding.projectionOrigin,inputDigest:'d'.repeat(64)}};
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(JSON.stringify(alteredInput),task.grant.id,specRef.type,specRef.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(alteredInput),task.grant.id,specRef.type,specRef.id]);
    assert.throws(()=>sqliteContext(specRef),/POLICY_CHANGED/);await assert.rejects(contextCandidate(specRef),/POLICY_CHANGED/);
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(JSON.stringify(specBinding),task.grant.id,specRef.type,specRef.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(specBinding),task.grant.id,specRef.type,specRef.id]);
    const foreignSpec=JSON.stringify({...JSON.parse(specBody),source:{kind:'task',id:'other-task'}});
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(foreignSpec,f.owner,specRef.type,specRef.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[foreignSpec,f.owner,specRef.type,specRef.id]);
    assert.equal(sqliteContext(specRef),undefined);assert.equal(await contextCandidate(specRef),undefined);
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(specBody,f.owner,specRef.type,specRef.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[specBody,f.owner,specRef.type,specRef.id]);
    const capBody=String(sqlite.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(f.owner,capRef.type,capRef.id)!.body);
    const foreignCap=JSON.parse(capBody);foreignCap.properties.capabilityRef={id:'unapproved-capability'};
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(JSON.stringify(foreignCap),f.owner,capRef.type,capRef.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[JSON.stringify(foreignCap),f.owner,capRef.type,capRef.id]);
    assert.equal(sqliteContext(capRef),undefined);assert.equal(await contextCandidate(capRef),undefined);
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(capBody,f.owner,capRef.type,capRef.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[capBody,f.owner,capRef.type,capRef.id]);
    const actionBody=String(sqlite.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(f.owner,actionRef.type,actionRef.id)!.body);
    const foreignAction=JSON.parse(actionBody);foreignAction.properties.actionId='UnapprovedAction';
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(JSON.stringify(foreignAction),f.owner,actionRef.type,actionRef.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[JSON.stringify(foreignAction),f.owner,actionRef.type,actionRef.id]);
    assert.equal(sqliteContext(actionRef),undefined);assert.equal(await contextCandidate(actionRef),undefined);
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(actionBody,f.owner,actionRef.type,actionRef.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[actionBody,f.owner,actionRef.type,actionRef.id]);
    const place={type:'Place',id:'retained-place'},placeBody=JSON.stringify({source:{kind:'provider',id:'synthetic-source'},properties:{placeId:'retained-place',name:'Synthetic',address:'private'}});
    sqlite.prepare('INSERT INTO ontology_objects(owner,type,id,revision,definition_digest,body) VALUES(?,?,?,?,?,?)').run(f.owner,place.type,place.id,1,'a'.repeat(64),placeBody);
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,$2,$3,1,$4,$5)`,[f.owner,place.type,place.id,'a'.repeat(64),placeBody]);
    const retainedBase={object:place,revision:1,fields:['placeId','name','address'],sourceBindingId:'synthetic-source',envelope:rootBinding.envelope};
    const earlier={...retainedBase,fields:['placeId']};
    for(const [index,value] of [earlier,retainedBase].entries()){
      sqlite.prepare('INSERT INTO security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES(?,?,?,?,?,?,?,?)').run(priorIds[index]!,f.owner,task.job.id,1,place.type,place.id,1,JSON.stringify(value));
      await client.query(`INSERT INTO "${schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4,$5,1,$6)`,[priorIds[index],f.owner,task.job.id,place.type,place.id,JSON.stringify(value)]);
    }
    const submission={taskId:task.job.id,requestRevision:1,contentDigest:submissionDigest(task.job.delegation!.request)};
    const retainedOrigin={programId:'brief.prepare',programDigest:'b'.repeat(64),sourceBindingId:'synthetic-source',inputEnvelope:{...metadataEnvelope,submission}};
    sqlite.prepare('INSERT INTO security_object_origins(owner,type,object_id,object_revision,body) VALUES(?,?,?,?,?)').run(f.owner,place.type,place.id,1,JSON.stringify(retainedOrigin));
    await client.query(`INSERT INTO "${schema}".security_object_origins(owner,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4)`,[f.owner,place.type,place.id,JSON.stringify(retainedOrigin)]);
    const retained=(item:{type:string;id:string},historical=false)=>postgresBusinessTransaction(client,schema,authority,c=>stagedReader.retainedBindingEvidence(c,principal,task.job.id,policy,item,historical));
    const privatePolicy=f.jobs.security.policies as unknown as {retainedBinding:(scope:unknown,item:{type:string;id:string},historical:boolean)=>unknown};
    const sqliteRetained=(item:{type:string;id:string},historical=false)=>f.jobs.security.withAgent(principal,task.job.id,'task.result.read',scope=>privatePolicy.retainedBinding(scope,item,historical));
    const retainedPlace=await retained(place);assert.deepEqual(retainedPlace,sqliteRetained(place));assert.deepEqual(retainedPlace?.fields,['placeId','name']);
    const retainedFields=()=>postgresBusinessTransaction(client,schema,authority,c=>stagedReader.retainedFieldCandidates(c,principal,task.job.id,policy,place));
    assert.deepEqual((await retainedFields())?.fields,['placeId','name']);
    const recipientRow=sqlite.prepare('SELECT body FROM security_recipients WHERE installation_id=?').get(installation.id)!;
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[JSON.stringify({...recipient,channels:['registered_model']}),installation.id]);
    assert.equal(await retainedFields(),undefined);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[recipientRow.body,installation.id]);
    const retainedSource=()=>postgresBusinessTransaction(client,schema,authority,c=>stagedReader.sourceObservationAllowed(c,principal,task.job.id,policy,place));
    assert.equal(sourceMatchesObservation(f.jobs.security.policies.sources(f.owner,installation.id),retainedOrigin,place.type),true);
    assert.equal(await retainedSource(),true);
    sqlite.prepare("UPDATE security_sources SET state='revoked' WHERE owner=? AND installation_id=?").run(f.owner,installation.id);
    await client.query(`UPDATE "${schema}".security_sources SET state='revoked' WHERE owner=$1 AND installation_id=$2`,[f.owner,installation.id]);
    assert.equal(sourceMatchesObservation(f.jobs.security.policies.sources(f.owner,installation.id),retainedOrigin,place.type),false);assert.equal(await retainedSource(),false);
    sqlite.prepare("UPDATE security_sources SET state='active' WHERE owner=? AND installation_id=?").run(f.owner,installation.id);
    await client.query(`UPDATE "${schema}".security_sources SET state='active' WHERE owner=$1 AND installation_id=$2`,[f.owner,installation.id]);
    const foreignGrant=randomUUID(),foreignInstallation=randomUUID();
    sqlite.prepare(`INSERT INTO security_grants(rowid,id,kind,owner,member_id,installation_id,parent_id,parent_revision,revision,state,expires_at,body)
      SELECT 110,?,kind,owner,member_id,?,parent_id,parent_revision,revision,'revoked',expires_at,body FROM security_grants WHERE id=?`).run(foreignGrant,foreignInstallation,task.grant.id);
    await client.query(`INSERT INTO "${schema}".security_grants(id,kind,owner,member_id,installation_id,parent_id,parent_revision,revision,state,expires_at,body,__eigos_rowid)
      SELECT $1,kind,owner,member_id,$2,parent_id,parent_revision,revision,'revoked',expires_at,body,110 FROM "${schema}".security_grants WHERE id=$3`,[foreignGrant,foreignInstallation,task.grant.id]);
    const foreignBinding={...retainedBase,fields:['address']};
    sqlite.prepare('INSERT INTO security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES(?,?,?,?,?,?,?,?)').run(foreignGrant,f.owner,task.job.id,1,place.type,place.id,1,JSON.stringify(foreignBinding));
    await client.query(`INSERT INTO "${schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4,$5,1,$6)`,[foreignGrant,f.owner,task.job.id,place.type,place.id,JSON.stringify(foreignBinding)]);
    assert.deepEqual(await retained(place),sqliteRetained(place),'newer evidence from another installation must not be used');
    const storedJob=String(sqlite.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(f.owner,task.job.id)!.body),retainedChangedJob=JSON.parse(storedJob);retainedChangedJob.delegation.request.originalGoal='different synthetic goal';
    sqlite.prepare('UPDATE jobs SET body=? WHERE owner=? AND id=?').run(JSON.stringify(retainedChangedJob),f.owner,task.job.id);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE owner=$2 AND id=$3`,[JSON.stringify(retainedChangedJob),f.owner,task.job.id]);
    assert.equal(sqliteRetained(place),undefined);assert.equal(await retained(place),undefined);assert.equal(await retainedSource(),false);assert.equal(await retainedFields(),undefined);
    sqlite.prepare('UPDATE jobs SET body=? WHERE owner=? AND id=?').run(storedJob,f.owner,task.job.id);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE owner=$2 AND id=$3`,[storedJob,f.owner,task.job.id]);
    const withoutOutput={...readGrant,outputs:[]};
    sqlite.prepare('UPDATE security_grants SET body=? WHERE id=?').run(JSON.stringify(withoutOutput),task.grant.id);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[JSON.stringify(withoutOutput),task.grant.id]);
    assert.equal(sqliteRetained(place),undefined);assert.equal(await retained(place),undefined);assert.equal(await retainedSource(),false);
    sqlite.prepare('UPDATE security_grants SET body=? WHERE id=?').run(JSON.stringify(readGrant),task.grant.id);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[JSON.stringify(readGrant),task.grant.id]);
    const changedOrigin={...retainedOrigin,inputEnvelope:{...retainedOrigin.inputEnvelope,submission:{...submission,contentDigest:'c'.repeat(64)}}};
    sqlite.prepare('UPDATE security_object_origins SET body=? WHERE owner=? AND type=? AND object_id=? AND object_revision=1').run(JSON.stringify(changedOrigin),f.owner,place.type,place.id);
    await client.query(`UPDATE "${schema}".security_object_origins SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND object_revision=1`,[JSON.stringify(changedOrigin),f.owner,place.type,place.id]);
    assert.equal(sqliteRetained(place),undefined);assert.equal(await retained(place),undefined);assert.equal(await retainedSource(),false);
    sqlite.prepare('UPDATE security_object_origins SET body=? WHERE owner=? AND type=? AND object_id=? AND object_revision=1').run(JSON.stringify(retainedOrigin),f.owner,place.type,place.id);
    await client.query(`UPDATE "${schema}".security_object_origins SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND object_revision=1`,[JSON.stringify(retainedOrigin),f.owner,place.type,place.id]);
    const wrongTask={...retainedBase,sourceBindingId:'task_submission'};
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(JSON.stringify(wrongTask),priorIds[1]!,place.type,place.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(wrongTask),priorIds[1],place.type,place.id]);
    assert.equal(sqliteRetained(place),undefined);assert.equal(await retained(place),undefined,'newer invalid evidence must not fall back to an older grant');
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(JSON.stringify(retainedBase),priorIds[1]!,place.type,place.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(retainedBase),priorIds[1],place.type,place.id]);
    const historicalCap={type:'RegisteredCapability',id:`capability:${'f'.repeat(64)}`},historicalCapBody=JSON.stringify({source:{kind:'task',id:'previous-task'},properties:{definitionDigest:'f'.repeat(64)}});
    const historicalBinding={object:historicalCap,revision:1,fields:['id','name'],sourceBindingId:'task_context',envelope:rootBinding.envelope};
    sqlite.prepare('INSERT INTO ontology_objects(owner,type,id,revision,definition_digest,body) VALUES(?,?,?,?,?,?)').run(f.owner,historicalCap.type,historicalCap.id,1,'a'.repeat(64),historicalCapBody);
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,$2,$3,1,$4,$5)`,[f.owner,historicalCap.type,historicalCap.id,'a'.repeat(64),historicalCapBody]);
    sqlite.prepare('INSERT INTO security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES(?,?,?,?,?,?,?,?)').run(priorIds[1]!,f.owner,task.job.id,1,historicalCap.type,historicalCap.id,1,JSON.stringify(historicalBinding));
    await client.query(`INSERT INTO "${schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4,$5,1,$6)`,[priorIds[1],f.owner,task.job.id,historicalCap.type,historicalCap.id,JSON.stringify(historicalBinding)]);
    assert.equal(await retained(historicalCap),undefined);assert.equal(sqliteRetained(historicalCap),undefined);
    assert.deepEqual(await retained(historicalCap,true),sqliteRetained(historicalCap,true));
    const projection={type:'GoalCoverage',id:'retained-projection'},projectionBody=JSON.stringify({source:{kind:'task',id:task.job.id},properties:{requestRevision:1}});
    const projectionBinding={object:projection,revision:1,fields:['id','displayTitle'],sourceBindingId:'task_projection',envelope:rootBinding.envelope};
    sqlite.prepare('INSERT INTO ontology_objects(owner,type,id,revision,definition_digest,body) VALUES(?,?,?,?,?,?)').run(f.owner,projection.type,projection.id,1,'a'.repeat(64),projectionBody);
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,$2,$3,1,$4,$5)`,[f.owner,projection.type,projection.id,'a'.repeat(64),projectionBody]);
    sqlite.prepare('INSERT INTO security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES(?,?,?,?,?,?,?,?)').run(priorIds[1]!,f.owner,task.job.id,1,projection.type,projection.id,1,JSON.stringify(projectionBinding));
    await client.query(`INSERT INTO "${schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4,$5,1,$6)`,[priorIds[1],f.owner,task.job.id,projection.type,projection.id,JSON.stringify(projectionBinding)]);
    assert.deepEqual(await retained(projection),sqliteRetained(projection));
    const laterProjection=JSON.stringify({source:{kind:'task',id:task.job.id},properties:{requestRevision:2}});
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(laterProjection,f.owner,projection.type,projection.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[laterProjection,f.owner,projection.type,projection.id]);
    assert.equal(sqliteRetained(projection),undefined);assert.equal(await retained(projection),undefined);
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(projectionBody,f.owner,projection.type,projection.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[projectionBody,f.owner,projection.type,projection.id]);
    // Remote retained-evidence validation can finish on one bounded connection
    // without replaying the independent admission/role/clearance suite.
    if(process.env.EIGOS_TEST_RETAINED_ONLY==='1')return;
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
    const bindingRow=sqlite.prepare('SELECT body FROM security_bindings WHERE grant_id=? AND type=? AND object_id=?').get(task.grant.id,ref.type,ref.id)!;
    const binding=()=>postgresBusinessTransaction(client,schema,authority,c=>stagedReader.directBindingEvidence(c,principal,task.job.id,policy,ref));
    assert.deepEqual(await binding(),JSON.parse(String(bindingRow.body)));
    const candidateFields=()=>postgresBusinessTransaction(client,schema,authority,c=>stagedReader.directFieldCandidates(c,principal,task.job.id,policy,ref));
    const sqliteFields=()=>f.jobs.security.withAgent(principal,task.job.id,'task.result.read',scope=>f.jobs.security.policies.binding(scope,ref)?.fields);
    const permittedFields=sqliteFields();assert(permittedFields?.includes('requestId') && permittedFields.includes('originalGoal'));
    assert.deepEqual((await candidateFields())?.fields,permittedFields);
    const parentRow=sqlite.prepare('SELECT body FROM security_grants WHERE id=?').get(parentGrantId)!;
    const narrowedParent=JSON.parse(String(parentRow.body));narrowedParent.resources=[{type:'ServiceRequest',fields:['requestId']}];
    sqlite.prepare('UPDATE security_grants SET body=? WHERE id=?').run(JSON.stringify(narrowedParent),parentGrantId);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[JSON.stringify(narrowedParent),parentGrantId]);
    const narrowedFields=(await candidateFields())?.fields;
    assert.deepEqual(narrowedFields,sqliteFields());assert(!narrowedFields?.includes('originalGoal'));
    sqlite.prepare('UPDATE security_grants SET body=? WHERE id=?').run(parentRow.body!,parentGrantId);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[parentRow.body,parentGrantId]);
    const sqliteRecipient=sqlite.prepare('SELECT body FROM security_recipients WHERE installation_id=?').get(installation.id)!;
    const restrictedRecipient={...recipient,markings:['member_private']};
    sqlite.prepare('UPDATE security_recipients SET body=? WHERE installation_id=?').run(JSON.stringify(restrictedRecipient),installation.id);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[JSON.stringify(restrictedRecipient),installation.id]);
    assert.deepEqual((await candidateFields())?.fields,sqliteFields());
    assert.equal(await candidateFields(),undefined);
    sqlite.prepare('UPDATE security_recipients SET body=? WHERE installation_id=?').run(sqliteRecipient.body!,installation.id);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[sqliteRecipient.body,installation.id]);
    const noAgentChannel={...recipient,channels:['registered_model']};
    sqlite.prepare('UPDATE security_recipients SET body=? WHERE installation_id=?').run(JSON.stringify(noAgentChannel),installation.id);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[JSON.stringify(noAgentChannel),installation.id]);
    assert.deepEqual((await candidateFields())?.fields,sqliteFields());
    assert.equal(await candidateFields(),undefined);
    sqlite.prepare('UPDATE security_recipients SET body=? WHERE installation_id=?').run(sqliteRecipient.body!,installation.id);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[sqliteRecipient.body,installation.id]);
    const fieldLabel=sqlite.prepare("SELECT body FROM security_labels WHERE owner=? AND type=? AND object_id=? AND field='originalGoal'").get(f.owner,ref.type,ref.id)!;
    const internalLabel={...JSON.parse(String(fieldLabel.body)),classification:'internal'};
    sqlite.prepare("UPDATE security_labels SET body=? WHERE owner=? AND type=? AND object_id=? AND field='originalGoal'").run(JSON.stringify(internalLabel),f.owner,ref.type,ref.id);
    await client.query(`UPDATE "${schema}".security_labels SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND field='originalGoal'`,[JSON.stringify(internalLabel),f.owner,ref.type,ref.id]);
    assert.deepEqual((await candidateFields())?.fields,sqliteFields());
    sqlite.prepare("UPDATE security_labels SET body=? WHERE owner=? AND type=? AND object_id=? AND field='originalGoal'").run(fieldLabel.body!,f.owner,ref.type,ref.id);
    await client.query(`UPDATE "${schema}".security_labels SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND field='originalGoal'`,[fieldLabel.body,f.owner,ref.type,ref.id]);
    const bindingWithRestrictedInput=JSON.parse(String(bindingRow.body));
    bindingWithRestrictedInput.inputEnvelope={...bindingWithRestrictedInput.envelope,classification:'sensitive',requiredMarkings:['health'],channels:['agent_response'],lineage:[],lineageComplete:true};
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(JSON.stringify(bindingWithRestrictedInput),task.grant.id,ref.type,ref.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(bindingWithRestrictedInput),task.grant.id,ref.type,ref.id]);
    assert.deepEqual((await candidateFields())?.fields,sqliteFields());
    assert.equal(await candidateFields(),undefined);
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(bindingRow.body!,task.grant.id,ref.type,ref.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[bindingRow.body,task.grant.id,ref.type,ref.id]);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.directBindingEvidence(c,principal,task.job.id,policy,{type:ref.type,id:'absent'})),undefined);
    await client.query(`UPDATE "${schema}".security_bindings SET grant_id='older-grant' WHERE grant_id=$1 AND type=$2 AND object_id=$3`,[task.grant.id,ref.type,ref.id]);
    assert.equal(await binding(),undefined);
    await client.query(`UPDATE "${schema}".security_bindings SET grant_id=$1 WHERE grant_id='older-grant' AND type=$2 AND object_id=$3`,[task.grant.id,ref.type,ref.id]);
    await client.query(`UPDATE "${schema}".security_bindings SET body=repeat('x',1048577) WHERE grant_id=$1 AND type=$2 AND object_id=$3`,[task.grant.id,ref.type,ref.id]);
    await assert.rejects(binding(),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[bindingRow.body,task.grant.id,ref.type,ref.id]);
    const alteredBinding={...JSON.parse(String(bindingRow.body)),object:{...ref,id:'different-object'}};
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(alteredBinding),task.grant.id,ref.type,ref.id]);
    await assert.rejects(binding(),/POLICY_CHANGED/);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[bindingRow.body,task.grant.id,ref.type,ref.id]);
    await client.query(`UPDATE "${schema}".security_bindings SET task_id='different-task' WHERE grant_id=$1 AND type=$2 AND object_id=$3`,[task.grant.id,ref.type,ref.id]);
    await assert.rejects(binding(),/POLICY_CHANGED/);
    await client.query(`UPDATE "${schema}".security_bindings SET task_id=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[task.job.id,task.grant.id,ref.type,ref.id]);
    await client.query(`UPDATE "${schema}".ontology_objects SET revision=2 WHERE owner=$1 AND type=$2 AND id=$3`,[f.owner,ref.type,ref.id]);
    assert.equal(await binding(),undefined);
    await client.query(`UPDATE "${schema}".ontology_objects SET revision=1 WHERE owner=$1 AND type=$2 AND id=$3`,[f.owner,ref.type,ref.id]);
    const origin={programId:'brief.prepare',programDigest:'b'.repeat(64),sourceBindingId:'synthetic-source'};
    const providerBinding={...JSON.parse(String(bindingRow.body)),sourceBindingId:origin.sourceBindingId,sourceObservation:origin};
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(providerBinding),task.grant.id,ref.type,ref.id]);
    const sourceAllowed=()=>postgresBusinessTransaction(client,schema,authority,c=>stagedReader.sourceObservationAllowed(c,principal,task.job.id,policy,ref));
    assert.equal(sourceMatchesObservation(f.jobs.security.policies.sources(f.owner,installation.id),origin,ref.type),true);
    assert.equal(await sourceAllowed(),true);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify({...providerBinding,sourceObservation:{...origin,sourceBindingId:'different-source'}}),task.grant.id,ref.type,ref.id]);
    assert.equal(await sourceAllowed(),false);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(providerBinding),task.grant.id,ref.type,ref.id]);
    await client.query(`UPDATE "${schema}".security_sources SET state='revoked' WHERE installation_id=$1`,[installation.id]);assert.equal(await sourceAllowed(),false);
    await client.query(`UPDATE "${schema}".security_sources SET state='active' WHERE installation_id=$1`,[installation.id]);
    const originalSource=sqlite.prepare('SELECT body FROM security_sources WHERE owner=? AND installation_id=?').get(f.owner,installation.id)!;
    const sourceBody=JSON.parse(String(originalSource.body));
    const updateSource=(body:unknown)=>client.query(`UPDATE "${schema}".security_sources SET body=$1 WHERE installation_id=$2`,[JSON.stringify(body),installation.id]);
    await client.query(`INSERT INTO "${schema}".security_sources(owner,installation_id,binding_id,program_id,state,body) SELECT $1,$2,'overflow-'||n,'program','active',$3 FROM generate_series(1,256) n`,[f.owner,installation.id,originalSource.body]);
    await assert.rejects(sourceAllowed(),/OUTPUT_NOT_ALLOWED/);
    await client.query(`DELETE FROM "${schema}".security_sources WHERE owner=$1 AND installation_id=$2 AND binding_id LIKE 'overflow-%'`,[f.owner,installation.id]);
    await updateSource({...sourceBody,expiresAt:'2000-01-01T00:00:00.000Z'});assert.equal(await sourceAllowed(),false);
    await updateSource({...sourceBody,parentGrant:{...sourceBody.parentGrant,revision:sourceBody.parentGrant.revision+1}});assert.equal(await sourceAllowed(),false);
    await updateSource({...sourceBody,outputTypes:['Place']});assert.equal(await sourceAllowed(),false);
    await updateSource({...sourceBody,bindingId:'different-source'});await assert.rejects(sourceAllowed(),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_sources SET body=repeat('x',65537) WHERE installation_id=$1`,[installation.id]);
    await assert.rejects(sourceAllowed(),/OUTPUT_NOT_ALLOWED/);
    const oldOrigin={...origin,sourceBindingId:'previous-source',programDigest:'c'.repeat(64)};
    const historicalSource={...sourceBody,readbackVersions:[{sourceBindingId:oldOrigin.sourceBindingId,programDigest:oldOrigin.programDigest}]};
    await updateSource(historicalSource);
    sqlite.prepare('UPDATE security_sources SET body=? WHERE owner=? AND installation_id=?').run(JSON.stringify(historicalSource),f.owner,installation.id);
    assert.equal(sourceMatchesObservation(f.jobs.security.policies.sources(f.owner,installation.id),oldOrigin,ref.type),true);
    sqlite.prepare('UPDATE security_sources SET body=? WHERE owner=? AND installation_id=?').run(originalSource.body!,f.owner,installation.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify({...providerBinding,sourceBindingId:oldOrigin.sourceBindingId,sourceObservation:oldOrigin}),task.grant.id,ref.type,ref.id]);
    assert.equal(await sourceAllowed(),true);
    await updateSource(sourceBody);assert.equal(await sourceAllowed(),false);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify({...providerBinding,sourceObservation:undefined}),task.grant.id,ref.type,ref.id]);
    await client.query(`DELETE FROM "${schema}".security_object_origins WHERE owner=$1 AND type=$2 AND object_id=$3 AND object_revision=1`,[f.owner,ref.type,ref.id]);
    await client.query(`INSERT INTO "${schema}".security_object_origins(owner,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4)`,[f.owner,ref.type,ref.id,JSON.stringify(origin)]);
    assert.equal(await sourceAllowed(),true);
    await client.query(`UPDATE "${schema}".security_object_origins SET body='invalid' WHERE owner=$1 AND type=$2 AND object_id=$3 AND object_revision=1`,[f.owner,ref.type,ref.id]);
    await assert.rejects(sourceAllowed(),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[bindingRow.body,task.grant.id,ref.type,ref.id]);
    assert.equal(await sourceAllowed(),false,'task-owned bindings are not provider source permissions');
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
    assert.equal(await candidateFields(),undefined);
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[role.body,role.id]);
    // A role may expire while the final grant recheck is waiting on PostgreSQL.
    // Advance only this test process's clock after the role query completes.
    const realNow=Date.now,shortRole={...JSON.parse(String(role.body)),expiresAt:new Date(realNow()+30000).toISOString()};
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[JSON.stringify(shortRole),role.id]);
    let clockShift=0,sawRole=false;
    const delayedRole=new Proxy(client,{get(target,property){
      if(property==='query')return async(sql:string,values?:unknown[])=>{
        const result=await target.query(sql,values);
        if(!sawRole && sql.includes('.security_roles')){assert(realNow()<Date.parse(shortRole.expiresAt));sawRole=true;clockShift=40000;}
        return result;
      };
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }});
    try {
      Date.now=()=>realNow()+clockShift;
      assert.equal(await postgresBusinessTransaction(delayedRole,schema,authority,c=>postgresTaskResourceViewAllowed(c,principal,task.job.id,policy,'objectType','ServiceRequest',staged)),false);
      assert(sawRole);
    } finally {
      Date.now=realNow;
      await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[role.body,role.id]);
    }
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
    await assert.rejects(binding(),/POLICY_CHANGED/);
    await assert.rejects(sourceAllowed(),/POLICY_CHANGED/);
    await assert.rejects(candidateFields(),/POLICY_CHANGED/);
    await assert.rejects(members(),/POLICY_CHANGED/);
    await assert.rejects(contextCandidate(specRef),/POLICY_CHANGED/);
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
  } finally {
    try {await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}
    finally {try {await client.end();} finally {sqlite.close();f.close();}}
  }
});
