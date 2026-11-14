import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { amapMcpEndpoint } from '../packages/capabilities/amap/client.js';
import { principal } from './fixture.js';

const key = 'synthetic-webservices-key';
const forecasts = [{
  date: '2026-11-15', dayweather: '晴', nightweather: '多云', daytemp: '17', nighttemp: '9',
}];
const mcpBody = (packet: {id: number}, result: unknown) => Response.json({ jsonrpc: '2.0', id: packet.id, result });

export async function testConnection(directory: string) {
  const keyFile = join(directory, 'key'), config = join(directory, 'connection.json');
  await writeFile(keyFile, key, { mode: 0o600 });
  await writeFile(config, JSON.stringify({
    owner: principal.owner, active: true, keyFile, expiresAt: new Date(Date.now() + 3600000).toISOString(),
    keySha256: createHash('sha256').update(key).digest('hex'),
  }), { mode: 0o600 });
  return config;
}
export type Recorded = { name: string; input: Record<string, unknown> };
export function fakeAmap(calls: Recorded[], state: {
  durationSeconds?: number; condition?: string; beforeRoute?: () => Promise<void>; remoteShape?: boolean;
} = {}): typeof fetch {
  return async (target, options) => {
    const url = new URL(String(target));
    assert.equal(url.searchParams.get('key'), key);
    assert.equal(options?.redirect, 'error');
    if (url.origin === 'https://restapi.amap.com') {
      assert.equal(options?.method, 'GET');
      const query = Object.fromEntries(url.searchParams);
      delete query.key;
      calls.push({ name: url.pathname, input: query });
      if (url.pathname === '/v3/assistant/coordinate/convert') return Response.json({ status: '1', locations: '121.499,31.205' });
      if (url.pathname === '/v3/geocode/regeo') return Response.json({ status: '1', regeocode: { addressComponent: { adcode: '310115' } } });
      assert.equal(url.pathname, '/v3/weather/weatherInfo');
      assert.equal(query.extensions, 'base');
      return Response.json({ status: '1', lives: [{
        province: '上海市', city: '浦东新区', adcode: query.city, weather: state.condition ?? '小雨',
        temperature: '13', winddirection: '东', windpower: '3', humidity: '52', reporttime: new Date().toISOString(),
      }] });
    }
    assert.equal(url.origin + url.pathname, amapMcpEndpoint);
    if (options?.method === 'DELETE') return new Response(null, { status: 200 });
    if (options?.method === 'GET') return new Response(null, { status: 405 });
    const packet = JSON.parse(String(options?.body));
    if (packet.method === 'initialize')
      return mcpBody(packet, { protocolVersion: packet.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'fixture-amap', version: '1' } });
    if (packet.method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(packet.method, 'tools/call');
    const { name, arguments: input } = packet.params;
    calls.push({ name, input });
    const matches = input.address === '未知地点' ? ['未知', '市'] : ['兴趣点'];
    if (name === 'maps_direction_walking' || name === 'maps_direction_driving') await state.beforeRoute?.();
    const data = state.remoteShape && name === 'maps_geo' && input.address === '上海市长宁区虹桥路2550号'
      ? { results: [
        { location: '121.348165,31.193918', level: '门址', adcode: '310105', city: '上海市', street: '虹桥路', number: '2550号' },
        { location: '121.355438,31.189464', level: '门牌号', adcode: '310105', city: '上海市', street: '虹桥路', number: [] },
      ] } : state.remoteShape && name === 'maps_direction_driving'
      ? { paths: [{ distance: '3000', duration: String(state.durationSeconds ?? 1500) }] }
      : {
      maps_geo: { return: matches.map(level => ({ location: '121.5,31.2', level, adcode: '310115', city: '上海市' })) },
      maps_regeocode: { provice: '上海市', city: [], district: '浦东新区' },
      maps_text_search: { pois: [{ id: 'B0EXAMPLE', name: '咖啡店', address: [], photos: { url: 'private-data' } }] },
      maps_search_detail: { id: input.id, name: '咖啡店', city: '上海市', location: '121.5,31.2' },
      maps_around_search: { pois: [{ id: 'B0EXAMPLE', name: '咖啡店' }] },
      maps_direction_walking: { route: { paths: [{ distance: '900', duration: String(state.durationSeconds ?? 650) }] } },
      maps_direction_driving: { route: { paths: [{ distance: '3000', duration: String(state.durationSeconds ?? 1500) }] } },
      maps_weather: { city: input.city === '310115' ? '浦东新区' : '上海市', forecasts },
    }[name as string];
    assert(data, 'Unexpected supplier tool');
    return mcpBody(packet, { content: [{ type: 'text', text: JSON.stringify(data) }] });
  };
}
