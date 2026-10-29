import test from 'node:test';
import assert from 'node:assert/strict';
import {securityFixture} from './fixtures/security.js';
import {didiFixture,input as rideInput} from './fixtures/didi.js';
import {DidiAgentProgram} from '../packages/capabilities/didi/program.js';
import {currentKernelImplementation} from '../packages/ontology/definition-store.js';
const businessModel=currentKernelImplementation();
const BUSINESS_MODEL_DEFINITION=businessModel.definitionSnapshot();
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {TaskService} from '../packages/core/tasks.js';
import {Coordinator,type Reasoner} from '../packages/coordinator/coordinator.js';
import {Worker} from '../apps/worker/worker.js';
import {digest} from '../packages/core/delegation.js';
import {evidence,interpretation,syntheticGoalReview,observeTaskContext,acknowledgeReads} from './backend-fixture.js';
import type {AgentDecision,AgentStep} from '../packages/ontology/agent-actions.js';
import type {ObjectRef} from '../packages/ontology/model.js';
import type {DidiData} from '../packages/capabilities/didi/contracts.js';
import {bindPersonalSourceOwner} from '../packages/core/source-owner.js';
import {DatabaseSync} from 'node:sqlite';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import type {ActionDiscoveryPage} from '../packages/core/action-bindings.js';

for(const mode of ['direct','native-goal'] as const)test(`foundation Worker ${mode} completes the source-selected read loop using safe facts and sealed delivery`,async()=>{
  const f=securityFixture(),source=didiFixture({booking:mode==='native-goal'});
  // Only this isolated synthetic connector is made available to the synthetic
  // member. Production personal-account permitted(owner) stays unchanged.
  const program=new DidiAgentProgram(source.binding,{connector:source.connector});bindPersonalSourceOwner(program,f.owner);
  const catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]);
  const policy=f.jobs.security.policies,profile=catalog.securityProfiles(f.owner)[0]!,until=new Date(Date.now()+3600000).toISOString(),install=f.installation('Scoped source');
  const resources=[...new Set(['ServiceRequest',...profile.outputTypes,...(mode==='native-goal'?Object.keys(taskContextFields):[])])].map(type=>({type,fields:Object.keys(policy.fields(type)).filter(field=>policy.fieldPolicy(type,field)!=='internal_only')}));
  f.coordinator.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:[program.ref.id],resources,sourceBindingIds:[profile.bindingId],channels:['agent_response','registered_model'],expiresAt:until});
  policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:businessModel.ref.id,version:businessModel.ref.digest},role:'Viewer',executeActions:program.actionIds,invokeFunctions:BUSINESS_MODEL_DEFINITION.functions.map(fn=>fn.id),expiresAt:until},policy.revision());
  const markings=['member_private','personal_data','precise_location','financial','health','account_private'];
  policy.setRecipient(install.id,{classification:'sensitive',markings,channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
  policy.setModelChannel('synthetic-didi',{classification:'sensitive',markings,expiresAt:until},policy.revision());
  policy.setSource(f.owner,{installationId:install.id,bindingId:profile.bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:program.actionIds,outputTypes:profile.outputTypes,expiresAt:until},policy.revision());
  const p={...f.principal,access:f.coordinator.authenticate(f.principal,install.token)},tasks=new TaskService(f.jobs,{catalog,allowSandboxActions:mode==='native-goal'});
  const modelInputs:string[]=[];let closed=0;
  const reasoner:Reasoner={ontologyContextMode:mode==='native-goal'?'task':'primitives',securityChannelId:'synthetic-didi',reviewGoal:syntheticGoalReview,closeTask:async()=>{closed++;},ground:async(request,capabilities,_signal,access)=>{
    modelInputs.push(JSON.stringify({request,capabilities}));
    if(mode==='native-goal') {
      observeTaskContext(access);
      const decision={kind:'compose' as const,requestRevision:request.revision,message:'Preserve the original read-only estimate goal',requirementsJson:'[]',conditionsJson:'[]',criteriaJson:JSON.stringify([{id:'estimate',description:'Source-backed estimate',predicate:'ride.estimate_observed',phase:'quote',messageId:request.messages[0]!.id,quote:request.originalGoal,requirementIds:[]}])};
      acknowledgeReads(access);return {decision,evidence:{...evidence(),decisionDigest:digest(decision)}};
    }
    access.session.call('describe_ontology',{search:'ServiceRequest'});access.session.call('query_ontology',{object:{type:'ServiceRequest',id:request.id}});
    return {decision:{...interpretation(request,program.ref.id,rideInput),capabilityRef:program.ref},evidence:evidence()};
  },plan:async()=>{throw new Error('Agent program must keep model-selected actions');},act:async(ctx,_signal,access)=>{
    modelInputs.push(JSON.stringify(ctx));
    const root=ctx;
    const pin=(actionId:string)=>(access.session.call('discover_actions',{actionId,programRef:program.ref}) as ActionDiscoveryPage).items[0]!.bindings[0]!.pin;
    if(mode==='native-goal') {
      observeTaskContext(access);
      if(!ctx.preparedContextNavigation!.length) {
        const decision:AgentDecision={kind:'prepare',requestRevision:ctx.request.revision,message:'Prepare the read-only route context',steps:[],completionJson:'',contexts:[{id:'ride',bindingDigest:pin('SearchDidiPlaces').digest,inputJson:JSON.stringify(rideInput)}]};
        acknowledgeReads(access);return {decision,evidence:{...evidence(),decisionDigest:digest(decision)}};
      }
      ctx={...ctx,state:{...ctx.state,scope:ctx.preparedContextNavigation![0]!.scope},capability:program.capability(),actionIds:[...program.actionIds]};
    }
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
    if(mode==='native-goal') {
      if(complete)decision.completionJson=JSON.stringify({components:[{contextId:'ride',proposalJson:decision.completionJson}],criteria:[{id:'estimate',contextIds:['ride']}],conditions:[]});
      else decision.steps=steps.map(step=>({...step,contextId:'ride',bindingDigest:pin(step.action).digest,contributesTo:['estimate']}));
      assert.equal(root.state.programRef.id,'eigos.goal');acknowledgeReads(access);
    }
    return {decision,evidence:{...evidence(),decisionDigest:digest(decision)}};
  }};
  const failures:string[]=[];
  class CheckedCoordinator extends Coordinator {override async run(claim:import('../packages/core/store.js').WorkClaim,signal:AbortSignal){try{return await super.run(claim,signal);}catch(error){failures.push(error instanceof Error?error.stack??error.message:String(error));throw error;}}}
  const worker=new Worker(f.jobs,{coordinator:new CheckedCoordinator(f.jobs,reasoner,catalog,{allowSandbox:mode==='native-goal'}),pollMs:10,leaseMs:10000});
  try {
    const job=tasks.submit(p,{service:'eigos.delegate',requestId:'scoped-didi',goal:'查询北京西站到西二旗地铁站的预估车费，不叫车、不付款',...(mode==='native-goal'?{executionEnvironment:'sandbox'}:{})});
    const rootRevision=f.jobs.security.withAgent(p,job.id,'task.query',()=>f.jobs.ontology.read(f.owner,{type:'ServiceRequest',id:job.id}).revision);
    policy.restrictObject({ownerKey:f.owner,object:{type:'ServiceRequest',id:job.id},expectedObjectRevision:rootRevision,field:'originalGoal',classification:'sensitive',requiredMarkings:['health'],channels:['agent_response','registered_model']},policy.revision());
    worker.start();
    const deadline=Date.now()+30000;
    while(['submitted','working'].includes(f.jobs.get(f.owner,job.id).state) && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
    const raw=f.jobs.get(f.owner,job.id);
    assert.equal(raw.state,'completed',JSON.stringify({state:raw.state,error:raw.error,failures,recovery:raw.delegation?.recovery,grounding:raw.delegation?.groundingFeedback,feedback:raw.delegation?.agent?.feedback,reads:raw.delegation?.ontologyReads?.filter(r=>r.status==='rejected'),intents:f.jobs.intents(f.owner,job.id).map(i=>({state:i.state,result:i.lastResult?.message}))}));
    const result=tasks.get(p,job.id);
    if(mode==='direct')assert.ok(result.artifact?.data.deliverable.includes('73.05'));
    else assert.equal(raw.delegation!.agent!.programRef.id,'eigos.goal');
    assert.ok(result.artifact?.data.result && 'observations' in result.artifact.data.result);
    const output=JSON.stringify(result.artifact!.data.result);
    for(const field of ['73.05','CNY','observedAt','expiresAt','noBusinessWrites'])assert.ok(output.includes(field),`Missing actual result field: ${field}`);
    for(const field of ['"snapshot":','"components":','didiAnswer','PRIVATE_TRACE_NEVER_TO_MODEL'])assert.ok(!output.includes(field));
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
    const migrationDb=new DatabaseSync(f.jobs.databasePath),historicalDigest='e'.repeat(64);
    const originRow=migrationDb.prepare('SELECT body FROM security_object_origins WHERE owner=? AND type=? AND object_id=?').get(f.owner,observation.type,observation.id)!;
    const origin=JSON.parse(String(originRow.body));
    migrationDb.prepare('UPDATE security_object_origins SET body=? WHERE owner=? AND type=? AND object_id=?').run(JSON.stringify({...origin,programDigest:historicalDigest}),f.owner,observation.type,observation.id);
    assert.equal(tasks.get(p,job.id).artifact,undefined,'An unreviewed historical source version remains unavailable');
    const sourceRow=migrationDb.prepare('SELECT body FROM security_sources WHERE installation_id=? AND program_id=?').get(install.id,program.ref.id)!;
    const currentSource=JSON.parse(String(sourceRow.body));
    migrationDb.prepare('UPDATE security_sources SET body=? WHERE installation_id=? AND program_id=?').run(JSON.stringify({...currentSource,readbackVersions:[{sourceBindingId:profile.bindingId,programDigest:historicalDigest}]}),install.id,program.ref.id);
    assert.ok(tasks.get(p,job.id).artifact,'An exact operator-reviewed predecessor permits readback');
    assert.throws(()=>f.jobs.security.withAgent(p,job.id,'task.process',scope=>policy.requireSource(scope,program.ref.id,historicalDigest)),/SOURCE_NOT_AUTHORIZED/,'Readback compatibility never authorizes old-version dispatch');
    migrationDb.close();
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
