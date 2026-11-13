import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { PlanningFixtureAgent, planningInput, calendarAnswer } from './planning-fixture.js';
import { Scenarios, initializeScenarioLifecycle } from '../packages/runtime/scenarios.js';
import { initializeActionUndo } from '../packages/runtime/action-journal.js';
import { scenarioObjectType } from '../packages/ontology/scenario-definition.js';
import { scenarioMetadataRead, scenarioMetadataQuery } from '../packages/runtime/scenario-metadata.js';
import { Objects } from '../packages/runtime/objects.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { PARequests } from '../packages/runtime/pa.js';
import { OntologyClient, OntologyHttpError } from '../packages/sdk/client.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { Effects, type EffectHandler } from '../packages/runtime/effects.js';
import { Actions } from '../packages/runtime/actions.js';

async function lifecycleFixture(driver=new PlanningFixtureAgent()){
  const f=await fixture(driver);
  await initializeScenarioLifecycle(f.db);await initializeActionUndo(f.db);
  const document=structuredClone(f.model.document);
  if(!document.objectTypes.some(type=>type.apiName==='OntologyScenario'))document.objectTypes.push(scenarioObjectType);
  const model=await f.metadata.publish(document,f.capabilities,f.publisher);
  await setGrants(f.db,principal.owner,memberGrants(model));
  const access=await Access.load(f.db,principal);
  return {...f,model,access,scenarios:new Scenarios(f.db)};
}

test('temporary scenarios are bound to owned sessions and close and TTL cleanup remove their deltas',async()=>{
  const f=await lifecycleFixture();try{
    const session=await f.scenarios.openSession(f.access),scene=await f.scenarios.create(f.access,f.model,{requestId:'temporary',name:'Temporary',kind:'temporary',sessionId:session.id});
    const view=await f.scenarios.view(f.access,f.model,scene.id);
    await new Objects(f.db,view,f.access).create({type:'Route',id:'temporary-route'},{id:'temporary-route',name:'Private draft'});
    await assert.rejects(f.scenarios.create(await Access.load(f.db,{...principal,owner:'another'}),f.model,{requestId:'other',name:'Other',kind:'temporary',sessionId:session.id}),/Permission|session/);
    await f.scenarios.closeSession(f.access,session.id);await f.scenarios.closeSession(f.access,session.id);
    await assert.rejects(f.scenarios.view(f.access,f.model,scene.id),/unavailable/);
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.scenario_objects WHERE scenario_id=$1`,[scene.id])).rows[0]!.n,0);
    const expiring=await f.scenarios.create(f.access,f.model,{requestId:'expiry',name:'Expired'});
    await f.db.query(`UPDATE ${f.db.schema}.scenarios SET expires_at=now()-interval '1 second' WHERE id=$1`,[expiring.id]);
    assert.equal((await f.scenarios.cleanup()).deleted,1);
  }finally{await f.close();}
});

test('persisted scenario metadata can be shared and revoked without sharing private proposal data',async()=>{
  const f=await lifecycleFixture();try{
    const scene=await f.scenarios.create(f.access,f.model,{requestId:'shared',name:'Shared proposal',description:'Compare alternatives'});
    await setGrants(f.db,'reader',memberGrants(f.model));
    const peer=await Access.load(f.db,{...principal,owner:'reader'}),peerGraph=new Objects(f.db,f.model,peer);
    assert.equal((await scenarioMetadataQuery(peerGraph,{type:'OntologyScenario'})).items.length,0);
    const shared=await f.scenarios.share(f.access,f.model,scene.id,1,['reader']);
    const metadata=await scenarioMetadataRead(peerGraph,{type:'OntologyScenario',id:scene.id});
    assert.equal(metadata.properties.description,'Compare alternatives');
    assert.equal((await scenarioMetadataQuery(peerGraph,{type:'OntologyScenario',where:{name:'Shared proposal'}})).items.length,1);
    await assert.rejects(f.scenarios.view(peer,f.model,scene.id),/unavailable/);
    await f.scenarios.share(f.access,f.model,scene.id,shared.revision,[]);
    await assert.rejects(scenarioMetadataRead(peerGraph,{type:'OntologyScenario',id:scene.id}),/unavailable/);
  }finally{await f.close();}
});

test('Action compensation restores edits once and rejects newer object revisions',async()=>{
  const f=await lifecycleFixture();try{
    const document=structuredClone(f.model.document);
    document.actionTypes.push({apiName:'RenameRoute',description:'Rename a route',parameters:{type:'object',properties:{route:{type:'object',properties:{type:{type:'string'},id:{type:'string'}},required:['type','id'],additionalProperties:false},revision:{type:'integer'},name:{type:'string'}},required:['route','revision','name'],additionalProperties:false},objectParameters:{route:'Route'},submissionCriteria:[],rules:[{op:'editObject',object:{parameter:'route'},expectedRevision:{parameter:'revision'},properties:{name:{parameter:'name'}}}],result:{type:'Route',id:{parameter:'route',path:['id']}}});
    const model=await f.metadata.publish(document,f.capabilities,f.publisher);
    await setGrants(f.db,principal.owner,memberGrants(model));const access=await Access.load(f.db,principal),graph=new Objects(f.db,model,access),ref={type:'Route',id:'undo'};
    await graph.create(ref,{id:ref.id,name:'Before'});
    await f.capabilities.actions.apply(access,model,'RenameRoute',{route:ref,revision:1,name:'After'},'rename');
    const undone=await f.capabilities.actions.undo(access,model,'rename','undo-rename');
    assert.equal((await graph.read(ref)).properties.name,'Before');assert.equal(undone.externalEffectsReversed,false);
    assert.deepEqual(await f.capabilities.actions.undo(access,model,'rename','undo-rename'),undone);
    await assert.rejects(f.capabilities.actions.undo(access,model,'rename','another-undo'),/already undone/);
    const latest=await graph.read(ref);
    await f.capabilities.actions.apply(access,model,'RenameRoute',{route:ref,revision:latest.revision,name:'Second'},'rename-again');
    await graph.edit(ref,(await graph.read(ref)).revision,{name:'Newer user edit'});
    await assert.rejects(f.capabilities.actions.undo(access,model,'rename-again','late-undo'),/changed after/);
    assert.equal((await graph.read(ref)).properties.name,'Newer user edit');
  }finally{await f.close();}
});

test('undo cancels pending effects atomically and rejects an effect already in flight',async()=>{
  const f=await lifecycleFixture();let finish:()=>void=()=>{};try{
    let entered:()=>void=()=>{},delivered=0;
    const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
    const handlers=new Map<string,EffectHandler>([['Notice',async()=>{delivered++;entered();await gate;}]]);
    const capabilities=createCapabilities(f.db,f.source,{effects:handlers}),document=structuredClone(f.model.document);
    document.actionTypes.push({apiName:'CreateUndoRoute',description:'Create and notify',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},objectParameters:{},submissionCriteria:[],rules:[{op:'createObject',object:{type:'Route',id:{parameter:'id'}},properties:{id:{parameter:'id'},name:{literal:'New route'}}}],result:{type:'Route',id:{parameter:'id'}},effects:[{name:'Notice',handler:'Notice',payload:{id:{parameter:'id'}}}]});
    const model=await f.metadata.publish(document,capabilities,f.publisher);
    await setGrants(f.db,principal.owner,memberGrants(model));const access=await Access.load(f.db,principal),effects=new Effects(f.db,handlers),actions=new Actions(f.db,capabilities.functions,effects);
    await actions.apply(access,model,'CreateUndoRoute',{id:'pending'},'pending');
    const result=await actions.undo(access,model,'pending','undo-pending');assert.equal(result.pendingEffectsCanceled,1);
    assert.equal((await effects.status(access,'pending'))[0]!.state,'canceled');assert.equal(await effects.runOne(),false);assert.equal(delivered,0);
    await actions.apply(access,model,'CreateUndoRoute',{id:'working'},'working');
    const running=effects.runOne();await started;
    await assert.rejects(actions.undo(access,model,'working','undo-working'),/in flight/);
    finish();await running;
    const completed=await actions.undo(access,model,'working','undo-working');assert.equal(completed.externalEffectsReversed,false);assert.equal(delivered,1);
  }finally{finish();await f.close();}
});

test('declarative struct edits, scoped scenario merge, unlink and deletion use atomic Action entrypoints',async()=>{
  const f=await lifecycleFixture();try{
    const document=structuredClone(f.model.document);
    document.objectTypes.find(type=>type.apiName==='Route')!.properties.details={description:'Route details',schema:{type:'object',properties:{x:{type:'number'},y:{type:'number'}},required:['x','y'],additionalProperties:false},required:false};
    const object={type:'object',properties:{type:{type:'string'},id:{type:'string'}},required:['type','id'],additionalProperties:false};
    document.actionTypes.push({apiName:'EditDetails',description:'Edit one struct field',parameters:{type:'object',properties:{route:object,revision:{type:'integer'},x:{type:'number'}},required:['route','revision','x'],additionalProperties:false},objectParameters:{route:'Route'},submissionCriteria:[],rules:[{op:'editStruct',object:{parameter:'route'},expectedRevision:{parameter:'revision'},property:'details',fields:{x:{parameter:'x'}}}],result:{type:'Route',id:{parameter:'route',path:['id']}}});
    document.actionTypes.push({apiName:'MergeRoutes',description:'Merge reviewed route changes',parameters:{type:'object',properties:{scenarioId:{type:'string'},revision:{type:'integer'},route:object},required:['scenarioId','revision','route'],additionalProperties:false},objectParameters:{},submissionCriteria:[],rules:[{op:'applyScenario',scenario:{parameter:'scenarioId'},expectedRevision:{parameter:'revision'},objectTypes:['Route'],linkTypes:[]}],result:{type:'Route',id:{parameter:'route',path:['id']}}});
    document.actionTypes.push({apiName:'DeleteRoute',description:'Delete a route',parameters:{type:'object',properties:{route:object,revision:{type:'integer'}},required:['route','revision'],additionalProperties:false},objectParameters:{route:'Route'},submissionCriteria:[],rules:[{op:'deleteObject',object:{parameter:'route'},expectedRevision:{parameter:'revision'}}],result:{type:'Route',id:{parameter:'route',path:['id']}}});
    document.actionTypes.push({apiName:'UnlinkRequest',description:'Remove the request route relation',parameters:{type:'object',properties:{route:object,request:object},required:['route','request'],additionalProperties:false},objectParameters:{route:'Route',request:'RideRequest'},submissionCriteria:[],rules:[{op:'removeLink',link:'RequestRoute',from:{type:'RideRequest',id:{parameter:'request',path:['id']}},to:{type:'Route',id:{parameter:'route',path:['id']}}}],result:{type:'Route',id:{parameter:'route',path:['id']}}});
    const model=await f.metadata.publish(document,f.capabilities,f.publisher);
    await setGrants(f.db,principal.owner,memberGrants(model));const access=await Access.load(f.db,principal),graph=new Objects(f.db,model,access),route={type:'Route',id:'rules'};
    await graph.create(route,{id:route.id,name:'Rules',details:{x:1,y:2}});
    const scenario=await f.scenarios.create(access,model,{requestId:'rules',name:'Rules'}),view=await f.scenarios.view(access,model,scenario.id);
    await f.capabilities.actions.apply(access,view,'EditDetails',{route,revision:1,x:3},'edit-details');
    assert.deepEqual((await graph.read(route)).properties.details,{x:1,y:2});
    const inspected=await f.scenarios.inspect(access,model,scenario.id);
    await f.capabilities.actions.apply(access,model,'MergeRoutes',{route,scenarioId:scenario.id,revision:inspected.revision},'merge-rules');
    assert.deepEqual((await graph.read(route)).properties.details,{x:3,y:2});
    const request={type:'RideRequest',id:'unlink-request'};
    await graph.create(request,{id:request.id,name:'Unlink',status:'requested',requestedAt:new Date().toISOString()});
    await graph.link({type:'RequestRoute',from:request,to:route});
    await f.capabilities.actions.apply(access,model,'UnlinkRequest',{route,request},'unlink-request');
    assert.equal((await graph.follow(request,'route')).length,0);
    await f.capabilities.actions.undo(access,model,'unlink-request','restore-link');
    assert.equal((await graph.follow(request,'route')).length,1);
    await f.capabilities.actions.apply(access,model,'DeleteRoute',{route,revision:2},'delete-rules');
    await assert.rejects(graph.read(route),/unavailable/);
    await f.capabilities.actions.undo(access,model,'delete-rules','restore-rules');
    assert.deepEqual((await graph.read(route)).properties.details,{x:3,y:2});
    assert.equal((await graph.follow(request,'route')).length,1);
  }finally{await f.close();}
});

class ReplanningDriver extends PlanningFixtureAgent {
  override async run(prompt:string,tools:Parameters<PlanningFixtureAgent['run']>[1]){
    const task=JSON.parse(prompt.split('\n').at(-1)!),input=JSON.parse(task.userRequest.message).planning;
    if(!input.plan)return super.run(prompt,tools);
    const scene=await tools.get('create_scenario')!.invoke({requestId:'replan',name:'Replanned alternative'}) as {id:string};
    const plan=await tools.get('apply_action')!.invoke({action:'PrepareSchedulePlan',input:{...input,scenarioId:scene.id}}) as ObjectRef;
    if(!plan.id)return;
    const query=await tools.get('query_ontology')!.invoke({scenarioId:scene.id,queries:[{type:'ScheduledActivity',from:{object:plan,link:'activities'}}]}) as {items:{ref:ObjectRef;revision:number}[]}[];
    const activity=query[0]!.items[0]!;
    const slots=await tools.get('evaluate_function')!.invoke({scenarioId:scene.id,function:'findScheduleSlots',input:{plan,ignoreActivity:activity.ref}}) as {slots:{start:string;end:string}[]};
    await tools.get('apply_action')!.invoke({scenarioId:scene.id,action:'SaveScheduleActivity',input:{plan,id:'meeting',revision:activity.revision,name:'Moved meeting',...slots.slots[0]}});
    await tools.get('complete_with_function')!.invoke({scenarioId:scene.id,function:'readSchedulePlan',input:{plan}});
  }
}
async function planTask(f:Awaited<ReturnType<typeof lifecycleFixture>>,input:ReturnType<typeof planningInput>&{plan?:ObjectRef},requestId:string){
  const task=await f.tasks.submit(principal,{requestId,message:JSON.stringify({planning:input})});await f.worker.runOne();
  const pending=await f.tasks.get(principal,task.id);assert.equal(pending.state,'input-required',JSON.stringify(pending));
  const request=pending.result as {requestId:string};
  await new PARequests(f.tasks).respond(principal,task.id,{requestId:request.requestId,response:calendarAnswer(input)});await f.worker.runOne();
  const done=await f.tasks.get(principal,task.id);assert.equal(done.state,'completed',JSON.stringify(done));
  return done.result as {plan:{ref:ObjectRef;properties:Record<string,unknown>};scenarioId:string;validation:{valid:boolean}};
}
test('replanning and discarding preserve the live plan and reviewed merge changes its coverage atomically',async()=>{
  const f=await lifecycleFixture(new ReplanningDriver());try{
    const first=await planTask(f,planningInput(),'initial');
    const initial=await f.scenarios.inspect(f.access,f.model,first.scenarioId);
    await f.capabilities.actions.apply(f.access,f.model,'CommitSchedulePlan',{plan:first.plan.ref,scenarioId:initial.id,revision:initial.revision},'initial-merge');
    const graph=new Objects(f.db,f.model,f.access),before=await graph.read(first.plan.ref),snapshot=(await graph.follow(first.plan.ref,'availability'))[0]!;
    const start=Date.parse(String(before.properties.end))+3600000;
    const input={...planningInput(),title:'Candidate plan',start:new Date(start).toISOString(),end:new Date(start+14400000).toISOString(),plan:first.plan.ref};
    const draft=await planTask(f,input,'replan-discard');
    assert.equal(draft.validation.valid,true);assert.deepEqual(await graph.read(first.plan.ref),before);
    assert.deepEqual((await graph.follow(first.plan.ref,'availability'))[0],snapshot);
    const inspected=await f.scenarios.inspect(f.access,f.model,draft.scenarioId);await f.scenarios.discard(f.access,f.model,inspected.id,inspected.revision);
    assert.deepEqual(await graph.read(first.plan.ref),before);
    const selected=await planTask(f,input,'replan-merge'),reviewed=await f.scenarios.inspect(f.access,f.model,selected.scenarioId);
    await f.capabilities.actions.apply(f.access,f.model,'CommitSchedulePlan',{plan:first.plan.ref,scenarioId:reviewed.id,revision:reviewed.revision},'reviewed-replan');
    assert.equal((await graph.read(first.plan.ref)).properties.name,'Candidate plan');
    assert.equal((await graph.follow(first.plan.ref,'availability'))[0]!.properties.start,input.start);
  }finally{await f.close();}
});

test('past proposed slots are reported and rejected by final merge',async()=>{
  const f=await lifecycleFixture();try{
    const now=Date.now(),input={...planningInput(),start:new Date(now-2*3600000).toISOString(),end:new Date(now+2*3600000).toISOString()};
    const first=await planTask(f,input,'past-window'),scenario=await f.scenarios.create(f.access,f.model,{requestId:'past-slot',name:'Past slot'});
    const view=await f.scenarios.view(f.access,f.model,scenario.id);
    await f.capabilities.actions.apply(f.access,view,'SaveScheduleActivity',{plan:first.plan.ref,id:'past',name:'Past',start:new Date(now-50*60000).toISOString(),end:new Date(now-20*60000).toISOString()},'save-past');
    const validation=await f.capabilities.functions.invoke(view,'validateSchedule',{plan:first.plan.ref},{principal,objects:new Objects(f.db,view,f.access),signal:AbortSignal.timeout(5000)}) as {valid:boolean;violations:{code:string}[]};
    assert.equal(validation.valid,false);assert(validation.violations.some(item=>item.code==='activity_in_past'));
    const inspected=await f.scenarios.inspect(f.access,f.model,scenario.id);
    await assert.rejects(f.capabilities.actions.apply(f.access,f.model,'CommitSchedulePlan',{plan:first.plan.ref,scenarioId:scenario.id,revision:inspected.revision},'merge-past'),/constraints/);
    assert.equal((await new Objects(f.db,f.model,f.access).query({type:'ScheduledActivity'})).items.length,0);
  }finally{await f.close();}
});

test('returned activity references support rescheduling without the original creation identifier',async()=>{
  const f=await lifecycleFixture();try{
    const first=await planTask(f,planningInput(),'reference-edit');
    const view=await f.scenarios.view(f.access,f.model,first.scenarioId),graph=new Objects(f.db,view,f.access);
    const activity=(await graph.follow(first.plan.ref,'activities'))[0]!;
    const start=new Date(Date.parse(String(activity.properties.start))+3600000).toISOString(),end=new Date(Date.parse(String(activity.properties.end))+3600000).toISOString();
    const input={plan:first.plan.ref,id:activity.ref.id,activity:activity.ref,revision:activity.revision,name:'Moved by reference',start,end};
    const updated=await f.capabilities.actions.apply(f.access,view,'SaveScheduleActivity',input,'move-reference');
    assert.deepEqual(updated,activity.ref);
    assert.equal((await graph.read(activity.ref)).properties.start,start);
    assert.equal((await graph.follow(first.plan.ref,'activities')).length,1);
    await assert.rejects(f.capabilities.actions.apply(f.access,view,'SaveScheduleActivity',{...input,revision:undefined},'missing-revision'),/requires its current revision/);
    await assert.rejects(f.capabilities.actions.apply(f.access,view,'SaveScheduleActivity',{...input,activity:{type:'Route',id:activity.ref.id}},'wrong-type'),/ScheduledActivity/);
    const other=await planTask(f,planningInput(),'different-plan');
    await assert.rejects(f.capabilities.actions.apply(f.access,view,'SaveScheduleActivity',{...input,plan:other.plan.ref,revision:activity.revision+1},'wrong-plan'),/does not belong/);
  }finally{await f.close();}
});

test('typed scenario SDK scopes HTTP calls and propagates service errors',async()=>{
  const calls:{url:string;body:any;token:string|null}[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    calls.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):null,token:new Headers(init?.headers).get('Authorization')});
    if(String(url).endsWith('/discard'))return new Response(JSON.stringify({error:'Scenario revision changed'}),{status:409});
    return new Response(JSON.stringify({items:[],id:'scenario'}),{status:200});
  };
  const client=new OntologyClient({baseUrl:'https://example.test/',token:async()=>'host-token',fetch:fetcher}),scenario=client.scenario('scenario','session');
  await scenario.query({type:'Route'});await scenario.evaluate('readSchedulePlan',{plan:{type:'SchedulePlan',id:'plan'}});
  await scenario.merge('CommitSchedulePlan','merge',3,{plan:{type:'SchedulePlan',id:'plan'}});
  await scenario.closeSession();
  assert(calls.every(call=>call.token==='Bearer host-token'));
  assert.equal(calls[0]!.body.scenarioId,'scenario');assert.equal(calls[2]!.body.scenarioId,undefined);
  assert.equal(calls[2]!.body.input.revision,3);assert.equal(calls[3]!.body.sessionId,'session');
  await assert.rejects(scenario.discard(2),error=>error instanceof OntologyHttpError&&error.status===409);
});
