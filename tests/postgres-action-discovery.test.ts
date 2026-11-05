import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {securityFixture} from './fixtures/security.js';
import {importPostgresPrimaryFixture} from './fixtures/postgres-primary.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import type {ActionDiscoveryPage,ActionDiscoveryQuery} from '../packages/core/action-bindings.js';
import {digest} from '../packages/core/delegation.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {LocalArtifactProgram} from '../packages/capabilities/local-artifact-agent.js';
import {createDynamicOntologyProgram} from '../packages/capabilities/dynamic-ontology.js';
import {TaskSecurity} from '../packages/security/task-service.js';
import {createSubmittedTask} from '../packages/core/task-submission.js';
import {DomainError,type Principal} from '../packages/core/domain.js';
import {SecurityError} from '../packages/security/errors.js';
import {PostgresDefinitionService} from '../packages/postgres/definition-service.js';
import {PostgresDefinitionStore} from '../packages/postgres/definition-store.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {discoverPostgresTaskActions} from '../packages/postgres/action-discovery.js';
import {parsePipelineIntake} from '../packages/ontology/pipeline/contracts.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
const page=(value:{version:1;result:unknown})=>value.result as ActionDiscoveryPage;
function sourceFixture(pipeline=false){
  const f=securityFixture(Date.now,{unified:true}),document=new DocumentAgentProgram(),brief=new LocalArtifactProgram('brief');
  try{
    const expiresAt=new Date(Date.now()+3600000).toISOString();
    if(pipeline){
      const active=f.jobs.definitions.active(),intake=parsePipelineIntake({format:'eigos.ontology.pipeline.v1',serviceId:'synthetic.agent.directory',source:{id:'synthetic.directory.contract',revision:'1',digest:digest('synthetic-only'),observedAt:new Date(Date.now()-1000).toISOString(),reference:'urn:eigos:synthetic:action-directory'},
        programRef:document.ref,configurationDigest:document.configurationDigest,environment:'local',vocabulary:[],actions:[{actionId:'ComposeDocument',definitionDigest:digest(active.model.action('ComposeDocument')),requiredEvidence:'local_test'}],mappings:[],fixtures:[],conditions:{regions:['synthetic-region'],payment:'not_required',operatorRequired:false}});
      let draft=f.jobs.definitions.createDraft(f.owner,active.ref.ontologyId,'Synthetic directory Pipeline',true);
      draft=f.jobs.definitions.putPipeline(f.owner,draft.id,draft.revision,intake,true);assert(f.jobs.definitions.validatePipeline(f.owner,draft.id,draft.revision,intake.serviceId,expiresAt,true).valid);
      const published=f.jobs.definitions.publish(f.owner,draft.id,draft.revision,true);f.jobs.definitions.activate(f.owner,published.release,f.jobs.definitions.namespace().generation,true);
    }
    const active=f.jobs.definitions.active(),model=active.model,dynamic=createDynamicOntologyProgram(f.jobs.ontologyForRelease(active.ref),f.owner)!;
    const installation=f.installation('Synthetic Agent action directory',3600000),programs=[document,brief,dynamic],bindings=programs.map((_program,index)=>`synthetic-directory-source-${index}`);
    const types=['ServiceRequest','DocumentTask','DocumentDraft','BriefTask','TaskBrief','RequestSpecification','Person','PersonalPreference'];
    const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only');
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[...new Set(programs.flatMap(program=>[program.ref.id,program.capability().ref.id]))],
      resources:types.map(type=>({type,fields:fields(type)})),sourceBindingIds:bindings,channels:['agent_response'],expiresAt});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
    const outputs=[['DocumentTask','DocumentDraft'],['BriefTask','TaskBrief'],['Person','PersonalPreference']];
    for(const [index,program] of programs.entries())f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId:bindings[index]!,programId:program.ref.id,programDigest:program.configurationDigest,
      operations:[...program.actionIds],outputTypes:outputs[index]!,expiresAt},f.jobs.security.policies.revision());
    const sourcePrincipal={...f.principal,scopes:f.principal.scopes.filter(scope=>scope!=='services:read')},principal={...sourcePrincipal,access:f.coordinator.authenticate(sourcePrincipal,installation.token)};
    // Real issuance, bindings and the original root precede the offline import.
    const submitted=new TaskSecurity(f.jobs).submit(principal,()=>{const job=createSubmittedTask(principal,{service:'eigos.delegate',goal:'Inspect supplied synthetic action contracts only',requestId:randomUUID()},active.ref);f.jobs.save(f.owner,job);return job;}),task=f.jobs.get(f.owner,submitted.id);
    const original=f.jobs.security.listGrants(f.owner).find(value=>value.kind==='task_data'&&value.taskId===task.id);assert(original&&original.kind==='task_data');
    f.jobs.security.revokeGrant(f.owner,original.id,original.revision);
    // The Agent owns query permission, never result-read or model delivery.
    const grant=f.jobs.security.issueTaskGrant({...original,id:randomUUID(),operations:['task.query'],channels:['agent_response']});
    const catalog=new ExecutionCatalog([document.capability(),brief.capability()],[],[],[],[document,brief],createDynamicOntologyProgram,f.jobs.security),request=task.delegation!.request;
    const oracle=(query:ActionDiscoveryQuery)=>f.jobs.security.withAgent(principal,task.id,'task.query',()=>f.jobs.security.policies.readSnapshot(()=>catalog.discoverActions(f.jobs.ontologyForJob(f.owner,task),f.owner,request,query)));
    const expected={document:oracle({actionId:'ComposeDocument'}),first:oracle({limit:1}),personal:oracle({actionId:'BindSelfPerson'})};
    return {f,document,brief,dynamic,installation,bindings,principal,task,grant,expected};
  }catch(error){f.close();throw error;}
}
async function fixture(pipeline=false){
  const source=sourceFixture(pipeline),{f,document,brief,dynamic,installation,bindings,principal,task,grant,expected}=source;
  let target:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>|undefined;
  try{
    target=await importPostgresPrimaryFixture(f);const t=target,q=`"${t.schema}"`;
    const verified={...f.principal,scopes:principal.scopes},p:Principal={...verified,access:await t.publisher.authenticate(verified,installation.token)};
    // The PG catalog has actual host programs and no SQLite authority object.
    const pgCatalog=new ExecutionCatalog([document.capability(),brief.capability()],[],[],[],[document,brief],createDynamicOntologyProgram);
    const service=(selected=pgCatalog)=>new PostgresDefinitionService({database:t.database,tasks:new PostgresTaskCommandService(t.database,t.policy,t.kernel),catalog:selected,publisher:t.publisher,policyDigest:t.policy,builder:t.kernel});
    const discover=(query:ActionDiscoveryQuery={},selected=pgCatalog,actor=p)=>service(selected).query(actor,{operation:'discover_task_actions',taskId:task.id,query}).then(page);
    const run=<T>(action:(store:PostgresDefinitionStore)=>Promise<T>)=>t.database.run(client=>t.publisher.withManagement(client,()=>action(new PostgresDefinitionStore(client,{builder:t.kernel}))));
    return {f,t,q,p,task,grant,installation,document,brief,dynamic,bindings,expected,pgCatalog,service,discover,run,close:async()=>{try{await t.close();}finally{f.close();}}};
  }catch(error){try{await target?.close();}finally{f.close();}throw error;}
}

test('the offline source oracle records a real query-only Agent directory without executing a program',()=>{
  const x=sourceFixture();try{
    assert.deepEqual(x.grant.operations,['task.query']);assert.equal(x.expected.document.items[0]!.status,'available');
    assert.equal(x.expected.personal.items[0]!.bindings[0]!.pin.programRef.id,x.dynamic.ref.id);assert(x.expected.first.page.hasMore);
  }finally{x.f.close();}
});

test('the offline source oracle keeps Pipeline validation separate from action readiness',()=>{
  const x=sourceFixture(true);try{
    const binding=x.expected.document.items[0]!.bindings[0]!;
    assert.equal(binding.readiness,'pipeline_unverified');assert.equal(binding.pipeline!.status,'verification_required');
  }finally{x.f.close();}
});

test('Agent PG directory has the exact SQLite pins and opaque binding-row pages using task.query alone',local,async()=>{
  const x=await fixture();try{
    assert(!x.grant.operations.includes('task.result.read'));assert.deepEqual(x.grant.channels,['agent_response']);
    const document=await x.discover({actionId:'ComposeDocument'});assert.deepEqual(document,x.expected.document);assert.equal(document.items[0]!.status,'available');assert.equal(document.authorization,'per_action_required');
    const personal=await x.discover({actionId:'BindSelfPerson'});assert.deepEqual(personal,x.expected.personal);assert.equal(personal.items[0]!.bindings[0]!.pin.programRef.id,x.dynamic.ref.id);
    const first=await x.discover({limit:1});assert.deepEqual(first,x.expected.first);assert(first.page.hasMore);
    const second=await x.discover({limit:1,cursor:first.page.cursor});assert.notDeepEqual(second.items,first.items);
    await assert.rejects(x.discover({search:'different-query',cursor:first.page.cursor}),/cursor/);
    await assert.rejects(x.discover({cursor:'not-a-cursor'}),/cursor/);
    await assert.rejects(x.discover({inputType:'UnregisteredType'}),/Unknown action discovery type/);
    await assert.rejects(x.service().query(x.p,{operation:'discover_task_actions',taskId:x.task.id,query:{modelChannel:'caller-selected-model'}}),/Unrecognized|unrecognized/);
    const output=JSON.stringify(document);for(const forbidden of ['registered_model','modelChannel','privateData','assertDispatchAllowed','eligibility','credential'])assert(!output.includes(forbidden));
    assert.equal((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_intents`)).rows[0].n,'0','Directory metadata creates no execution intent or permission');
  }finally{await x.close();}
});

test('Agent PG directory keeps exact old task releases after explicit activation and reports missing handlers honestly',local,async()=>{
  const x=await fixture();try{
    const original=await x.discover({actionId:'BindSelfPerson'}),namespace=await x.run(store=>store.namespace()),draft=await x.run(store=>store.createDraft(x.f.owner,'eigos.business','Synthetic metadata release',true));
    const published=await x.run(store=>store.publish(x.f.owner,draft.id,draft.revision,true));await x.run(store=>store.activate(x.f.owner,published.release,namespace.generation,true));
    assert.notDeepEqual(published.release,original.ontologyRelease);assert.deepEqual(await x.discover({actionId:'BindSelfPerson'}),original);
    const absent=await x.discover({actionId:'ComposeDocument'},new ExecutionCatalog([],[],[]));assert.equal(absent.items[0]!.status,'binding_unavailable');assert.deepEqual(absent.items[0]!.bindings,[]);
    const unrelated=await x.discover({programRef:{id:'not-configured',version:'1'},actionId:'ComposeDocument'});assert.equal(unrelated.items[0]!.status,'binding_unavailable');
  }finally{await x.close();}
});

test('Agent PG directory rechecks namespace roles, owner, sources, field clearance and the actual task grant',local,async()=>{
  const x=await fixture();try{
    await assert.rejects(x.discover({actionId:'ComposeDocument'},x.pgCatalog,{...x.p,subject:'foreign-owner'}),error=>error instanceof SecurityError);
    const first=await x.discover({limit:1});assert(first.page.cursor);
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindings[0]]);
    await assert.rejects(x.discover({limit:1,cursor:first.page.cursor}),/cursor/);
    const denied=await x.discover({actionId:'ComposeDocument'});assert.equal(denied.items[0]!.status,'not_ready');assert.equal(denied.items[0]!.bindings[0]!.readiness,'source_authorization_required');
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='active' WHERE binding_id=$1`,[x.bindings[0]]);
    const changedBrief=new LocalArtifactProgram('brief','synthetic-changed-configuration'),changedCatalog=new ExecutionCatalog([x.document.capability(),changedBrief.capability()],[],[],[],[x.document,changedBrief],createDynamicOntologyProgram);
    const changed=await x.discover({actionId:'PrepareTaskBrief'},changedCatalog);assert.equal(changed.items[0]!.bindings[0]!.readiness,'source_authorization_required');assert.notEqual(changed.items[0]!.bindings[0]!.pin.configurationDigest,x.brief.configurationDigest);
    const conditions=await x.discover({actionId:'ComposeDocument',serviceConditions:{region:'not-declared'}});assert.equal(conditions.items[0]!.bindings[0]!.readiness,'conditions_unmet');
    const roles=(await x.t.client.query(`SELECT id,body FROM ${x.q}.security_roles WHERE subject_id=$1`,[x.installation.id])).rows;assert(roles.length);
    for(const row of roles)await x.t.client.query(`UPDATE ${x.q}.security_roles SET body=$1 WHERE id=$2`,[JSON.stringify({...JSON.parse(row.body),expiresAt:new Date(Date.now()-1).toISOString()}),row.id]);
    await assert.rejects(x.discover({actionId:'ComposeDocument'}),error=>error instanceof SecurityError||error instanceof DomainError);
    for(const row of roles)await x.t.client.query(`UPDATE ${x.q}.security_roles SET body=$1 WHERE id=$2`,[row.body,row.id]);
    const originalGrant=(await x.t.client.query(`SELECT body FROM ${x.q}.security_grants WHERE id=$1`,[x.grant.id])).rows[0].body;
    await x.t.client.query(`UPDATE ${x.q}.security_grants SET body=$1 WHERE id=$2`,[JSON.stringify({...JSON.parse(originalGrant),operations:['task.process']}),x.grant.id]);
    await assert.rejects(x.discover({actionId:'ComposeDocument'}),error=>error instanceof SecurityError&&error.reason==='AUTHORIZATION_REQUIRED');
    await x.t.client.query(`UPDATE ${x.q}.security_grants SET body=$1 WHERE id=$2`,[originalGrant,x.grant.id]);
    await x.t.client.query(`DELETE FROM ${x.q}.security_recipients WHERE installation_id=$1`,[x.installation.id]);
    await assert.rejects(x.discover({actionId:'ComposeDocument'}),error=>error instanceof SecurityError);
  }finally{await x.close();}
});

test('Agent PG directory evaluates actual published Pipeline status and refuses incomplete proof history',local,async()=>{
  const x=await fixture(true);try{
    const before=await x.discover({actionId:'ComposeDocument'});assert.equal(before.items[0]!.status,'not_ready');assert.equal(before.items[0]!.bindings[0]!.readiness,'pipeline_unverified');assert.equal(before.items[0]!.bindings[0]!.pipeline!.status,'verification_required');
    const release=await x.run(store=>store.resolve(before.ontologyRelease)),ref=release.document.pipeline![0]!;
    await x.t.client.query(`INSERT INTO ${x.q}.ontology_pipeline_verifications(id,ontology_id,intake_digest,owner,body) VALUES($1,$2,$3,$4,$5)`,[randomUUID(),'eigos.business',ref.intakeDigest,x.f.owner,'{"kind":"task_evidence","missing":"required-proof-identity"}']);
    await assert.rejects(x.discover({actionId:'ComposeDocument'}),error=>error instanceof DomainError&&error.code==='CONFLICT'||error instanceof Error&&error.name==='ZodError');
    // Direct host calls still require the actual authenticated Agent scope.
    const missingScope={...x.p,scopes:x.p.scopes.filter(scope=>scope!=='ontology:read')};
    await assert.rejects(x.t.database.run(client=>x.t.publisher.withManagement(client,()=>discoverPostgresTaskActions(client,missingScope,x.task.id,'eigos.business',{}, {catalog:x.pgCatalog,policyDigest:x.t.policy,builder:x.t.kernel}))),error=>error instanceof SecurityError||error instanceof DomainError);
  }finally{await x.close();}
});
