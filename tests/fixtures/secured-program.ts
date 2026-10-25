import {taskContextFields} from '../../packages/security/task-context-contract.js';
import assert from 'node:assert/strict';
import {securityFixture} from './security.js';
import {ExecutionCatalog} from '../../packages/core/catalog.js';
import {TaskService} from '../../packages/core/tasks.js';
import {Coordinator,type Reasoner,type AgentPlanningContext,type PlanningAccess} from '../../packages/coordinator/coordinator.js';
import type {AgentProgram} from '../../packages/core/agent-program.js';
import type {AgentDecision} from '../../packages/ontology/agent-actions.js';
import {bindPersonalSourceOwner} from '../../packages/core/source-owner.js';
import {withAuthorization} from '../../packages/security/context.js';
import {digest} from '../../packages/core/delegation.js';
import {evidence,interpretation,syntheticGoalReview,observeTaskContext,acknowledgeReads} from '../backend-fixture.js';

export function securedProgramFixture(factory:(f:ReturnType<typeof securityFixture>)=>AgentProgram,input:object,choice:(ctx:AgentPlanningContext,access:PlanningAccess)=>AgentDecision,base?:ReturnType<typeof securityFixture>,options:{nativeTaskContext?:boolean}={}) {
  const f=base??securityFixture(),program=factory(f);bindPersonalSourceOwner(program,f.owner);
  const businessModel=f.jobs.security.model,BUSINESS_MODEL_DEFINITION=businessModel.definitionSnapshot();
  const catalog=new ExecutionCatalog([program.capability()],[],[],[],[program],undefined,f.jobs.security),profile=catalog.securityProfiles(f.owner)[0]!,policy=f.jobs.security.policies,until=new Date(Date.now()+3600000).toISOString(),a=f.installation('Scoped native program',15*60*1000);
  const resources=[...new Set(['ServiceRequest',...profile.outputTypes])].map(type=>({type,fields:Object.keys(policy.fields(type)).filter(field=>policy.fieldPolicy(type,field)!=='internal_only')}));
  if(options.nativeTaskContext) for(const [type,allowed] of Object.entries(taskContextFields)) {
    const fields=allowed.filter(field=>Object.hasOwn(policy.fields(type),field) && policy.fieldPolicy(type,field)!=='internal_only');
    if(!fields.length)continue;const existing=resources.find(resource=>resource.type===type);
    if(existing)existing.fields=[...new Set([...existing.fields,...fields])];else resources.push({type,fields});
  }
  f.coordinator.approveAgentGrant(f.member.id,{installationId:a.id,capabilityIds:[program.ref.id],resources,sourceBindingIds:[profile.bindingId],channels:['agent_response','registered_model','controlled_download'],expiresAt:until});
  policy.setRole({subjectKind:'installation',subjectId:a.id,resource:{kind:'namespace',id:businessModel.ref.id,version:businessModel.ref.digest},role:'Viewer',executeActions:program.actionIds,invokeFunctions:BUSINESS_MODEL_DEFINITION.functions.map(fn=>fn.id),expiresAt:until},policy.revision());
  const markings=['member_private','personal_data','precise_location','financial','account_private','health'];
  policy.setRecipient(a.id,{classification:'sensitive',markings,channels:['agent_response','registered_model','controlled_download'],expiresAt:until},policy.revision());
  policy.setModelChannel('s5-synthetic',{classification:'sensitive',markings,expiresAt:until},policy.revision());
  policy.setSource(f.owner,{installationId:a.id,bindingId:profile.bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:program.actionIds,outputTypes:profile.outputTypes,expiresAt:until},policy.revision());
  const p={...f.principal,access:f.coordinator.authenticate(f.principal,a.token)},tasks=new TaskService(f.jobs,{catalog,allowSandboxActions:true}),modelInputs:string[]=[];
  const reasoner:Reasoner={ontologyContextMode:options.nativeTaskContext?'task':'primitives',securityChannelId:'s5-synthetic',reviewGoal:async ctx=>{modelInputs.push(JSON.stringify(ctx));return syntheticGoalReview(ctx);},ground:async(request,_caps,_signal,access)=>{
    if(options.nativeTaskContext)request=observeTaskContext(access)??request;
    else {access.session.call('describe_ontology',{search:'ServiceRequest',limit:1});access.session.call('query_ontology',{object:{type:'ServiceRequest',id:request.id}});}
    acknowledgeReads(access);
    return {decision:{...interpretation(request,program.ref.id,input),capabilityRef:program.ref},evidence:evidence()};
  },plan:async()=>{throw new Error('Native program must not enter legacy planning');},act:async(ctx,_signal,access)=>{
    modelInputs.push(JSON.stringify(ctx));const call=access.session.call.bind(access.session);
    access.session.call=(...args)=>{const result=call(...args);modelInputs.push(JSON.stringify(result));return result;};
    if(options.nativeTaskContext)observeTaskContext(access);
    const decision=choice(ctx,access);acknowledgeReads(access);return {decision,evidence:{...evidence(),decisionDigest:digest(decision)}};
  }};
  const coordinator=new Coordinator(f.jobs,reasoner,catalog,{allowSandbox:true});
  async function tick() {
    const claim=f.jobs.claim(['eigos.delegate'],30000);assert.ok(claim);
    try {await withAuthorization(f.jobs.security.workerScope(f.owner,claim.job.id,claim.securityAuthorityId!,claim.token),()=>coordinator.run(claim,new AbortController().signal));}
    finally{f.jobs.release(claim);await coordinator.releaseModelContext(claim);}
  }
  async function advance(id:string,max=12) {
    for(let turn=0;turn<max;turn++) {
      const current=f.jobs.get(f.owner,id);if(!['working','submitted'].includes(current.state))return current;
      const claim=f.jobs.claim(['eigos.delegate'],30000);assert.ok(claim);
      try {await withAuthorization(f.jobs.security.workerScope(f.owner,id,claim.securityAuthorityId!,claim.token),()=>coordinator.run(claim,new AbortController().signal));}
      finally{f.jobs.release(claim);await coordinator.releaseModelContext(claim);}
    }
    assert.fail('Native program exceeded its bounded decision count');
  }
  return {...f,a,p,tasks,program,policy,catalog,modelInputs,reasoner,advance,tick};
}
