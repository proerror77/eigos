import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DidiOperations } from '../packages/capabilities/didi/operations.js';
import { digest } from '../packages/core/identity.js';
import { configuredSource } from '../packages/core/config.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { rideWatchRead, rideWatchType } from '../packages/ontology/ride-watch.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

const at = (minutes = 0) => new Date(Date.now() + minutes * 60000).toISOString();
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function originalOrder(f: Fixture, evidence: 'synthetic' | 'provider_mock' = 'synthetic') {
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
    independentRead: false, evidence, observedAt: at(), contentDigest: 'a'.repeat(64),
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
    let sandboxText: string | undefined;
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
        result = name === 'taxi_query_order' && sandboxText !== undefined
          ? { content: [{ type: 'text', text: sandboxText }] }
          : {structuredContent:name==='taxi_query_order' ? {
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

    // The sandbox returns these reports as text, without echoing the queried order.
    const mockBinding = { bindingId:'adapter-sandbox-test', keyFile, environment:'mock' as const,
      keySha256:createHash('sha256').update(secret).digest('hex') };
    const pinned = new DidiOperations(mockBinding,false,providerFetch,'provider-test-order');
    const phases = [
      [0, '系统正在为您匹配最近的司机...\n提示：您可以随时取消订单'],
      [1, '系统已为您匹配到司机，正在快马加鞭来接您。\n师傅离上车点还有：2.5 公里，约需8分钟到达。'],
      [2, '司机已经到达起点附近，请尽快上车。\n• 车型：黑 · 奥迪 · A6\n• 车牌：京TEST2025\n• 电话：PRIVATE-NUMBER'],
      [4, '行程进行中，请系好安全带\n离终点还有：5.0 公里，约需15分钟到达。'],
      [5, '✅ 行程已完成！'],
    ] as const;
    for (const [statusCode,message] of phases) {
      sandboxText = message;
      const progress = await pinned.observe('provider-test-order',AbortSignal.timeout(5000));
      assert.equal(progress.statusCode,statusCode);
      assert.equal(progress.orderId,'provider-test-order');
      if (statusCode===1) {
        assert.equal(progress.etaMinutes,8);
        assert.equal(progress.distanceKm,2.5);
      }
      if (statusCode===2) assert.deepEqual(progress.driver,{name:null,carModel:'黑 · 奥迪 · A6',carPlate:'京TEST2025'});
    }
    const observed = names.length;
    await assert.rejects(pinned.observe('other-order',AbortSignal.timeout(5000)),/identity changed/);
    assert.equal(names.length,observed);
    sandboxText = '✅ 行程已完成！\n订单号：other-order';
    await assert.rejects(pinned.observe('provider-test-order',AbortSignal.timeout(5000)),/identity changed/);
    sandboxText = '状态不可用\n✅ 行程已完成！';
    await assert.rejects(pinned.observe('provider-test-order',AbortSignal.timeout(5000)),/Unrecognized/);
    sandboxText = '✅ 行程已完成！';
    await assert.rejects(client.observe('provider-test-order',AbortSignal.timeout(5000)));
    await assert.rejects(new DidiOperations(mockBinding,false,providerFetch).observe('provider-test-order',AbortSignal.timeout(5000)));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('only the tracked order can select the separate read-only sandbox binding', async () => {
  const dir = await mkdtemp(join(tmpdir(),'eigos-didi-sandbox-binding-'));
  try {
    const keyFile = join(dir,'key'), primaryFile = join(dir,'primary.json'), sandboxFile = join(dir,'sandbox.json');
    const key = 'synthetic-provider-test-key';
    await writeFile(keyFile,key,{mode:0o600});
    const details = { owner:principal.owner, active:true, ordersEnabled:false, binding:{
      bindingId:'ordinary',environment:'production',keyFile,keySha256:createHash('sha256').update(key).digest('hex'),
    } };
    const sandbox = {...details,binding:{...details.binding,environment:'mock',bindingId:'watch-sandbox'},originalOrderId:'only-original'};
    await writeFile(primaryFile,JSON.stringify(details),{mode:0o600});
    await writeFile(sandboxFile,JSON.stringify(sandbox),{mode:0o600});
    const resolver = configuredSource(primaryFile,sandboxFile);
    const ordinary = await resolver(principal.owner);
    const original = {bindingId:'watch-sandbox',orderId:'only-original'};
    const watch = await resolver(principal.owner,original);
    assert.equal(ordinary.orders?.environment,'production');
    assert.equal(watch.orders?.environment,'mock');
    assert.notEqual(watch.authorityId,ordinary.authorityId);
    await assert.rejects(watch.orders!.assertAvailable(),/EXECUTION_DISABLED/);
    await assert.rejects(watch.orders!.observe!('other-order',AbortSignal.timeout(5000)),/identity changed/);
    await assert.rejects(resolver('different-owner',original),/unavailable/);
    await assert.rejects(resolver(principal.owner,{...original,bindingId:'wrong-binding'}),/Invalid DiDi sandbox watch binding/);
    await assert.rejects(resolver(principal.owner,{...original,orderId:'other-order'}),/identity changed/);
    await writeFile(sandboxFile,JSON.stringify({...sandbox,originalOrderId:'new-order'}),{mode:0o600});
    await assert.rejects(watch.assertCurrent(),/changed/);
    await writeFile(sandboxFile,JSON.stringify({...sandbox,ordersEnabled:true}),{mode:0o600});
    await assert.rejects(resolver(principal.owner,original));
    assert.equal((await resolver(principal.owner)).orders?.environment,'production');
    await writeFile(sandboxFile,JSON.stringify({...sandbox,cancellationsEnabled:true}),{mode:0o600});
    await assert.rejects(resolver(principal.owner,original));
    await writeFile(primaryFile, JSON.stringify({ ...details, cancellationsEnabled: true }), { mode: 0o600 });
    const updated = await resolver(principal.owner);
    assert.equal(updated.authorityId, ordinary.authorityId);
    await assert.rejects(ordinary.assertCurrent(), /changed/);
    await updated.orders!.assertCancellationAvailable!();
    await assert.rejects(updated.orders!.assertAvailable(), /DIDI_ORDER_EXECUTION_DISABLED/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('the original DiDi order is followed to arrival and completion without posting orders or collecting payment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eigos-ride-watch-'));
  const keyFile = join(dir, 'key'), travelPA = join(dir, 'target.json');
  await writeFile(keyFile, 'test-credential-00000000', { mode: 0o600 });
  await writeFile(travelPA, JSON.stringify({ owner: principal.owner, keyFile,
    endpoint:'https://api2.cursor.sh/automations/webhook/0e5eaab2-4dc9-4a1e-b2e5-74ff95c08c52',
    keyHeader:'X-Automation-Key', objectTypes:['DidiRideWatch'] }), {mode:0o600});
  const delivered: {operation:string; text:string; ride:unknown; sandbox?:boolean}[] = [];
  const f = await fixture(undefined, undefined, undefined, undefined, { travelPA, travelPAFetch: async (_target, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('X-Automation-Key'),'test-credential-00000000');
    assert.equal(headers.get('Authorization'),null);
    delivered.push(JSON.parse(String(init?.body)));
    return Response.json({runUuid:'8e690fdf-c2c8-4ff4-b930-a889c63c181a'});
  } });
  try {
    const { graph, order } = await originalOrder(f,'provider_mock'), seen: string[] = [];
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
    assert.equal(delivered[0]!.sandbox,true);
    assert.match(delivered[0]!.text,/^【滴滴沙箱】.*已到达.*TEST-123/);
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
    const tracking = await graph.follow(order,'watches');
    assert.deepEqual(tracking.map(item=>item.ref),[watch]);
    assert.equal(tracking[0]!.properties.observedAt,ended.observedAt);
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

test('the CancelableRideOrder cancellation Action dispatches once and stops following the canceled order', async () => {
  const f = await fixture();
  try {
    const { graph, order } = await originalOrder(f);
    const ops = f.provider.source.orders!;
    let calls = 0;
    ops.observe = async orderId => progress(orderId, 1);
    const originalQuery = ops.query.bind(ops);
    ops.query = async (orderId, signal) => ({ ...await originalQuery(orderId, signal), state: 'unknown' });
    ops.cancel = async (orderId, reason, signal, beforeDispatch) => {
      await beforeDispatch();
      assert.equal(orderId, 'provider-test-order');
      assert.equal(reason, 'Change of plans');
      calls++;
      const status = await originalQuery(orderId, signal);
      return { order: { ...status, status: '订单已取消' }, acknowledgementDigest: digest('accepted') };
    };
    const { actions, functions } = f.capabilities;
    const watch = await actions.apply(f.access, f.model, 'StartDidiRideWatch',
      { order, expiresAt: at(30), notifyArrival: false }, 'watch-before-cancel');
    const selected = actions.resolve(f.access, f.model, {
      interface: { type: 'CancelableRideOrder', action: 'cancel', object: order },
      input: { order, confirmCancellation: true, reason: 'Change of plans' },
    });
    assert.equal(selected.action, 'CancelDidiRideOrder');
    const apply = (id: string, input = selected.input) =>
      actions.apply(f.access, f.model, selected.action, input, id);
    await assert.rejects(apply('no-confirmation', { order }));
    await assert.rejects(apply('wrong-order', { ...selected.input, order: { ...order, id: 'other' } }));
    f.provider.flags.orderEnabled = false;
    await assert.rejects(apply('disabled'), /DIDI_ORDER_EXECUTION_DISABLED/);
    assert.equal(calls, 0);
    f.provider.flags.orderEnabled = true;
    assert.deepEqual(await apply('cancel-order'), order);
    assert.deepEqual(await apply('cancel-order'), order);
    assert.deepEqual(await apply('cancel-order-repeated'), order);
    assert.equal(calls, 1);
    const read = (name: string, input: Record<string, unknown>) => functions.invoke(f.model, name, input, {
      principal, objects: graph, signal: AbortSignal.timeout(5000),
    });
    const result = await read('readDidiRideOrder', { order }) as { cancellation: string; cancellationReceipt: { receiptDigest: string } };
    assert.equal(result.cancellation, 'confirmed');
    assert.equal(result.cancellationReceipt.receiptDigest, digest('accepted'));
    assert.equal(rideWatchRead.parse(await read('readDidiRideWatch', { watch })).state, 'provider_terminal');
    await due(f, watch);
    assert.equal((await graph.read(watch)).properties.state, 'provider_terminal');
    await assert.rejects(read('readDidiDriverPosition', { watch }));
  } finally {
    await f.close();
  }
});

test('an unresolved cancellation looks up the original order and never submits it again', async () => {
  const f = await fixture();
  try {
    const { graph, order } = await originalOrder(f);
    const ops = f.provider.source.orders!, query = ops.query.bind(ops);
    let calls = 0, settled = false;
    ops.cancel = async (_id, _reason, _signal, beforeDispatch) => {
      await beforeDispatch();
      calls++;
      throw new Error('Provider response lost');
    };
    ops.query = async (id, signal) => ({
      ...await query(id, signal), status: settled ? '订单已取消' : '正在匹配',
    });
    const apply = (id: string) => f.capabilities.actions.apply(f.access, f.model, 'CancelDidiRideOrder',
      { order, confirmCancellation: true }, id);
    const read = () => f.capabilities.functions.invoke(f.model, 'readDidiRideOrder', { order }, {
      principal, objects: graph, signal: AbortSignal.timeout(5000),
    }) as Promise<{ cancellation: string; cancellationReceipt: { evidence: string } }>;
    await assert.rejects(apply('lost-cancel'), /unresolved/);
    assert.equal((await read()).cancellation, 'unresolved');
    await assert.rejects(apply('recovery-before-provider-settles'), /reconcile/);
    settled = true;
    assert.deepEqual(await apply('recovery-after-provider-settles'), order);
    assert.equal((await read()).cancellationReceipt.evidence, 'original_order_readback');
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test('the DiDi cancel adapter requires acknowledgement and reads the original order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eigos-didi-cancel-adapter-'));
  try {
    const key = 'synthetic-didi-cancel-adapter-key', keyFile = join(dir, 'key');
    await writeFile(keyFile, key, { mode: 0o600 });
    let success = true, readback = '❌ 订单已取消';
    const calls: string[] = [];
    const provider: typeof fetch = async (url, init) => {
      assert.equal(new URL(String(url)).pathname, '/mcp-servers-sandbox');
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      const rpc = JSON.parse(String(init?.body));
      if (rpc.method.startsWith('notifications/')) return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc.method === 'initialize') result = {
        protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
      };
      else if (rpc.method === 'tools/list') result = {
        tools: [
          { name: 'taxi_cancel_order', inputSchema: {
            type: 'object', properties: { order_id: { type: 'string' }, reason: { type: 'string' } }, required: ['order_id'],
          } },
          { name: 'taxi_query_order', inputSchema: {
            type: 'object', properties: { order_id: { type: 'string' } },
          } },
        ],
      };
      else {
        assert.equal(rpc.method, 'tools/call');
        assert.equal(rpc.params.arguments.order_id, 'original-order');
        calls.push(rpc.params.name);
        result = rpc.params.name === 'taxi_cancel_order' ? { structuredContent: { success } }
          : { content: [{ type: 'text', text: readback }] };
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    };
    const client = new DidiOperations({ bindingId: 'adapter', environment: 'mock', keyFile,
      keySha256: createHash('sha256').update(key).digest('hex') }, false, provider, undefined, true);
    await assert.rejects(client.assertAvailable(), /DIDI_ORDER_EXECUTION_DISABLED/);
    let guarded = 0;
    const submit = () => client.cancel('original-order', undefined, AbortSignal.timeout(5000), async () => { guarded++; });
    success = false;
    await assert.rejects(submit());
    assert.deepEqual(calls, ['taxi_cancel_order']);
    calls.length = 0;
    success = true;
    const result = await submit();
    assert.deepEqual(calls, ['taxi_cancel_order', 'taxi_query_order']);
    assert.equal(result.order.status, '订单已取消');
    assert.equal(result.order.evidence, 'provider_mock');
    assert.equal(result.order.independentRead, true);
    assert.equal(guarded, 2);
    readback += '\n订单号: different-order';
    await assert.rejects(submit(), /identity changed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
