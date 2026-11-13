import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,principal} from './fixture.js';
import {PlanningFixtureAgent,planningInput,calendarAnswer} from './planning-fixture.js';
import {PARequests} from '../packages/runtime/pa.js';
import {Objects} from '../packages/runtime/objects.js';
import {Scenarios} from '../packages/runtime/scenarios.js';
import {Access,setGrants,memberGrants} from '../packages/runtime/access.js';

async function pending(f:Awaited<ReturnType<typeof fixture>>) {
 const input=planningInput(),task=await f.tasks.submit(principal,{requestId:'planning',message:JSON.stringify({planning:input})});
 await f.worker.runOne();const waiting=await f.tasks.get(principal,task.id);
 assert.equal(waiting.state,'input-required',JSON.stringify(waiting));
 const request=waiting.result as {kind:string;requestId:string;capability:string;responseSchema:unknown};
 assert.equal(request.kind,'pa-request');assert.equal(request.capability,'calendar.freebusy');
 return {input,task,request};
}
async function proposed(f:Awaited<ReturnType<typeof fixture>>) {
 const p=await pending(f);await new PARequests(f.tasks).respond(principal,p.task.id,{requestId:p.request.requestId,response:calendarAnswer(p.input)});
 await f.worker.runOne();const task=await f.tasks.get(principal,p.task.id);assert.equal(task.state,'completed',JSON.stringify(task));
 const result=task.result as {plan:{ref:{type:string;id:string}};activities:{ref:{type:string;id:string};revision:number;properties:{start:string;end:string}}[];scenarioId:string;validation:{valid:boolean;calendarEvidence:{evidence:string}[]};externalCalendarUpdated:boolean};
 return {...p,result};
}
test('PA calendar requests resume the same task and produce feasible isolated scenarios',async()=>{
 const f=await fixture(new PlanningFixtureAgent());try{
  const p=await proposed(f);assert.equal(p.result.validation.valid,true);assert.equal(p.result.validation.calendarEvidence[0]!.evidence,'synthetic');assert.equal(p.result.externalCalendarUpdated,false);
  assert.equal(Date.parse(p.result.activities[0]!.properties.start),Date.parse(p.input.start)+3600000);
  assert.equal((await new Objects(f.db,f.model,f.access).query({type:'ScheduledActivity'})).items.length,0);
  assert.equal(f.provider.calls.length,0);
  const diff=await new Scenarios(f.db).inspect(f.access,f.model,p.result.scenarioId);
  await f.capabilities.actions.apply(f.access,f.model,'CommitSchedulePlan',{plan:p.result.plan.ref,scenarioId:p.result.scenarioId,revision:Number(diff.revision)},'approved-merge');
  assert.equal((await new Objects(f.db,f.model,f.access).query({type:'ScheduledActivity'})).items.length,1);
 }finally{await f.close();}
});

test('PA response ownership, exact retry and cancellation are enforced',async()=>{
 const f=await fixture(new PlanningFixtureAgent());try{
  const p=await pending(f),pa=new PARequests(f.tasks),raw={requestId:p.request.requestId,response:calendarAnswer(p.input)};
  await assert.rejects(pa.respond({...principal,owner:'other'},p.task.id,raw),/unavailable/);
  await pa.respond(principal,p.task.id,raw);await pa.respond(principal,p.task.id,raw);
  await assert.rejects(pa.respond(principal,p.task.id,{...raw,response:{...raw.response,sourceVersion:'changed'}}),/different content/);
  await f.tasks.cancel(principal,p.task.id);assert.equal((await f.tasks.get(principal,p.task.id)).state,'canceled');
 }finally{await f.close();}
});

test('denied, incomplete and stale calendar data cannot become an empty free calendar',async()=>{
 for(const kind of ['denied','incomplete','stale'] as const){
  const f=await fixture(new PlanningFixtureAgent());try{
   const p=await pending(f),response=kind==='stale'?{...calendarAnswer(p.input),observedAt:new Date(Date.now()-600000).toISOString()}: {status:kind,reason:'Synthetic refusal'};
   await new PARequests(f.tasks).respond(principal,p.task.id,{requestId:p.request.requestId,response});await f.worker.runOne();
   assert.equal((await f.tasks.get(principal,p.task.id)).state,'failed');assert.equal((await new Objects(f.db,f.model,f.access).query({type:'ScheduledActivity'})).items.length,0);
  }finally{await f.close();}
 }
});

test('merge revalidates live calendar changes and preserves the unmerged proposal',async()=>{
 const f=await fixture(new PlanningFixtureAgent());try{
  const p=await proposed(f),live=new Objects(f.db,f.model,f.access),s=new Scenarios(f.db),diff=await s.inspect(f.access,f.model,p.result.scenarioId);
  const snapshot=(await live.query({type:'CalendarAvailability'})).items[0]!;
  await live.edit(snapshot.ref,snapshot.revision,{busy:[{start:p.input.start,end:p.input.end}],sourceVersion:'calendar-changed'});
  const args={plan:p.result.plan.ref,scenarioId:p.result.scenarioId,revision:Number(diff.revision)};
  await assert.rejects(f.capabilities.actions.apply(f.access,f.model,'CommitSchedulePlan',args,'conflicting-merge'),/constraints/);
  assert.equal((await live.query({type:'ScheduledActivity'})).items.length,0);assert.equal((await s.inspect(f.access,f.model,p.result.scenarioId)).state,'open');
 }finally{await f.close();}
});

test('merge requires the reviewed revision and current source and action permissions',async()=>{
 const f=await fixture(new PlanningFixtureAgent());try{
  const p=await proposed(f),s=new Scenarios(f.db),d=await s.inspect(f.access,f.model,p.result.scenarioId);
  const args={plan:p.result.plan.ref,scenarioId:p.result.scenarioId,revision:Number(d.revision)-1};
  await assert.rejects(f.capabilities.actions.apply(f.access,f.model,'CommitSchedulePlan',args,'old-review'),/changed after review/);
  await setGrants(f.db,principal.owner,memberGrants(f.model).filter(g=>g.resource!=='Eigos/source/PACalendar'));
  await assert.rejects(f.capabilities.actions.apply(await Access.load(f.db,principal),f.model,'CommitSchedulePlan',{...args,revision:Number(d.revision)},'revoked-source'),/Permission/);
  assert.equal((await f.tasks.get(principal,p.task.id)).result,null);
 }finally{await f.close();}
});

test('concurrent scenario merges cannot reserve the same resource twice',async()=>{
 const f=await fixture(new PlanningFixtureAgent());try{
  const p=await proposed(f),s=new Scenarios(f.db),b=await s.create(f.access,f.model,{requestId:'competing',name:'Competing plan'}),view=await s.view(f.access,f.model,b.id);
  const activity=p.result.activities[0]!;
  await f.capabilities.actions.apply(f.access,view,'SaveScheduleActivity',{plan:p.result.plan.ref,id:'competing-meeting',name:'Other meeting',start:activity.properties.start,end:activity.properties.end},'competing-activity');
  const [aDiff,bDiff]=await Promise.all([s.inspect(f.access,f.model,p.result.scenarioId),s.inspect(f.access,f.model,b.id)]);
  const outcomes=await Promise.allSettled([aDiff,bDiff].map((d,i)=>f.capabilities.actions.apply(f.access,f.model,'CommitSchedulePlan',{plan:p.result.plan.ref,scenarioId:d.id,revision:d.revision},'competing-merge-'+i)));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);
  assert.equal((await new Objects(f.db,f.model,f.access).query({type:'ScheduledActivity'})).items.length,1);
 }finally{await f.close();}
});

test('scenario conflicts are visible and rescheduling considers activity dependencies',async()=>{
 const f=await fixture(new PlanningFixtureAgent());try{
  const p=await proposed(f),s=new Scenarios(f.db),view=await s.view(f.access,f.model,p.result.scenarioId),context={principal,objects:new Objects(f.db,view,f.access),signal:AbortSignal.timeout(5000)};
  const first=p.result.activities[0]!,start=first.properties.start,end=first.properties.end;
  const second=await f.capabilities.actions.apply(f.access,view,'SaveScheduleActivity',{plan:p.result.plan.ref,id:'dependent',name:'Dependent meeting',start,end,predecessors:[first.ref]},'dependency-conflict');
  const result=await f.capabilities.functions.invoke(view,'validateSchedule',{plan:p.result.plan.ref},context) as {valid:boolean;violations:{code:string}[]};
  assert.equal(result.valid,false);assert(result.violations.some(v=>v.code==='dependency_order'));
  const slots=await f.capabilities.functions.invoke(view,'findScheduleSlots',{plan:p.result.plan.ref,ignoreActivity:second},context) as {slots:{start:string}[]};
  assert(slots.slots.every(s=>Date.parse(s.start)>=Date.parse(end)));
 }finally{await f.close();}
});

test('the restricted database role completes PA handoff and merge without metadata or grant writes',async()=>{
 const f=await fixture(new PlanningFixtureAgent()),role='eigos_plan_'+f.schema.slice(-32);
 let limited:import('../packages/runtime/database.js').Database|undefined;
 try{
  await f.db.query(`CREATE ROLE "${role}"; GRANT USAGE ON SCHEMA ${f.db.schema} TO "${role}";
    GRANT SELECT ON ${f.db.schema}.ontology,${f.db.schema}.releases,${f.db.schema}.resource_grants,${f.db.schema}.property_security,${f.db.schema}.object_policies,${f.db.schema}.security_memberships,${f.db.schema}.edit_policies,${f.db.schema}.ontology_resource_projects,${f.db.schema}.entity_bindings,${f.db.schema}.entity_binding_history TO "${role}";
    GRANT SELECT,INSERT,UPDATE,DELETE ON ${f.db.schema}.objects,${f.db.schema}.links TO "${role}";
    GRANT SELECT,INSERT,UPDATE ON ${f.db.schema}.tasks,${f.db.schema}.source_calls,${f.db.schema}.scenarios,${f.db.schema}.scenario_objects,${f.db.schema}.scenario_links,${f.db.schema}.pa_requests TO "${role}";
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${f.db.schema}.source_values,${f.db.schema}.object_edits TO "${role}";
      GRANT SELECT,INSERT ON ${f.db.schema}.edit_history TO "${role}";
      GRANT SELECT,INSERT,UPDATE ON ${f.db.schema}.action_changes,${f.db.schema}.action_undo_requests,${f.db.schema}.scenario_sessions TO "${role}";
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${f.db.schema} TO "${role}";
      GRANT SELECT,INSERT ON ${f.db.schema}.actions,${f.db.schema}.scenario_actions TO "${role}";`);
  const {Database}=await import('../packages/runtime/database.js'),{Metadata}=await import('../packages/runtime/metadata.js'),{Tasks}=await import('../packages/runtime/tasks.js'),{createCapabilities}=await import('../packages/capabilities/index.js'),{Worker}=await import('../apps/worker/worker.js'),{OntologyAgent}=await import('../packages/runtime/agent.js');
  const url=new URL(process.env.EIGOS_TEST_DATABASE_URL!);url.searchParams.set('options','-c role='+role);limited=new Database(url.toString(),f.schema);
  const metadata=new Metadata(limited),tasks=new Tasks(limited,metadata),capabilities=createCapabilities(limited,f.source),access=await Access.load(limited,principal),agent=new OntologyAgent(limited,metadata,tasks,capabilities,new PlanningFixtureAgent()),worker=new Worker(tasks,agent);
  const p=await proposed({...f,db:limited,metadata,tasks,capabilities,access,agent,worker});
  const d=await new Scenarios(limited).inspect(access,f.model,p.result.scenarioId);
  await capabilities.actions.apply(access,f.model,'CommitSchedulePlan',{plan:p.result.plan.ref,scenarioId:d.id,revision:d.revision},'limited-merge');
  assert.equal((await new Objects(limited,f.model,access).query({type:'ScheduledActivity'})).items.length,1);
  await assert.rejects(limited.query(`UPDATE ${f.db.schema}.ontology SET release=release`),/permission denied/);
  await assert.rejects(limited.query(`DELETE FROM ${f.db.schema}.resource_grants`),/permission denied/);
  worker.stop();
 }finally{await limited?.close();await f.db.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);await f.close();}
});

test('the Agent cannot bypass scenario review with a live activity Action',async()=>{
 const f=await fixture(new PlanningFixtureAgent());try{
  const p=await proposed(f),task=await f.tasks.submit(principal,{requestId:'unsafe-live-edit',message:'proposal'}),claimed=await f.tasks.claim();assert.equal(claimed!.id,task.id);
  await assert.rejects(f.capabilities.actions.apply(f.access,f.model,'SaveScheduleActivity',{plan:p.result.plan.ref,id:'bypass',name:'bypass',start:p.result.activities[0]!.properties.start,end:p.result.activities[0]!.properties.end},'bypass',undefined,{task:claimed!,tasks:f.tasks}),/scenario for PA review/);
  assert.equal((await new Objects(f.db,f.model,f.access).query({type:'ScheduledActivity'})).items.length,0);
 }finally{await f.close();}
});

test('separate plans retain independent calendar coverage on the same resource',async()=>{
 const f=await fixture(new PlanningFixtureAgent());try{
  const first=await proposed(f),secondInput={...first.input,start:new Date(Date.parse(first.input.start)+86400000).toISOString(),end:new Date(Date.parse(first.input.end)+86400000).toISOString()};
  const task=await f.tasks.submit(principal,{requestId:'second-window',message:JSON.stringify({planning:secondInput})});await f.worker.runOne();
  const waiting=await f.tasks.get(principal,task.id);assert.equal(waiting.state,'input-required');
  await new PARequests(f.tasks).respond(principal,task.id,{requestId:(waiting.result as {requestId:string}).requestId,response:calendarAnswer(secondInput)});await f.worker.runOne();
  assert.equal((await f.tasks.get(principal,task.id)).state,'completed');
  const context={principal,objects:new Objects(f.db,f.model,f.access),signal:AbortSignal.timeout(5000)};
  const result=await f.capabilities.functions.invoke(f.model,'findScheduleSlots',{plan:first.result.plan.ref},context) as {slots:unknown[]};
  assert(result.slots.length>0);
  assert.equal((await context.objects.query({type:'ScheduleResource'})).items.length,1);
  assert.equal((await context.objects.query({type:'CalendarAvailability'})).items.length,2);
 }finally{await f.close();}
});

test('a model changing the plan title after PA response still resumes the same calendar request',async()=>{
 class ChangingTitleAgent extends PlanningFixtureAgent {
  private attempt=0;
  override async run(prompt:string,tools:Parameters<PlanningFixtureAgent['run']>[1]){
   const lines=prompt.split('\n'),task=JSON.parse(lines.at(-1)!),message=JSON.parse(task.userRequest.message);
   message.planning.title='Plan title '+(++this.attempt);task.userRequest.message=JSON.stringify(message);lines[lines.length-1]=JSON.stringify(task);
   return super.run(lines.join('\n'),tools);
  }
 }
 const f=await fixture(new ChangingTitleAgent());try{
  const p=await proposed(f);assert.equal(p.result.validation.valid,true);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.pa_requests WHERE task_id=$1`,[p.task.id])).rows[0]!.n,1);
 }finally{await f.close();}
});
