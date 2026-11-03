import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {JobStore} from '../packages/core/store.js';
import {TaskService} from '../packages/core/tasks.js';
import {DidiAgentProgram,initializeDidiProgram,projectDidiProgram,buildDidiReadResult,didiCallContext,type DidiActionProgramContext} from '../packages/capabilities/didi/program.js';
import {digest} from '../packages/core/delegation.js';
import {projectRideEstimateProgram} from '../packages/ontology/ride-estimate-projection.js';
import {runGraphProgramAsync,type GraphStorage,type SyncGraphStorage} from '../packages/ontology/graph-program.js';
import {didiFixture} from './fixtures/didi.js';
import {owner,principal} from './backend-fixture.js';
import {ownerKey} from '../packages/core/domain.js';
import type {DidiMemberConnection} from '../packages/core/didi-source.js';
import type {PostgresDatabase} from '../packages/postgres/database.js';
import {PostgresDidiAccount} from '../packages/postgres/didi-account.js';
import {PostgresTaskRelay} from '../packages/postgres/task-relay.js';
import {PostgresRelayReadAuthority} from '../packages/postgres/relay-read-authority.js';
import {PostgresReadProgramRegistry} from '../packages/postgres/didi-registry.js';

test('shared DiDi readonly initialization and canonical projection preserve the real SQLite facade through awaited storage',async()=>{
  const source=didiFixture(),stores=[new JobStore(':memory:'),new JobStore(':memory:')];try{
    const program=new DidiAgentProgram(source.binding,{connector:source.connector}),prepared=[];
    for(const [index,store] of stores.entries()){
      const job=new TaskService(store,{catalog:new ExecutionCatalog([program.capability()],[],[],[],[program])}).submit(principal,{goal:'Synthetic supplied place lookup only',requestId:randomUUID()}),request=store.get(owner,job.id).delegation!.request,graph=store.ontologyForJob(owner,job.id),input={mode:'places',city:'北京市',keywords:'北京西站'};
      const storage:GraphStorage={read:async(...args)=>graph.read(...args),readPrivate:async(...args)=>graph.readPrivate(...args),query:async(...args)=>graph.query(...args),related:async(...args)=>graph.related(...args),ingest:async(...args)=>graph.ingest(...args),containsLinks:async(...args)=>graph.containsLinks(...args),relationshipDigest:async(...args)=>graph.relationshipDigest(...args),evidencePropertiesDigest:async(...args)=>graph.evidencePropertiesDigest(...args),tombstone:async(...args)=>graph.tombstone(...args),projectedRelationshipDigest:async(...args)=>graph.projectedRelationshipDigest(...args)};
      const initialized=index?await runGraphProgramAsync(storage,initializeDidiProgram(program,graph,owner,request,input)):program.initialize(graph,owner,request,input);
      const actionInput={scope:initialized.scope,role:'search',keywords:input.keywords},context:DidiActionProgramContext={graph,owner,request,state:{version:'1',programRef:program.ref,programDigest:program.configurationDigest,scope:initialized.scope,input,requestRevision:request.revision,plans:[],observations:[],feedback:[]},planId:'synthetic-plan',intentId:'synthetic-intent',attemptId:'synthetic-attempt',modelRunId:'synthetic-model'};
      const call={tool:'maps_textsearch' as const,args:{city:input.city,keywords:input.keywords}},raw=await source.connector.invoke(didiCallContext(program,context,'SearchDidiPlaces',actionInput),call.tool,call.args,AbortSignal.timeout(5000));
      const response=buildDidiReadResult(program,context,'SearchDidiPlaces',actionInput,call,raw),object=index?await runGraphProgramAsync(storage,projectRideEstimateProgram(graph,owner,response.value)):program.project({...context,graph},'SearchDidiPlaces',actionInput,response);
      const observation=graph.read(owner,object);assert.equal(observation.ref.type,'DidiPlaceObservation');const links=graph.related(owner,object,'sourceReceipts',{remaining:1000});assert.equal(links?.length,1);
      const sourceReceipt=links![0]!;assert.equal(sourceReceipt.properties.evidenceLevel,'synthetic');assert.equal((sourceReceipt.properties.subjects as unknown[]).length,3,'Observation plus both real canonical place facts are independently sealed');
      prepared.push({places:(observation.properties.snapshot as any).data.places.length,sourceTypes:graph.query(owner,{type:'Place',limit:50}).items.map(value=>value.ref.type),noBusinessWrites:(observation.properties.snapshot as any).noBusinessWrites});
    }
    assert.deepEqual(prepared[0],prepared[1]);assert(source.calls.filter(call=>call.method==='tools/call').every(call=>call.name==='maps_textsearch'));assert(!source.calls.some(call=>call.name==='taxi_create_order'));
  }finally{for(const store of stores)store.close();source.close();}
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
    const authority={id:randomUUID(),gatewayOrigin:'https://primary.synthetic.example'},options={database,policyDigest,authorityId:authority.id,gatewayOrigin:authority.gatewayOrigin},relay=new PostgresTaskRelay({...options,didiAccount:account});
    const registration={binding:source.binding,owner,account,kind:'relay' as const,reads:relay.reads,peerId:'agent_'+'A'.repeat(43),authority};
    assert.equal(relay.reads.didiAccount,account);const registry=new PostgresReadProgramRegistry(policyDigest,{documentEnabled:false,didi:registration});assert.equal(registry.entries[0]!.didi!.account,account);
    assert.throws(()=>new PostgresReadProgramRegistry(policyDigest,{didi:{...registration,reads:new PostgresRelayReadAuthority(options)}}),/same current account/);
    assert.throws(()=>new PostgresReadProgramRegistry(policyDigest,{didi:{...registration,account:other}}),/same current account/);
    descriptor={...descriptor,revision:descriptor.revision+1};assert.equal(registry.entries[0]!.program.permitted(owner),false);assert.throws(()=>account.assertBinding(source.binding,owner));assert.equal(source.calls.length,0);
  }finally{source.close();}
});
