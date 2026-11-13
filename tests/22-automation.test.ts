import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Actions } from '../packages/runtime/actions.js';
import { initializeActionUndo } from '../packages/runtime/action-journal.js';
import { initializeScenarioLifecycle } from '../packages/runtime/scenarios.js';
import { Automation, initializeAutomation } from '../packages/runtime/automation.js';
import { Objects } from '../packages/runtime/objects.js';
import { objectPolicySchema } from '../packages/runtime/security.js';

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
    await f.objects.edit(f.source,1,{name:'changed-after-commit'});
    await automation.retry(await Access.load(f.db,principal),f.model,run.id);await automation.runOne();
    const completed=(await f.db.query(`SELECT state,step,results FROM ${f.db.schema}.workflow_runs WHERE id=$1`,[run.id])).rows[0]!;
    assert.equal(completed.state,'completed');assert.equal(completed.step,1);assert.equal(completed.results[0].object.id,'original');
    await assert.rejects(f.objects.read({type:'Route',id:'changed-after-commit'}),/unavailable/);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.actions WHERE request_id=$1`,['workflow:'+run.id+':0'])).rows[0]!.count,1);
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
