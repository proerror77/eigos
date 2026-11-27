import { restaurantServices } from '../packages/ontology/restaurant-services.js';
import { amapObservationDefinition } from '../packages/ontology/amap-observations.js';
import { tableCheckReservations } from '../packages/ontology/tablecheck-reservations.js';
import { bookWithEndpoints, bookWithEndpointsFunction, estimateWithEndpoints, immediateRideRouteLink,
  prepareWithEndpoints, ridePersonalPlaceLinks } from '../packages/ontology/didi-ride-endpoints.js';
import { localDeliveryProviders } from '../packages/ontology/local-delivery.js';
import { localDeliveryTradeDefinition } from '../packages/ontology/local-delivery-trade.js';
import { localDeliveryDefinition } from '../packages/ontology/local-delivery.js';
import { personalPlaceDefinition } from '../packages/ontology/personal-places.js';
import { scheduleJourneyDefinition } from '../packages/ontology/schedule-journey.js';
import { itineraryDefinition } from '../packages/ontology/itinerary-continuity.js';
import { executeHotelDependentTrip, tripHotelDependencyDefinition } from '../packages/ontology/trip-hotel-dependency.js';
import { travelHandoffDefinition } from '../packages/ontology/travel-handoff.js';
import { ingestMachineryHistory } from '../packages/runtime/machinery-history.js';
import { ontologyServices } from '../packages/runtime/services.js';
import { MachineryReviews, machineryReviewSchema } from '../packages/runtime/machinery-reviews.js';
import { ScenarioEvaluations } from '../packages/runtime/scenario-evaluation.js';
import { analyzeMachinery, machineryAnalysisSchema } from '../packages/runtime/machinery-analysis.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { digest } from '../packages/core/identity.js';
import { OntologyClient } from '../packages/sdk/client.js';
import type { AgentDriver } from '../packages/runtime/agent.js';
import { PARequests } from '../packages/runtime/pa.js';
import { publicTask, type Task } from '../packages/runtime/tasks.js';
import { HotelWorkflows } from '../packages/capabilities/services/hotel-workflows.js';
import { calendarAnswer, planningInput } from './planning-fixture.js';
import { serviceProvider } from './service-fixture.js';
import { document, fixture, principal } from './fixture.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { Actions } from '../packages/runtime/actions.js';
import { initializeActionUndo } from '../packages/runtime/action-journal.js';
import { Scenarios, initializeScenarioLifecycle } from '../packages/runtime/scenarios.js';
import { decisionEvidenceSchema } from '../packages/runtime/decision-evidence.js';
import { ExecutionTrace } from '../packages/runtime/execution-trace.js';
import { Automation, initializeAutomation } from '../packages/runtime/automation.js';
import { Objects } from '../packages/runtime/objects.js';
import { ObjectSets } from '../packages/runtime/object-sets.js';
import { objectPolicySchema } from '../packages/runtime/security.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { Ontology } from '../packages/ontology/model.js';
import { addProcessLogs, processLogTarget } from '../packages/ontology/process-definition.js';
import { bookImmediateRideAction, immediateOrderLink, immediateRideInterface, immediateRideType } from '../packages/ontology/didi-immediate-ride.js';
import { didiReadDefinitions } from '../packages/ontology/didi-reads.js';
import { didiOrderDefinitions } from '../packages/ontology/travel.js';
import { calendarJourneyDefinition } from '../packages/ontology/calendar-journey.js';
import { deliveryFunctions } from '../packages/ontology/delivery.js';
import { dianpingResearchFunctions } from '../packages/ontology/dianping.js';
import { diningReservations } from '../packages/ontology/dining-reservations.js';
import { petRideDefinition } from '../packages/ontology/pet-ride.js';
import { documentDefinition } from '../packages/ontology/documents.js';
import { fliggyFlightBookingDefinition } from '../packages/ontology/fliggy-flight-booking.js';
import { fliggyHotelDefinition } from '../packages/ontology/fliggy-hotel.js';
import { hotelTransferDefinition } from '../packages/ontology/hotel-transfer-decisions.js';
import { flightDefinition } from '../packages/ontology/flight.js';
import { flightPositionFunction } from '../packages/ontology/flight-position.js';
import { locationFunctions, taskLocationValueType } from '../packages/ontology/location.js';
import { luckinDefinition } from '../packages/ontology/luckin.js';
import { mapFunctions } from '../packages/ontology/maps.js';
import { rideWatchDefinition, rideWatchType } from '../packages/ontology/ride-watch.js';
import { fliggyServicesDefinition, marketplaceDefinition } from '../packages/ontology/services.js';
import { checkWorkflowDependencies } from '../packages/runtime/workflow-compatibility.js';
import { setTimeout as delay } from 'node:timers/promises';
import { dispatchAutomation } from '../apps/indexer/dispatch.js';

async function setup() {
  const f=await fixture();await initializeActionUndo(f.db);await initializeScenarioLifecycle(f.db);await initializeAutomation(f.db);
  const document=structuredClone(f.model.document);
  document.actionTypes.push({apiName:'CopyRoute',description:'Copy an authorized route name into a new Route',parameters:{type:'object',properties:{id:{type:'string'},name:{type:'string'},tag:{type:'string',default:'copied'}},required:['id','name'],additionalProperties:false},objectParameters:{},submissionCriteria:[],rules:[{op:'createObject',object:{type:'Route',id:{parameter:'id'}},properties:{id:{parameter:'id'},name:{parameter:'name'}}}],result:{type:'Route',id:{parameter:'id'}}});
  document.actionTypes.push({apiName:'RenameRoute',description:'Rename the selected route',parameters:{type:'object',properties:{route:{type:'object',properties:{type:{type:'string'},id:{type:'string'}},required:['type','id'],additionalProperties:false},revision:{type:'integer'},name:{type:'string'}},required:['route','revision','name'],additionalProperties:false},objectParameters:{route:'Route'},submissionCriteria:[],rules:[{op:'editObject',object:{parameter:'route'},expectedRevision:{parameter:'revision'},properties:{name:{parameter:'name'}}}],result:{type:'Route',id:{parameter:'route',path:['id']}}});
  const model=await f.metadata.publish(document,f.capabilities,f.publisher);await setGrants(f.db,principal.owner,businessGrants(model));
  const access=await Access.load(f.db,principal),objects=new Objects(f.db,model,access),actions=new Actions(f.db,f.capabilities.functions),automation=new Automation(f.db,f.metadata,actions);
  const source={type:'Route',id:'source'};await objects.create(source,{id:source.id,name:'original'});
  const steps=[{name:'Copy',action:'CopyRoute',input:{id:{property:'name'},name:{literal:'Copied'}}}];
  const workflow=await automation.workflow(access,model,{name:'Copy route',steps});
  return {...f,model,access,objects,actions,automation,source,workflow,steps};
}

test('workflow submission and concurrent workers preserve a single authorized Action per step',async()=>{
  const f=await setup();try{
    const input={workflow:f.workflow.id,object:f.source,requestId:'once'};
    const run=await f.automation.run(f.access,f.model,input);
    assert.equal((await f.automation.run(f.access,f.model,input)).id,run.id);
    const results=await Promise.all([f.automation.runOne(),f.automation.runOne()]);assert.deepEqual(results.sort(),[false,true]);
    const rows=(await f.db.query(`SELECT * FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows;
    assert.equal(rows[0]!.state,'completed');assert.equal(rows[0]!.step,1);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.actions WHERE request_id=$1`,['workflow:'+run.id+':0'])).rows[0]!.count,1);
    assert.equal((await f.automation.list(await Access.load(f.db,principal),f.model,'workflow_runs')).items.length,1);
  }finally{await f.close();}
});

test('a workflow run logs its claim, queue time, stages and database profile under one attempt',async t=>{
  const f=await setup();try{
    const run=await f.automation.run(f.access,f.model,{workflow:f.workflow.id,object:f.source,requestId:'profiled-run'});
    const logger=t.mock.method(console,'info',(_line:string)=>{});
    assert.equal(await f.automation.runOne(),true);
    const records=logger.mock.calls.map(call=>JSON.parse(call.arguments[0]));
    const claim=records.find(row=>row.event==='workflow_claim'),finish=records.find(row=>row.event==='workflow_finish');
    assert.equal(claim.workflowRunId,run.id);assert.equal(finish.workflowRunId,run.id);assert.equal(finish.attemptId,claim.attemptId);
    assert.equal(claim.queuedMs,Date.parse(claim.claimedAt)-Date.parse(claim.runAvailableAt));
    assert(Number.isFinite(Date.parse(claim.runCreatedAt)));
    assert(finish.durationMs>=0&&finish.db.statements>0&&finish.db.editLockHoldMs>=0);
    const stages=records.filter(row=>row.event==='stage_timing');
    assert(stages.some(row=>row.stage==='action_apply'&&row.operation==='CopyRoute'&&row.db.statements>0));
    assert(stages.every(row=>row.workflowRunId===run.id&&row.attemptId===claim.attemptId));
  }finally{await f.close();}
});

test('retry after committed Action and before checkpoint uses its frozen validated input',async()=>{
  const f=await setup();try{
    class CrashAfterCommit extends Actions {
      crash=true;
      override async apply(...args:Parameters<Actions['apply']>) {
        const result=await super.apply(...args);
        if(this.crash){this.crash=false;throw new Error('Synthetic process failure after commit');}
        return result;
      }
    }
    const automation=new Automation(f.db,f.metadata,new CrashAfterCommit(f.db,f.capabilities.functions));
    const run=await automation.run(f.access,f.model,{workflow:f.workflow.id,object:f.source,requestId:'crash'});
    await automation.runOne();
    const failed=(await f.db.query(`SELECT state,step FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows[0]!;
    assert.equal(failed.state,'failed');assert.equal(failed.step,0);
    const frozen=(await f.db.query(`SELECT input FROM ${f.db.schema}.workflow_steps WHERE run_id=$1`,[run.id])).rows[0]!.input;
    assert.deepEqual(frozen,{id:'original',name:'Copied',tag:'copied'});
    // A committed legacy receipt can finish checkpoint recovery without re-executing frozen inputs.
    await f.db.query(`UPDATE ${f.db.schema}.workflow_steps SET read_markings=NULL WHERE run_id=$1`,[run.id]);
    await f.objects.edit(f.source,1,{name:'changed-after-commit'});
    await automation.retry(await Access.load(f.db,principal),f.model,run.id);await automation.runOne();
    const completed=(await f.db.query(`SELECT state,step,results FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows[0]!;
    assert.equal(completed.state,'completed');assert.equal(completed.step,1);assert.equal(completed.results[0].object.id,'original');
    await assert.rejects(f.objects.read({type:'Route',id:'changed-after-commit'}),/unavailable/);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.actions WHERE request_id=$1`,['workflow:'+run.id+':0'])).rows[0]!.count,1);
  }finally{await f.close();}
});

async function markedSetup() {
  const f=await setup(),document=structuredClone(f.model.document);
  document.objectTypes.find(type=>type.apiName==='Route')!.properties.labels={description:'Security markings',schema:{type:'array',items:{type:'string'}},required:false};
  document.actionTypes.push({apiName:'CopyMarkedRoute',description:'Copy with input security markings',parameters:{type:'object',properties:{id:{type:'string'},name:{type:'string'},labels:{type:'array',items:{type:'string'}}},required:['id','name','labels'],additionalProperties:false},objectParameters:{},submissionCriteria:[],rules:[{op:'createObject',object:{type:'Route',id:{parameter:'id'}},properties:{id:{parameter:'id'},name:{parameter:'name'},labels:{parameter:'labels'}}}],result:{type:'Route',id:{parameter:'id'}}});
  const model=await f.metadata.publish(document,f.capabilities,f.publisher);
  await setGrants(f.db,principal.owner,businessGrants(model));
  await f.db.query(`INSERT INTO ${f.db.schema}.object_policies(ontology,type,policy) VALUES('Eigos','Route',$1)`,[objectPolicySchema.parse({markingsProperty:'labels'})]);
  await f.db.query(`INSERT INTO ${f.db.schema}.security_memberships(subject,kind,name) VALUES($1,'marking','Secret')`,[principal.owner]);
  const access=await Access.load(f.db,principal),objects=new Objects(f.db,model,access),actions=new Actions(f.db,f.capabilities.functions),automation=new Automation(f.db,f.metadata,actions);
  await objects.edit(f.source,1,{name:'Classified payload',labels:['Secret']});
  return {...f,model,access,objects,actions,automation};
}

test('unchanged frozen retries preserve original input markings even after source markings change',async()=>{
  const f=await markedSetup();try{
    const workflow=await f.automation.workflow(f.access,f.model,{name:'Reject declassification',steps:[{name:'Copy',action:'CopyRoute',input:{id:{literal:'unmarked-output'},name:{property:'name'}}}]});
    const run=await f.automation.run(f.access,f.model,{workflow:workflow.id,object:f.source,requestId:'marked-retry'});
    const state=async()=>(await f.db.query(`SELECT state FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows[0]!.state;
    await f.automation.runOne();assert.equal(await state(),'failed');
    const original=(await f.db.query(`SELECT input,requirements,read_markings FROM ${f.db.schema}.workflow_steps WHERE run_id=$1`,[run.id])).rows[0]!;
    assert.deepEqual(original.read_markings,['Secret']);assert(original.requirements.some((requirement:any)=>requirement.row?.id===f.source.id));
    await f.automation.retry(await Access.load(f.db,principal),f.model,run.id);await f.automation.runOne();assert.equal(await state(),'failed');
    await f.db.query(`UPDATE ${f.db.schema}.objects SET properties=jsonb_set(properties,'{labels}','[]') WHERE projection=$1 AND owner=$2 AND type='Route' AND id=$3`,[f.model.projection,principal.owner,f.source.id]);
    await f.automation.retry(await Access.load(f.db,principal),f.model,run.id);await f.automation.runOne();assert.equal(await state(),'failed');
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.objects WHERE projection=$1 AND owner=$2 AND id='unmarked-output'`,[f.model.projection,principal.owner])).rows[0]!.n,0);
    const after=(await f.db.query(`SELECT input,requirements,read_markings FROM ${f.db.schema}.workflow_steps WHERE run_id=$1`,[run.id])).rows[0]!;
    assert.deepEqual(after,original);
  }finally{await f.close();}
});

test('retry preserves frozen values and source dependencies for a correctly marked output',async()=>{
  const f=await markedSetup();try{
    class FailBeforeApply extends Actions {
      failed=false;
      override async apply(...args:Parameters<Actions['apply']>){if(!this.failed){this.failed=true;throw new Error('Synthetic interruption before Action');}return super.apply(...args);}
    }
    const automation=new Automation(f.db,f.metadata,new FailBeforeApply(f.db,f.capabilities.functions));
    const workflow=await automation.workflow(f.access,f.model,{name:'Preserve marked values',steps:[{name:'Copy',action:'CopyMarkedRoute',input:{id:{literal:'marked-output'},name:{property:'name'},labels:{property:'labels'}}}]});
    const run=await automation.run(f.access,f.model,{workflow:workflow.id,object:f.source,requestId:'safe-marked-retry'});await automation.runOne();
    await f.db.query(`UPDATE ${f.db.schema}.objects SET properties=jsonb_set(properties,'{name}','"New source value"') WHERE projection=$1 AND owner=$2 AND type='Route' AND id=$3`,[f.model.projection,principal.owner,f.source.id]);
    await automation.retry(await Access.load(f.db,principal),f.model,run.id);await automation.runOne();
    assert.equal((await f.db.query(`SELECT state FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows[0]!.state,'completed');
    const output=await new Objects(f.db,f.model,await Access.load(f.db,principal)).read({type:'Route',id:'marked-output'});
    assert.equal(output.properties.name,'Classified payload');assert.deepEqual(output.properties.labels,['Secret']);
    const receipt=(await f.db.query(`SELECT requirements,read_markings FROM ${f.db.schema}.workflow_steps WHERE run_id=$1`,[run.id])).rows[0]!;
    assert(receipt.requirements.some((requirement:any)=>requirement.row?.id===f.source.id));assert.deepEqual(receipt.read_markings,['Secret']);
    await f.db.query(`DELETE FROM ${f.db.schema}.security_memberships WHERE subject=$1 AND kind='marking'`,[principal.owner]);
    await assert.rejects(new Objects(f.db,f.model,await Access.load(f.db,principal)).read({type:'Route',id:'marked-output'}),/denied/);
  }finally{await f.close();}
});

test('current source row authorization is rechecked after input freezing and before Action edits',async()=>{
  const f=await setup();try{
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies(ontology,type,policy) VALUES('Eigos','Route',$1)`,[objectPolicySchema.parse({read:{any:[{op:'equals',property:'name',value:'original'},{op:'equals',property:'name',value:'Copied'}]}})]);
    class RevokeBeforeApply extends Actions {
      override async apply(...args:Parameters<Actions['apply']>){
        await f.db.query(`UPDATE ${f.db.schema}.objects SET properties=jsonb_set(properties,'{name}','"revoked"') WHERE projection=$1 AND owner=$2 AND type='Route' AND id=$3`,[f.model.projection,principal.owner,f.source.id]);
        return super.apply(...args);
      }
    }
    const automation=new Automation(f.db,f.metadata,new RevokeBeforeApply(f.db,f.capabilities.functions));
    const run=await automation.run(await Access.load(f.db,principal),f.model,{workflow:f.workflow.id,object:f.source,requestId:'revoke-before-edit'});await automation.runOne();
    assert.equal((await f.db.query(`SELECT state FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows[0]!.state,'failed');
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.objects WHERE projection=$1 AND owner=$2 AND id='original'`,[f.model.projection,principal.owner])).rows[0]!.n,0);
  }finally{await f.close();}
});

test('a workflow can merge a Scenario and continue using its committed surviving object',async()=>{
  const f=await setup();try{
    const document=structuredClone(f.model.document),object={type:'object',properties:{type:{type:'string'},id:{type:'string'}},required:['type','id'],additionalProperties:false};
    const parameters={type:'object',properties:{route:object,scenarioId:{type:'string'},revision:{type:'integer'}},required:['route','scenarioId','revision'],additionalProperties:false};
    const definition={apiName:'mergeInspectedRoute',description:'Validate the proposed object before merging',version:'1',edits:true,parameters,returns:object};
    const capabilities=createCapabilities(f.db,async()=>f.provider.source,{functions:[{definition,implementationId:'merge-inspected-route-v1',handler:async(input,context)=>context.edit!(input.route as ObjectRef,async graph=>{
      await new Scenarios(f.db).mergeInto(graph,String(input.scenarioId),Number(input.revision),{objects:['Route'],links:[],validate:async view=>{await view.read(input.route as ObjectRef);}});
    })}]});
    document.functionTypes.push(definition);
    document.actionTypes.push({apiName:'MergeRouteScenario',description:'Merge a reviewed Route scenario',parameters,objectParameters:{route:'Route'},submissionCriteria:[],function:'mergeInspectedRoute'});
    const model=await f.metadata.publish(document,capabilities,f.publisher);await setGrants(f.db,principal.owner,businessGrants(model));
    const access=await Access.load(f.db,principal),scenarios=new Scenarios(f.db),scene=await scenarios.create(access,model,{requestId:'workflow-scenario',name:'Workflow scenario'}),view=await scenarios.view(access,model,scene.id);
    await new Objects(f.db,view,access).edit(f.source,1,{name:'Merged route'});
    const inspected=await scenarios.inspect(access,model,scene.id),automation=new Automation(f.db,f.metadata,new Actions(f.db,capabilities.functions));
    const workflow=await automation.workflow(access,model,{name:'Merge and rename',steps:[
      {name:'Merge',action:'MergeRouteScenario',input:{route:{object:true},scenarioId:{literal:scene.id},revision:{literal:inspected.revision}}},
      {name:'Rename',action:'RenameRoute',input:{route:{step:'Merge'},revision:{property:'$revision'},name:{literal:'Final route'}}},
    ]});
    const run=await automation.run(access,model,{workflow:workflow.id,object:f.source,requestId:'workflow-merge-chain'});await automation.runOne();
    const state=(await f.db.query(`SELECT state,step FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows[0]!;
    assert.equal(state.state,'completed');assert.equal(state.step,2);
    assert.equal((await new Objects(f.db,model,await Access.load(f.db,principal)).read(f.source)).properties.name,'Final route');
    const requirements=(await f.db.query(`SELECT requirements FROM ${f.db.schema}.workflow_steps WHERE run_id=$1 AND position=0`,[run.id])).rows[0]!.requirements;
    assert(requirements.some((requirement:any)=>requirement.row?.id===f.source.id));assert(requirements.every((requirement:any)=>!requirement.row?.scenario));
  }finally{await f.close();}
});

test('upgraded unfinished frozen inputs without markings fail safely with a diagnostic',async()=>{
  const f=await setup();try{
    class PauseBeforeAction extends Actions {override async apply(..._args:Parameters<Actions['apply']>):Promise<{type:string;id:string}>{throw new Error('Synthetic interruption before Action');}}
    const interrupted=new Automation(f.db,f.metadata,new PauseBeforeAction(f.db,f.capabilities.functions));
    const run=await interrupted.run(f.access,f.model,{workflow:f.workflow.id,object:f.source,requestId:'legacy-frozen'});await interrupted.runOne();
    await f.db.query(`UPDATE ${f.db.schema}.workflow_steps SET read_markings=NULL WHERE run_id=$1`,[run.id]);
    await initializeAutomation(f.db);await initializeAutomation(f.db);
    const resumed=new Automation(f.db,f.metadata,new Actions(f.db,f.capabilities.functions));
    await resumed.retry(await Access.load(f.db,principal),f.model,run.id);await resumed.runOne();
    const state=(await f.db.query(`SELECT state,error FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows[0]!;
    assert.equal(state.state,'failed');assert.match(state.error,/security context.*new workflow run/);
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.actions WHERE request_id=$1`,['workflow:'+run.id+':0'])).rows[0]!.n,0);
  }finally{await f.close();}
});

test('cancellation fences future commits and preserves completed step audit',async()=>{
  const f=await setup();try{
    const workflow=await f.automation.workflow(f.access,f.model,{name:'Two steps',steps:[...f.steps,{name:'Second',action:'CopyRoute',input:{id:{literal:'second'},name:{literal:'Second'}}}]});
    let release!:()=>void,started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{started=resolve;});
    class PausedSecondAction extends Actions {
      override async apply(...args:Parameters<Actions['apply']>) {
        if(args[4].endsWith(':1')){started();await gate;}
        return super.apply(...args);
      }
    }
    const automation=new Automation(f.db,f.metadata,new PausedSecondAction(f.db,f.capabilities.functions));
    const run=await automation.run(f.access,f.model,{workflow:workflow.id,object:f.source,requestId:'cancel'});
    const worker=automation.runOne();await waiting;
    const canceled=await automation.cancel(await Access.load(f.db,principal),f.model,run.id);assert.equal(canceled.step,1);
    release();await worker;
    const row=(await f.db.query(`SELECT state,step,results FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows[0]!;
    assert.equal(row.state,'canceled');assert.equal(row.step,1);assert.equal(row.results.length,1);
    assert.equal((await f.objects.read({type:'Route',id:'original'})).properties.name,'Copied');
    await assert.rejects(f.objects.read({type:'Route',id:'second'}),/unavailable/);
    await assert.rejects(automation.retry(f.access,f.model,run.id),/unavailable/);
  }finally{await f.close();}
});

test('rules preserve original scopes and trigger again after link-driven reentry without object revision changes',async()=>{
  const f=await setup();try{
    const request={type:'RideRequest',id:'request'};
    await f.objects.create(request,{id:request.id,name:'Request',status:'requested',requestedAt:new Date().toISOString()});
    const link={type:'RequestRoute',from:request,to:f.source};await f.objects.link(link);
    const access=await Access.load(f.db,{...principal,scopes:['ontology:write']});
    const rule=await f.automation.rule(access,f.model,{name:'Linked route',workflow:f.workflow.id,query:{type:'Route',from:{object:request,link:'route'}},enabled:true});
    assert.equal(await f.automation.scanOne(),true);assert.equal(await f.automation.scanOne(),false);
    let runs=(await f.db.query(`SELECT scopes FROM ${f.db.schema}.workflow_runs`)).rows;assert.equal(runs.length,1);assert.deepEqual(runs[0]!.scopes,['ontology:write']);
    await f.objects.unlink(link);await f.db.query(`UPDATE ${f.db.schema}.object_rules SET last_scan=NULL WHERE id=$1`,[rule.id]);await f.automation.scanOne();
    await f.objects.link(link);await f.db.query(`UPDATE ${f.db.schema}.object_rules SET last_scan=NULL WHERE id=$1`,[rule.id]);await f.automation.scanOne();
    runs=(await f.db.query(`SELECT scopes FROM ${f.db.schema}.workflow_runs`)).rows;assert.equal(runs.length,2);
    assert.equal((await f.objects.read(f.source)).revision,1);
  }finally{await f.close();}
});

test('a failing rule scan disables the rule and does not leave partial workflow submissions',async()=>{
  const f=await setup();try{
    const rule=await f.automation.rule(f.access,f.model,{name:'All routes',workflow:f.workflow.id,query:{type:'Route'},enabled:true});
    await setGrants(f.db,principal.owner,businessGrants(f.model).filter(grant=>grant.permission!=='view_objects'));
    assert.equal(await f.automation.scanOne(),true);
    const row=(await f.db.query(`SELECT enabled,error,last_scan FROM ${f.db.schema}.object_rules WHERE id=$1`,[rule.id])).rows[0]!;
    assert.equal(row.enabled,false);assert.match(row.error,/scan failed/);assert(row.last_scan);
    assert.equal(await f.automation.scanOne(),false);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.workflow_runs`)).rows[0]!.count,0);
  }finally{await f.close();}
});

async function processSetup(withDependentRoute = false) {
  const f = await setup();
  try {
    const definition = structuredClone(f.model.document);
    const state = {type:'string', enum:['open','stalled','done']};
    definition.objectTypes.find(type=>type.apiName==='Route')!.properties.state = {
      description:'Synthetic route processing state', schema:state, required:false,
    };
    addProcessLogs(definition, [{type:'Route', property:'state'}]);
    const object = {type:'object', properties:{type:{type:'string'},id:{type:'string'}}, required:['type','id'], additionalProperties:false};
    definition.actionTypes.push({
      apiName:'ChangeRouteState', description:'Commit a synthetic process transition',
      parameters:{type:'object',properties:{route:object,revision:{type:'integer'},state},required:['route','revision','state'],additionalProperties:false},
      objectParameters:{route:'Route'}, submissionCriteria:[],
      rules:[{op:'editObject',object:{parameter:'route'},expectedRevision:{parameter:'revision'},properties:{state:{parameter:'state'}}}],
      result:{type:'Route',id:{parameter:'route',path:['id']}},
    });
    if (withDependentRoute) {
      definition.linkTypes.push({
        apiName: 'SyntheticRouteDependency', description: 'Fixture route dependency',
        from: { type: 'Route', name: 'impactedRoutes', cardinality: 'many' },
        to: { type: 'Route', name: 'upstreamRoutes', cardinality: 'many' },
      });
      const rename = structuredClone(definition.actionTypes.find(action => action.apiName === 'RenameRoute')!);
      rename.apiName = 'ReviewDependentRoute';
      rename.parameters = {
        type: 'object', additionalProperties: false, required: ['route', 'revision', 'name', 'upstream', 'transition'],
        properties: { ...(rename.parameters.properties as object), upstream: object, transition: object },
      };
      rename.objectParameters = { ...rename.objectParameters, upstream: 'Route', transition: 'RouteStateLog' };
      definition.actionTypes.push(rename);
    }
    const model = await f.metadata.publish(definition, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const access = await Access.load(f.db, principal);
    const graph = new Objects(f.db, model, access);
    const change = async (state:string) => f.actions.apply(await Access.load(f.db, principal), model, 'ChangeRouteState',
      {route:f.source, revision:(await graph.read(f.source)).revision, state}, randomUUID());
    const runs = async () => (await f.db.query(`SELECT id,state,process_trigger,request_id FROM ${f.db.schema}.workflow_runs ORDER BY available_at`)).rows;
    return {...f, model, access, graph, change, runs};
  } catch (error) {
    await f.close();
    throw error;
  }
}

test('a second published process and Action reuse related dispatch and invalidate an unlinked run', async () => {
  const f = await processSetup(true);
  try {
    const target = { type: 'Route', id: 'dependent' };
    await f.graph.create(target, { id: target.id, name: 'To review' });
    const dependency = { type: 'SyntheticRouteDependency', from: f.source, to: target };
    await f.graph.link(dependency);
    const related = { path: ['impactedRoutes'], sourceParameter: 'upstream', transitionParameter: 'transition', targetParameter: 'route' };
    const rule = await f.automation.rule(f.access, f.model, {
      name: 'Review dependent route', enabled: true,
      process: { type: 'RouteStateLog', to: 'stalled' },
      effect: { action: 'ReviewDependentRoute', related, input: {
        revision: { property: '$revision' }, name: { literal: 'Reviewed from a route transition' },
      } },
    });
    await f.change('stalled');
    assert.equal(await f.automation.scanOne(), true);
    await f.graph.unlink(dependency);
    assert.equal(await f.automation.runOne(), true);
    assert.equal((await f.graph.read(target)).properties.name, 'To review');
    assert.equal((await f.runs())[0]!.state, 'canceled');
    await f.graph.link(dependency);
    await f.automation.rule(f.access, f.model, { ...rule, replayFrom: '0' });
    assert.equal(await f.automation.scanOne(), true);
    assert.equal(await f.automation.runOne(), true);
    assert.equal((await f.graph.read(target)).properties.name, 'Reviewed from a route transition');
    assert.equal((await f.graph.read(f.source)).properties.name, 'original');
  } finally {
    await f.close();
  }
});

test('a related process rule replays from a committed history sequence without repeating earlier transitions', async () => {
  const f = await processSetup(true);
  try {
    const target = { type: 'Route', id: 'dependent' };
    await f.graph.create(target, { id: target.id, name: 'To review' });
    await f.graph.link({ type: 'SyntheticRouteDependency', from: f.source, to: target });
    const related = { path: ['impactedRoutes'], sourceParameter: 'upstream', transitionParameter: 'transition', targetParameter: 'route' };
    const rule = await f.automation.rule(f.access, f.model, {
      name: 'Review each stall', enabled: true, process: { type: 'RouteStateLog', to: 'stalled' },
      effect: { action: 'ReviewDependentRoute', related, input: { revision: { property: '$revision' }, name: { literal: 'Reviewed' } } },
    });
    await f.change('stalled'); await f.change('open'); await f.change('stalled');
    assert.equal(await f.automation.scanOne(), true);
    const first = (await f.runs()).map(row => String(row.process_trigger.sequence));
    assert.equal(first.length, 2);
    const replay = await f.automation.rule(f.access, f.model, { ...rule, replayFrom: first[0] });
    assert.equal(await f.automation.scanOne(), true);
    const replayed = (await f.runs()).filter(row => row.process_trigger.revision === replay.revision);
    assert.deepEqual(replayed.map(row => String(row.process_trigger.sequence)), [first[1]]);
  } finally { await f.close(); }
});

test('process rules deliver each committed matching transition between polls and replay checkpoints without duplicates',async()=>{
  const f = await processSetup();
  try {
    await f.change('open');
    await f.change('stalled');
    await f.change('open');
    const rule = await f.automation.rule(f.access, f.model, {name:'Each stall',workflow:f.workflow.id,
      process:{type:'RouteStateLog',from:'open',to:'stalled'},enabled:true});
    const initial = (await f.db.query(`SELECT process_commit::text,process_cursor::text FROM ${f.db.schema}.object_rules WHERE id=$1`, [rule.id])).rows[0]!;
    await f.change('stalled');
    await f.change('open');
    await f.change('stalled');
    await f.change('done');
    assert.deepEqual((await Promise.all([f.automation.scanOne(),f.automation.scanOne()])).sort(), [false,true]);
    const first = await f.runs();
    assert.equal(first.length, 2);
    assert.notEqual(first[0]!.process_trigger.sequence, first[1]!.process_trigger.sequence);
    assert(first.every(row=>row.request_id.startsWith('process-rule:')));
    await f.db.query(`UPDATE ${f.db.schema}.object_rules SET process_commit=$2,process_cursor=$3,last_scan=NULL WHERE id=$1`,
      [rule.id,initial.process_commit,initial.process_cursor]);
    assert.equal(await f.automation.scanOne(), true);
    assert.deepEqual(await f.runs(), first);
    assert.equal(await f.automation.runOne(), true);
    assert.equal(await f.automation.runOne(), true);
    assert.deepEqual((await f.runs()).map(row=>row.state), ['completed','completed']);
    assert.equal(await f.automation.runOne(), false);
  } finally { await f.close(); }
});

test('a process scan consumes committed transitions in commit order without waiting for open commits',async()=>{
  const f=await processSetup();
  try{
    const rule=await f.automation.rule(f.access,f.model,{name:'Every stall',workflow:f.workflow.id,process:{type:'RouteStateLog',to:'stalled'},enabled:true});
    const other={type:'Route',id:'second-route'};await f.graph.create(other,{id:other.id,name:'Second'});
    const targets=async()=>(await f.db.query(`SELECT object_ref->>'id' AS id FROM ${f.db.schema}.workflow_runs ORDER BY created_at`)).rows.map(row=>row.id);
    let release!:()=>void,entered!:()=>void,calls=0;
    const released=new Promise<void>(resolve=>{release=resolve;}),inside=new Promise<void>(resolve=>{entered=resolve;});
    // The held commit writes its history row first and commits last.
    const held=f.actions.apply(await Access.load(f.db,principal),f.model,'ChangeRouteState',
      {route:f.source,revision:(await f.graph.read(f.source)).revision,state:'stalled'},'held-transition',
      async()=>{if(++calls===2){entered();await released;}});
    try{
      await inside;
      await f.actions.apply(await Access.load(f.db,principal),f.model,'ChangeRouteState',{route:other,revision:1,state:'stalled'},'later-transition');
      const started=performance.now();
      assert.equal(await f.automation.scanOne(),true);
      assert(performance.now()-started<1500,'the scan must not wait for the open commit');
      assert.deepEqual(await targets(),[other.id]);
    }finally{release();await held;}
    await f.db.query(`UPDATE ${f.db.schema}.object_rules SET last_scan=NULL WHERE id=$1`,[rule.id]);
    assert.equal(await f.automation.scanOne(),true);
    assert.deepEqual(await targets(),[other.id,f.source.id],'the earlier-written, later-committed transition is still consumed');
    await f.db.query(`UPDATE ${f.db.schema}.object_rules SET last_scan=NULL WHERE id=$1`,[rule.id]);
    await f.automation.scanOne();
    assert.equal((await targets()).length,2,'no transition is consumed twice');
  }finally{await f.close();}
});

test('a process rule finishes pre-upgrade history by sequence before commit-ordered history',async()=>{
  const f=await processSetup();
  try{
    await f.change('stalled');await f.change('open');
    // History written before the commit journal existed has no transaction identity and ends at the recorded boundary.
    await f.db.query(`UPDATE ${f.db.schema}.edit_history SET xact=NULL`);
    await f.db.query(`UPDATE ${f.db.schema}.change_journal SET legacy_end=(SELECT max(sequence) FROM ${f.db.schema}.edit_history)`);
    const rule=await f.automation.rule(f.access,f.model,{name:'Replayed stalls',workflow:f.workflow.id,process:{type:'RouteStateLog',to:'stalled'},enabled:true});
    // A rule saved before that history was written still has to consume it.
    await f.db.query(`UPDATE ${f.db.schema}.object_rules SET process_commit=0,process_cursor=0 WHERE id=$1`,[rule.id]);
    await f.change('stalled');
    assert.equal(await f.automation.scanOne(),true);
    const triggers=(await f.runs()).map(row=>Number(row.process_trigger.sequence));
    assert.equal(triggers.length,2);
    assert(triggers[0]!<triggers[1]!,'the legacy transition comes first');
    await f.db.query(`UPDATE ${f.db.schema}.object_rules SET last_scan=NULL WHERE id=$1`,[rule.id]);
    await f.automation.scanOne();
    assert.equal((await f.runs()).length,2);
  }finally{await f.close();}
});

test('process dwell starts only for the latest uninterrupted state and reports recorded duration', async () => {
  const f = await processSetup();
  try {
    await f.change('open');
    await f.automation.rule(f.access, f.model, {name:'Long stall',workflow:f.workflow.id,
      process:{type:'RouteStateLog',to:'stalled',dwellSeconds:3600},enabled:true});
    await f.change('stalled');
    await f.change('open');
    await f.change('stalled');
    await f.automation.scanOne();
    const [first, latest] = await f.runs();
    assert(first && latest);
    assert.equal(await f.automation.runOne(), false);
    const status = await f.automation.processStatus(f.access, f.model, {type:'RouteStateLog',object:f.source});
    assert.equal(status.state, 'stalled');
    assert.equal(status.transition?.id, latest.process_trigger.sequence.padStart(20, '0'));
    assert.notEqual(status.recordedDurationSeconds, null);
    assert(Date.parse(status.asOf) >= Date.parse(status.recordedAt!));
    await f.db.query(`UPDATE ${f.db.schema}.workflow_runs SET available_at=available_at-interval '2 hours'`);
    assert.equal(await f.automation.runOne(), true);
    assert.equal(await f.automation.runOne(), true);
    assert.deepEqual((await f.runs()).map(row=>row.state), ['canceled','completed']);
  } finally { await f.close(); }
});

test('Machinery reconstructs repeated paths, measures dwell and excludes a case with hidden history', async () => {
  const f = await processSetup();
  try {
    const now = Date.now();
    const iso = (minutes: number) => new Date(now + minutes * 60000).toISOString();
    for (const state of ['open', 'stalled', 'open', 'stalled', 'done']) await f.change(state);
    const logs = await f.graph.query({ type: 'RouteStateLog' });
    for (const [index, log] of logs.items.entries()) {
      await f.db.query(`UPDATE ${f.db.schema}.edit_history SET happened_at=$1 WHERE sequence=$2`,
        [iso([-40, -39, -34, -32, -12][index]!), log.properties.sequence]);
    }
    const input = machineryAnalysisSchema.parse({
      type: 'RouteStateLog', from: iso(-45), to: iso(-1), object: f.source,
      reference: {
        states: [{ name: 'open' }, { name: 'stalled', dwellSeconds: 600 }, { name: 'done' }],
        transitions: [{ from: null, to: 'open' }, { from: 'open', to: 'stalled' }, { from: 'stalled', to: 'done' }],
      },
    });
    const inspect = async (query = input) => analyzeMachinery(f.db, await Access.load(f.db, principal), f.model, query);
    const result = await inspect();
    assert.equal(result.casesTotal, 1);
    assert.deepEqual(result.cases[0]?.states, ['open', 'stalled', 'open', 'stalled', 'done']);
    assert.equal(result.conformance.deviation, 1);
    assert.deepEqual(result.mined.transitions.map(({ from, to }) => [from, to]), [['stalled', 'open']]);
    const stalled = result.states.find(row => row.name === 'stalled')!;
    assert.equal(stalled.historical.totalMs, 25 * 60000);
    assert.equal(stalled.historical.p95Ms, 20 * 60000);
    assert.equal(stalled.breaches, 1);
    assert.equal(result.transitions.find(edge => edge.from === 'open')?.count, 2);
    assert.equal(result.cases[0]?.timeline?.[4]?.action, 'ChangeRouteState');
    const compared = await inspect({ ...input, candidate: {
      ...input.reference!, transitions: [...input.reference!.transitions, { from: 'stalled', to: 'open' }],
    } });
    assert.equal(compared.comparison?.baseline.deviation, 1);
    assert.equal(compared.comparison?.candidate.conforming, 1);
    assert.equal(compared.comparison?.evidence, 'observed-transitions');
    const narrow = await inspect({ ...input, from: iso(-38) });
    assert.equal(narrow.cases[0]?.partial, true);
    assert.equal(narrow.states.find(row => row.name === 'stalled')?.historical.totalMs, 25 * 60000);

    const lastSequence = logs.items.at(-1)!.properties.sequence;
    await f.db.query(`UPDATE ${f.db.schema}.edit_history SET observed_at=$1 WHERE sequence=$2`, [iso(-27), lastSequence]);
    const observed = await inspect({ ...input, durationClock: 'observedAt' });
    assert.equal(observed.states.find(row => row.name === 'stalled')?.historical.totalMs, 10 * 60000);
    assert.equal(observed.cases[0]?.timeline?.at(-1)?.requestId, result.cases[0]?.timeline?.at(-1)?.requestId);

    const set = await new ObjectSets(f.db).save(await Access.load(f.db, principal), f.model, {
      requestId: 'route-analysis-cohort', name: 'Route analysis cohort', mode: 'static',
      set: { op: 'refs', objects: [f.source] },
    });
    const { object: _object, ...cohort } = input;
    assert.equal((await inspect({ ...cohort, setId: set.id })).cases[0]?.object.id, f.source.id);

    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','RouteStateLog',$1)`,
      [objectPolicySchema.parse({ read: { all: [{ op: 'equals', property: 'newState', value: 'done' }] } })]);
    const restricted = await inspect();
    assert.equal(restricted.casesTotal, 0);
    assert.equal(restricted.paths.length, 0);
    assert(restricted.transitions.every(edge => edge.count === 0));
  } finally { await f.close(); }
});

test('Machinery shows its four views, selects processes by state or last transition, and aggregates node and edge metrics', async () => {
  const f = await processSetup();
  try {
    const definition = structuredClone(f.model.document);
    definition.objectTypes.find(type => type.apiName === 'Route')!.properties.distance = {
      description: 'Synthetic distance', schema: { type: 'number' }, required: false,
    };
    definition.objectTypes.find(type => type.apiName === 'RouteStateLog')!.machinery = {
      states: [{ name: 'open' }, { name: 'stalled', dwellSeconds: 600 }, { name: 'done', terminal: true }],
      transitions: [{ from: null, to: 'open' }, { from: 'open', to: 'stalled' }, { from: 'stalled', to: 'done' }],
      metrics: {
        node: { label: 'Distance', aggregation: { op: 'sum', property: 'distance' }, unit: 'km', colors: [{ min: 0, color: 'green' }, { min: 10, color: 'red' }] },
        edge: { label: 'Routes', aggregation: { op: 'count' } },
      },
    };
    const invalid = structuredClone(definition);
    invalid.objectTypes.find(type => type.apiName === 'RouteStateLog')!.machinery!.metrics!.node!.aggregation = { op: 'sum', property: 'name' };
    await assert.rejects(f.metadata.publish(invalid, f.capabilities, f.publisher), /numeric property of the tracked object type/);
    const model = await f.metadata.publish(definition, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const graph = new Objects(f.db, model, await Access.load(f.db, principal));
    const [first, second, third] = ['metric-first', 'metric-second', 'metric-third'].map(id => ({ type: 'Route', id }));
    for (const [ref, distance] of [[first, 4], [second, 6], [third, 12]] as const) await graph.create(ref!, { id: ref!.id, name: ref!.id, distance });
    const move = async (ref: { type: string; id: string }, ...path: string[]) => {
      for (const state of path) await f.actions.apply(await Access.load(f.db, principal), model, 'ChangeRouteState',
        { route: ref, revision: (await graph.read(ref)).revision, state }, randomUUID());
    };
    await move(first!, 'open', 'stalled');
    await move(second!, 'open', 'stalled', 'open');
    await move(third!, 'open', 'stalled', 'done');
    const now = Date.now();
    const analyze = async (input: Record<string, unknown>) => analyzeMachinery(f.db, await Access.load(f.db, principal), model,
      machineryAnalysisSchema.parse({ type: 'RouteStateLog', from: new Date(now - 3600000).toISOString(), to: new Date(now + 60000).toISOString(), ...input }));
    type View = { nodes: { state: string; value: number | null; cases?: number; color?: string }[]; edges: { from: string | null; to: string | null; value: number }[] };
    const nodes = (view: View) => Object.fromEntries(view.nodes.map(node => [node.state, node.value]));
    const edges = (view: View) => Object.fromEntries(view.edges.map(edge => [`${edge.from}>${edge.to}`, edge.value]));

    const ever = (await analyze({ view: { kind: 'count', scope: 'historical' } })).view!;
    assert.deepEqual(nodes(ever), { open: 3, stalled: 3, done: 1 });
    assert.deepEqual(edges(ever), { 'null>open': 3, 'open>stalled': 3, 'stalled>done': 1, 'stalled>open': 1 });
    // Current counts: the state each process is in, and the transition each made last.
    const current = (await analyze({ view: { kind: 'count', scope: 'current' } })).view!;
    assert.deepEqual(nodes(current), { open: 1, stalled: 1, done: 1 });
    assert.deepEqual(edges(current), { 'null>open': 0, 'open>stalled': 1, 'stalled>done': 1, 'stalled>open': 1 });
    const waiting = ((await analyze({ view: { kind: 'duration', scope: 'current' } })).view! as View).nodes.find(node => node.state === 'stalled')!;
    assert.equal(waiting.cases, 1);
    assert.equal(waiting.color, 'green');
    const finished = ((await analyze({ view: { kind: 'duration', scope: 'historical' } })).view! as View).nodes.find(node => node.state === 'stalled')!;
    assert.equal(finished.cases, 2);

    const selected = async (filter: Record<string, unknown>) => (await analyze({ filter })).cases.map(item => item.object.id).sort();
    assert.deepEqual(await selected({ states: ['stalled', 'done'], current: true }), ['metric-first', 'metric-third']);
    assert.deepEqual(await selected({ states: ['done', 'stalled'] }), ['metric-first', 'metric-second', 'metric-third']);
    assert.deepEqual(await selected({ edges: [{ from: 'open', to: 'stalled' }], edgeMode: 'last' }), ['metric-first']);
    assert.deepEqual(await selected({ edges: [{ from: 'stalled', to: 'open' }, { from: 'stalled', to: 'done' }], edgeMode: 'last' }),
      ['metric-second', 'metric-third']);
    assert.deepEqual(await selected({ edges: [{ from: 'stalled', to: 'open' }] }), ['metric-second']);

    // Metrics cover conforming processes only, so the second route, which went back to open, counts nowhere.
    const { metrics } = await analyze({});
    assert.equal(metrics?.node?.label, 'Distance');
    assert.equal(metrics?.node?.unit, 'km');
    assert.deepEqual(metrics?.node?.values.map(row => { const { state, value, color } = row as { state: string; value: number | null; color?: string };
      return [state, value, color ?? null]; }), [['open', null, null], ['stalled', 4, 'green'], ['done', 12, 'red']]);
    assert.deepEqual(metrics?.edge?.values.map(row => { const { from, to, value } = row as { from: string | null; to: string | null; value: number | null };
      return [from, to, value]; }), [[null, 'open', 2], ['open', 'stalled', 2], ['stalled', 'done', 1], ['stalled', 'open', null]]);
  } finally { await f.close(); }
});

test('a dynamic Machinery selection follows the processes as they move, while a static one keeps its cases', async () => {
  const f = await processSetup();
  try {
    const sets = new ObjectSets(f.db), access = () => Access.load(f.db, principal);
    const now = Date.now();
    const analysis = machineryAnalysisSchema.parse({ type: 'RouteStateLog', from: new Date(now - 3600000).toISOString(),
      to: new Date(now + 3600000).toISOString(), filter: { states: ['stalled'], current: true } });
    await f.change('open');
    await f.change('stalled');
    const dynamic = await sets.save(await access(), f.model, { requestId: 'stalled-now', name: 'Stalled now', mode: 'dynamic',
      set: { op: 'machinery', analysis } });
    const today = (await analyzeMachinery(f.db, await access(), f.model, analysis, true)).members!;
    const fixed = await sets.save(await access(), f.model, { requestId: 'stalled-today', name: 'Stalled today', mode: 'static',
      set: { op: 'refs', objects: today } });
    const members = async (id: string) => (await sets.evaluate(await access(), f.model, { set: { op: 'saved', id } })).items.map(item => item.ref.id);
    assert.deepEqual(await members(dynamic.id), [f.source.id]);
    assert.deepEqual(await members(fixed.id), [f.source.id]);
    // The route leaves the selected state: the dynamic set follows it, the static one keeps it.
    await f.change('done');
    assert.deepEqual(await members(dynamic.id), []);
    assert.deepEqual(await members(fixed.id), [f.source.id]);
    // A selection that reads a saved set could reach itself, so it analyzes all readable processes or one object.
    await assert.rejects(sets.evaluate(await access(), f.model, { set: { op: 'machinery', analysis: { ...analysis, setId: dynamic.id } } }),
      /analyzes all readable processes or one object/);
  } finally { await f.close(); }
});

test('a process container relates parallel processes of the same objects, aligns nested ones, and refuses cycles', async () => {
  const f = await processSetup();
  try {
    const definition = structuredClone(f.model.document);
    definition.objectTypes.find(type => type.apiName === 'Route')!.properties.priority = {
      description: 'Synthetic route priority', schema: { type: 'string', enum: ['low', 'high'] }, required: false,
    };
    addProcessLogs(definition, [{ type: 'Route', property: 'priority' }, { type: 'RideRequest', property: 'status' }]);
    const log = (name: string) => definition.objectTypes.find(type => type.apiName === name)!;
    log('RouteStateLog').machinery = {
      states: [{ name: 'open' }, { name: 'stalled' }, { name: 'done' }],
      transitions: [{ from: null, to: 'open' }, { from: 'open', to: 'stalled' }, { from: 'stalled', to: 'done' }],
      parallel: ['RoutePriorityLog'], subprocesses: [{ link: 'requests', process: 'RideRequestStatusLog' }],
    };
    const refused = async (change: (copy: typeof definition) => void, message: RegExp) => {
      const copy = structuredClone(definition);
      change(copy);
      await assert.rejects(f.metadata.publish(copy, f.capabilities, f.publisher), message);
    };
    await refused(copy => { copy.objectTypes.find(type => type.apiName === 'RideRequestStatusLog')!.machinery = {
      states: [{ name: 'requested' }, { name: 'quoted' }], transitions: [{ from: null, to: 'requested' }],
      subprocesses: [{ link: 'route', process: 'RouteStateLog' }] }; }, /must not form a cycle: .*RouteStateLog/);
    await refused(copy => { copy.objectTypes.find(type => type.apiName === 'RouteStateLog')!.machinery!.parallel = ['RouteStateLog']; },
      /parallel processes require other tracked state properties of the same objects/);
    await refused(copy => { copy.objectTypes.find(type => type.apiName === 'RouteStateLog')!.machinery!.parallel = ['RideRequestStatusLog']; },
      /parallel processes require/);
    const model = await f.metadata.publish(definition, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const graph = new Objects(f.db, model, await Access.load(f.db, principal));
    const route = (id: string) => ({ type: 'Route', id }), request = (id: string) => ({ type: 'RideRequest', id });
    const requestedAt = new Date().toISOString();
    for (const [id, priority, path] of [['container-first', 'high', ['open', 'stalled']], ['container-second', 'low', ['open']]] as const) {
      await graph.create(route(id), { id, name: id, priority });
      for (const state of path) await graph.edit(route(id), (await graph.read(route(id))).revision, { state });
    }
    for (const [id, status, parent] of [['container-a', 'requested', 'container-first'], ['container-b', 'quoted', 'container-first'],
      ['container-c', 'quoted', 'container-second']] as const) {
      await graph.create(request(id), { id, name: id, status, requestedAt });
      await graph.link({ type: 'RequestRoute', from: request(id), to: route(parent) });
    }
    const now = Date.now();
    const result = await analyzeMachinery(f.db, await Access.load(f.db, principal), model, machineryAnalysisSchema.parse({
      type: 'RouteStateLog', from: new Date(now - 3600000).toISOString(), to: new Date(now + 60000).toISOString() }));
    const table = (rows: { state: string; with: { state: string | null; count: number }[] }[]) =>
      Object.fromEntries(rows.map(row => [row.state, Object.fromEntries(row.with.map(cell => [String(cell.state), cell.count]))]));
    // The same routes, in their priority process and their state process.
    assert.deepEqual(result.parallel?.map(item => [item.process, item.property, table(item.states)]),
      [['RoutePriorityLog', 'priority', { stalled: { high: 1 }, open: { low: 1 } }]]);
    // The requests each route leads, by their own status, against the route's state.
    assert.deepEqual(result.alignment?.map(item => [item.link, item.process, item.property, table(item.states)]),
      [['requests', 'RideRequestStatusLog', 'status', { stalled: { requested: 1, quoted: 1 }, open: { quoted: 1 } }]]);
  } finally { await f.close(); }
});

test('definition discovery filters Machinery actions and subprocesses under limited resource grants', async () => {
  const f = await setup();
  try {
    const reader = { owner: 'machinery-reader', scopes: ['ontology:read'] };
    await setGrants(f.db, reader.owner, [
      ...['EventTripStateLog', 'EventTrip'].flatMap(type => [
        { resource: 'Eigos/object/' + type, permission: 'view_definition' as const },
        { resource: 'Eigos/object/' + type, permission: 'view_objects' as const },
      ]),
    ]);
    const access = await Access.load(f.db, reader);
    const definition = access.describe(f.model);
    const reference = definition.objectTypes.find(type => type.apiName === 'EventTripStateLog')?.machinery;
    assert(reference);
    assert(reference.transitions.every(edge => !edge.action));
    assert.deepEqual(reference.subprocesses, []);
  } finally { await f.close(); }
});

test('periodic Machinery review claims one window and recalculates it after visibility changes', async () => {
  const f = await processSetup();
  try {
    await f.change('open');
    await f.change('stalled');
    const reviews = new MachineryReviews(f.db, f.metadata);
    const review = await reviews.save(f.access, f.model, machineryReviewSchema.parse({
      name: 'Weekly route review', type: 'RouteStateLog', enabled: true, minCases: 1,
    }));
    assert.deepEqual((await Promise.all([reviews.scanOne(), reviews.scanOne()])).sort(), [false, true]);
    assert.deepEqual(await f.automation.list(f.access, f.model, 'object_rules'), { items: [], hasMore: false });
    const list = await reviews.list(await Access.load(f.db, principal), f.model);
    assert.equal(list.items[0]?.id, review.id);
    assert.equal(list.items[0]?.checkpoint?.release, f.model.release);
    const report = await reviews.read(await Access.load(f.db, principal), f.model, review.id, false);
    assert.equal(report.casesTotal, 1);
    assert.equal(report.mined.transitions.length, 2);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','Route',$1)`,
      [objectPolicySchema.parse({ read: { all: [{ op: 'equals', property: 'id', value: 'other' }] } })]);
    assert.equal((await reviews.read(await Access.load(f.db, principal), f.model, review.id, false)).casesTotal, 0);
  } finally { await f.close(); }
});

test('publication refreshes Machinery analysis once without repeating evaluations or shifting their cadence', async () => {
  const f=await processSetup();try{
    await f.change('open');await f.change('stalled');
    class CountingEvaluations extends ScenarioEvaluations {
      calls=0;
      override async runSuite(...args:Parameters<ScenarioEvaluations['runSuite']>){
        this.calls++;
        return {mode:'offline' as const,release:args[1].release,evaluatedAt:new Date().toISOString(),
          experimentDigest:'synthetic-evaluation',cases:[],summary:[],run:randomUUID(),suite:'synthetic-suite',suiteRevision:1};
      }
    }
    const evaluations=new CountingEvaluations(f.db,f.actions,f.capabilities.functions);
    const reviews=new MachineryReviews(f.db,f.metadata,evaluations);
    const review=await reviews.save(f.access,f.model,machineryReviewSchema.parse({name:'Weekly analysis',type:'RouteStateLog',
      enabled:true,evaluation:{id:randomUUID(),revision:1}}));
    assert.equal(await reviews.scanOne(),true);assert.equal(evaluations.calls,1);
    const before=(await reviews.list(f.access,f.model)).items[0]!;
    const next=await f.metadata.publish(f.model.document,f.capabilities,f.publisher);
    assert.equal((await reviews.list(f.access,next)).items[0]!.status,'stale');
    await assert.rejects(reviews.read(f.access,next,review.id,false),/publication changed/);
    assert.deepEqual((await Promise.all([reviews.scanOne(),reviews.scanOne()])).sort(),[false,true]);
    const after=(await reviews.list(f.access,next)).items[0]!;
    assert.equal(after.status,'ready');assert.equal(after.checkpoint!.release,next.release);
    assert.equal(after.checkpoint!.from,before.checkpoint!.from);assert.equal(after.checkpoint!.to,before.checkpoint!.to);
    assert.deepEqual(after.lastScan,before.lastScan);assert.equal(after.checkpoint!.evaluation,undefined);
    assert.equal(evaluations.calls,1);assert.equal(await reviews.scanOne(),false);
    assert.equal((await reviews.read(f.access,next,review.id,false)).casesTotal,1);
    await f.db.query(`UPDATE ${f.db.schema}.object_rules SET last_scan=now()-interval '8 days' WHERE id=$1`,[review.id]);
    assert.equal(await reviews.scanOne(),true);assert.equal(evaluations.calls,2);
    assert.equal(await reviews.scanOne(),false);
  }finally{await f.close();}
});

test('Machinery publication refresh honors pause and revocation without retrying a failed refresh in a tight loop',async()=>{
  const f=await processSetup();try{
    await f.change('open');const reviews=new MachineryReviews(f.db,f.metadata);
    const active=await reviews.save(f.access,f.model,machineryReviewSchema.parse({name:'Active',type:'RouteStateLog',enabled:true}));
    const paused=await reviews.save(f.access,f.model,machineryReviewSchema.parse({name:'Paused',type:'RouteStateLog',enabled:false}));
    await reviews.scanOne();await reviews.read(f.access,f.model,paused.id,true);
    const next=await f.metadata.publish(f.model.document,f.capabilities,f.publisher);
    await setGrants(f.db,principal.owner,businessGrants(next).filter(grant=>grant.resource!=='Eigos/object/Route'));
    assert.equal(await reviews.scanOne(),true);assert.equal(await reviews.scanOne(),false);
    const failed=(await f.db.query(`SELECT error,body FROM ${f.db.schema}.object_rules WHERE id=$1`,[active.id])).rows[0]!;
    assert.match(failed.error,/Review failed/);assert.equal(failed.body.attemptedRelease,next.release);
    await setGrants(f.db,principal.owner,businessGrants(next));const access=await Access.load(f.db,principal);
    const list=await reviews.list(access,next);
    assert.equal(list.items.find(row=>row.id===active.id)!.status,'failed');
    assert.equal(list.items.find(row=>row.id===paused.id)!.status,'stale');
    assert.equal(await reviews.scanOne(),false);
    await reviews.read(access,next,active.id,true);
    assert.equal((await reviews.list(access,next)).items.find(row=>row.id===active.id)!.status,'ready');
  }finally{await f.close();}
});

test('a queued transition is hidden and cannot run after its historical log permission is revoked', async () => {
  const f = await processSetup();
  try {
    await f.change('open');
    await f.automation.rule(f.access, f.model, {name:'Watch open to done',workflow:f.workflow.id,
      process:{type:'RouteStateLog',from:'open',to:'done'},enabled:true});
    await f.change('done');
    assert.equal(await f.automation.scanOne(), true);
    const [run] = await f.runs();
    assert(run);
    await setGrants(f.db, principal.owner, businessGrants(f.model).filter(grant=>grant.resource!=='Eigos/object/RouteStateLog' || grant.permission!=='view_objects'));
    const restricted = await Access.load(f.db, principal);
    assert.deepEqual(await f.automation.list(restricted, f.model, 'workflow_runs'), {items:[],hasMore:false});
    assert.equal(await f.automation.runOne(), true);
    assert.equal((await f.runs())[0]!.state,'failed');
    await assert.rejects(new Objects(f.db, f.model, restricted).read({type:'Route',id:'original'}), /unavailable/);
  } finally { await f.close(); }
});

test('run results redact references whose current instance permissions were revoked',async()=>{
  const f=await setup();try{
    await f.automation.run(f.access,f.model,{workflow:f.workflow.id,object:f.source,requestId:'private-result'});await f.automation.runOne();
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','Route',$1)`,[objectPolicySchema.parse({read:{all:[{op:'equals',property:'id',value:'source'}]}})]);
    const listed=await f.automation.list(await Access.load(f.db,principal),f.model,'workflow_runs');
    const row=listed.items[0] as {object:Object;results:{object:unknown}[]};
    assert.deepEqual(row.object,f.source);assert.equal(row.results[0]!.object,null);
  }finally{await f.close();}
});

test('stale publications and unauthorized owners cannot start or cancel runs',async()=>{
  const f=await setup();try{
    const document=structuredClone(f.model.document);document.version+='-updated';await f.metadata.publish(document,f.capabilities,f.publisher);
    await assert.rejects(f.automation.run(f.access,f.model,{workflow:f.workflow.id,object:f.source,requestId:'stale'}),/current live publication/);
    const current=await f.metadata.active(),run=await f.automation.run(await Access.load(f.db,principal),current,{workflow:f.workflow.id,object:f.source,requestId:'current'});
    const other=await Access.load(f.db,{owner:'other',scopes:['ontology:write']});
    await assert.rejects(f.automation.cancel(other,current,run.id),/unavailable/);
    assert.equal((await f.automation.cancel(await Access.load(f.db,principal),current,run.id)).state,'canceled');
  }finally{await f.close();}
});


test('cancellation reconciles an Action committed before its workflow checkpoint',async()=>{
  const f=await setup();try{
    let release!:()=>void,started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{started=resolve;});
    class PauseAfterCommit extends Actions {
      override async apply(...args:Parameters<Actions['apply']>){const result=await super.apply(...args);started();await gate;return result;}
    }
    const automation=new Automation(f.db,f.metadata,new PauseAfterCommit(f.db,f.capabilities.functions));
    const run=await automation.run(f.access,f.model,{workflow:f.workflow.id,object:f.source,requestId:'cancel-checkpoint-gap'});
    const worker=automation.runOne();await waiting;
    const canceled=await automation.cancel(await Access.load(f.db,principal),f.model,run.id);
    assert.equal(canceled.step,1);release();await worker;
    const row=(await f.db.query(`SELECT state,step,results FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows[0]!;
    assert.equal(row.state,'canceled');assert.equal(row.step,1);assert.equal(row.results.length,1);
    assert.equal((await automation.list(await Access.load(f.db,principal),f.model,'workflow_runs')).items.length,1);
  }finally{await f.close();}
});


test('a workflow can operate on a prior created object and preserve that binding after a committed-step retry',async()=>{
  const f=await setup();try{
    const workflow=await f.automation.workflow(f.access,f.model,{name:'Create then rename',steps:[...f.steps,{name:'Rename',action:'RenameRoute',input:{route:{step:'Copy'},revision:{literal:1},name:{literal:'Updated copy'}}}]});
    class CrashAfterSecondCommit extends Actions {
      crashed=false;
      override async apply(...args:Parameters<Actions['apply']>){
        const result=await super.apply(...args);
        if(!this.crashed&&args[4].endsWith(':1')){this.crashed=true;throw new Error('Synthetic failure after chained commit');}
        return result;
      }
    }
    const automation=new Automation(f.db,f.metadata,new CrashAfterSecondCommit(f.db,f.capabilities.functions));
    const run=await automation.run(f.access,f.model,{workflow:workflow.id,object:f.source,requestId:'chained'});
    await automation.runOne();
    assert.equal((await f.objects.read({type:'Route',id:'original'})).properties.name,'Updated copy');
    assert.equal((await f.objects.read(f.source)).properties.name,'original');
    const frozen=(await f.db.query(`SELECT input FROM ${f.db.schema}.workflow_steps WHERE run_id=$1 AND position=1`,[run.id])).rows[0]!.input;
    assert.deepEqual(frozen.route,{type:'Route',id:'original'});
    await f.objects.edit(f.source,1,{name:'New trigger name'});
    await automation.retry(await Access.load(f.db,principal),f.model,run.id);await automation.runOne();
    const row=(await f.db.query(`SELECT state,step FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows[0]!;
    assert.equal(row.state,'completed');assert.equal(row.step,2);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.actions WHERE request_id=$1`,['workflow:'+run.id+':1'])).rows[0]!.count,1);
  }finally{await f.close();}
});

test('workflow step bindings reject missing, forward and self references at definition time',async()=>{
  const f=await setup();try{
    for(const reference of ['Missing','First','Later']){
      await assert.rejects(f.automation.workflow(f.access,f.model,{name:'Invalid binding',steps:[{name:'First',action:'RenameRoute',input:{route:{step:reference},revision:{literal:1},name:{literal:'No'}}},{name:'Later',action:'CopyRoute',input:{id:{literal:'unused'},name:{literal:'Unused'}}}]}),/prior named step/);
    }
  }finally{await f.close();}
});

test('revoked prior-step result visibility blocks a later Action even when the trigger remains readable',async()=>{
  const f=await setup();try{
    const workflow=await f.automation.workflow(f.access,f.model,{name:'Protected chain',steps:[...f.steps,{name:'Rename',action:'RenameRoute',input:{route:{step:'Copy'},revision:{literal:1},name:{literal:'Must not be applied'}}}]});
    class RevokeAfterFirstCommit extends Actions {
      override async apply(...args:Parameters<Actions['apply']>){
        const result=await super.apply(...args);
        if(args[4].endsWith(':0'))await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','Route',$1)`,[objectPolicySchema.parse({read:{all:[{op:'equals',property:'id',value:'source'}]}})]);
        return result;
      }
    }
    const automation=new Automation(f.db,f.metadata,new RevokeAfterFirstCommit(f.db,f.capabilities.functions));
    const run=await automation.run(f.access,f.model,{workflow:workflow.id,object:f.source,requestId:'protected-chain'});
    await automation.runOne();
    await automation.retry(await Access.load(f.db,principal),f.model,run.id);await automation.runOne();
    const row=(await f.db.query(`SELECT state,step FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows[0]!;
    assert.equal(row.state,'failed');assert.equal(row.step,1);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.actions WHERE request_id=$1`,['workflow:'+run.id+':1'])).rows[0]!.count,0);
    assert.equal((await new Objects(f.db,f.model,await Access.load(f.db,principal)).read(f.source)).properties.name,'original');
  }finally{await f.close();}
});

test('a hotel workflow saved under v8 replays in v9 and the current release with fresh inputs and separate approval', async () => {
  // Reconstruct the historical documents on the same runtime and check both published identities.
  const laterDomains = [
    calendarJourneyDefinition, flightDefinition, luckinDefinition, documentDefinition, fliggyServicesDefinition,
    fliggyFlightBookingDefinition, fliggyHotelDefinition, diningReservations, restaurantServices, tableCheckReservations, marketplaceDefinition, petRideDefinition,
    travelHandoffDefinition, hotelTransferDefinition, tripHotelDependencyDefinition, itineraryDefinition, personalPlaceDefinition, localDeliveryDefinition, localDeliveryTradeDefinition, amapObservationDefinition,
  ];
  const addedTypes = new Set([
    ...laterDomains.flatMap(domain => domain.objectTypes.map(type => type.apiName)), 'ActionConfirmation', rideWatchType, immediateRideType,
  ]);
  const model = new Ontology(document);
  const logs = document.objectTypes.flatMap(type => processLogTarget(model, type.apiName) ?? []);
  const addedLogs = logs.filter(log => addedTypes.has(log.objectType) || log.type === 'DidiRideOrderStateLog');
  const addedActions = new Set([...laterDomains.flatMap(domain => domain.actionTypes.map(action => action.apiName)),
    ...scheduleJourneyDefinition.actionTypes.map(action => action.apiName)]);
  for (const action of didiOrderDefinitions.actionTypes) addedActions.add(action.apiName);
  for (const action of [bookImmediateRideAction, bookWithEndpoints, estimateWithEndpoints]) addedActions.add(action);
  addedActions.add(executeHotelDependentTrip);
  addedActions.add('StageDiningActivity');
  addedActions.add('StageScheduleRecommendation');
  const addedFunctions = new Set([
    ...laterDomains.flatMap(domain => domain.functionTypes), ...scheduleJourneyDefinition.functionTypes, ...didiOrderDefinitions.functionTypes, ...didiReadDefinitions,
    ...deliveryFunctions, ...locationFunctions, ...mapFunctions, ...dianpingResearchFunctions, flightPositionFunction,
  ].map(fn => fn.apiName));
  for (const name of ['stageDiningActivity', 'searchRestaurantNotes', 'readWeatherHistory', 'readDiningAvailability']) addedFunctions.add(name);
  addedActions.add('EstimateRideWithPlaceClues');
  for (const action of rideWatchDefinition.actionTypes) addedActions.add(action.apiName);
  for (const fn of rideWatchDefinition.functionTypes) addedFunctions.add(fn.apiName);
  for (const name of ['bookDidiImmediateRide', bookWithEndpointsFunction, prepareWithEndpoints]) addedFunctions.add(name);
  addedFunctions.add('readDidiImmediateRide');
  addedFunctions.add('prepareRideInquiryWithPlaceClues');
  addedFunctions.add('readInteractiveRideEstimate');
  addedFunctions.add('recommendSchedule');
  addedFunctions.add('stageScheduleRecommendation');
  const v9Definition = structuredClone(document);
  v9Definition.version = '9';
  // Historical DiDi contracts predate PA-reported observations.
  const legacyEvidence = ['live_readonly', 'provider_mock', 'fixture'];
  v9Definition.objectTypes.find(type => type.apiName === 'SourceReceipt')!.properties.evidence!.schema.enum = legacyEvidence;
  for (const name of ['searchPlaces', 'estimateRoute', 'estimateLocations']) {
    const returns = v9Definition.functionTypes.find(fn => fn.apiName === name)!.returns;
    (returns.properties as { evidence: { enum: string[] } }).evidence.enum = legacyEvidence;
  }
  const readEstimates = v9Definition.functionTypes.find(fn => fn.apiName === 'readRideEstimates')!.returns;
  (readEstimates.properties as { evidence: { items: { enum: string[] } } }).evidence.items.enum = legacyEvidence;
  delete v9Definition.agentProfiles;
  delete v9Definition.imports;
  for (const resource of [...v9Definition.objectTypes, ...v9Definition.functionTypes, ...v9Definition.actionTypes]) {
    if (resource.typeClasses?.some(tag => tag.kind === 'agent-capability')) {
      const tags = resource.typeClasses.filter(tag => tag.kind !== 'agent-capability');
      if (tags.length) resource.typeClasses = tags;
      else delete resource.typeClasses;
    }
  }
  v9Definition.functionTypes = v9Definition.functionTypes.filter(fn => fn.apiName !== 'verifyGeometryUpload');
  const geometry = v9Definition.actionTypes.find(action => action.apiName === 'RegisterGeometry')!;
  delete geometry.rules;
  delete geometry.result;
  geometry.submissionCriteria = [];
  geometry.function = 'registerGeometry';
  v9Definition.interfaceTypes = v9Definition.interfaceTypes.filter(type => type.apiName !== 'RideInquiryWithPlaceClues' && type.apiName !== immediateRideInterface &&
    !amapObservationDefinition.interfaceTypes.some(item => item.apiName === type.apiName) &&
    !travelHandoffDefinition.interfaceTypes.some(item => item.apiName === type.apiName) &&
    !fliggyServicesDefinition.interfaceTypes.some(item => item.apiName === type.apiName) &&
    !marketplaceDefinition.interfaceTypes.some(item => item.apiName === type.apiName) &&
    !localDeliveryDefinition.interfaceTypes.some(item => item.apiName === type.apiName) &&
    !localDeliveryTradeDefinition.interfaceTypes.some(item => item.apiName === type.apiName) &&
    ![...restaurantServices.interfaceTypes, ...tableCheckReservations.interfaceTypes].some(item => item.apiName === type.apiName) &&
    !petRideDefinition.interfaceTypes.some(item => item.apiName === type.apiName));
  delete v9Definition.objectTypes.find(type => type.apiName === 'RideRequest')!.interfaces.RideInquiryWithPlaceClues;
  const didiOrder = v9Definition.objectTypes.find(type => type.apiName === 'DidiRideOrder')!;
  const originalOrderEvidence = ['live', 'provider_mock', 'synthetic'];
  didiOrder.properties.evidence!.schema.enum = originalOrderEvidence;
  v9Definition.interfaceTypes.find(type => type.apiName === 'RideOrder')!.properties.evidence!.schema.enum = originalOrderEvidence;
  delete didiOrder.properties.cancellationReceipt;
  delete didiOrder.properties.sourceAuthority;
  for (const type of didiOrderDefinitions.interfaceTypes) delete didiOrder.interfaces[type.apiName];
  v9Definition.interfaceTypes = v9Definition.interfaceTypes.filter(type =>
    !didiOrderDefinitions.interfaceTypes.some(item => item.apiName === type.apiName));
  v9Definition.objectTypes = v9Definition.objectTypes.filter(type => !addedTypes.has(type.apiName) && !addedLogs.some(log => log.type === type.apiName));
  delete v9Definition.objectTypes.find(type => type.apiName === 'ScheduledActivity')!.properties.dining;
  delete v9Definition.objectTypes.find(type => type.apiName === 'EventTripStateLog')!.machinery;
  const tripProperties = v9Definition.objectTypes.find(type => type.apiName === 'EventTrip')!.properties;
  delete tripProperties.hotelBooking;
  delete tripProperties.pendingHotelDependencyReview;
  v9Definition.actionTypes.find(action => action.apiName === 'AuthorizeEventTrip')!.submissionCriteria = [];
  const historicalRoute = v9Definition.objectTypes.find(type => type.apiName === 'Route')!;
  delete historicalRoute.classificationProperty;
  const historicalPlace = v9Definition.objectTypes.find(type => type.apiName === 'Place')!;
  delete historicalPlace.classificationProperty;
  delete historicalPlace.properties.locationClassification;
  const routeProperties = historicalRoute.properties;
  delete routeProperties.locationClassification;
  delete routeProperties.personalPlaceRevisions;
  delete routeProperties.pickup;
  delete routeProperties.drivingEstimate;
  v9Definition.linkTypes = v9Definition.linkTypes.filter(type =>
    !amapObservationDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    type.apiName !== 'ImmediateDidiApproval' && type.apiName !== immediateOrderLink && type.apiName !== immediateRideRouteLink &&
    !ridePersonalPlaceLinks.some(link => link.apiName === type.apiName) && !addedLogs.some(log => log.link === type.apiName) && !documentDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !rideWatchDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !flightDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !calendarJourneyDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !travelHandoffDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !hotelTransferDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !tripHotelDependencyDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !itineraryDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !scheduleJourneyDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !fliggyServicesDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !marketplaceDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    ![...restaurantServices.linkTypes, ...tableCheckReservations.linkTypes, ...luckinDefinition.linkTypes].some(item => item.apiName === type.apiName) &&
    !personalPlaceDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !localDeliveryDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !localDeliveryTradeDefinition.linkTypes.some(link => link.apiName === type.apiName));
  v9Definition.dataSources = v9Definition.dataSources.filter(source =>
    !fliggyServicesDefinition.dataSources.some(item => item.apiName === source.apiName) &&
    !hotelTransferDefinition.dataSources.some(item => item.apiName === source.apiName) &&
    !marketplaceDefinition.dataSources.some(item => item.apiName === source.apiName));
  v9Definition.actionTypes = v9Definition.actionTypes.filter(action => !addedActions.has(action.apiName));
  v9Definition.functionTypes = v9Definition.functionTypes.filter(fn => !addedFunctions.has(fn.apiName));
  v9Definition.functionTypes.find(fn => fn.apiName === 'resolveRideLocations')!.description =
    'Resolve each venue by querying exact Location.name within its source receipt. One exact match resolves even when other entrances or nearby shops were returned. Multiple exact matches or no exact match require clarification. Explicit selections must belong to the corresponding source response.';
  v9Definition.valueTypes = v9Definition.valueTypes?.filter(type => type.apiName !== taskLocationValueType.apiName);
  v9Definition.typeGroups = v9Definition.typeGroups?.filter(group => group.apiName !== 'Documents' && group.apiName !== 'PersonalPlaces' && !localDeliveryProviders.some(provider => provider === group.apiName));
  for (const group of v9Definition.typeGroups ?? []) group.objectTypes = group.objectTypes.filter(type => !addedTypes.has(type));
  assert.equal(new Ontology(v9Definition).digest, 'ab7a4e8a4c6d6c0e56eaef294ae849911f78da535e9cef2fb213bdfaa39c4d8a');

  const v8Definition = structuredClone(v9Definition);
  v8Definition.version = '8';
  v8Definition.objectTypes = v8Definition.objectTypes.filter(type => !logs.some(log => log.type === type.apiName));
  v8Definition.interfaceTypes = v8Definition.interfaceTypes.filter(type => type.apiName !== 'ProcessLog');
  v8Definition.linkTypes = v8Definition.linkTypes.filter(type => !logs.some(log => log.link === type.apiName));
  delete v8Definition.objectTypes.find(type => type.apiName === 'SchedulePlan')!.properties.state;
  // This is the definition published at 6609009, before the v9 process logs.
  assert.equal(new Ontology(v8Definition).digest, '2773fecccb1e5731b25494b33346e726c85f3906fb4067b40c9b8623d6a35c92');
  const service = serviceProvider();
  const start = Date.now();
  const day = (n: number) => new Date(start + n * 86400000).toISOString().slice(0, 10);
  const requested = day(3), replayDate = day(5), currentDate = day(7), thirdDate = day(11);
  const originKeyword = 'Shanghai Hongqiao railway station';
  const destinationKeyword = 'Synthetic hotel';
  const title = requested + ' Hongqiao to the selected hotel';
  const goal = 'Plan my transfer from Hongqiao station to the same Shanghai hotel on ' + requested + ', one adult for one night.';
  let modelInvocations = 0;
  const driver: AgentDriver = {
    model: 'recorded-ontology-agent-decisions',
    async run(prompt, tools) {
      modelInvocations++;
      const { userRequest } = JSON.parse(prompt.split('\n').at(-1)!);
      assert.equal(userRequest.message, goal);
      const call = (name: string, input: unknown) => tools.get(name)!.invoke(input);
      await assert.rejects(call('apply_action', { action: 'ExecuteEventTrip', input: {} }), /only permits/);
      await assert.rejects(call('refresh_sources', { sources: [{ source: 'DidiEstimates', input: {} }] }));
      const apply = (type: string, implementation: string, action: string, input: Record<string, unknown>) =>
        call('apply_action', { interface: { type, implementation, action }, input });
      const page = await apply('HotelSearch', 'RollingGoHotelSearch', 'search', {
        place: '上海', checkIn: requested, adults: 1, nights: 1, currency: 'CNY', limit: 3,
      }) as ObjectRef;
      const [selection] = await call('query_ontology', { queries: [{
        type: 'HotelOffer', from: { object: page, link: 'results', as: 'ServiceSearchResult' }, where: { nativeId: 'hotel-1' },
      }] }) as Array<{ items: Array<{ ref: ObjectRef }> }>;
      const hotel = selection!.items[0]!.ref;
      const prepared = await apply('SchedulablePlan', 'SchedulePlan', 'prepare', {
        title, start: requested + 'T14:00:00+08:00', end: requested + 'T19:00:00+08:00',
        timeZone: 'Asia/Shanghai', durationMinutes: 75,
      }) as ObjectRef & { waitingForPA?: boolean };
      if (prepared.waitingForPA) return;
      const [origin, destination] = await call('refresh_sources', { sources: [originKeyword, destinationKeyword].map(keywords =>
        ({ source: 'DidiPlaces', input: { city: '上海', keywords }, view: { type: 'Location', link: 'places' } })),
      }) as Array<{ objects: ObjectRef[] }>;
      const travel = await apply('DrivingEstimate', 'DidiDrivingEstimate', 'observe', {
        origin: origin!.objects[0], destination: destination!.objects[0],
      });
      await call('evaluate_function', { function: 'readDrivingEstimate', input: { travel } });
      const { id: scenarioId } = await call('create_scenario', { requestId: 'hotel-proposal', name: title }) as { id: string };
      await call('apply_action', { scenarioId, interface: { type: 'HotelOffer', action: 'select', object: hotel },
        input: { service: hotel, plan: prepared } });
      const { slots } = await call('evaluate_function', {
        scenarioId, function: 'findScheduleSlots', input: { plan: prepared, limit: 1 },
      }) as { slots: Array<{ start: string; end: string }> };
      await call('apply_action', { scenarioId, action: 'SaveScheduleActivity',
        input: { plan: prepared, id: 'transfer', name: 'Hotel transfer', ...slots[0] } });
      await call('complete_with_function', { scenarioId, function: 'readSchedulePlan', input: { plan: prepared } });
    },
  };
  const f = await fixture(driver, service.resolve, undefined, v8Definition);
  f.provider.flags.related = false;
  try {
    const hotelWorkflows = new HotelWorkflows(f.db, f.metadata, f.capabilities.functions);
    const pa = new PARequests(f.tasks);
    const approvedBody = (task: Task) => {
      const review = (publicTask(task, f.capabilities.projectTaskResult).result as { hotelWorkflow: { scenarioId: string; revision: number; snapshot: string } }).hotelWorkflow;
      assert.ok(!Object.hasOwn(review, 'recipe'));
      return { taskId: task.id, scenarioId: review.scenarioId, revision: review.revision,
        snapshot: review.snapshot, decision: 'approve-simulation' };
    };
    const prepare = async (message: string, input: Record<string, unknown>) => {
      const task = await f.tasks.submit(principal, { requestId: randomUUID(), message, ...input });
      await f.worker.runOne();
      const waiting = await f.tasks.get(principal, task.id);
      assert.equal(waiting.state, 'input-required', waiting.error ?? '');
      const ask = waiting.result as { requestId: string; capability: string; input: ReturnType<typeof planningInput> };
      assert.equal(ask.capability, 'calendar.freebusy');
      const response = calendarAnswer(ask.input);
      await pa.respond(principal, task.id, { requestId: ask.requestId, response });
      await f.worker.runOne();
      const reviewed = await f.tasks.get(principal, task.id);
      assert.equal(reviewed.state, 'completed', reviewed.error ?? '');
      return reviewed;
    };

    const learned = await prepare(goal, { learnHotelWorkflow: true });
    const first = approvedBody(learned);
    assert.equal((await hotelWorkflows.list(principal)).items.length, 0);
    await assert.rejects(hotelWorkflows.approve(principal, { ...first, revision: first.revision + 1 }), /reviewed Scenario/);
    await assert.rejects(hotelWorkflows.approve(principal, { ...first, snapshot: '0'.repeat(64) }), /reviewed Scenario/);
    await assert.rejects(hotelWorkflows.approve({ ...principal, scopes: ['tasks:read', 'tasks:write'] }, first), /ontology:write/);
    await assert.rejects(hotelWorkflows.approve({ ...principal, owner: 'different-owner' }, first), /no hotel itinerary/);
    await setGrants(f.db, principal.owner, businessGrants(f.model).filter(g => g.resource !== 'Eigos/action/CommitSchedulePlan'));
    await assert.rejects(hotelWorkflows.approve(principal, first), /Permission required: apply_action/);
    await setGrants(f.db, principal.owner, businessGrants(f.model));
    const [approved, concurrent] = await Promise.all([
      hotelWorkflows.approve(principal, first), hotelWorkflows.approve(principal, first),
    ]);
    assert.deepEqual(concurrent, approved);
    assert.equal(approved.status, 'simulated');
    assert.equal(approved.receipt?.mode, 'synthetic');
    assert.equal(approved.receipt?.executed, false);
    assert.equal(approved.receipt?.bookable, false);
    assert.ok(approved.workflowId);
    assert.deepEqual(await hotelWorkflows.approve(principal, first), approved);
    const stored = (await f.db.query(`SELECT body FROM ${f.db.schema}.workflows WHERE id=$1`, [approved.workflowId])).rows[0]!.body;
    assert.ok(!JSON.stringify(stored).includes(requested));
    assert.ok(!JSON.stringify(stored).includes(first.scenarioId));
    assert.ok(!JSON.stringify(stored).includes(approved.hotel.id));
    assert.ok(!JSON.stringify(stored).includes(approved.travel.id));
    assert.equal(stored.definition, f.model.digest);

    const v9 = await f.metadata.publish(v9Definition, f.capabilities, f.publisher);
    assert.notEqual(v9.digest, f.model.digest);
    await setGrants(f.db, principal.owner, businessGrants(v9));
    assert.deepEqual((await hotelWorkflows.list(principal)).items.map(item => item.id), [approved.workflowId]);
    const calls = service.flags.calls.length, reads = f.provider.calls.length, agentRuns = modelInvocations;
    const replay = await prepare('Reuse my saved hotel itinerary on ' + replayDate, {
      replayHotelWorkflow: { workflowId: approved.workflowId, checkIn: replayDate },
    });
    const second = approvedBody(replay);
    const replayResult = replay.result as { hotelWorkflow: typeof approved; plan: { properties: { start: string } } };
    assert.notEqual(second.scenarioId, first.scenarioId);
    assert.equal(replayResult.hotelWorkflow.workflowId, approved.workflowId);
    assert.equal(replayResult.hotelWorkflow.status, 'awaiting_approval');
    assert.equal(replayResult.hotelWorkflow.receipt, undefined);
    assert.equal(replayResult.hotelWorkflow.checkIn, replayDate);
    assert.ok(replayResult.plan.properties.start.startsWith(replayDate));
    assert.ok((replay.result as { plan: { properties: { name: string } } }).plan.properties.name.startsWith(replayDate));
    assert.notEqual(replayResult.hotelWorkflow.hotel.id, approved.hotel.id);
    assert.notEqual(replayResult.hotelWorkflow.travel.id, approved.travel.id);
    assert.equal(modelInvocations, agentRuns);
    assert.deepEqual(service.flags.calls.slice(calls), ['RollingGo']);
    assert.deepEqual(f.provider.calls.slice(reads).sort(), ['maps_direction_driving', 'maps_textsearch', 'maps_textsearch']);
    await assert.rejects(hotelWorkflows.approve(principal, { ...first, taskId: replay.id }), /reviewed Scenario/);
    const repeated = await hotelWorkflows.approve(principal, second);
    assert.equal(repeated.workflowId, approved.workflowId);
    assert.equal(repeated.status, 'simulated');
    const currentModel = await f.metadata.publish(document, f.capabilities, f.publisher);
    assert.throws(() => checkWorkflowDependencies(v9, currentModel, { interfaceTypes: ['HotelOffer'] }, new Set(['HotelOffer'])),
      /interfaceTypes\/HotelOffer/);
    await setGrants(f.db, principal.owner, businessGrants(currentModel));
    const currentAccess = await Access.load(f.db, principal);
    assert.deepEqual((await hotelWorkflows.list(principal)).items.map(item => item.id), [approved.workflowId]);
    const currentReplay = await prepare('Replay the v8 workflow on the current publication', {
      replayHotelWorkflow: { workflowId: approved.workflowId, checkIn: currentDate },
    });
    assert.equal(currentReplay.release, currentModel.release);
    assert.notEqual(approvedBody(currentReplay).scenarioId, second.scenarioId);
    assert.equal((await hotelWorkflows.approve(principal, approvedBody(currentReplay))).workflowId, approved.workflowId);
    assert.equal(modelInvocations, agentRuns);
    assert.equal((await hotelWorkflows.list(principal)).items.length, 1);
    const persisted = (await f.db.query(`SELECT body FROM ${f.db.schema}.workflows WHERE id=$1`, [approved.workflowId])).rows[0]!.body;
    assert.deepEqual(persisted, stored);
    const automation = new Automation(f.db, f.metadata, f.capabilities.actions);
    const names = await automation.list(currentAccess, currentModel, 'workflows');
    assert.deepEqual(names.items.map((item) => (item as { name: string }).name), ['酒店行程 · Synthetic hotel']);
    await assert.rejects(automation.run(currentAccess, currentModel, { workflow: approved.workflowId,
      object: approved.plan, requestId: 'wrong-automation-runner' }), /Workflow is unavailable/);
    await assert.rejects(automation.workflow(currentAccess, currentModel, { id: approved.workflowId, revision: 1,
      name: 'Attempt overwrite', steps: [{ name: 'One', action: 'SearchRollingGoHotels', input: {} }],
    }), /changed or is unavailable/);

    const interrupted = await f.tasks.submit(principal, {
      requestId: randomUUID(), message: 'Recover this replay', replayHotelWorkflow: { workflowId: approved.workflowId, checkIn: day(9) },
    });
    await f.worker.runOne();
    const pending = await f.tasks.get(principal, interrupted.id);
    const ask = pending.result as { requestId: string; input: ReturnType<typeof planningInput> };
    await pa.respond(principal, interrupted.id, { requestId: ask.requestId, response: calendarAnswer(ask.input) });
    const claimed = await f.tasks.claim();
    assert.equal(claimed?.id, interrupted.id);
    const invoke = f.capabilities.functions.invoke.bind(f.capabilities.functions);
    f.capabilities.functions.invoke = async (...args) => {
      if (args[1] === 'findScheduleSlots') throw new Error('Synthetic Worker termination after hotel selection');
      return invoke(...args);
    };
    try {
      await assert.rejects(f.agent.run(claimed!, AbortSignal.timeout(5000)), /Synthetic Worker termination/);
    } finally { f.capabilities.functions.invoke = invoke; }
    const savedTrace = (await f.db.query(`SELECT workflow_trace FROM ${f.db.schema}.tasks WHERE id=$1`, [interrupted.id])).rows[0]!.workflow_trace;
    assert(savedTrace.some((event: { input?: { interface?: { type?: string } } }) => event.input?.interface?.type === 'HotelOffer'));
    await f.db.query(`UPDATE ${f.db.schema}.tasks SET lease_until=now()-interval '1 second' WHERE id=$1`, [interrupted.id]);
    await f.worker.runOne();
    const recovered = await f.tasks.get(principal, interrupted.id);
    assert.equal(recovered.state, 'completed', recovered.error ?? '');
    assert.equal((recovered.result as { hotelWorkflow: { status: string } }).hotelWorkflow.status, 'awaiting_approval');
    await hotelWorkflows.approve(principal, approvedBody(recovered));

    const changed = await prepare('Another rehearsal', { replayHotelWorkflow: { workflowId: approved.workflowId, checkIn: thirdDate } });
    const change = approvedBody(changed);
    service.flags.active = false;
    try { await assert.rejects(hotelWorkflows.approve(principal, change), /revoked/); }
    finally { service.flags.active = true; }
    await new Scenarios(f.db).discard(currentAccess, currentModel, change.scenarioId, change.revision);
    await assert.rejects(hotelWorkflows.approve(principal, change), /closed|changed/);

    const incompatible = structuredClone(document);
    incompatible.version = 'incompatible-replay';
    const step = incompatible.actionTypes.find(action => action.apiName === 'SaveScheduleActivity')!;
    step.parameters = {...step.parameters, maxProperties: 1};
    await f.metadata.publish(incompatible, f.capabilities, f.publisher);
    assert.deepEqual((await hotelWorkflows.list(principal)).items, []);
    const blocked = await f.tasks.submit(principal, { requestId: randomUUID(), message: 'Replay after a breaking contract change',
      replayHotelWorkflow: { workflowId: approved.workflowId, checkIn: day(13) } });
    const sourceCalls = service.flags.calls.length + f.provider.calls.length;
    await f.worker.runOne();
    const failed = await f.tasks.get(principal, blocked.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error ?? '', /Ontology.*changed/);
    assert.equal(service.flags.calls.length + f.provider.calls.length, sourceCalls);
    const safe = (await f.db.query(`SELECT
      (SELECT count(*)::int FROM ${f.db.schema}.external_operations) external_operations,
      (SELECT count(*)::int FROM ${f.db.schema}.scheduled_actions) scheduled_actions,
      (SELECT count(*)::int FROM ${f.db.schema}.action_effects) action_effects,
      (SELECT count(*)::int FROM ${f.db.schema}.objects WHERE type='ScheduledActivity') live_activities`)).rows[0];
    assert.deepEqual(safe, { external_operations: 0, scheduled_actions: 0, action_effects: 0, live_activities: 0 });
    assert.equal(f.provider.flags.orderCreates, 0);
  } finally { await f.close(); }
});

async function exerciseReviewedHotelWorkflow(outcome: 'commit' | 'changed-evidence' | 'conflicting-activity' | 'predicate-match' | 'revoked-at-expiry' | 'revoked-on-reclaim') {
  const hotelSource = serviceProvider();
  const initial = planningInput();
  const start = new Date(Date.now() + 3 * 86400000);
  start.setUTCHours(6, 0, 0, 0);
  const checkIn = start.toISOString().slice(0, 10);
  const target = {
    title: 'Hongqiao to synthetic hotel',
    start: start.toISOString(),
    end: new Date(start.getTime() + 4 * 3600000).toISOString(),
    timeZone: 'Asia/Shanghai',
    durationMinutes: 45,
  };
  let hotel: ObjectRef, modelRuns = 0;
  const driver: AgentDriver = {
    model: 'fixture-hotel-replanning',
    async run(prompt, tools) {
      modelRuns++;
      const { object: plan, scenarioId, ontology } = JSON.parse(prompt.split('\n').at(-1)!);
      assert.deepEqual([...tools.keys()], ['evaluate_function', 'apply_action', 'submit_workflow_proposal']);
      assert.deepEqual(ontology.dataSources, []);
      const act = (action: string, input: Record<string, unknown>, scenario: string | null = scenarioId) =>
        tools.get('apply_action')!.invoke({ ...(scenario ? { scenarioId: scenario } : {}), action, input });
      await assert.rejects(act('CommitSchedulePlan', { plan, scenarioId, revision: 1 }), /capability list/);
      await assert.rejects(act('PrepareSchedulePlan', { ...target, plan, scenarioId }, null), /assigned Scenario/);
      await assert.rejects(tools.get('evaluate_function')!.invoke({
        function: 'readSchedulePlan', input: { plan }, scenarioId,
      }), /capability list/);
      const prepared = await act('PrepareSchedulePlan', { ...target, plan, scenarioId }) as { waitingForPA?: boolean };
      if (prepared.waitingForPA) return;
      const attach = act('AttachPlanService', { plan, service: hotel });
      await assert.rejects(tools.get('submit_workflow_proposal')!.invoke({}), /current Workflow tool/);
      await attach;
      const { slots } = await tools.get('evaluate_function')!.invoke({
        scenarioId, function: 'findScheduleSlots', input: { plan, limit: 1 },
      }) as { slots: { start: string; end: string }[] };
      assert.equal(slots.length, 1);
      await act('SaveScheduleActivity', { plan, id: 'hotel-transfer', name: 'Hotel transfer', ...slots[0] });
      await tools.get('submit_workflow_proposal')!.invoke({});
    },
  };
  const definition = structuredClone(document);
  const commit = definition.actionTypes.find(action => action.apiName === 'CommitSchedulePlan')!;
  commit.effects = [{
    name: 'ConfirmedReplan', handler: 'SyntheticHotelReplan',
    payload: { plan: { parameter: 'plan' }, approvedRevision: { parameter: 'revision' } },
  }];
  const deliveries: unknown[] = [];
  const extensions = { effects: new Map([['SyntheticHotelReplan', async (payload: unknown) => { deliveries.push(payload); }]]) };
  const f = await fixture(driver, hotelSource.resolve, undefined, definition, undefined, extensions);
  const reviewer = { ...principal, owner: 'hotel-replan-reviewer' };
  const config = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL,
    EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'workflow-isolated-test-'.repeat(3) });
  const { app } = createApp(config, f.db, f.source, async token => {
    if (token === 'workflow-owner') return principal;
    if (token === 'workflow-reviewer') return reviewer;
    throw new Error('Unknown synthetic test token');
  }, extensions);
  const server = app.listen(0, '127.0.0.1');
  const mcp = new Client({ name: 'synthetic-hotel-pa', version: '1' });
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = 'http://127.0.0.1:' + address.port;
    const ownerClient = new OntologyClient({ baseUrl, token: 'workflow-owner' });
    const reviewerClient = new OntologyClient({ baseUrl, token: 'workflow-reviewer' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(baseUrl + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer workflow-owner' } },
    }));
    const graph = new Objects(f.db, f.model, f.access), scenarios = new Scenarios(f.db);
    const { actions, effects } = f.capabilities;
    const plan = { type: 'SchedulePlan', id: 'existing-itinerary' };
    const { title: name, ...dates } = initial;
    await graph.create(plan, { id: plan.id, name, ...dates, state: 'prepared' });
    const before = await graph.read(plan);
    const resource = { type: 'ScheduleResource', id: digest([principal.owner, 'personal-calendar']) };
    await graph.create(resource, { id: resource.id, name: 'User calendar' });
    const conflictsQuery = {
      type: 'ScheduledActivity', from: { object: resource, link: 'activities' },
      filter: { op: 'all' as const, predicates: [
        { op: 'lt' as const, property: 'start', value: target.end },
        { op: 'gt' as const, property: 'end', value: target.start },
      ] },
    };
    const validationInput = { type: 'Route', id: 'only-read-by-final-validator' };
    await graph.create(validationInput, { id: validationInput.id, name: 'Approved evidence' });
    const invoke = f.capabilities.functions.invoke.bind(f.capabilities.functions);
    let addUnexpectedEdit = false;
    f.capabilities.functions.invoke = async (model, name, input, context) => {
      if (name === 'findScheduleSlots' && model.scenario) {
        assert.deepEqual((await context.objects.query(conflictsQuery)).items, []);
        const sets = new ObjectSets(f.db);
        assert.equal((await sets.evaluate(context.objects.access, model, {
          set: { op: 'query', query: conflictsQuery },
        })).total, 0);
      }
      if (name === 'validateSchedule' && model.scenario) {
        await context.objects.read(validationInput);
        await context.objects.query({ type: 'Route', where: { name: 'Hotel route closure' } });
      }
      if (name === 'commitSchedulePlan' && addUnexpectedEdit && context.edit) {
        const edit = context.edit;
        return invoke(model, name, input, { ...context, edit: (ref, write) =>
          edit(ref, async (target) => {
            await write(target);
            const { revision } = await target.read(ref);
            await target.edit(ref, revision, { name: 'Unreviewed name' });
          }),
        });
      }
      return invoke(model, name, input, context);
    };
    const search = await actions.resolve(f.access, f.model, {
      interface: { type: 'HotelSearch', implementation: 'RollingGoHotelSearch', action: 'search' },
      input: { place: '上海', checkIn, adults: 1, nights: 1, currency: 'CNY', limit: 3 },
    });
    const page = await actions.apply(f.access, f.model, search.action, search.input, 'replan-hotel-read');
    const found = await graph.query({ type: 'HotelOffer', from: { object: page, link: 'results', as: 'ServiceSearchResult' },
      where: { nativeId: 'hotel-1' } });
    hotel = found.items[0]!.ref;
    await setGrants(f.db, reviewer.owner, businessGrants(f.model));
    const reviewerAccess = await Access.load(f.db, reviewer);
    const automation = new Automation(f.db, f.metadata, actions);
    const workflow = await automation.workflow(f.access, f.model, {
      name: 'Replan a hotel itinerary', steps: [],
      proposal: {
        name: 'Hotel transfer proposal', goal: 'Choose an available time for the hotel transfer.',
        actions: ['PrepareSchedulePlan', 'AttachPlanService', 'SaveScheduleActivity'],
        functions: ['findScheduleSlots'], validation: { function: 'validateSchedule', objectParameter: 'plan' },
        mergeAction: 'CommitSchedulePlan', mergeObjectParameter: 'plan', reviewers: [reviewer.owner],
      },
    });
    await setGrants(f.db,principal.owner,[...businessGrants(f.model),{resource:'Eigos',permission:'edit_definition'}]);
    const started = await mcp.callTool({ name: 'ontology_run_workflow',
      arguments: { workflow: workflow.id, object: plan, requestId: 'hotel-replan' } });
    assert.equal(Boolean(started.isError), false, JSON.stringify(started.content));
    const submitted = JSON.parse((started.content as { text: string }[])[0]!.text) as { id: string };
    const status = async () => (await automation.list(await Access.load(f.db, principal), f.model, 'workflow_runs'))
      .items.find(item => item.id === submitted.id)!;
    assert.equal(await automation.runOne(), true);
    const waiting = await status();
    assert.equal(waiting.state, 'waiting-proposal');
    const { taskId, scenarioId } = waiting.proposal!;
    await assert.rejects(scenarios.inspectReview(reviewerAccess, f.model, scenarioId), /unavailable/);
    assert.deepEqual((await reviewerClient.pendingScenarioReviews()).items, []);
    const candidate = structuredClone(f.model.document);
    candidate.version += '-next';
    const prepared = await f.metadata.prepare(candidate, f.capabilities, f.publisher);
    await assert.rejects(f.metadata.activate(prepared.release, f.capabilities, f.publisher), /unfinished tasks/);
    assert.equal(await f.worker.runOne(), true);
    const paused = await f.tasks.get(principal, taskId);
    assert.equal(paused.state, 'input-required', paused.error ?? '');
    const ask = paused.result as { requestId: string; capability: string; input: typeof initial };
    assert.equal(ask.capability, 'calendar.freebusy');
    assert.equal(await automation.runOne(), false);
    if (outcome === 'revoked-at-expiry' || outcome === 'revoked-on-reclaim') {
      await setGrants(f.db, principal.owner, businessGrants(f.model).filter(grant =>
        grant.resource !== 'Eigos/action/CommitSchedulePlan' || grant.permission !== 'apply_action'));
      const expired = outcome === 'revoked-at-expiry';
      if (expired) {
        await f.db.query(`UPDATE ${f.db.schema}.workflow_runs SET proposal_deadline=clock_timestamp()-interval '1 second'
          WHERE id=$1`, [submitted.id]);
      } else {
        // Simulate reclaiming a dispatcher that stopped after claiming the paused run.
        await f.db.query(`UPDATE ${f.db.schema}.workflow_runs SET state='working',lease_until=clock_timestamp()-interval '1 second'
          WHERE id=$1`, [submitted.id]);
      }
      assert.equal(await automation.runOne(), true);
      assert.equal((await status()).state, expired ? 'expired' : 'failed');
      assert.equal((await f.tasks.get(principal, taskId)).state, 'canceled');
      assert.deepEqual((await new PARequests(f.tasks).pending(principal)).items, []);
      await assert.rejects(ownerClient.request('tasks/' + taskId + '/pa-response',
        { requestId: ask.requestId, response: calendarAnswer(ask.input) }), /not waiting/);
      assert.equal(await automation.runOne(), false);
      assert.equal(await effects.runOne(), false);
      assert.deepEqual(await graph.read(plan), before);
      assert.equal(f.provider.flags.orderCreates, 0);
      if (expired) {
        await f.metadata.activate(prepared.release, f.capabilities, f.publisher);
        assert.equal((await f.metadata.active()).release, prepared.release);
      }
      return;
    }
    await ownerClient.request('tasks/' + taskId + '/pa-response', { requestId: ask.requestId, response: calendarAnswer(ask.input) });
    assert.equal(await f.worker.runOne(), true);
    const proposed = await f.tasks.get(principal, taskId);
    assert.equal(proposed.state, 'completed', proposed.error ?? '');
    assert.equal(modelRuns, 2);
    await assert.rejects(f.metadata.activate(prepared.release, f.capabilities, f.publisher), /unfinished workflows/);
    assert.equal(await automation.runOne(), true);
    assert.equal((await status()).state, 'waiting-approval');
    assert.deepEqual(await graph.read(plan), before);
    assert.equal((await graph.follow(plan, 'activities')).length, 0);

    const review = await reviewerClient.scenario(scenarioId).inspectReview();
    assert.deepEqual((await reviewerClient.pendingScenarioReviews()).items.map(({ id, approved }) => ({ id, approved })), [
      { id: scenarioId, approved: false },
    ]);
    assert.deepEqual((await ownerClient.pendingScenarioReviews()).items, []);
    const reviewedPlan = review.objects.find(({ ref }) => ref.id === plan.id);
    assert.equal(reviewedPlan?.before?.state, 'prepared');
    assert.equal(reviewedPlan?.after?.state, 'confirmed');
    assert.equal(review.evidenceChanged, false);
    assert.match(review.evidenceVersion ?? '', /^[a-f0-9]{64}$/);
    const reviewedPayload = { plan, approvedRevision: review.revision };
    assert.deepEqual(review.commit?.effects, [{ name: 'ConfirmedReplan', handler: 'SyntheticHotelReplan', payload: reviewedPayload }]);
    assert.ok(review.evidence?.some(item => item.ref.id === hotel.id));
    assert.ok(review.evidence?.some(item => item.ref.id === validationInput.id));
    const { cognitive_evidence: rawEvidence } = (await f.db.query(
      `SELECT cognitive_evidence FROM ${f.db.schema}.tasks WHERE owner=$1 AND id=$2`, [principal.owner, taskId],
    )).rows[0]!;
    const observations = decisionEvidenceSchema.parse(rawEvidence);
    const empty = observations.find(item => item.read.kind === 'query' && item.read.input.type === 'ScheduledActivity');
    assert.ok(empty && empty.read.kind === 'query');
    assert.deepEqual(empty.read.input.filter, conflictsQuery.filter);
    assert.equal(empty.fingerprint, digest({ value: { items: [] } }));
    const emptySet = observations.find(item => item.read.kind === 'set');
    assert.ok(emptySet && emptySet.read.kind === 'set');
    assert.deepEqual(emptySet.refs, []);
    assert.match(emptySet.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(observations.some(item => item.read.kind === 'follow' && item.read.link === 'activities' && item.refs.length === 0));
    assert.ok(observations.some(item => item.read.kind === 'pa'));
    assert.ok(observations.some(item => item.read.kind === 'source' && item.read.ref.id === hotel.id));
    const merge = () => actions.apply(f.access, f.model, 'CommitSchedulePlan', {
      plan, scenarioId, revision: review.revision,
    }, 'commit-hotel-replan');
    assert.equal(await effects.runOne(), false);
    await assert.rejects(merge(), /requires approval/);
    await assert.rejects(scenarios.inviteReviewers(f.access, f.model, scenarioId, review.revision, []), /revision changed/);
    await assert.rejects(scenarios.approveReview(reviewerAccess, f.model, scenarioId, review.revision, '0'.repeat(64)), /review changed/);
    await reviewerClient.scenario(scenarioId).approveReview(review.revision, review.snapshot);
    assert.equal((await reviewerClient.pendingScenarioReviews()).items[0]?.approved, true);
    await assert.rejects(f.metadata.activate(prepared.release, f.capabilities, f.publisher), /unfinished workflows/);
    assert.equal((await f.metadata.active()).release, f.model.release);
    await setGrants(f.db, reviewer.owner, []);
    await assert.rejects(merge(), /requires approval/);
    await setGrants(f.db, reviewer.owner, businessGrants(f.model));
    if (outcome === 'changed-evidence' || outcome === 'conflicting-activity' || outcome === 'predicate-match') {
      if (outcome === 'changed-evidence') {
        const evidence = await graph.read(validationInput);
        await graph.edit(validationInput, evidence.revision, { name: 'Different decision evidence' });
      } else if (outcome === 'predicate-match') {
        await graph.create({ type: 'Route', id: 'new-predicate-match' }, { id: 'new-predicate-match', name: 'Hotel route closure' });
      } else {
        const activity = review.objects.find(item => item.ref.type === 'ScheduledActivity')!.after!;
        const blocker = { type: 'ScheduledActivity', id: 'concurrent-reservation' };
        await f.db.transaction(async client => {
          const writer = new Objects(f.db, f.model, f.access, client);
          await writer.create(blocker, { id: blocker.id, name: 'Concurrent reservation', start: activity.start, end: activity.end });
          await writer.link({ type: 'ActivityResource', from: blocker, to: resource });
        });
        assert.equal((await graph.read(resource)).revision, review.evidence?.find(item => item.ref.id === resource.id)?.revision ?? 1);
      }
      const stale = await scenarios.inspectReview(reviewerAccess, f.model, scenarioId);
      assert.equal(stale.evidenceVersion, review.evidenceVersion);
      assert.equal(stale.evidenceChanged, true);
      assert.equal(stale.conflicts, true);
      await assert.rejects(scenarios.approveReview(reviewerAccess, f.model, scenarioId, stale.revision, stale.snapshot), /review changed/);
      await assert.rejects(merge(), /decision evidence changed/);
      assert.deepEqual(await graph.read(plan), before);
      assert.equal(await effects.runOne(), false);
      await automation.cancel(f.access, f.model, submitted.id);
      const next = await f.metadata.publish(candidate, f.capabilities, f.publisher);
      assert.equal((await f.metadata.active()).release, next.release);
      assert.equal(f.provider.flags.orderCreates, 0);
      return;
    }

    const unrelated = { type: 'Route', id: 'unrelated-route-after-approval' };
    await graph.create(unrelated, { id: unrelated.id, name: 'Unrelated route' });
    const afterUnrelatedWrite = await reviewerClient.scenario(scenarioId).inspectReview();
    assert.equal(afterUnrelatedWrite.evidenceChanged, false);
    assert.equal(afterUnrelatedWrite.snapshot, review.snapshot);

    addUnexpectedEdit = true;
    await assert.rejects(merge(), /differ from the reviewed Scenario delta/);
    assert.deepEqual(await graph.read(plan), before);
    assert.equal((await status()).state, 'waiting-approval');
    assert.equal(await effects.runOne(), false);
    addUnexpectedEdit = false;
    assert.deepEqual(await ownerClient.scenario(scenarioId).merge('CommitSchedulePlan', 'commit-hotel-replan', review.revision, { plan }), plan);
    assert.deepEqual(await merge(), plan);
    assert.equal((await status()).state, 'completed');
    assert.equal((await graph.read(plan)).properties.name, target.title);
    assert.equal((await graph.read(plan)).properties.state, 'confirmed');
    assert.equal((await graph.follow(plan, 'activities'))[0]?.properties.name, 'Hotel transfer');
    assert.equal((await graph.follow(plan, 'availability'))[0]?.properties.evidence, 'synthetic');
    assert.equal((await f.tasks.get(principal, taskId)).id, taskId);
    assert.deepEqual(deliveries, []);
    assert.equal(await effects.runOne(), true);
    assert.equal(await effects.runOne(), false);
    assert.deepEqual(deliveries, [reviewedPayload]);
    const trace = await new ExecutionTrace(f.db, f.metadata).read(await Access.load(f.db, principal), 'Eigos', { taskId });
    assert.ok(trace.events.some(event => event.kind === 'approval'));
    assert.ok(trace.events.some(event => event.kind === 'merge' && event.taskId === taskId));
    assert.ok(trace.effects.some(effect => effect.state === 'completed'));
    assert.equal(f.provider.flags.orderCreates, 0);
    const dispatches = await f.db.query(`SELECT
      (SELECT count(*) FROM ${f.db.schema}.external_operations) AS operations,
      (SELECT count(*) FROM ${f.db.schema}.action_effects) AS effects`);
    assert.deepEqual(dispatches.rows[0], { operations: '0', effects: '1' });

    const second = await automation.run(f.access, f.model, { workflow: workflow.id, object: plan, requestId: 'expired-hotel-replan' });
    await automation.runOne();
    const secondRun = (await automation.list(f.access, f.model, 'workflow_runs')).items.find(item => item.id === second.id)!;
    await f.db.query(`UPDATE ${f.db.schema}.workflow_runs SET proposal_deadline=clock_timestamp()-interval '1 second'
      WHERE id=$1`, [second.id]);
    assert.equal(await automation.runOne(), true);
    assert.equal((await f.tasks.get(principal, secondRun.proposal!.taskId)).state, 'canceled');
    assert.equal((await automation.list(f.access, f.model, 'workflow_runs')).items.find(item => item.id === second.id)!.state, 'expired');
    await assert.rejects(scenarios.inspectReview(reviewerAccess, f.model, secondRun.proposal!.scenarioId), /unavailable/);
  } finally {
    await mcp.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
}

test('hotel replanning preserves the independent review and synthetic Outbox after an unrelated Route is added', () =>
  exerciseReviewedHotelWorkflow('commit'));

test('hotel replanning rejects drift in final-validator evidence and allows activation after closing the run', () =>
  exerciseReviewedHotelWorkflow('changed-evidence'));

test('hotel replanning rejects a new activity on the same resource in the previously empty window', () =>
  exerciseReviewedHotelWorkflow('conflicting-activity'));

test('hotel replanning rejects a new match in a validator-only predicate that returned no objects', () =>
  exerciseReviewedHotelWorkflow('predicate-match'));


test('hotel replanning expires and cancels the original PA task even after the merge grant is revoked', () =>
  exerciseReviewedHotelWorkflow('revoked-at-expiry'));

test('hotel replanning cancels the original PA task when a reclaimed proposal fails authorization', () =>
  exerciseReviewedHotelWorkflow('revoked-on-reclaim'));

test('saved object-rule preview runs actual workflow bindings in selected Scenarios without leaving writes',async()=>{
  const f=await setup();try {
    const scenarios=new Scenarios(f.db);
    const [a,b]=await Promise.all(['matched','unchanged'].map(name=>scenarios.create(f.access,f.model,{requestId:name,name})));
    assert(a && b);
    const view=await scenarios.view(f.access,f.model,a.id);
    await f.actions.apply(f.access,view,'RenameRoute',{route:f.source,revision:1,name:'match'},'preview-rename');
    const rule=await f.automation.rule(f.access,f.model,{name:'Matches',query:{type:'Route',where:{name:'match'}},workflow:f.workflow.id,enabled:true});
    const inspection=await scenarios.inspect(f.access,f.model,a.id);
    const result=await f.automation.preview(f.access,f.model,{rule:rule.id,revision:rule.revision,
      scenarios:[{id:a.id,revision:inspection.revision},{id:b.id,revision:b.revision}]});
    assert.equal(result.scenarios[0]!.results[0]!.steps[0]!.status,'completed');
    assert.equal(result.scenarios[1]!.results.length,0);
    assert.equal((await scenarios.inspect(f.access,f.model,a.id)).revision,inspection.revision);
    assert.equal((await f.objects.query({type:'Route'})).items.length,1);
    assert.equal((await f.db.query(`SELECT * FROM ${f.db.schema}.workflow_runs`)).rowCount,0);
  }finally{await f.close();}
});

test('continuation replays the exact authored journal on a compatible release and does not transfer approval',async()=>{
  const f=await setup();try{
    const scenarios=new Scenarios(f.db), draft=await scenarios.create(f.access,f.model,{requestId:'prior',name:'Draft'});
    await f.actions.apply(f.access,await scenarios.view(f.access,f.model,draft.id),'RenameRoute',
      {route:f.source,revision:1,name:'proposed'},'journal');
    const prior=await scenarios.inspect(f.access,f.model,draft.id);
    const review=await scenarios.inviteReviewers(f.access,f.model,draft.id,prior.revision,['independent-reviewer']);
    const document=structuredClone(f.model.document);
    document.version+='next';
    const next=await f.metadata.publish(document,f.capabilities,f.publisher);
    assert.deepEqual((await scenarios.list(f.access,next)).items,[]);
    assert.equal((await scenarios.continuationSources(f.access,next)).items[0]!.id,draft.id);
    const copied=await scenarios.continueScenario(f.access,next,{id:draft.id,revision:review.revision,requestId:'continue'});
    assert.notEqual(copied.id,draft.id);
    assert.equal((await scenarios.inspect(f.access,next,copied.id)).objects[0]!.after!.name,'proposed');
    assert.equal((await new Objects(f.db,next,f.access).read(f.source)).properties.name,'original');
    assert.equal((await scenarios.continueScenario(f.access,next,{id:draft.id,revision:review.revision,requestId:'continue'})).id,copied.id);
    assert.equal((await f.db.query(`SELECT * FROM ${f.db.schema}.scenario_approvals WHERE scenario_id=$1`,[copied.id])).rowCount,0);
    await new Objects(f.db,next,f.access).edit(f.source,1,{name:'other edit'});
    await assert.rejects(scenarios.continueScenario(f.access,next,{id:draft.id,revision:review.revision,requestId:'collision'}),/conflict/);
  }finally{await f.close();}
});

test('external process history is source-authorized, idempotent, isolated from live automation, and exportable',async()=>{
  const f=await processSetup();try{
    await setGrants(f.db,principal.owner,[...businessGrants(f.model),
      {resource:'Eigos/source/Archive',permission:'ingest_source'},{resource:'Eigos/source/Archive',permission:'read_source'}]);
    const access=await Access.load(f.db,principal);
    const time=(minutes:number)=>new Date(Date.now()+minutes*60000).toISOString();
    const history={type:'RouteStateLog',source:'Archive',events:[
      {id:'A',object:f.source,from:null,to:'open',observedAt:time(-60)},
      {id:'B',object:f.source,from:'open',to:'stalled',observedAt:time(-30)},
    ]};
    assert.equal((await ingestMachineryHistory(f.db,access,f.model,history)).inserted,2);
    assert.equal((await ingestMachineryHistory(f.db,access,f.model,history)).replayed,2);
    await assert.rejects(ingestMachineryHistory(f.db,access,f.model,{...history,events:[{...history.events[1],to:'done'}]}),/conflicts/);
    const input=machineryAnalysisSchema.parse({type:'RouteStateLog',externalSource:'Archive',from:time(-75),to:time(-1)});
    const analyzed=await analyzeMachinery(f.db,access,f.model,input,true);
    assert.deepEqual(analyzed.cases[0]?.states,['open','stalled']);
    assert.deepEqual(analyzed.members,[f.source]);
    const services=ontologyServices(f.db,f.metadata,f.capabilities,f.capabilities.functions,f.capabilities.effects,f.actions);
    const saved=await services.get('save_machinery_cases')!.invoke(principal,{analysis:input,name:'Stalled cases',requestId:'case-set'}) as {id:string};
    assert.deepEqual(await f.db.transaction(client=>new ObjectSets(f.db).members(access,f.model,{op:'saved',id:saved.id},client)),[f.source]);
    const cases=await services.get('evaluation_cases_from_set')!.invoke(principal,{set:saved.id,parameter:'route'});
    assert.deepEqual(cases,{total:1,cases:[{name:'Case1',inputs:{route:f.source},
      evidence:[{object:f.source,revision:(await f.graph.read(f.source)).revision}]}]});
    assert.equal((await f.graph.query({type:'RouteStateLog'})).items.length,0);
  }finally{await f.close();}
});


test('ordinary users run published Workflow snapshots under their own permissions without author access',async()=>{
  const f=await setup();
  try {
    const services=ontologyServices(f.db,f.metadata,f.capabilities,f.capabilities.functions,f.capabilities.effects,f.actions);
    const member={...principal,owner:'workflow-consumer'};
    const editor={...principal,owner:'service-editor'};
    await setGrants(f.db,principal.owner,[...businessGrants(f.model),{resource:'Eigos',permission:'manage_definition'}]);
    await setGrants(f.db,editor.owner,[...businessGrants(f.model),{resource:'Eigos',permission:'edit_definition'}]);
    await setGrants(f.db,member.owner,businessGrants(f.model));
    const invoke=(name:string,actor:typeof principal,input:unknown={})=>services.get(name)!.invoke(actor,input);
    for (const [actor,role] of [[principal,'admin'],[editor,'editor'],[member,'member']] as const) {
      assert.equal((await invoke('workbench_access',actor) as {role:string}).role,role);
    }
    assert.deepEqual(await invoke('published_workflows',member),{items:[],hasMore:false});
    await assert.rejects(invoke('raw_definition',member),/service team/);
    await assert.rejects(invoke('list_branches',member),/service team/);
    await assert.rejects(invoke('save_workflow',member,{name:'draft',steps:f.steps}),/edit_definition/);
    await assert.rejects(invoke('run_workflow',member,{workflow:f.workflow.id,object:f.source,requestId:'draft'}),/edit_definition/);
    await assert.rejects(invoke('publish_workflow',editor,{id:f.workflow.id,revision:1,targetType:'Route'}),/manage_definition/);
    await assert.rejects(invoke('run_published_workflow',member,{workflow:f.workflow.id,revision:1,object:f.source,requestId:'not-released'}),/unavailable/);

    const graph=new Objects(f.db,f.model,await Access.load(f.db,member));
    const input={type:'Route',id:'member-route'};
    await graph.create(input,{id:input.id,name:'member-input'});
    await invoke('publish_workflow',principal,{id:f.workflow.id,revision:1,targetType:'Route'});
    await invoke('save_workflow',principal,{id:f.workflow.id,revision:1,name:'Unreleased edit',steps:[{
      ...f.steps[0],input:{...f.steps[0]!.input,name:{literal:'Draft-only name'}},
    }]});
    assert.deepEqual(await invoke('published_workflows',member),{items:[{
      id:f.workflow.id,name:'Copy route',description:'',revision:1,targetType:'Route',
    }],hasMore:false});
    await assert.rejects(invoke('run_published_workflow',member,{workflow:f.workflow.id,revision:1,object:f.source,requestId:'foreign'}),/Object is unavailable/);
    const request={workflow:f.workflow.id,revision:1,object:input,requestId:'published'};
    const accepted=await invoke('run_published_workflow',member,request);
    assert.deepEqual(await invoke('run_published_workflow',member,request),accepted);
    assert(await f.automation.runOne());
    assert.equal((await graph.read({type:'Route',id:'member-input'})).properties.name,'Copied');
    assert.equal((await f.objects.query({type:'Route'})).items.length,1);

    await setGrants(f.db,member.owner,businessGrants(f.model).filter(g=>g.resource!=='Eigos/action/CopyRoute'));
    assert.deepEqual(await invoke('published_workflows',member),{items:[],hasMore:false});
    await assert.rejects(invoke('run_published_workflow',member,{...request,requestId:'revoked'}),/apply_action/);
    await setGrants(f.db,member.owner,businessGrants(f.model));
    await invoke('withdraw_workflow',principal,{id:f.workflow.id,revision:1});
    await assert.rejects(invoke('run_published_workflow',member,{...request,requestId:'withdrawn'}),/unavailable/);
  }finally{await f.close();}
});

test('legacy drafts expose blocked continuation and an authorized recovery difference without inventing a journal',async()=>{
  const f=await setup();try{
    const scenarios=new Scenarios(f.db);
    const place={type:'Place',id:'recovery-place'};
    await f.objects.create(place,{id:place.id,name:'Synthetic place',city:'Shanghai',address:'Synthetic address',
      coordinates:{lat:31,lng:121},coordinateSystem:'GCJ02',sourceBinding:'fixture',observedAt:new Date().toISOString()});
    const draft=await scenarios.create(f.access,f.model,{requestId:'legacy-continuation',name:'Legacy route proposal'});
    await f.actions.apply(f.access,await scenarios.view(f.access,f.model,draft.id),'RenameRoute',
      {route:f.source,revision:1,name:'Proposed route'},'legacy-step');
    await new Objects(f.db,await scenarios.view(f.access,f.model,draft.id),f.access).link({type:'RouteOrigin',from:f.source,to:place});
    const revision=(await scenarios.inspect(f.access,f.model,draft.id)).revision;
    await f.db.query(`UPDATE ${f.db.schema}.scenarios SET journal_steps=0 WHERE id=$1`,[draft.id]);
    await f.db.query(`UPDATE ${f.db.schema}.scenario_actions SET step_revision=NULL,input=NULL,edits=NULL WHERE scenario_id=$1`,[draft.id]);
    const next=await f.metadata.publish(f.model.document,f.capabilities,f.publisher);
    const listed=(await scenarios.continuationSources(f.access,next)).items.find(item=>item.id===draft.id)!;
    assert.deepEqual(listed.continuation,{status:'blocked',reason:'incomplete-action-journal'});
    await assert.rejects(scenarios.continueScenario(f.access,next,{id:draft.id,revision,requestId:'invalid-copy'}),/complete Action journal/);
    const services=ontologyServices(f.db,f.metadata,f.capabilities,f.capabilities.functions,f.capabilities.effects,f.actions);
    const preview=await services.get('inspect_scenario_continuation')!.invoke(
      {...principal,scopes:['ontology:read']},{id:draft.id,revision}) as Awaited<ReturnType<Scenarios['inspectContinuation']>>;
    assert.equal(preview.objects[0]!.before!.name,'original');assert.equal(preview.objects[0]!.after!.name,'Proposed route');
    assert.deepEqual(preview.links,[{type:'RouteOrigin',from:f.source,to:place,removed:false}]);
    assert.equal((await new Objects(f.db,next,f.access).read(f.source)).properties.name,'original');
    assert.equal((await scenarios.list(f.access,next)).items.length,0);
    await f.db.query(`INSERT INTO ${f.db.schema}.property_security VALUES('Eigos','Route','name')`);
    const masked=await scenarios.inspectContinuation(await Access.load(f.db,principal),next,draft.id,revision);
    assert.equal(masked.objects[0]!.before!.name,null);assert.equal(masked.objects[0]!.after!.name,null);
    await setGrants(f.db,principal.owner,businessGrants(next).filter(grant=>grant.resource!=='Eigos/object/Place'));
    await assert.rejects(scenarios.inspectContinuation(await Access.load(f.db,principal),next,draft.id,revision),/permission|denied|Place/i);
    await setGrants(f.db,principal.owner,businessGrants(next));
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','Route',$1)`,
      [objectPolicySchema.parse({read:{all:[{op:'equals',property:'id',value:'unavailable'}]}})]);
    await assert.rejects(scenarios.inspectContinuation(await Access.load(f.db,principal),next,draft.id,revision),/unavailable/);
  }finally{await f.close();}
});

test('continuation recovery enforces owner, revision, session expiry and current object permissions',async()=>{
  const f=await setup();try{
    const scenarios=new Scenarios(f.db),session=await scenarios.openSession(f.access,3600);
    const draft=await scenarios.create(f.access,f.model,{requestId:'temporary-recovery',name:'Temporary recovery',kind:'temporary',sessionId:session.id});
    await new Objects(f.db,await scenarios.view(f.access,f.model,draft.id),f.access).edit(f.source,1,{name:'Unjournaled'});
    const revision=(await scenarios.inspect(f.access,f.model,draft.id)).revision;
    const next=await f.metadata.publish(f.model.document,f.capabilities,f.publisher);
    await setGrants(f.db,'different-owner',businessGrants(next));
    const other=await Access.load(f.db,{...principal,owner:'different-owner'});
    assert.equal((await scenarios.continuationSources(other,next)).items.length,0);
    await assert.rejects(scenarios.inspectContinuation(other,next,draft.id,revision),/unavailable/);
    await assert.rejects(scenarios.inspectContinuation(f.access,next,draft.id,revision+1),/changed/);
    await setGrants(f.db,principal.owner,businessGrants(next).filter(grant=>grant.resource!=='Eigos/object/Route'));
    await assert.rejects(scenarios.inspectContinuation(await Access.load(f.db,principal),next,draft.id,revision),/permission|denied|Route/i);
    await setGrants(f.db,principal.owner,businessGrants(next));
    await f.db.query(`UPDATE ${f.db.schema}.scenario_sessions SET closed_at=now() WHERE id=$1`,[session.id]);
    assert.equal((await scenarios.continuationSources(f.access,next)).items.length,0);
    await assert.rejects(scenarios.inspectContinuation(f.access,next,draft.id,revision),/unavailable/);
  }finally{await f.close();}
});

test('the recovery service validates draft-only rows against current policies without requiring live counterparts',async()=>{
  const f=await setup();try{
    const scenarios=new Scenarios(f.db),draft=await scenarios.create(f.access,f.model,{requestId:'draft-only-policy',name:'Policy-aware recovery'});
    const ref={type:'Route',id:'draft-only'},view=await scenarios.view(f.access,f.model,draft.id);
    await new Objects(f.db,view,f.access).create(ref,{id:ref.id,name:'Allowed proposed route'});
    const revision=(await scenarios.inspect(f.access,f.model,draft.id)).revision;
    const next=await f.metadata.publish(f.model.document,f.capabilities,f.publisher);
    const policy=objectPolicySchema.parse({read:{all:[{op:'equals',property:'id',value:ref.id}]},
      properties:{name:{all:[{op:'equals',property:'name',value:'Allowed proposed route'}]}}});
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','Route',$1)`,[policy]);
    const services=ontologyServices(f.db,f.metadata,f.capabilities,f.capabilities.functions,f.capabilities.effects,f.actions);
    const read=()=>services.get('inspect_scenario_continuation')!.invoke({...principal,scopes:['ontology:read']},{id:draft.id,revision}) as Promise<Awaited<ReturnType<Scenarios['inspectContinuation']>>>;
    const result=await read();
    assert.deepEqual(result.objects,[{ref,before:null,after:{id:ref.id,name:'Allowed proposed route'}}]);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.objects WHERE projection=$1 AND type='Route' AND id=$2`,[next.projection,ref.id])).rows[0]!.count,0);
    await f.db.query(`UPDATE ${f.db.schema}.object_policies SET policy=$1 WHERE type='Route'`,
      [objectPolicySchema.parse({...policy,properties:{name:{all:[{op:'equals',property:'name',value:'not-permitted'}]}}})]);
    assert.equal((await read()).objects[0]!.after!.name,null);
    await f.db.query(`UPDATE ${f.db.schema}.object_policies SET policy=$1 WHERE type='Route'`,
      [objectPolicySchema.parse({read:{all:[{op:'equals',property:'id',value:'different-row'}]}})]);
    await assert.rejects(read(),/unavailable|denied/);
  }finally{await f.close();}
});

test('a process rule invokes one Action with no saved workflow and reports only the owner’s visible execution', async () => {
  const f=await processSetup();
  try {
    const base={name:'Resolve stalls',enabled:true,process:{type:'RouteStateLog',from:'open',to:'stalled'}};
    const effect={action:'ChangeRouteState',input:{route:{object:true},revision:{property:'$revision'},state:{literal:'done'}}};
    await assert.rejects(f.automation.rule(f.access,f.model,{...base,workflow:f.workflow.id,effect}));
    await assert.rejects(f.automation.rule(f.access,f.model,{...base,effect:{...effect,input:{}}}),/missing a required Action parameter/);
    const before=(await f.automation.list(f.access,f.model,'workflows')).items.length;
    const rule=await f.automation.rule(f.access,f.model,{...base,effect});
    assert.equal((await f.automation.list(f.access,f.model,'workflows')).items.length,before);
    const services=ontologyServices(f.db,f.metadata,f.capabilities,f.capabilities.functions,f.capabilities.effects,f.actions);
    const read=(caller=principal)=>services.get('machinery_rule_bindings')!.invoke(caller,{type:'RouteStateLog'}) as ReturnType<Automation['processBindings']>;
    const binding=(await read()).items[0]!;
    assert.deepEqual(binding.effect,{action:'ChangeRouteState'}); assert.equal(binding.enabled,true);
    assert.equal(binding.id,rule.id); assert.equal(binding.latestRun,null);
    await setGrants(f.db,'other-rule-owner',businessGrants(f.model));
    assert.deepEqual((await read({...principal,owner:'other-rule-owner'})).items,[]);
    await f.change('open');await f.change('stalled');
    await f.automation.scanOne();
    assert.equal((await read()).items[0]!.latestRun?.state,'pending');
    await f.automation.runOne();
    assert.equal((await f.graph.read(f.source)).properties.state,'done');
    assert.equal((await read()).items[0]!.latestRun?.state,'completed');
    await f.automation.scanOne();assert.equal(await f.automation.runOne(),false);
    assert.equal((await f.runs()).length,1);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','Route',$1)`,
      [objectPolicySchema.parse({read:{all:[{op:'equals',property:'id',value:'other'}]}})]);
    assert.equal((await read()).items[0]!.latestRun,null);
  } finally {await f.close();}
});

test('revocation and disabling a direct process effect prevent a queued Action from committing',async()=>{
  const f=await processSetup();
  try{
    const effect={action:'ChangeRouteState',input:{route:{object:true},revision:{property:'$revision'},state:{literal:'done'}}};
    const input={name:'Resolve route',enabled:true,process:{type:'RouteStateLog',to:'stalled'},effect};
    const rule=await f.automation.rule(f.access,f.model,input);
    await f.change('open');await f.change('stalled');await f.automation.scanOne();
    await setGrants(f.db,principal.owner,businessGrants(f.model).filter(g=>g.resource!=='Eigos/action/ChangeRouteState'));
    await f.automation.runOne();
    assert.equal((await f.runs())[0]!.state,'failed');
    assert.equal((await f.graph.read(f.source)).properties.state,'stalled');
    await setGrants(f.db,principal.owner,businessGrants(f.model));
    await f.automation.rule(await Access.load(f.db,principal),f.model,{...input,id:rule.id,revision:rule.revision,enabled:false});
    const row=(await f.runs())[0]!;
    try {await f.automation.retry(await Access.load(f.db,principal),f.model,row.id);await f.automation.runOne();}
    catch(error){assert.match(String(error),/rule|workflow/i);}
    assert.equal((await f.graph.read(f.source)).properties.state,'stalled');
  }finally{await f.close();}
});

test('a process effect checks its published Action contract before admitting later transitions',async()=>{
  const f=await processSetup();
  try{
    const rule=await f.automation.rule(f.access,f.model,{name:'Review stale routes',enabled:true,
      process:{type:'RouteStateLog',to:'stalled'},
      effect:{action:'ChangeRouteState',input:{route:{object:true},revision:{property:'$revision'},state:{literal:'done'}}}});
    const changed=structuredClone(f.model.document);
    changed.actionTypes.find(action=>action.apiName==='ChangeRouteState')!.parameters={
      type:'object',properties:{route:{type:'object'},revision:{type:'integer'},state:{type:'string'},reason:{type:'string'}},
      required:['route','revision','state','reason'],additionalProperties:false,
    };
    const live=await f.metadata.publish(changed,f.capabilities,f.publisher);
    const editor=await Access.load(f.db,principal);
    await f.actions.apply(editor,live,'ChangeRouteState',{route:f.source,revision:(await new Objects(f.db,live,editor).read(f.source)).revision,
      state:'stalled',reason:'Maintenance'},randomUUID());
    assert.equal(await f.automation.scanOne(),true);
    const current=(await f.automation.processBindings(editor,live,{type:'RouteStateLog'})).items.find(entry=>entry.id===rule.id)!;
    assert.equal(current.enabled,false);assert.match(current.error,/scan failed/i);
    assert.equal(current.latestRun,null);assert.equal((await f.runs()).length,0);
  }finally{await f.close();}
});

test('rule scans continue while a workflow run is still executing',async()=>{
  const controller=new AbortController();let scans=0,runs=0,release!:()=>void,scanned!:()=>void;
  const running=new Promise<void>(resolve=>{release=resolve;}),thirdScan=new Promise<void>(resolve=>{scanned=resolve;});
  const dispatch=dispatchAutomation({
    cleanup:async()=>({more:false}),
    scans:[async()=>{if(++scans===3)scanned();return false;}],
    run:async()=>{if(++runs>1)return false;await running;return true;},
  },controller.signal,5);
  try{
    await Promise.race([thirdScan,delay(2000).then(()=>{throw new Error('Rule scans waited for the running workflow');})]);
    assert.equal(runs,1);
  }finally{release();controller.abort();await dispatch;}
});

test('a productive rule scan wakes an idle workflow runner',async()=>{
  const controller=new AbortController();let queued=false,scans=0,claimed!:()=>void;
  const claim=new Promise<void>(resolve=>{claimed=resolve;});
  const dispatch=dispatchAutomation({
    cleanup:async()=>({more:false}),
    scans:[async()=>{if(++scans>1)return false;await delay(20);queued=true;return true;}],
    run:async()=>{if(!queued)return false;queued=false;claimed();return true;},
  },controller.signal,60000);
  try{
    await Promise.race([claim,delay(1000).then(()=>{throw new Error('The queued workflow waited for the idle interval');})]);
  }finally{controller.abort();await dispatch;}
});

test('a failing workflow runner stops rule scans and reports its error',async()=>{
  const controller=new AbortController(),failure=new Error('runner failed');let scans=0;
  await assert.rejects(dispatchAutomation({
    cleanup:async()=>({more:false}),
    scans:[async()=>{scans++;await delay(1);return true;}],
    run:async()=>{await delay(20);throw failure;},
  },controller.signal,5),failure);
  const stopped=scans;await delay(30);assert.equal(scans,stopped);
});

test('aborting dispatch ends idle scan and run loops promptly',async()=>{
  const controller=new AbortController();
  const dispatch=dispatchAutomation({cleanup:async()=>({more:false}),scans:[async()=>false],run:async()=>false},controller.signal,60000);
  await delay(10);const started=performance.now();controller.abort();await dispatch;
  assert.ok(performance.now()-started<1000);
});
