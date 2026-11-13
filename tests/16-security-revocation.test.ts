import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Access } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { objectPolicySchema, permits, policySql } from '../packages/runtime/security.js';
import { Scenarios } from '../packages/runtime/scenarios.js';

const plan = { type: 'SchedulePlan', id: 'reviewed-plan' };
const properties = { id: plan.id, name: 'Private meeting', start: '2026-11-20T01:00:00Z', end: '2026-11-20T03:00:00Z', timeZone: 'Asia/Shanghai', durationMinutes: 30 };
const fieldPolicy = objectPolicySchema.parse({ properties: { name: { all: [{ op: 'equals', property: 'durationMinutes', value: 30 }] } } });

test('member SQL and in-memory evaluation agree on strings, numbers and mixed arrays', async () => {
  const f = await fixture();
  try {
    const context = { subject: principal.owner, groups: ['30', 'true', 'operations'], markings: [] };
    const expression = objectPolicySchema.parse({ read: { all: [{ op: 'member', property: 'groups' }] } }).read!;
    for (const value of [30, true, '30', ['operations'], [30, true], ['absent'], null]) {
      const values: unknown[] = [JSON.stringify({ groups: value })];
      const sql = policySql(expression, values, context, '$1::jsonb');
      const actual = (await f.db.query(`SELECT ${sql} AS permitted`, values)).rows[0]!.permitted;
      assert.equal(actual, permits(expression, { groups: value }, context));
    }
    await new Objects(f.db, f.model, f.access).create(plan, properties);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','SchedulePlan',$1)`, [objectPolicySchema.parse({ properties: { name: { all: [{ op: 'member', property: 'durationMinutes' }] } } })]);
    await f.db.query(`INSERT INTO ${f.db.schema}.security_memberships VALUES($1,'group','30')`, [principal.owner]);
    const objects = new Objects(f.db, f.model, await Access.load(f.db, principal));
    assert.equal((await objects.read(plan)).properties.name, null);
    assert.equal((await objects.query({ type: 'SchedulePlan', where: { name: properties.name } })).items.length, 0);
  } finally { await f.close(); }
});

test('null markings are empty in both row filters and direct policy evaluation', async () => {
  const f = await fixture();
  try {
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','Route',$1)`, [objectPolicySchema.parse({ markingsProperty: 'marks' })]);
    const access = await Access.load(f.db, principal);
    for (const properties of [{}, { marks: null }, { marks: [] }, { marks: ['private'] }]) {
      const values: unknown[] = [JSON.stringify(properties)];
      const sql = access.rowSql(f.model, 'Route', values, '$1::jsonb');
      const actual = (await f.db.query(`SELECT ${sql} AS permitted`, values)).rows[0]!.permitted;
      assert.equal(actual, access.rowAllowed(f.model, 'Route', properties));
    }
  } finally { await f.close(); }
});

test('cached task output rechecks row-controlled cell access while ordinary value edits remain valid', async () => {
  const f = await fixture();
  try {
    await new Objects(f.db, f.model, f.access).create(plan, properties);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','SchedulePlan',$1)`, [fieldPolicy]);
    const access = await Access.load(f.db, principal);
    const output = await new Objects(f.db, f.model, access).read(plan);
    const requirements = access.dataRequirements();
    assert.equal(await (await Access.load(f.db, principal)).canReturn(requirements.filter(requirement => !requirement.security && !requirement.row)), false);
    assert(!JSON.stringify(requirements).includes(properties.name));
    const dependency = requirements.find(requirement => requirement.row)?.row!;
    assert.equal(dependency.id, plan.id); assert(dependency.fields.includes('name'));
    const submitted = await f.tasks.submit(principal, { requestId: 'protected-result', message: 'Read the plan' });
    const task = await f.tasks.claim(); assert.equal(task!.id, submitted.id);
    await f.tasks.finish(task!, 'completed', output, undefined, requirements);
    assert.equal((await f.tasks.get(principal, submitted.id)).result !== null, true);
    await new Objects(f.db, f.model, await Access.load(f.db, principal)).edit(plan, 1, { name: 'Updated visible name' });
    assert.equal(await (await Access.load(f.db, principal)).canReturn(requirements), true);
    assert.equal((await f.tasks.get(principal, submitted.id)).result !== null, true);
    await new Objects(f.db, f.model, await Access.load(f.db, principal)).edit(plan, 2, { durationMinutes: 60 });
    const current = await Access.load(f.db, principal);
    assert.equal((await new Objects(f.db, f.model, current).read(plan)).properties.name, null);
    assert.equal(await current.canReturn(requirements), false);
    assert.equal((await f.tasks.get(principal, submitted.id)).result, null);
  } finally { await f.close(); }
});

test('result completion and deleted dependencies fail closed and Scenario dependencies keep their view', async () => {
  const f = await fixture();
  try {
    await new Objects(f.db, f.model, f.access).create(plan, properties);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','SchedulePlan',$1)`, [fieldPolicy]);
    const access = await Access.load(f.db, principal), objects = new Objects(f.db, f.model, access);
    const output = await objects.read(plan), requirements = access.dataRequirements();
    const scenario = await new Scenarios(f.db).create(access, f.model, { requestId: 'policy-view', name: 'View' });
    const view = await new Scenarios(f.db).view(access, f.model, scenario.id);
    const sceneAccess = await Access.load(f.db, principal), sceneObjects = new Objects(f.db, view, sceneAccess);
    await sceneObjects.edit(plan, 1, { name: 'Scenario name' });
    await sceneObjects.read(plan);
    const sceneRequirements = sceneAccess.dataRequirements();
    assert(sceneRequirements.some(requirement => requirement.row?.scenario === scenario.id));
    assert.equal(await (await Access.load(f.db, principal)).canReturn(sceneRequirements), true);
    await new Scenarios(f.db).discard(await Access.load(f.db, principal), f.model, scenario.id, Number((await new Scenarios(f.db).inspect(sceneAccess, f.model, scenario.id)).revision));
    assert.equal(await (await Access.load(f.db, principal)).canReturn(sceneRequirements), false);
    const submitted = await f.tasks.submit(principal, { requestId: 'delete-before-finish', message: 'Read plan' });
    const task = await f.tasks.claim(); assert.equal(task!.id, submitted.id);
    await new Objects(f.db, f.model, await Access.load(f.db, principal)).remove(plan, 1);
    assert.equal(await (await Access.load(f.db, principal)).canReturn(requirements), false);
    await assert.rejects(f.tasks.finish(task!, 'completed', output, undefined, requirements), /permissions changed/);
  } finally { await f.close(); }
});

test('derived object writes retain markings of objects read by the Action context',async()=>{
  const f=await fixture();try{
    const body=structuredClone(f.model.document);
    body.objectTypes.find(type=>type.apiName==='Route')!.properties.marks={description:'Data security labels',schema:{type:'array',items:{type:'string'}},required:true};
    const model=await f.metadata.publish(body,f.capabilities,f.publisher);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','Route',$1)`,[objectPolicySchema.parse({markingsProperty:'marks'})]);
    await f.db.query(`INSERT INTO ${f.db.schema}.security_memberships VALUES($1,'marking','private')`,[principal.owner]);
    const access=await Access.load(f.db,principal),graph=new Objects(f.db,model,access);
    await graph.create({type:'Route',id:'marked'},{id:'marked',name:'Protected',marks:['private']});
    await graph.read({type:'Route',id:'marked'});
    await assert.rejects(graph.create({type:'Route',id:'public'},{id:'public',name:'Derived',marks:[]}),/retain/);
    await graph.create({type:'Route',id:'derived'},{id:'derived',name:'Derived',marks:['private']});
    assert.deepEqual((await graph.read({type:'Route',id:'derived'})).properties.marks,['private']);
  }finally{await f.close();}
});

test('cached output authorization follows current objects after a publication changes',async()=>{
  const f=await fixture();try{
    await new Objects(f.db,f.model,f.access).create(plan,properties);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','SchedulePlan',$1)`,[fieldPolicy]);
    const access=await Access.load(f.db,principal);
    await new Objects(f.db,f.model,access).read(plan);
    const requirements=access.dataRequirements();
    const body=structuredClone(f.model.document);body.version='new-security-view';
    const current=await f.metadata.publish(body,f.capabilities,f.publisher);
    await new Objects(f.db,current,await Access.load(f.db,principal)).edit(plan,1,{durationMinutes:60});
    assert.equal(await (await Access.load(f.db,principal)).canReturn(requirements),false);
  }finally{await f.close();}
});

test('policed activity deletions merge against live inputs and deleted cached outputs stay hidden', async () => {
  const { PlanningFixtureAgent, planningInput, calendarAnswer } = await import('./planning-fixture.js');
  const { PARequests } = await import('../packages/runtime/pa.js');
  const f = await fixture(new PlanningFixtureAgent());
  try {
    const input = planningInput(), task = await f.tasks.submit(principal, { requestId: 'deletion-setup', message: JSON.stringify({ planning: input }) });
    await f.worker.runOne();
    const pending = await f.tasks.get(principal, task.id);
    await new PARequests(f.tasks).respond(principal, task.id, { requestId: (pending.result as {requestId:string}).requestId, response: calendarAnswer(input) });
    await f.worker.runOne();
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state, 'completed');
    const output = done.result as { plan:{ref:{type:string;id:string}}; scenarioId:string; activities:{ref:{type:string;id:string}}[] };
    const scenarios = new Scenarios(f.db), first = await scenarios.inspect(f.access, f.model, output.scenarioId);
    await f.capabilities.actions.apply(f.access, f.model, 'CommitSchedulePlan', { plan:output.plan.ref, scenarioId:first.id, revision:first.revision }, 'first-merge');
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','ScheduledActivity',$1)`, [objectPolicySchema.parse({})]);
    const access = await Access.load(f.db, principal), scene = await scenarios.create(access, f.model, { requestId:'remove-activity', name:'Remove activity' });
    const view = await scenarios.view(access, f.model, scene.id);
    const activity = output.activities[0]!.ref;
    await new Objects(f.db, view, access).read(activity);
    const cacheRequirements = access.dataRequirements();
    await f.capabilities.actions.apply(access, view, 'RemoveScheduleActivity', { activity, revision:1 }, 'stage-removal');
    const diff = await scenarios.inspect(access, f.model, scene.id);
    assert.equal(await (await Access.load(f.db, principal)).canReturn(cacheRequirements), false);
    await f.capabilities.actions.apply(await Access.load(f.db, principal), f.model, 'CommitSchedulePlan', { plan:output.plan.ref, scenarioId:scene.id, revision:diff.revision }, 'commit-removal');
    await assert.rejects(new Objects(f.db, f.model, await Access.load(f.db, principal)).read(activity), /unavailable/);
    assert.equal(await (await Access.load(f.db, principal)).canReturn(cacheRequirements), false);
    const transientAccess = await Access.load(f.db, principal);
    const transient = await scenarios.create(transientAccess, f.model, { requestId:'transient', name:'Create then remove' });
    const transientView = await scenarios.view(transientAccess, f.model, transient.id);
    const temporaryActivity = await f.capabilities.actions.apply(transientAccess, transientView, 'SaveScheduleActivity', {
      plan:output.plan.ref, id:'temporary', name:'Temporary activity', start:input.start, end:new Date(Date.parse(input.start)+1800000).toISOString(),
    }, 'create-temporary');
    await f.capabilities.actions.apply(transientAccess, transientView, 'RemoveScheduleActivity', { activity:temporaryActivity, revision:1 }, 'remove-temporary');
    const transientDiff = await scenarios.inspect(transientAccess, f.model, transient.id);
    assert.equal(transientDiff.objects.length, 0); assert.equal(transientDiff.links.length, 0);
    await f.capabilities.actions.apply(await Access.load(f.db, principal), f.model, 'CommitSchedulePlan', {
      plan:output.plan.ref, scenarioId:transient.id, revision:transientDiff.revision,
    }, 'commit-empty-alternative');
  } finally { await f.close(); }
});

test('Scenario Link diffs require each endpoint row to remain visible', async () => {
  const f = await fixture();
  try {
    const live = new Objects(f.db, f.model, f.access), route = { type:'Route', id:'secret-route' }, request = { type:'RideRequest', id:'public-request' };
    await live.create(route, { id:route.id, name:'Secret route' });
    await live.create(request, { id:request.id, name:'Public request', status:'requested', requestedAt:new Date().toISOString() });
    const scenarios = new Scenarios(f.db), scene = await scenarios.create(f.access, f.model, { requestId:'hidden-link', name:'Link proposal' });
    const view = await scenarios.view(f.access, f.model, scene.id);
    await new Objects(f.db, view, f.access).link({ type:'RequestRoute', from:request, to:route });
    assert.equal((await scenarios.inspect(f.access, f.model, scene.id)).links.length, 1);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','Route',$1)`, [objectPolicySchema.parse({ read:{ all:[{ op:'equals', property:'name', value:'Allowed route' }] } })]);
    const access = await Access.load(f.db, principal);
    await assert.rejects(new Objects(f.db, view, access).read(route), /policy/);
    await assert.rejects(scenarios.inspect(access, f.model, scene.id), /policy/);
  } finally { await f.close(); }
});
