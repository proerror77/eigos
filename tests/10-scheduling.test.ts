import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,principal} from './fixture.js';
import {PlanningFixtureAgent,planningInput,calendarAnswer} from './planning-fixture.js';
import {PARequests} from '../packages/runtime/pa.js';
import {Objects} from '../packages/runtime/objects.js';
import {Conflict, InvalidInput, PermissionDenied} from '../packages/core/identity.js';
import {Scenarios} from '../packages/runtime/scenarios.js';
import {Access,setGrants,businessGrants} from '../packages/runtime/access.js';
import { ScenarioEvaluations, trialScenariosSchema } from '../packages/runtime/scenario-evaluation.js';
import {seedPlan} from './service-fixture.js';
import {harnessFixture} from './harness-fixture.js';
import {readPlan} from '../packages/capabilities/scheduling/functions.js';

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
 const harness=await harnessFixture(),f=await fixture(harness.driver);try{
  const p=await proposed(f);assert.equal(p.result.validation.valid,true);assert.equal(p.result.validation.calendarEvidence[0]!.evidence,'synthetic');assert.equal(p.result.externalCalendarUpdated,false);
  assert.equal(Date.parse(p.result.activities[0]!.properties.start),Date.parse(p.input.start)+3600000);
  assert.equal((await new Objects(f.db,f.model,f.access).query({type:'ScheduledActivity'})).items.length,0);
  assert.equal(f.provider.calls.length,0);
  const graph=new Objects(f.db,f.model,f.access);
  const before=await graph.query({type:'SchedulePlanStateLog',where:{processId:p.result.plan.ref.id}});
  assert.equal(before.items.length,1);assert.equal(before.items[0]!.properties.newState,'prepared');
  assert.equal(before.items[0]!.properties.action,'PrepareSchedulePlan');assert.equal(before.items[0]!.properties.taskId,p.task.id);
  const view=await new Scenarios(f.db).view(f.access,f.model,p.result.scenarioId);
  assert.equal((await new Objects(f.db,view,f.access).query({type:'SchedulePlanStateLog'})).items.length,1);
  const diff=await new Scenarios(f.db).inspect(f.access,f.model,p.result.scenarioId);
  await f.capabilities.actions.apply(f.access,f.model,'CommitSchedulePlan',{plan:p.result.plan.ref,scenarioId:p.result.scenarioId,revision:Number(diff.revision)},'approved-merge');
  assert.equal((await new Objects(f.db,f.model,f.access).query({type:'ScheduledActivity'})).items.length,1);
  const logs=await graph.follow(p.result.plan.ref,'stateLogs');
  assert.equal(logs.length,2);assert.equal(logs[1]!.properties.oldState,'prepared');assert.equal(logs[1]!.properties.newState,'confirmed');
  assert.equal(logs[1]!.properties.action,'CommitSchedulePlan');assert.equal(logs[1]!.properties.requestId,'approved-merge');
  assert.deepEqual((await graph.follow(logs[1]!.ref,'process'))[0]!.ref,p.result.plan.ref);
  const confirmed=await graph.query({type:'ProcessLog',where:{newState:'confirmed'}});
  assert.equal(confirmed.items.length,1);
  await f.capabilities.actions.apply(f.access,f.model,'CommitSchedulePlan',{plan:p.result.plan.ref,scenarioId:p.result.scenarioId,revision:Number(diff.revision)},'approved-merge');
  assert.equal((await graph.follow(p.result.plan.ref,'stateLogs')).length,2);
 }finally{await f.close();await harness.close();}
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

test('an expired calendar reply asks the original PA for a fresh snapshot on the same task', async () => {
  const f = await fixture(new PlanningFixtureAgent());
  try {
    const p = await pending(f), pa = new PARequests(f.tasks);
    const observedAt = new Date(Date.now() - 4200000), expiresAt = new Date(observedAt.getTime() + 3600000);
    await f.db.query(`UPDATE ${f.db.schema}.pa_requests SET created_at=$2 WHERE id=$1`, [p.request.requestId, observedAt]);
    await pa.respond(principal, p.task.id, { requestId: p.request.requestId, response: {
      ...calendarAnswer(p.input), observedAt: observedAt.toISOString(), expiresAt: expiresAt.toISOString(),
    } });
    await f.worker.runOne();
    const awaiting = await f.tasks.get(principal, p.task.id);
    assert.equal(awaiting.state, 'input-required');
    const renewal = awaiting.result as { taskId: string; requestId: string; capability: string };
    assert.equal(renewal.taskId, p.task.id);
    assert.equal(renewal.capability, 'calendar.freebusy');
    assert.notEqual(renewal.requestId, p.request.requestId);
    assert.equal((await new Objects(f.db, f.model, f.access).query({ type: 'SchedulePlan' })).items.length, 0);
    await pa.respond(principal, p.task.id, { requestId: renewal.requestId, response: calendarAnswer(p.input) });
    await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, p.task.id)).state, 'completed');
  } finally { await f.close(); }
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
  await setGrants(f.db,principal.owner,businessGrants(f.model).filter(g=>g.resource!=='Eigos/source/PACalendar'));
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
  const occupied=await f.db.query(`SELECT count(*)::int AS n FROM ${f.db.schema}.resource_reservations WHERE state='committed'`);
  assert.equal(occupied.rows[0]!.n,1);
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
    GRANT SELECT,INSERT ON ${f.db.schema}.task_inbox_events TO "${role}";
      GRANT SELECT,INSERT,UPDATE ON ${f.db.schema}.task_turns,${f.db.schema}.resource_reservations TO "${role}";
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${f.db.schema}.source_values,${f.db.schema}.object_edits TO "${role}";
      GRANT SELECT,INSERT ON ${f.db.schema}.edit_history TO "${role}";
      GRANT SELECT,INSERT ON ${f.db.schema}.link_history,${f.db.schema}.change_commits TO "${role}";
      GRANT SELECT ON ${f.db.schema}.change_journal TO "${role}";
      GRANT INSERT ON ${f.db.schema}.execution_trace TO "${role}";
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


test('offline trials run real schedule Actions on the same PA evidence and roll back both alternatives', async () => {
  const f = await fixture(new PlanningFixtureAgent());
  try {
    const p = await proposed(f), graph = new Objects(f.db, f.model, f.access);
    const plan = await graph.read(p.result.plan.ref);
    const [calendar] = await graph.follow(plan.ref, 'availability');
    assert(calendar);
    const metric = { function: 'validateSchedule', input: { plan: { input: 'plan' } }, path: ['valid'] };
    const at = (minutes: number) => new Date(Date.parse(p.input.start) + minutes * 60000).toISOString();
    const activity = (minutes: number) => ({
      kind: 'action', name: 'allocate', action: 'SaveScheduleActivity',
      input: { plan: { input: 'plan' }, id: { value: 'same-activity' }, name: { value: 'Meeting' },
        start: { value: at(minutes) }, end: { value: at(minutes + 30) } },
    });
    const input = trialScenariosSchema.parse({
      cases: [{ name: 'calendar', inputs: { plan: plan.ref },
        evidence: [{ object: plan.ref, revision: plan.revision }, { object: calendar.ref, revision: calendar.revision }] }],
      variants: [
        { name: 'current', steps: [activity(0), { ...metric, kind: 'check', name: 'validate', equals: true }] },
        { name: 'candidate', steps: [{ ...metric, kind: 'check', name: 'precheck', equals: true }, activity(60)] },
      ],
      metrics: [{ ...metric, name: 'feasible' }],
    });
    const evaluations = new ScenarioEvaluations(f.db, f.capabilities.actions, f.capabilities.functions);
    const tables = ['scenarios', 'scenario_sessions', 'scenario_objects', 'scenario_links', 'scenario_actions',
      'actions', 'action_effects', 'external_operations', 'scheduled_actions', 'tasks', 'pa_requests', 'edit_history'];
    const counts = () => Promise.all(tables.map(async table =>
      (await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.${table}`)).rows[0]?.n));
    const before = await counts();
    const report = await evaluations.trial(await Access.load(f.db, principal), f.model, input);
    assert.deepEqual(report.summary.map(row => [row.name, row.completed, row.rejected]), [
      ['current', 0, 1], ['candidate', 1, 0],
    ]);
    const [current, candidate] = report.cases[0]!.variants;
    assert.equal(current?.steps[1]?.value, false);
    assert(candidate?.status === 'completed');
    assert.deepEqual(candidate.metrics, { feasible: true });
    assert.equal(candidate.changes.objectsCreated, 1);
    assert.equal((await graph.query({ type: 'ScheduledActivity' })).items.length, 0);
    assert.equal(f.provider.calls.length, 0);
    assert.deepEqual(await counts(), before);

    await assert.rejects(evaluations.trial(await Access.load(f.db, principal), f.model, {
      ...input, cases: [{ ...input.cases[0]!, evidence: [{ object: plan.ref, revision: plan.revision + 1 }] }],
    }), /evidence changed/);
    await assert.rejects(evaluations.trial(await Access.load(f.db, principal), f.model, {
      ...input, variants: [{ name: 'merge', steps: [{ kind: 'action', name: 'merge', action: 'CommitSchedulePlan', input: {} }] },
        input.variants[1]!],
    }), /offline Scenario evaluation/);
    assert.deepEqual(await counts(), before);
  } finally { await f.close(); }
});

test('joint scheduling honors multiple calendars, dependencies and current revisions before staging',async()=>{
  const f=await fixture();try{
    const seed=await seedPlan(f), graph=new Objects(f.db,f.model,f.access), scenarios=new Scenarios(f.db);
    const first=await graph.read(seed.availability), resource={type:'ScheduleResource',id:'second-resource'};
    const second={type:'CalendarAvailability',id:'second-coverage'};
    const start=new Date(Date.now()+10*60000), end=new Date(start.getTime()+20*60000);
    await graph.create(resource,{id:resource.id,name:'Second resource'});
    await graph.create(second,{...first.properties,id:second.id,name:'Second calendar',busy:[{start:start.toISOString(),end:end.toISOString()}]});
    await graph.linkBatch([{type:'PlanResource',from:seed.plan,to:resource},{type:'PlanAvailability',from:seed.plan,to:second},
      {type:'ResourceAvailability',from:resource,to:second}]);
    const scenario=await scenarios.create(f.access,f.model,{requestId:'optimizer',name:'Optimization'});
    const view=await scenarios.view(f.access,f.model,scenario.id);
    const schedule={plan:seed.plan,start:start.toISOString(),end:end.toISOString(),name:'Activity'};
    const a=await f.capabilities.actions.apply(f.access,view,'SaveScheduleActivity',{...schedule,id:'first'},'first');
    const b=await f.capabilities.actions.apply(f.access,view,'SaveScheduleActivity',{...schedule,id:'second',predecessors:[a]},'second');
    const context={objects:new Objects(f.db,view,f.access),principal,signal:AbortSignal.timeout(10000)};
    const recommendation=await f.capabilities.functions.invoke(view,'recommendSchedule',{plan:seed.plan,activities:[a,b],
      objective:'earliest_finish'},context) as {status:string;moves:{activity:typeof a;revision:number;start:string;end:string}[]};
    assert.equal(recommendation.status,'optimal');
    assert(recommendation.moves.every(move=>Date.parse(move.start)>=end.getTime()));
    assert(Date.parse(recommendation.moves[0]!.end)<=Date.parse(recommendation.moves[1]!.start));
    await f.capabilities.actions.apply(f.access,view,'StageScheduleRecommendation',{plan:seed.plan,moves:recommendation.moves},'stage');
    assert.equal((await f.capabilities.functions.invoke(view,'validateSchedule',{plan:seed.plan},context) as {valid:boolean}).valid,true);
    assert.equal((await graph.query({type:'ScheduledActivity'})).items.length,0);
    await assert.rejects(f.capabilities.actions.apply(f.access,view,'StageScheduleRecommendation',
      {plan:seed.plan,moves:recommendation.moves},'stale'),/revision/);
  }finally{await f.close();}
});

test('prepared candidate trials, saved evaluations and reviewer handoff share the existing Scenario transaction',async()=>{
  const f=await fixture();try{
    const seed=await seedPlan(f), graph=new Objects(f.db,f.model,f.access), scenarios=new Scenarios(f.db);
    const plan=await graph.read(seed.plan), calendar=await graph.read(seed.availability);
    const start=new Date(Date.now()+30*60000).toISOString(), end=new Date(Date.now()+60*60000).toISOString();
    const trial=trialScenariosSchema.parse({
      cases:[{name:'case1',inputs:{plan:plan.ref},evidence:[{object:plan.ref,revision:plan.revision},{object:calendar.ref,revision:calendar.revision}]}],
      variants:[{name:'Baseline',steps:[]},{name:'Candidate',steps:[{kind:'action',name:'schedule',action:'SaveScheduleActivity',
        input:{plan:{input:'plan'},id:{value:'trial'},name:{value:'Trial'},start:{value:start},end:{value:end}}}]}],
      metrics:[{name:'valid',function:'validateSchedule',input:{plan:{input:'plan'}},path:['valid']}],
    });
    const evaluations=new ScenarioEvaluations(f.db,f.capabilities.actions,f.capabilities.functions);
    const definition=structuredClone(f.model.document);definition.version+='-candidate';
    const candidate=await f.metadata.prepare(definition,f.capabilities,f.publisher);
    const offline=await evaluations.trial(f.access,candidate,trial,f.model.release);
    assert.equal(offline.release,candidate.release);
    assert.equal(offline.cases[0]!.variants[1]!.status,'completed');
    assert.equal((await f.metadata.active()).release,f.model.release);
    assert.equal((await scenarios.list(f.access,f.model)).items.length,0);
    const suite=await evaluations.saveSuite(f.access,f.model,{name:'Release test',requestId:'suite',trial});
    const report=await evaluations.runSuite(f.access,f.model,suite);
    const proposed=await evaluations.promote(f.access,f.model,{run:report.run,case:'case1',variant:'Candidate',
      reviewers:['reviewer-test'],requestId:'promote'});
    const diff=await scenarios.inspect(f.access,f.model,proposed.id);
    assert.equal(diff.objects[0]?.ref.type,'ScheduledActivity');
    assert.equal((await graph.query({type:'ScheduledActivity'})).items.length,0);
    await assert.rejects(f.capabilities.actions.apply(f.access,f.model,'CommitSchedulePlan',
      {plan:seed.plan,scenarioId:proposed.id,revision:proposed.revision},'premature-merge'),/approval|review/i);
    await graph.edit(calendar.ref,calendar.revision,{sourceVersion:'new evidence'});
    await assert.rejects(evaluations.promote(f.access,f.model,{run:report.run,case:'case1',variant:'Candidate',
      reviewers:['reviewer-test'],requestId:'stale-evidence'}),/evidence/i);
    assert.equal((await scenarios.list(f.access,f.model)).items.length,1);
  }finally{await f.close();}
});

test('cross-release continuation recovers a Function Action that creates and links its own output', async () => {
  const f = await fixture();
  try {
    const { plan } = await seedPlan(f);
    const scenarios = new Scenarios(f.db);
    const source = await scenarios.create(f.access, f.model, { requestId: 'prior-plan', name: 'Prior plan' });
    const view = await scenarios.view(f.access, f.model, source.id);
    const at = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();
    const activity = await f.capabilities.actions.apply(f.access, view, 'SaveScheduleActivity', {
      plan, id: 'linked-activity', name: 'Staged activity', start: at(30), end: at(40),
    }, 'prior-activity');
    const before = await scenarios.inspect(f.access, f.model, source.id);
    const definition = structuredClone(f.model.document);
    definition.version += '-compatible';
    const current = await f.metadata.publish(definition, f.capabilities, f.publisher);
    const copy = await scenarios.continueScenario(f.access, current, {
      id: source.id, revision: before.revision, requestId: 'continue-linked-activity',
    });
    const after = await scenarios.inspect(f.access, current, copy.id);
    assert.deepEqual(after.objects, before.objects);
    assert.deepEqual(after.links, before.links);
    const continued = await scenarios.view(f.access, current, copy.id);
    const graph = new Objects(f.db, continued, f.access);
    assert.deepEqual((await graph.follow(plan, 'activities')).map(item => item.ref), [activity]);
    assert.deepEqual((await new Objects(f.db, current, f.access).follow(plan, 'activities')), []);
  } finally {
    await f.close();
  }
});

test('scheduling reads past 100 resource links and an Action can undo a high-degree deletion', async () => {
  const f = await fixture();
  try {
    const { plan, resource, input } = await seedPlan(f);
    const graph = new Objects(f.db, f.model, f.access);
    const start = Date.parse(input.start), end = Date.parse(input.end);
    const timestamp = (value: number) => new Date(value).toISOString();
    const target = { type: 'ScheduledActivity', id: 'plan-activity' };
    const create = async (writer: Objects, ref: typeof target, start: number, end: number) => {
      await writer.create(ref, { id: ref.id, name: ref.id, start: timestamp(start), end: timestamp(end) });
    };
    await f.db.transaction(async client => {
      const writer = new Objects(f.db, f.model, f.access, client);
      await create(writer, target, end - 1800000, end);
      const historical = Array.from({ length: 101 }, (_, index) => ({
        type: 'ScheduledActivity', id: `history-${String(index).padStart(3, '0')}`,
      }));
      const current = Array.from({ length: 101 }, (_, index) => ({
        type: 'ScheduledActivity', id: `occupied-${String(index).padStart(3, '0')}`,
      }));
      for (const item of historical) await create(writer, item, start - 3600000, start);
      for (const item of current) {
        const at = start + 8 * 3600000;
        // Stored values may include offsets, even if the plan boundaries are in UTC.
        await writer.create(item, { id: item.id, name: item.id,
          start: timestamp(at).replace('Z', '+08:00'),
          end: timestamp(end + 8 * 3600000).replace('Z', '+08:00') });
      }
      await writer.linkBatch([
        { type: 'ActivityPlan', from: target, to: plan },
        ...[target, ...historical, ...current].map(from => ({ type: 'ActivityResource', from, to: resource })),
        ...historical.map(to => ({ type: 'ActivityDependency', from: target, to })),
      ]);
    });

    const context = { principal, objects: graph, signal: AbortSignal.timeout(30000) };
    const state = await readPlan(graph, plan);
    assert.equal(state.calendars[0]?.assignments.length, 102);
    const result = await f.capabilities.functions.invoke(f.model, 'findScheduleSlots', { plan }, context) as { slots: unknown[] };
    assert.deepEqual(result.slots, []);
    const validation = await f.capabilities.functions.invoke(f.model, 'validateSchedule', { plan }, context) as {
      violations: { code: string; related: { id: string }[] }[];
    };
    const overlaps = validation.violations.filter(item => item.code === 'resource_overlap');
    assert.equal(overlaps.length, 101);
    assert(overlaps.some(item => item.related[0]?.id === 'occupied-100'));

    await f.capabilities.actions.apply(f.access, f.model, 'RemoveScheduleActivity', { activity: target, revision: 1 }, 'remove-many-links');
    assert.deepEqual(await graph.follow(plan, 'activities'), []);
    await f.capabilities.actions.undo(f.access, f.model, 'remove-many-links', 'restore-many-links');
    assert.equal((await graph.follow(target, 'predecessors')).length, 101);
    assert.equal((await graph.follow(plan, 'activities'))[0]?.ref.id, target.id);
  } finally {
    await f.close();
  }
});

test('complete relationship reads are bounded while an authorized paginated query keeps every activity', async () => {
  const f = await fixture();
  try {
    const { resource, input } = await seedPlan(f);
    const graph = new Objects(f.db, f.model, f.access);
    await f.db.transaction(async client => {
      const scope = [f.model.projection, principal.owner];
      await f.db.query(`INSERT INTO ${f.db.schema}.objects(projection,owner,type,id,properties)
        SELECT $1,$2,'ScheduledActivity',id,jsonb_build_object('id',id,'name',id,'start',$3::text,'end',$4::text)
        FROM (SELECT 'crowded-'||lpad(n::text,4,'0') AS id FROM generate_series(1,1001) n) activities`,
      [...scope, input.start, input.end], client);
      await f.db.query(`INSERT INTO ${f.db.schema}.links(projection,owner,type,from_type,from_id,to_type,to_id,single_from,single_to)
        SELECT $1,$2,'ActivityResource',type,id,$3,$4,false,false FROM ${f.db.schema}.objects
        WHERE projection=$1 AND owner=$2 AND type='ScheduledActivity'`,
      [...scope, resource.type, resource.id], client);
    });
    await assert.rejects(graph.follow(resource, 'activities'), (error: unknown) =>
      error instanceof Conflict && /complete read limit.*paginated query/.test(error.message));
    await assert.rejects(graph.follow(resource, 'activities', resource.type, 50), Conflict);

    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await graph.query({ type: 'ScheduledActivity',
        from: { object: resource, link: 'activities' }, limit: 100, cursor });
      for (const item of page.items) ids.add(item.ref.id);
      cursor = page.cursor;
    } while (cursor);
    assert.equal(ids.size, 1001);
    await assert.rejects(graph.query({ type: 'ScheduledActivity', cursor: 'not-a-query-cursor' }), InvalidInput);

    const scenarios = new Scenarios(f.db);
    const scenario = await scenarios.create(f.access, f.model, { requestId: 'crowded-link', name: 'Crowded calendar' });
    const staged = new Objects(f.db, await scenarios.view(f.access, f.model, scenario.id), f.access);
    const extra = { type: 'ScheduledActivity', id: 'additional-activity' };
    await staged.create(extra, { id: extra.id, name: extra.id, start: input.start, end: input.end });
    await staged.link({ type: 'ActivityResource', from: extra, to: resource });
    assert.deepEqual((await staged.follow(extra, 'resources')).map(item => item.ref), [resource]);
  } finally {
    await f.close();
  }
});

test('deletion with a hidden relationship returns a permission failure and keeps all changes atomic', async () => {
  const f = await fixture();
  try {
    const { plan, resource, input } = await seedPlan(f);
    const graph = new Objects(f.db, f.model, f.access);
    const activity = (id: string) => ({ type: 'ScheduledActivity', id });
    const visible = activity('visible-target'), companion = activity('visible-companion');
    const hidden = activity('hidden-dependency');
    for (const ref of [visible, companion, hidden])
      await graph.create(ref, { id: ref.id, name: ref === hidden ? 'Hidden' : 'Visible', start: input.start, end: input.end });
    await graph.linkBatch([
      { type: 'ActivityPlan', from: visible, to: plan },
      { type: 'ActivityResource', from: visible, to: resource },
      { type: 'ActivityDependency', from: visible, to: companion },
      { type: 'ActivityDependency', from: hidden, to: visible },
    ]);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES($1,$2,$3)`,
      [f.model.document.id, visible.type, { read: { all: [{ op: 'equals', property: 'name', value: 'Visible' }], any: [] }, properties: {} }]);
    const access = await Access.load(f.db, principal);
    const scenarios = new Scenarios(f.db);
    const created = await scenarios.create(access, f.model, { requestId: 'hidden-link-scenario', name: 'Hidden relationship deletion' });
    const view = await scenarios.view(access, f.model, created.id);
    for (const [model, id] of [[f.model, 'hidden-live-delete'], [view, 'hidden-draft-delete']] as const) {
      await assert.rejects(f.capabilities.actions.apply(access, model, 'RemoveScheduleActivity',
        { activity: visible, revision: 1 }, id), (error: unknown) =>
          error instanceof PermissionDenied && /inaccessible relationships/.test(error.message) && !error.message.includes(hidden.id));
    }
    const remaining = new Objects(f.db, f.model, access);
    assert.deepEqual((await remaining.follow(plan, 'activities')).map(item => item.ref), [visible]);
    assert.deepEqual((await remaining.follow(visible, 'predecessors')).map(item => item.ref), [companion]);
    assert.equal((await scenarios.inspect(access, f.model, created.id)).revision, created.revision);
    await assert.rejects(remaining.link({ type: 'ActivityResource', from: visible, to: plan }), InvalidInput);
    const secondPlan = { ...plan, id: 'second-plan' };
    await remaining.create(secondPlan, { ...(await remaining.read(plan)).properties, id: secondPlan.id });
    await assert.rejects(remaining.link({ type: 'ActivityPlan', from: visible, to: secondPlan }), Conflict);

    await f.db.query(`INSERT INTO ${f.db.schema}.property_security VALUES($1,$2,$3)`,
      [f.model.document.id, visible.type, 'name']);
    const hiddenField = new Objects(f.db, f.model, await Access.load(f.db, principal));
    await assert.rejects(hiddenField.edit(visible, 1, { name: 'Different' }), PermissionDenied);
  } finally {
    await f.close();
  }
});
