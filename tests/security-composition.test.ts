// Foundation authorization with synthetic model decisions and source responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {securityFixture} from './fixtures/security.js';
import {didiFixture} from './fixtures/didi.js';
import {meituanPrimitiveFixture} from './fixtures/meituan-agent.js';
import {createExecutionCatalog} from '../packages/capabilities/catalog.js';
import {TaskService} from '../packages/core/tasks.js';
import {Coordinator,type Reasoner,type AgentPlanningContext,type PlanningAccess} from '../packages/coordinator/coordinator.js';
import {currentKernelImplementation} from '../packages/ontology/definition-store.js';
const businessModel=currentKernelImplementation();
const BUSINESS_MODEL_DEFINITION=businessModel.definitionSnapshot();
import {withAuthorization} from '../packages/security/context.js';
import {TASK_PROJECTION_TYPES} from '../packages/security/policy-store.js';
import {digest} from '../packages/core/delegation.js';
import {evidence,interpretation,syntheticGoalReview} from './backend-fixture.js';
import type {CompositionInput} from '../packages/ontology/composition.js';
import type {AgentDecision,AgentStep} from '../packages/ontology/agent-actions.js';
import type {ObjectRef} from '../packages/ontology/model.js';
import {secureAgentContext} from '../packages/security/model.js';

const input:CompositionInput={components:[
  {id:'geo',capabilityRef:{id:'geo.search',version:'1'},goal:'查美团公开地点',input:{city:'北京市',keyword:'天安门'},dependsOn:[],bindings:[],requirementIds:[],conditionIds:[]},
  {id:'didi',capabilityRef:{id:'ride.estimate.query',version:'1'},goal:'用滴滴搜索上一步地点',input:{mode:'places',city:'北京市'},dependsOn:['geo'],bindings:[{from:'geo',targetKey:'keywords',path:['places','0','name']}],requirementIds:[],conditionIds:[]},
]};
function choose(ctx:AgentPlanningContext,access:PlanningAccess):AgentDecision {
  assert.equal(ctx.state.components,undefined,'Raw component state must never reach a model');
  access.session.call('describe_ontology',{actions:['SearchMeituanLocations','SearchDidiPlaces','ActivateServiceComponent','CompleteServiceComponent']});
  access.session.call('query_ontology',{object:{type:'ServiceRequest',id:ctx.request.id}});
  access.session.call('query_ontology',{object:ctx.state.scope});
  const components=ctx.components!;
  for(const c of components) {
    if(c.state.scope)access.session.call('query_ontology',{object:c.state.scope});
    for(const ref of c.state.observations) {
      access.session.call('query_ontology',{object:ref});
      const status=access.session.call('evaluate_ontology',{function:c.id==='geo'?'meituanReadStatus':'rideEstimateStatus',object:ref}) as {status:string;reason?:string};
      assert.equal(status.status,'known',status.reason);
    }
    if(c.state.result)access.session.call('query_ontology',{object:c.state.result.ref});
  }
  const execute=(action:string,args:object):AgentDecision=>{
    const step:AgentStep={id:action,action,argumentsJson:JSON.stringify(args),dependsOn:[],inputRefs:[]};
    return {kind:'execute',requestRevision:ctx.request.revision,message:'Synthetic component choice',steps:[step],completionJson:''};
  };
  for(const c of components) {
    if(!c.state.scope && c.dependsOn.every(id=>components.find(c=>c.id===id)?.state.result))return execute('ActivateServiceComponent',{scope:ctx.state.scope,componentId:c.id});
    if(!c.state.scope)continue;
    if(!c.state.observations.length)return c.id==='geo'?execute('SearchMeituanLocations',{scope:c.state.scope}):execute('SearchDidiPlaces',{scope:c.state.scope,role:'search',keywords:c.state.input!.keywords});
    if(!c.state.result)return execute('CompleteServiceComponent',{scope:ctx.state.scope,componentId:c.id,completionJson:JSON.stringify({observation:c.state.observations[0],rationale:'The source read covers this component'})});
  }
  return {kind:'complete',requestRevision:ctx.request.revision,message:'Both source reads verified',steps:[],completionJson:JSON.stringify({rationale:'Both components satisfy the original goal'})};
}
function fixture(omitSource?:string) {
  const f=securityFixture(),didi=didiFixture(),meituan=meituanPrimitiveFixture();
  const catalog=createExecutionCatalog({personalSourceOwner:f.owner,store:f.jobs,meituan:meituan.reader,didi:{...didi.binding,connector:didi.connector}});
  const ids=['geo.search','ride.estimate.query','services.compose.live'];
  const profiles=catalog.securityProfiles(f.owner).filter(p=>ids.includes(p.programId)),policy=f.jobs.security.policies;
  const installation=f.installation('Composition installation'),until=new Date(Date.now()+3600000).toISOString(),channels=['agent_response','registered_model'];
  const resources=[...new Set(['ServiceRequest',...TASK_PROJECTION_TYPES,...profiles.flatMap(p=>p.outputTypes)])].map(type=>({type,fields:Object.keys(policy.fields(type)).filter(field=>policy.fieldPolicy(type,field)!=='internal_only')}));
  assert(resources.every(r=>r.fields.length), 'Unreviewed resources: '+resources.filter(r=>!r.fields.length).map(r=>r.type).join(','));
  f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:ids,resources,sourceBindingIds:profiles.map(p=>p.bindingId),channels,expiresAt:until});
  policy.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:businessModel.ref.id,version:businessModel.ref.digest},role:'Viewer',executeActions:[...new Set(profiles.flatMap(p=>p.operations))],invokeFunctions:BUSINESS_MODEL_DEFINITION.functions.map(f=>f.id),expiresAt:until},policy.revision());
  const markings=['member_private','personal_data','precise_location','financial','account_private'];
  policy.setRecipient(installation.id,{classification:'sensitive',markings,channels,expiresAt:until},policy.revision());
  policy.setModelChannel('synthetic-composition',{classification:'sensitive',markings,expiresAt:until},policy.revision());
  for(const p of profiles.filter(p=>p.programId!==omitSource))policy.setSource(f.owner,{installationId:installation.id,bindingId:p.bindingId,programId:p.programId,programDigest:p.programDigest,operations:p.operations,outputTypes:p.outputTypes,expiresAt:until},policy.revision());
  const principal={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)},tasks=new TaskService(f.jobs,{catalog}),modelInputs:string[]=[];
  const reasoner:Reasoner={securityChannelId:'synthetic-composition',reviewGoal:async ctx=>{modelInputs.push(JSON.stringify(ctx));return syntheticGoalReview(ctx);},
    ground:async (request,_caps,_signal,access)=>{access.session.call('describe_ontology',{search:'ServiceRequest'});access.session.call('query_ontology',{object:{type:'ServiceRequest',id:request.id}});return {decision:{...interpretation(request,'services.compose.live',input),capabilityRef:{id:'services.compose.live',version:'1'}},evidence:evidence()};},
    plan:async()=>{throw new Error('No legacy route');},act:async(ctx,_signal,access)=>{modelInputs.push(JSON.stringify(ctx));const decision=choose(ctx,access);return {decision,evidence:{...evidence(),decisionDigest:digest(decision)}};}};
  const coordinator=new Coordinator(f.jobs,reasoner,catalog);
  const tick=async()=>{
    const claim=f.jobs.claim(['eigos.delegate'],30000);assert(claim);
    try{await withAuthorization(f.jobs.security.workerScope(f.owner,claim.job.id,claim.securityAuthorityId!,claim.token),()=>coordinator.run(claim,new AbortController().signal));}
    finally{f.jobs.release(claim);await coordinator.releaseModelContext(claim);}
  };
  const submit=()=>tasks.submit(principal,{service:'eigos.delegate',requestId:randomUUID(),goal:'先查美团公开地点，再用滴滴搜索返回的地点，两个来源都要返回，不下单不付款。'});
  return {...f,didi,meituan,catalog,policy,profiles,installation,until,channels,markings,principal,tasks,modelInputs,reasoner,tick,submit,close:()=>{f.close();didi.close();}};
}

test('foundation composition retains typed handoffs, child source provenance and the goal/outcome/feedback readback',async()=>{
  const f=fixture();
  try {
    const job=f.submit();
    for(let i=0;i<12 && ['submitted','working'].includes(f.jobs.get(f.owner,job.id).state);i++)await f.tick();
    const done=f.jobs.get(f.owner,job.id);
    assert.equal(done.state,'completed',JSON.stringify({feedback:done.delegation?.agent?.feedback,recovery:done.delegation?.recovery,events:done.delegation?.events.slice(-4)}));
    assert.equal(f.meituan.calls.length,1);assert.equal(f.didi.calls.filter(c=>c.method==='tools/call').length,1);
    assert.equal(done.delegation!.agent!.components!.didi!.input!.keywords,'合成公开地点');
    const result=f.tasks.get(f.principal,job.id);assert.ok('accepted' in result && result.accepted===true);
    assert.equal((result.artifact!.data.result as {observations:unknown[]}).observations.length,2);
    const query=(ref:ObjectRef)=>f.tasks.queryOntology(f.principal,{version:2,taskId:job.id,query:{object:ref}});
    const closureRefs:ObjectRef[]=[];
    for(const type of ['GoalCoverage','OutcomeAssessment','ExecutionFeedback']) {
      const r=f.tasks.queryOntology(f.principal,{version:2,taskId:job.id,query:{type}});
      assert(r.items.length>0,`${type} must be readable only inside its authorized task`);closureRefs.push(r.items[0]!.ref);
    }
    const noConstraints=f.tasks.queryOntology(f.principal,{version:2,taskId:job.id,query:{type:'RequestConstraint'}});assert.deepEqual(noConstraints.items,[],'A task without constraints must not invent metadata rows');
    const other=f.tasks.submit(f.principal,{service:'eigos.delegate',requestId:randomUUID(),goal:'Another task, without source execution'});
    for(const ref of closureRefs)assert.throws(()=>f.tasks.queryOntology(f.principal,{version:2,taskId:other.id,query:{object:ref}}),/not available/);
    const obs=done.delegation!.agent!.components!.geo!.observations[0]!;
    const text=f.modelInputs.join('\n');assert(!text.includes('"snapshot":'));assert(!text.includes('PRIVATE_TRACE_NEVER_TO_MODEL'));assert(!text.includes('"delivery":'));assert(!text.includes('"proposal":'));
    const revision=f.jobs.security.withAgent(f.principal,job.id,'task.query',()=>f.jobs.ontology.read(f.owner,obs).revision);
    f.policy.restrictObject({ownerKey:f.owner,object:obs,expectedObjectRevision:revision,field:'snapshot',classification:'internal',requiredMarkings:['account_private'],channels:[]},f.policy.revision());
    assert.throws(()=>query(done.delegation!.agent!.components!.geo!.result!.ref),/not available/);
    assert.equal(f.tasks.get(f.principal,job.id).artifact,undefined,'A parent artifact retains the actual child read restrictions');
  }finally{f.close();}
});

test('an orchestration source grant cannot substitute for a missing selected child source',async()=>{
  const f=fixture('ride.estimate.query');
  try {f.submit();await assert.rejects(f.tick(),/SOURCE_NOT_AUTHORIZED|AUTHORIZATION_REQUIRED/);assert.equal(f.meituan.calls.length,0);assert.equal(f.didi.calls.length,0);}finally{f.close();}
});

test('component summaries honor a narrowed result field instead of copying its private execution state',async()=>{
  const f=fixture();
  try {
    const job=f.submit();await f.tick();await f.tick();await f.tick();
    const d=f.jobs.get(f.owner,job.id).delegation!,result=d.agent!.components!.geo!.result!;assert(result.delivery.evidenceRefs.length);
    const revision=f.jobs.security.withAgent(f.principal,job.id,'task.query',()=>f.jobs.ontology.read(f.owner,result.ref).revision);
    f.policy.restrictObject({ownerKey:f.owner,object:result.ref,expectedObjectRevision:revision,field:'evidenceRefs',classification:'internal',requiredMarkings:['account_private'],channels:[]},f.policy.revision());
    const context=f.jobs.security.withAgent(f.principal,job.id,'task.query',()=>{
      const program=f.catalog.agentProgram(d.agent!.programRef,f.owner)!;
      const components=program.describeComponents!({graph:f.jobs.ontology,owner:f.owner,request:d.request,state:d.agent!});
      return secureAgentContext({request:d.request,capability:program.capability(),state:d.agent!,components,actionIds:[...program.actionIds],guidance:program.guidance,completionSchema:program.completionSchema},f.jobs.ontology);
    });
    assert.deepEqual(context.components!.find(c=>c.id==='geo')!.state.result!.evidenceRefs,[]);
    assert.equal(context.state.components,undefined);
  }finally{f.close();}
});

test('goal review rechecks current model authority before accepting its response',async()=>{
  const f=fixture();let reviewed=false;
  f.reasoner.reviewGoal=async ctx=>{
    reviewed=true;
    f.policy.setModelChannel('synthetic-composition',{classification:'private',markings:[],expiresAt:f.until},f.policy.revision());
    return syntheticGoalReview(ctx);
  };
  try {
    const job=f.submit();await assert.rejects(f.tick(),/POLICY_CHANGED|OUTPUT_NOT_ALLOWED|claim is no longer active/);
    assert(reviewed);assert.equal(f.jobs.get(f.owner,job.id).delegation!.goalCoverage,undefined);
    assert.equal(f.meituan.calls.length,0);assert.equal(f.didi.calls.length,0);
  }finally{f.close();}
});
