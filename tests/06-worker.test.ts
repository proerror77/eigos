import { Access, setGrants, businessGrants } from '../packages/runtime/access.js';
import { Ontology } from '../packages/ontology/model.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { createCapabilities } from '../packages/capabilities/index.js';
import { classificationSchema } from '../packages/ontology/classification.js';
import { Objects } from '../packages/runtime/objects.js';
import { digest } from '../packages/core/identity.js';
import { document, fixture, principal, route } from './fixture.js';
import { OntologyAgent } from '../packages/runtime/agent.js';
import { taskCatalogueScope } from '../packages/runtime/agent-catalogue.js';
import { businessDefinition } from '../packages/ontology/definition.js';
import { Functions } from '../packages/runtime/functions.js';
import { Actions } from '../packages/runtime/actions.js';
import { Sources } from '../packages/runtime/sources.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { setModelClearance } from '../packages/runtime/model-egress.js';
import { Worker } from '../apps/worker/worker.js';
import { harnessFixture } from './harness-fixture.js';

test('unprofiled Chinese requests rank relevant published resources before the first sixteen types', () => {
  const cargo = { apiName: 'CargoManifest', displayName: '货运清单', description: '港口货运清单保存集装箱编号',
    primaryKey: 'id', titleProperty: 'id', interfaces: {},
    properties: { id: { description: 'Identity', schema: { type: 'string' }, required: true } } };
  const model = new Ontology({ ...document, agentProfiles: [], objectTypes: [...document.objectTypes, cargo] });
  const canDefine = () => true;
  for (const message of ['麻烦核对这份港口货运清单里的集装箱编号', '查看 ＣａｒｇｏＭａｎｉｆｅｓｔ']) {
    const scope = taskCatalogueScope(model, { canDefine }, { requestId: 'rank-fallback', message });
    assert.deepEqual(scope.profiles, []);
    assert(scope.include('object', 'CargoManifest'));
  }
});

test('colloquial Chinese requests preload their published Agent profile', () => {
  const model = new Ontology(businessDefinition);
  const canDefine = () => true;
  const expected: Record<string, string> = {
    '帮我叫个车去机场多少钱': 'RideQuote', '从公司到机场打个车要多久': 'RideQuote',
    '明天下午我有空吗': 'SchedulePlanning', '帮我订个周五晚上的位子': 'Dining', '附近有什么好吃的': 'Dining',
    '下周去上海住哪里好': 'TravelOffers', '来杯拿铁': 'CoffeePickup', '我的航班延误了吗': 'TravelMonitoring',
    '外面会下雨吗': 'MapsAndWeather', '帮我报名这个周末的活动': 'Events',
  };
  for (const [message, profile] of Object.entries(expected)) {
    const scope = taskCatalogueScope(model, { canDefine }, { requestId: 'colloquial', message });
    assert(scope.profiles.some(item => item.apiName === profile), message);
  }
  for (const message of ['今天心情不太好', '帮我写一封感谢邮件', '房间有空调吗']) {
    assert.deepEqual(taskCatalogueScope(model, { canDefine }, { requestId: 'unrelated', message }).profiles, [], message);
  }
});

test('runtime modules stay provider-neutral outside listed compatibility contracts', () => {
  const provider = /\.\.\/capabilities\/[\w-]+|hotel\w*|amap\w*|didi\w*|fliggy|meituan|dianping|rollinggo|\bluma\b|luckin|stripe|taobao|shopify|xiaohongshu|variflight|flightradar|fr24|mapPlace\w*/gi;
  // Existing clients and persisted tasks still send these public request and clarification fields.
  // The organization catalogue service registers through the shared Ontology services.
  const compatibility: Record<string, string[]> = {
    'clarification.ts': ['Amap', 'amapPlaceAmendmentSchema', 'DiDi', 'MapPlace', 'mapPlaceCorrectionSchema', 'mapPlaceCorrectionsSchema'],
    'services.ts': ['../capabilities/public-places'],
    'task-input.ts': ['HotelWorkflow', 'mapPlaceCorrections', 'mapPlaceCorrectionsSchema'],
  };
  const directory = new URL('../packages/runtime/', import.meta.url);
  for (const file of readdirSync(directory).filter(name => name.endsWith('.ts'))) {
    const found = new Set([...readFileSync(new URL(file, directory), 'utf8').matchAll(provider)].map(match => match[0]));
    assert.deepEqual([...found].sort(), [...(compatibility[file] ?? [])].sort(), file);
  }
});

test('one Agent capability choice resolves unique supplier names despite different formatting and nearby entrances', async t => {
  const f = await fixture();
  try {
    const graph = new Objects(f.db, f.model, f.access);
    assert.equal((await graph.query({ type: 'Location' })).items.length, 0);
    f.provider.flags.placeName = name => name === route.origin ? '青禾·虚构园区' : name;
    const task = await f.submit(), before = f.db.queries;
    assert(await f.worker.runOne());
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state, 'completed', done.error ?? undefined);
    const result = done.result as { execution: { steps: { tool: string }[] }; estimates: { properties: { amount: string | null } }[]; accepted: boolean; elapsedMs: number; evidence: string[] };
    assert.deepEqual(result.execution.steps.map(step => step.tool), ['complete_with_action']);
    assert.equal(result.estimates.length, 2); assert.equal(result.accepted, false); assert.deepEqual(result.evidence, ['fixture']);
    assert(result.estimates.some(item => item.properties.amount === '73.05'));
    assert(result.estimates.some(item => item.properties.amount === null));
    assert(result.elapsedMs < 20000);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert(!JSON.stringify(done.result).includes('PRIVATE_ORDER_TOKEN'));
    const objects = new Objects(f.db, f.model, f.access);
    const routes = await objects.query({ type: 'RideEstimatable' }); assert.equal(routes.items.length, 1);
    assert.equal((await objects.follow(routes.items[0]!.ref, 'origin', 'RideEstimatable'))[0]!.properties.name, '青禾·虚构园区');
    assert.deepEqual((await f.db.query(`SELECT owner,executor_kind,executor_id,task_id FROM ${f.db.schema}.actions`)).rows, [{
      owner: principal.owner, executor_kind: 'agent', executor_id: 'eigos-ontology:fixture-tool-decisions', task_id: task.id,
    }]);
    const planning = (await f.db.query(`SELECT
      (SELECT count(*)::int FROM ${f.db.schema}.scenarios) AS scenarios,
      (SELECT count(*)::int FROM ${f.db.schema}.workflows) AS workflows,
      (SELECT count(*)::int FROM ${f.db.schema}.objects WHERE type='SchedulePlan') AS plans`)).rows[0];
    assert.deepEqual(planning, { scenarios: 0, workflows: 0, plans: 0 });
    assert.equal(await f.worker.runOne(), false);
    t.diagnostic(JSON.stringify({ elapsedMs: result.elapsedMs, sqlStatements: f.db.queries - before, providerCalls: f.provider.calls.length }));
  } finally { await f.close(); }
});

test('fare Actions preserve the submitted venue name and use a submitted address to break ties', async () => {
  const origin = '東發道茶冰廰·甄选(前滩店)', address = '浦东新区园照路193号';
  const decorated = `${origin}（${address}）`;
  const itinerary = { city: '上海', origin, destination: '虚构北苑99弄9号地下车库' };
  const f = await fixture({ model: 'fixture-decorated-venue', async run(_prompt, tools) {
    await tools.get('complete_with_action')!.invoke({
      action: { interface: { type: 'RideInquiry', implementation: 'RideRequest', action: 'estimate' },
        input: { ...itinerary, city: '上海市', origin: decorated } },
      read: { function: 'readRideEstimates', resultParameter: 'request' },
    });
  } });
  const quote = async (requestId: string, message: string) => {
    f.provider.calls.length = 0;
    f.provider.inputs.length = 0;
    const task = await f.tasks.submit(principal, { requestId, message, route: itinerary });
    assert(await f.worker.runOne());
    const keywords = f.provider.inputs.flatMap(input => typeof input.keywords === 'string' ? [input.keywords] : []);
    assert.deepEqual(keywords.sort(), [origin, itinerary.destination].sort());
    return f.tasks.get(principal, task.id);
  };
  try {
    f.provider.flags.related = false;
    f.provider.flags.placeName = name => name === decorated ? origin : name;
    f.provider.flags.placeAddress = name => name.startsWith(origin) ? '浦东新区三林镇园照路193、197号' : name;
    f.provider.flags.placeAlternatives = (name, place) => name.startsWith(origin) ? [
      { ...place, display_name: '园照路193号', address_all: address,
        location: { lat: 31.15, lng: 121.47 } },
    ] : [];
    const unique = await quote('structured-origin', `从${decorated}到地下车库，只询价`);
    assert.equal(unique.state, 'completed', unique.error ?? undefined);
    assert.equal((unique.result as {route: {origin: {name: string}}}).route.origin.name, origin);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);

    f.provider.flags.placeAddress = name => name.startsWith(origin) ? address : name;
    f.provider.flags.placeAlternatives = (name, place) => name.startsWith(origin) ? [
      { ...place, address_all: '浦东新区东育路500弄', location: { lat: 31.16, lng: 121.46 } },
    ] : [];
    const resolved = await quote('structured-origin-same-name', `从${decorated}到地下车库，只询价`);
    assert.equal(resolved.state, 'completed', resolved.error ?? undefined);
    assert.equal((resolved.result as {route: {origin: {address: string}}}).route.origin.address, address);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);

    const unresolved = await quote('structured-origin-no-address', `从${origin}到地下车库，只询价`);
    assert.equal(unresolved.state, 'input-required');
    assert.equal((unresolved.result as {origin: unknown[]}).origin.length, 2);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch']);
    assert.equal(f.provider.flags.orderCreates, 0);
  } finally { await f.close(); }
});

test('the production Harness discovers the Ontology and executes a simple capability through MCP',async()=>{
  const harness=await harnessFixture(),f=await fixture(harness.driver);
  try{
    const task=await f.submit();await f.worker.runOne();const done=await f.tasks.get(principal,task.id);
    assert.equal(done.state,'completed',done.error??undefined);
    const result=done.result as {execution:{steps:{tool:string}[]}};
    assert.deepEqual(result.execution.steps.map(step=>step.tool),['describe_ontology','complete_with_action']);
    assert.equal((await new Objects(f.db,f.model,f.access).query({type:'SchedulePlan'})).items.length,0);
    assert.equal((await new Scenarios(f.db).list(f.access,f.model)).items.length,0);
    assert.equal((await new Objects(f.db,f.model,f.access).query({type:'ActionConfirmation'})).items.length,0);
  }finally{await f.close();await harness.close();}
});

test('the same Agent runtime discovers and completes a different published Function without a ride recipe', async () => {
  const f = await fixture();
  try {
    const definitions = { id: 'Eigos', version: '1', objectTypes: [], interfaceTypes: [], linkTypes: [], actionTypes: [], dataSources: [],
      functionTypes: [{ apiName: 'countAvailableItems', description: 'Return the available item count', parameters: { type: 'object', properties: {}, additionalProperties: false }, returns: { type: 'integer' } }] };
    const definition = new Ontology(definitions), functions = new Functions(new Map([['countAvailableItems', () => 7]]), definition.document.functionTypes);
    const bindings = { describe: (model: Ontology) => ({ functions: functions.bindings(model), sources: {} }) };
    const published = await f.metadata.publish(definitions, bindings, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(published));
    const agent = new OntologyAgent(f.db, f.metadata, f.tasks,
      { ...bindings, functions, actions: new Actions(f.db, functions), sources: new Sources(f.db, functions, new Map()) }, {
        model: 'fixture-unrelated-domain', async run(prompt, tools) {
          assert(prompt.includes('countAvailableItems')); assert(!prompt.includes('RideEstimatable')); assert(!prompt.includes('searchPlaces'));
          const [definition] = await tools.get('describe_ontology')!.invoke({ names: ['countAvailableItems'] }) as { apiName: string }[];
          await tools.get('complete_with_function')!.invoke({ function: definition!.apiName, input: {} });
        },
      });
    const task = await f.tasks.submit(principal, { requestId: 'independent-function', message: 'How many items are available?' });
    assert.equal(task.release, published.release);
    await new Worker(f.tasks, agent).runOne();
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state, 'completed'); assert.equal((done.result as { value: number }).value, 7);
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('model prose or a fabricated completion payload cannot replace an executed result Function', async () => {
  const f = await fixture({ model: 'fixture-invalid-completion', async run(_prompt, tools) {
    await assert.rejects(tools.get('complete_with_function')!.invoke({ accepted: true, estimates: [] }));
  } });
  try {
    const task = await f.submit(); await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'failed');
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('canceling a model-driven source read prevents its late projection and further Action submission', async () => {
  const f = await fixture();
  try {
    const task = await f.submit();
    f.provider.flags.before = async () => { await f.tasks.cancel(principal, task.id).catch(() => {}); };
    await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'canceled');
    assert.equal((await new Objects(f.db, f.model, f.access).query({ type: 'RideEstimatable' })).items.length, 0);
  } finally { await f.close(); }
});
test('one confirmation resumes the original Action using current supplier receipts without another model run', async () => {
  const harness = await harnessFixture(), f = await fixture(harness.driver);
  const graph = new Objects(f.db, f.model, f.access);
  try {
    assert.equal((await graph.query({ type: 'Location' })).items.length, 0);
    f.provider.flags.ambiguous = true;
    const task = await f.submit();
    await f.worker.runOne();
    const paused = await f.tasks.get(principal, task.id);
    assert.equal(paused.state, 'input-required');
    assert.equal(f.provider.calls.length, 2);
    const pending = paused.input.placeContinuation!;
    assert.equal(pending.action, 'EstimateRide');
    const process = { type: 'ActionConfirmation', id: pending.requestId };
    assert.equal((await graph.read(process)).properties.state, 'awaiting-input');
    assert.equal((await graph.query({ type: 'PriceEstimate' })).items.length, 0);
    const candidates = paused.result as Record<'origin' | 'destination', { ref: { type: string; id: string } }[]>;
    assert.equal(candidates.origin.length, 2);
    const places = { origin: candidates.origin[0]!.ref, destination: candidates.destination[0]!.ref };
    await assert.rejects(f.tasks.selectPlaces(principal, task.id, { ...places, origin: places.destination }), /current candidates/);
    assert.equal((await graph.read(process)).properties.state, 'awaiting-input');
    // Existing operators need no new grant to drive the same authorized Action.
    const grants = businessGrants(f.model);
    await setGrants(f.db, principal.owner, grants.filter(grant => !grant.resource.includes('/ActionConfirmation')));
    const unprivileged = new Objects(f.db, f.model, await Access.load(f.db, principal));
    await assert.rejects(unprivileged.read(process), /Permission/);
    assert.equal((await f.tasks.selectPlaces(principal, task.id, places)).id, task.id);
    await f.worker.runOne();
    await setGrants(f.db, principal.owner, grants);
    const completed = await f.tasks.get(principal, task.id);
    assert.equal(completed.state, 'completed', completed.error ?? undefined);
    const result = completed.result as { request: { id: string }; execution: { mode: string }; evidence: string[] };
    assert.equal(result.request.id, pending.requestId);
    assert.equal(result.execution.mode, 'action-continuation');
    assert.deepEqual(result.evidence, ['fixture']);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    const states = await graph.follow(process, 'stateLogs');
    assert.deepEqual(states.sort((a, b) => Number(a.properties.sequence) - Number(b.properties.sequence))
      .map(row => row.properties.newState), ['awaiting-input', 'confirmed', 'completed']);
    assert.equal((await f.db.query(`SELECT count(*)::int AS count FROM ${f.db.schema}.execution_trace
      WHERE task_id=$1 AND event->>'kind'='model' AND event->>'state'='started'`, [task.id])).rows[0]!.count, 1);
    assert.equal((await f.db.query(`SELECT count(*)::int AS count FROM ${f.db.schema}.pa_requests WHERE task_id=$1`, [task.id])).rows[0]!.count, 0);
    assert.equal(f.provider.flags.orderCreates, 0);
  } finally { await f.close(); await harness.close(); }
});

test('an exact short building name cannot hide a formal building candidate from the same receipt', async () => {
  const harness = await harnessFixture(), f = await fixture(harness.driver);
  try {
    f.provider.flags.placeAddress = name => name === '上海中心' ? '徐汇区陕西南路188弄16号' : name;
    f.provider.flags.placeAlternatives = (name, place) => name === '上海中心' ? [
      { ...place, display_name: '上海中心大厦', address_all: '浦东新区银城中路501号',
        location: { lat: 31.235, lng: 121.505 } },
      { ...place, display_name: '上海中心大厦停车场', address_all: '浦东新区银城中路501号',
        location: { lat: 31.234, lng: 121.505 } },
      { ...place, display_name: '上海之巅观光厅(上海中心大厦店)', address_all: '浦东新区银城中路501号',
        location: { lat: 31.235, lng: 121.506 } },
    ] : [];
    const initial = await f.tasks.submit(principal, {
      requestId: 'shanghai-center-quote', message: '从青禾虚构园区到上海中心，只查实时价格。',
      route: { ...route, destination: '上海中心' },
    });
    await f.worker.runOne();
    const paused = await f.tasks.get(principal, initial.id);
    assert.equal(paused.state, 'input-required');
    const result = paused.result as {kind: string; origin: {ref: ObjectRef}[];
      destination: {ref: ObjectRef; properties: {name: string; address: string}}[]};
    assert.equal(result.kind, 'place-selection');
    const expected = [
      {name: '上海中心', address: '徐汇区陕西南路188弄16号'},
      {name: '上海中心大厦', address: '浦东新区银城中路501号'},
    ];
    assert.deepEqual(result.destination.map(v => ({name:v.properties.name,address:v.properties.address}))
      .sort((a,b) => a.name.length-b.name.length), expected);
    assert.deepEqual(f.provider.calls, ['maps_textsearch','maps_textsearch']);
    const selected = result.destination.find(v => v.properties.name==='上海中心大厦')!;
    const resumed = await f.tasks.selectPlaces(principal, initial.id, {origin:result.origin[0]!.ref,destination:selected.ref});
    assert.equal(resumed.id,initial.id);
    await f.worker.runOne();
    const done = await f.tasks.get(principal, initial.id);
    assert.equal(done.state,'completed',done.error ?? undefined);
    const quote = done.result as {request: ObjectRef; route: {destination:{name:string;address:string}}};
    assert.equal(quote.request.id,paused.input.placeContinuation!.requestId);
    assert.equal(quote.route.destination.address,selected.properties.address);
    assert.deepEqual(f.provider.calls, ['maps_textsearch','maps_textsearch','taxi_estimate']);
  } finally { await f.close(); await harness.close(); }
});

test('a corrected address continues the original Action and refreshes only the amended endpoint', async () => {
  const harness = await harnessFixture(), f = await fixture(harness.driver);
  try {
    f.provider.flags.placeName = name => name === route.destination ? '旧候选目的地' : name;
    f.provider.flags.placeAddress = name => name === '科投大厦' ? '徐汇区建国西路285号科投大厦' : '浦东新区' + name;
    const submitted = await f.submit();
    await f.worker.runOne();
    const paused = await f.tasks.get(principal, submitted.id);
    assert.equal(paused.state, 'input-required');
    const pending = paused.input.placeContinuation!;
    const misplaced = (paused.result as { destination: { ref: { type: string; id: string } }[] }).destination[0]!.ref;
    const amend = (address: string) => ({ side: 'destination', name: '科投大厦', address });
    await assert.rejects(f.tasks.amendPlace(principal, submitted.id, { ...amend('建国西路285号'), keep: misplaced }),
      /unchanged endpoint/);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch']);

    await f.tasks.amendPlace(principal, submitted.id, amend('建国西路286号'));
    await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, submitted.id)).state, 'input-required');
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'maps_textsearch']);

    const resumed = await f.tasks.amendPlace(principal, submitted.id, amend('上海市徐汇区建国西路285号'));
    assert.equal(resumed.id, submitted.id);
    await f.worker.runOne();
    const task = await f.tasks.get(principal, submitted.id);
    assert.equal(task.state, 'completed', task.error ?? undefined);
    const result = task.result as { request: { id: string }; route: { destination: { name: string } }; execution: { mode: string } };
    assert.equal(result.request.id, pending.requestId);
    assert.equal(result.execution.mode, 'action-continuation');
    assert.equal(result.route.destination.name, '科投大厦');
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    const inquiries = f.provider.inputs.filter(input => input.keywords).map(input => input.keywords);
    assert.equal(inquiries.filter(keyword => keyword === route.origin).length, 1);
    assert.equal(inquiries.filter(keyword => keyword === '科投大厦').length, 2);
    const rows = (await f.db.query(`SELECT request_id, action FROM ${f.db.schema}.actions WHERE task_id=$1`, [task.id])).rows;
    assert.deepEqual(rows, [{ request_id: pending.requestId, action: 'EstimateRide' }]);
    const started = await f.db.query(`SELECT 1 FROM ${f.db.schema}.execution_trace
      WHERE task_id=$1 AND event->>'kind'='model' AND event->>'state'='started'`, [task.id]);
    assert.equal(started.rowCount, 1);
  } finally { await f.close(); await harness.close(); }
});

test('missing city pauses the original Action before source reads and resumes after the owner supplies it', async () => {
  let modelCalls = 0;
  const f = await fixture({ model: 'city-input-test', async run(_prompt, tools) {
    modelCalls++;
    await tools.get('complete_with_action')!.invoke({
      action: { interface: { type: 'RideInquiryWithPlaceClues', implementation: 'RideRequest', action: 'estimate' },
        input: { origin: route.origin, destination: route.destination } },
      read: { function: 'readRideEstimates', resultParameter: 'request' },
    });
  } });
  try {
    const { id } = await f.tasks.submit(principal, { requestId: 'city-quote', message: 'Estimate my ride without a city.' });
    await f.worker.runOne();
    const paused = await f.tasks.get(principal, id);
    assert.equal(paused.state, 'input-required');
    assert.deepEqual(paused.result, { kind: 'city' });
    assert.equal(paused.input.placeContinuation!.waitingFor, 'city');
    assert.equal(f.provider.calls.length, 0);
    await assert.rejects(f.tasks.answerInput({ ...principal, owner: 'some-other-owner' }, id, { kind: 'city', city: '上海市' }), /not waiting/);
    const answer = await f.tasks.answerInput(principal, id, { kind: 'city', city: '上海市' });
    assert.equal(answer.id, id);
    await f.worker.runOne();
    const done = await f.tasks.get(principal, id);
    assert.equal(done.state, 'completed', done.error ?? undefined);
    assert.equal((done.result as {request: {id: string}}).request.id, paused.input.placeContinuation!.requestId);
    assert.equal(modelCalls, 1);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate', 'maps_direction_driving']);
    assert(f.provider.inputs.slice(0, 2).every(input => input.city === '上海市'));
  } finally { await f.close(); }
});

test('a landmark returns a single named address and waits for confirmation on the original Action', async () => {
  const f = await fixture();
  try {
    f.provider.flags.placeName = name => name === '太古里' ? '前滩太古里' : name;
    f.provider.flags.placeAddress = name => name === '太古里' ? '浦东新区东育路500弄前滩太古里' : name;
    f.provider.flags.placeAlternatives = (name, place) => name === '太古里'
      ? [{ ...place, display_name: '华为旗舰店·上海前滩太古里', address_all: '浦东新区东育路500弄1号商铺',
        location: { ...place.location, lat: place.location.lat + 0.001 } }]
      : [];
    const task = await f.tasks.submit(principal, { requestId: 'landmark-quote', message: '只询价',
      route: { ...route, destination: '太古里' } });
    await f.worker.runOne();
    const paused = await f.tasks.get(principal, task.id);
    assert.equal(paused.state, 'input-required');
    const continued = await f.tasks.amendPlace(principal, task.id, { side: 'destination', landmark: '东方体育中心' });
    assert.equal(continued.id, task.id);
    await f.worker.runOne();
    const suggested = await f.tasks.get(principal, task.id);
    assert.equal(suggested.state, 'input-required');
    const choices = suggested.result as {kind: string; origin: {ref: ObjectRef}[];
      destination: {ref: ObjectRef; properties: {name: string; address: string}}[]};
    assert.equal(choices.kind, 'place-selection');
    assert.equal(choices.destination.length, 1);
    assert.equal(choices.destination[0]!.properties.name, '前滩太古里');
    assert.equal(choices.destination[0]!.properties.address, '浦东新区东育路500弄前滩太古里');
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'maps_textsearch', 'maps_textsearch']);
    assert.equal(suggested.input.placeContinuation!.requestId, paused.input.placeContinuation!.requestId);
    await f.tasks.selectPlaces(principal, task.id, {origin: choices.origin[0]!.ref, destination: choices.destination[0]!.ref});
    await f.worker.runOne();
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state, 'completed', done.error ?? undefined);
    const quote = done.result as {request: {id: string}; route: {destination: {name: string}}};
    assert.equal(quote.request.id, paused.input.placeContinuation!.requestId);
    assert.equal(quote.route.destination.name, '前滩太古里');
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    const keywords = f.provider.inputs.map(item => item.keywords).filter(Boolean);
    assert.equal(keywords.filter(name => name === route.origin).length, 1);
    assert(keywords.includes('东方体育中心'));
  } finally { await f.close(); }
});

test('empty source candidates request more address information on the original task', async () => {
  const f = await fixture();
  try {
    f.provider.flags.emptyPlaces = name => name === route.destination;
    f.provider.flags.related = false;
    const task = await f.submit();
    await f.worker.runOne();
    const paused = await f.tasks.get(principal, task.id);
    assert.equal(paused.state, 'input-required');
    const input = paused.result as {kind: string; needsAddress: string[]; destination: unknown[]};
    assert.deepEqual([input.kind, input.needsAddress, input.destination], ['place-address-required', ['destination'], []]);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch']);
    await f.tasks.amendPlace(principal, task.id, {side:'destination', address:'建国西路285号'});
    await f.worker.runOne();
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state,'completed',done.error ?? undefined);
    assert.equal((done.result as { request: ObjectRef }).request.id, paused.input.placeContinuation!.requestId);
    assert.deepEqual(f.provider.calls, ['maps_textsearch','maps_textsearch','maps_textsearch','taxi_estimate']);
  } finally { await f.close(); }
});

test('a paused supplier retry releases the next chat batch and resumes the original Action safely', async () => {
  const f = await fixture();
  try {
    f.provider.flags.failPlaceSearch = true;
    const submit = (requestId: string) => f.tasks.submit(principal, {
      requestId, conversationId: 'ride-estimate-chat', message: '从青禾虚构园区到前滩太古里，只询价', route,
    });
    const makeAvailable = (id: string) => f.db.query(
      `UPDATE ${f.db.schema}.tasks SET available_at=now() WHERE id=$1`, [id]);
    const task = await submit('before-supplier-recovery');
    await makeAvailable(task.id);
    await f.worker.runOne();
    const paused = await f.tasks.get(principal, task.id);
    assert.equal(paused.state, 'input-required');
    assert.deepEqual(paused.result, { kind: 'retry-source', source: 'DiDi', stage: 'places' });
    await assert.rejects(f.tasks.amendPlace(principal, task.id, {side:'destination', address:'建国西路285号'}), /no place candidates/);
    assert.deepEqual((await f.db.query(`SELECT state FROM ${f.db.schema}.source_calls WHERE task_id=$1 ORDER BY name`,[task.id])).rows,
      [{state:'failed'}, {state:'failed'}]);
    const fresh = await submit('after-supplier-recovery');
    await makeAvailable(fresh.id);
    assert.equal((await f.tasks.claim())?.id, fresh.id);
    assert.equal((await f.tasks.get(principal, task.id)).state, 'input-required');

    f.provider.flags.failPlaceSearch = false;
    await f.tasks.answerInput(principal, task.id, {kind:'retry-source'});
    assert.equal(await f.tasks.claim(), undefined);
    await f.db.query(`UPDATE ${f.db.schema}.tasks SET lease_until=now()-interval '1 second' WHERE id=$1`, [fresh.id]);
    assert(await f.worker.runOne());
    assert.equal((await f.tasks.get(principal, fresh.id)).state, 'completed');

    await f.worker.runOne();
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state,'completed',done.error ?? undefined);
    assert.equal((done.result as { request: ObjectRef }).request.id, paused.input.placeContinuation!.requestId);
    const started = (await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.execution_trace
      WHERE task_id=$1 AND event->>'kind'='model' AND event->>'state'='started'`, [task.id])).rows[0]!.n;
    assert.equal(started, 1);
  } finally { await f.close(); }
});

test('an expired saved place receipt is refreshed without asking the model to choose again', async () => {
  const f = await fixture();
  try {
    f.provider.flags.ambiguous = true;
    const task = await f.submit();
    await f.worker.runOne();
    const paused = await f.tasks.get(principal, task.id);
    assert.equal(paused.state, 'input-required');
    const pending = paused.input.placeContinuation!;
    const candidates = paused.result as Record<'origin' | 'destination', { ref: { type: string; id: string } }[]>;
    await f.db.query(`UPDATE ${f.db.schema}.objects SET properties=jsonb_set(properties,'{observedAt}',to_jsonb($2::text))
      WHERE type='SourceReceipt' AND id=$1`, [pending.receipts!.origin.id, new Date(Date.now()-310000).toISOString()]);
    await f.tasks.selectPlaces(principal, task.id, { origin: candidates.origin[0]!.ref, destination: candidates.destination[0]!.ref });
    await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'completed');
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
  } finally { await f.close(); }
});

test('revoking all access after place confirmation closes the process without a supplier quote', async () => {
  const f = await fixture();
  try {
    f.provider.flags.ambiguous = true;
    const task = await f.submit();
    await f.worker.runOne();
    const paused = await f.tasks.get(principal, task.id);
    assert.equal(paused.state, 'input-required');
    const candidates = paused.result as Record<'origin' | 'destination', { ref: { type: string; id: string } }[]>;
    await f.tasks.selectPlaces(principal, task.id, { origin: candidates.origin[0]!.ref, destination: candidates.destination[0]!.ref });
    await setGrants(f.db, principal.owner, []);
    await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'failed');
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch']);
    await setGrants(f.db, principal.owner, businessGrants(f.model));
    const graph = new Objects(f.db, f.model, await Access.load(f.db, principal));
    const process = { type: 'ActionConfirmation', id: paused.input.placeContinuation!.requestId };
    assert.equal((await graph.read(process)).properties.state, 'failed');
  } finally { await f.close(); }
});

test('revocation during the real connector callback cannot produce an accepted inquiry', async () => {
  const f = await fixture();
  try {
    f.provider.flags.before = async () => { f.provider.flags.active = false; };
    const task = await f.submit(); await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'failed');
    assert.equal((await new Objects(f.db, f.model, f.access).query({ type: 'PriceEstimate' })).items.length, 0);
  } finally { await f.close(); }
});

test('task-only PA permission executes the inquiry through the source-bound Worker', async () => {
  const f = await fixture();
  try {
    const caller = { owner: principal.owner, scopes: ['tasks:read', 'tasks:write'] };
    const task = await f.tasks.submit(caller, { requestId: 'task-permission', message: '上海只询价', route });
    await f.worker.runOne();
    assert.equal((await f.tasks.get(caller, task.id)).state, 'completed');
    await setGrants(f.db, principal.owner, businessGrants(f.model).filter(grant => grant.permission !== 'apply_action'));
    await assert.rejects(f.capabilities.actions.apply(await Access.load(f.db, caller), f.model, 'EstimateRide', route, 'direct-write'), /Permission/);
  } finally { await f.close(); }
});

test('the fare-only prompt uses the named inquiry when the interactive result Function is not executable', async () => {
  const f = await fixture({
    model: 'scoped-ride-quotes',
    provider: 'openai-codex',
    async run(prompt, tools) {
      const instructions = prompt.split('\n').slice(0, -1).join('\n');
      assert.match(instructions, /RideInquiry\.estimate on RideRequest and readRideEstimates/);
      assert.doesNotMatch(instructions, /readInteractiveRideEstimate/);
      await tools.get('complete_with_action')!.invoke({
        action: { interface: { type: 'RideInquiry', implementation: 'RideRequest', action: 'estimate' },
          input: { ...route, serviceClass: '专车' } },
        read: { function: 'readRideEstimates', resultParameter: 'request' },
      });
    },
  });
  try {
    await setGrants(f.db, principal.owner, businessGrants(f.model).filter(grant =>
      grant.permission !== 'execute_function' || !grant.resource.endsWith('/readInteractiveRideEstimate')));
    const task = await f.tasks.submit(principal, { requestId: 'scoped-ride-quote', message: '上海从青禾虚构园区到前滩太古里，只查专车估价。' });
    assert(await f.worker.runOne());
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state, 'completed', done.error ?? undefined);
    const result = done.result as { estimates: { properties: { name: string; priceText: string } }[] };
    assert.deepEqual(result.estimates.map(({ properties }) => [properties.name, properties.priceText]),
      [['专车', '100-120元']]);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert.equal(f.provider.flags.orderCreates, 0);
  } finally { await f.close(); }
});

test('a missing tool grant fails before supplier calls and is distinct from model egress policy denial', async () => {
  const f = await fixture({
    model: 'scoped-ride-quotes',
    provider: 'openai-codex',
    async run(_prompt, tools) {
      await tools.get('complete_with_action')!.invoke({
        action: { interface: { type: 'RideInquiryWithPlaceClues', implementation: 'RideRequest', action: 'estimate' },
          input: route },
        read: { function: 'readInteractiveRideEstimate', resultParameter: 'request' },
      });
    },
  });
  try {
    await setGrants(f.db, principal.owner, businessGrants(f.model).filter(grant =>
      grant.permission !== 'execute_function' || !grant.resource.endsWith('/readInteractiveRideEstimate')));
    const task = await f.submit();
    assert(await f.worker.runOne());
    assert.equal((await f.tasks.get(principal, task.id)).state, 'failed');
    const traces = await f.db.query(`SELECT event->>'code' AS code FROM ${f.db.schema}.execution_trace
      WHERE task_id=$1 AND event->>'kind'='egress' AND event->>'state'='blocked'`, [task.id]);
    assert.deepEqual(traces.rows, [{ code: 'tool_permission_denied' }]);
    assert.deepEqual(f.provider.calls, []);
  } finally { await f.close(); }
});

test('a rate-limited quote revalidates stored DiDi endpoints nearby and rejects moved points', async () => {
  const f = await fixture();
  try {
    f.provider.flags.related = false;
    for (const keywords of [route.origin, route.destination]) {
      await f.capabilities.sources.refresh(f.model, 'DidiPlaces', { city: route.city, keywords },
        f.access, undefined, undefined, AbortSignal.timeout(5000));
    }
    f.provider.calls.length = 0;
    f.provider.flags.rateLimitPlaceSearch = true;
    f.provider.flags.related = true;
    const task = await f.submit();
    assert(await f.worker.runOne());
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state, 'completed', done.error ?? undefined);
    assert.deepEqual([...f.provider.calls].sort(),
      ['maps_place_around', 'maps_place_around', 'maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert.equal(f.provider.calls.at(-1), 'taxi_estimate');
    const objects = new Objects(f.db, f.model, f.access);
    assert.equal((await objects.query({ type: 'Place' })).items.length, 2);
    assert.equal((await objects.query({ type: 'SourceReceipt', where: { tool: 'maps_place_around' } })).items.length, 2);

    f.provider.calls.length = 0;
    f.provider.flags.moveNearbyPlace = true;
    const moved = await f.submit();
    assert(await f.worker.runOne());
    const pending = await f.tasks.get(principal, moved.id);
    assert.equal(pending.state, 'input-required');
    assert.deepEqual(pending.result, { kind: 'retry-source', source: 'DiDi', stage: 'places' });
    assert(!f.provider.calls.includes('taxi_estimate'));
    assert.equal(f.provider.flags.orderCreates, 0);
  } finally { await f.close(); }
});

test('revoked data rights also remove access to a cached task result', async () => {
  const f = await fixture();
  try {
    const task = await f.submit(); await f.worker.runOne();
    assert((await f.tasks.get(principal, task.id)).result);
    await setGrants(f.db, principal.owner, businessGrants(f.model).filter(grant => grant.resource !== 'Eigos/object/Place' || grant.permission !== 'view_objects'));
    const hidden = await f.tasks.get(principal, task.id);
    assert.equal(hidden.state, 'completed'); assert.equal(hidden.result, null);
    const retry = await f.tasks.submit(principal, task.input);
    assert.equal(retry.id, task.id); assert.equal(retry.result, null);
  } finally { await f.close(); }
});

test('permission revocation during a source response blocks late business edits', async () => {
  const f = await fixture();
  try {
    f.provider.flags.before = async () => { await setGrants(f.db, principal.owner, businessGrants(f.model).filter(grant => grant.permission !== 'read_source')); };
    const task = await f.submit(); await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'failed');
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.objects WHERE projection=$1 AND type='RideRequest'`, [f.model.projection])).rows[0]!.n, 0);
  } finally { await f.close(); }
});

test('the production database role can execute an inquiry without publication update privileges', async () => {
  const f = await fixture();
  const role = 'eigos_limited_' + f.schema.slice(-32);
  let limited: import('../packages/runtime/database.js').Database | undefined;
  try {
    await f.db.query(`CREATE ROLE "${role}"`);
    await f.db.query(`GRANT USAGE ON SCHEMA ${f.db.schema} TO "${role}";
      GRANT SELECT ON ${f.db.schema}.ontology,${f.db.schema}.releases,${f.db.schema}.resource_grants,${f.db.schema}.property_security,${f.db.schema}.object_policies,${f.db.schema}.security_memberships,${f.db.schema}.edit_policies,${f.db.schema}.ontology_resource_projects,${f.db.schema}.entity_bindings,${f.db.schema}.entity_binding_history TO "${role}";
      GRANT SELECT,INSERT,UPDATE ON ${f.db.schema}.objects,${f.db.schema}.tasks,${f.db.schema}.source_calls TO "${role}";
      GRANT SELECT,INSERT ON ${f.db.schema}.task_inbox_events TO "${role}";
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${f.db.schema}.source_values,${f.db.schema}.object_edits TO "${role}";
      GRANT SELECT,INSERT ON ${f.db.schema}.edit_history TO "${role}";
      GRANT SELECT,INSERT ON ${f.db.schema}.link_history,${f.db.schema}.change_commits TO "${role}";
      GRANT SELECT ON ${f.db.schema}.change_journal TO "${role}";
      GRANT INSERT ON ${f.db.schema}.execution_trace TO "${role}";
      GRANT SELECT,INSERT,UPDATE ON ${f.db.schema}.action_changes,${f.db.schema}.action_undo_requests,${f.db.schema}.scenario_sessions TO "${role}";
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${f.db.schema} TO "${role}";
      GRANT SELECT,INSERT ON ${f.db.schema}.links,${f.db.schema}.actions,${f.db.schema}.execution_trace TO "${role}";`);
    const { Database } = await import('../packages/runtime/database.js');
    const { Metadata } = await import('../packages/runtime/metadata.js');
    const { Tasks } = await import('../packages/runtime/tasks.js');
    const { createCapabilities } = await import('../packages/capabilities/index.js');
    const { FixtureAgent } = await import('./agent-driver.js');
    const url = new URL(process.env.EIGOS_TEST_DATABASE_URL!); url.searchParams.set('options', '-c role=' + role);
    limited = new Database(url.toString(), f.schema);
    const metadata = new Metadata(limited), tasks = new Tasks(limited, metadata), capabilities = createCapabilities(limited, f.source);
    const worker = new Worker(tasks, new OntologyAgent(limited, metadata, tasks, capabilities, new FixtureAgent()));
    await assert.rejects(limited.query(`UPDATE ${limited.schema}.ontology SET release=release`), /permission denied/);
    const task = await tasks.submit(principal, { requestId: 'production-role', conversationId: 'production-role-chat', message: '只询价', route });
    await f.db.query(`UPDATE ${f.db.schema}.tasks SET available_at=now() WHERE id=$1`, [task.id]);
    await worker.runOne();
    assert.equal((await tasks.get(principal, task.id)).state, 'completed');
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    worker.stop();
  } finally {
    await limited?.close();
    await f.db.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    await f.close();
  }
});

test('the Agent evaluates, aggregates and completes object sets in the task Scenario', async () => {
  const ref = { type: 'Route', id: 'scenario-set-route' };
  const set = { op: 'refs', objects: [ref] };
  const metrics = { n: { op: 'count' } };
  const f = await fixture({ model: 'fixture-scenario-object-set', async run(prompt, tools) {
    const { scenarioId, completion } = JSON.parse(JSON.parse(prompt.split('\n').at(-1)!).userRequest.message) as
      { scenarioId?: string; completion?: string };
    assert(scenarioId);
    const invoke = (name: string, input: unknown) => tools.get(name)!.invoke(input);
    const live = await invoke('evaluate_object_set', { set }) as { items: { properties: { name: string } }[] };
    assert.equal(live.items[0]!.properties.name, 'Live');
    const candidate = await invoke('evaluate_object_set', { set, scenarioId }) as typeof live;
    assert.equal(candidate.items[0]!.properties.name, 'Proposed');
    const proposed = { op: 'query', query: { type: 'Route', where: { name: 'Proposed' } } };
    const liveCount = await invoke('aggregate_object_set', { set: proposed, metrics }) as { count: number };
    const scenarioCount = await invoke('aggregate_object_set', { set: proposed, metrics, scenarioId }) as typeof liveCount;
    assert.equal(liveCount.count, 0);
    assert.equal(scenarioCount.count, 1);
    await assert.rejects(invoke('evaluate_object_set', { set, scenarioId: '7c03109b-4281-4e2b-ace3-8ca697184b8e' }), /Scenario is unavailable/);
    if (completion === 'aggregate') await invoke('complete_with_aggregate', { set: proposed, metrics, scenarioId });
    else await invoke('complete_with_object_set', { set, scenarioId });
  } });
  try {
    await new Objects(f.db, f.model, f.access).create(ref, { id: ref.id, name: 'Live' });
    const scenarios = new Scenarios(f.db);
    const scene = await scenarios.create(f.access, f.model, { requestId: 'task-set-scenario', name: 'Proposal' });
    const view = await scenarios.view(f.access, f.model, scene.id);
    await new Objects(f.db, view, f.access).edit(ref, 1, { name: 'Proposed' });
    for (const completion of ['set', 'aggregate']) {
      const task = await f.tasks.submit(principal, { requestId: 'scenario-complete-' + completion,
        message: JSON.stringify({ scenarioId: scene.id, completion }) });
      assert(await f.worker.runOne());
      const done = await f.tasks.get(principal, task.id);
      assert.equal(done.state, 'completed', done.error ?? undefined);
      const result = done.result as { count?: number; items: { properties: { name: string } }[] };
      if (completion === 'aggregate') assert.equal(result.count, 1);
      else assert.equal(result.items[0]!.properties.name, 'Proposed');
    }
  } finally { await f.close(); }
});

test('the initial model context requires the exact destination and every compartment before invoking the driver', async () => {
  const clearance = { sensitivity: 'CONFIDENTIAL', compartments: ['FINANCE', 'SUPPLIER_RATE'] } as const;
  const model = 'fixture-classified-input';
  let starts = 0;
  const f = await fixture({ model, provider: 'openai-codex', async run(prompt, tools) {
    starts++;
    assert.match(prompt, /private planning detail/);
    await tools.get('complete_with_object_set')!.invoke({ set: { op: 'refs', objects: [] } });
  } });
  try {
    const submit = (requestId: string) => f.tasks.submit(principal, {
      requestId, message: 'private planning detail', classification: clearance,
    });
    await setModelClearance(f.db, { owner: 'other-owner', provider: 'openai-codex', model, clearance });
    await setModelClearance(f.db, { owner: principal.owner, provider: 'other-provider', model, clearance });
    for (const key of ['no-exact-policy', 'missing-compartment']) {
      const task = await submit(key);
      await f.worker.runOne();
      assert.equal((await f.tasks.get(principal, task.id)).state, 'failed');
      assert.equal(starts, 0);
      const trace = (await f.db.query(`SELECT event FROM ${f.db.schema}.execution_trace WHERE task_id=$1 ORDER BY sequence`, [task.id])).rows;
      assert.equal(trace.length, 1);
      assert.equal(trace[0]!.event.state, 'blocked');
      await setModelClearance(f.db, { owner: principal.owner, provider: 'openai-codex', model,
        clearance: { sensitivity: 'CONFIDENTIAL', compartments: ['FINANCE'] } });
    }
    await setModelClearance(f.db, { owner: principal.owner, provider: 'openai-codex', model, clearance });
    const authorized = await submit('authorized-confidential');
    await f.worker.runOne();
    const done = await f.tasks.get(principal, authorized.id);
    assert.equal(done.state, 'completed', done.error ?? undefined);
    assert.equal(starts, 1);
    const result = done.result as { execution: { steps: { input?: unknown; resultDigest?: string }[] } };
    assert(!Object.hasOwn(result.execution.steps[0]!, 'input'));
    assert(!Object.hasOwn(result.execution.steps[0]!, 'resultDigest'));
    assert(!JSON.stringify(done.result).includes('private planning detail'));
  } finally { await f.close(); }
});

test('the model catalogue and definition tool omit classified types and field metadata', async () => {
  const definition = structuredClone(document);
  const classification = { sensitivity: 'CONFIDENTIAL' as const, compartments: ['FINANCE'] };
  definition.objectTypes.find(type => type.apiName === 'RideRequest')!.classification = classification;
  definition.objectTypes.find(type => type.apiName === 'Route')!.properties.name!.classification = classification;
  const f = await fixture({
    model: 'fixture-model-catalogue', provider: 'openai-codex',
    async run(prompt, tools) {
      const description = JSON.parse(prompt.split('\n').at(-1)!).ontology;
      assert(!description.objects.some((type: { apiName: string }) => type.apiName === 'RideRequest'));
      const schemas = await tools.get('describe_ontology')!.invoke({ names: ['RideRequest', 'Route'] }) as
        { apiName: string; properties: Record<string, unknown> }[];
      assert.deepEqual(schemas.map(record => record.apiName), ['Route']);
      assert(!Object.hasOwn(schemas[0]!.properties, 'name'));
      await tools.get('complete_with_object_set')!.invoke({ set: { op: 'refs', objects: [] } });
    },
  }, undefined, undefined, definition);
  try {
    const task = await f.tasks.submit(principal, { requestId: 'egress-catalogue', message: 'List the available operations' });
    await f.worker.runOne();
    const result = await f.tasks.get(principal, task.id);
    assert.equal(result.state, 'completed', result.error ?? undefined);
  } finally { await f.close(); }
});

test('classified chunks are excluded before model filters and forced references, and grants are rechecked after each call', async () => {
  const model = 'fixture-document-egress';
  const title = 'protected procurement detail';
  const clearance = { sensitivity: 'CONFIDENTIAL', compartments: ['FINANCE'] };
  const useModel = { owner: principal.owner, provider: 'openai-codex', model, clearance };
  let document: { type: string; id: string }, chunk: { type: string; id: string };
  let expectVisible = false;
  const f = await fixture({ model, provider: 'openai-codex', async run(_prompt, tools) {
    const query = (value: string) => tools.get('query_ontology')!.invoke({ queries: [{
      type: 'OperationalDocumentChunk', filter: { op: 'contains', property: 'text', value },
    }] });
    if (expectVisible) {
      const visible = JSON.stringify(await query(title));
      assert(visible.includes(title));
      assert(visible.includes(chunk.id));
      await setModelClearance(f.db, { ...useModel, active: false });
      await assert.rejects(query(title), /^Error: Data is unavailable to the selected model$/);
      return;
    }
    assert.deepEqual(await query(title), await query('no matching text'));
    await assert.rejects(tools.get('complete_with_object_set')!.invoke({ set: { op: 'refs', objects: [chunk] } }),
      /^Error: Data is unavailable to the selected model$/);
    await tools.get('complete_with_object_set')!.invoke({ set: { op: 'refs', objects: [] } });
  } });
  try {
    const plan = { type: 'SchedulePlan', id: 'doc-plan' }, graph = new Objects(f.db, f.model, f.access);
    await graph.create(plan, { id: plan.id, name: 'Plan', start: '2027-01-01T08:00:00Z', end: '2027-01-01T10:00:00Z', timeZone: 'UTC', durationMinutes: 60 });
    document = await f.capabilities.actions.apply(f.access, f.model, 'RegisterSchedulePlanDocument', {
      plan, documentKey: 'budget-document', edition: '1', name: 'Budget', mediaType: 'application/pdf',
      sourceRef: 'records/budget', contentSha256: 'b'.repeat(64), extractedText: title, classification: clearance,
    }, 'classified-document');
    chunk = (await graph.follow(document, 'chunks'))[0]!.ref;
    // Protect against a chunk row missing its own valid label by reading the real parent classification.
    await f.db.query(`UPDATE ${f.db.schema}.objects SET properties=properties-'classification'
      WHERE owner=$1 AND id=$2 AND type=$3`, [principal.owner, chunk.id, chunk.type]);
    const denied = await f.tasks.submit(principal, { requestId: 'hidden-chunk', message: 'Check document availability' });
    await f.worker.runOne();
    const completed = await f.tasks.get(principal, denied.id);
    assert.equal(completed.state, 'completed', completed.error ?? undefined);
    assert(!JSON.stringify(completed.result).includes(chunk.id));

    expectVisible = true;
    await setModelClearance(f.db, useModel);
    const revoked = await f.tasks.submit(principal, { requestId: 'revoked-chunk', message: 'Check document availability' });
    await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, revoked.id)).state, 'failed');
    const records = (await f.db.query(`SELECT event,requirements FROM ${f.db.schema}.execution_trace
      WHERE task_id=ANY($1::uuid[]) ORDER BY sequence`, [[denied.id, revoked.id]])).rows;
    assert(records.filter(row => row.event.kind === 'egress' && row.event.state === 'blocked').length >= 2);
    for (const secret of [title, document.id, chunk.id, 'FINANCE']) assert(!JSON.stringify(records).includes(secret));
  } finally { await f.close(); }
});

test('linked derived values retain their classification through grant downgrade and workflow capture', async () => {
  const f = await fixture();
  let worker: Worker | undefined;
  try {
    const modelName = 'fixture-derived-egress';
    const clearance = { sensitivity: 'CONFIDENTIAL' as const, compartments: ['FINANCE'] };
    const destination = { owner: principal.owner, provider: 'openai-codex', model: modelName };
    const resource = { type: 'ScheduleResource', id: 'derived-egress-resource' };
    const activity = { type: 'ScheduledActivity', id: 'derived-egress-dependency' };
    const protectedMinutes = 7319;
    const definition = structuredClone(document);
    const activityType = definition.objectTypes.find(type => type.apiName === activity.type)!;
    activityType.classificationProperty = 'disclosure';
    activityType.properties.disclosure = { description: 'Fixture row classification', schema: z.toJSONSchema(classificationSchema), required: false };
    activityType.properties.reviewMinutes = { description: 'Time recorded by the fixture', schema: { type: 'number' }, required: false };
    definition.objectTypes.find(type => type.apiName === resource.type)!.properties.reviewMinutes = {
      description: 'Total review time', schema: { type: 'number' }, required: false,
      derived: { op: 'linked', path: [{ link: 'activities' }], aggregate: 'sum', property: 'reviewMinutes' },
    };
    const read = {
      apiName: 'ReadDerivedReviewMinutes', version: '1', description: 'Read the derived scheduling total',
      parameters: { type: 'object', properties: { downgrade: { type: 'boolean' } }, required: ['downgrade'], additionalProperties: false },
      returns: { type: 'number' }, dependencies: { objectTypes: [resource.type, activity.type], linkTypes: ['ActivityResource'] },
    };
    definition.functionTypes.push(read);
    const capabilities = createCapabilities(f.db, f.source, { functions: [{
      definition: read, implementationId: 'fixture-derived-egress-1',
      async handler(input, context) {
        const total = (await context.objects.read(resource)).properties.reviewMinutes;
        assert.equal(total, protectedMinutes);
        if (input.downgrade) {
          await setModelClearance(f.db, { ...destination, clearance: { sensitivity: 'INTERNAL', compartments: [] } });
        }
        return total;
      },
    }] });
    const model = await f.metadata.publish(definition, capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const graph = new Objects(f.db, model, await Access.load(f.db, principal));
    await graph.create(resource, { id: resource.id, name: 'Review calendar' });
    await graph.create(activity, {
      id: activity.id, name: 'Review', start: '2027-01-01T08:00:00Z', end: '2027-01-01T09:00:00Z',
      disclosure: clearance, reviewMinutes: protectedMinutes,
    });
    await graph.link({ type: 'ActivityResource', from: activity, to: resource });
    const agent = new OntologyAgent(f.db, f.metadata, f.tasks, capabilities, {
      model: modelName, provider: destination.provider,
      async run(prompt, tools) {
        const { userRequest } = JSON.parse(prompt.split('\n').at(-1)!);
        const denied = /^Error: Data is unavailable to the selected model$/;
        if (userRequest.learnHotelWorkflow) {
          await assert.rejects(tools.get('query_ontology')!.invoke({
            queries: [{ type: resource.type, select: ['reviewMinutes'] }],
          }), denied);
          await tools.get('request_clarification')!.invoke({ message: 'Use a public schedule instead.' });
          return;
        }
        const downgrade = userRequest.message === 'downgrade';
        const result = tools.get('evaluate_function')!.invoke({ function: read.apiName, input: { downgrade } });
        if (downgrade) await assert.rejects(result, denied);
        else assert.equal(await result, protectedMinutes);
        await tools.get('complete_with_object_set')!.invoke({ set: { op: 'refs', objects: [] } });
      },
    });
    worker = new Worker(f.tasks, agent);
    for (const requestId of ['authorized', 'downgrade', 'capture']) {
      await setModelClearance(f.db, { ...destination, clearance });
      const task = await f.tasks.submit(principal, {
        requestId, message: requestId, ...(requestId === 'capture' ? { learnHotelWorkflow: true } : {}),
      });
      assert(await worker.runOne());
      const result = await f.tasks.get(principal, task.id);
      assert.equal(result.state, requestId === 'capture' ? 'input-required' : 'completed', result.error ?? undefined);
      if (requestId !== 'authorized') {
        const events = (await f.db.query(`SELECT event FROM ${f.db.schema}.execution_trace WHERE task_id=$1`, [task.id])).rows;
        assert(events.some(row => row.event.kind === 'egress' && row.event.state === 'blocked'));
        assert(!JSON.stringify(result.result).includes(String(protectedMinutes)));
      }
      if (requestId === 'capture') {
        const saved = (await f.db.query(`SELECT workflow_trace FROM ${f.db.schema}.tasks WHERE id=$1`, [task.id])).rows[0]!;
        assert.deepEqual(saved.workflow_trace, []);
      }
    }
  } finally { worker?.stop(); await f.close(); }
});

test('task prompts preload the selected capability and keep sandbox tools out of production discovery', async t => {
  const f = await fixture({
    model: 'fixture-profile-scope',
    async run(prompt, tools) {
      const { ontology, userRequest } = JSON.parse(prompt.split('\n').at(-1)!);
      const actions = ontology.actions.map((action: { apiName: string }) => action.apiName);
      assert(prompt.length < 30_000, `Prompt is ${prompt.length} characters`);
      t.diagnostic(`${userRequest.route ? 'Ride' : 'Calendar'} prompt: ${prompt.length} characters`);
      if (userRequest.route) {
        assert(actions.includes('EstimateRide'));
        assert(!actions.includes('PrepareSchedulePlan'));
      } else {
        assert(actions.includes('PrepareSchedulePlan'));
        assert(!actions.includes('EstimateRide'));
        assert.match(prompt, /original PA and resumes this same task/);
      }
      const discover = tools.get('describe_ontology')!;
      const compact = await discover.invoke({}) as { actions: { apiName: string }[] };
      assert(compact.actions.some(action => action.apiName === 'PrepareSchedulePlan'));
      assert(!compact.actions.some(action => action.apiName === 'PrepareDiningTestReservation'));
      assert.deepEqual(await discover.invoke({
        names: ['PrepareDiningTestReservation', 'CreateStripeSandboxOrder', 'createStripeSandboxOrder'],
      }), []);
      const order = { action: 'CreateStripeSandboxOrder', input: { orderKey: '1ef80429-639b-4ed0-9d61-84e43d211b6b' } };
      await assert.rejects(tools.get('apply_action')!.invoke(order), /requires a sandbox Agent/);
      const sandboxOrder = { type: 'StripeSandboxOrder', id: 'unsubmitted-order' };
      await assert.rejects(tools.get('complete_with_action')!.invoke({
        action: { interface: { type: 'PayableOrder', action: 'prepare', object: sandboxOrder },
          input: { order: sandboxOrder } },
        read: { function: 'readSchedulePlan', resultParameter: 'plan' },
      }), /Data is unavailable to the selected model/);
      await tools.get('request_clarification')!.invoke({ message: 'Confirm the intended time.' });
    },
  });
  try {
    for (const task of [await f.submit(), await f.tasks.submit(principal, {
      requestId: 'scoped-calendar', message: '帮我排程并检查日历可用时段。',
    })]) {
      assert(await f.worker.runOne());
      const result = await f.tasks.get(principal, task.id);
      assert.equal(result.state, 'input-required', result.error ?? undefined);
    }
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});
