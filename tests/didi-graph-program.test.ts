import {test} from 'node:test';
import {runtimeAuthoritySchema} from '../packages/core/runtime-authority.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {JobStore} from '../packages/core/store.js';
import {TaskService} from '../packages/core/tasks.js';
import {DidiAgentProgram,initializeDidiProgram,projectDidiProgram,buildDidiReadResult,didiCallContext,verifyDidiResultProgram,validateDidiCallPlanningProgram,type DidiActionProgramContext} from '../packages/capabilities/didi/program.js';
import {digest} from '../packages/core/delegation.js';
import {projectRideEstimateProgram} from '../packages/ontology/ride-estimate-projection.js';
import {runGraphProgram,runGraphProgramAsync,type GraphStorage,type SyncGraphStorage} from '../packages/ontology/graph-program.js';
import {didiFixture} from './fixtures/didi.js';
import {owner,principal} from './backend-fixture.js';
import {ownerKey} from '../packages/core/domain.js';
import type {DidiMemberConnection} from '../packages/core/didi-source.js';
import type {PostgresDatabase} from '../packages/postgres/database.js';
import {PostgresDidiAccount} from '../packages/postgres/didi-account.js';
import {PostgresTaskRelay} from '../packages/postgres/task-relay.js';
import {PostgresRelayReadAuthority} from '../packages/postgres/relay-read-authority.js';
import {PostgresReadProgramRegistry} from '../packages/postgres/didi-registry.js';
import {planningSnapshot,type ObjectSnapshot} from '../packages/ontology/planning-contract.js';
import type {ObjectRef} from '../packages/ontology/model.js';

function countedStorage(graph:SyncGraphStorage,counts:{scope:number;observations:number;evaluations:number}):SyncGraphStorage{
  return {read:(...args)=>graph.read(...args),readPrivate:(o,ref)=>{if(ref.type==='RideEstimateTask')counts.scope++;if(ref.type==='DidiPlaceObservation')counts.observations++;return graph.readPrivate(o,ref);},query:(...args)=>graph.query(...args),related:(...args)=>graph.related(...args),ingest:(...args)=>graph.ingest(...args),containsLinks:(...args)=>graph.containsLinks(...args),relationshipDigest:(...args)=>graph.relationshipDigest(...args),evidencePropertiesDigest:(...args)=>graph.evidencePropertiesDigest(...args),tombstone:(...args)=>graph.tombstone(...args),
    evaluate:(...args)=>{counts.evaluations++;if(!graph.evaluate)throw new Error('Actual evaluation is required');return graph.evaluate(...args);},
    withGraphFunction:(o,id,action)=>{if(!graph.withGraphFunction)throw new Error('Actual registered function scope is required');return graph.withGraphFunction(o,id,scope=>action(countedStorage(scope,counts)));}};
}

test('shared DiDi readonly initialization and canonical projection preserve the real SQLite facade through awaited storage',async()=>{
  const source=didiFixture(),stores=[new JobStore(':memory:'),new JobStore(':memory:')];try{
    const program=new DidiAgentProgram(source.binding,{connector:source.connector}),prepared=[];
    for(const [index,store] of stores.entries()){
      const job=new TaskService(store,{catalog:new ExecutionCatalog([program.capability()],[],[],[],[program])}).submit(principal,{goal:'Synthetic supplied place lookup only',requestId:randomUUID()}),request=store.get(owner,job.id).delegation!.request,graph=store.ontologyForJob(owner,job.id),input={mode:'places',city:'北京市',keywords:'北京西站'};
      const storage:GraphStorage={read:async(...args)=>graph.read(...args),readPrivate:async(...args)=>graph.readPrivate(...args),query:async(...args)=>graph.query(...args),related:async(...args)=>graph.related(...args),ingest:async(...args)=>graph.ingest(...args),containsLinks:async(...args)=>graph.containsLinks(...args),relationshipDigest:async(...args)=>graph.relationshipDigest(...args),evidencePropertiesDigest:async(...args)=>graph.evidencePropertiesDigest(...args),tombstone:async(...args)=>graph.tombstone(...args),projectedRelationshipDigest:async(...args)=>graph.projectedRelationshipDigest(...args)};
      const initialized=index?await runGraphProgramAsync(storage,initializeDidiProgram(program,graph,owner,request,input)):program.initialize(graph,owner,request,input);
      const actionInput={scope:initialized.scope,role:'search',keywords:input.keywords},context:DidiActionProgramContext={graph,owner,request,state:{version:'1',programRef:program.ref,programDigest:program.configurationDigest,scope:initialized.scope,input,requestRevision:request.revision,plans:[],observations:[],feedback:[]},planId:'synthetic-plan',intentId:'synthetic-intent',attemptId:'synthetic-attempt',modelRunId:'synthetic-model'};
      const call={tool:'maps_textsearch' as const,args:{city:input.city,keywords:input.keywords}},raw=await source.connector.invoke(didiCallContext(program,context,'SearchDidiPlaces',actionInput),call.tool,call.args,AbortSignal.timeout(5000));
      const response=buildDidiReadResult(program,context,'SearchDidiPlaces',actionInput,call,raw),counts={scope:0,observations:0,evaluations:0};
      runGraphProgram(countedStorage(graph,counts),verifyDidiResultProgram(program,context,'SearchDidiPlaces',actionInput,response));
      assert.equal(counts.scope,1,'A single result verifier resolves the same source call once');
      const object=index?await runGraphProgramAsync(storage,projectRideEstimateProgram(graph,owner,response.value)):program.project({...context,graph},'SearchDidiPlaces',actionInput,response);
      const observation=graph.read(owner,object);assert.equal(observation.ref.type,'DidiPlaceObservation');const links=graph.related(owner,object,'sourceReceipts',{remaining:1000});assert.equal(links?.length,1);
      const sourceReceipt=links![0]!;assert.equal(sourceReceipt.properties.evidenceLevel,'synthetic');assert.equal((sourceReceipt.properties.subjects as unknown[]).length,3,'Observation plus both real canonical place facts are independently sealed');
      prepared.push({places:(observation.properties.snapshot as any).data.places.length,sourceTypes:graph.query(owner,{type:'Place',limit:50}).items.map(value=>value.ref.type),noBusinessWrites:(observation.properties.snapshot as any).noBusinessWrites});
    }
    assert.deepEqual(prepared[0],prepared[1]);assert(source.calls.filter(call=>call.method==='tools/call').every(call=>call.name==='maps_textsearch'));assert(!source.calls.some(call=>call.name==='taxi_create_order'));
  }finally{for(const store of stores)store.close();source.close();}
});

test('DiDi validates each dependency once per invocation and rejects changed roles, mismatched receipts or missing reads',async()=>{
  const source=didiFixture(),store=new JobStore(':memory:');try{
    const program=new DidiAgentProgram(source.binding,{connector:source.connector}),job=new TaskService(store,{catalog:new ExecutionCatalog([program.capability()],[],[],[],[program])}).submit(principal,{goal:'Synthetic source-backed route estimate only',requestId:randomUUID()}),request=store.get(owner,job.id).delegation!.request,graph=store.ontologyForJob(owner,job.id),input={mode:'estimate',city:'北京市',origin:'北京西站',destination:'西二旗地铁站'},initialized=program.initialize(graph,owner,request,input);
    const context:DidiActionProgramContext={graph,owner,request,state:{version:'1',programRef:program.ref,programDigest:program.configurationDigest,scope:initialized.scope,input,requestRevision:request.revision,plans:[],observations:[],feedback:[]},planId:'synthetic-plan',intentId:'synthetic-intent',attemptId:'synthetic-attempt',modelRunId:'synthetic-model'};
    const refs:ObjectRef[]=[],placeIds:string[]=[];
    for(const role of ['origin','destination'] as const){
      const actionInput={scope:initialized.scope,role,keywords:input[role]},call={tool:'maps_textsearch' as const,args:{city:input.city,keywords:input[role]}},raw=await source.connector.invoke(didiCallContext(program,context,'SearchDidiPlaces',actionInput),call.tool,call.args,AbortSignal.timeout(5000)),result=buildDidiReadResult(program,context,'SearchDidiPlaces',actionInput,call,raw),ref=program.project({...context,graph},'SearchDidiPlaces',actionInput,result);
      refs.push(ref);context.state.observations.push(ref);const snapshot=result.value as import('../packages/ontology/ride-estimate.js').RideEstimateObservation;assert.equal(snapshot.data.kind,'places');if(snapshot.data.kind!=='places')throw new Error('Expected actual fixture search data');placeIds.push(snapshot.data.places.find(place=>place.name===input[role])!.id);
    }
    const objects:ObjectSnapshot[]=refs.map(ref=>({ref,revision:graph.read(owner,ref).revision,propertiesDigest:graph.evidencePropertiesDigest(owner,ref,{remaining:1000}),linksDigest:graph.relationshipDigest(owner,ref,{remaining:1000})}));
    // Explicit synthetic model receipts derived from the actual graph reads;
    // this fixture invokes no model or permissive semantic validator.
    const reads=planningSnapshot({mode:'model_queries',model:graph.model.ref,requestRevision:request.revision,conditionsDigest:digest(request.conditions??[]),objects,conditionChecks:[],actionProposals:[],reads:refs.map((ref,index)=>{const args={function:'rideEstimateStatus',object:ref};return {id:randomUUID(),at:new Date().toISOString(),tool:'evaluate_ontology',inputDigest:digest(args),outputDigest:digest(graph.evaluate(owner,args)),datasetRevision:graph.revision(owner),status:'ok',objects:[objects[index]!]};})});
    const estimate={scope:initialized.scope,originObservation:refs[0]!,originPlaceId:placeIds[0]!,destinationObservation:refs[1]!,destinationPlaceId:placeIds[1]!},counts={scope:0,observations:0,evaluations:0},storage=countedStorage(graph,counts);
    const checked=runGraphProgram(storage,validateDidiCallPlanningProgram(program,context,'EstimateDidiRide',estimate,reads));
    assert.equal(checked.call.tool,'taxi_estimate');assert.equal(checked.dependencies.length,2);
    assert.equal(counts.scope,1,'Both dependencies use the same checked route scope');
    assert.equal(counts.observations,2,'Each dependency snapshot is source-checked once within this invocation');
    assert.equal(counts.evaluations,2,'The exact current registered evaluation is reused for the receipt comparison');
    const mismatched={...reads,reads:reads.reads.map((receipt,index)=>index===0?{...receipt,outputDigest:digest('other output')}:receipt)};
    assert.throws(()=>runGraphProgram(storage,validateDidiCallPlanningProgram(program,context,'EstimateDidiRide',estimate,mismatched)),/read and evaluate/);
    assert.equal(counts.evaluations,4,'A separate validation invocation resolves both dependencies again');
    assert.throws(()=>runGraphProgram(storage,validateDidiCallPlanningProgram(program,context,'EstimateDidiRide',estimate,{...reads,reads:[]})),/read and evaluate/);
    assert.throws(()=>runGraphProgram(storage,validateDidiCallPlanningProgram(program,context,'EstimateDidiRide',{...estimate,originObservation:refs[1]!},reads)),/Wrong place source/);
    const changed={...context,state:{...context.state,observations:[refs[0]!]}};assert.throws(()=>runGraphProgram(storage,validateDidiCallPlanningProgram(program,changed,'EstimateDidiRide',estimate,reads)),/not accepted by this task/);
  }finally{store.close();source.close();}
});

test('registered validator function scopes are read-only and expire at their real callback boundary',()=>{
  const store=new JobStore(':memory:');try{
    let saved:SyncGraphStorage|undefined;store.ontology.withGraphFunction(owner,'rideEstimateStatus',scope=>{saved=scope;assert.throws(()=>scope.ingest(owner,{objects:[],links:[]},{kind:'synthetic',id:'forbidden-write',observedAt:new Date().toISOString()}),/AUTHORIZATION_REQUIRED/);});
    assert(saved);assert.throws(()=>saved!.read(owner,{type:'ServiceRequest',id:randomUUID()}),/AUTHORIZATION_REQUIRED/);
  }finally{store.close();}
});

test('production DiDi registration shares the actual account with Relay and rejects a missing or different account before any I/O',()=>{
  const source=didiFixture();try{
    const identity={issuer:'https://synthetic.example',tenant:'test',subject:'account-owner'},owner=ownerKey({...identity,clientId:'test',scopes:[]}),policyDigest=digest('synthetic-registry-policy');
    let descriptor:DidiMemberConnection={version:1,connectionId:randomUUID(),revision:1,memberId:randomUUID(),owner:identity,localUid:process.getuid?.()??0,purpose:'ride_estimate_readonly',state:'active',expiresAt:new Date(Date.now()+60000).toISOString(),binding:{...source.binding,environment:'production',auditDirectory:source.binding.auditDirectory!}};
    const account=new PostgresDidiAccount(source.binding,owner,{readCurrent:()=>descriptor}),other=new PostgresDidiAccount(source.binding,owner,{readCurrent:()=>descriptor});
    const noIO=async():Promise<never>=>{throw new Error('Constructor validation must not use PostgreSQL or a provider');},database:Pick<PostgresDatabase,'run'|'inspectClaim'>={run:noIO,inspectClaim:noIO};
    const canonicalOrigin='https://primary.synthetic.example';
    const runtime=runtimeAuthoritySchema.parse({version:1,id:randomUUID(),revision:1,canonicalOrigin,issuer:identity.issuer,ontologyId:'eigos.business',
      databasePath:'/synthetic/tasks.sqlite',membershipDatabasePath:'/synthetic/members.sqlite',
      ingresses:[{origin:canonicalOrigin,audience:canonicalOrigin,agentClientId:'test',agentClientIds:['test']}]});
    const authority={id:runtime.id,gatewayOrigin:runtime.canonicalOrigin};
    const options={database,policyDigest,authority:runtime},relay=new PostgresTaskRelay({...options,didiAccount:account});
    const registration={binding:source.binding,owner,account,kind:'relay' as const,reads:relay.reads,peerId:'agent_'+'A'.repeat(43),authority};
    assert.equal(relay.reads.didiAccount,account);const registry=new PostgresReadProgramRegistry(policyDigest,{documentEnabled:false,didi:registration});assert.equal(registry.entries[0]!.didi!.account,account);
    assert.throws(()=>new PostgresReadProgramRegistry(policyDigest,{didi:{...registration,reads:new PostgresRelayReadAuthority(options)}}),/same current account/);
    assert.throws(()=>new PostgresReadProgramRegistry(policyDigest,{didi:{...registration,account:other}}),/same current account/);
    descriptor={...descriptor,revision:descriptor.revision+1};assert.equal(registry.entries[0]!.program.permitted(owner),false);assert.throws(()=>account.assertBinding(source.binding,owner));assert.equal(source.calls.length,0);
  }finally{source.close();}
});
