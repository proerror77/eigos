import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { comparedWeatherResult } from '../packages/ontology/weather.js';
import { businessGrants, setGrants } from '../packages/runtime/access.js';
import { fakeAmap, testConnection } from './amap-fixture.js';
import { fixture, principal } from './fixture.js';

test('published weather MCP starts both suppliers concurrently and retains verified partial results', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'eigos-compared-weather-'));
  const token = 'weather-eigos-test-token-'.repeat(3), apiKey = 'synthetic-qweather-key';
  const amap = await testConnection(directory);
  const qweather = join(directory, 'qweather.json'), keyFile = join(directory, 'qweather.key');
  await writeFile(keyFile, apiKey, { mode: 0o600 });
  await writeFile(qweather, JSON.stringify({
    owner: principal.owner, active: true, host: 'sample.xy.qweatherapi.com', keyFile,
    keySha256: createHash('sha256').update(apiKey).digest('hex'),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }), { mode: 0o600 });

  const currentDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(new Date());
  const amapCalls: Parameters<typeof fakeAmap>[0] = [];
  const qweatherCalls: string[] = [];
  let startQweather!: () => void, startAmap!: () => void;
  const qweatherStarted = new Promise<void>(resolve => { startQweather = resolve; });
  const amapStarted = new Promise<void>(resolve => { startAmap = resolve; });
  const fake = fakeAmap(amapCalls, { forecasts: [{ date: currentDate, dayweather: '晴', nightweather: '多云', daytemp: '17', nighttemp: '9' }] });
  let status = 200, blockForPeer = true;
  let city = '上海市';
  const config = readConfig({
    DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token,
    EIGOS_AMAP_CONNECTION_FILE: amap, EIGOS_QWEATHER_CONNECTION_FILE: qweather,
  });
  const server = createApp(config, f.db, f.source, undefined, {}, {
    amapFetch: async (target, options) => {
      if (String(options?.body).includes('maps_weather')) {
        startAmap();
        if (blockForPeer) await qweatherStarted;
      }
      const response = await fake(target, options);
      if (new URL(String(target)).pathname !== '/v3/weather/weatherInfo') return response;
      const data = await response.json() as { lives: { city: string }[] };
      data.lives[0]!.city = '上海市';
      return Response.json(data);
    },
    qweatherFetch: async (target, options) => {
      const url = new URL(String(target));
      assert.equal(url.origin, 'https://sample.xy.qweatherapi.com');
      assert.equal(new Headers(options?.headers).get('X-QW-Api-Key'), apiKey);
      assert.equal(url.searchParams.has('key'), false);
      assert.equal(options?.redirect, 'error');
      qweatherCalls.push(url.pathname);
      if (url.pathname === '/geo/v2/city/lookup') {
        startQweather();
        if (blockForPeer) await amapStarted;
        if (status !== 200) return new Response(null, { status });
        assert.equal(url.searchParams.get('location'), '上海');
        return Response.json({ code: '200', location: [{ name: city, adm1: '上海市',
          country: '中国', lat: '31.23', lon: '121.47', tz: 'Asia/Shanghai' }] });
      }
      if (url.pathname === '/weather/v1/current/31.23/121.47') {
        return Response.json({ metadata: {}, validTime: new Date().toISOString(), condition: { text: '小雨' },
          temperature: { unit: '°C', value: 12.5 }, humidity: 0.57 });
      }
      assert.equal(url.pathname, '/weather/v1/daily/31.23/121.47');
      assert.equal(url.searchParams.get('days'), '4');
      return Response.json({ metadata: { attributions: ['https://www.qweather.com/attribution.html'] }, days: [{
        daytime: { forecastStartTime: currentDate + 'T07:00:00+08:00', condition: { text: '小雨' } },
        nighttime: { condition: { text: '阴' } }, temperatureMax: { value: 16, unit: '°C' },
        temperatureMin: { value: 8, unit: '°C' },
      }] });
    },
  }).app.listen(0, '127.0.0.1');
  const mcp = new Client({ name: 'compare-weather-test', version: '1' });
  await once(server, 'listening');
  try {
    const addr = server.address();
    assert(addr && typeof addr !== 'string');
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }));
    async function read(mode: 'current' | 'forecast' = 'forecast') {
      const reply = await mcp.callTool({ name: 'evaluate_ontology', arguments: {
        function: 'readComparedWeather', input: { city: '上海', mode },
      } }, { timeout: 12000 });
      assert.equal(reply.isError, undefined, JSON.stringify(reply.structuredContent ?? reply.content));
      return comparedWeatherResult.parse(JSON.parse((reply.content[0] as { text: string }).text));
    }
    const result = await read();
    blockForPeer = false;
    const [first, second] = result.sources;
    assert.equal(first.status, 'available');
    assert.equal(second.status, 'available');
    assert(first.status === 'available' && first.weather.kind === 'forecast' && 'daytimeTemperatureC' in first.weather.days[0]!);
    assert(second.status === 'available' && second.weather.kind === 'forecast' && 'maxTemperatureC' in second.weather.days[0]!);
    assert.equal(first.weather.days[0]?.daytime, '晴');
    assert.equal(second.weather.days[0]?.daytime, '小雨');
    assert.deepEqual(second.weather.attributions, ['https://www.qweather.com/', 'https://www.qweather.com/attribution.html']);
    assert(!JSON.stringify(result).includes(apiKey));

    const live = await read('current');
    assert.equal(live.locationAgreement, 'same');
    const reading = live.sources[1];
    assert(reading.status === 'available' && reading.weather.kind === 'current');
    assert.equal(reading.weather.temperatureC, 12.5);
    assert(Math.abs(reading.weather.humidityPct! - 57) < 1e-9);

    status = 503;
    assert.deepEqual((await read()).sources.map(source => source.status), ['available', 'unavailable']);
    status = 200;
    city = '杭州市';
    assert.deepEqual((await read()).sources.map(source => source.status), ['available', 'location_unconfirmed']);

    await setGrants(f.db, principal.owner, businessGrants(f.model).filter(grant => grant.resource !== 'Eigos/source/QWeather'));
    const initialQweatherCalls = qweatherCalls.length;
    assert.deepEqual((await read()).sources.map(source => source.status), ['available', 'authorization_required']);
    assert.equal(qweatherCalls.length, initialQweatherCalls);

    city = '上海市';
    await setGrants(f.db, principal.owner, businessGrants(f.model).filter(grant => grant.resource !== 'Eigos/source/Amap'));
    const initialAmapCalls = amapCalls.length;
    assert.deepEqual((await read()).sources.map(source => source.status), ['authorization_required', 'available']);
    assert.equal(amapCalls.length, initialAmapCalls);
  } finally {
    startQweather();
    startAmap();
    await mcp.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
