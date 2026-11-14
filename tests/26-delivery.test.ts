import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { waimaiFunctions } from '../packages/capabilities/meituan/waimai.js';
import { AmapClient } from '../packages/capabilities/amap/client.js';
import { Access, setGrants } from '../packages/runtime/access.js';
import { Functions } from '../packages/runtime/functions.js';
import { Objects } from '../packages/runtime/objects.js';
import { deliveryFunctions, waimaiArrival, waimaiShops } from '../packages/ontology/delivery.js';
import { fixture, principal } from './fixture.js';
import { PARequests } from '../packages/runtime/pa.js';

test('Waimai sends only signed store and arrival reads, preserves zero fees and marks an unspecified arrival as unknown', async () => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'eigos-waimai-connection-'));
  const config = join(directory, 'connection.json');
  const key = Buffer.from('fixture-aes-key!');
  const calls: { path: string; parameters: Record<string, unknown> }[] = [];
  await writeFile(config, JSON.stringify({ owner: principal.owner, active: true, environment: 'test',
    version: '1.0', token: 'mock-account', sign: 'mock-signature', aesKey: key.toString('base64url'),
  }), { mode: 0o600 });
  const supply: typeof fetch = async (target, init) => {
    const url = new URL(String(target));
    assert.equal(url.origin, 'https://sqt-api.test.meituan.com');
    assert.equal(init?.method, 'POST');
    const body = init?.body as URLSearchParams;
    assert.equal(body.get('token'), 'mock-account');
    const decrypt = createDecipheriv('aes-128-ecb', key, null);
    const parameters = JSON.parse(Buffer.concat([decrypt.update(Buffer.from(body.get('content')!, 'base64url')), decrypt.final()]).toString());
    calls.push({ path: url.pathname, parameters });
    const data = url.pathname === '/waimai/v1/poi/list' ? {
      current_page_index: 1, have_next_page: 0,
      openPoiBaseInfoList: [{ wm_poi_id: '129', name: '测试餐厅', shipping_fee: 0, min_price: 15.5,
        avg_delivery_time: 28, status: 1, extra: 'provider-only' }],
    } : [{ date: '今天', status: 0, timelist: [
      { date_type_tip: '立即送达', view_time: '立即送出', unixtime: 0 },
      { date_type_tip: '指定时间', view_time: '12:30', unixtime: 1794630600 },
    ] }];
    return Response.json({ status: 0, data });
  };
  const conversions: string[] = [];
  const amap = new AmapClient('map-fixture-web-key', async (target) => {
    const url = new URL(String(target));
    assert.equal(url.origin + url.pathname, 'https://restapi.amap.com/v3/assistant/coordinate/convert');
    assert.equal(url.searchParams.get('coordsys'), 'gps');
    conversions.push(url.searchParams.get('locations')!);
    return Response.json({ status: '1', locations: '121.455555,31.222222' });
  }, async () => {});
  const functions = new Functions(waimaiFunctions(config, supply, async () => amap), deliveryFunctions);
  const coordinates = { latitude: 31.222222, longitude: 121.455555, coordinateSystem: 'gcj02' };
  const context = { principal, objects: new Objects(f.db, f.model, f.access), signal: AbortSignal.timeout(10000) };
  try {
    const store = waimaiShops.parse(await functions.invoke(f.model, 'findMeituanWaimaiShops', { ...coordinates, query: '咖啡' }, context));
    assert.equal(store.evidence, 'provider_sandbox');
    assert.deepEqual(store.shops[0], { shopId: '129', name: '测试餐厅', status: 'deliverable',
      listedDeliveryFeeMinor: 0, averageDeliveryMinutes: 28, minimumOrderMinor: 1550, currency: 'CNY' });
    const arrivals = waimaiArrival.parse(await functions.invoke(f.model, 'readMeituanWaimaiArrival', { ...coordinates, shopId: '129' }, context));
    assert.deepEqual(arrivals.dates[0]?.times.map(row => row.at), [null, new Date(1794630600000).toISOString()]);
    assert.equal(calls[0]?.parameters.longitude, 121455555);
    assert.equal(calls[0]?.parameters.sign, 'mock-signature');
    assert.equal(calls[1]?.parameters.wm_poi_id, 129);
    assert.deepEqual(calls.map(c => c.path), ['/waimai/v1/poi/list', '/waimai/v1/order/arriveTime']);
    const task = await f.tasks.submit(principal, { requestId: 'waimai-hotel', message: '查酒店附近外卖' });
    const working = (await f.tasks.claim())!;
    assert.equal(working.id, task.id);
    const locationInput = { query: '咖啡', location: { source: 'planned', place: '酒店' } };
    const execution = { ...context, execution: { task: working, tasks: f.tasks } };
    const pending = await functions.invoke(f.model, 'findMeituanWaimaiShops', locationInput, execution)
      .catch((error: unknown) => {
        assert(error && typeof error === 'object' && 'choices' in error);
        return error.choices as { kind: string; requestId: string; input: unknown };
      }) as { kind: string; requestId: string; input: unknown };
    assert.equal(pending.kind, 'pa-request');
    assert.deepEqual(pending.input, {
      use: 'waimai_delivery', selection: locationInput.location, coordinateSystem: 'gcj02',
      maxAgeMs: 120000, maxAccuracyMeters: 100,
    });
    assert.equal(calls.length, 2);
    await f.tasks.finish(working, 'input-required', pending);
    await new PARequests(f.tasks).respond(principal, task.id, {
      requestId: pending.requestId, response: { status: 'available', location: { ...coordinates, ...locationInput.location } },
    });
    await f.tasks.claim().then(async resumed => {
      assert.equal(resumed?.id, task.id);
      const taskContext = { ...context, execution: { task: resumed!, tasks: f.tasks } };
      const page = waimaiShops.parse(await functions.invoke(f.model, 'findMeituanWaimaiShops', locationInput, taskContext));
      assert.equal(page.locationRequestId, pending.requestId);
      assert(!JSON.stringify(page).includes(String(coordinates.longitude)));
      await functions.invoke(f.model, 'readMeituanWaimaiArrival', { shopId: '129', locationRequestId: page.locationRequestId! }, taskContext);
    });
    const nearby = await f.tasks.submit(principal, { requestId: 'waimai-device', message: '查我附近的外卖' });
    const first = await f.tasks.claim();
    assert.equal(first?.id, nearby.id);
    const pendingDevice = await functions.invoke(f.model, 'findMeituanWaimaiShops', {},
      { ...context, execution: { task: first!, tasks: f.tasks } }).catch((error: unknown) => {
        assert(error && typeof error === 'object' && 'choices' in error);
        return error.choices as { requestId: string; input: Record<string, unknown> };
      }) as { requestId: string; input: Record<string, unknown> };
    assert.equal(pendingDevice.input.acceptDeviceWgs84, true);
    assert.equal(pendingDevice.input.coordinateProvider, 'Amap');
    assert.equal(calls.length, 4);
    await f.tasks.finish(first!, 'input-required', pendingDevice);
    await new PARequests(f.tasks).respond(principal, nearby.id, {
      requestId: pendingDevice.requestId, response: { status: 'available', location: {
        source: 'device', latitude: 31.221, longitude: 121.45, coordinateSystem: 'wgs84',
        observedAt: new Date().toISOString(), accuracyMeters: 18,
      } },
    });
    const resumed = await f.tasks.claim();
    assert.equal(resumed?.id, nearby.id);
    const resumedContext = { ...context, execution: { task: resumed!, tasks: f.tasks } };
    const shops = waimaiShops.parse(await functions.invoke(f.model, 'findMeituanWaimaiShops', {}, resumedContext));
    assert.equal(shops.locationRequestId, pendingDevice.requestId);
    await functions.invoke(f.model, 'readMeituanWaimaiArrival',
      { shopId: '129', locationRequestId: shops.locationRequestId! }, resumedContext);
    assert.deepEqual(conversions, ['121.45,31.221', '121.45,31.221']);
    assert.deepEqual(calls.map(call => call.parameters.longitude), Array(6).fill(121455555));
    await setGrants(f.db, principal.owner, [{ resource: 'Eigos', permission: 'view_definition' },
      { resource: 'Eigos/function/findMeituanWaimaiShops', permission: 'execute_function' }]);
    const revoked = await Access.load(f.db, principal);
    await assert.rejects(functions.invoke(f.model, 'findMeituanWaimaiShops', coordinates,
      { ...context, objects: new Objects(f.db, f.model, revoked) }), /read_source/);
    assert.equal(calls.length, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await f.close();
  }
});
