import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { amapRideMcpEndpoint } from '../packages/capabilities/amap/client.js';
import { amapRide, amapRideAccountResources, amapRidePlanRecord } from '../packages/ontology/amap-ride.js';
import { businessGrants, setGrants } from '../packages/runtime/access.js';
import { accountGateway, type AccountGateway } from './account-harness.js';
import { fixture } from './fixture.js';

test('the quote MCP resolves Amap through its published Interface and uses only the bound rider Key', async t => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'eigos-amap-ride-'));
  const key = 'synthetic-amap-rider-key', keyFile = join(directory, 'key'), config = join(directory, 'connection.json');
  const calls: Record<string, unknown>[] = [];
  const token = 'private-provider-plan-token';
  const pickup = { name: '合成博物馆北门', longitude: '121.542', latitude: '31.220', pointId: 'private-id' };
  const dropoff = { name: '合成机场', longitude: '121.327', latitude: '31.193' };
  const card = (cardScene: string, modelInput: unknown, cardSubScene?: string) => ({ entities: [
    { cardScene, cardSubScene, modelInput, businessData: token, entity_type: cardScene },
  ] });
  const quoted = card('amap_car_plan', { startPoint: pickup, endPoint: dropoff, transportTypeInfoList: [
    { name: '经济', minPrice: 60.25, maxPrice: 90 }, { name: '特惠快车', minPrice: '49.1', maxPrice: '75.22' },
  ] });
  const candidates = [{ name: '合成商场南店', address: '合成南路1号' }, { name: '合成商场西店', address: '合成西路2号' }];
  let reply: { structuredContent?: unknown; content: { type: string; text: string }[] } =
    { structuredContent: quoted, content: [{ type: 'text', text: '查看规划' }, { type: 'text', text: JSON.stringify(quoted) }] };
  const amapRideFetch: typeof fetch = async (target, init) => {
    const url = new URL(String(target));
    assert.equal(url.origin + url.pathname, amapRideMcpEndpoint);
    assert.equal(url.searchParams.get('key'), key);
    assert.equal(init?.redirect, 'error');
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    const request = JSON.parse(String(init?.body));
    const respond = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'initialize') return respond({
      protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-amap-ride', version: '1' },
    });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(request.method, 'tools/call');
    assert.equal(request.params.name, 'get_taxi_service');
    calls.push(request.params.arguments);
    return respond(reply);
  };

  let gateway: AccountGateway | undefined;
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await gateway?.close();
    await f.close();
    await rm(directory, { recursive: true, force: true });
  });
  const g = gateway = await accountGateway(f, { signup: 'invite', env: {
    EIGOS_AMAP_RIDE_CONNECTION_FILE: config, EIGOS_BETA_AMAP_CONNECTION_FILE: config,
  }, amapRideFetch });
  const saveConnection = async (active: boolean) => {
    await writeFile(keyFile, key, { mode: 0o600 });
    await writeFile(config, JSON.stringify({ owner: g.owner('rider'), active, keyFile,
      keySha256: createHash('sha256').update(key).digest('hex'), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }), { mode: 0o600 });
  };
  const grants = businessGrants(f.model).filter(grant => amapRideAccountResources.has(grant.resource));
  assert.equal(grants.length, amapRideAccountResources.size);
  const connect = async (account: string) => {
    await setGrants(f.db, g.owner(account), [{ resource: 'Eigos', permission: 'view_definition' }, ...grants]);
    const client = new Client({ name: 'synthetic-ride-pa', version: '1' });
    clients.push(client);
    const token = await g.token(account, { azp: 'existing-client', aud: g.config.PUBLIC_URL, scope: 'tasks:read tasks:write' });
    await client.connect(new StreamableHTTPClientTransport(new URL(g.url + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }));
    return client;
  };
  await saveConnection(true);
  const [rider, other] = await Promise.all([connect('rider'), connect('other')]);
  const args = {
    requestId: 'amap-quote', action: {
      interface: { type: amapRide.interface, action: 'estimate', implementation: amapRide.object },
      input: { origin: '合成博物馆', originCity: '上海市', destination: '合成机场', destinationCity: '上海市' },
    },
    read: { function: amapRide.read, resultParameter: 'plan' },
  };
  const call = (client: Client, input: Record<string, unknown>) =>
    client.callTool({ name: 'complete_with_action', arguments: input });
  assert.equal((await call(other, args)).isError, true);
  assert.equal((await call(rider, { ...args, read: { function: 'readRideEstimates', resultParameter: 'request' } })).isError, true);
  assert.equal(calls.length, 0);
  const read = async (requestId: string) => {
    const result = await call(rider, { ...args, requestId });
    assert(!result.isError, JSON.stringify(result));
    const json = JSON.stringify(result);
    assert(!json.includes(token) && !json.includes(key));
    const data = JSON.parse((result.content as { text: string }[])[0]!.text);
    return { plan: data.plan, observation: amapRidePlanRecord.parse(data.observation) };
  };
  const first = await read(args.requestId);
  assert.equal(first.plan.type, amapRide.object);
  assert.equal(first.observation.evidence, 'provider_mock');
  assert.deepEqual(first.observation.result, {
    status: 'quoted', pickup: { name: pickup.name }, dropoff: { name: dropoff.name }, currency: 'CNY',
    offers: [{ vehicle: '经济', minMinor: 6025, maxMinor: 9000 }, { vehicle: '特惠快车', minMinor: 4910, maxMinor: 7522 }],
  });
  assert.deepEqual(await read(args.requestId), first);
  assert.deepEqual(calls, [{
    agent_name: 'EIGOS', origin: '合成博物馆', origin_city: '上海市',
    destination: '合成机场', destination_city: '上海市', vehicle_type: [],
    departure_time: '', arrival_time: '', businessData: '',
  }]);

  const ambiguous = card('amap_car_point', { points: candidates }, 'start_point');
  reply = { content: [{ type: 'text', text: JSON.stringify(ambiguous) }] };
  assert.deepEqual((await read('ambiguous')).observation.result, { status: 'place_required', side: 'origin', candidates });
  reply = { content: [{ type: 'text', text: '距离过近，建议步行。' }] };
  assert.deepEqual((await read('near')).observation.result, { status: 'no_quote', message: '距离过近，建议步行。' });
  reply = { structuredContent: card('amap_car_order', {}), content: [] };
  assert.equal((await call(rider, { ...args, requestId: 'unexpected-order' })).isError, true);

  await saveConnection(false);
  assert.equal((await call(rider, { ...args, requestId: 'revoked' })).isError, true);
  assert.equal(calls.length, 4);
  assert.equal((await f.db.query(`SELECT count(*)::int AS count FROM ${f.schema}.tasks`)).rows[0]?.count, 0);
});
