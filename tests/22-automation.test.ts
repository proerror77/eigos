import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AgentDriver } from '../packages/runtime/agent.js';
import { PARequests } from '../packages/runtime/pa.js';
import { publicTask, type Task } from '../packages/runtime/tasks.js';
import { HotelWorkflows } from '../packages/runtime/hotel-workflows.js';
import { calendarAnswer, planningInput } from './planning-fixture.js';
import { serviceProvider } from './service-fixture.js';
import { fixture, principal } from './fixture.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Actions } from '../packages/runtime/actions.js';
import { initializeActionUndo } from '../packages/runtime/action-journal.js';
import { Scenarios, initializeScenarioLifecycle } from '../packages/runtime/scenarios.js';
import { Automation, initializeAutomation } from '../packages/runtime/automation.js';
import { Objects } from '../packages/runtime/objects.js';
import { objectPolicySchema } from '../packages/runtime/security.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import type { ObjectRef } from '../packages/ontology/schema.js';

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

test('a validated hotel task learns only after approval and replays with fresh inputs and a separate approval', async () => {
  const service = serviceProvider();
  const start = Date.now();
  const day = (n: number) => new Date(start + n * 86400000).toISOString().slice(0, 10);
  const requested = day(3), replayDate = day(5), thirdDate = day(7);
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
  const f = await fixture(driver, service.resolve);
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
    assert.equal((await hotelWorkflows.list(principal)).items.length, 1);
    const automation = new Automation(f.db, f.metadata, f.capabilities.actions);
    await assert.rejects(automation.run(f.access, f.model, { workflow: approved.workflowId,
      object: approved.plan, requestId: 'wrong-automation-runner' }), /Workflow is unavailable/);
    await assert.rejects(automation.workflow(f.access, f.model, { id: approved.workflowId, revision: 1,
      name: 'Attempt overwrite', steps: [{ name: 'One', action: 'SearchRollingGoHotels', input: {} }],
    }), /changed or is unavailable/);

    const changed = await prepare('Another rehearsal', { replayHotelWorkflow: { workflowId: approved.workflowId, checkIn: thirdDate } });
    const change = approvedBody(changed);
    service.flags.active = false;
    try { await assert.rejects(hotelWorkflows.approve(principal, change), /revoked/); }
    finally { service.flags.active = true; }
    await new Scenarios(f.db).discard(f.access, f.model, change.scenarioId, change.revision);
    await assert.rejects(hotelWorkflows.approve(principal, change), /closed|changed/);
    const safe = (await f.db.query(`SELECT
      (SELECT count(*)::int FROM ${f.db.schema}.external_operations) external_operations,
      (SELECT count(*)::int FROM ${f.db.schema}.scheduled_actions) scheduled_actions,
      (SELECT count(*)::int FROM ${f.db.schema}.action_effects) action_effects,
      (SELECT count(*)::int FROM ${f.db.schema}.objects WHERE type='ScheduledActivity') live_activities`)).rows[0];
    assert.deepEqual(safe, { external_operations: 0, scheduled_actions: 0, action_effects: 0, live_activities: 0 });
    assert.equal(f.provider.flags.orderCreates, 0);
  } finally { await f.close(); }
});
