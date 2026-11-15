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
import { HotelWorkflows } from '../packages/runtime/hotel-workflows.js';
import { calendarAnswer, planningInput } from './planning-fixture.js';
import { serviceProvider } from './service-fixture.js';
import { document, fixture, principal } from './fixture.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
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
import { calendarJourneyDefinition } from '../packages/ontology/calendar-journey.js';
import { deliveryFunctions } from '../packages/ontology/delivery.js';
import { dianpingResearchFunctions } from '../packages/ontology/dianping.js';
import { diningReservations } from '../packages/ontology/dining-reservations.js';
import { documentDefinition } from '../packages/ontology/documents.js';
import { flightDefinition } from '../packages/ontology/flight.js';
import { flightPositionFunction } from '../packages/ontology/flight-position.js';
import { locationFunctions, taskLocationValueType } from '../packages/ontology/location.js';
import { luckinDefinition } from '../packages/ontology/luckin.js';
import { mapFunctions } from '../packages/ontology/maps.js';
import { rideWatchDefinition, rideWatchType } from '../packages/ontology/ride-watch.js';
import { fliggyServicesDefinition } from '../packages/ontology/services.js';
import { checkWorkflowDependencies } from '../packages/runtime/workflow-compatibility.js';

async function setup() {
  const f=await fixture();await initializeActionUndo(f.db);await initializeScenarioLifecycle(f.db);await initializeAutomation(f.db);
  const document=structuredClone(f.model.document);
  document.actionTypes.push({apiName:'CopyRoute',description:'Copy an authorized route name into a new Route',parameters:{type:'object',properties:{id:{type:'string'},name:{type:'string'},tag:{type:'string',default:'copied'}},required:['id','name'],additionalProperties:false},objectParameters:{},submissionCriteria:[],rules:[{op:'createObject',object:{type:'Route',id:{parameter:'id'}},properties:{id:{parameter:'id'},name:{parameter:'name'}}}],result:{type:'Route',id:{parameter:'id'}}});
  document.actionTypes.push({apiName:'RenameRoute',description:'Rename the selected route',parameters:{type:'object',properties:{route:{type:'object',properties:{type:{type:'string'},id:{type:'string'}},required:['type','id'],additionalProperties:false},revision:{type:'integer'},name:{type:'string'}},required:['route','revision','name'],additionalProperties:false},objectParameters:{route:'Route'},submissionCriteria:[],rules:[{op:'editObject',object:{parameter:'route'},expectedRevision:{parameter:'revision'},properties:{name:{parameter:'name'}}}],result:{type:'Route',id:{parameter:'route',path:['id']}}});
  const model=await f.metadata.publish(document,f.capabilities,f.publisher);await setGrants(f.db,principal.owner,memberGrants(model));
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
  await setGrants(f.db,principal.owner,memberGrants(model));
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
    const model=await f.metadata.publish(document,capabilities,f.publisher);await setGrants(f.db,principal.owner,memberGrants(model));
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
    await setGrants(f.db,principal.owner,memberGrants(f.model).filter(grant=>grant.permission!=='view_objects'));
    assert.equal(await f.automation.scanOne(),true);
    const row=(await f.db.query(`SELECT enabled,error,last_scan FROM ${f.db.schema}.object_rules WHERE id=$1`,[rule.id])).rows[0]!;
    assert.equal(row.enabled,false);assert.match(row.error,/scan failed/);assert(row.last_scan);
    assert.equal(await f.automation.scanOne(),false);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.workflow_runs`)).rows[0]!.count,0);
  }finally{await f.close();}
});

async function processSetup() {
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
    const model = await f.metadata.publish(definition, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, memberGrants(model));
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

test('process rules deliver each committed matching transition between polls and replay checkpoints without duplicates',async()=>{
  const f = await processSetup();
  try {
    await f.change('open');
    await f.change('stalled');
    await f.change('open');
    const rule = await f.automation.rule(f.access, f.model, {name:'Each stall',workflow:f.workflow.id,
      process:{type:'RouteStateLog',from:'open',to:'stalled'},enabled:true});
    const initial = (await f.db.query(`SELECT process_cursor::text FROM ${f.db.schema}.object_rules WHERE id=$1`, [rule.id])).rows[0]!.process_cursor;
    await f.change('stalled');
    await f.change('open');
    await f.change('stalled');
    await f.change('done');
    assert.deepEqual((await Promise.all([f.automation.scanOne(),f.automation.scanOne()])).sort(), [false,true]);
    const first = await f.runs();
    assert.equal(first.length, 2);
    assert.notEqual(first[0]!.process_trigger.sequence, first[1]!.process_trigger.sequence);
    assert(first.every(row=>row.request_id.startsWith('process-rule:')));
    await f.db.query(`UPDATE ${f.db.schema}.object_rules SET process_cursor=$2,last_scan=NULL WHERE id=$1`, [rule.id,initial]);
    assert.equal(await f.automation.scanOne(), true);
    assert.deepEqual(await f.runs(), first);
    assert.equal(await f.automation.runOne(), true);
    assert.equal(await f.automation.runOne(), true);
    assert.deepEqual((await f.runs()).map(row=>row.state), ['completed','completed']);
    assert.equal(await f.automation.runOne(), false);
  } finally { await f.close(); }
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
    await setGrants(f.db, principal.owner, memberGrants(f.model).filter(grant=>grant.resource!=='Eigos/object/RouteStateLog' || grant.permission!=='view_objects'));
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
  const laterDomains = [calendarJourneyDefinition, flightDefinition, luckinDefinition, documentDefinition, fliggyServicesDefinition, diningReservations];
  const addedTypes = new Set([
    ...laterDomains.flatMap(domain => domain.objectTypes.map(type => type.apiName)), 'ActionConfirmation', rideWatchType,
  ]);
  const model = new Ontology(document);
  const logs = document.objectTypes.flatMap(type => processLogTarget(model, type.apiName) ?? []);
  const addedLogs = logs.filter(log => addedTypes.has(log.objectType));
  const addedActions = new Set(laterDomains.flatMap(domain => domain.actionTypes.map(action => action.apiName)));
  addedActions.add('StageDiningActivity');
  const addedFunctions = new Set([
    ...laterDomains.flatMap(domain => domain.functionTypes), ...deliveryFunctions, ...locationFunctions, ...mapFunctions, ...dianpingResearchFunctions, flightPositionFunction,
  ].map(fn => fn.apiName));
  for (const name of ['stageDiningActivity', 'searchRestaurantNotes', 'readWeatherHistory', 'readDiningAvailability']) addedFunctions.add(name);
  addedActions.add('EstimateRideWithPlaceClues');
  for (const action of rideWatchDefinition.actionTypes) addedActions.add(action.apiName);
  for (const fn of rideWatchDefinition.functionTypes) addedFunctions.add(fn.apiName);
  addedFunctions.add('prepareRideInquiryWithPlaceClues');
  addedFunctions.add('readInteractiveRideEstimate');
  const v9Definition = structuredClone(document);
  v9Definition.version = '9';
  v9Definition.interfaceTypes = v9Definition.interfaceTypes.filter(type => type.apiName !== 'RideInquiryWithPlaceClues' &&
    !fliggyServicesDefinition.interfaceTypes.some(item => item.apiName === type.apiName));
  delete v9Definition.objectTypes.find(type => type.apiName === 'RideRequest')!.interfaces.RideInquiryWithPlaceClues;
  v9Definition.objectTypes = v9Definition.objectTypes.filter(type => !addedTypes.has(type.apiName) && !addedLogs.some(log => log.type === type.apiName));
  delete v9Definition.objectTypes.find(type => type.apiName === 'ScheduledActivity')!.properties.dining;
  const routeProperties = v9Definition.objectTypes.find(type => type.apiName === 'Route')!.properties;
  delete routeProperties.pickup;
  delete routeProperties.drivingEstimate;
  v9Definition.linkTypes = v9Definition.linkTypes.filter(type =>
    !addedLogs.some(log => log.link === type.apiName) && !documentDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !rideWatchDefinition.linkTypes.some(link => link.apiName === type.apiName) &&
    !fliggyServicesDefinition.linkTypes.some(link => link.apiName === type.apiName));
  v9Definition.dataSources = v9Definition.dataSources.filter(source => !fliggyServicesDefinition.dataSources.some(item => item.apiName === source.apiName));
  v9Definition.actionTypes = v9Definition.actionTypes.filter(action => !addedActions.has(action.apiName));
  v9Definition.functionTypes = v9Definition.functionTypes.filter(fn => !addedFunctions.has(fn.apiName));
  v9Definition.functionTypes.find(fn => fn.apiName === 'resolveRideLocations')!.description =
    'Resolve each venue by querying exact Location.name within its source receipt. One exact match resolves even when other entrances or nearby shops were returned. Multiple exact matches or no exact match require clarification. Explicit selections must belong to the corresponding source response.';
  v9Definition.valueTypes = v9Definition.valueTypes?.filter(type => type.apiName !== taskLocationValueType.apiName);
  v9Definition.typeGroups = v9Definition.typeGroups?.filter(group => group.apiName !== 'Documents');
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
      const review = (publicTask(task).result as { hotelWorkflow: { scenarioId: string; revision: number; snapshot: string } }).hotelWorkflow;
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
    await setGrants(f.db, principal.owner, memberGrants(f.model).filter(g => g.resource !== 'Eigos/action/CommitSchedulePlan'));
    await assert.rejects(hotelWorkflows.approve(principal, first), /Permission required: apply_action/);
    await setGrants(f.db, principal.owner, memberGrants(f.model));
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
    await setGrants(f.db, principal.owner, memberGrants(v9));
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
    await setGrants(f.db, principal.owner, memberGrants(currentModel));
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
    await setGrants(f.db, reviewer.owner, memberGrants(f.model));
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
      await setGrants(f.db, principal.owner, memberGrants(f.model).filter(grant =>
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
    await setGrants(f.db, reviewer.owner, memberGrants(f.model));
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
