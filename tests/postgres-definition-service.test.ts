import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {securityFixture} from './fixtures/security.js';
import {importPostgresPrimaryFixture} from './fixtures/postgres-primary.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {PostgresDefinitionStore} from '../packages/postgres/definition-store.js';
import {PostgresDefinitionService} from '../packages/postgres/definition-service.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresProjectionGraph} from '../packages/postgres/projection-graph.js';
import {digest} from '../packages/core/delegation.js';
import {DomainError,type Principal} from '../packages/core/domain.js';
import {SecurityError} from '../packages/security/errors.js';
import {parsePipelineIntake,pipelineMappingDigest,type PipelineIntake} from '../packages/ontology/pipeline/contracts.js';
import type {DefinitionDraft} from '../packages/ontology/definition-store.js';
import type {OntologyReleaseRef,SerializableObjectType} from '../packages/ontology/definition-contracts.js';
import {preparePostgresKernel} from '../packages/postgres/kernel-runtime.js';
import {createPaClassificationKernelDefinition,createSemanticRetrievalKernelDefinition,StagedKernelBuilder} from '../packages/ontology/seed-definition.js';
import {FUNCTION_CONTRACT_CLOSEOUT_DOCUMENT_DIGEST,FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF} from '../packages/ontology/function-contract-closeout-compatibility.js';
import {managedFixtureObject} from './fixtures/dynamic-ontology.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
const result=<T>(value:{version:1;result:unknown})=>{assert.equal(value.version,1);return value.result as T;};
async function fixture(taskReads=false){
  const f=securityFixture(Date.now,{unified:true}),program=new DocumentAgentProgram();let target:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic Ontology operator',3600000);f.approve(installation.id);
    if(taskReads){
      const expiresAt=new Date(Date.now()+3600000).toISOString();
      f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,role:'Viewer',expiresAt,
        resource:{kind:'objectType',id:'ServiceRequest',version:f.jobs.security.policies.resourceVersion('objectType','ServiceRequest')}},f.jobs.security.policies.revision());
      f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
    }
    const original=f.task(installation.id);target=await importPostgresPrimaryFixture(f);const t=target;
    const principal=async(scopes=[...f.principal.scopes])=>{const verified={...f.principal,scopes};return {...verified,access:await t.publisher.authenticate(verified,installation.token)};};
    const catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]),tasks=new PostgresTaskCommandService(t.database,t.policy,t.kernel);
    const service=new PostgresDefinitionService({database:t.database,tasks,catalog,publisher:t.publisher,policyDigest:t.policy,builder:t.kernel});
    const run=<T>(action:(store:PostgresDefinitionStore)=>Promise<T>)=>t.database.run(client=>t.publisher.withManagement(client,()=>action(new PostgresDefinitionStore(client,{builder:t.kernel}))));
    return {f,t,program,installation,original,principal,service,run,q:`"${t.schema}"`,close:async()=>{try{await t.close();}finally{f.close();}}};
  }catch(error){try{await target?.close();}finally{f.close();}throw error;}
}
function intake(program:DocumentAgentProgram,model:ReturnType<PostgresDefinitionStore['compile']>):PipelineIntake{
  return parsePipelineIntake({format:'eigos.ontology.pipeline.v1',serviceId:'synthetic.definition.shipping',source:{id:'synthetic.definition.source',revision:'1',digest:digest('synthetic-only'),observedAt:new Date(Date.now()-1000).toISOString(),reference:'urn:eigos:synthetic:definition-shipping'},
    programRef:program.ref,configurationDigest:program.configurationDigest,environment:'local',vocabulary:[],actions:[{actionId:'ComposeDocument',definitionDigest:digest(model.action('ComposeDocument')),requiredEvidence:'definition_only'}],mappings:[],fixtures:[],conditions:{regions:[],payment:'not_required',operatorRequired:false}});
}

test('PG Ontology metadata uses its actual OAuth scope, current identity and the unchanged Foundation operation allowlist',local,async()=>{
  const x=await fixture();try{
    const p=await x.principal(x.f.principal.scopes.filter(scope=>scope!=='services:read'&&scope!=='tasks:read'));
    const namespace=result<{id:string;permissions:{read:boolean}}>(await x.service.query(p,{operation:'get_ontology'}));assert.equal(namespace.id,'eigos.business');assert.equal(namespace.permissions.read,true);
    await assert.rejects(x.service.query({...p,subject:'a different owner'}, {operation:'get_ontology'}),error=>error instanceof SecurityError&&['AUTHORIZATION_REQUIRED','ACCESS_REVOKED','POLICY_CHANGED'].includes(error.reason));
    await assert.rejects(x.service.query(p,{operation:'list_drafts'}),/separately reviewed Foundation interface/);
    await assert.rejects(x.service.command(p,{operation:'put_definition',draftId:randomUUID(),expectedRevision:1,kind:'object',definition:{}}),/separately reviewed Foundation interface/);
    const noPublish=await x.principal(x.f.principal.scopes.filter(scope=>scope!=='ontology:publish'));
    await assert.rejects(x.service.command(noPublish,{operation:'activate_release',release:x.original.job.delegation!.ontologyRelease,expectedGeneration:1}),error=>error instanceof DomainError&&error.code==='FORBIDDEN');
    const owned=await x.run(store=>store.createNamespace(x.f.owner,{id:'synthetic.pg.private',name:'Synthetic private'}));
    const withoutAdmin=await x.principal(x.f.principal.scopes.filter(scope=>scope!=='ontology:admin'));
    await x.t.database.run(async client=>{await client.query(`UPDATE ${x.q}.ontology_namespaces SET owner=$1 WHERE id=$2`,[JSON.stringify(['foreign','tenant','owner']),owned.id]);});
    await assert.rejects(x.service.query(withoutAdmin,{operation:'get_ontology',ontologyId:owned.id}),/belongs to another owner|requires its owner/);
    await x.t.publisher.close();await assert.rejects(x.service.query(p,{operation:'get_ontology'}),/AUTHORITY_UNAVAILABLE/);
  }finally{await x.close();}
});

test('PG Pipeline shipping publishes immutable metadata without activation, CAS activates separately and keeps original task pins',local,async()=>{
  const x=await fixture();try{
    const p=await x.principal(),before=await x.run(store=>store.namespace()),originalPin=x.original.job.delegation!.ontologyRelease!;
    let draft=result<Omit<DefinitionDraft,'document'>>(await x.service.command(p,{operation:'create_draft',title:'Synthetic shipping review'}));
    const contract=await x.run(async store=>intake(x.program,(await store.active()).model));
    draft=result(await x.service.command(p,{operation:'put_pipeline_intake',draftId:draft.id,expectedRevision:draft.revision,intake:contract}));
    const validation=result<{valid:boolean;verification:{availabilityProof:false;authorizationProof:false;kind:string}}>(await x.service.command(p,{operation:'validate_pipeline_intake',draftId:draft.id,expectedRevision:draft.revision,serviceId:contract.serviceId,expiresAt:new Date(Date.now()+300000).toISOString()}));
    assert(validation.valid);assert.equal(validation.verification.kind,'mapping_test');assert.equal(validation.verification.availabilityProof,false);assert.equal(validation.verification.authorizationProof,false);
    const published=result<{release:OntologyReleaseRef;draft:{revision:number}}>(await x.service.command(p,{operation:'publish_draft',draftId:draft.id,expectedRevision:draft.revision}));
    assert.notEqual(published.release.releaseId,before.active.releaseId);assert.deepEqual(await x.run(store=>store.namespace()),before,'Publication must not advance active pointer or generation');
    const repeated=result<{release:OntologyReleaseRef}>(await x.service.command(p,{operation:'publish_draft',draftId:draft.id,expectedRevision:draft.revision}));assert.deepEqual(repeated.release,published.release);
    await assert.rejects(x.service.command(p,{operation:'activate_release',release:published.release,expectedGeneration:before.generation+99}),/generation changed/);
    const activated=result<{generation:number;active:OntologyReleaseRef}>(await x.service.command(p,{operation:'activate_release',release:published.release,expectedGeneration:before.generation}));assert.equal(activated.generation,before.generation+1);assert.deepEqual(activated.active,published.release);
    assert.deepEqual(JSON.parse((await x.t.client.query(`SELECT body FROM ${x.q}.jobs WHERE id=$1`,[x.original.job.id])).rows[0].body).delegation.ontologyRelease,originalPin);
    const read=result<{publication:string;intake:PipelineIntake}>(await x.service.query(p,{operation:'get_pipeline_intake',serviceId:contract.serviceId}));assert.equal(read.publication,'published');assert.deepEqual(read.intake,contract);
    await assert.rejects(x.t.database.run(async client=>{await client.query(`UPDATE ${x.q}.ontology_definition_releases SET body='{}' WHERE id=$1`,[published.release.releaseId]);}),/Immutable history/);
    await assert.rejects(x.t.database.run(async client=>{await client.query(`DELETE FROM ${x.q}.ontology_definition_releases WHERE id=$1`,[published.release.releaseId]);}),/Immutable history/);
  }finally{await x.close();}
});

test('PG publication rejects missing, expired, revoked and changed Pipeline mapping evidence atomically',local,async()=>{
  const x=await fixture();try{
    const p=await x.principal(),before=await x.run(store=>store.namespace());let draft=result<Omit<DefinitionDraft,'document'>>(await x.service.command(p,{operation:'create_draft',title:'Synthetic evidence refusals'}));
    const contract=await x.run(async store=>intake(x.program,(await store.active()).model));draft=result(await x.service.command(p,{operation:'put_pipeline_intake',draftId:draft.id,expectedRevision:draft.revision,intake:contract}));
    const count=async()=>Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.ontology_definition_releases`)).rows[0].n),releases=await count();
    const publish=()=>x.service.command(p,{operation:'publish_draft',draftId:draft.id,expectedRevision:draft.revision});
    await assert.rejects(publish(),/fresh mapping validation/);assert.equal(await count(),releases);
    const stored=await x.run(async store=>({ref:(await store.draft(draft.id)).document.pipeline![0]!,contract:store.pipeline.contract((await store.active()).model,contract)}));
    const expired={id:randomUUID(),intakeDigest:stored.ref.intakeDigest,mappingDigest:pipelineMappingDigest(contract),contractDigest:stored.contract,kind:'mapping_test',level:'synthetic',actionIds:[],evidenceRefs:[],verifiedAt:new Date(Date.now()-3600000).toISOString(),expiresAt:new Date(Date.now()-1800000).toISOString(),availabilityProof:false,authorizationProof:false};
    await x.t.client.query(`INSERT INTO ${x.q}.ontology_pipeline_verifications(id,ontology_id,intake_digest,owner,body) VALUES($1,'eigos.business',$2,$3,$4)`,[expired.id,expired.intakeDigest,x.f.owner,JSON.stringify(expired)]);
    await assert.rejects(publish(),/fresh mapping validation/);assert.equal(await count(),releases);

    const proof=result<{verification:{id:string}}>(await x.service.command(p,{operation:'validate_pipeline_intake',draftId:draft.id,expectedRevision:draft.revision,serviceId:contract.serviceId,expiresAt:new Date(Date.now()+300000).toISOString()}));
    await x.run(store=>store.pipeline.event('eigos.business',x.f.owner,contract.serviceId,{kind:'verification_revoked',verificationId:proof.verification.id}));
    await assert.rejects(publish(),/fresh mapping validation/);
    await x.service.command(p,{operation:'validate_pipeline_intake',draftId:draft.id,expectedRevision:draft.revision,serviceId:contract.serviceId,expiresAt:new Date(Date.now()+300000).toISOString()});
    await x.run(store=>store.pipeline.event('eigos.business',x.f.owner,contract.serviceId,{kind:'source_changed',sourceDigest:digest('another contract')}));
    await assert.rejects(publish(),/Latest observed source contract differs/);assert.equal(await count(),releases);assert.deepEqual(await x.run(store=>store.namespace()),before);
    const saved=await x.run(store=>store.draft(draft.id));assert.equal(saved.status,'open');assert.equal(saved.revision,draft.revision);
  }finally{await x.close();}
});

function object(id:string):SerializableObjectType{return {...structuredClone(managedFixtureObject),id,resourceId:`synthetic:pg:${id}`,name:id,description:'Synthetic PG draft compatibility only'};}

test('PG fact-change reads propagate incomplete authorized object reads instead of returning an empty history',local,async()=>{
  const x=await fixture(true);try{
    const p=await x.principal(),tasks=new PostgresTaskCommandService(x.t.database,x.t.policy,x.t.kernel);
    const job=await tasks.submit(p,{requestId:'fact-change-incomplete',goal:'Synthetic owned fact change only'}),id=randomUUID();
    const change={id,componentId:'synthetic-component',object:{type:'ServiceRequest',id:job.id},reason:'changed',fields:['originalGoal'],semanticRevision:1,at:new Date().toISOString()};
    await x.t.client.query(`INSERT INTO ${x.q}.ontology_pipeline_fact_changes(id,owner,job_id,request_revision,body) VALUES($1,$2,$3,1,$4)`,[id,x.f.owner,job.id,JSON.stringify(change)]);
    const incomplete=new DomainError('CONFLICT','Synthetic incomplete authorized object read');let injected=false;
    const database={run:<T>(action:Parameters<typeof x.t.database.run<T>>[0])=>x.t.database.run(async client=>{
      const original=client.query;let changesRead=false,modelRead=false;
      client.query=(async(...args:unknown[])=>{
        const sql=String(args[0]);
        if(modelRead&&sql.includes('.ontology_objects')){injected=true;throw incomplete;}
        const value=await Reflect.apply(original,client,args);
        if(sql.includes('ontology_pipeline_fact_changes WHERE __eigos_rowid IN('))changesRead=true;
        if(changesRead&&sql.includes('.ontology_definition_releases'))modelRead=true;
        return value;
      }) as typeof client.query;
      try{return await action(client);}finally{client.query=original;}
    })};
    const service=new PostgresDefinitionService({database,tasks,catalog:new ExecutionCatalog([x.program.capability()],[],[],[],[x.program]),publisher:x.t.publisher,policyDigest:x.t.policy,builder:x.t.kernel});
    await assert.rejects(service.query(p,{operation:'get_pipeline_task_changes',taskId:job.id}),error=>error===incomplete);
    assert(injected,'The failure must occur inside the authorized object read');
  }finally{await x.close();}
});

test('PG draft revisions roll back with events and compatibility refuses narrowing, incomplete facts and rollback over newer types',local,async()=>{
  const x=await fixture();try{
    const namespace=await x.run(store=>store.createNamespace(x.f.owner,{id:'synthetic.pg.compatibility',name:'Synthetic compatibility'}));
    let draft=await x.run(store=>store.createDraft(x.f.owner,namespace.id,'Add a real type')),asset=object('SyntheticAsset');
    draft=await x.run(store=>store.putResource(x.f.owner,draft.id,draft.revision,'object',asset));const published=await x.run(store=>store.publish(x.f.owner,draft.id,draft.revision));
    let active=await x.run(store=>store.activate(x.f.owner,published.release,namespace.generation));
    const primary=asset.primaryKey,title=asset.titleKey,properties={[primary]:'asset-1',[title]:'Synthetic asset',status:'available'};
    await x.t.database.run(async client=>{const graph=await PostgresProjectionGraph.create(client,x.f.owner,published.release,x.t.kernel);await graph.ingest(x.f.owner,{objects:[{ref:{type:asset.id,id:'asset-1'},properties}]},{kind:'user',id:'synthetic-fixture',observedAt:new Date().toISOString()});});
    let revise=await x.run(store=>store.createDraft(x.f.owner,namespace.id,'Illegal identity change'));const changed={...asset,titleKey:primary};
    revise=await x.run(store=>store.putResource(x.f.owner,revise.id,revise.revision,'object',changed));const check=await x.run(store=>store.validate(revise.id));assert.equal(check.valid,false);assert.equal(check.migrationRequired,true);
    await assert.rejects(x.run(store=>store.publish(x.f.owner,revise.id,revise.revision)),/migration/);
    const original=await x.run(store=>store.draft(revise.id)),eventsBefore=await x.run(store=>store.events(namespace.id,100));
    await assert.rejects(x.run(async store=>{await store.putResource(x.f.owner,revise.id,original.revision,'object',asset);throw new Error('Synthetic draft rollback');}),/Synthetic draft rollback/);
    assert.deepEqual(await x.run(store=>store.draft(revise.id)),original);assert.deepEqual(await x.run(store=>store.events(namespace.id,100)),eventsBefore);
    let next=await x.run(store=>store.createDraft(x.f.owner,namespace.id,'Add a newer type'));const newer=object('SyntheticNewerAsset');next=await x.run(store=>store.putResource(x.f.owner,next.id,next.revision,'object',newer));const released=await x.run(store=>store.publish(x.f.owner,next.id,next.revision));
    active=await x.run(store=>store.activate(x.f.owner,released.release,active.generation));
    await x.t.database.run(async client=>{const graph=await PostgresProjectionGraph.create(client,x.f.owner,released.release,x.t.kernel);await graph.ingest(x.f.owner,{objects:[{ref:{type:newer.id,id:'newer-1'},properties:{[newer.primaryKey]:'newer-1',[newer.titleKey]:'Newer synthetic fact',status:'available'}}]},{kind:'user',id:'synthetic-fixture',observedAt:new Date().toISOString()});});
    await assert.rejects(x.run(store=>store.activate(x.f.owner,published.release,active.generation)),/migration|reinterpret/);assert.deepEqual(await x.run(store=>store.namespace(namespace.id)),active);
    const overflow=await x.run(store=>store.createDraft(x.f.owner,namespace.id,'Unknown fact coverage'));const optional={...newer,properties:{...newer.properties,note:{kind:'string' as const,schema:{type:'string',maxLength:200},description:'Optional synthetic note',source:'Owner input'}}};const edited=await x.run(store=>store.putResource(x.f.owner,overflow.id,overflow.revision,'object',optional));
    await x.t.client.query(`UPDATE ${x.q}.ontology_scoped_objects SET body=jsonb_set(body::jsonb,'{padding}',to_jsonb($1::text))::text WHERE ontology_id=$2 AND owner=$3 AND type=$4`,['x'.repeat(1048577),namespace.id,x.f.owner,newer.id]);
    const incomplete=await x.run(store=>store.validate(edited.id));assert.equal(incomplete.valid,false);assert.equal(incomplete.migrationRequired,true);
  }finally{await x.close();}
});

test('PG fixed v35 publication preserves canonical historical versions, lineage, tasks and separate activation',local,async()=>{
  const x=await fixture(),kernel=await preparePostgresKernel(undefined,'35');
  const run=<T>(action:(store:PostgresDefinitionStore)=>Promise<T>)=>x.t.database.run(client=>action(new PostgresDefinitionStore(client,{builder:kernel})));
  try{
    const originalPin=x.original.job.delegation!.ontologyRelease!,before=await run(store=>store.namespace()),actor='system:synthetic-kernel-maintenance';
    const historical={...createPaClassificationKernelDefinition().document,version:'release-13'},legacyRef={ontologyId:historical.id,releaseId:randomUUID(),digest:digest(historical)};
    // Fixture-only historical ordinary publication. Its document is canonical
    // v30 apart from the display version; no production row is rewritten.
    await x.t.database.run(async client=>{
      const store=new PostgresDefinitionStore(client,{builder:kernel});
      await client.query(`INSERT INTO ${x.q}.ontology_definition_releases(id,ontology_id,sequence,digest,model_digest,body,created_at)
        VALUES($1,$2,(SELECT max(sequence)+1 FROM ${x.q}.ontology_definition_releases),$3,$4,$5,$6)`,[legacyRef.releaseId,legacyRef.ontologyId,legacyRef.digest,store.compile(historical).ref.digest,JSON.stringify(historical),new Date().toISOString()]);
      await client.query(`UPDATE ${x.q}.ontology_namespaces SET active_release_id=$1,generation=generation+1 WHERE id=$2`,[legacyRef.releaseId,legacyRef.ontologyId]);
    });
    const expectedActive={ref:legacyRef,generation:before.generation+1},request={expectedActive,reviewDigest:digest('synthetic v35 review')};
    const events=async()=>Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.ontology_definition_events`)).rows[0].n);
    await assert.rejects(run(store=>store.publishReviewedKernel(actor,request)),/administrator/);
    await assert.rejects(run(store=>store.publishReviewedKernel(actor,{...request,expectedActive:{...expectedActive,generation:expectedActive.generation+1}},true)),/active ontology changed/);
    await assert.rejects(x.t.database.run(async client=>{
      const semantic=createSemanticRetrievalKernelDefinition(),ref={ontologyId:semantic.document.id,releaseId:randomUUID(),digest:digest(semantic.document)};
      await client.query(`INSERT INTO ${x.q}.ontology_definition_releases(id,ontology_id,sequence,digest,model_digest,body,created_at)
        VALUES($1,$2,(SELECT max(sequence)+1 FROM ${x.q}.ontology_definition_releases),$3,$4,$5,$6)`,[ref.releaseId,ref.ontologyId,ref.digest,semantic.audit.model.digest,JSON.stringify(semantic.document),new Date().toISOString()]);
      await client.query(`UPDATE ${x.q}.ontology_namespaces SET active_release_id=$1 WHERE id=$2`,[ref.releaseId,ref.ontologyId]);
      await new PostgresDefinitionStore(client,{builder:kernel}).publishReviewedKernel(actor,{...request,expectedActive:{...expectedActive,ref}},true);
    }),/canonical predecessor/,'The independently installed v29 vector branch is explicitly refused before optional handler resolution');
    assert.deepEqual((await run(store=>store.namespace())).active,legacyRef);
    for(const variant of ['predecessor','target'] as const){
      await assert.rejects(x.t.database.run(async client=>{
        const store=new PostgresDefinitionStore(client,{builder:kernel}),document={...(variant==='predecessor'?historical:StagedKernelBuilder.prototype.result.call(kernel).document),pipeline:[]};
        const ref={ontologyId:document.id,releaseId:randomUUID(),digest:digest(document)};
        await client.query(`INSERT INTO ${x.q}.ontology_definition_releases(id,ontology_id,sequence,digest,model_digest,body,created_at)
          VALUES($1,$2,(SELECT max(sequence)+1 FROM ${x.q}.ontology_definition_releases),$3,$4,$5,$6)`,[ref.releaseId,ref.ontologyId,ref.digest,store.compile(document).ref.digest,JSON.stringify(document),new Date().toISOString()]);
        if(variant==='predecessor')await client.query(`UPDATE ${x.q}.ontology_namespaces SET active_release_id=$1 WHERE id=$2`,[ref.releaseId,ref.ontologyId]);
        await store.publishReviewedKernel(actor,variant==='predecessor'?{...request,expectedActive:{...expectedActive,ref}}:request,true);
      }),variant==='predecessor'?/unchanged canonical predecessor/:/existing v35 release differs/);
    }
    const published=await run(store=>store.publishReviewedKernel(actor,request,true));assert(published.created);
    assert.equal(published.release.digest,FUNCTION_CONTRACT_CLOSEOUT_DOCUMENT_DIGEST);assert.deepEqual(published.namespace.active,legacyRef);assert.equal(published.namespace.generation,expectedActive.generation);
    const resolved=await run(store=>store.resolve(published.release));assert.equal(resolved.document.version,'35');assert.deepEqual(resolved.model.ref,FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF);
    const count=await events(),repeat=await run(store=>store.publishReviewedKernel(actor,request,true));assert.equal(repeat.created,false);assert.deepEqual(repeat.release,published.release);assert.equal(await events(),count);
    await assert.rejects(run(store=>store.publishReviewedKernel(actor,{...request,reviewDigest:digest('another review')},true)),/publication preconditions changed/);
    const changedLineage={...request,expectedActive:{...expectedActive,ref:before.active}};
    await assert.rejects(run(store=>store.inspectReviewedKernel(actor,changedLineage,published.release,'published',true)),/publication lineage changed/);
    await x.t.client.query(`INSERT INTO ${x.q}.ontology_objects(owner,type,id,revision,definition_digest,body) VALUES('synthetic','UnreviewedType','fixture',1,$1,'{"properties":{}}')`,['a'.repeat(64)]);
    await assert.rejects(run(store=>store.activateReviewedKernel(actor,request,published.release,true)),/data migration/);
    assert.deepEqual((await run(store=>store.namespace())).active,legacyRef);
    await x.t.client.query(`DELETE FROM ${x.q}.ontology_objects WHERE owner='synthetic' AND type='UnreviewedType' AND id='fixture'`);
    const activated=await run(store=>store.activateReviewedKernel(actor,request,published.release,true));assert.equal(activated.namespace.generation,expectedActive.generation+1);assert.deepEqual(activated.namespace.active,published.release);
    const activatedEvents=await events();assert.deepEqual(await run(store=>store.activateReviewedKernel(actor,request,published.release,true)),activated);assert.equal(await events(),activatedEvents);
    await assert.rejects(run(store=>store.publishReviewedKernel(actor,request,true)),/active ontology changed/);
    await assert.rejects(run(store=>store.inspectReviewedKernel(actor,{...request,expectedActive:{...expectedActive,generation:expectedActive.generation+1}},published.release,'active',true)),/publication preconditions changed/);
    assert.deepEqual(JSON.parse((await x.t.client.query(`SELECT body FROM ${x.q}.jobs WHERE id=$1`,[x.original.job.id])).rows[0].body).delegation.ontologyRelease,originalPin);
    await x.t.client.query(`UPDATE ${x.q}.ontology_namespaces SET generation=generation+1 WHERE id=$1`,[legacyRef.ontologyId]);
    await assert.rejects(run(store=>store.activateReviewedKernel(actor,request,published.release,true)),/activation generation changed/);
  }finally{await x.close();}
});
