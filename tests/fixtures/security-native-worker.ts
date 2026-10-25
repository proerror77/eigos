// Compiled, separate-process foundation proof. All source facts and choices are synthetic.
import {readFileSync,writeFileSync} from 'node:fs';
import {JobStore} from '../../packages/core/store.js';
import {ExecutionCatalog} from '../../packages/core/catalog.js';
import {bindPersonalSourceOwner} from '../../packages/core/source-owner.js';
import {ParticipantBookingProgram} from '../../packages/capabilities/free-booking/program.js';
import {participantFixture} from './free-booking.js';
import {Coordinator,type Reasoner} from '../../packages/coordinator/coordinator.js';
import {Worker} from '../../apps/worker/worker.js';
import {evidence,interpretation} from '../backend-fixture.js';
import {digest} from '../../packages/core/delegation.js';
import type {AgentDecision} from '../../packages/ontology/agent-actions.js';

const {database,owner,taskId,resultFile}=JSON.parse(readFileSync(process.argv[2]!,'utf8'));
const fixture=participantFixture(),program=new ParticipantBookingProgram(fixture.source);bindPersonalSourceOwner(program,owner);
let reads=0;const call=fixture.source.call.bind(fixture.source);fixture.source.call=async(...args)=>{reads++;return call(...args);};
const catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]),store=new JobStore(database,{securityMode:'foundation'});
const reasoner:Reasoner={securityChannelId:'s5-synthetic',ground:async request=>({decision:{...interpretation(request,program.ref.id,fixture.input),capabilityRef:program.ref},evidence:evidence()}),plan:async()=>{throw Error('No legacy planning');},act:async(ctx,_signal,access)=>{
  access.session.call('describe_ontology',{search:'RegistrationTask',limit:1});access.session.call('query_ontology',{object:ctx.state.scope});
  const ref=ctx.state.observations.at(-1);
  if(ref){access.session.call('query_ontology',{object:ref});access.session.call('evaluate_ontology',{function:'registrationStatus',object:ref});}
  const decision:AgentDecision={kind:ref?'complete':'execute',requestRevision:ctx.request.revision,message:'Synthetic independent existing-registration read',steps:ref?[]:[{id:'read',action:'ReadParticipantRegistration',argumentsJson:JSON.stringify({scope:ctx.state.scope}),dependsOn:[],inputRefs:[]}],completionJson:ref?JSON.stringify({registration:ref,rationale:'Independently read an existing synthetic registration'}):''};
  return {decision,evidence:{...evidence(),decisionDigest:digest(decision)}};
}};
const worker=new Worker(store,{coordinator:new Coordinator(store,reasoner,catalog,{allowSandbox:true}),pollMs:10});
try {
  worker.start();const deadline=Date.now()+30000;
  while(Date.now()<deadline) {
    const job=store.get(owner,taskId);
    if(!['submitted','working'].includes(job.state)){writeFileSync(resultFile,JSON.stringify({state:job.state,reads,submits:fixture.counters().submits}),{mode:0o600});break;}
    await new Promise(done=>setTimeout(done,25));
  }
}finally{await worker.close();store.close();fixture.store.close();}
