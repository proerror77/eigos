import {assertReviewedModel} from '../packages/security/model-review.js';
import {OntologyModel} from '../packages/ontology/model.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JobStore} from '../packages/core/store.js';
import {TaskService} from '../packages/core/tasks.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {createExecutionCatalog} from '../packages/capabilities/catalog.js';
import {RideEstimateProgram,initializeRideProgram,validateRideProgram,projectRideProgram} from '../packages/capabilities/rides/program.js';
import {RideRelayConnector} from '../packages/capabilities/rides/relay-connector.js';
import {normalizeRideData} from '../packages/capabilities/rides/connector.js';
import {rideReadResultSchema,type RideBinding} from '../packages/capabilities/rides/contracts.js';
import {rideSourceRequestSchema,type RideSourceResponse} from '../packages/agent-transport/ride-contracts.js';
import {assertSourceDispatchInput} from '../packages/agent-transport/source-protocol.js';
import {SOURCE_RELAY_PROTOCOL} from '../packages/agent-transport/service-contracts.js';
import {digest} from '../packages/core/delegation.js';
import {runGraphProgramAsync,type GraphStorage} from '../packages/ontology/graph-program.js';
import {createCurrentKernelDefinition,createSemanticRetrievalKernelDefinition,createRideSourcesKernelDefinition,StagedKernelBuilder} from '../packages/ontology/seed-definition.js';
import {compileOntologyDocument} from '../packages/ontology/model-compiler.js';
import {persistentConsentPolicyContracts} from '../packages/security/policy-store.js';
import {owner,principal} from './backend-fixture.js';
const peer='agent_'+'a'.repeat(43),query={coordinateSystem:'WGS84' as const,pickup:{latitude:1.28,longitude:103.85,address:'Synthetic origin'},dropoff:{latitude:1.36,longitude:103.99,address:'Synthetic destination'}};
function fixture(){
 const binding:RideBinding={provider:'uber',environment:'sandbox',bindingId:'synthetic',connectionId:randomUUID(),revision:1,owner},authority={id:randomUUID(),gatewayOrigin:'https://synthetic-primary.example'},accepted=new Map<string,RideSourceResponse>();let calls=0;
 const relay=new RideRelayConnector({create(_peer,input){const request=rideSourceRequestSchema.parse({...input,protocol:SOURCE_RELAY_PROTOCOL,kind:'source.read',callId:randomUUID(),expiresAt:Date.now()+60000});calls++;
  const data=normalizeRideData('uber',{ride_estimate:{product_estimates:[{product:{product_id:'synthetic'},fare:{fare_id:'fare',currency_code:'SGD',contractual:false,point_fare:'10.01'},eta:{eta_in_seconds:90}}]}},request.input),at=new Date().toISOString();
  const result=rideReadResultSchema.parse({data,receipt:{provider:'uber',environment:'sandbox',bindingId:binding.bindingId,connectionDigest:digest(binding),contextDigest:digest(request.context),inputDigest:digest(request.input),resultDigest:digest(data),evidenceKind:'fixture',startedAt:at,receivedAt:at}});
  accepted.set(request.callId,{protocol:SOURCE_RELAY_PROTOCOL,kind:'source.result',provider:'uber',callId:request.callId,authorityId:authority.id,requestDigest:digest(request),result});return request;},ready:id=>accepted.has(id),rideResult:id=>accepted.get(id),revoke(){}},peer,binding,authority,'fixture');
 const program=new RideEstimateProgram('uber',{binding,peerId:peer,enabled:true,kernelReady:true,connector:relay,verifyReceipt(id,wire,result){const actual=accepted.get(id);assert(actual?.result);assert.equal(actual.result.receipt.contextDigest,digest(wire));assert.deepEqual(actual.result,result);}});return {program,calls:()=>calls};
}
test('Uber and Grab disabled capabilities are discoverable for their owner without executable actions',()=>{
 const catalog=createExecutionCatalog(),local=JSON.stringify(['local-development','local','developer']);
 for(const provider of ['uber','grab']as const){const summary=catalog.summaries(local).find(s=>s.ref.id===`ride.${provider}.estimate`);assert(summary);assert.equal(summary.sourceAuthorization?.state,'disabled');const program=new RideEstimateProgram(provider);assert.deepEqual(program.actionIds,[]);assert.throws(()=>program.assertSourceAvailable(local));}
 assert(!catalog.summaries(JSON.stringify(['foreign','tenant','owner'])).some(s=>['ride.uber.estimate','ride.grab.estimate'].includes(s.ref.id)));
});
test('v30 is explicit, preserves v28/v29 and the original policy, and staged compilation is identical',{timeout:300000},()=>{
 const current=createCurrentKernelDefinition(),semantic=createSemanticRetrievalKernelDefinition(),next=createRideSourcesKernelDefinition();assert.equal(current.document.version,'28');assert.equal(semantic.document.version,'29');assert.equal(next.document.version,'30');
 const before=compileOntologyDocument(semantic.document,semantic.registry),after=compileOntologyDocument(next.document,next.registry);
 for(const t of semantic.document.objects)assert.equal(before.fingerprint(t.id),after.fingerprint(t.id));for(const a of semantic.document.actions)assert.deepEqual(before.action(a.id),after.action(a.id));
 assert.doesNotThrow(()=>assertReviewedModel(after,before));assert.throws(()=>assertReviewedModel(after,new OntologyModel({...compileOntologyDocument(current.document,current.registry).definitionSnapshot(),version:'29'})));
 const builder=new StagedKernelBuilder('30');for(let n=0;n<17;n++)builder.step(n);assert.deepEqual(builder.trusted().model.ref,after.ref);
 assert.equal(persistentConsentPolicyContracts(compileOntologyDocument(current.document,current.registry)).after,persistentConsentPolicyContracts(before).after);assert.notEqual(persistentConsentPolicyContracts(after).after,persistentConsentPolicyContracts(before).after);
});
test('shared ride scope, dispatch, projection and status behave identically through awaited storage; all evidence remains estimate-only',{timeout:300000},async()=>{
 const stores=[new JobStore(':memory:'),new JobStore(':memory:')],outcomes=[];try{for(const[index,store]of stores.entries()){
  const ns=store.definitions.namespace();store.definitions.installRideSources(ns.active,ns.generation);const {program,calls}=fixture(),catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]);
  const job=new TaskService(store,{catalog}).submit(principal,{goal:'Get a ride estimate and App handoff only',requestId:randomUUID(),executionEnvironment:'sandbox'}),request=store.get(owner,job.id).delegation!.request,graph=store.ontologyForJob(owner,job.id);
  const asyncGraph:GraphStorage={read:async(...a)=>graph.read(...a),readPrivate:async(...a)=>graph.readPrivate(...a),query:async(...a)=>graph.query(...a),related:async(...a)=>graph.related(...a),ingest:async(...a)=>graph.ingest(...a),containsLinks:async(...a)=>graph.containsLinks(...a),relationshipDigest:async(...a)=>graph.relationshipDigest(...a),evidencePropertiesDigest:async(...a)=>graph.evidencePropertiesDigest(...a),tombstone:async(...a)=>graph.tombstone(...a)};
  const initial=index?await runGraphProgramAsync(asyncGraph,initializeRideProgram(program,graph,owner,request,query)):program.initialize(graph,owner,request,query);
  const ctx={graph,owner,request,state:{version:'1' as const,programRef:program.ref,programDigest:program.configurationDigest,scope:initial.scope,input:initial.input,requestRevision:request.revision,plans:[],observations:[],feedback:[]},planId:'original-plan',intentId:'original-intent',attemptId:'original-attempt',modelRunId:'original-model'},input={scope:initial.scope,query},action='EstimateUberRide';
  const result=await program.invoke(ctx,action,input,AbortSignal.timeout(5000));assert.equal(calls(),1);const object=index?await runGraphProgramAsync(asyncGraph,projectRideProgram(program,ctx,action,input,result)):program.project(ctx,action,input,result);
  const status=graph.evaluate(owner,{function:'rideSourceStatus',object});assert.equal(status.status,'known',JSON.stringify(status));assert.equal((status.value as any).orderCreated,false);assert.equal((status.value as any).paymentInitiated,false);
  assert.throws(()=>program.validate(ctx,action,{...input,query:{...query,dropoff:{...query.dropoff,latitude:9}}}));await assert.rejects(runGraphProgramAsync(asyncGraph,validateRideProgram(program,{...ctx,owner:'foreign'},action,input)));
  const tampered=structuredClone(result);(tampered.value as any).wire.attemptId='foreign';assert.throws(()=>program.project(ctx,action,input,tampered));const aborted=new AbortController();aborted.abort();await assert.rejects(program.invoke(ctx,action,input,aborted.signal));assert.equal(calls(),1);
  outcomes.push({known:status.status,data:(status.value as any).estimate,types:graph.related(owner,object,'sourceReceipts',{remaining:100})?.map(r=>r.ref.type)});
 }}finally{stores.forEach(s=>s.close());}assert.deepEqual(outcomes[0],outcomes[1]);
});
