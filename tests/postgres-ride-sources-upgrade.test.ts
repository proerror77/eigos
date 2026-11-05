// Real, disposable LOCAL PostgreSQL/pgvector only; no provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {securityFixture} from './fixtures/security.js';
import {postgresVectorFixture,vectorConnection} from './fixtures/postgres-vectors.js';
import {postgresTlsFixture} from './fixtures/postgres-tls.js';
import {currentKernelImplementation} from '../packages/ontology/definition-store.js';
import {OntologyObjectStore} from '../packages/ontology/object-store.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {roleSchema} from '../packages/security/resource-role.js';
import {postgresBindingIdentity} from '../packages/deployment/postgres-binding.js';
import {digest} from '../packages/core/delegation.js';
import {upgradePostgresRideSources,readPostgresRideUpgrade} from '../packages/postgres/ride-sources-upgrade.js';
import {preparePostgresKernel} from '../packages/postgres/kernel-runtime.js';
import {PostgresDefinitionStore} from '../packages/postgres/definition-store.js';
import {PostgresDatabase} from '../packages/postgres/database.js';
import {PostgresAuthorizationPublisher} from '../packages/postgres/authority-publisher.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresTaskReadService} from '../packages/postgres/task-read-service.js';
import {PostgresPermissionManagement} from '../packages/postgres/permission-management.js';
import {PostgresEmbeddingIndex} from '../packages/postgres/embedding-index.js';
import {embeddedFieldInput} from '../packages/ontology/semantic-retrieval.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {preflightPostgresBinding,verifyPostgresPrimaryActivation} from '../packages/postgres/host-runtime.js';

test('real v29 to v30 ride upgrade preserves activated identity, vector ACL, immutable index and old/new task retrieval',
 {skip:process.env.EIGOS_TEST_VECTOR_PG!=='1'},async()=>{
 const source=securityFixture(Date.now,{unified:true}),sqlite=new DatabaseSync(source.database),model=currentKernelImplementation(),raw=new OntologyObjectStore(sqlite,model,Date.now,undefined,{skipLegacyMigration:true});
 let target:Awaited<ReturnType<typeof postgresVectorFixture>>|undefined,newDatabase:PostgresDatabase|undefined,newPublisher:PostgresAuthorizationPublisher|undefined,control:pg.Pool|undefined,endpoint:Awaited<ReturnType<typeof postgresTlsFixture>>|undefined;
 try{
  const installation=source.installation('Synthetic v30 vector PA',3600000),until=new Date(Date.now()+3600000).toISOString(),refs=[{type:'Place',id:'ride-vector-a'},{type:'Place',id:'ride-vector-b'}];
  const parent=source.coordinator.approveAgentGrant(source.member.id,{installationId:installation.id,capabilityIds:['brief.prepare'],resources:[...['ServiceRequest',...Object.keys(taskContextFields)].map(type=>({type,fields:Object.keys(source.jobs.security.policies.fields(type)).filter(field=>source.jobs.security.policies.fieldPolicy(type,field)!=='internal_only')})),{type:'Place',fields:['placeId','displayTitle','name']}],sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt:until});
  const policy=source.jobs.security.policies;policy.setRole({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},expiresAt:until},policy.revision());policy.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt:until},policy.revision());
  raw.ingest(source.owner,{objects:refs.flatMap(ref=>[{ref,properties:{placeId:ref.id,displayTitle:ref.id,name:ref.id}},{ref:{type:'SourceReceipt',id:'receipt-'+ref.id},properties:{receiptId:'receipt-'+ref.id,displayTitle:'Synthetic',safeSummary:'Synthetic',evidenceLevel:'synthetic'}}]),links:refs.map(ref=>({type:'PlaceEvidence',from:ref,to:{type:'SourceReceipt',id:'receipt-'+ref.id}}))},{kind:'synthetic',id:'ride-vector-fixture',observedAt:new Date().toISOString()});
  target=await postgresVectorFixture(source);const t=target,q=`"${t.schema}"`,beforeIdentity=postgresBindingIdentity(t.binding),beforeBinding=structuredClone(t.binding);
  const namespace=await t.database.run(c=>new PostgresDefinitionStore(c,{builder:t.kernel}).namespace()),namespaceRole=roleSchema.parse({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'namespace',id:model.ref.id,version:t.kernel.trusted().model.ref.digest},expiresAt:until}),invoke=roleSchema.parse({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'function',id:'semanticCandidates',version:'1'},invokeFunctions:['semanticCandidates'],expiresAt:until});
  for(const role of [namespaceRole,invoke])await t.client.query(`INSERT INTO ${q}.security_roles(id,subject_id,body) VALUES($1,$2,$3)`,[randomUUID(),installation.id,JSON.stringify(role)]);
  const program=new DocumentAgentProgram(),catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]);
  async function task(database:PostgresDatabase,publisher:PostgresAuthorizationPublisher,kernel:typeof t.kernel,policyDigest:string,index:PostgresEmbeddingIndex){
   const principal={...source.principal,access:await publisher.authenticate(source.principal,installation.token)},commands=new PostgresTaskCommandService(database,policyDigest,kernel),created=await commands.submit(principal,{goal:'Synthetic vector candidate retrieval',requestId:randomUUID()});
   const issued=(await t.client.query(`SELECT id,revision FROM ${q}.security_grants WHERE kind='task_data' AND body::jsonb->>'taskId'=$1 AND state='active'`,[created.id])).rows[0];assert(issued);
   const management=new PostgresPermissionManagement({database,members:t.members,publisher,catalog,policyDigest,builder:kernel});await management.approveTaskGrant(source.member.id,{taskId:created.id,installationId:installation.id,expectedRequestRevision:1,replaces:{id:issued.id,revision:Number(issued.revision)},expectedAgentGrant:{id:parent.id,revision:parent.revision},takeover:true,inputs:refs.map(object=>({object,objectRevision:1,fields:['placeId','displayTitle','name']})),programIds:[],purpose:'delegated_task',operations:['task.process','task.query','task.result.read','member_asset.read'],channels:['agent_response','registered_model'],expiresAt:until});
   const current={...source.principal,access:await publisher.authenticate(source.principal,installation.token)},release=(await t.client.query(`SELECT body::jsonb#>'{delegation,ontologyRelease}' AS pin FROM ${q}.jobs WHERE id=$1`,[created.id])).rows[0].pin,space={modelId:'synthetic-ride-vectors',modelRevision:'1',dimensions:3,metric:'cosine' as const,inputFormat:'canonical-fields-json-v1' as const},rows=refs.map((object,n)=>({object,expectedObjectRevision:1,...embeddedFieldInput(release,object,1,['name'],raw.read(source.owner,object).properties),vector:n?[0,1,0]:[1,0,0]})),packet={version:1,taskId:created.id,expectedRequestRevision:1,ontologyRelease:release,batchId:randomUUID(),space,rows},indexed=await index.sync(current,packet),call={function:'semanticCandidates',object:{type:'ServiceRequest',id:created.id},space,queryVector:[1,0,0],limit:2,candidates:rows.map(({vector:_v,...row})=>({...row,batchId:packet.batchId,batchDigest:indexed.batchDigest}))};
   return {id:created.id,release,call};
  }
  const old=await task(t.database,t.publisher,t.kernel,t.policy,t.vectors),read=async(database:PostgresDatabase,publisher:PostgresAuthorizationPublisher,kernel:typeof t.kernel,policyDigest:string,entry:typeof old)=>new PostgresTaskReadService(database,policyDigest,kernel).evaluateOntology({...source.principal,access:await publisher.authenticate(source.principal,installation.token)},{version:2,taskId:entry.id,expectedRequestRevision:1,call:entry.call});
  assert.equal((await read(t.database,t.publisher,t.kernel,t.policy,old)).status,'known');
  const indexBefore=(await t.client.query(`SELECT to_jsonb(r) AS row FROM ${q}.ontology_object_embeddings r ORDER BY to_jsonb(r)::text`)).rows;
  await t.publisher.close();await t.database.close();const revision=Number((await t.client.query(`SELECT revision FROM ${q}.security_policy WHERE slot=1`)).rows[0].revision),expected={baseBinding:t.binding,vectorFeature:t.feature,operationId:randomUUID(),release:namespace.active,generation:namespace.generation,digest:t.policy,revision};
  await assert.rejects(upgradePostgresRideSources(t.client,t.schema,t.binding.authority,{...expected,vectorFeature:undefined},true),/vector storage/);
  assert.equal((await readPostgresRideUpgrade(t.client,t.schema,t.binding.authority,expected)).status,'not_applied');
  const upgraded=await upgradePostgresRideSources(t.client,t.schema,t.binding.authority,expected,true);assert('activationProof' in upgraded);const proof=upgraded.activationProof!;assert.equal((await readPostgresRideUpgrade(t.client,t.schema,t.binding.authority,expected)).status,'applied');assert.equal(postgresBindingIdentity(t.binding),beforeIdentity);assert.deepEqual(t.binding,beforeBinding);assert.deepEqual((await t.client.query(`SELECT to_jsonb(r) AS row FROM ${q}.ontology_object_embeddings r ORDER BY to_jsonb(r)::text`)).rows,indexBefore);
  const kernel=await preparePostgresKernel(undefined,'30');endpoint=await postgresTlsFixture(vectorConnection().port);const runtime=new pg.Client({...vectorConnection(),host:'localhost',port:endpoint.port,user:t.role,password:'synthetic-vector-runtime-only',ssl:{ca:endpoint.ca,rejectUnauthorized:true}});await runtime.connect();try{
   await assert.rejects(preflightPostgresBinding(runtime,t.binding),/policy differs/);await preflightPostgresBinding(runtime,t.binding,proof,kernel);await verifyPostgresPrimaryActivation(runtime,t.binding,t.feature,kernel,proof);await assert.rejects(verifyPostgresPrimaryActivation(runtime,t.binding,undefined,kernel,proof),/vector feature/);await assert.rejects(runtime.query(`INSERT INTO ${q}.eigos_runtime_activation(id,body) VALUES($1,$2)`,[randomUUID(),JSON.stringify(proof.receipt)]),/permission denied/);await assert.rejects(runtime.query(`UPDATE ${q}.ontology_object_embeddings SET dimensions=3`),/permission denied/);assert.equal((await runtime.query(`SELECT pg_catalog.has_schema_privilege(current_user,'extensions','USAGE') AS usage`)).rows[0].usage,false);
  }finally{await runtime.end();}
  const connection={...vectorConnection(),user:t.role,password:'synthetic-vector-runtime-only'};newDatabase=new PostgresDatabase(new pg.Pool({...connection,max:2}),t.schema,t.binding.authority,{kernel,vectorFeature:t.feature});control=new pg.Pool({...connection,max:2});newPublisher=new PostgresAuthorizationPublisher({database:newDatabase,controlPool:control,schema:t.schema,runtime:t.binding.authority,policyDigest:proof.receipt.after,members:t.members});await newPublisher.start();
  const retained=await read(newDatabase,newPublisher,kernel,proof.receipt.after,old);assert.equal(retained.status,'known');assert.deepEqual((retained.value as {refs:unknown[]}).refs,refs);
  const fresh=await task(newDatabase,newPublisher,kernel,proof.receipt.after,new PostgresEmbeddingIndex(newDatabase,proof.receipt.after,t.feature,kernel));assert.notDeepEqual(fresh.release,old.release);const retrieved=await read(newDatabase,newPublisher,kernel,proof.receipt.after,fresh);assert.equal(retrieved.status,'known');assert.deepEqual((retrieved.value as {refs:unknown[]}).refs,refs);
 }finally{await newPublisher?.close();await newDatabase?.close();await control?.end();await endpoint?.close();await target?.close();sqlite.close();source.close();}
});
