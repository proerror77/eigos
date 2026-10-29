// Synthetic source/model fixture shared by Worker and real protocol readback tests.
import assert from 'node:assert/strict';
import type {DidiAgentProgram} from '../../packages/capabilities/didi/program.js';
import type {Reasoner} from '../../packages/coordinator/coordinator.js';
import {digest} from '../../packages/core/delegation.js';
import type {AgentDecision,AgentStep} from '../../packages/ontology/agent-actions.js';
import type {ObjectRef} from '../../packages/ontology/model.js';
import type {DidiData} from '../../packages/capabilities/didi/contracts.js';
import type {ActionDiscoveryPage} from '../../packages/core/action-bindings.js';
import {evidence,interpretation,syntheticGoalReview,observeTaskContext,acknowledgeReads} from '../backend-fixture.js';
import {input as rideInput} from './didi.js';
import {Worker} from '../../apps/worker/worker.js';
import type {Coordinator} from '../../packages/coordinator/coordinator.js';
import type {JobStore} from '../../packages/core/store.js';

/** Real Worker ownership with caller-controlled fixture time. CPU scheduling
 * does not advance authority time; the real-time test signal bounds waiting. */
export async function runNativeDidiTask(store:JobStore,coordinator:Coordinator,owner:string,taskId:string,signal:AbortSignal,advanceTime:()=>void) {
  const worker=new Worker(store,{coordinator,pollMs:20,leaseMs:10000});
  try {
    worker.start();
    while(['submitted','working'].includes(store.get(owner,taskId).state)) {
      signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,20));advanceTime();
    }
  }finally{await worker.close();}
}

export function securedDidiReasoner(program:DidiAgentProgram,mode:'direct'|'native-goal') {
  const modelInputs:string[]=[];let closed=0,turns=0;
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
    if(mode==='native-goal')assert(++turns<=8,'The synthetic native goal exceeded its bounded decision count');
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
  return {reasoner,modelInputs,closed:()=>closed};
}
