import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { amapFunctions } from '../packages/capabilities/amap/functions.js';
import { configuredAmap } from '../packages/capabilities/amap/client.js';
import { Functions } from '../packages/runtime/functions.js';
import { unresolvedMapPlace } from '../packages/runtime/clarification.js';
import { amendMapPlace } from '../packages/capabilities/amap/task-correction.js';
import { ExecutionTrace } from '../packages/runtime/execution-trace.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { mapFunctions, pickupCoordinateEvidence } from '../packages/ontology/maps.js';
import { document, fixture, principal, route } from './fixture.js';

import { fakeAmap, testConnection, type Recorded } from './amap-fixture.js';

test('the original ride Action obtains missing endpoints and uses GCJ-02 before quoting a phone pickup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-ride-pickup-'));
  const calls: Recorded[] = [];
  const config = await testConnection(directory);
  let input: Record<string, unknown> = {};
  let modelCalls = 0;
  const f = await fixture({
    model: 'fixture-ride-pickup',
    async run(_prompt, tools) {
      modelCalls++;
      await tools.get('complete_with_action')!.invoke({
        action: { interface: { type: 'RideInquiryWithPlaceClues', implementation: 'RideRequest', action: 'estimate' }, input },
        read: { function: 'readInteractiveRideEstimate', resultParameter: 'request' },
      });
    },
  }, undefined, undefined, undefined, { amap: config, amapFetch: fakeAmap(calls) });
  try {
    f.provider.flags.related = false;
    const pa = new PARequests(f.tasks);
    for (const system of ['wgs84', 'gcj02'] as const) {
      input = system === 'wgs84' ? {} : { destination: route.destination };
      const original = await f.tasks.submit(principal, { requestId: 'pickup-' + system, message: '帮我叫台车' });
      const initialDidi = f.provider.calls.length;
      const initialAmap = calls.length;
      await f.worker.runOne();
      let pending = await f.tasks.get(principal, original.id);
      if (system === 'wgs84') {
        assert.deepEqual(pending.result, { kind: 'destination' });
        await f.tasks.answerInput(principal, original.id, { kind: 'destination', place: route.destination });
        await f.worker.runOne();
        pending = await f.tasks.get(principal, original.id);
      }
      assert.equal(pending.state, 'input-required');
      assert.equal(pending.input.placeContinuation?.waitingFor, 'pa-request');
      const actionId = pending.input.placeContinuation.requestId;
      const request = pending.result as { requestId: string; capability: string; input: Record<string, unknown> };
      assert.equal(request.capability, 'location.resolve');
      assert.equal(request.input.use, 'ride_pickup');
      assert.equal(request.input.coordinateSystem, 'gcj02');
      const point = { source: 'device', latitude: 31.201, longitude: 121.495,
        observedAt: new Date().toISOString(), accuracyMeters: 25 };
      await assert.rejects(pa.respond(principal, original.id, { requestId: request.requestId, response: {
        status: 'available', location: point,
      } }));
      assert.equal(calls.length, initialAmap);
      assert.equal(f.provider.calls.length, initialDidi);
      await pa.respond(principal, original.id, { requestId: request.requestId, response: {
        status: 'available', location: { ...point, coordinateSystem: system },
      } });
      await f.worker.runOne();
      const finished = await f.tasks.get(principal, original.id);
      assert.equal(finished.state, 'completed', JSON.stringify(finished));
      const result = finished.result as {request: {id: string}; route: {origin: {name: string}; pickup: unknown;
        drivingEstimate: {durationSeconds: number; distanceMeters: number}}};
      const pickup = pickupCoordinateEvidence.parse(result.route.pickup);
      assert.equal(result.request.id, actionId);
      assert.equal(result.route.origin.name, '上海市浦东新区示例路1号');
      assert.equal(result.route.drivingEstimate.durationSeconds, 300);
      assert.equal(result.route.drivingEstimate.distanceMeters, 1951);
      assert.equal(pickup.inputCoordinateSystem, system);
      assert.equal(pickup.coordinateSystem, 'gcj02');
      assert.equal(pickup.conversion, system === 'wgs84' ? 'converted_by_amap' : 'already_gcj02');
      assert.deepEqual(calls.slice(initialAmap).map(call => call.name), system === 'wgs84'
        ? ['/v3/assistant/coordinate/convert', '/v3/geocode/regeo'] : ['/v3/geocode/regeo']);
      assert.equal(calls.at(-1)?.input.location, system === 'wgs84' ? '121.499,31.205' : '121.495,31.201');
      assert.deepEqual(f.provider.calls.slice(initialDidi),
        ['maps_textsearch', 'maps_textsearch', 'taxi_estimate', 'maps_direction_driving']);
    }
    const initialAmap = calls.length;
    input = route;
    const direct = await f.tasks.submit(principal, { requestId: 'named-pickup', message: '从指定上车点叫车' });
    await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, direct.id)).state, 'completed');
    assert.equal(calls.length, initialAmap);
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.pa_requests WHERE task_id=$1`, [direct.id])).rows[0]?.n, 0);
    assert.equal(modelCalls, 3);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Ontology exposes read-only Amap and weather together and enforces owner and location authorization', async () => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'eigos-amap-'));
  try {
    const config = await testConnection(directory);
    const calls: Recorded[] = [];
    const functions = new Functions(amapFunctions(configuredAmap(config, fakeAmap(calls, { remoteShape: true }))), mapFunctions);
    const ctx = { principal, objects: new Objects(f.db, f.model, f.access), signal: AbortSignal.timeout(15000) };
    const invoke = (name: string, input: Record<string, unknown>) => functions.invoke(f.model, name, input, ctx);
    assert(f.model.resolvedDocument.functionTypes.some(fn => fn.apiName === 'readWeather' && fn.source === 'Amap'));
    const forecast = await invoke('readWeather', { city: '上海', mode: 'forecast' }) as { kind: string; days: unknown[]; reportedAt?: string };
    assert.equal(forecast.kind, 'forecast');
    assert.deepEqual(forecast.days, [{ date: '2026-11-15', daytime: '晴', nighttime: '多云', daytimeTemperatureC: 17, nighttimeTemperatureC: 9 }]);
    assert.equal(forecast.reportedAt, undefined);
    assert.deepEqual(calls[0], { name: 'maps_weather', input: { city: '上海' } });
    const region = await invoke('reverseGeocode', { latitude: 31.2, longitude: 121.5, coordinateSystem: 'gcj02' }) as { district: string };
    assert.equal(region.district, '浦东新区');
    const results = await invoke('searchMapPlaces', { city: '上海', query: '咖啡' });
    assert(!JSON.stringify(results).includes('private-data'));
    await invoke('readMapPlace', { id: 'B0EXAMPLE' });
    await assert.rejects(invoke('estimateMapRoute', {
      mode: 'walking', origin: { address: '未知地点' }, destination: { latitude: 31.2, longitude: 121.5, coordinateSystem: 'gcj02' },
    }), /唯一匹配/);
    assert(!calls.some(call => call.name === 'maps_direction_walking'));
    const route = await invoke('estimateMapRoute', {
      mode: 'walking', origin: { address: '地标' }, destination: { latitude: 31.2, longitude: 121.51, coordinateSystem: 'gcj02' },
    }) as { routes: unknown[] };
    assert.deepEqual(route.routes, [{ distanceMeters: 900, durationSeconds: 650 }]);
    const drive = await invoke('estimateMapRoute', {
      mode: 'driving', origin: { address: '地标' }, destination: { address: '上海市长宁区虹桥路2550号' },
    }) as { routes: unknown[] };
    assert.deepEqual(drive.routes, [{ distanceMeters: 3000, durationSeconds: 1500 }]);
    assert.equal(calls.at(-1)?.input.destination, '121.348165,31.193918');

    const task = await f.tasks.submit(principal, { requestId: 'nearby-weather', message: '我这里现在多少度？' });
    const first = (await f.tasks.claim())!;
    const use = (task: typeof first) => functions.invoke(f.model, 'readWeather', { mode: 'current' },
      { ...ctx, execution: { task, tasks: f.tasks } });
    const count = calls.length;
    const pending = await use(first).catch((error: unknown) => {
      assert(error && typeof error === 'object' && 'choices' in error);
      return error.choices as { requestId: string; capability: string; input: Record<string, unknown> };
    }) as { requestId: string; capability: string; input: Record<string, unknown> };
    assert.equal(calls.length, count);
    assert.equal(pending.capability, 'location.resolve');
    assert.equal(pending.input.use, 'weather');
    assert.equal(pending.input.acceptDeviceWgs84, true);
    assert.equal(pending.input.coordinateProvider, 'Amap');
    await f.tasks.finish(first, 'input-required', pending);
    await new PARequests(f.tasks).respond(principal, task.id, { requestId: pending.requestId, response: {
      status: 'available', location: { source: 'device', latitude: 31.201, longitude: 121.495,
        coordinateSystem: 'wgs84', observedAt: new Date().toISOString(), accuracyMeters: 25 },
    } });
    const current = await use((await f.tasks.claim())!) as { kind: string; adcode: string; temperatureC: number };
    assert.equal(current.kind, 'current');
    assert.equal(current.adcode, '310115');
    assert.equal(current.temperatureC, 13);
    assert.deepEqual(calls.slice(count).map(call => call.name), [
      '/v3/assistant/coordinate/convert', '/v3/geocode/regeo', '/v3/weather/weatherInfo',
    ]);
    assert.equal(calls[count + 1]?.input.location, '121.499,31.205');
    assert(!JSON.stringify(current).includes('121.495'));
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.scenarios`)).rows[0]?.n, 0);

    const other = { ...principal, owner: 'unbound-amap-user' };
    await setGrants(f.db, other.owner, businessGrants(f.model));
    const otherAccess = await Access.load(f.db, other);
    const beforeRejected = calls.length;
    await assert.rejects(functions.invoke(f.model, 'readWeather', { city: '上海' },
      { ...ctx, principal: other, objects: new Objects(f.db, f.model, otherAccess) }), /有效的高德/);
    assert.equal(calls.length, beforeRejected);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await f.close();
  }
});

test('Agent MCP discovers map and weather Functions in the same published model and requires configured access', async () => {
  const f = await fixture(), token = 'amap-eigos-test-token-'.repeat(3);
  const config = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token });
  const server = createApp(config, f.db, f.source).app.listen(0, '127.0.0.1');
  const mcp = new Client({ name: 'amap-candidate-audit', version: '1' });
  await once(server, 'listening');
  try {
    const addr = server.address();
    assert(addr && typeof addr !== 'string');
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }));
    const send = (name: string, args: Record<string, unknown>) => mcp.callTool({ name, arguments: args });
    const r = await send('describe_ontology', {});
    const manifest = JSON.parse((r.content[0] as {text: string}).text);
    for (const name of ['geocodeAddress', 'searchNearbyPlaces', 'estimateMapRoute', 'readWeather'])
      assert(manifest.functionTypes.some((fn: {apiName: string; source: string}) => fn.apiName === name && fn.source === 'Amap'));
    const failed = await send('evaluate_ontology', { function: 'readWeather', input: { city: '上海' } });
    assert(failed.isError);
    assert.deepEqual(failed.structuredContent, { status: 503, error: 'Source temporarily unavailable' });
  } finally {
    await mcp.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});

test('an imprecise route endpoint pauses for a scoped location response and resumes the original task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-amap-route-recovery-'));
  const calls: Recorded[] = [];
  const config = await testConnection(directory);
  const f = await fixture({
    model: 'fixture-amap-route-recovery',
    async run(_prompt, tools) {
      await tools.get('complete_with_function')!.invoke({ function: 'estimateMapRoute', input: {
        mode: 'driving', origin: { address: '未知地点', city: '上海市' },
        destination: { latitude: 31.2, longitude: 121.51, coordinateSystem: 'gcj02' },
      } });
    },
  }, undefined, undefined, undefined, { amap: config, amapFetch: fakeAmap(calls) });
  try {
    const task = await f.tasks.submit(principal, { requestId: 'route-recovery', message: '从上述指定地标出发自驾' });
    await f.worker.runOne();
    const paused = await f.tasks.get(principal, task.id);
    assert.equal(paused.state, 'input-required');
    const request = paused.result as { kind: string; requestId: string; capability: string; input: {
      use: string; selection: { source: 'specified'; place: string }; coordinateSystem: 'gcj02';
    } };
    assert.equal(request.kind, 'pa-request');
    assert.equal(request.capability, 'location.resolve');
    assert.equal(request.input.use, 'map_route');
    assert.deepEqual(request.input.selection, { source: 'specified', place: '上海市 未知地点' });
    assert.equal(request.input.coordinateSystem, 'gcj02');
    assert.deepEqual(calls.map(call => call.name), ['maps_geo']);

    await new PARequests(f.tasks).respond(principal, task.id, { requestId: request.requestId, response: {
      status: 'available', location: {
        ...request.input.selection, latitude: 31.205, longitude: 121.499, coordinateSystem: 'gcj02',
      },
    } });
    await f.worker.runOne();
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state, 'completed', done.error ?? undefined);
    assert.deepEqual((done.result as { routes: unknown[] }).routes, [{ distanceMeters: 3000, durationSeconds: 1500 }]);
    assert.deepEqual(calls.map(call => call.name), ['maps_geo', 'maps_geo', 'maps_direction_driving']);
    assert.deepEqual(calls.at(-1)?.input, { origin: '121.499,31.205', destination: '121.51,31.2' });
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a verified endpoint correction reopens the original legacy map pause across releases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-amap-legacy-'));
  const calls: Recorded[] = [], connection = await testConnection(directory);
  const providerFetch = { amapFetch: fakeAmap(calls) };
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(Date.now() - 172800000);
  const f = await fixture({
    model: 'fixture-amap-place-amendment',
    async run(prompt, tools) {
      const data = JSON.parse(prompt.split('\n').at(-1)!);
      const read = tools.get('evaluate_function')!, complete = tools.get('complete_with_function')!;
      const history = await read.invoke({ function: 'readWeatherHistory',
        input: { city: '上海', startDate: day, endDate: day } }) as { status?: string; days?: unknown[] };
      if (!history.status) return;
      assert.deepEqual(history.days, [{ date: day, minC: 8 }]);
      if (!data.confirmedMapPlaces) {
        await tools.get('request_clarification')!.invoke({ message: unresolvedMapPlace });
        return;
      }
      assert.equal(data.userRequest.message, '从旧写法对应的地标出发自驾');
      const ref = data.confirmedMapPlaces.origin;
      assert.deepEqual(ref, { placeId: 'B0EXAMPLE', name: '咖啡店', city: '上海市' });
      const found = await read.invoke({ function: 'readMapPlace', input: { id: ref.placeId } }) as { place: { point: unknown } };
      await complete.invoke({ function: 'estimateMapRoute', input: {
        mode: 'driving', origin: found.place.point, destination: { latitude: 31.2, longitude: 121.51, coordinateSystem: 'gcj02' },
      } });
    },
  }, undefined, undefined, undefined, { amap: connection, ...providerFetch });
  const config = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development',
    EIGOS_DEV_TOKEN: 'amap-recovery-dev-token-'.repeat(2), EIGOS_AMAP_CONNECTION_FILE: connection });
  const server = createApp(config, f.db, f.source, async token => token === 'owner' ? principal : { ...principal, owner: 'other' },
    {}, providerFetch).app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const original = { requestId: 'legacy-map-trip', message: '从旧写法对应的地标出发自驾' };
    const task = await f.tasks.submit(principal, original);
    await f.worker.runOne();
    const weather = await f.tasks.get(principal, task.id);
    const request = weather.result as { requestId: string };
    await new PARequests(f.tasks).respond(principal, task.id, { requestId: request.requestId, response: {
      status: 'available', city: '上海', observedAt: new Date().toISOString(), sourceUrl: 'https://example.org/weather',
      kind: 'station_observation', evidence: 'synthetic', complete: true, days: [{ date: day, minC: 8 }],
    } });
    await f.worker.runOne();
    const waiting = await f.tasks.get(principal, task.id);
    assert.equal(waiting.state, 'input-required');
    assert.equal(waiting.result, null);
    const canceled = await f.tasks.cancel(principal, task.id);
    const active = await f.metadata.publish(document, f.capabilities, f.publisher);
    assert.notEqual(active.release, task.release);
    const addr = server.address();
    assert(addr && typeof addr !== 'string');
    const amendment = { source: 'Amap', side: 'origin', placeId: 'B0EXAMPLE',
      requestId: '211cfc13-0d98-452e-9d4d-c453d778cf3d', expectedUpdatedAt: canceled.updated_at.toISOString(), restoreCanceled: true };
    const post = (body: unknown, token = 'owner') => fetch(`http://127.0.0.1:${addr.port}/tasks/${task.id}/place-amendment`, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await post(amendment, 'other')).status, 404);
    assert.equal((await post({ ...amendment, expectedUpdatedAt: task.created_at.toISOString() })).status, 409);
    assert.equal((await post({ ...amendment, restoreCanceled: undefined })).status, 409);
    const blocked = await f.tasks.submit(principal, { requestId: 'prior-map-action', message: original.message });
    const claimed = (await f.tasks.claim())!;
    assert.equal(claimed.id, blocked.id);
    await f.tasks.finish(claimed, 'input-required', null, unresolvedMapPlace);
    const blockedCanceled = await f.tasks.cancel(principal, blocked.id);
    await f.db.query(`INSERT INTO ${f.db.schema}.actions(owner,request_id,digest,action,release,result,task_id)
      VALUES($1,'already-applied','fixture','PrepareSchedulePlan',$2,'{}',$3)`, [principal.owner, active.release, blocked.id]);
    await assert.rejects(amendMapPlace(f.tasks, f.metadata, f.capabilities.functions, principal, blocked.id, {
      ...amendment, expectedUpdatedAt: blockedCanceled.updated_at.toISOString(),
    }), /prior business Actions/);
    assert.equal(calls.length, 0);
    const response = await post(amendment);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, task.id);
    assert.equal((await post(amendment)).status, 200);
    assert.equal((await post({ ...amendment, placeId: 'other-place' })).status, 409);
    assert.deepEqual(calls.map(call => call.name), ['maps_search_detail']);
    assert.equal((await f.tasks.submit(principal, original)).id, task.id);

    await f.worker.runOne();
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state, 'completed', done.error ?? undefined);
    assert.equal(done.release, active.release);
    assert.deepEqual((done.result as { routes: unknown[] }).routes, [{ distanceMeters: 3000, durationSeconds: 1500 }]);
    const trace = await new ExecutionTrace(f.db, f.metadata).read(f.access, 'Eigos', { taskId: task.id });
    assert(trace.events.some(event => event.kind === 'model' && event.release === task.release));
    const corrections = trace.events.filter(event => event.kind === 'map-place-correction');
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0]?.previousRelease, task.release);
    assert.equal(corrections[0]?.previousState, 'canceled');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
