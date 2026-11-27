import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { loadInstallation } from '../packages/runtime/installation.js';
import { addProcessLogs } from '../packages/ontology/process-definition.js';
import type { OntologyDocument } from '../packages/ontology/schema.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { ChangeSubscriptions } from '../packages/runtime/change-subscriptions.js';
import { MachineryWatchPlanner } from '../packages/runtime/machinery-watch.js';
import { ScheduledActions } from '../packages/runtime/scheduled-actions.js';
import { ontologyServices } from '../packages/runtime/services.js';
import { ObservationInterests } from '../packages/runtime/observation-interests.js';
import { MachineryExecution } from '../packages/runtime/machinery-execution.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

const journey = { type: 'SyntheticJourney', id: 'journey' };
const flight = { type: 'SyntheticFlight', id: 'flight' };
const transfer = { type: 'SyntheticTransfer', id: 'transfer-1' };
const backupTransfer = { type: 'SyntheticTransfer', id: 'transfer-2' };
const hotel = { type: 'SyntheticHotel', id: 'hotel' };

function modelOf(base: OntologyDocument) {
  const document = structuredClone(base);
  const field = (schema: Record<string, unknown>) => ({ description: 'Synthetic field', schema, required: true });
  for (const type of [journey.type, flight.type, transfer.type, hotel.type]) {
    document.objectTypes.push({
      apiName: type, displayName: type, description: 'Synthetic journey process', primaryKey: 'id', titleProperty: 'name',
      properties: { id: field({ type: 'string' }), name: field({ type: 'string' }), state: field({ type: 'string', enum: ['pending', 'ready', 'done'] }) },
      interfaces: {},
    });
  }
  addProcessLogs(document, [journey.type, flight.type, transfer.type, hotel.type].map(type => ({ type, property: 'state' })));
  for (const [type, link] of [[flight.type, 'flights'], [transfer.type, 'transfers'], [hotel.type, 'hotels']] as const) {
    document.linkTypes.push({
      apiName: 'Journey' + type, description: 'Synthetic related process',
      from: { type: journey.type, name: link, cardinality: 'many' },
      to: { type, name: 'journey', cardinality: 'one' },
    });
  }
  document.actionTypes.push({
    apiName: 'CompleteSyntheticJourney', description: 'Complete the synthetic journey after its dependencies',
    parameters: { type: 'object', properties: {
      journey: { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type', 'id'] },
      revision: { type: 'integer', minimum: 1 },
    }, required: ['journey', 'revision'], additionalProperties: false },
    objectParameters: { journey: journey.type }, submissionCriteria: [],
    rules: [{ op: 'editObject', object: { parameter: 'journey' }, expectedRevision: { parameter: 'revision' }, properties: { state: { literal: 'done' } } }],
    result: { type: journey.type, id: { parameter: 'journey', path: ['id'] } },
  });
  for (const type of [journey.type, flight.type, transfer.type, hotel.type]) {
    const definition = document.objectTypes.find(item => item.apiName === type + 'StateLog')!;
    definition.machinery = {
      states: [{ name: 'pending' }, { name: 'ready' }, { name: 'done', terminal: true }],
      transitions: type !== journey.type ? [] : [{
        from: 'pending', to: 'done', action: 'CompleteSyntheticJourney',
        execution: { subject: 'journey', requires: [
          { process: flight.type + 'StateLog', link: 'flights', states: ['ready'], match: 'all' },
          { process: transfer.type + 'StateLog', link: 'transfers', states: ['ready'], match: 'any' },
          { process: hotel.type + 'StateLog', link: 'hotels', states: ['ready'], match: 'all' },
        ] },
      }],
    };
  }
  return document;
}

test('Machinery infers a cross-process Action and rechecks its guards on direct submission', async () => {
  const f = await fixture();
  try {
    const model = await f.metadata.publish(modelOf(f.model.document), f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const access = () => Access.load(f.db, principal);
    const graph = new Objects(f.db, model, await access());
    const machinery = new MachineryExecution(f.db, f.capabilities.actions);
    const inspect = async () => (await machinery.nextActions(model, await access(), { object: journey })).items;
    const apply = async (request: string) => f.capabilities.actions.apply(await access(), model, 'CompleteSyntheticJourney', { journey, revision: 1 }, request);

    for (const ref of [journey, flight, transfer, backupTransfer, hotel])
      await graph.create(ref, { id: ref.id, name: ref.id, state: 'pending' });
    assert.equal((await inspect())[0]?.status, 'blocked');
    for (const ref of [flight, transfer, backupTransfer, hotel])
      await graph.link({ type: 'Journey' + ref.type, from: journey, to: ref });
    const unrelated = { ...journey, id: 'unrelated-journey' };
    await graph.create(unrelated, { id: unrelated.id, name: unrelated.id, state: 'pending' });
    const refreshed = await machinery.replan(model, await access(), { changedObjects: [hotel, flight, journey] });
    assert.deepEqual(refreshed.items.map(item => item.object), [journey]);
    assert.equal(refreshed.items[0]?.items[0]?.status, 'blocked');
    await graph.edit(flight, 1, { state: 'ready' });
    await graph.edit(transfer, 1, { state: 'ready' });
    assert.equal((await inspect())[0]?.status, 'blocked');
    await assert.rejects(apply('hotel-still-pending'), /transition is not available/);

    await graph.edit(hotel, 1, { state: 'ready' });
    const candidates = await inspect();
    assert.equal(candidates[0]?.status, 'needs_input');
    assert.deepEqual(candidates[0]?.input, { journey });
    assert.deepEqual(candidates[0]?.missing, ['revision']);

    await f.db.query(`INSERT INTO ${f.db.schema}.property_security(ontology,type,property) VALUES('Eigos',$1,'state')`, [hotel.type]);
    await setGrants(f.db, principal.owner, businessGrants(model).filter(grant => grant.resource !== `Eigos/property/${hotel.type}/state`));
    assert.equal((await inspect())[0]?.status, 'needs_check');
    await assert.rejects(apply('hidden-dependency'), /transition is not available/);
    await f.db.query(`DELETE FROM ${f.db.schema}.property_security WHERE type=$1 AND property='state'`, [hotel.type]);
    await setGrants(f.db, principal.owner, businessGrants(model));

    await graph.edit(hotel, 2, { state: 'pending' });
    await assert.rejects(apply('dependency-changed'), /transition is not available/);
    await graph.edit(hotel, 3, { state: 'ready' });
    assert.deepEqual(await apply('same-guarded-action'), journey);
    assert.equal((await graph.read(journey)).properties.state, 'done');
    assert.deepEqual(await inspect(), []);
  } finally { await f.close(); }
});

test('commit windows replan only the affected journey, wake once and revisit its original schedule', async t => {
  const f = await fixture();
  try {
    const model = await f.metadata.publish(modelOf(f.model.document),f.capabilities,f.publisher);
    await setGrants(f.db,principal.owner,businessGrants(model));
    const access = await Access.load(f.db,principal);
    const graph = new Objects(f.db,model,access);
    const other = { ...journey,id:'other' }, otherHotel = { ...hotel,id:'other-hotel' };
    for (const ref of [journey,other,flight,transfer,hotel,otherHotel])
      await graph.create(ref,{id:ref.id,name:ref.id,state: [flight,transfer].includes(ref) ? 'ready' : 'pending'});
    for (const ref of [flight,transfer,hotel]) await graph.link({type:'Journey'+ref.type,from:journey,to:ref});
    await graph.link({type:'Journey'+hotel.type,from:other,to:otherHotel});
    const interests = new ObservationInterests(f.db,f.metadata);
    for (const object of [journey,other]) await interests.start(access,model,{ requestId:'observe-'+object.id,object,
      deadline:new Date(Date.now()+3600000).toISOString(),phases:[{name:'arrival',process:journey.type+'StateLog',
        complete:['done'],wait:{maxSilenceSeconds:3600}}] });
    const schedules = new ScheduledActions(f.db,f.metadata);
    const runAt = new Date(Date.now()+600000).toISOString(), deadline = new Date(Date.now()+3600000).toISOString();
    for (const object of [journey,other]) await schedules.enqueue(graph,{ id:'schedule-'+object.id,
      action:'CompleteSyntheticJourney',arguments:{journey:object,revision:1},runAt,deadline });
    const s = f.db.schema;
    await f.db.query(`UPDATE ${s}.observation_interests SET next_scan=now()+interval '30 minutes'`);
    const execution = new MachineryExecution(f.db,f.capabilities.actions);
    const evaluations = t.mock.method(execution,'evaluate');
    const subscriptions = new ChangeSubscriptions(f.db,f.tasks,new MachineryWatchPlanner(f.db,f.metadata,execution));
    const watch = (object:typeof journey) => subscriptions.watchMachinery(access,model,{
      object,requestId:'watch-'+object.id,conversationId:'process-'+object.id});
    const [first, retried] = await Promise.all([watch(journey),watch(journey)]);
    assert.equal(first.id,retried.id);
    const second = await watch(other);
    evaluations.mock.resetCalls();
    const scan = async () => {
      await f.db.query(`UPDATE ${s}.change_subscriptions SET last_scan=NULL`);
      await subscriptions.scanOne();
      await subscriptions.scanOne();
    };
    const events = async () => (await f.db.query(`SELECT message FROM ${s}.task_inbox_events WHERE request_id LIKE 'subscription:%' ORDER BY received_at`)).rows.map(r=>JSON.parse(r.message));
    await assert.rejects(f.db.transaction(async client => {
      await new Objects(f.db,model,access,client).edit(hotel,1,{state:'ready'});
      throw new Error('roll back');
    }),/roll back/);
    await scan();
    assert.equal(evaluations.mock.callCount(),0);
    await graph.edit(hotel,1,{state:'ready'});
    // Fail after schedule reevaluation. The cursor, notification and schedule must all roll back.
    const send = t.mock.method(f.tasks,'submit',async () => { throw new Error('simulated delivery interruption'); });
    await f.db.query(`UPDATE ${s}.change_subscriptions SET last_scan=CASE WHEN id=$1 THEN NULL ELSE now()+interval '1 hour' END`,[first.id]);
    await assert.rejects(subscriptions.scanOne(), /simulated delivery interruption/);
    assert.deepEqual(await events(),[]);
    const saved = await f.db.query(`SELECT position::text FROM ${s}.change_subscriptions WHERE id=$1`,[first.id]);
    assert.equal(saved.rows[0]!.position,first.position);
    const held = await f.db.query(`SELECT count(*)::int AS total FROM ${s}.scheduled_actions WHERE machinery_retry_at IS NOT NULL`);
    assert.equal(held.rows[0]!.total,0);
    send.mock.restore();
    evaluations.mock.resetCalls();
    await scan();
    assert.deepEqual(evaluations.mock.calls.map(c=>c.arguments[2].object),[journey]);
    const [changed] = await events();
    assert.equal(changed.subscription,first.id);
    assert.deepEqual(changed.object,journey);
    const due = await f.db.query(`SELECT plan->'object' AS object FROM ${s}.observation_interests WHERE next_scan<=now()`);
    assert.deepEqual(due.rows.map(r=>r.object),[journey]);
    const jobs = () => f.db.query(`SELECT id,state,run_at,deadline,machinery_retry_at<=now() AS eligible FROM ${s}.scheduled_actions ORDER BY id`);
    let planned = (await jobs()).rows;
    assert.deepEqual(planned.map(job=>job.eligible),[true,null]);
    assert(planned.every(job=>job.state==='scheduled' && job.run_at.toISOString()===runAt && job.deadline.toISOString()===deadline));
    assert.equal(await schedules.promoteOne(),false,'a newly eligible Action must keep its original start time');
    await interests.scanOne();
    await scan();
    assert.equal(evaluations.mock.callCount(),1);
    assert.equal((await events()).length,1);
    await graph.unlink({type:'Journey'+hotel.type,from:journey,to:hotel});
    await scan();
    assert.equal((await events()).length,2);
    planned = (await jobs()).rows;
    assert.deepEqual(planned.map(job=>job.eligible),[false,null]);
    await f.db.query(`UPDATE ${s}.scheduled_actions SET run_at=now()-interval '1 second' WHERE id=$1`,['schedule-'+journey.id]);
    assert.equal(await schedules.promoteOne(),false,'the blocked Action stays scheduled');
    assert.deepEqual(evaluations.mock.calls.map(c=>c.arguments[2].object),[journey,journey]);
    await graph.edit(hotel,2,{state:'pending'});
    await scan();
    assert.equal(evaluations.mock.callCount(),2);
    await graph.edit(hotel,3,{state:'ready'});
    await graph.link({type:'Journey'+hotel.type,from:journey,to:hotel});
    await scan();
    assert.equal(await schedules.promoteOne(),true);
    assert.equal((await jobs()).rows[0]!.state,'started');
    assert.equal((await jobs()).rows[1]!.eligible,null);
    await subscriptions.cancel(access,second.id);
    // A restarted consumer sees the committed cursor. A later publication retires the original watch.
    const restarted = new ChangeSubscriptions(f.db,f.tasks,new MachineryWatchPlanner(f.db,f.metadata,execution));
    const count = (await events()).length;
    await f.db.query(`UPDATE ${s}.change_subscriptions SET last_scan=NULL`);
    await Promise.all([restarted.scanOne(),subscriptions.scanOne()]);
    assert.equal((await events()).length,count);
    await schedules.enqueue(graph,{ id:'held-across-release',action:'CompleteSyntheticJourney',
      arguments:{journey,revision:1},runAt,deadline });
    await graph.edit(hotel,4,{state:'pending'});
    await scan();
    const finalEventCount = (await events()).length;
    const unfinished = await f.db.query(`SELECT id FROM ${s}.tasks WHERE owner=$1 AND state IN ('submitted','working','input-required')`,[principal.owner]);
    for (const row of unfinished.rows) await f.tasks.cancel(principal,row.id);
    const next = structuredClone(model.document);
    next.version += '-next';
    const process = next.objectTypes.find(type => type.apiName===journey.type+'StateLog')!;
    for (const transition of process.machinery!.transitions) delete transition.execution;
    await f.metadata.publish(next,f.capabilities,f.publisher);
    await f.db.query(`UPDATE ${s}.change_subscriptions SET last_scan=NULL`);
    await restarted.scanOne();
    assert.deepEqual(await subscriptions.list(access),[]);
    assert.equal((await events()).length,finalEventCount);
    await f.db.query(`UPDATE ${s}.scheduled_actions SET run_at=now(),machinery_retry_at=now() WHERE id='held-across-release'`);
    assert.equal(await schedules.promoteOne(),true);
    const heldAcross = await f.db.query(`SELECT state,task_id FROM ${s}.scheduled_actions WHERE id='held-across-release'`);
    assert.deepEqual(heldAcross.rows,[{state:'blocked',task_id:null}]);
  } finally { await f.close(); }
});

test('a revoked process read stops event delivery without terminating the Indexer', async () => {
  const f = await fixture();
  try {
    const model = await f.metadata.publish(modelOf(f.model.document),f.capabilities,f.publisher);
    const grants = businessGrants(model);
    await setGrants(f.db,principal.owner,grants);
    const access = await Access.load(f.db,principal), graph = new Objects(f.db,model,access);
    await graph.create(journey,{id:journey.id,name:'journey',state:'pending'});
    const subscriptions = new ChangeSubscriptions(f.db,f.tasks,
      new MachineryWatchPlanner(f.db,f.metadata,new MachineryExecution(f.db,f.capabilities.actions)));
    const services = ontologyServices(f.db, f.metadata, f.capabilities, f.capabilities.functions, f.capabilities.effects, f.capabilities.actions);
    await services.get('watch_machinery_process')!.invoke(principal, {object:journey,requestId:'watched',conversationId:'process'});
    await graph.edit(journey,1,{state:'done'});
    await setGrants(f.db,principal.owner,[]);
    assert.equal(await subscriptions.scanOne(),true);
    assert.equal(await subscriptions.scanOne(),false);
    const { rows } = await f.db.query(`SELECT count(*)::int AS total FROM ${f.db.schema}.task_inbox_events WHERE request_id LIKE 'subscription:%'`);
    assert.equal(rows[0]!.total,0);
  } finally { await f.close(); }
});

test('the same subject in two installed Ontologies wakes only the changed installation and its original PA', async () => {
  const f = await fixture();
  try {
    const installation = await loadInstallation(resolve('tests/fixtures/installed-ontology/installation.json'));
    const runtime = installation.assemble(f.db);
    const document = modelOf(installation.model.document);
    const ids = ['FirstFixture','SecondFixture'];
    await setGrants(f.db,'fixture-publisher',ids.map(resource => ({resource,permission:'manage_definition'})));
    const publisher = await Access.load(f.db,{owner:'fixture-publisher',scopes:[]});
    const [first,second] = await Promise.all(ids.map(id=>f.metadata.publish({...document,id},runtime,publisher)));
    const actor = {...principal,clientId:'fixture-pa'};
    await setGrants(f.db,actor.owner,[...businessGrants(first!),...businessGrants(second!)]);
    const access = await Access.load(f.db,actor);
    const subscriptions = new ChangeSubscriptions(f.db,f.tasks,
      new MachineryWatchPlanner(f.db,f.metadata,new MachineryExecution(f.db,runtime.actions)));
    for (const model of [first!,second!]) {
      await new Objects(f.db,model,access).create(journey,{id:journey.id,name:'fixture',state:'pending'});
      await subscriptions.watchMachinery(access,model,{object:journey,requestId:model.document.id,conversationId:'shared-conversation'});
    }
    await new Objects(f.db,second!,access).edit(journey,1,{state:'done'});
    await subscriptions.scanOne();
    await subscriptions.scanOne();
    const wakes = await f.db.query(`SELECT ontology,release,input->>'paClient' AS client FROM ${f.db.schema}.tasks WHERE owner=$1`,[actor.owner]);
    assert.deepEqual(wakes.rows,[{ontology:'SecondFixture',release:second!.release,client:'fixture-pa'}]);
  } finally { await f.close(); }
});
