// Compiled, separate-process foundation proof. All source facts and choices are synthetic.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {JobStore} from '../../packages/core/store.js';
import {ExecutionCatalog} from '../../packages/core/catalog.js';
import {bindPersonalSourceOwner} from '../../packages/core/source-owner.js';
import {ParticipantBookingProgram} from '../../packages/capabilities/free-booking/program.js';
import {participantFixture} from './free-booking.js';
import {Coordinator,type Reasoner} from '../../packages/coordinator/coordinator.js';
import {Worker} from '../../apps/worker/worker.js';
import {evidence,interpretation,syntheticGoalReview,observeTaskContext,acknowledgeReads} from '../backend-fixture.js';
import {digest} from '../../packages/core/delegation.js';
import type {AgentDecision} from '../../packages/ontology/agent-actions.js';

const {database,owner,taskId,resultFile}=JSON.parse(readFileSync(process.argv[2]!,'utf8'));
const fixture=participantFixture(),program=new ParticipantBookingProgram(fixture.source);bindPersonalSourceOwner(program,owner);
let reads=0;const call=fixture.source.call.bind(fixture.source);fixture.source.call=async(...args)=>{reads++;return call(...args);};
const store=new JobStore(database,{securityMode:'foundation'}),catalog=new ExecutionCatalog([program.capability()],[],[],[],[program],undefined,store.security);
const reasoner:Reasoner={ontologyContextMode:'task',securityChannelId:'s5-synthetic',reviewGoal:syntheticGoalReview,ground:async(request,_caps,_signal,access)=>{request=observeTaskContext(access)??request;return {decision:{...interpretation(request,program.ref.id,fixture.input),capabilityRef:program.ref},evidence:evidence()};},plan:async()=>{throw Error('No legacy planning');},act:async(ctx,_signal,access)=>{
  observeTaskContext(access);
  access.session.call('describe_ontology',{search:'RegistrationTask',limit:1});access.session.call('query_ontology',{object:ctx.state.scope});
  const ref=ctx.state.observations.at(-1);
  if(ref){access.session.call('query_ontology',{object:ref});access.session.call('evaluate_ontology',{function:'registrationStatus',object:ref});}
  const decision:AgentDecision={kind:ref?'complete':'execute',requestRevision:ctx.request.revision,message:'Synthetic independent existing-registration read',steps:ref?[]:[{id:'read',action:'ReadParticipantRegistration',argumentsJson:JSON.stringify({scope:ctx.state.scope}),dependsOn:[],inputRefs:[]}],completionJson:ref?JSON.stringify({registration:ref,rationale:'Independently read an existing synthetic registration'}):''};
  acknowledgeReads(access);
  return {decision,evidence:{...evidence(),decisionDigest:digest(decision)}};
}};
const coordinator=new Coordinator(store,reasoner,catalog,{allowSandbox:true}),run=coordinator.run.bind(coordinator);
let failure: {name?:string;code?:unknown;reason?:unknown;message?:string}|undefined;
coordinator.run=async(...args)=>{try{return await run(...args);}catch(error){const e=error as Error & {code?:unknown;reason?:unknown};failure={name:e.name,code:e.code,reason:e.reason,message:e.message.slice(0,500)};throw error;}};
const worker=new Worker(store,{coordinator,pollMs:25,leaseMs:30000,timeoutMs:60000});
try {
  worker.start();const deadline=Date.now()+65000;let lastProgress='';
  while(Date.now()<deadline) {
    const job=store.get(owner,taskId);
    const progress={state:job.state,phase:job.delegation?.phase,reads,submits:fixture.counters().submits,modelRuns:job.runs?.length??0,failure};
    if(JSON.stringify(progress)!==lastProgress){lastProgress=JSON.stringify(progress);writeFileSync(resultFile+'.progress.json',lastProgress,{mode:0o600});}
    if(!['submitted','working'].includes(job.state)){writeFileSync(resultFile,JSON.stringify({state:job.state,reads,submits:fixture.counters().submits,...(job.state!=='completed'?{diagnostic:{failure,recovery:job.delegation?.recovery,events:job.delegation?.events.slice(-4)}}:{})}),{mode:0o600});break;}
    await new Promise(done=>setTimeout(done,25));
  }
  if(!existsSync(resultFile))writeFileSync(resultFile,JSON.stringify({state:store.get(owner,taskId).state,reads,submits:fixture.counters().submits,diagnostic:{deadlineReached:true,progress:lastProgress?JSON.parse(lastProgress):undefined}}),{mode:0o600});
}finally{await worker.close();store.close();fixture.store.close();}
