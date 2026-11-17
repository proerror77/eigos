import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapDidiResult } from '../packages/capabilities/didi/mapping.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal, route } from './fixture.js';

test('DiDi App handoff accepts the original quote and returns only vetted short links', async () => {
  const f = await fixture();
  try {
    const objects = new Objects(f.db, f.model, f.access);
    const context = { principal, objects, signal: AbortSignal.timeout(5000) };
    const request = await f.capabilities.actions.apply(f.access, f.model, 'EstimateRide', route, 'quote-for-app');
    const estimates = await objects.follow(request, 'estimates');
    const estimate = estimates.find(item => item.properties.productCategory === 'fast')!.ref;
    const generate = (input: Record<string, unknown>) =>
      f.capabilities.functions.invoke(f.model, 'generateDidiRideAppLink', input, context);
    await assert.rejects(generate({ request, estimate: { ...estimate, id: 'other-ride' } }), /current quote/);
    const link = await generate({ request, estimate }) as { appLink: string; miniprogramLink: string; evidence: string };
    assert.equal(link.appLink, 'https://v.didi.cn/TestABC');
    assert.equal(link.miniprogramLink, 'https://v.didi.cn/p/TestDEF');
    assert.equal(link.evidence, 'fixture');
    assert(!('deepLink' in link));
    assert.equal(f.provider.inputs.at(-1)?.product_category, 'fast');
    await generate({ request });
    assert(!Object.hasOwn(f.provider.inputs.at(-1)!, 'product_category'));
    assert.equal(f.provider.flags.orderCreates, 0);
    assert.throws(() => mapDidiResult('taxi_generate_ride_app_link', {
      structuredContent: { appLink: 'https://untrusted.example/123' },
    }));
  } finally {
    await f.close();
  }
});

test('DiDi production short links preserve bounded coordinates and selected-vehicle parameters', () => {
  const appQuery = new URLSearchParams({
    slat: '39.8949', slng: '116.3211', dlat: '39.9109', dlng: '116.4053',
    estimate_params: JSON.stringify({ multi_require_product: '301,302' }),
  });
  const miniProgramQuery = new URLSearchParams({
    fromlat: '39.8949', fromlng: '116.3211', tolat: '39.9109', tolng: '116.4053', source: 'mcp',
    extra_request_pramas: JSON.stringify({ from_type: 1, multi_require_product: '301' }),
  });
  const links = {
    appLink: 'https://v.didi.cn/TestABC?' + appQuery,
    miniprogramLink: 'https://v.didi.cn/p/TestDEF?' + miniProgramQuery,
    browserLink: 'https://v.didi.cn/TestGHI',
  };
  assert.deepEqual(mapDidiResult('taxi_generate_ride_app_link', { structuredContent: links }), { kind: 'app_links', links });
  for (const appLink of [
    links.appLink + '&slat=39.8949',
    'https://v.didi.cn/TestABC?slat=91',
    'https://v.didi.cn/TestABC?redirect=https%3A%2F%2Fexample.com',
    'https://v.didi.cn/TestABC?estimate_params=' + encodeURIComponent(JSON.stringify({
      multi_require_product: '301', redirect: 'https://example.com',
    })),
  ]) assert.throws(() => mapDidiResult('taxi_generate_ride_app_link', { structuredContent: { ...links, appLink } }));
});

test('DiDi map reads keep supported modes, coordinate evidence and source receipts', async () => {
  const f = await fixture();
  try {
    const context = {
      principal, objects: new Objects(f.db, f.model, f.access), signal: AbortSignal.timeout(5000),
    };
    const call = (name: string, input: Record<string, unknown>) =>
      f.capabilities.functions.invoke(f.model, name, input, context);
    const point = { longitude: 121.5, latitude: 31.2, coordinateSystem: 'provider_unspecified' };
    const destination = { ...point, longitude: 121.51 };
    const address = await call('reverseGeocodeDidi', { point }) as { address: string; point: unknown; receiptDigest: string };
    assert.equal(address.address, '上海市浦东新区测试站');
    assert.deepEqual(address.point, point);
    assert.match(address.receiptDigest, /^[a-f0-9]{64}$/);
    const nearby = await call('searchDidiNearbyPlaces', { point, query: '咖啡', radiusMeters: 800 }) as { places: unknown[] };
    assert(nearby.places.length > 0);
    assert.equal(f.provider.inputs.at(-1)?.max_distance, '800');
    for (const mode of ['walking', 'bicycling', 'transit']) {
      const result = await call('estimateDidiMapRoute', {
        origin: point, destination, mode, ...(mode === 'transit' ? { city: '上海市' } : {}),
      }) as { mode: string; routes: { distanceMeters: number }[] };
      assert.equal(result.mode, mode);
      assert.equal(result.routes[0]?.distanceMeters, 850);
    }
    await assert.rejects(call('estimateDidiMapRoute', {
      origin: point, destination: { ...destination, coordinateSystem: 'gcj02' }, mode: 'walking',
    }), /same coordinate system/);
  } finally {
    await f.close();
  }
});
