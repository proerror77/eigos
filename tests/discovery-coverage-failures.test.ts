// Synthetic reader failures only; no credential, model or live provider is used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ExecutionCatalog, type AdapterContext, type DiscoverySource } from '../packages/core/catalog.js';
import { CapabilityResolver, type Resolution } from '../packages/coordinator/resolver.js';
import { PaotuiGeoDiscoverySource } from '../packages/capabilities/paotui-geo-discovery.js';
import { PAOTUI_READ_CAPABILITIES } from '../packages/capabilities/paotui-ontology.js';
import type { PaotuiReader } from '../packages/capabilities/paotui-contracts.js';
import type { DiscoveryCoverage } from '../packages/ontology/supply.js';
import { fixtureAdapter, fixtureCapability, owner } from './backend-fixture.js';

const capability = PAOTUI_READ_CAPABILITIES[0]!;
const publicQuery = { city: '北京市', keyword: '天安门' };
const sourceId = 'meituan:public-geo-discovery';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const context = (): AdapterContext => ({ owner, request: {
  id: randomUUID(), revision: 1, originalGoal: 'Synthetic public search failure', messages: [], requirements: [],
} });
function resolver(reader: PaotuiReader) {
  const source = new PaotuiGeoDiscoverySource(reader, 'synthetic-reader', [publicQuery]);
  return new CapabilityResolver(new ExecutionCatalog([capability], [], [source.adapter], [source]));
}
function assertCoverage(resolution: Resolution, status: DiscoveryCoverage['status'], expectedSource = sourceId, realSupply = false) {
  assert.deepEqual(resolution.candidates, []);
  assert.equal(resolution.scope.realSupply, false, 'failed retrieval cannot establish real supply');
  assert.equal(resolution.comparison, undefined);
  assert.equal(resolution.scope.coverage?.length, 1);
  const coverage = resolution.scope.coverage![0]!;
  assert.equal(coverage.sourceId, expectedSource);
  assert.equal(coverage.status, status);
  assert.equal(coverage.realSupply, realSupply);
  assert.equal(coverage.returnedStores, 0);
  assert.equal(coverage.queriedStores, 0);
}

test('public-location provider failure retains non-supply coverage through the resolver', async () => {
  let calls = 0;
  const discovery = resolver({ query: async () => { calls++; throw new Error('Synthetic provider outage'); } });
  const resolution = await discovery.resolve(context(), capability.ref, publicQuery, new AbortController().signal);
  assert.equal(calls, 1);
  assertCoverage(resolution, 'unavailable');
});

test('public-location allowlist denial retains non-supply coverage without invoking the reader', async () => {
  let calls = 0;
  const discovery = resolver({ query: async () => { calls++; throw new Error('Reader must not run'); } });
  const resolution = await discovery.resolve(context(), capability.ref, { city: '北京市', keyword: '故宫博物院' }, new AbortController().signal);
  assert.equal(calls, 0);
  assertCoverage(resolution, 'needs_authorization');
});

test('an uncooperative public-location reader times out with non-supply coverage', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0; let readerSignal: AbortSignal | undefined;
  const discovery = resolver({ query: async (_input, signal) => { calls++; readerSignal = signal; return new Promise<object>(() => {}); } });
  let resolution: Resolution | undefined; let failure: unknown;
  void discovery.resolve(context(), capability.ref, publicQuery, new AbortController().signal)
    .then(result => { resolution = result; }, error => { failure = error; });
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(60000); await flush();
  assert.ifError(failure);
  assert(resolution, 'resolver must finish even when the reader ignores cancellation');
  assert.equal(readerSignal?.aborted, true);
  assertCoverage(resolution, 'timeout');
});

for (const declared of [undefined, true] as const) test(`source failure preserves supply metadata when declared ${String(declared)}`, async () => {
  const id = 'synthetic-supply-failure';
  const source: DiscoverySource = {
    id, adapterId: id, channelId: 'fixture', capabilityRefs: [fixtureCapability.ref],
    ...(declared === undefined ? {} : { realSupply: declared }), permitted: identity => identity === owner,
    discover: async () => { throw new Error('Synthetic supply outage'); },
  };
  const catalog = new ExecutionCatalog([fixtureCapability], [], [fixtureAdapter(id, {})], [source]);
  const resolution = await new CapabilityResolver(catalog).resolve(context(), fixtureCapability.ref, {}, new AbortController().signal);
  assertCoverage(resolution, 'unavailable', id, true);
});
