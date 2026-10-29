import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { securityFixture } from './fixtures/security.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { TaskService } from '../packages/core/tasks.js';
import {currentKernelImplementation} from '../packages/ontology/definition-store.js';
const businessModel=currentKernelImplementation();
import { withAuthorization } from '../packages/security/context.js';
import { assertModelChannel,secureRequest } from '../packages/security/model.js';
import { combineEnvelopes,requireChannel } from '../packages/security/envelope.js';
import { SECURITY_CONTRACT,POLICY_VERSION } from '../packages/security/contracts.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import { reasonWithOntology } from '../packages/coordinator/reasoning-loop.js';
import {JobStore} from '../packages/core/store.js';
import type {Job} from '../packages/core/domain.js';

function fixture(now:()=>number=Date.now) {
  const f=securityFixture(now),a=f.installation('A'),b=f.installation('B'),policy=f.jobs.security.policies,until=new Date(Date.now()+3600000).toISOString();
  for(const install of [a,b]) {
    f.coordinator.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:['brief.prepare'],resources:[{type:'ServiceRequest',fields:['requestId','displayTitle','originalGoal','revision','conditions','progress','createdAt']}],sourceBindingIds:[],channels:['agent_response','registered_model','controlled_download'],expiresAt:until});
    policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:businessModel.ref.id,version:businessModel.ref.digest},role:'Viewer',expiresAt:until},policy.revision());
    policy.setRecipient(install.id,{classification:'sensitive',markings:['member_private','personal_data','health'],channels:['agent_response','registered_model','controlled_download'],expiresAt:until},policy.revision());
  }
  const principal=(install:typeof a,scopes=f.principal.scopes)=>({...f.principal,scopes,access:f.coordinator.authenticate({...f.principal,scopes},install.token)});
  const pa=principal(a),pb=principal(b),tasks=new TaskService(f.jobs,{catalog:new ExecutionCatalog([],[],[]),waitTimeoutMs:500});
  function claim(id:string) {const claim=f.jobs.claim(['eigos.delegate'],10000)!;assert.equal(claim.job.id,id);return {claim,scope:f.jobs.security.workerScope(f.owner,id,claim.securityAuthorityId!,claim.token)};}
  function publish(id:string,artifact?:NonNullable<Job['artifact']>) {
    const work=claim(id);
    withAuthorization(work.scope,()=>{
      secureRequest(f.jobs.ontology,f.owner,f.jobs.get(f.owner,id).delegation!.request);
      assert.equal(f.jobs.finish(work.claim,job=>{job.state='completed';job.question='A scoped question';job.artifact=artifact??{id:randomUUID(),name:'Result',data:{goal:job.goal,deliverable:'report',execution:'completed',markdown:'Scoped report',result:{privatePayload:'PRIVATE_RESULT'}}};job.delegation!.events.push({at:new Date().toISOString(),event:'PRIVATE_LEDGER'});}),true);
    });
    return work;
  }
  return {...f,a,b,pa,pb,policy,until,principal,tasks,claim,publish};
}

test('sealed native goal delivery extracts only bounded verified typed references and never child payloads',()=>{
  const f=fixture();try {
    const task=f.tasks.submit(f.pa,{service:'eigos.delegate',requestId:randomUUID(),goal:'Scoped goal result'}),ref={type:'ServiceRequest',id:task.id};
    const child={data:{execution:'completed',result:{securityEvidenceRefs:[ref,ref],privatePayload:'PRIVATE_CHILD'}}};
    const artifact:NonNullable<Job['artifact']>={id:randomUUID(),name:'goal-result.json',data:{goal:task.goal,deliverable:'Verified goal',execution:'completed',result:{version:'1',goalDigest:'a'.repeat(64),securityEvidenceRefs:[ref],components:[
      {contextId:'verified',status:'verified',artifact:child},
      {contextId:'unverified',status:'unverified',artifact:{data:{result:{securityEvidenceRefs:[{type:'ServiceRequest',id:'another-task'}]}}}},
    ],privateNested:{securityEvidenceRefs:[{type:'ServiceRequest',id:'not-a-reviewed-slot'}]}}}};
    f.publish(task.id,artifact);
    const result=f.tasks.get(f.pa,task.id),observations=(result.artifact!.data.result as {observations:{ref:unknown}[]}).observations;
    assert.deepEqual(observations.map(value=>value.ref),[ref]);assert(!JSON.stringify(result).includes('PRIVATE_'));assert(!JSON.stringify(result).includes('components'));
    assert.throws(()=>f.tasks.get(f.pb,task.id),/AUTHORIZATION_REQUIRED/);
    const db=new DatabaseSync(f.database);try {
      const job=f.jobs.get(f.owner,task.id);job.artifact!.data.deliverable='Tampered after sealing';
      db.prepare('UPDATE jobs SET body=? WHERE owner=? AND id=?').run(JSON.stringify(job),f.owner,task.id);
      assert.equal(f.tasks.get(f.pa,task.id).artifact,undefined,'Reference extraction never bypasses the original artifact seal');
    }finally{db.close();}
  }finally{f.close();}
});

test('native delivery refuses malformed or oversized evidence without accepting a generic summary',()=>{
  const f=fixture();try {
    const cases=[
      {components:[{contextId:'bad',status:'verified',artifact:{data:{execution:'completed',result:{securityEvidenceRefs:['receipt-id']}}}}]},
      {components:Array.from({length:17},(_,i)=>({contextId:`c${i}`,status:'unverified'}))},
      {components:[{contextId:'many',status:'verified',artifact:{data:{execution:'completed',result:{securityEvidenceRefs:Array.from({length:20},(_,i)=>({type:'ServiceRequest',id:`ref-${i}`}))}}}}],securityEvidenceRefs:[{type:'ServiceRequest',id:'ref-20'}]},
    ];
    for(const value of cases) {
      const task=f.tasks.submit(f.pa,{service:'eigos.delegate',requestId:randomUUID(),goal:'Bounded result'});
      f.publish(task.id,{id:randomUUID(),name:'goal-result.json',data:{goal:task.goal,deliverable:'Summary is not evidence',execution:'completed',result:{version:'1',goalDigest:'a'.repeat(64),...value}}});
      const view=f.tasks.get(f.pa,task.id);assert.equal(view.artifact,undefined);assert.equal('outputStatus' in view?view.outputStatus:undefined,'restricted');assert(!('accepted' in view));
    }
  }finally{f.close();}
});

test('sealed partial goal observations remain task-bound and do not imply whole-goal acceptance',()=>{
  const f=fixture();try {
    const task=f.tasks.submit(f.pa,{service:'eigos.delegate',requestId:randomUUID(),goal:'Partial source result'}),ref={type:'ServiceRequest',id:task.id};
    f.publish(task.id,{id:randomUUID(),name:'partial-goal-result.json',data:{goal:task.goal,deliverable:'Partial observation',execution:'partial',result:{version:'1',goalDigest:'a'.repeat(64),accepted:false,observedResults:[{object:ref,properties:{privatePayload:'PRIVATE_SNAPSHOT'}},{object:{type:'ServiceRequest',id:'unavailable'},currentObjectUnavailable:true}]}}});
    const view=f.tasks.get(f.pa,task.id);assert.equal(view.artifact!.data.execution,'partial');assert(!('accepted' in view));
    assert.deepEqual((view.artifact!.data.result as {observations:{ref:unknown}[]}).observations.map(item=>item.ref),[ref]);assert(!JSON.stringify(view).includes('PRIVATE_'));
    const other=f.tasks.submit(f.pa,{service:'eigos.delegate',requestId:randomUUID(),goal:'Different task'});
    f.publish(other.id,{id:randomUUID(),name:'goal-result.json',data:{goal:other.goal,deliverable:'Cross-task ref',execution:'completed',result:{version:'1',goalDigest:'a'.repeat(64),components:[{contextId:'wrong',status:'verified',artifact:{data:{execution:'completed',result:{securityEvidenceRefs:[ref]}}}}]}}});
    assert.throws(()=>f.tasks.get(f.pa,other.id),/AUTHORIZATION_REQUIRED|not available/);
  }finally{f.close();}
});

test('TaskView shares one bounded authorization read while retaining output lineage checks',()=>{
  let now=Date.now();const f=fixture(()=>now);try {
    const task=f.tasks.submit(f.pa,{service:'eigos.delegate',requestId:'bounded-read',goal:'Scoped result'});f.publish(task.id);
    const create=f.jobs.security.scope.bind(f.jobs.security);let checks=0;
    f.jobs.security.scope=(...args)=>{const scope=create(...args),check=scope.assertCurrent;scope.assertCurrent=()=>{checks++;now+=20;check();};return scope;};
    const view=f.tasks.get(f.pa,task.id);assert.equal(view.artifact?.data.markdown,'Scoped report');
    assert(checks<=5,`A slow check must not repeat for every result field: ${checks}`);
    const db=new DatabaseSync(f.database,{readOnly:true});let envelope;
    try{envelope=JSON.parse(String(db.prepare("SELECT body FROM security_outputs WHERE task_id=? AND output_id='artifact'").get(task.id)!.body));}finally{db.close();}
    checks=0;
    f.jobs.security.withAgent(f.pa,task.id,'task.result.read',scope=>f.policy.validateLineage(scope,envelope));
    assert(checks<=4,`Standalone lineage validation also shares checked bindings: ${checks}`);
    f.coordinator.revokeInstallation(f.member.id,f.a.id);
    assert.throws(()=>f.tasks.get(f.pa,task.id),/ACCESS_REVOKED/);
  }finally{f.close();}
});

test('TaskView covers submit/get/list/wait/mutation/replay without internal Job fields',async()=>{
  const f=fixture();try {
    const input={service:'eigos.delegate',requestId:'same-submit',goal:'My task'};
    const x=f.tasks.submit(f.pa,input);assert.equal((x as {view?:string}).view,'eigos.task.v2');assert.ok(!('delegation' in x));
    f.publish(x.id);
    for(const value of [f.tasks.get(f.pa,x.id),f.tasks.list(f.pa,{limit:10,offset:0}),await f.tasks.wait(f.pa,x.id),f.tasks.submit(f.pa,input)]) {
      const text=JSON.stringify(value);assert.ok(!text.includes('PRIVATE_'));assert.ok(!text.includes('delegation'));assert.ok(!text.includes('runs'));assert.ok(text.includes('Scoped report'));
    }
    const db=new DatabaseSync(f.database,{readOnly:true});try{const rows=db.prepare('SELECT response FROM requests').all();assert.deepEqual(JSON.parse(String(rows[0]!.response)),{taskId:x.id});}finally{db.close();}
    assert.throws(()=>f.tasks.get(f.pb,x.id),/AUTHORIZATION_REQUIRED/);
    const y=f.tasks.submit(f.pb,input);assert.notEqual(x.id,y.id);
    assert.equal(f.tasks.list(f.pa,{limit:10,offset:0}).total,1);assert.equal(f.tasks.list(f.pb,{limit:10,offset:0}).total,1);
    assert.throws(()=>f.tasks.submit(f.pb,{...input,requestId:'different-context'},x.contextId),/Context not found/);
    const canceled=f.tasks.cancel(f.pb,y.id);assert.equal(canceled.state,'canceled');assert.ok(!('delegation' in canceled));
    const grant=f.jobs.security.taskGrant(f.pa.access as Extract<NonNullable<typeof f.pa.access>,{actorKind:'agent'}>,x.id);
    f.jobs.security.revokeGrant(f.owner,grant.id,grant.revision);
    assert.throws(()=>f.tasks.submit(f.pa,input),/AUTHORIZATION_REQUIRED/);
  }finally{f.close();}
});

test('write-only submissions and blocking waits return minimal receipts',async()=>{
  const f=fixture();try {
    const p=f.principal(f.a,['tasks:write']),x=f.tasks.submit(p,{service:'eigos.delegate',requestId:'write-only',goal:'PRIVATE_INPUT'});
    assert.equal(x.goal,'');assert.deepEqual(x.messages,[]);assert.ok(!JSON.stringify(x).includes('PRIVATE_INPUT'));
    f.publish(x.id);
    const wait=await f.tasks.wait(p,x.id);assert.ok(!wait.artifact);assert.ok(!wait.question);assert.ok(!JSON.stringify(wait).includes('PRIVATE_INPUT'));
    assert.throws(()=>f.tasks.get(p,x.id),/tasks:read/);
    const read=f.principal(f.a);assert.throws(()=>f.tasks.get(read,x.id),/AUTHORIZATION_REQUIRED/,'A later read scope cannot manufacture task result permission');
  }finally{f.close();}
});

test('pinned historical task readback survives an engine upgrade without execution or authority fallback',()=>{
  const f=fixture(),db=new DatabaseSync(f.database);
  try {
    const task=f.tasks.submit(f.pa,{service:'eigos.delegate',requestId:'historical-readback',goal:'Retained scoped report'});
    f.publish(task.id);
    const query={version:2,taskId:task.id,query:{object:{type:'ServiceRequest',id:task.id}}};
    const before=f.tasks.get(f.pa,task.id),beforeQuery=f.tasks.queryOntology(f.pa,query);
    const original=f.jobs.get(f.owner,task.id),pin=structuredClone(original.delegation!.ontologyRelease!);
    const job={...original,delegation:{...original.delegation!,backendVersion:'retired-ontology-backend'}};
    const persist=()=>db.prepare('UPDATE jobs SET body=? WHERE owner=? AND id=?').run(JSON.stringify(job),f.owner,task.id);
    persist();
    assert.deepEqual(f.tasks.get(f.pa,task.id),before);
    assert.deepEqual(f.tasks.queryOntology(f.pa,query),beforeQuery);
    assert.deepEqual(f.jobs.ontologyForTaskRead(f.owner,task.id).releaseRef,pin);
    assert.throws(()=>f.jobs.ontologyForJob(f.owner,task.id),/Historical backend/);
    assert.throws(()=>f.tasks.queryOntology(f.pb,query),/AUTHORIZATION_REQUIRED/);
    job.delegation!.recoveryPending=true;persist();
    assert.equal(f.jobs.claim(['eigos.delegate'],30000),undefined,'Read permission cannot reactivate an old execution or recovery');
    job.delegation!.ontologyRelease={...pin,digest:'0'.repeat(64)};persist();
    assert.throws(()=>f.tasks.get(f.pa,task.id),/ontology release|Ontology release/);
    delete job.delegation!.ontologyRelease;persist();
    assert.throws(()=>f.tasks.queryOntology(f.pa,query),/Historical backend/);
    job.delegation!.ontologyRelease=pin;persist();
    const grant=f.jobs.security.taskGrant(f.pa.access as Extract<NonNullable<typeof f.pa.access>,{actorKind:'agent'}>,task.id);
    f.jobs.security.revokeGrant(f.owner,grant.id,grant.revision);
    assert.throws(()=>f.tasks.get(f.pa,task.id),/AUTHORIZATION_REQUIRED/);
    assert.throws(()=>f.tasks.queryOntology(f.pa,query),/AUTHORIZATION_REQUIRED/);
    assert.equal(f.jobs.get(f.owner,task.id).delegation!.backendVersion,'retired-ontology-backend');
  }finally{db.close();f.close();}
});

test('controlled file bytes, metadata and old links recheck labels and revocation',()=>{
  const f=fixture();try {
    const x=f.tasks.submit(f.pa,{service:'eigos.delegate',requestId:'file',goal:'Private report'}),work=f.claim(x.id);
    const artifact=withAuthorization(work.scope,()=>{
      secureRequest(f.jobs.ontology,f.owner,work.claim.job.delegation!.request);
      return f.policy.createArtifact(f.owner,x.id,{name:'report.txt',mediaType:'text/plain',content:Buffer.from('Authorized file')});
    });
    assert.equal(f.tasks.downloadArtifact(f.pa,x.id,artifact.id).content.toString(),'Authorized file');
    assert.throws(()=>f.tasks.downloadArtifact(f.pb,x.id,artifact.id),/AUTHORIZATION_REQUIRED/);
    assert.equal((f.tasks.get(f.pa,x.id) as {attachments?:unknown[]}).attachments?.length,1);
    const root=f.jobs.ontology;
    const revision=f.jobs.security.withAgent(f.pa,x.id,'task.query',()=>root.read(f.owner,{type:'ServiceRequest',id:x.id}).revision);
    f.policy.restrictObject({ownerKey:f.owner,object:{type:'ServiceRequest',id:x.id},expectedObjectRevision:revision,classification:'internal',requiredMarkings:['member_private'],channels:[]},f.policy.revision());
    assert.equal(f.jobs.renew(work.claim,10000),false);
    assert.throws(()=>f.tasks.downloadArtifact(f.pa,x.id,artifact.id),/OUTPUT_NOT_ALLOWED/);
    assert.throws(()=>f.tasks.get(f.pa,x.id),/AUTHORIZATION_REQUIRED/);
    assert.throws(()=>f.policy.restrictObject({ownerKey:f.owner,object:{type:'ServiceRequest',id:x.id},expectedObjectRevision:revision,classification:'private',requiredMarkings:[],channels:['agent_response']},f.policy.revision()-1),/POLICY_CHANGED/);
  }finally{f.close();}
});

test('model channel is independent of task permission and includes all submitted inputs',async()=>{
  const f=fixture();try {
    assert.throws(()=>assertModelChannel(f.jobs.ontology,'synthetic'),/OUTPUT_NOT_ALLOWED/);
    const x=f.tasks.submit(f.pa,{service:'eigos.delegate',requestId:'model',goal:'PRIVATE_MODEL_INPUT'}),work=f.claim(x.id);
    const session=new OntologyPlanningSession(f.jobs.ontology,f.owner,work.claim.job.delegation!.request);
    let calls=0;
    const model={securityChannelId:'synthetic',runStructured:async()=>{calls++;throw new Error('Should not be called');}};
    await assert.rejects(withAuthorization(work.scope,()=>reasonWithOntology(model,'Instructions',{},session,new AbortController().signal,()=>{},1)),/OUTPUT_NOT_ALLOWED/);
    assert.equal(calls,0);
    f.policy.setModelChannel('synthetic',{classification:'private',markings:['member_private'],expiresAt:f.until},f.policy.revision());
    const current=f.jobs.security.workerScope(f.owner,x.id,work.claim.securityAuthorityId!,work.claim.token);
    await assert.rejects(withAuthorization(current,()=>reasonWithOntology(model,'Instructions',{},session,new AbortController().signal,()=>{},1)),/OUTPUT_NOT_ALLOWED/);
    assert.equal(calls,0);
    f.policy.setModelChannel('synthetic',{classification:'sensitive',markings:['member_private','personal_data'],expiresAt:f.until},f.policy.revision());
    const allowed=f.jobs.security.workerScope(f.owner,x.id,work.claim.securityAuthorityId!,work.claim.token);
    const key=withAuthorization(allowed,()=>session.modelSessionKey());
    withAuthorization(allowed,()=>session.authorizeModel('synthetic'));
    f.policy.setModelChannel('synthetic',{classification:'private',markings:['member_private'],expiresAt:f.until},f.policy.revision());
    assert.throws(()=>withAuthorization(allowed,()=>session.authorizeModel('synthetic')),/POLICY_CHANGED/);
    const changed=f.jobs.security.workerScope(f.owner,x.id,work.claim.securityAuthorityId!,work.claim.token);
    assert.notEqual(key,withAuthorization(changed,()=>session.modelSessionKey()));
  }finally{f.close();}
});

test('envelope joins tighten labels/channels and reject incomplete or cross-owner data',()=>{
  const a={version:SECURITY_CONTRACT,ownerKey:'["issuer","tenant","alice"]',requiredMarkings:['member_private'] as const,classification:'private' as const,channels:['agent_response','registered_model'] as const,policyVersion:POLICY_VERSION,lineage:[],lineageComplete:true};
  const first={...a,requiredMarkings:[...a.requiredMarkings],channels:[...a.channels]};
  const second={...first,requiredMarkings:['member_private','health'] as ('member_private'|'health')[],classification:'sensitive' as const,channels:['registered_model'] as const};
  const joined=combineEnvelopes([first,{...second,channels:[...second.channels]}]);
  assert.equal(joined.classification,'sensitive');assert.deepEqual(joined.channels,['registered_model']);assert.ok(joined.requiredMarkings.includes('health'));
  assert.throws(()=>requireChannel(joined,'registered_model',{classification:'sensitive',markings:['member_private']}),/OUTPUT_NOT_ALLOWED/);
  assert.throws(()=>requireChannel({...joined,lineageComplete:false},'registered_model',{classification:'sensitive',markings:['member_private','health']}),/OUTPUT_NOT_ALLOWED/);
  assert.throws(()=>combineEnvelopes([first,{...first,ownerKey:'["issuer","tenant","bob"]'}]),/OUTPUT_NOT_ALLOWED/);
});

test('persisted model lineage re-evaluates upgraded labels before a later model invocation',()=>{
  const f=fixture();try {
    f.policy.setModelChannel('synthetic',{classification:'sensitive',markings:['member_private','personal_data'],expiresAt:f.until},f.policy.revision());
    const x=f.tasks.submit(f.pa,{service:'eigos.delegate',requestId:'model-label-upgrade',goal:'Private task'}),work=f.claim(x.id);
    const revision=withAuthorization(work.scope,()=>{secureRequest(f.jobs.ontology,f.owner,work.claim.job.delegation!.request);assertModelChannel(f.jobs.ontology,'synthetic');return f.jobs.ontology.read(f.owner,{type:'ServiceRequest',id:x.id}).revision;});
    f.jobs.release(work.claim);
    // The installation can receive health data; the model channel cannot.
    f.policy.restrictObject({ownerKey:f.owner,object:{type:'ServiceRequest',id:x.id},expectedObjectRevision:revision,field:'originalGoal',classification:'sensitive',requiredMarkings:['health'],channels:['agent_response','registered_model','controlled_download']},f.policy.revision());
    const next=f.claim(x.id);assert.ok(next.scope.lineage.size>0);
    assert.throws(()=>withAuthorization(next.scope,()=>assertModelChannel(f.jobs.ontology,'synthetic')),/OUTPUT_NOT_ALLOWED/);
    f.jobs.release(next.claim);
  }finally{f.close();}
});

test('missing policy authority and labels never reset to permissive defaults on reopen',()=>{
  const f=fixture();try{
    const x=f.tasks.submit(f.pa,{service:'eigos.delegate',requestId:'missing-policy',goal:'Private task'}),work=f.claim(x.id);
    const db=new DatabaseSync(f.database);db.exec('DELETE FROM security_policy');db.close();
    assert.equal(f.jobs.security.workAuthority(f.owner,x.id),undefined);assert.equal(f.jobs.renew(work.claim,10000),false);
    assert.throws(()=>f.tasks.get(f.pa,x.id),/AUTHORITY_UNAVAILABLE/);
    assert.throws(()=>new JobStore(f.database,{securityMode:'foundation'}),/policy authority is missing/);
  }finally{f.close();}
  const g=fixture();try{
    const db=new DatabaseSync(g.database);db.exec('DROP TABLE security_labels');db.close();
    assert.throws(()=>new JobStore(g.database,{securityMode:'foundation'}),/policy table is missing/);
  }finally{g.close();}
});
