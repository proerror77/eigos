import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { amapObservationAccountResources, amapObservationResult, amapObservations } from '../packages/ontology/amap-observations.js';
import { Access, businessGrants, syncAccountGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { Accounts } from '../packages/runtime/accounts.js';
import { fixture, principal } from './fixture.js';
import { fakeAmap, testConnection, type Recorded } from './amap-fixture.js';

test('Amap Actions record verifiable observations and reuse the linked geocoded origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eigos-amap-observations-'));
  const mcpCalls: Recorded[] = [], webCalls: string[] = [];
  try {
    const config = await testConnection(dir), mcp = fakeAmap(mcpCalls);
    const fetcher: typeof fetch = async (target, options) => {
      const url = new URL(String(target));
      if (url.origin === 'https://mcp.amap.com') return mcp(target, options);
      assert.equal(url.origin, 'https://restapi.amap.com');
      assert.equal(options?.method, 'GET');
      assert.equal(options?.redirect, 'error');
      webCalls.push(url.pathname);
      const answer = (value: object) => Response.json({ status: '1', ...value });
      if (url.pathname === '/v5/direction/bicycling')
        return answer({ route: { paths: [{ distance: '900', duration: '220' }] } });
      if (url.pathname === '/v5/direction/transit/integrated') {
        assert.equal(url.searchParams.get('city1'), '310115');
        assert.equal(url.searchParams.get('city2'), '310000');
        assert.equal(url.searchParams.get('show_fields'), 'cost');
        return answer({ route: { transits: [{ distance: '3900', cost: { duration: '1050' },
          segments: [{ bus: [] }, { bus: { buslines: [{ name: '地铁 8 号线' }] } }] }] } });
      }
      if (url.pathname === '/v3/distance')
        return answer({ results: [{ origin_id: '2', dest_id: '1', distance: '1200', duration: '100' },
          { origin_id: '1', dest_id: '1', distance: '900', duration: '90' }] });
      assert.equal(url.pathname, '/v3/traffic/status/rectangle');
      return answer({ trafficinfo: { evaluation: { status: '2' }, description: '合成路况', roads: [{}, {}] } });
    };
    const f = await fixture(undefined, undefined, undefined, undefined, { amap: config, amapFetch: fetcher });
    try {
      const graph = new Objects(f.db, f.model, f.access);
      const call = async (action: string, input: Record<string, unknown>, requestId: string) => {
        const ref = await f.capabilities.actions.apply(f.access, f.model, action, input, requestId);
        return amapObservationResult.parse(await f.capabilities.functions.invoke(f.model, 'readAmapObservation',
          { observation: ref }, { objects: graph, principal, signal: AbortSignal.timeout(5000) }));
      };
      const search = await call('ResolveAmapAddress', { address: '测试地点', city: '上海市' }, 'geocode');
      assert.equal(search.kind, 'geocode');
      const point = search.candidates[0]!.ref;
      const destination = { point: { latitude: 31.211, longitude: 121.51, coordinateSystem: 'gcj02' }, cityCode: '310000' };
      const origin = { place: point };
      const input = { origin, destination, mode: 'transit' };
      const transit = await call('PlanAmapRoute', input, 'bus');
      assert.equal(transit.kind, 'route');
      assert.deepEqual(transit.origin.ref, point);
      assert.equal(transit.origin.evidence, 'amap_geocode');
      assert.equal(transit.destination.evidence, 'caller_provided');
      assert.deepEqual(transit.options[0]?.lines, ['地铁 8 号线']);
      assert.equal(transit.options[0]?.durationSeconds, 1050);
      assert.deepEqual((await call('PlanAmapRoute', input, 'bus')).observation, transit.observation);
      assert.equal(webCalls.length, 1);
      for (const mode of ['bicycling', 'walking', 'driving']) {
        const route = await call('PlanAmapRoute', { origin, destination, mode }, mode);
        assert.equal(route.kind, 'route');
        assert.equal(route.data.mode, mode);
      }
      const matrix = await call('MeasureAmapDistances', { origins: [origin, destination], destination, mode: 'driving' }, 'matrix');
      assert.equal(matrix.kind, 'distance');
      assert.deepEqual(matrix.legs.map(leg => leg.distanceMeters), [900, 1200]);
      assert.deepEqual(matrix.legs[0]?.origin.ref, point);
      const traffic = await call('InspectAmapTraffic', { southwest: search.candidates[0]!.point, northeast: destination.point }, 'traffic');
      assert.equal(traffic.kind, 'traffic');
      assert.deepEqual([traffic.data.status, traffic.data.roadCount], ['slow', 2]);
      assert.equal((await graph.follow(traffic.observation, 'area')).length, 1);
      assert.equal(businessGrants(f.model).filter(grant => amapObservationAccountResources.has(grant.resource)).length,
        amapObservationAccountResources.size);
      const account = new Accounts(f.db, 'open'), owner = 'synthetic-amap-member';
      await account.provision(owner);
      await account.approve(owner);
      await syncAccountGrants(f.db, f.model);
      const limited = await Access.load(f.db, { owner, scopes: [], memberAccess: true });
      assert(!limited.allows({ ontology: 'Eigos', permission: 'apply_action', resource: 'Eigos/action/' + amapObservations.route.action }));
      assert.equal(mcpCalls[0]?.name, 'maps_geo');
    } finally { await f.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
