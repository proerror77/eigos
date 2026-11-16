import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

test('authorized Dianping search and shop details work through the published MCP and PA task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-dianping-'));
  const path = join(directory, 'dianping.json');
  const binding = {
    owner: principal.owner, active: true, expiresAt: new Date(Date.now() + 600000).toISOString(),
    appKey: 'fixture-dianping-appkey', appSecret: 'fixture-dianping-appsecret',
    sessions: { search: 'fixture-dianping-search-session', detail: 'fixture-dianping-detail-session' },
  };
  const connection = (value: Record<string, unknown>) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await connection(binding);
  const calls: Array<{ endpoint: string; parameters: Record<string, unknown> }> = [];
  const searchUrl = 'https://poiopen.dianping.com/router/poisearch/search';
  const detailUrl = 'https://poiopen.dianping.com/router/poi/getsinglepoi';
  const search = { query: '苏帮菜', city: '苏州', center: { latitude: 31.27, longitude: 120.67, coordinateSystem: 'gcj02' }, radiusMeters: 1500, limit: 3 };
  const selected = { shopId: 'fixture-shop-A' };
  const merchant = {
    name: '合成验收餐厅', branch_name: '湖畔店', address: '合成验收地址', city: '苏州', latitude: 31.27, longitude: 120.67,
    star: 4.6, avgprice: 128, reviewCount: 42, reviewTags: [{ tag: '环境好', hit: 12 }],
    dishs: [{ dishName: '松鼠桂鱼', price: 108, recommendCount: 9 }], business_hour: '11:00–20:00',
    bookable: '1', mBookURL: 'https://m.dianping.com/fixture-reservation',
    mShopInfoUrl: 'https://m.dianping.com/fixture-shop',
    mReviewAllUrl: 'https://dianping.com.untrusted.invalid/reviews',
    ugcs: [{ nick: 'fixture-reviewer', content: 'fixture-review-text' }],
  };
  let override: (() => Response | Promise<Response>) | undefined;
  const fake: typeof fetch = async (input, init) => {
    const endpoint = String(input);
    assert([searchUrl, detailUrl].includes(endpoint));
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const { sign, ...parameters } = JSON.parse(String(init?.body));
    assert.equal(parameters.appkey, binding.appKey);
    assert.equal(parameters.session, endpoint === searchUrl ? binding.sessions.search : binding.sessions.detail);
    assert.match(parameters.timestamp, /^\d{13}$/);
    assert.equal(parameters.appsecrect, undefined);
    const expected = Object.keys(parameters).sort().map(name => name + parameters[name]).join('');
    assert.equal(sign, createHash('md5').update(binding.appSecret + expected + binding.appSecret).digest('hex'));
    calls.push({ endpoint, parameters });
    if (override) return override();
    return endpoint === searchUrl ? Response.json({
      status: 'OK', records: [
        { openshopid: selected.shopId, name: '合成验收餐厅', branchname: '湖畔店', shopaddress: '合成验收地址', distance: 805, category: '美食' },
        { openshopid: 'fixture-shop-B', name: '另一家合成餐厅' },
      ], total_count: 2,
    }) : Response.json({ status: 'success', success: true, data: merchant });
  };
  const f = await fixture({
    model: 'recorded-dianping-decisions',
    async run(prompt, tools) {
      assert.match(prompt, /searchDianpingRestaurants/);
      const result = await tools.get('evaluate_function')!.invoke({ function: 'searchDianpingRestaurants', input: search }) as { shops: Array<{ shopId: string }> };
      await tools.get('complete_with_function')!.invoke({ function: 'readDianpingRestaurant', input: { shopId: result.shops[0]!.shopId } });
    },
  }, undefined, undefined, undefined, { dianping: path, dianpingFetch: fake });
  const token = 'dianping-local-fixture-token-at-least-32';
  const config = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, EIGOS_DIANPING_CONNECTION_FILE: path });
  const gateway = createApp(config, f.db, f.source, undefined, {}, { dianpingFetch: fake });
  const server = gateway.app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const invoke = async (name: string, args: unknown) => {
      const response = await fetch('http://127.0.0.1:' + address.port + '/mcp', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const { result } = await response.json();
      assert.equal(response.status, 200);
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    const listed = await invoke('evaluate_ontology', { function: 'searchDianpingRestaurants', input: { city: '苏州', query: '苏帮菜' } });
    assert.equal(listed.evidence, 'provider_mock');
    assert.equal(listed.shops.length, 2);
    assert.equal(listed.shops[0].distanceMeters, 805);
    assert.equal(listed.shops[1].distanceMeters, undefined);
    assert.equal(calls[0]!.parameters.latitude, undefined);
    const task = await invoke('submit_task', { requestId: 'dianping-read-fixture', message: '找附近的苏帮菜，查一家餐厅的评分、推荐菜和预订入口' });
    await f.worker.runOne();
    const finished = await invoke('get_task', { taskId: task.id });
    assert.equal(finished.state, 'completed', finished.error);
    assert.deepEqual(calls.map(call => call.endpoint), [searchUrl, searchUrl, detailUrl]);
    const { appkey, session, timestamp, ...searchParameters } = calls[1]!.parameters;
    assert.deepEqual(searchParameters, { categories: '美食', city: '苏州', keyword: '苏帮菜', latitude: 31.27, longitude: 120.67, page: 1, limit: 3, radius: 1500 });
    assert.equal(calls[2]!.parameters.openshopid, selected.shopId);
    assert.equal(finished.result.shop.shopId, selected.shopId);
    assert.equal(finished.result.shop.rating, 4.6);
    assert.equal(finished.result.shop.averageSpend, 128);
    assert.equal(finished.result.shop.location.coordinateSystem, 'unknown');
    assert.deepEqual(finished.result.shop.reviewTags, [{ label: '环境好', count: 12 }]);
    assert.deepEqual(finished.result.shop.recommendedDishes, [{ name: '松鼠桂鱼', price: 108, recommendationCount: 9 }]);
    assert.equal(finished.result.shop.supportsBooking, true);
    assert.equal(finished.result.shop.bookingUrl, merchant.mBookURL);
    assert.equal(finished.result.shop.reviewsUrl, undefined);
    const output = JSON.stringify(finished.result);
    assert(!output.includes(binding.appSecret) && !output.includes(binding.sessions.detail) && !output.includes('fixture-reviewer'));

    const read = async (name: string, input: Record<string, unknown>) =>
      f.capabilities.functions.invoke(f.model, name, input, {
        principal, objects: new Objects(f.db, f.model, await Access.load(f.db, principal)), signal: AbortSignal.timeout(5000),
      });
    await connection({ ...binding, sessions: { search: binding.sessions.search } });
    await assert.rejects(read('readDianpingRestaurant', selected), /详情授权尚未配置/);
    assert.equal(calls.length, 3);
    await connection(binding);
    override = () => Response.json({ status: 'DENIED', records: [] });
    await assert.rejects(read('searchDianpingRestaurants', search), /大众点评查询失败/);
    override = () => Response.json({ status: 'OK', records: [], total_count: 0 });
    const empty = await read('searchDianpingRestaurants', search) as { shops: unknown[]; totalCount: number };
    assert.deepEqual(empty.shops, []);
    assert.equal(empty.totalCount, 0);
    override = () => Response.json({ status: 'success', success: true, data: { ...merchant, openshopid: 'different-shop' } });
    await assert.rejects(read('readDianpingRestaurant', selected), /大众点评查询失败/);
    override = async () => {
      await connection({ ...binding, active: false });
      return Response.json({ status: 'success', success: true, data: merchant });
    };
    await assert.rejects(read('readDianpingRestaurant', selected), /连接不可用/);
    await connection(binding);
    const sourceRequest = { function: 'searchDianpingRestaurants', input: search };
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const base = 'http://127.0.0.1:' + address.port;
    for (const [status, message, sourceResponse] of [
      [502, 'Source request failed', () => Response.json({ detail: 'private-upstream-error' })],
      [503, 'Source temporarily unavailable', () => new Response('private-upstream-error', { status: 503 })],
    ] as const) {
      override = sourceResponse;
      const httpResponse = await fetch(base + '/ontology/functions', {
        method: 'POST', headers, body: JSON.stringify(sourceRequest),
      });
      assert.equal(httpResponse.status, status);
      assert.deepEqual(await httpResponse.json(), { error: message });

      const mcpResponse = await fetch(base + '/mcp', {
        method: 'POST', headers, body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'evaluate_ontology', arguments: sourceRequest },
        }),
      });
      const { result } = await mcpResponse.json();
      assert.equal(mcpResponse.status, 200);
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { status, error: message });
      assert(!JSON.stringify(result).includes('private-upstream-error'));
    }
    const requests = calls.length;
    await setGrants(f.db, principal.owner, memberGrants(f.model).filter(grant => grant.resource !== 'Eigos/source/Dianping'));
    await assert.rejects(read('readDianpingRestaurant', selected), /Permission required/);
    assert.equal(calls.length, requests);
    assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${f.db.schema}.external_operations`)).rows[0]!.n, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
