import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { amapFunctions } from '../packages/capabilities/amap/functions.js';
import { configuredAmap } from '../packages/capabilities/amap/client.js';
import { Functions } from '../packages/runtime/functions.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { mapFunctions } from '../packages/ontology/maps.js';
import { fixture, principal } from './fixture.js';

import { fakeAmap, testConnection, type Recorded } from './amap-fixture.js';

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
    await setGrants(f.db, other.owner, memberGrants(f.model));
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
    assert.match(JSON.stringify(failed.content), /尚未配置有效的高德/);
  } finally {
    await mcp.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});
