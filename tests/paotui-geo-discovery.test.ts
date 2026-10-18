import { templatePlanning } from '../packages/ontology/planning-contract.js';
// Every provider response in this file is synthetic. No personal CLI, credential,
// model, public POI endpoint, or live service is invoked by these tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionCatalog, type AdapterContext } from '../packages/core/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { digest } from '../packages/core/delegation.js';
import { CapabilityResolver } from '../packages/coordinator/resolver.js';
import { proposePlan, validatePlan } from '../packages/coordinator/plan.js';
import { PaotuiGeoDiscoverySource } from '../packages/capabilities/paotui-geo-discovery.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { PAOTUI_READ_CAPABILITIES, PAOTUI_READ_BINDINGS } from '../packages/capabilities/paotui-ontology.js';
import type { PaotuiQuery, PaotuiReader } from '../packages/capabilities/paotui-contracts.js';
import type { OntologyReceipt } from '../packages/capabilities/paotui-mcp-server.js';
import { backend, owner, principal, proposal, reasoner } from './backend-fixture.js';

const capability = PAOTUI_READ_CAPABILITIES[0]!;
const publicQuery = { city: '北京市', keyword: '天安门' };
const otherPublicQuery = { city: '北京市', keyword: '故宫博物院' };
const readerConfiguration = digest({ fixture: 'synthetic-reader-v1' });
const signal = () => new AbortController().signal;
const context = (): AdapterContext => ({ owner, request: {
  id: randomUUID(), revision: 1, originalGoal: 'PRIVATE_GOAL_MUST_NOT_REACH_PROVIDER',
  messages: [{ id: 'private-message', text: 'PRIVATE_MESSAGE_MUST_NOT_REACH_PROVIDER', receivedAt: new Date().toISOString() }], requirements: [],
} });
const places = () => [{ name: 'Synthetic public location', address: 'Synthetic public square', city: '北京市', cityId: 'fixture-city', lat: 39.9, lng: 116.4, coordinateUnit: 'degree', id: 'fixture-place-1', poiId: 'fixture-poi-1' }];
function response(items: unknown[] = places(), evidenceKind: OntologyReceipt['evidenceKind'] = 'fixture') {
  const business = { source: 'meituan', readOnly: true, places: items };
  const ontologyReceipt: OntologyReceipt = {
    id: randomUUID(), transport: 'mcp-stdio', server: 'eigos-ontology', capabilityRef: { id: 'geo.search', version: '1' },
    ontologyRef: { id: 'locations-and-parcel-quotes', version: '1' }, tool: 'ontology_geo_search', evidenceKind,
    inputDigest: digest(publicQuery), resultDigest: digest(business), observedAt: new Date().toISOString(), sourceCalls: ['search_poi'], readOnly: true,
  };
  return { ...business, ontologyReceipt };
}
function harness(result: object = response(), allowedQueries: readonly { city: string; keyword: string }[] = [publicQuery], configuration = readerConfiguration) {
  const calls: PaotuiQuery[] = [];
  const reader: PaotuiReader = { query: async input => { calls.push(structuredClone(input)); return structuredClone(result); } };
  const source = new PaotuiGeoDiscoverySource(reader, configuration, allowedQueries);
  const catalog = new ExecutionCatalog([capability], [], [source.adapter], [source]);
  return { source, catalog, calls };
}
async function resolvedPlan(h: ReturnType<typeof harness>, ctx = context()) {
  const resolution = await new CapabilityResolver(h.catalog).resolve(ctx, capability.ref, publicQuery, signal());
  const candidate = resolution.candidates[0]!;
  assert.equal(candidate?.status, 'ready');
  const plan = proposePlan(h.catalog, ctx.owner, ctx.request, capability, candidate,
    proposal({ request: ctx.request, capability, resolution }), templatePlanning(ctx.request));
  return { ctx, resolution, candidate, plan, privateData: resolution.privateData.get(candidate.id) };
}

test('public POI discovery is denied by default, including direct adapter preparation', async () => {
  const calls: PaotuiQuery[] = [];
  const source = new PaotuiGeoDiscoverySource({ query: async input => { calls.push(input); return response(); } }, readerConfiguration);
  assert.equal(source.permitted(owner), false);
  const catalog = new ExecutionCatalog([capability], [], [source.adapter], [source]);
  assert.deepEqual(catalog.summaries(owner), []);
  await assert.rejects(() => source.discover(context(), publicQuery, signal()));
  await assert.rejects(() => source.adapter.prepare(context(), publicQuery, signal()));
  assert.deepEqual(calls, []);
});

test('application catalog opts into public discovery without duplicating the static search binding', () => {
  const store = new JobStore(':memory:');
  try {
    // Construction only: the synthetic path is never opened and no reader runs.
    const options = { store, paotuiSkillDirectory: '/tmp/eigos-synthetic-paotui-not-invoked' };
    const defaultCatalog = createExecutionCatalog(options);
    assert.deepEqual(defaultCatalog.discoverySources(capability.ref, owner), []);
    assert.equal(defaultCatalog.bindings(capability.ref, owner).length, 1);
    const optedIn = createExecutionCatalog({ ...options, publicGeoDiscoveryQueries: [publicQuery] });
    assert.equal(optedIn.discoverySources(capability.ref, owner).length, 1);
    assert.deepEqual(optedIn.bindings(capability.ref, owner), []);
    assert.deepEqual(optedIn.discoverySources(capability.ref, 'another-owner'), []);
    assert.equal(optedIn.summaries(owner).filter(summary => summary.ref.id === 'geo.search').length, 1);
    assert.equal(optedIn.bindings({ id: 'address.book.read', version: '1' }, owner).length, 1);
  } finally { store.close(); }
});

test('source rejects another owner and nonallowlisted, private or extra inputs before reading', async () => {
  const h = harness();
  assert.equal(h.source.permitted('another-owner'), false);
  await assert.rejects(() => h.source.discover({ ...context(), owner: 'another-owner' }, publicQuery, signal()));
  const rejected = [
    otherPublicQuery,
    { city: '北京市', keyword: 'PRIVATE_HOME_ADDRESS' },
    { ...publicQuery, senderAddressId: 'PRIVATE_SAVED_ADDRESS' },
    { ...publicQuery, action: 'addresses' },
    { ...publicQuery, goal: 'PRIVATE_GOAL' },
    { city: publicQuery.city },
    { city: publicQuery.city, keyword: { private: 'nested-value' } },
  ];
  for (const input of rejected) await assert.rejects(() => h.source.discover(context(), input, signal()));
  await assert.rejects(() => h.source.adapter.prepare(context(), otherPublicQuery, signal()));
  assert.deepEqual(h.calls, []);
});

test('an already canceled discovery never invokes its reader', async () => {
  const h = harness(); const controller = new AbortController();
  controller.abort(new Error('Synthetic cancellation'));
  await assert.rejects(() => h.source.discover(context(), publicQuery, controller.signal));
  assert.deepEqual(h.calls, []);
});

test('fixture POIs produce one scoped search binding, no merchant offer or real-supply claim', async () => {
  const fixture = response([...places(), { ...places()[0], poiId: 'fixture-poi-2' }]);
  const h = harness(fixture); const ctx = context();
  const discovered = await h.source.discover(ctx, publicQuery, signal());
  assert.deepEqual(h.calls, [{ action: 'search_address', ...publicQuery }]);
  assert.equal(discovered.candidates.length, 1);
  const candidate = discovered.candidates[0]!;
  assert.equal(candidate.binding.providerId, PAOTUI_READ_BINDINGS[0]!.providerId);
  assert.equal(candidate.binding.channelId, 'meituan');
  assert.equal(candidate.binding.adapterId, h.source.adapterId);
  assert.equal(candidate.binding.configurationDigest, h.source.configurationDigest);
  assert.equal(candidate.binding.merchantId, undefined);
  assert.equal(candidate.binding.verification.level, 'local_test');
  assert.equal(candidate.binding.discovery.sourceId, 'meituan:public-geo-discovery');
  assert.equal(candidate.binding.discovery.requestId, ctx.request.id);
  assert.equal(candidate.binding.discovery.requestRevision, ctx.request.revision);
  assert(candidate.binding.discovery.evidenceRefs.length > 0);
  assert.equal('offer' in candidate, false);
  assert.equal(candidate.preparation.kind, 'ready');
  if (candidate.preparation.kind !== 'ready') assert.fail('Expected a synthetic, prepared search result');
  assert.equal(candidate.preparation.details.evidenceKind, 'fixture');
  assert.equal(candidate.preparation.facts.totalPrice, undefined);
  assert.equal(candidate.preparation.facts.deliveryBy, undefined);
  assert.deepEqual(candidate.preparation.facts.conditions, ['execution.no_order']);
  assert.equal(discovered.coverage.status, 'returned');
  assert.equal(discovered.coverage.realSupply, false);
  assert.equal(discovered.coverage.returnedStores, 0);
  assert.equal(discovered.coverage.queriedStores, 0);
  assert.equal(discovered.coverage.hasMore, true);
  assert(discovered.coverage.note);
  assert(!JSON.stringify(h.calls).includes('PRIVATE_'));
});

test('a synthetic live-shaped receipt exercises live validation without calling a live provider', async () => {
  const h = harness(response(places(), 'live_readonly'));
  const result = await h.source.discover(context(), publicQuery, signal());
  assert.equal(h.calls.length, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.binding.verification.level, 'read_only_probe');
  const prepared = result.candidates[0]!.preparation;
  assert.equal(prepared.kind, 'ready');
  if (prepared.kind === 'ready') assert.equal(prepared.details.evidenceKind, 'live_public_location_read');
  assert.equal(result.coverage.realSupply, false);
  assert.equal('offer' in result.candidates[0]!, false);
  const resolved = await new CapabilityResolver(h.catalog).resolve(context(), capability.ref, publicQuery, signal());
  assert.equal(resolved.scope.realSupply, false);
  assert.equal(resolved.comparison, undefined);
});

test('empty POI responses remain empty and disclose incomplete search coverage', async () => {
  const h = harness(response([]));
  const result = await h.source.discover(context(), publicQuery, signal());
  assert.deepEqual(result.candidates, []);
  assert.equal(result.coverage.status, 'empty');
  assert.equal(result.coverage.returnedStores, 0);
  assert.equal(result.coverage.queriedStores, 0);
  assert.equal(result.coverage.hasMore, true);
  assert.equal(result.coverage.realSupply, false);
  const resolved = await new CapabilityResolver(h.catalog).resolve(context(), capability.ref, publicQuery, signal());
  assert.deepEqual(resolved.candidates, []);
  assert.equal(resolved.comparison, undefined);
});

test('typed POI output rejects malformed, nested and non-whitelisted provider data', async t => {
  const cases: { name: string; value: object }[] = [
    { name: 'nested name', value: response([{ ...places()[0], name: { debug: 'PRIVATE_PROVIDER_DATA' } }]) },
    { name: 'nested address', value: response([{ ...places()[0], address: { token: 'PRIVATE_PROVIDER_DATA' } }]) },
    { name: 'unknown place field', value: response([{ ...places()[0], phone: 'PRIVATE_PROVIDER_DATA' }]) },
    { name: 'invalid coordinate type', value: response([{ ...places()[0], lat: { value: 39.9 } }]) },
    { name: 'missing places', value: { source: 'meituan', readOnly: true, ontologyReceipt: response().ontologyReceipt } },
    { name: 'unexpected top-level data', value: { ...response(), providerDebug: 'PRIVATE_PROVIDER_DATA' } },
    { name: 'wrong source', value: { ...response(), source: 'synthetic-other-provider' } },
    { name: 'write response', value: { ...response(), readOnly: false } },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const h = harness(item.value);
    await assert.rejects(() => h.source.discover(context(), publicQuery, signal()));
    assert.equal(h.calls.length, 1);
  });
});

test('POI results are bounded at 100 and over-limit responses are rejected without truncation', async () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ ...places()[0], poiId: `fixture-poi-${i}` }));
  const accepted = await harness(response(items)).source.discover(context(), publicQuery, signal());
  assert.equal(accepted.candidates.length, 1);
  const h = harness(response([...items, places()[0]! ]));
  await assert.rejects(() => h.source.discover(context(), publicQuery, signal()));
});

test('source validates full receipt schema and binds the exact search operation and response', async t => {
  const changes: { name: string; change: Record<string, unknown> }[] = [
    { name: 'input digest', change: { inputDigest: digest(otherPublicQuery) } },
    { name: 'result digest', change: { resultDigest: digest({ places: [] }) } },
    { name: 'capability', change: { capabilityRef: { id: 'address.book.read', version: '1' } } },
    { name: 'ontology', change: { ontologyRef: { id: 'untrusted', version: '1' } } },
    { name: 'tool', change: { tool: 'ontology_delivery_quote' } },
    { name: 'source call', change: { sourceCalls: ['get_address_list'] } },
    { name: 'additional source call', change: { sourceCalls: ['search_poi', 'get_address_list'] } },
    { name: 'missing source call', change: { sourceCalls: [] } },
    { name: 'invalid evidence kind', change: { evidenceKind: 'live_fulfillment' } },
    { name: 'invalid timestamp', change: { observedAt: 'not-a-timestamp' } },
    { name: 'unknown receipt field', change: { debug: 'PRIVATE_PROVIDER_DATA' } },
  ];
  for (const item of changes) await t.test(item.name, async () => {
    const value = response();
    const h = harness({ ...value, ontologyReceipt: { ...value.ontologyReceipt, ...item.change } });
    await assert.rejects(() => h.source.discover(context(), publicQuery, signal()));
  });
  const { ontologyReceipt: _receipt, ...noReceipt } = response();
  await assert.rejects(() => harness(noReceipt).source.discover(context(), publicQuery, signal()));
});

test('stale and future source timestamps cannot become current discovery facts', async t => {
  for (const [name, offset] of [['stale', -300001], ['future', 60000]] as const) await t.test(name, async () => {
    const value = response();
    value.ontologyReceipt.observedAt = new Date(Date.now() + offset).toISOString();
    await assert.rejects(() => harness(value).source.discover(context(), publicQuery, signal()));
  });
});

test('preparation freshness is pinned to the source receipt instead of extending at discovery time', async () => {
  const value = response();
  value.ontologyReceipt.observedAt = new Date(Date.now() - 60000).toISOString();
  const result = await harness(value).source.discover(context(), publicQuery, signal());
  const prepared = result.candidates[0]!.preparation;
  assert.equal(prepared.kind, 'ready');
  if (prepared.kind !== 'ready') assert.fail('Expected fresh synthetic source evidence');
  assert.equal(prepared.observedAt, value.ontologyReceipt.observedAt);
  assert.equal(prepared.expiresAt, new Date(Date.parse(value.ontologyReceipt.observedAt) + 300000).toISOString());
});

test('configuration fingerprints normalize the allowlist and change with reader or allowed scope', () => {
  const base = harness(response(), [publicQuery, otherPublicQuery]).source;
  const normalized = harness(response(), [otherPublicQuery, { city: ' 北京市 ', keyword: ' 天安门 ' }, publicQuery]).source;
  assert.equal(base.configurationDigest, normalized.configurationDigest);
  assert.notEqual(base.configurationDigest, harness(response(), [publicQuery]).source.configurationDigest);
  assert.notEqual(base.configurationDigest, harness(response(), [publicQuery, otherPublicQuery], 'different-reader-configuration').source.configurationDigest);
});

test('discovered plan restores only for the same owner, request and allowed source configuration', async () => {
  const h = harness(); const { ctx, plan } = await resolvedPlan(h);
  const restarted = harness();
  validatePlan(restarted.catalog, ctx.owner, ctx.request, plan);
  assert.deepEqual(restarted.calls, []);
  assert.equal(restarted.catalog.binding(plan.bindingRef, owner, ctx.request.id).binding.configurationDigest, h.source.configurationDigest);
  assert.throws(() => restarted.catalog.binding(plan.bindingRef, 'another-owner', ctx.request.id));
  assert.throws(() => restarted.catalog.binding(plan.bindingRef, owner, randomUUID()));
  assert.throws(() => validatePlan(harness(response(), []).catalog, owner, ctx.request, plan));
  assert.throws(() => validatePlan(harness(response(), [otherPublicQuery]).catalog, owner, ctx.request, plan));
  assert.throws(() => validatePlan(harness(response(), [publicQuery], 'changed-reader').catalog, owner, ctx.request, plan));
});

test('search delivery preserves source evidence and independent verification rejects altered result or receipt', async () => {
  const h = harness(); const { ctx, plan, privateData } = await resolvedPlan(h);
  const delivered = await h.source.adapter.execute(ctx, plan, privateData, signal());
  assert.equal(h.calls.length, 1);
  assert.equal(delivered.artifact.name, 'geo.search.json');
  assert.equal(h.source.adapter.verify(ctx, plan, privateData, delivered).accepted, true);
  const original = delivered.artifact.data.result as ReturnType<typeof response>;
  assert.deepEqual(original.places, places());
  assert.equal(original.ontologyReceipt.evidenceKind, 'fixture');
  assert.equal(delivered.facts.totalPrice, undefined);
  assert(delivered.evidenceRefs.length > 0);
  const changed = structuredClone(delivered);
  (changed.artifact.data.result as ReturnType<typeof response>).places = [{ ...places()[0], name: 'Fabricated substitute' }];
  assert.equal(h.source.adapter.verify(ctx, plan, privateData, changed).accepted, false);
  const changedReceipt = structuredClone(delivered);
  (changedReceipt.artifact.data.result as ReturnType<typeof response>).ontologyReceipt.resultDigest = 'forged-digest';
  assert.equal(h.source.adapter.verify(ctx, plan, privateData, changedReceipt).accepted, false);
});

test('a synthetic public-query task completes and its exact evidence survives durable task readback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-public-geo-'));
  const path = join(directory, 'jobs.sqlite');
  const fixture = response(); const h = harness(fixture);
  const runner = backend(h.catalog, reasoner(request => ({
    kind: 'resolve', requestRevision: request.revision, capabilityRef: capability.ref,
    message: 'Synthetic public-query grounding', inputJson: JSON.stringify(publicQuery), requirementsJson: '[]', conditionsJson: '[]',
  })), new JobStore(path));
  let opened = runner.store;
  try {
    const submitted = runner.submit({ goal: 'PRIVATE_GOAL_MUST_NOT_REACH_PROVIDER; obtain the allowlisted public location result' });
    const done = await runner.run();
    assert.equal(done.id, submitted.id);
    assert.equal(done.state, 'completed');
    assert.equal(done.delegation!.acceptance!.accepted, true);
    assert.equal(done.delegation!.plan!.completionTarget, 'artifact');
    assert.equal(done.delegation!.resolution!.scope.realSupply, false);
    assert.equal(done.delegation!.resolution!.comparison, undefined);
    assert.deepEqual(done.artifact!.data.result, fixture);
    assert.deepEqual(h.calls, [{ action: 'search_address', ...publicQuery }]);
    assert(!JSON.stringify(h.calls).includes('PRIVATE_'));
    assert(done.delegation!.acceptance!.evidenceRefs.length > 0);

    runner.store.close();
    const restartedSource = harness();
    opened = new JobStore(path);
    const restarted = backend(restartedSource.catalog, reasoner(), opened);
    const readback = restarted.tasks.get(principal, submitted.id);
    assert.equal(readback.state, 'completed');
    assert.deepEqual(readback.artifact, done.artifact);
    assert.deepEqual(readback.delegation!.acceptance, done.delegation!.acceptance);
    assert.equal((readback.artifact!.data.result as ReturnType<typeof response>).ontologyReceipt.evidenceKind, 'fixture');
    assert.equal(readback.delegation!.actions!.length, 1);
    assert.equal(readback.delegation!.actions![0]!.state, 'effect_confirmed');
    assert.equal(readback.delegation!.businessFacts!.length, 0);
    assert.equal(opened.intents(owner, submitted.id)[0]!.effect, 'read');
    validatePlan(restartedSource.catalog, owner, readback.delegation!.request, readback.delegation!.plan!);
    assert.deepEqual(restartedSource.calls, []);
  } finally { opened.close(); rmSync(directory, { recursive: true, force: true }); }
});
