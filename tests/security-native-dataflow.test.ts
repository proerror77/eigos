import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {securityFixture} from './fixtures/security.js';
import {didiFixture} from './fixtures/didi.js';
import {securedDidiReasoner,runNativeDidiTask} from './fixtures/secured-didi.js';
import {DidiAgentProgram} from '../packages/capabilities/didi/program.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {TaskService} from '../packages/core/tasks.js';
import {bindPersonalSourceOwner} from '../packages/core/source-owner.js';
import {AuthorizationCoordinator} from '../packages/security/coordinator.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {Coordinator} from '../packages/coordinator/coordinator.js';
import type {AgentDecision} from '../packages/ontology/agent-actions.js';

function fixture(mutate?:(decision:AgentDecision)=>void){
  const f=securityFixture(),source=didiFixture({booking:true}),program=new DidiAgentProgram(source.binding,{connector:source.connector});
  bindPersonalSourceOwner(program,f.owner);
  const catalog=new ExecutionCatalog([program.capability()],[],[],[],[program],undefined,f.jobs.security);
  f.coordinator.close();const manager=new AuthorizationCoordinator(f.jobs.security,f.members,f.jobs,catalog);manager.start();
  const install=f.installation('native dataflow'),policy=f.jobs.security.policies,profile=catalog.securityProfiles(f.owner)[0]!,until=new Date(Date.now()+3600000).toISOString();
  const channels=['agent_response','registered_model'],markings=['member_private','personal_data','precise_location','financial','account_private'];
  const resources=[...new Set(['ServiceRequest',...profile.outputTypes,...Object.keys(taskContextFields)])].map(type=>({type,fields:Object.keys(policy.fields(type)).filter(field=>policy.fieldPolicy(type,field)!=='internal_only')}));
  manager.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:[program.ref.id],resources,sourceBindingIds:[profile.bindingId],channels,expiresAt:until});
  policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',executeActions:program.actionIds,invokeFunctions:policy.model.definitionSnapshot().functions.map(fn=>fn.id),expiresAt:until},policy.revision());
  policy.setRecipient(install.id,{classification:'sensitive',markings,channels,expiresAt:until},policy.revision());
  policy.setModelChannel('synthetic-didi',{classification:'sensitive',markings,expiresAt:until},policy.revision());
  policy.setSource(f.owner,{installationId:install.id,bindingId:profile.bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:program.actionIds,outputTypes:profile.outputTypes,expiresAt:until},policy.revision());
  const principal={...f.principal,access:manager.authenticate(f.principal,install.token)},tasks=new TaskService(f.jobs,{catalog});
  const task=tasks.submit(principal,{service:'eigos.delegate',requestId:randomUUID(),goal:'查询北京西站到西二旗地铁站的预估车费，不叫车、不付款',executionEnvironment:'sandbox'});
  const {reasoner}=securedDidiReasoner(program,'native-goal',{dataflow:true,mutate}),coordinator=new Coordinator(f.jobs,reasoner,catalog,{allowSandbox:true});
  return {...f,source,program,policy,profile,install,principal,tasks,task,coordinator,close:()=>{manager.close();f.close();source.close();}};
}

for(const [name,mutate] of [
  ['unregistered scalar derivation',(d:AgentDecision)=>{d.steps[2]!.inputRefs.find(ref=>ref.compute)!.compute!.function='remainingQuantity';}],
  ['different source port',(d:AgentDecision)=>{d.steps[2]!.inputRefs.find(ref=>ref.compute)!.port='identity';}],
  ['missing fixed goal criterion',(d:AgentDecision)=>{d.plannedGoalCompletion!.criteria=[{id:'invented',contextIds:['ride']}];}],
  ['foreign completion context',(d:AgentDecision)=>{d.plannedGoalCompletion!.components[0]!.contextId='other';}],
] as const)test(`native read dataflow rejects ${name} before source dispatch`,{timeout:180000},async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=fixture(mutate);
  try{
    await runNativeDidiTask(f.jobs,f.coordinator,f.owner,f.task.id,t.signal,()=>t.mock.timers.tick(20),job=>!!job.delegation?.agent?.feedback.length);
    const job=f.jobs.get(f.owner,f.task.id);
    assert(job.delegation!.agent!.feedback.some(value=>value.kind==='validation'));
    assert.notEqual(job.state,'completed');assert(!job.delegation!.acceptance?.accepted);
    assert.equal(f.source.calls.filter(call=>call.method==='tools/call').length,0);
  }finally{f.close();}
});

test('native planned completion cannot select a place result as an estimate',{timeout:180000},async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=fixture(decision=>{decision.plannedGoalCompletion!.components[0]!.inputRefs[0]!.stepId='from';});
  try{
    await runNativeDidiTask(f.jobs,f.coordinator,f.owner,f.task.id,t.signal,()=>t.mock.timers.tick(20),job=>!!job.delegation?.agent?.feedback.some(value=>value.kind==='completion'));
    const job=f.jobs.get(f.owner,f.task.id);
    assert(job.delegation!.agent!.feedback.some(value=>value.kind==='completion'));
    assert(!job.delegation!.acceptance?.accepted);assert.notEqual(job.state,'completed');
    assert.equal(job.delegation!.agent!.pendingPlanId,undefined,'Failed conditional verification returns control for a new model decision');
    const calls=f.source.calls.filter(call=>call.method==='tools/call').length;
    await runNativeDidiTask(f.jobs,f.coordinator,f.owner,f.task.id,t.signal,()=>t.mock.timers.tick(20));
    assert.equal(f.jobs.get(f.owner,f.task.id).delegation!.acceptance?.accepted,true,'A subsequent correct decision can finish the same task');
    assert.equal(f.source.calls.filter(call=>call.method==='tools/call').length,calls,'Corrective completion reuses the accepted source facts');
  }finally{f.close();}
});

test('ambiguous native deferred inputs require a new business choice before estimating',{timeout:180000},async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=fixture();f.source.flags.ambiguous=true;
  try{
    await runNativeDidiTask(f.jobs,f.coordinator,f.owner,f.task.id,t.signal,()=>t.mock.timers.tick(20));
    const job=f.jobs.get(f.owner,f.task.id);assert.equal(job.state,'input-required',JSON.stringify(job.delegation!.agent!.feedback));
    assert.equal(f.source.calls.filter(call=>call.name==='maps_textsearch').length,2);
    assert(!f.source.calls.some(call=>call.name==='taxi_estimate'));assert(!job.delegation!.acceptance?.accepted);
  }finally{f.close();}
});

test('cancellation during native source reads blocks deferred estimate and goal acceptance',{timeout:180000},async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=fixture();
  f.source.flags.before=async()=>{f.tasks.cancel(f.principal,f.task.id);};
  try{
    await runNativeDidiTask(f.jobs,f.coordinator,f.owner,f.task.id,t.signal,()=>t.mock.timers.tick(20));
    const job=f.jobs.get(f.owner,f.task.id);assert.equal(job.state,'canceled');
    assert(!f.source.calls.some(call=>call.name==='taxi_estimate'));assert(!job.delegation!.acceptance?.accepted);
  }finally{f.close();}
});

test('source revocation during native reads cannot authorize a deferred estimate or accept late evidence',{timeout:180000},async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=fixture();let revoked=false;
  f.source.flags.before=async()=>{if(!revoked){revoked=true;f.policy.revokeSource(f.owner,f.install.id,f.profile.bindingId,f.policy.revision());}};
  try{
    await runNativeDidiTask(f.jobs,f.coordinator,f.owner,f.task.id,t.signal,()=>t.mock.timers.tick(20),()=>revoked);
    const job=f.jobs.get(f.owner,f.task.id);
    assert(revoked);assert.notEqual(job.state,'completed');assert(!job.delegation!.acceptance?.accepted);
    assert(!f.source.calls.some(call=>call.name==='taxi_estimate'));
  }finally{f.close();}
});
