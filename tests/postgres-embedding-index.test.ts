import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {DatabaseSync} from 'node:sqlite';
import {securityFixture} from './fixtures/security.js';
import {postgresVectorFixture,vectorConnection} from './fixtures/postgres-vectors.js';
import {OntologyObjectStore} from '../packages/ontology/object-store.js';
import {currentKernelImplementation} from '../packages/ontology/definition-store.js';
import {embeddedFieldInput} from '../packages/ontology/semantic-retrieval.js';
import {PostgresTaskReadService} from '../packages/postgres/task-read-service.js';
import {verifyPostgresEmbeddingExtension} from '../packages/deployment/postgres-vector-index.js';
import {AuthorizationCoordinator} from '../packages/security/coordinator.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {PostgresNativePlanningSession} from '../packages/postgres/native-planning-session.js';
import {openOntologyMcp} from '../packages/coordinator/ontology-mcp.js';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {SignJWT,generateKeyPair} from 'jose';
import {jwtVerifier} from '../apps/gateway/auth.js';
import {postgresVectorGateway} from './fixtures/postgres-vector-gateway.js';
import {assertPostgresEmbeddingSchema} from '../packages/postgres/embedding-schema.js';
import {PostgresEmbeddingIndex} from '../packages/postgres/embedding-index.js';
import {stagedKernelComponents,createPaymentCommerceKernelDefinition,compiledSeedModel} from '../packages/ontology/seed-definition.js';
import {roleSchema} from '../packages/security/resource-role.js';
import {PostgresPermissionManagement} from '../packages/postgres/permission-management.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {digest} from '../packages/core/delegation.js';
import {BACKEND_VERSION} from '../packages/ontology/execution.js';
import {POLICY_VERSION,SECURITY_CONTRACT} from '../packages/security/contracts.js';
import type {Job} from '../packages/core/domain.js';
import {POSTGRES_PROJECTION_EPOCH_CONTRACT} from '../packages/postgres/business-schema.js';

async function rejectChangedEpochBase(t:Awaited<ReturnType<typeof postgresVectorFixture>>){
  const q=`"${t.schema}"`,signature=`${q}.eigos_projection_epoch_invalidate()`,reader=new pg.Client(vectorConnection());await reader.connect();
  try{
  const original=(await t.client.query(`SELECT pg_get_functiondef(p.oid) AS sql FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='eigos_projection_epoch_invalidate'`,[t.schema])).rows[0].sql as string;
  const triggers=(await t.client.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS sql FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=$1 AND p.proname='eigos_projection_epoch_invalidate'`,[t.schema])).rows;
  assert.equal(triggers.length,12);
  const verify=(binding=t.binding)=>verifyPostgresEmbeddingExtension(reader,binding,t.feature);
  const restore=async()=>{await t.client.query(`ALTER FUNCTION ${signature} OWNER TO postgres; ${original}; REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC,"${t.role}"`);};
  const rejected=async(sql:string)=>{await t.client.query(sql);try{await assert.rejects(verify(),/Original projection epoch/);}finally{await restore();}};
    assert(Object.isFrozen(POSTGRES_PROJECTION_EPOCH_CONTRACT));assert(Object.isFrozen(POSTGRES_PROJECTION_EPOCH_CONTRACT.tables));assert(Object.isFrozen(POSTGRES_PROJECTION_EPOCH_CONTRACT.events));
    assert(original.includes('RETURN NULL;'));
    await rejected(original.replace('RETURN NULL;','PERFORM 1; RETURN NULL;'));
    for(const change of ['SECURITY DEFINER','STABLE','PARALLEL SAFE','SET search_path TO public,pg_catalog',`OWNER TO "${t.role}"`])await rejected(`ALTER FUNCTION ${signature} ${change}`);
    await rejected(`GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`);
    await rejected(`GRANT EXECUTE ON FUNCTION ${signature} TO "${t.role}"`);
    const trigger=triggers.find(row=>row.tgname==='ontology_links_projection_insert')!;
    for(const row of triggers)await t.client.query(`DROP TRIGGER "${row.tgname}" ON ${q}."${row.relname}"`);
    await t.client.query(`DROP FUNCTION ${signature}`);
    try{await assert.rejects(verify(),/Original projection epoch helper is missing from its reviewed base/);}
    finally{await t.client.query(`${original}; REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC,"${t.role}"`);for(const row of triggers)await t.client.query(row.sql);}
    for(const replacement of ['',`CREATE TRIGGER "${trigger.tgname}" AFTER UPDATE ON ${q}."${trigger.relname}" FOR EACH ROW EXECUTE FUNCTION ${signature}`,
      `CREATE TRIGGER "${trigger.tgname}" AFTER INSERT ON ${q}."${trigger.relname}" FOR EACH ROW EXECUTE FUNCTION ${q}.eigos_immutable_history()`]){
      await t.client.query(`DROP TRIGGER "${trigger.tgname}" ON ${q}."${trigger.relname}"; ${replacement}`);
      try{await assert.rejects(verify(),/Original projection epoch trigger source differs/);}
      finally{await t.client.query(`DROP TRIGGER IF EXISTS "${trigger.tgname}" ON ${q}."${trigger.relname}"; ${trigger.sql}`);}
    }
    await t.client.query(`CREATE FUNCTION ${q}.unreviewed_vector_neighbor() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
    try{await assert.rejects(verify(),/unreviewed functions/);}finally{await t.client.query(`DROP FUNCTION ${q}.unreviewed_vector_neighbor()`);}
    await assert.rejects(verify({...t.binding,activation:{...t.binding.activation!,runtimeSchemaReceiptDigest:'0'.repeat(64)}}),/Base activation belongs to a different primary/);
    await assert.rejects(verify({...t.binding,business:{...t.binding.business,schemaDigest:'0'.repeat(64)}}),/Base activation belongs to a different primary/);
    await verify();
  }finally{await reader.end();}
}

async function oldBaseCannotAdoptPosthocEpochs(){
  const source=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof postgresVectorFixture>>|undefined;
  try{
    target=await postgresVectorFixture(source,{legacyProjection:true});const t=target,q=`"${t.schema}"`,reader=new pg.Client(vectorConnection());await reader.connect();
    try{
      await t.publisher.close();
      const before=(await t.client.query(`SELECT body FROM ${q}.eigos_migration_receipt WHERE slot=1`)).rows[0].body;
      assert(before.tables.every((row:{name:string})=>!['ontology_projection_epochs','ontology_projection_checkpoints'].includes(row.name)));
      await verifyPostgresEmbeddingExtension(reader,t.binding,t.feature);
      const contract=POSTGRES_PROJECTION_EPOCH_CONTRACT;
      await t.client.query(`BEGIN; SET LOCAL search_path TO ${q},pg_catalog,pg_temp;
        CREATE TABLE ${q}.ontology_projection_epochs(ontology_id text NOT NULL,owner text NOT NULL,type text NOT NULL,revision bigint NOT NULL,PRIMARY KEY(ontology_id,owner,type));
        CREATE TABLE ${q}.ontology_projection_checkpoints(ontology_id text NOT NULL,owner text NOT NULL,task_id text NOT NULL,model_digest text NOT NULL,epochs text NOT NULL,entries text NOT NULL,PRIMARY KEY(ontology_id,owner,task_id));
        ${contract.functionSql}; REVOKE ALL ON FUNCTION ${q}.eigos_projection_epoch_invalidate() FROM PUBLIC; COMMIT`);
      try{
        // Even the exact reviewed function with the proper owner/config/ACL
        // cannot claim to have belonged to this original immutable import.
        await assert.rejects(verifyPostgresEmbeddingExtension(reader,t.binding,t.feature),/absent from the original base import/);
        for(const table of contract.tables)for(const event of contract.events)await t.client.query(`CREATE TRIGGER ${table}_projection_${event.toLowerCase()} AFTER ${event} ON ${q}.${table} FOR EACH ROW EXECUTE FUNCTION ${q}.eigos_projection_epoch_invalidate()`);
        await assert.rejects(verifyPostgresEmbeddingExtension(reader,t.binding,t.feature),/absent from the original base import/);
      }finally{
        for(const table of contract.tables)for(const event of contract.events)await t.client.query(`DROP TRIGGER IF EXISTS ${table}_projection_${event.toLowerCase()} ON ${q}.${table}`);
        await t.client.query(`DROP FUNCTION ${q}.eigos_projection_epoch_invalidate(); DROP TABLE ${q}.ontology_projection_epochs; DROP TABLE ${q}.ontology_projection_checkpoints`);
      }
      assert.deepEqual((await t.client.query(`SELECT body FROM ${q}.eigos_migration_receipt WHERE slot=1`)).rows[0].body,before);
      await verifyPostgresEmbeddingExtension(reader,t.binding,t.feature);
    }finally{await reader.end();}
  }finally{await target?.close();source.close();}
}

test('supplied task vectors use actual pgvector through a restricted runtime, exact field grants and complete current index',
  {skip:process.env.EIGOS_TEST_VECTOR_PG!=='1'},async()=>{
    const source=securityFixture(Date.now,{unified:true}),sqlite=new DatabaseSync(source.database);let target:Awaited<ReturnType<typeof postgresVectorFixture>>|undefined;
    let gateway:Awaited<ReturnType<typeof postgresVectorGateway>>|undefined;
    try{
      const model=currentKernelImplementation(),raw=new OntologyObjectStore(sqlite,model,Date.now,undefined,{skipLegacyMigration:true});
      const installation=source.installation('Synthetic supplied-vector PA',3600000),expiresAt=new Date(Date.now()+3600000).toISOString();
      const keys=await generateKeyPair('RS256'),bearer=await new SignJWT({tenant_id:source.principal.tenant,client_id:source.principal.clientId,scope:source.principal.scopes.join(' ')})
        .setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(source.principal.issuer).setAudience(source.authority!.ingresses[0]!.audience).setSubject(source.principal.subject).setJti(randomUUID()).setIssuedAt().setExpirationTime('10m').sign(keys.privateKey);
      source.members.agents.bind(installation.id,installation.credential,source.principal,source.member.id,bearer,Date.now()+600000,Date.now(),true);
      const parent=source.coordinator.approveAgentGrant(source.member.id,{installationId:installation.id,capabilityIds:['brief.prepare'],resources:[
        ...['ServiceRequest',...Object.keys(taskContextFields)].map(type=>({type,fields:Object.keys(source.jobs.security.policies.fields(type)).filter(field=>source.jobs.security.policies.fieldPolicy(type,field)!=='internal_only')})),
        {type:'Place',fields:['placeId','displayTitle','name','address']}],sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt:null});
      const other=source.installation('Synthetic ungranted same-owner PA',3600000),otherBearer=await new SignJWT({tenant_id:source.principal.tenant,client_id:source.principal.clientId,scope:source.principal.scopes.join(' ')})
        .setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(source.principal.issuer).setAudience(source.authority!.ingresses[0]!.audience).setSubject(source.principal.subject).setJti(randomUUID()).setIssuedAt().setExpirationTime('10m').sign(keys.privateKey);
      source.members.agents.bind(other.id,other.credential,source.principal,source.member.id,otherBearer,Date.now()+600000,Date.now(),true);
      source.coordinator.approveAgentGrant(source.member.id,{installationId:other.id,capabilityIds:['brief.prepare'],resources:[{type:'ServiceRequest',fields:['requestId','originalGoal']}],sourceBindingIds:[],channels:['agent_response'],expiresAt:null});
      source.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},expiresAt:null},source.jobs.security.policies.revision());
      source.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt:null},source.jobs.security.policies.revision());
      source.jobs.security.policies.setModelChannel('synthetic:vectors',{classification:'sensitive',markings:['member_private','personal_data'],expiresAt},source.jobs.security.policies.revision());
      const refs=[{type:'Place',id:'synthetic-place-a'},{type:'Place',id:'synthetic-place-b'}];
      raw.ingest(source.owner,{objects:refs.flatMap(ref=>[{ref,properties:{placeId:ref.id,displayTitle:ref.id,name:ref.id,address:{text:'Synthetic private address'}}},
        {ref:{type:'SourceReceipt',id:'receipt-'+ref.id},properties:{receiptId:'receipt-'+ref.id,displayTitle:'Synthetic',safeSummary:'Synthetic',evidenceLevel:'synthetic'}}]),
        links:refs.map(ref=>({type:'PlaceEvidence',from:ref,to:{type:'SourceReceipt',id:'receipt-'+ref.id}}))},{kind:'synthetic',id:'vector-fixture',observedAt:new Date().toISOString()});
      // This independent legacy task remains pinned to v27 with original
      // until-revoked consent. It is not replaced or declared completed.
      const legacySeed=createPaymentCommerceKernelDefinition(),legacyModel=compiledSeedModel(legacySeed,legacySeed.registry),legacyId=randomUUID(),at=new Date().toISOString();
      // Initial synthetic history contains the genuine, independently hashed
      // prior release. No existing release or task pin is relabelled.
      sqlite.prepare('INSERT INTO ontology_definition_releases(id,ontology_id,sequence,digest,model_digest,body,created_at) VALUES(?,?,(SELECT coalesce(max(sequence),0)+1 FROM ontology_definition_releases WHERE ontology_id=?),?,?,?,?)')
        .run(legacyId,legacySeed.document.id,legacySeed.document.id,digest(legacySeed.document),legacyModel.ref.digest,JSON.stringify(legacySeed.document),at);
      sqlite.prepare('INSERT INTO ontology_definition_promotions(ontology_id,release_id,at) VALUES(?,?,?)').run(legacySeed.document.id,legacyId,at);
      const oldId=randomUUID(),oldJob:Job={id:oldId,contextId:randomUUID(),service:'eigos.delegate',goal:'Synthetic historical v27 input',state:'submitted',messages:[],createdAt:at,updatedAt:at,revision:1,executionMode:'worker',runs:[],
        delegation:{backendVersion:BACKEND_VERSION,ontologyRelease:{ontologyId:legacySeed.document.id,releaseId:legacyId,digest:digest(legacySeed.document)},ontologyReadScope:'request' as const,phase:'grounding' as const,events:[],request:{id:oldId,revision:1,originalGoal:'Synthetic historical v27 input',requirements:[],messages:[]}}};
      source.jobs.save(source.owner,oldJob);
      const originalGrant=source.jobs.security.issueTaskGrant({version:SECURITY_CONTRACT,id:randomUUID(),revision:1,kind:'task_data',status:'active',ownerKey:source.owner,memberId:source.member.id,approvedByMemberId:source.member.id,installationId:installation.id,
        issuedAt:at,expiresAt:null,parentGrant:{id:parent.id,revision:parent.revision},taskId:oldId,requestRevision:1,purpose:'delegated_task',operations:['task.process'],inputs:[],outputs:[],channels:['registered_model']});
      source.jobs.security.attachTaskAuthority({version:SECURITY_CONTRACT,id:randomUUID(),revision:1,ownerKey:source.owner,memberId:source.member.id,installationId:installation.id,taskId:oldId,requestRevision:1,agentGrant:{id:parent.id,revision:parent.revision},dataGrant:{id:originalGrant.id,revision:1},
        submittedScopes:['tasks:write'],authEpoch:source.jobs.security.requireSubject(installation.id).epoch,policyVersion:POLICY_VERSION,issuedAt:at,expiresAt:null});
      const oldTask={job:oldJob,grant:originalGrant};
      const oldRole=roleSchema.parse({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'namespace',id:legacyModel.ref.id,version:legacyModel.ref.digest},expiresAt:null});
      sqlite.prepare('INSERT INTO security_roles(id,subject_id,body) VALUES(?,?,?)').run(randomUUID(),installation.id,JSON.stringify(oldRole));
      source.coordinator.close();const controller=new AuthorizationCoordinator(source.jobs.security,source.members,source.jobs);controller.start();
      let grant:ReturnType<AuthorizationCoordinator['approveTaskGrant']>;
      try{grant=controller.approveTaskGrant(source.member.id,{taskId:oldTask.job.id,installationId:installation.id,expectedRequestRevision:1,replaces:{id:oldTask.grant.id,revision:1},expectedAgentGrant:{id:parent.id,revision:parent.revision},takeover:true,
        inputs:refs.map(object=>({object,objectRevision:1,fields:['placeId','displayTitle','name']})),programIds:[],purpose:'delegated_task',operations:['task.process','task.query','task.result.read','member_asset.read'],channels:['agent_response','registered_model'],expiresAt:null});
        const historical=source.jobs.get(source.owner,oldTask.job.id);historical.state='paused';source.jobs.save(source.owner,historical);
      }finally{controller.close();}
      target=await postgresVectorFixture(source);const t=target,q=`"${t.schema}"`;let principal={...source.principal,access:await t.publisher.authenticate(source.principal,installation.token)};
      const service=new PostgresTaskReadService(t.database,t.policy,t.kernel),newModel=stagedKernelComponents(t.kernel).model;
      assert.equal(model.ref.version,'28');assert.equal(newModel.ref.version,'29');assert.equal(t.published.generation,t.prior.generation+1);
      const oldPin=(await t.client.query(`SELECT body::jsonb#>'{delegation,ontologyRelease}' AS pin FROM ${q}.jobs WHERE id=$1`,[oldTask.job.id])).rows[0].pin;
      assert.deepEqual(oldPin,oldTask.job.delegation!.ontologyRelease);
      assert.equal((await service.queryOntology(principal,{version:2,taskId:oldTask.job.id,query:{type:'Place'}})).items.length,2,'real v27 persistent task consent still reads its original objects under the v28-enabled host');
      const legacyGrant=(await t.client.query(`SELECT body::jsonb AS body FROM ${q}.security_grants WHERE id=$1`,[grant.id])).rows[0].body;assert.equal(legacyGrant.expiresAt,null);
      const namespaceRole=roleSchema.parse({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'namespace',id:newModel.ref.id,version:newModel.ref.digest},expiresAt:null});
      await t.client.query(`INSERT INTO ${q}.security_roles(id,subject_id,body) VALUES($1,$2,$3)`,[randomUUID(),installation.id,JSON.stringify(namespaceRole)]);
      const commands=new PostgresTaskCommandService(t.database,t.policy,t.kernel),created=await commands.submit(principal,{goal:'Synthetic supplied vector candidate retrieval only',requestId:'new-explicit-vector-task'}),task={job:{id:created.id}};
      const issued=(await t.client.query(`SELECT id,revision FROM ${q}.security_grants WHERE kind='task_data' AND body::jsonb->>'taskId'=$1 AND state='active'`,[created.id])).rows[0];assert(issued);
      const program=new DocumentAgentProgram(),catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]),management=new PostgresPermissionManagement({database:t.database,members:t.members,publisher:t.publisher,catalog,policyDigest:t.policy,builder:t.kernel});
      grant=await management.approveTaskGrant(source.member.id,{taskId:created.id,installationId:installation.id,expectedRequestRevision:1,replaces:{id:issued.id,revision:Number(issued.revision)},expectedAgentGrant:{id:parent.id,revision:parent.revision},takeover:true,
        inputs:refs.map(object=>({object,objectRevision:1,fields:['placeId','displayTitle','name']})),programIds:[],purpose:'delegated_task',operations:['task.process','task.query','task.result.read','member_asset.read'],channels:['agent_response','registered_model'],expiresAt:null});
      principal={...source.principal,access:await t.publisher.authenticate(source.principal,installation.token)};
      const release=(await t.client.query(`SELECT body::jsonb#>'{delegation,ontologyRelease}' AS pin FROM ${q}.jobs WHERE id=$1`,[created.id])).rows[0].pin;
      const space={modelId:'synthetic-vectors',modelRevision:'1',dimensions:3,metric:'cosine' as const,inputFormat:'canonical-fields-json-v1' as const};
      const rows=refs.map((object,index)=>({object,expectedObjectRevision:1,...embeddedFieldInput(release,object,1,['name'],raw.read(source.owner,object).properties),vector:index===0?[1,0,0]:[0,1,0]}));
      const packet={version:1,taskId:task.job.id,expectedRequestRevision:1,ontologyRelease:release,batchId:randomUUID(),space,rows};
      const indexed=await t.vectors.sync(principal,packet);assert.equal(indexed.rows,2);assert.deepEqual(await t.vectors.sync(principal,packet),indexed);
      const call={function:'semanticCandidates',object:{type:'ServiceRequest',id:task.job.id},space,queryVector:[1,0,0],limit:2,
        candidates:rows.map(({vector:_vector,...row})=>({...row,batchId:packet.batchId,batchDigest:indexed.batchDigest}))};
      const read=()=>service.evaluateOntology(principal,{version:2,taskId:task.job.id,expectedRequestRevision:1,call});
      await assert.rejects(read(),/AUTHORIZATION_REQUIRED/,'namespace viewing is not function invocation');
      const invoke=roleSchema.parse({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'function',id:'semanticCandidates',version:'1'},invokeFunctions:['semanticCandidates'],expiresAt:null});
      await t.client.query(`INSERT INTO ${q}.security_roles(id,subject_id,body) VALUES($1,$2,$3)`,[randomUUID(),installation.id,JSON.stringify(invoke)]);
      await assert.rejects(service.evaluateOntology(principal,{version:2,taskId:oldTask.job.id,call:{...call,object:{type:'ServiceRequest',id:oldTask.job.id}}}),/AUTHORIZATION_REQUIRED|Unknown function/,'the old task pin cannot gain a new function even from a new explicit role');
      const result=await read();assert.equal(result.status,'known');assert.deepEqual((result.value as {refs:unknown[]}).refs,refs);assert.equal((result.value as {candidateOnly:boolean}).candidateOnly,true);
      gateway=await postgresVectorGateway(source,t,bearer,jwtVerifier(source.principal.issuer,source.authority!.ingresses[0]!.audience,async()=>keys.publicKey));
      assert.equal((await gateway.request('/ontology/vectors/sync',{...packet,batchId:randomUUID()},'invalid-signed-token')).status,401);
      assert.equal((await gateway.request('/ontology/vectors/sync',{...packet,batchId:randomUUID()},otherBearer)).status,403,'a different real same-owner PA has no task-processing grant');
      assert.equal((await gateway.request('/ontology/evaluate',{version:2,taskId:task.job.id,call},otherBearer)).status,403,'object ownership alone is not a task grant');
      const httpPacket={...packet,batchId:randomUUID()},http=await gateway.request('/ontology/vectors/sync',httpPacket);assert.equal(http.status,200);const httpReceipt=await http.json() as {batchDigest:string};
      const fromMcp=await gateway.call('evaluate_ontology',{version:2,taskId:task.job.id,call:{...call,candidates:call.candidates.map(candidate=>({...candidate,batchId:httpPacket.batchId,batchDigest:httpReceipt.batchDigest}))}});
      assert(!fromMcp.isError,JSON.stringify(fromMcp));assert.deepEqual((fromMcp.structuredContent as {result:{value:{refs:unknown[]}}}).result.value.refs,refs);
      const a2a=await gateway.request('/a2a',{jsonrpc:'2.0',id:randomUUID(),method:'GetTask',params:{id:task.job.id}});assert.equal(a2a.status,200);
      const a2aBody=await a2a.json() as {error?:unknown;result:{id:string}};assert(!a2aBody.error,JSON.stringify(a2aBody));assert.equal(a2aBody.result.id,task.job.id);
      const stale=await service.evaluateOntology(principal,{version:2,taskId:task.job.id,call:{...call,candidates:[{...call.candidates[0],expectedObjectRevision:2}]}});
      assert.equal(stale.status,'unknown');assert.equal(stale.reason,'index_incomplete');
      const wrongModel=await service.evaluateOntology(principal,{version:2,taskId:task.job.id,call:{...call,space:{...space,modelRevision:'unindexed'}}});assert.equal(wrongModel.status,'unknown');
      assert.equal((await t.client.query(`SELECT count(*)::int AS n FROM ${q}.action_intents`)).rows[0]?.n,0,'index sync creates no business action');
      assert.equal((await t.client.query(`SELECT state FROM ${q}.jobs WHERE id=$1`,[task.job.id])).rows[0]?.state,'submitted','candidate retrieval does not complete the original task');
      const runtime=new pg.Client({...vectorConnection(),user:t.role,password:'synthetic-vector-runtime-only'});await runtime.connect();
      try{
        const flags=(await runtime.query(`SELECT pg_catalog.has_schema_privilege(current_user,'extensions','USAGE') AS usage,pg_catalog.has_schema_privilege(current_user,'extensions','CREATE') AS create`)).rows[0];assert.deepEqual(flags,{usage:false,create:false});
        await assert.rejects(runtime.query("SELECT extensions.cosine_distance('[1,0,0]'::extensions.vector,'[0,1,0]'::extensions.vector)"),/permission denied for schema/);
        await assert.rejects(runtime.query(`UPDATE ${q}.ontology_object_embeddings SET dimensions=3`),/permission denied/);
        await assert.rejects(runtime.query(`DELETE FROM ${q}.eigos_runtime_schema_extensions`),/permission denied/);
      }finally{await runtime.end();}
      await assert.rejects(t.vectors.sync(principal,{...packet,batchId:randomUUID(),rows:[{...rows[0],fields:['address']}]}),/INSUFFICIENT_ACCESS/);
      await assert.rejects(t.vectors.sync(principal,{...packet,space:{...space,dimensions:2}}),/dimension/);
      const missing=await service.evaluateOntology(principal,{version:2,taskId:task.job.id,call:{...call,candidates:[{...call.candidates[0],batchId:randomUUID()}]}});
      assert.equal(missing.status,'unknown');assert.equal(missing.reason,'index_incomplete');assert.equal(missing.value,undefined);
      const bindingFile=t.write('cli-vector-binding.json',t.binding),featureFile=t.write('cli-vector-feature.json',t.feature);
      for(const action of ['prepare-schema','publish-kernel']){
        const operation=t.write('cli-'+action+'.json',{version:1,kind:'eigos.task-vector-operation',action,binding:bindingFile,adminIdentity:{user:'postgres',role:'postgres'},reviewDigest:'c'.repeat(64),
          ...(action==='publish-kernel'?{feature:featureFile,expectedActive:{ref:t.prior.active,generation:t.prior.generation}}:{})});
        const preview=spawnSync(process.execPath,[resolve('scripts/postgres-task-vectors.mjs'),'--input',operation.path],{encoding:'utf8',timeout:15000,
          env:{PATH:process.env.PATH,EIGOS_POSTGRES_ADMIN_USER:'preview-must-not-read-credentials',EIGOS_POSTGRES_ADMIN_PASSWORD:'synthetic-unusable-preview-only'}});
        assert.equal(preview.status,0,preview.stderr);const value=JSON.parse(preview.stdout);assert.equal(value.status,'preview-only');assert.equal(value.runtimeStarted,false);assert.match(value.previewDigest,/^[a-f0-9]{64}$/);
      }
      await assert.rejects(t.vectors.sync({...principal,subject:'another-owner'},{...packet,batchId:randomUUID()}),/AUTHORIZATION_REQUIRED|ACCESS_REVOKED/);
      await assert.rejects(t.vectors.sync(principal,{...packet,rows:[{...rows[0],vector:[0,0,1]},rows[1]]}),/identity was reused/);
      const savedGrant=(await t.client.query(`SELECT body FROM ${q}.security_grants WHERE id=$1`,[grant.id])).rows[0].body;
      await t.client.query(`UPDATE ${q}.security_grants SET body=jsonb_set(body::jsonb,'{operations}',$2::jsonb)::text WHERE id=$1`,[grant.id,JSON.stringify(['task.query','task.result.read','member_asset.read'])]);
      try{await assert.rejects(t.vectors.sync(principal,{...packet,batchId:randomUUID()}),/AUTHORIZATION_REQUIRED/);assert.equal((await read()).status,'known','query remains read-only when process consent is absent');}
      finally{await t.client.query(`UPDATE ${q}.security_grants SET body=$2 WHERE id=$1`,[grant.id,savedGrant]);}
      const failedPacket={...packet,batchId:randomUUID()};let inserts=0,observedRollback=false;
      const faulty=new PostgresEmbeddingIndex({inspectClaim:t.database.inspectClaim.bind(t.database),run:action=>t.database.run(async c=>{
        const original=c.query;c.query=(async(...args:unknown[])=>{if(String(args[0]).startsWith(`INSERT INTO ${q}.ontology_object_embeddings`)&&++inserts===2)throw new Error('Synthetic second embedding insert failure');return Reflect.apply(original,c,args);}) as typeof c.query;
        try{return await action(c);}catch(error){const remaining=(await c.query(`SELECT count(*)::int AS n FROM ${q}.ontology_embedding_batches WHERE batch_id=$1`,[failedPacket.batchId])).rows[0]?.n;assert.equal(remaining,0,'SAVEPOINT already removed the header before outer rollback');observedRollback=true;throw error;}finally{c.query=original;}
      })},t.policy,t.feature,t.kernel);
      await assert.rejects(faulty.sync(principal,failedPacket),/Synthetic second embedding insert failure/);assert(observedRollback);
      assert.equal((await t.vectors.sync(principal,failedPacket)).rows,2,'a failed batch can be explicitly retried without a partial header');
      const corrupt=async(sql:string,pattern:RegExp)=>{await t.client.query('BEGIN');try{await t.client.query(sql);await assert.rejects(assertPostgresEmbeddingSchema(t.client,t.feature),pattern);}finally{await t.client.query('ROLLBACK');}};
      await corrupt(`GRANT USAGE ON SCHEMA extensions TO "${t.role}"`,/namespace isolation/);
      await corrupt(`ALTER FUNCTION ${q}.eigos_vector_from_values(real[]) VOLATILE`,/numeric wrappers/);
      await corrupt(`CREATE FUNCTION ${q}.eigos_vector_spoof(integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT $1'`,/numeric wrappers/);
      await corrupt(`CREATE INDEX unreviewed_embedding_index ON ${q}.ontology_object_embeddings(object_id)`,/index inventory/);
      await corrupt(`ALTER TABLE ${q}.ontology_object_embeddings ADD CONSTRAINT unreviewed_embedding_check CHECK(dimensions>0)`,/constraints/);
      await corrupt(`ALTER TABLE ${q}.ontology_object_embeddings DISABLE TRIGGER ontology_object_embeddings_immutable`,/immutable guards/);
      await corrupt(`GRANT UPDATE ON TABLE ${q}.ontology_object_embeddings TO "${t.role}"`,/table privileges/);
      await corrupt(`GRANT EXECUTE ON FUNCTION ${q}.eigos_vector_from_values(real[]) TO PUBLIC`,/routine privileges/);
      const full=new PostgresEmbeddingIndex({inspectClaim:t.database.inspectClaim.bind(t.database),run:action=>t.database.run(async c=>{
        await c.query('SAVEPOINT synthetic_embedding_quota');
        try{
          // Real immutable copies model repeated previously indexed batches;
          // no query/auth result is mocked and the fixture rolls them back.
          const copies=await c.query(`INSERT INTO ${q}.ontology_embedding_batches SELECT owner,installation_id,task_id,request_revision,grant_id,grant_revision,gen_random_uuid()::text,batch_digest,body
            FROM ${q}.ontology_embedding_batches CROSS JOIN generate_series(1,1000) WHERE batch_id=$1 RETURNING batch_id`,[packet.batchId]);
          await c.query(`INSERT INTO ${q}.ontology_object_embeddings SELECT e.owner,e.installation_id,e.task_id,ids.batch_id,e.object_type,e.object_id,e.object_revision,e.ontology_id,e.release_id,e.release_digest,e.space_digest,e.fields_digest,e.input_digest,e.vector_digest,e.dimensions,e.embedding
            FROM ${q}.ontology_object_embeddings e CROSS JOIN unnest($2::text[]) ids(batch_id) WHERE e.batch_id=$1`,[packet.batchId,copies.rows.map(row=>row.batch_id)]);
          return await action(c);
        }finally{await c.query('ROLLBACK TO SAVEPOINT synthetic_embedding_quota');await c.query('RELEASE SAVEPOINT synthetic_embedding_quota');}
      })},t.policy,t.feature,t.kernel);
      await assert.rejects(full.sync(principal,{...packet,batchId:randomUUID()}),/storage budget exceeded/);
      const worker=new PostgresWorkerStore(t.database,t.policy,t.kernel),claim=await worker.claim(['eigos.delegate'],15000);assert(claim);assert.equal(claim.job.id,task.job.id);
      let pending:Promise<void>|undefined,heartbeatFailure:unknown;
      const timer=setInterval(()=>{if(!pending)pending=worker.renew(claim,15000).then(ok=>{assert(ok);}).catch(error=>{heartbeatFailure=error;}).finally(()=>{pending=undefined;});},500);timer.unref();
      try{
        const workerBatch={...packet,batchId:randomUUID()},accepted=await t.vectors.syncWorker(claim,'synthetic:vectors',workerBatch);
        const session=await PostgresNativePlanningSession.create(worker,claim,t.policy,'synthetic:vectors',{builder:t.kernel,taskContext:{purpose:'grounding'},boundRefs:refs});
        let mcp:Awaited<ReturnType<typeof openOntologyMcp>>|undefined,client:Client|undefined;
        try{
          mcp=await openOntologyMcp(session,new AbortController().signal,undefined,{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false},'synthetic:vectors');
          client=new Client({name:'synthetic-vector-native',version:'1'});
          await client.connect(new StreamableHTTPClientTransport(new URL(mcp.connection.url),{requestInit:{headers:{Authorization:`Bearer ${mcp.connection.token}`}}}),{timeout:30000});
          const context=await client.callTool({name:'read_task_context',arguments:{}},{timeout:30000});assert(!context.isError,JSON.stringify(context));
          const response=await client.callTool({name:'evaluate_ontology',arguments:{...call,limit:1,candidates:call.candidates.map(candidate=>({...candidate,batchId:workerBatch.batchId,batchDigest:accepted.batchDigest}))}},{timeout:30000});
          assert(!response.isError,JSON.stringify(response));const value=(response.structuredContent as {result:{result:{status:string;value:{refs:unknown[]}}}}).result.result;
          assert.equal(value.status,'known');assert.deepEqual(value.value.refs,refs.slice(0,1));
          const receipt=session.lastReceipt();assert.equal(receipt?.tool,'evaluate_ontology');assert.equal(receipt?.status,'ok');
          assert(refs.every(ref=>receipt.securityEnvelope?.lineage.some(value=>value.object.type===ref.type&&value.object.id===ref.id&&value.fields?.includes('name'))),'both winning and losing candidate field influences are retained');
          assert.equal((await t.client.query(`SELECT count(*)::int AS n FROM ${q}.security_reads WHERE grant_id=$1`,[grant.id])).rows[0]?.n>0,true);
          const stored=(await t.client.query(`SELECT body::jsonb#>'{delegation,ontologyReads}' AS reads FROM ${q}.jobs WHERE id=$1`,[task.job.id])).rows[0]?.reads;
          assert(stored.some((value:{id:string})=>value.id===receipt.id),'native receipt was actually committed');
        }finally{await client?.close();await mcp?.close();session.close();}
      }finally{clearInterval(timer);if(pending)await pending;}
      assert.equal(heartbeatFailure,undefined);
      const aborted=new AbortController();aborted.abort();await assert.rejects(t.vectors.syncWorker(claim,'synthetic:vectors',{...packet,batchId:randomUUID()},aborted.signal),{name:'AbortError'});
      await new PostgresTaskCommandService(t.database,t.policy,t.kernel).cancel(principal,task.job.id);
      await assert.rejects(t.vectors.syncWorker(claim,'synthetic:vectors',{...packet,batchId:randomUUID()}),/ACCESS_REVOKED|AUTHORIZATION_REQUIRED|changed|active/i);
      await assert.rejects(t.vectors.sync(principal,{...packet,batchId:randomUUID()}),/ACCESS_REVOKED/);
      assert.equal((await t.client.query(`SELECT count(*)::int AS n FROM ${q}.member_model_usage`)).rows[0]?.n,0,'no embedding or LLM model run is invented');
      await t.client.query(`UPDATE ${q}.security_grants SET state='revoked' WHERE id=$1`,[grant.id]);
      await assert.rejects(read(),/AUTHORIZATION_REQUIRED|ACCESS_REVOKED/);
      const verifier=new pg.Client(vectorConnection());await verifier.connect();try{await verifyPostgresEmbeddingExtension(verifier,t.binding,t.feature);}finally{await verifier.end();}
      await rejectChangedEpochBase(t);
    }finally{await gateway?.close();if(target)await target.close();sqlite.close();source.close();}
    await oldBaseCannotAdoptPosthocEpochs();
  });
