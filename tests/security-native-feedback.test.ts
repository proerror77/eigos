import {z} from 'zod';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import type {AgentProgram} from '../packages/core/agent-program.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JobStore} from '../packages/core/store.js';
import {digest} from '../packages/core/delegation.js';
import {createGoalContract} from '../packages/core/goal-contract.js';
import {BACKEND_VERSION,type ServiceCapability,type ServiceRequest} from '../packages/ontology/execution.js';
import type {AgentComponentContext,AgentDecision} from '../packages/ontology/agent-actions.js';
import type {ActionBindingPin} from '../packages/core/action-bindings.js';
import type {Job} from '../packages/core/domain.js';
import {templatePlanning} from '../packages/ontology/planning-contract.js';

// Feedback input fixtures represent already independently checked source results;
// this test performs no model call, provider operation or capability publication.
test('native component feedback uses stable provider identities and never inherits an unresolved root success',()=>{
 const store=new JobStore(':memory:'),owner=JSON.stringify(['synthetic','tenant','alice']);
 try {
  const id=randomUUID(),at=new Date().toISOString(),release=store.definitions.active().ref;
  const request:ServiceRequest={id,revision:1,originalGoal:'Compare Alpha and Beta quotes',requirements:[],messages:[{id:'request',text:'Compare Alpha and Beta quotes',receivedAt:at}]};
  const capability:ServiceCapability={ref:{id:'fixture.quotes',version:'1'},ontologyRef:{id:'fixture',version:'1'},name:'Fixture',description:'Fixture',tags:[],inputSchema:{},ontology:{},actions:[],predicates:[],goalOutcomes:[{predicate:'quote.read',phase:'quote',description:'Source quote'}],verifierRef:{id:'fixture',version:'1'}};
  const goal=createGoalContract(request,release,[{id:'quotes',description:'Compare both',predicate:'quote.read',phase:'quote',messageId:'request',quote:request.originalGoal,requirementIds:[]}],[capability]);
  const context=(name:string):AgentComponentContext=>{
   const programRef={id:`fixture.${name}`,version:'1'},programDigest=digest(programRef);
   const pin:Omit<ActionBindingPin,'digest'>={ref:programRef,programRef,actionId:'SyntheticRead',actionVersion:'1',definitionDigest:digest('fixture'),configurationDigest:programDigest,ontologyRelease:release,ownerDigest:digest(owner),requestId:id,requestRevision:1};
   const binding={...pin,digest:digest(pin)},decision:AgentDecision={kind:'prepare',requestRevision:1,message:'Synthetic context',steps:[],completionJson:'',contexts:[{id:name,bindingDigest:binding.digest,inputJson:'{"mode":"quote"}'}]};
   const body:Omit<AgentComponentContext,'digest'>={id:name,programRef,programDigest,requestRevision:1,scope:{type:'ServiceRequest',id},input:{mode:'quote'},initializedBy:{modelRunId:'synthetic',binding,decision,ontologyPlanning:templatePlanning(request,store.ontology.model.ref)}};
   return {...body,digest:digest(body)};
  };
  const alpha=context('alpha'),beta=context('beta');
  const job:Job={id,contextId:randomUUID(),service:'eigos.delegate',goal:request.originalGoal,state:'completed',revision:1,messages:[],createdAt:at,updatedAt:at,runs:[],delegation:{backendVersion:BACKEND_VERSION,ontologyRelease:release,request,phase:'accepted',events:[],agent:{version:'2',programRef:{id:'eigos.goal',version:'1'},programDigest:digest({goal:goal.digest}),scope:{type:'ServiceRequest',id},input:{},requestRevision:1,plans:[],observations:[],feedback:[],composition:{version:'1',goal,contexts:[alpha,beta],assessment:{version:'1',goalDigest:goal.digest,accepted:false,at,criteria:[],requirements:[],conditions:[],components:[{contextId:'alpha',status:'verified',delivery:{artifact:{id:randomUUID(),name:'synthetic-quote',data:{goal:request.originalGoal,deliverable:'A source quote',execution:'completed'}},facts:{},evidenceRefs:['exact-alpha-receipt'],evidenceLevel:'synthetic'}},{contextId:'beta',status:'unverified',reason:'No independent result'}]}}}}};
  store.recordFeedback(owner,job,'live_fulfillment',false);
  const a=store.providerFeedback(owner,alpha.programRef) as Record<string,unknown>[],b=store.providerFeedback(owner,beta.programRef) as Record<string,unknown>[];
  assert.equal(a.length,1);assert.equal(a[0]!.bindingDefinitionDigest,alpha.programDigest);assert.equal(a[0]!.scope,'component_only');assert.equal(a[0]!.parentTaskState,'completed');
  assert.equal(a[0]!.outcome,'satisfied');assert.equal(a[0]!.evidenceLevel,'synthetic');assert.deepEqual(a[0]!.evidenceRefs,['exact-alpha-receipt']);
  assert.equal(b[0]!.outcome,'unknown');assert.equal(b[0]!.evidenceLevel,'unverified');assert.deepEqual(b[0]!.evidenceRefs,[]);
  store.recordFeedback(owner,job,'live_fulfillment',false);assert.equal(store.providerEvidenceView(owner,alpha.programRef,alpha.programDigest).sampleCount,1);
  assert.equal(store.providerEvidenceView(owner,alpha.programRef,'different-version').sampleCount,0);assert.equal(store.providerFeedback('another-owner',alpha.programRef).length,0);
  assert.equal(store.capabilityFacts(owner,alpha.programRef).verifications.length,0);assert.equal(a[0]!.availabilityProof,false);assert.equal(a[0]!.automaticPromotion,false);
  job.delegation!.agent!.composition!.assessment!.goalDigest='stale';store.recordFeedback(owner,job,'live_fulfillment',false);
  assert.equal((store.providerFeedback(owner,alpha.programRef) as Record<string,unknown>[])[0]!.outcome,'unknown');
 }finally{store.close();}
});

test('capability feedback lookup requires one exact permitted runtime and keeps ambiguous provider families native',()=>{
 const capability:ServiceCapability={ref:{id:'fixture.semantic',version:'1'},ontologyRef:{id:'fixture',version:'1'},name:'Fixture',description:'Fixture',tags:[],inputSchema:{},ontology:{},actions:[],predicates:[],verifierRef:{id:'fixture',version:'1'}};
 const program=(id:string,allowed=true):AgentProgram=>({ref:{id,version:'1'},configurationDigest:digest(id),actionIds:[],completionSchema:{},guidance:'Synthetic',permitted:()=>allowed,capability:()=>capability,
  initialize:()=>{throw new Error('No execution expected');},schema:()=>z.object({}),definition:()=>{throw new Error('No execution expected');},validate:()=>{},invoke:async()=>{throw new Error('No execution expected');},project:()=>{throw new Error('No execution expected');},complete:()=>{throw new Error('No execution expected');}});
 const a=program('fixture.actual.a'),b=program('fixture.actual.b'),owner='fixture-owner';
 assert.equal(new ExecutionCatalog([capability],[],[],[],[a]).programForCapability(capability.ref,owner),a);
 const multiple=new ExecutionCatalog([capability],[],[],[],[a,b]);
 assert.equal(multiple.programForCapability(capability.ref,owner),undefined);
 assert.equal(multiple.agentProgram(a.ref,owner),a);assert.equal(multiple.agentProgram(b.ref,owner),b);
 assert.equal(new ExecutionCatalog([capability],[],[],[],[a,program('fixture.hidden',false)]).programForCapability(capability.ref,owner),a);
 assert.equal(multiple.programForCapability({...capability.ref,version:'other'},owner),undefined);
});
