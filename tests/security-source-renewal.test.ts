import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {securityFixture} from './fixtures/security.js';
import {didiFixture} from './fixtures/didi.js';
import {securedDidiReasoner,runNativeDidiTask} from './fixtures/secured-didi.js';
import {DidiAgentProgram} from '../packages/capabilities/didi/program.js';
import {bindPersonalSourceOwner} from '../packages/core/source-owner.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {TaskService} from '../packages/core/tasks.js';
import {TaskSecurity} from '../packages/security/task-service.js';
import {Coordinator} from '../packages/coordinator/coordinator.js';
import {AuthorizationCoordinator} from '../packages/security/coordinator.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {scheduleTaskRecovery} from '../packages/core/task-recovery.js';
import {preparePermissionReview,permissionReviewPage} from '../apps/gateway/members/permissions-page.js';

function fixture(legacyFields=false) {
  const f=securityFixture(),source=didiFixture(),policy=f.jobs.security.policies;
  const oldProgram=new DidiAgentProgram(source.binding,{connector:source.connector});
  const program=new DidiAgentProgram(source.binding,{connector:{evidenceKind:source.connector.evidenceKind,
    transportDigest:'f'.repeat(64),invoke:source.connector.invoke.bind(source.connector)}});
  bindPersonalSourceOwner(program,f.owner);
  const catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]);
  f.coordinator.close();
  const manager=new AuthorizationCoordinator(f.jobs.security,f.members,f.jobs,catalog);manager.start();
  const profile=catalog.securityProfiles(f.owner)[0]!,until=new Date(Date.now()+3600000).toISOString(),install=f.installation('Original Monk');
  const resources=[...new Set(['ServiceRequest',...profile.outputTypes,...Object.keys(taskContextFields)])]
    .map(type=>({type,fields:Object.keys(policy.fields(type)).filter(field=>policy.fieldPolicy(type,field)!=='internal_only')}));
  const ceiling=(partial=false)=>({installationId:install.id,capabilityIds:[program.ref.id],resources:partial?resources.filter(r=>!['Place','RideEstimate'].includes(r.type)):resources,
    sourceBindingIds:[profile.bindingId],channels:['agent_response','registered_model'],expiresAt:until});
  let parent=manager.approveAgentGrant(f.member.id,ceiling(legacyFields));
  policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},
    role:'Viewer',executeActions:program.actionIds,invokeFunctions:policy.model.definitionSnapshot().functions.map(fn=>fn.id),expiresAt:until},policy.revision());
  const markings=['member_private','personal_data','precise_location','financial','health','account_private'];
  policy.setRecipient(install.id,{classification:'sensitive',markings,channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
  policy.setModelChannel('synthetic-didi',{classification:'sensitive',markings,expiresAt:until},policy.revision());
  policy.setSource(f.owner,{installationId:install.id,bindingId:profile.bindingId,programId:profile.programId,programDigest:oldProgram.configurationDigest,
    operations:program.actionIds,outputTypes:profile.outputTypes.filter(type=>!legacyFields||!['Place','RideEstimate'].includes(type)),expiresAt:until},policy.revision());
  let principal={...f.principal,access:manager.authenticate(f.principal,install.token)};
  const tasks=new TaskService(f.jobs,{catalog}),task=tasks.submit(principal,{service:'eigos.delegate',requestId:randomUUID(),goal:'查询北京西站到西二旗地铁站的预估车费，不叫车、不付款'});
  const originalGrant=f.jobs.security.taskGrant(f.jobs.security.agentContext(principal),task.id),originalAuthority=f.jobs.security.workAuthority(f.owner,task.id)!;
  function pause() {
    const job=f.jobs.get(f.owner,task.id);scheduleTaskRecovery(job,'source_authorization_required','Synthetic source mismatch',{automatic:false});f.jobs.save(f.owner,job);
  }
  function approveCurrentSource(replaceCeiling=false) {
    if(replaceCeiling){f.jobs.security.revokeGrant(f.owner,parent.id,parent.revision);parent=manager.approveAgentGrant(f.member.id,ceiling());}
    manager.approveSource(f.member.id,{installationId:install.id,bindingId:profile.bindingId,programId:profile.programId,operations:program.actionIds,
      outputTypes:profile.outputTypes,expiresAt:until,expectedRevision:policy.revision(),expectedAgentGrant:{id:parent.id,revision:parent.revision}});
    principal={...f.principal,access:manager.authenticate(f.principal,install.token)};
  }
  function renewal() {
    const current=f.jobs.security.listGrants(f.owner).find(g=>g.id===originalGrant.id)!;
    return {installationId:install.id,taskId:task.id,expectedRequestRevision:1,replaces:{id:current.id,revision:current.revision},
      expectedAgentGrant:{id:parent.id,revision:parent.revision},renewOriginal:true,inputs:originalGrant.inputs,programIds:[program.ref.id],purpose:originalGrant.purpose,
      operations:originalGrant.operations,channels:originalGrant.channels,expiresAt:originalGrant.expiresAt,
      expectedSources:[{programId:profile.programId,programDigest:profile.programDigest,bindingId:profile.bindingId}]};
  }
  return {...f,source,program,manager,catalog,tasks,task,install,profile,originalGrant,originalAuthority,pause,approveCurrentSource,renewal,
    principal:()=>principal,close:()=>{manager.close();f.close();source.close();}};
}

for(const replaceCeiling of [false,true])test(`member-reviewed source renewal keeps the original PA and completes its original task${replaceCeiling?' after an explicit field-ceiling replacement':''}`,{timeout:60000},async t=>{
  const f=fixture(replaceCeiling);try {
    const {reasoner}=securedDidiReasoner(f.program,'direct'),coordinator=new Coordinator(f.jobs,reasoner,f.catalog);
    await runNativeDidiTask(f.jobs,coordinator,f.owner,f.task.id,t.signal,()=>{});
    const paused=f.jobs.get(f.owner,f.task.id);assert.equal(paused.state,'paused');assert.equal(paused.delegation!.recovery!.code,'source_authorization_required');
    const view=new TaskSecurity(f.jobs).get(f.principal(),f.task.id);
    assert.deepEqual(view.recovery,{code:'SOURCE_NOT_AUTHORIZED',message:paused.delegation!.recovery!.message,nextAction:'review_source_authorization',reviewPath:'/members/permissions'});
    assert.equal(f.source.calls.length,0);
    const resume=()=>({taskId:f.task.id,requestId:randomUUID(),expectedRevision:f.jobs.get(f.owner,f.task.id).revision!});
    assert.throws(()=>f.tasks.resume(f.principal(),resume()),/SOURCE_NOT_AUTHORIZED/);
    f.approveCurrentSource(replaceCeiling);
    assert.throws(()=>f.tasks.resume(f.principal(),resume()),/SOURCE_NOT_AUTHORIZED|AUTHORIZATION_REQUIRED/,'Source approval cannot silently replace the old task grant');
    const input=f.renewal(),before=f.jobs.get(f.owner,f.task.id),grant=f.manager.approveTaskGrant(f.member.id,input),renewed=f.jobs.get(f.owner,f.task.id);
    assert.equal(renewed.state,'paused','Only the original PA resumes execution');assert.equal(renewed.contextId,before.contextId);
    assert.deepEqual(renewed.delegation!.request,before.delegation!.request);assert.deepEqual(renewed.messages,before.messages);assert.deepEqual(renewed.runs,before.runs);
    const authority=f.jobs.security.workAuthority(f.owner,f.task.id)!;
    for(const key of ['installationId','memberId','ownerKey','requestRevision','authorityOrigin','submittedScopes','authEpoch','expiresAt'] as const)
      assert.deepEqual(authority[key],f.originalAuthority[key],key);
    assert.notEqual(grant.id,f.originalGrant.id);assert.deepEqual(grant.operations,f.originalGrant.operations);assert.deepEqual(grant.channels,f.originalGrant.channels);
    assert(grant.outputs.every(o=>o.programDigest===f.program.configurationDigest));
    assert(f.jobs.security.listGrants(f.owner).find(g=>g.id===f.originalGrant.id)?.status==='revoked');
    const other=f.installation('Other PA');f.manager.approveAgentGrant(f.member.id,{installationId:other.id,capabilityIds:[f.program.ref.id],
      resources:[{type:'ServiceRequest',fields:['requestId','originalGoal']}],sourceBindingIds:[],channels:['agent_response'],expiresAt:grant.expiresAt});
    const foreign={...f.principal(),access:f.manager.authenticate(f.principal(),other.token)};
    assert.throws(()=>f.tasks.resume(foreign,resume()),/AUTHORIZATION_REQUIRED/);
    f.tasks.resume(f.principal(),resume());
    await runNativeDidiTask(f.jobs,coordinator,f.owner,f.task.id,t.signal,()=>{});
    const completed=new TaskSecurity(f.jobs).get(f.principal(),f.task.id);
    assert.equal(completed.state,'completed',JSON.stringify(f.jobs.get(f.owner,f.task.id).delegation?.recovery));assert.equal(completed.accepted,true);
    assert.deepEqual(f.source.calls.filter(c=>c.name).map(c=>c.name),['maps_textsearch','maps_textsearch','taxi_estimate']);
  }finally{f.close();}
});

test('original-PA renewal rejects changed rights, extended deadlines, stale approvals and individually revoked tasks',()=>{
  const f=fixture();try {
    f.pause();f.approveCurrentSource();
    const input=f.renewal(),count=()=>f.jobs.security.listGrants(f.owner).length;
    for(const change of [{takeover:true},{expectedRequestRevision:2},{operations:['task.process']},{channels:['registered_model']},
      {expiresAt:new Date(Date.parse(input.expiresAt)+1).toISOString()},{expectedSources:[{...input.expectedSources[0]!,programDigest:'0'.repeat(64)}]},
      {replaces:{...input.replaces,revision:99}},{programIds:[f.program.ref.id,f.program.ref.id]}]) {
      const n=count();assert.throws(()=>f.manager.approveTaskGrant(f.member.id,{...input,...change}));assert.equal(count(),n);
      assert.equal(f.jobs.get(f.owner,f.task.id).state,'paused');
    }
    f.jobs.security.revokeGrant(f.owner,f.originalGrant.id,f.originalGrant.revision);
    assert.throws(()=>f.manager.approveTaskGrant(f.member.id,f.renewal()),/unexpired, undispatched/);
    assert.equal(f.source.calls.length,0);
  }finally{f.close();}
});

for(const mode of ['expired','claimed','operation'] as const)test(`original-PA renewal rejects an ${mode} task without issuing authority`,()=>{
  const f=fixture(),db=new DatabaseSync(f.database);try {
    f.pause();f.approveCurrentSource();const input=f.renewal();
    if(mode==='expired') {
      const row=db.prepare('SELECT body FROM security_task_authorities WHERE id=?').get(f.originalAuthority.id)!;
      const body=JSON.parse(String(row.body));body.expiresAt=new Date(Date.now()-1).toISOString();
      db.prepare('UPDATE security_task_authorities SET expires_at=?,body=? WHERE id=?').run(Date.parse(body.expiresAt),JSON.stringify(body),f.originalAuthority.id);
    } else if(mode==='claimed') {
      const job=f.jobs.get(f.owner,f.task.id);job.state='submitted';f.jobs.save(f.owner,job);assert(f.jobs.claim(['eigos.delegate'],30000));
    } else {
      const id=randomUUID();db.prepare('INSERT INTO action_intents VALUES(?,?,?,?,?,?,?)').run(id,f.owner,f.task.id,'synthetic-operation','effect_unknown','{}',JSON.stringify({id,jobId:f.task.id,effect:'purchase',state:'effect_unknown'}));
    }
    const before=f.jobs.security.listGrants(f.owner);
    assert.throws(()=>f.manager.approveTaskGrant(f.member.id,input));assert.deepEqual(f.jobs.security.listGrants(f.owner),before);
    assert.equal(f.source.calls.length,0);
  }finally{db.close();f.close();}
});

test('permission review pins the current source and preserves the original task restrictions',()=>{
  const f=fixture(true);try {
    f.pause();f.approveCurrentSource(true);
    const view=f.manager.managementView(f.member.id),review=preparePermissionReview(view,{kind:'task',installationId:f.install.id,taskId:f.task.id,
      renewOriginal:'yes',programs:[f.program.ref.id],hours:'1'});
    assert.equal(review.input.renewOriginal,true);assert.deepEqual(review.input.operations,f.originalGrant.operations);
    assert.deepEqual(review.input.channels,f.originalGrant.channels);assert.deepEqual(review.input.expectedSources,f.renewal().expectedSources);
    const html=permissionReviewPage(review,view,f.member,'synthetic-csrf','synthetic-review');
    assert(html.includes('由原助手恢复'));assert(html.includes('允许接收的服务结果'));assert(html.includes('地点资料'));
    const grant=f.manager.approveTaskGrant(f.member.id,review.input);assert(grant.outputs.some(o=>o.type==='Place'));
    assert.equal(f.jobs.get(f.owner,f.task.id).state,'paused');assert.equal(f.source.calls.length,0);
  }finally{f.close();}
});
