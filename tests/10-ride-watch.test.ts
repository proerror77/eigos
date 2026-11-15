import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DidiOperations } from '../packages/capabilities/didi/operations.js';
import { digest } from '../packages/core/identity.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { rideWatchRead, rideWatchType } from '../packages/ontology/ride-watch.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

const at = (minutes = 0) => new Date(Date.now() + minutes * 60000).toISOString();
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function originalOrder(f: Fixture) {
  const graph = new Objects(f.db, f.model, f.access);
  const trip = { type: 'EventTrip', id: 'original-trip' };
  const order = { type: 'DidiRideOrder', id: 'original-order' };
  await graph.create(trip, {
    id: trip.id, name: 'Test trip', eventStart: at(30), eventEnd: at(90), callAt: at(-10),
    departAt: at(-5), arriveAt: at(20), waitMinutes: 5, entryMinutes: 10,
    state: 'dispatched', permit: null, scheduleId: null, sourceTaskId: null, eventIdentity: 'synthetic-event',
    eventBindingId: 'synthetic-event-binding', sourceAuthority: digest(f.provider.source.bindingId),
    venueAddress: 'Fixture destination', nextCheckAt: null,
  });
  await graph.create(order, {
    id: order.id, name: 'Test order', orderId: 'provider-test-order', status: 'created', state: 'created',
    independentRead: false, evidence: 'synthetic', observedAt: at(), contentDigest: 'a'.repeat(64),
    bindingId: f.provider.source.bindingId,
  });
  await graph.link({ type: 'TripOrder', from: trip, to: order });
  return { graph, order };
}

async function due(f: Fixture, watch: ObjectRef) {
  await f.db.query(`UPDATE ${f.db.schema}.tasks SET available_at=clock_timestamp()
    WHERE id=(SELECT task_id FROM ${f.db.schema}.scheduled_actions WHERE id=$1)`, [watch.id]);
  assert(await f.worker.runOne('scheduled'));
}

const progress = (orderId: string, statusCode: number) => ({
  orderId, statusCode, observedAt: at(), contentDigest: 'b'.repeat(64),
  driver: statusCode ? { name:'Driver', carModel:'Black car', carPlate:'TEST-123' } : null,
  etaMinutes: 5, distanceKm: 1.5,
});

test('the DiDi MCP adapter binds status and driver position reads to the exact original order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eigos-observe-didi-'));
  try {
    const secret = 'synthetic-provider-test-key', keyFile = join(dir, 'key');
    await writeFile(keyFile, secret, {mode: 0o600});
    const names: string[] = [];
    let returnedId = 'provider-test-order';
    const providerFetch: typeof fetch = async (_url, init) => {
      if (init?.method === 'GET') return new Response(null, {status:405});
      if (init?.method === 'DELETE') return new Response(null, {status:200});
      const request = JSON.parse(String(init?.body));
      if (request.method.startsWith('notifications/')) return new Response(null, {status:202});
      let result: unknown;
      if (request.method === 'initialize') result = {
        protocolVersion:request.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'fixture',version:'1'},
      };
      else if (request.method === 'tools/list') result = {
        tools: ['taxi_query_order','taxi_get_driver_location'].map(name => ({
          name,inputSchema:{type:'object',properties:{order_id:{type:'string'}},required:['order_id']},
        })),
      };
      else {
        assert.equal(request.method,'tools/call');
        const name = request.params.name;
        assert(['taxi_query_order','taxi_get_driver_location'].includes(name));
        assert.deepEqual(request.params.arguments,{order_id:'provider-test-order'});
        names.push(name);
        result = {structuredContent:name==='taxi_query_order' ? {
          orderId:returnedId,statusCode:'2',driver:{name:'Driver',carPlate:'TEST-123',carModel:'Black car',phone:'PRIVATE-NUMBER'},
          map:{distanceKm:'0.5',eta:'3'},
        } : {longitude:121.5,latitude:31.2}};
      }
      return Response.json({jsonrpc:'2.0',id:request.id,result});
    };
    const client = new DidiOperations({keyFile,bindingId:'adapter-test',environment:'production',
      keySha256:createHash('sha256').update(secret).digest('hex')},false,providerFetch);
    const result = await client.observe('provider-test-order',AbortSignal.timeout(5000));
    assert.equal(result.statusCode,2);
    assert.equal(result.etaMinutes,3);
    assert.equal(result.distanceKm,0.5);
    assert.deepEqual(result.driver,{name:'Driver',carPlate:'TEST-123',carModel:'Black car'});
    returnedId = 'different-order';
    await assert.rejects(client.observe('provider-test-order',AbortSignal.timeout(5000)), /identity changed/);
    const point = await client.driverPosition('provider-test-order',AbortSignal.timeout(5000));
    assert.equal(point.coordinateSystem,'provider_unspecified');
    assert.deepEqual(names,['taxi_query_order','taxi_query_order','taxi_get_driver_location']);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('the original DiDi order is followed to arrival and completion without posting orders or collecting payment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eigos-ride-watch-'));
  const keyFile = join(dir, 'key'), travelPA = join(dir, 'target.json');
  await writeFile(keyFile, 'test-credential-00000000', { mode: 0o600 });
  await writeFile(travelPA, JSON.stringify({ owner: principal.owner, keyFile,
    endpoint:'https://api2.cursor.sh/automations/webhook/0e5eaab2-4dc9-4a1e-b2e5-74ff95c08c52' }), {mode:0o600});
  const delivered: {operation:string; text:string; ride:unknown}[] = [];
  const f = await fixture(undefined, undefined, undefined, undefined, { travelPA, travelPAFetch: async (_target, init) => {
    delivered.push(JSON.parse(String(init?.body)));
    return Response.json({runUuid:'8e690fdf-c2c8-4ff4-b930-a889c63c181a'});
  } });
  try {
    const { graph, order } = await originalOrder(f), seen: string[] = [];
    let locationReads = 0;
    const codes = [-1, 0, 1, 2, 2, 1, 4, 5];
    f.provider.source.orders!.observe = async orderId => {
      assert.equal(orderId, 'provider-test-order');
      seen.push(orderId);
      const code = codes.shift();
      if (code === -1) throw new Error('Synthetic transport failure');
      assert(code !== undefined);
      return progress(orderId, code);
    };
    f.provider.source.orders!.driverPosition = async orderId => {
      assert.equal(orderId, 'provider-test-order');
      locationReads++;
      return {longitude:121.5,latitude:31.2,coordinateSystem:'provider_unspecified',observedAt:at()};
    };
    const watch = await f.capabilities.actions.apply(f.access, f.model, 'StartDidiRideWatch',
      {order,expiresAt:at(30),notifyArrival:true}, 'start-watch');
    assert.equal(watch.type, rideWatchType);
    const call = (name: string, input: Record<string, unknown>) => f.capabilities.functions.invoke(f.model,name,input,
      {principal,objects:graph,signal:AbortSignal.timeout(4000)});
    const read = async () => rideWatchRead.parse(await call('readDidiRideWatch',{watch}));
    assert.equal((await read()).state, 'watching');
    await due(f, watch);
    assert.equal((await read()).reason,'source_retry');
    assert.equal((await read()).arrival,null);
    await due(f, watch);
    assert.equal((await read()).state,'matching');
    await due(f, watch);
    assert.equal((await read()).state,'driver_assigned');
    assert.equal((await read()).etaMinutes,5);
    assert.equal(locationReads,0);
    await call('readDidiDriverPosition',{watch});
    assert.equal(locationReads,1);
    await due(f, watch);
    assert.equal((await read()).state,'driver_arrived');
    assert((await read()).arrival);
    assert(await f.capabilities.effects.runOne());
    assert.equal(delivered.length,1);
    assert.match(delivered[0]!.text,/已到达.*TEST-123/);
    await due(f, watch);
    await due(f, watch);
    assert.equal((await read()).state,'driver_arrived');
    assert.equal(await f.capabilities.effects.runOne(),false);
    await due(f, watch);
    assert.equal((await read()).state,'in_trip');
    assert.equal((await read()).arrival,null);
    assert(await f.capabilities.effects.runOne());
    assert.deepEqual(delivered.map(x=>x.operation),['update','withdraw']);
    await due(f, watch);
    const ended=await read();
    assert.equal(ended.state,'completed');
    assert.equal(ended.nextCheckAt,null);
    assert.equal(ended.settlement,'unverified');
    assert.equal(await f.worker.runOne('scheduled'),false);
    assert.equal(seen.length,8);
    const logs=await graph.follow(watch,'stateLogs');
    const phases=logs.sort((a,b)=>Number(a.properties.sequence)-Number(b.properties.sequence)).map(x=>x.properties.newState);
    assert.deepEqual(phases,['watching','matching','driver_assigned','driver_arrived','in_trip','completed']);
    assert.equal(f.provider.flags.orderCreates,0);
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.pa_requests`)).rows[0]!.n,0);
  } finally { await f.close(); await rm(dir,{recursive:true,force:true}); }
});

test('stopping a watch stops observation without canceling the original ride', async () => {
  const f=await fixture();
  try {
    const {graph,order}=await originalOrder(f);
    let reads=0, cancels=0;
    f.provider.source.orders!.observe=async orderId=>{ reads++; return progress(orderId,1); };
    f.provider.source.orders!.cancel=async()=>{ cancels++; throw new Error('must not cancel provider order'); };
    const watch=await f.capabilities.actions.apply(f.access,f.model,'StartDidiRideWatch',{order,expiresAt:at(30)},'start');
    await due(f,watch);
    await f.capabilities.actions.apply(f.access,f.model,'StopDidiRideWatch',{watch},'stop');
    assert.equal((await graph.read(watch)).properties.state,'stopped');
    assert.equal(await f.worker.runOne('scheduled'),false);
    assert.equal(cancels,0);
    assert.equal(reads,1);
  } finally { await f.close(); }
});
