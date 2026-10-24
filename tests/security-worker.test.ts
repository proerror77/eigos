import test from 'node:test';
import assert from 'node:assert/strict';
import {securityFixture} from './fixtures/security.js';
import {didiFixture,input as rideInput} from './fixtures/didi.js';
import {DidiAgentProgram} from '../packages/capabilities/didi/program.js';
import {businessModel,BUSINESS_MODEL_DEFINITION} from '../packages/ontology/business-model.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {TaskService} from '../packages/core/tasks.js';
import {Coordinator,type Reasoner} from '../packages/coordinator/coordinator.js';
import {Worker} from '../apps/worker/worker.js';
import {digest} from '../packages/core/delegation.js';
import {evidence,interpretation} from './backend-fixture.js';
import type {AgentDecision,AgentStep} from '../packages/ontology/agent-actions.js';
import type {ObjectRef} from '../packages/ontology/model.js';
import type {DidiData} from '../packages/capabilities/didi/contracts.js';

test('foundation Worker completes the existing source-selected read loop using safe facts and sealed delivery',async()=>{
  const f=securityFixture(),source=didiFixture();
  // Only this isolated synthetic connector is made available to the synthetic
  // member. Production personal-account permitted(owner) stays unchanged.
  class MemberFixtureProgram extends DidiAgentProgram {override permitted(owner:string){return owner===f.owner;}}
  const program=new MemberFixtureProgram(source.binding,{connector:source.connector}),catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]);
  const policy=f.jobs.security.policies,profile=catalog.securityProfiles(f.owner)[0]!,until=new Date(Date.now()+3600000).toISOString(),install=f.installation('Scoped source');
  const resources=['ServiceRequest',...profile.outputTypes].map(type=>({type,fields:Object.keys(policy.fields(type)).filter(field=>policy.fieldPolicy(type,field)!=='internal_only')}));
  f.coordinator.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:[program.ref.id],resources,sourceBindingIds:[profile.bindingId],channels:['agent_response','registered_model'],expiresAt:until});
  policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:businessModel.ref.id,version:businessModel.ref.digest},role:'Viewer',executeActions:program.actionIds,invokeFunctions:BUSINESS_MODEL_DEFINITION.functions.map(fn=>fn.id),expiresAt:until},policy.revision());
  const markings=['member_private','personal_data','precise_location','financial','health'];
  policy.setRecipient(install.id,{classification:'sensitive',markings,channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
  policy.setModelChannel('synthetic-didi',{classification:'sensitive',markings,expiresAt:until},policy.revision());
  policy.setSource(f.owner,{installationId:install.id,bindingId:profile.bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:program.actionIds,outputTypes:profile.outputTypes,expiresAt:until},policy.revision());
  const p={...f.principal,access:f.coordinator.authenticate(f.principal,install.token)},tasks=new TaskService(f.jobs,{catalog});
  const modelInputs:string[]=[];let closed=0;
  const reasoner:Reasoner={securityChannelId:'synthetic-didi',closeTask:async()=>{closed++;},ground:async(request,capabilities,_signal,access)=>{
    modelInputs.push(JSON.stringify({request,capabilities}));
    access.session.call('describe_ontology',{search:'ServiceRequest'});access.session.call('query_ontology',{object:{type:'ServiceRequest',id:request.id}});
    return {decision:{...interpretation(request,program.ref.id,rideInput),capabilityRef:program.ref},evidence:evidence()};
  },plan:async()=>{throw new Error('Agent program must keep model-selected actions');},act:async(ctx,_signal,access)=>{
    modelInputs.push(JSON.stringify(ctx));
    access.session.call('describe_ontology',{search:'RideEstimate',limit:5});
    access.session.call('query_ontology',{object:{type:'ServiceRequest',id:ctx.request.id}});
    access.session.call('query_ontology',{object:ctx.state.scope});
    const observations=ctx.state.observations.map(ref=>{
      const result=access.session.call('query_ontology',{object:ref}) as {items:{properties:{observedData:{data:DidiData}}}[]};
      modelInputs.push(JSON.stringify(result));
      assert.ok(!JSON.stringify(result).includes('"configurationDigest":'));assert.ok(!JSON.stringify(result).includes('"snapshot":'));
      const status=access.session.call('evaluate_ontology',{function:'rideEstimateStatus',object:ref}) as {status:string;reason?:string};
      assert.equal(status.status,'known',status.reason);
      return {ref,data:result.items[0]!.properties.observedData.data};
    });
    const step=(id:string,action:string,args:object):AgentStep=>({id,action,argumentsJson:JSON.stringify(args),dependsOn:[],inputRefs:[]});
    let steps:AgentStep[]=[],complete:ObjectRef|undefined;
    if(!observations.length) steps=[step('origin','SearchDidiPlaces',{scope:ctx.state.scope,role:'origin',keywords:rideInput.origin}),step('destination','SearchDidiPlaces',{scope:ctx.state.scope,role:'destination',keywords:rideInput.destination})];
    else {
      complete=observations.find(o=>o.data.kind==='estimate')?.ref;
      if(!complete) {
        const endpoint=(name:string)=>{const o=observations.find(o=>o.data.kind==='places' && o.data.places.some(p=>p.name===name))!;assert(o.data.kind==='places');return {ref:o.ref,place:o.data.places.find(p=>p.name===name)!};};
        const origin=endpoint(rideInput.origin),destination=endpoint(rideInput.destination);
        steps=[step('estimate','EstimateDidiRide',{scope:ctx.state.scope,originObservation:origin.ref,originPlaceId:origin.place.id,destinationObservation:destination.ref,destinationPlaceId:destination.place.id})];
      }
    }
    const decision:AgentDecision={kind:complete?'complete':'execute',requestRevision:ctx.request.revision,message:'Synthetic selection from authorized facts',steps,completionJson:complete?JSON.stringify({observation:complete,rationale:'The original requested route has a current synthetic estimate'}):''};
    return {decision,evidence:{...evidence(),decisionDigest:digest(decision)}};
  }};
  const failures:string[]=[];
  class CheckedCoordinator extends Coordinator {override async run(claim:import('../packages/core/store.js').WorkClaim,signal:AbortSignal){try{return await super.run(claim,signal);}catch(error){failures.push(error instanceof Error?error.stack??error.message:String(error));throw error;}}}
  const worker=new Worker(f.jobs,{coordinator:new CheckedCoordinator(f.jobs,reasoner,catalog),pollMs:10,leaseMs:10000});
  try {
    const job=tasks.submit(p,{service:'eigos.delegate',requestId:'scoped-didi',goal:'查询北京西站到西二旗地铁站的预估车费，不叫车、不付款'});
    const rootRevision=f.jobs.security.withAgent(p,job.id,'task.query',()=>f.jobs.ontology.read(f.owner,{type:'ServiceRequest',id:job.id}).revision);
    policy.restrictObject({ownerKey:f.owner,object:{type:'ServiceRequest',id:job.id},expectedObjectRevision:rootRevision,field:'originalGoal',classification:'sensitive',requiredMarkings:['health'],channels:['agent_response','registered_model']},policy.revision());
    worker.start();
    const deadline=Date.now()+30000;
    while(['submitted','working'].includes(f.jobs.get(f.owner,job.id).state) && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
    const raw=f.jobs.get(f.owner,job.id);
    assert.equal(raw.state,'completed',JSON.stringify({state:raw.state,error:raw.error,failures,feedback:raw.delegation?.agent?.feedback,reads:raw.delegation?.ontologyReads?.filter(r=>r.status==='rejected'),intents:f.jobs.intents(f.owner,job.id).map(i=>({state:i.state,result:i.lastResult?.message}))}));
    const result=tasks.get(p,job.id);
    assert.ok(result.artifact?.data.deliverable.includes('73.05'));assert.ok(!result.artifact?.data.result);
    assert.deepEqual(source.calls.filter(c=>c.name).map(c=>c.name),['maps_textsearch','maps_textsearch','taxi_estimate']);
    const text=modelInputs.join('\n');assert.ok(!text.includes('PRIVATE_TRACE_NEVER_TO_MODEL'));assert.ok(!text.includes(source.keyFile));assert.ok(!text.includes('"snapshot":'));assert.ok(closed>0);
    const observation=raw.delegation!.agent!.observations.at(-1)!;
    policy.setRecipient(install.id,{classification:'sensitive',markings:markings.filter(m=>m!=='health'),channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
    assert.throws(()=>tasks.queryOntology(p,{version:2,taskId:job.id,query:{object:observation}}),/not available/,'Action output objects retain restrictions inherited from actual input reads');
    const hidden=tasks.queryOntology(p,{version:2,taskId:job.id,query:{type:observation.type,where:[{property:'displayTitle',op:'eq',value:'滴滴车型估价'}]}});assert.deepEqual(hidden.items,[]);assert.equal(hidden.page.hasMore,false);
    policy.setRecipient(install.id,{classification:'sensitive',markings,channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
    const sourceGrant={installationId:install.id,bindingId:profile.bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:program.actionIds,outputTypes:profile.outputTypes,expiresAt:until};
    policy.setSource(f.owner,{...sourceGrant,outputTypes:profile.outputTypes.filter(type=>type!==observation.type)},policy.revision());
    assert.equal(tasks.get(p,job.id).artifact,undefined,'Narrowed source output types block an old deliverable');
    policy.setSource(f.owner,{...sourceGrant,programDigest:'0'.repeat(64)},policy.revision());
    assert.equal(tasks.get(p,job.id).artifact,undefined,'A different source configuration cannot authorize old observations');
    policy.setSource(f.owner,sourceGrant,policy.revision());
    const revision=f.jobs.security.withAgent(p,job.id,'task.query',()=>f.jobs.ontology.read(f.owner,observation).revision);
    policy.restrictObject({ownerKey:f.owner,object:observation,expectedObjectRevision:revision,field:'snapshot',classification:'internal',requiredMarkings:['account_private'],channels:[]},policy.revision());
    assert.equal(tasks.get(p,job.id).artifact,undefined,'Mandatory controls on raw source dependencies propagate into the safe view and old delivery');
    policy.revokeSource(f.owner,install.id,profile.bindingId,policy.revision());
    assert.throws(()=>tasks.get(p,job.id),/AUTHORIZATION_REQUIRED/);
    const parent=f.jobs.security.agentGrant(install.id);f.jobs.security.revokeGrant(f.owner,parent.id,parent.revision);
    f.coordinator.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:[program.ref.id],resources,sourceBindingIds:[profile.bindingId],channels:['agent_response','registered_model'],expiresAt:until});
    assert.deepEqual(policy.sources(f.owner,install.id),[],'A new installation ceiling never resurrects an old source approval');
  }finally{await worker.close();f.close();source.close();}
});
