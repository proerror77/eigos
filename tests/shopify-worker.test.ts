import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { ShopifyCatalogAdapter, SHOPIFY_CATALOG_CAPABILITY } from '../packages/capabilities/shopify/adapter.js';
import { AnonymousShopifyCatalogReader } from '../packages/capabilities/shopify/reader.js';
import { checkedCatalogSnapshot, type CatalogSnapshot } from '../packages/capabilities/shopify/contracts.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { digest } from '../packages/core/delegation.js';
import { JobStore } from '../packages/core/store.js';
import { backend, evidence, interpretation, owner, principal, proposal } from './backend-fixture.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';

const merchant = { id: 'coffee', name: 'Coffee', shopId: 'gid://shopify/Shop/12', domain: 'coffee.myshopify.com' };
const input = { merchantId: 'coffee', query: 'coffee beans', country: 'US' as const };
const variantId = 'gid://shopify/ProductVariant/34', productId = 'gid://shopify/p/abc';
const caps = Object.fromEntries(['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.catalog.lookup', 'dev.shopify.catalog', 'dev.shopify.catalog.global'].map(k => [k, [{ version: '2026-08-25' }]]));
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function fixture() {
  const calls: { endpoint: string; operation: string; headers: Record<string, string>; body: any }[] = [];
  const flags = { price: 2900, changeOnRefresh: false, empty: false, wrongSeller: false, crowdedCluster: false, beforeSearch: undefined as undefined | (() => Promise<void>), beforeRefresh: undefined as undefined | (() => Promise<void>) };
  let lookups = 0;
  const fetcher: typeof fetch = async (url, options = {}) => {
    const endpoint = String(url), body = options.body ? JSON.parse(String(options.body)) : undefined;
    const operation = body?.params?.name ?? 'discovery';
    calls.push({ endpoint, operation, headers: options.headers as Record<string, string>, body });
    assert(['discovery', 'search_catalog', 'get_product', 'lookup_catalog'].includes(operation));
    if (operation === 'search_catalog') await flags.beforeSearch?.();
    if (operation === 'lookup_catalog' && ++lookups >= 2) { await flags.beforeRefresh?.(); if (flags.changeOnRefresh) { flags.price = 3000; flags.changeOnRefresh = false; } }
    if (!body) return response({ ucp: { version: '2026-08-25', capabilities: caps, services: { 'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp', endpoint: 'https://coffee.myshopify.com/api/ucp/mcp' }] } } });
    const item = { id: variantId, title: 'Coffee beans', sku: 'COFFEE', price: { amount: flags.price, currency: 'USD' }, seller: { id: flags.wrongSeller ? 'gid://shopify/Shop/99' : merchant.shopId, name: merchant.name, domain: merchant.domain }, availability: { available: true }, eligible: { native_checkout: false }, inputs: [{ id: variantId, match: 'exact' }] };
    const unpinned = operation === 'get_product' && flags.crowdedCluster && (body.params.arguments.catalog.id !== variantId || digest(body.params.arguments.catalog.filters?.shops) !== digest([merchant.shopId]));
    const product = { id: productId, title: 'Coffee beans', variants: unpinned ? [{ ...item, id: 'gid://shopify/ProductVariant/99', seller: { ...item.seller, id: 'gid://shopify/Shop/99' } }] : [item] };
    return response({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { ucp: { version: '2026-08-25', status: 'success', capabilities: caps }, ...(operation === 'get_product' ? { product } : { products: flags.empty ? [] : [product] }), messages: [] } } });
  };
  return { calls, flags, reader: new AnonymousShopifyCatalogReader(undefined, fetcher) };
}
function model(readSource = true): Reasoner {
  return {
    ground: async request => ({ decision: { ...interpretation(request, SHOPIFY_CATALOG_CAPABILITY, input), capabilityRef: { id: SHOPIFY_CATALOG_CAPABILITY, version: '1' } }, evidence: evidence() }),
    plan: async (ctx, _signal, access) => {
      access.session.call('describe_ontology', { search: 'CatalogRead' });
      access.session.call('query_ontology', { object: { type: 'ServiceRequest', id: ctx.request.id } });
      if (readSource) {
        const subject = ctx.resolution.candidates[0]!.ontologySubject!;
        assert.equal(subject?.type, 'CatalogRead');
        access.session.call('query_ontology', { object: subject });
        const status = access.session.call('evaluate_ontology', { function: 'catalogReadStatus', object: subject }) as { status: string };
        assert.equal(status.status, 'known');
      }
      return { decision: proposal(ctx), evidence: evidence() };
    },
  };
}
function setup(readSource = true) {
  const f = fixture(), store = new JobStore(':memory:'), catalog = createExecutionCatalog({ store, shopifyCatalog: { merchants: [merchant], reader: f.reader } });
  const b = backend(catalog, model(readSource), store);
  return { ...f, b, store, catalog };
}

test('Shopify catalog is absent by default, identity scoped and configured equally for Gateway and Worker', () => {
  assert(!createExecutionCatalog().summaries(owner).some(c => c.ref.id === SHOPIFY_CATALOG_CAPABILITY));
  const t = setup(); try {
    assert(t.catalog.summaries(owner).some(c => c.ref.id === SHOPIFY_CATALOG_CAPABILITY));
    assert(!t.catalog.summaries('other-owner').some(c => c.ref.id === SHOPIFY_CATALOG_CAPABILITY));
    assert(!t.catalog.summaries(owner, 16, 'sandbox').some(c => c.ref.id === SHOPIFY_CATALOG_CAPABILITY));
    const env = { EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(40), EIGOS_SHOPIFY_CATALOG_MERCHANTS: JSON.stringify([merchant]), EIGOS_SHOPIFY_AUDIT_DIR: '/tmp/shopify-private-test' };
    assert.deepEqual(readConfig(env).EIGOS_SHOPIFY_CATALOG_MERCHANTS, readWorkerConfig(env).EIGOS_SHOPIFY_CATALOG_MERCHANTS);
    assert.throws(() => readWorkerConfig({ ...env, NODE_ENV: 'production' }));
    assert.throws(() => readWorkerConfig({ ...env, HOST: '0.0.0.0' }));
    assert.throws(() => readWorkerConfig({ ...env, EIGOS_SHOPIFY_CATALOG_MERCHANTS: JSON.stringify([{ ...merchant, accessToken: 'forbidden' }]) }));
    assert.throws(() => readWorkerConfig({ ...env, EIGOS_SHOPIFY_CATALOG_MERCHANTS: JSON.stringify([{ ...merchant, domain: 'evil.example' }]) }));
    assert.throws(() => readWorkerConfig({ ...env, EIGOS_SHOPIFY_CATALOG_MERCHANTS: JSON.stringify([merchant, merchant]) }));
    assert.throws(() => readWorkerConfig({ ...env, EIGOS_SHOPIFY_AUDIT_DIR: 'relative' }));
    assert.equal(t.calls.length, 0, 'constructing the Gateway catalog performs no HTTP or execution');
  } finally { t.store.close(); }
});

test('Shopify runs through ontology reads, durable read action, merchant refresh and independent acceptance', async () => {
  const t = setup(); try {
    const job = t.b.submit({ goal: '查 Coffee 咖啡豆的公开商品，保持只读', requirements: [{ id: 'no-order', kind: 'condition', strength: 'hard', expected: { predicate: 'execution.no_order' } }] });
    const done = await t.b.run();
    assert.equal(done.id, job.id); assert.equal(done.state, 'completed'); assert(done.delegation?.acceptance?.accepted);
    assert.equal(done.delegation!.plan!.completionTarget, 'artifact'); assert.equal(done.delegation!.plan!.quote, undefined);
    assert.deepEqual(done.delegation!.plan!.steps.map(s => s.effect), ['read']);
    assert.equal(done.delegation!.resolution!.scope.realSupply, false);
    const snapshot = checkedCatalogSnapshot((done.artifact!.data.result as { catalogSnapshot: unknown }).catalogSnapshot);
    assert.equal(snapshot.phase, 'verified'); assert.equal(snapshot.evidenceKind, 'fixture'); assert.equal(snapshot.receipts.length, 6);
    assert.equal(snapshot.items[0]!.displayPrice.minor, '2900'); assert.equal(snapshot.stockQuantity, 'unknown');
    assert.deepEqual(t.calls.map(c => c.operation), ['search_catalog', 'get_product', 'discovery', 'lookup_catalog', 'discovery', 'lookup_catalog']);
    assert(t.calls.every(c => !c.headers.authorization && !c.headers['Shopify-Buyer-IP']));
    const graph = t.store.ontology;
    assert.equal(graph.query(owner, { type: 'CatalogRead' }).items.length, 2);
    assert.equal(graph.evaluate(owner, { function: 'catalogReadStatus', object: { type: 'CatalogRead', id: snapshot.id } }).status, 'known');
    const offers = graph.related(owner, { type: 'CatalogRead', id: snapshot.id }, 'offers', { remaining: 1000 })!;
    assert.equal(offers.length, 1); assert.equal(offers[0]!.properties.priceKind, 'display_price'); assert.equal(offers[0]!.properties.capacity, 'unknown');
    assert.equal(graph.evaluate(owner, { function: 'withinBudget', object: offers[0]!.ref, budget: { minor: '10000', currency: 'USD' }, priceBasis: 'firm_quote' }).status, 'unknown');
    for (const type of ['Order', 'Payment', 'CheckoutSession']) assert.equal(graph.query(owner, { type }).items.length, 0);
    assert.equal(graph.query('another-owner', { type: 'CatalogRead' }).items.length, 0);
    assert(done.delegation!.ontologyReads!.some(r => r.tool === 'evaluate_ontology'));
    assert.equal(done.delegation!.actions!.length, 1); assert.equal(done.delegation!.actions![0]!.state, 'effect_confirmed');
  } finally { t.store.close(); }
});

test('Shopify cannot dispatch a plan which skipped the actual catalog ontology read', async () => {
  const t = setup(false); try {
    t.b.submit({ goal: '查公开咖啡商品' }); const done = await t.b.run();
    assert.equal(done.state, 'failed'); assert.equal(done.artifact, undefined);
    assert.equal(t.calls.filter(c => c.operation === 'lookup_catalog').length, 1);
  } finally { t.store.close(); }
});

test('Shopify detail lookup pins the searched merchant and variant when a global cluster is crowded', async () => {
  const t = setup(); try {
    t.flags.crowdedCluster = true; t.b.submit({ goal: '查公开咖啡商品' });
    const done = await t.b.run(); assert.equal(done.state, 'completed');
    const lookup = t.calls.find(c => c.operation === 'get_product')!.body.params.arguments.catalog;
    assert.deepEqual(lookup, { id: variantId, context: { address_country: 'US' }, filters: { shops: [merchant.shopId] } });
    const snapshot = checkedCatalogSnapshot((done.artifact!.data.result as { catalogSnapshot: unknown }).catalogSnapshot);
    assert.equal(snapshot.items[0]!.variantId, variantId); assert.equal(snapshot.merchant.shopId, merchant.shopId);
  } finally { t.store.close(); }
});

test('Shopify refresh detects changed prices and replans the same request instead of accepting stale observations', async () => {
  const t = setup(); try {
    t.flags.changeOnRefresh = true;
    const job = t.b.submit({ goal: '查公开咖啡商品' }); const first = await t.b.run();
    assert.equal(first.id, job.id); assert.equal(first.state, 'submitted'); assert.equal(first.delegation!.replans, 1); assert.equal(first.artifact, undefined);
    const done = await t.b.run(); assert.equal(done.id, job.id); assert.equal(done.state, 'completed');
    const result = (done.artifact!.data.result as { catalogSnapshot: CatalogSnapshot }).catalogSnapshot;
    assert.equal(result.items[0]!.displayPrice.minor, '3000');
    assert(t.calls.every(c => ['search_catalog', 'get_product', 'discovery', 'lookup_catalog'].includes(c.operation)));
  } finally { t.store.close(); }
});

test('Shopify empty results stay bounded observations rather than unavailable-stock claims', async () => {
  const t = setup(); try {
    t.flags.empty = true; t.b.submit({ goal: '查公开咖啡商品' }); const done = await t.b.run();
    assert.equal(done.state, 'completed');
    const snapshot = (done.artifact!.data.result as { catalogSnapshot: CatalogSnapshot }).catalogSnapshot;
    assert.equal(snapshot.items.length, 0); assert.equal(snapshot.completeness, 'partial_or_unknown'); assert.equal(snapshot.stockQuantity, 'unknown');
    assert.equal(t.calls.filter(c => c.operation === 'lookup_catalog').length, 0);
  } finally { t.store.close(); }
});

test('Shopify rejects cross-owner and unconfigured-merchant queries before any provider request', async () => {
  const f = fixture(), adapter = new ShopifyCatalogAdapter([merchant], { reader: f.reader });
  const request = { id: randomUUID(), revision: 1, originalGoal: 'query', requirements: [], messages: [] };
  await assert.rejects(adapter.prepare({ owner: 'other', request }, input, new AbortController().signal));
  await assert.rejects(adapter.prepare({ owner, request }, { ...input, merchantId: 'unapproved' }, new AbortController().signal));
  await assert.rejects(adapter.prepare({ owner, request }, { ...input, endpoint: 'https://evil.example' }, new AbortController().signal));
  assert.equal(f.calls.length, 0);
});

test('Shopify cancellation during preparation cannot publish late source results', async () => {
  const t = setup(); let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
  t.flags.beforeSearch = async () => { started(); await gate; };
  try {
    const job = t.b.submit({ goal: '查公开咖啡商品' }), pending = t.b.run(); await waiting;
    t.b.tasks.cancel(principal, job.id); release(); await pending;
    assert.equal(t.store.get(owner, job.id).state, 'canceled'); assert.equal(t.store.get(owner, job.id).artifact, undefined);
    assert.equal(t.store.ontology.query(owner, { type: 'CatalogRead' }).items.length, 0);
  } finally { release?.(); t.store.close(); }
});

test('Shopify cancellation during the final read preserves history and excludes a late verified projection', async () => {
  const t = setup(); let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
  t.flags.beforeRefresh = async () => { started(); await gate; };
  try {
    const job = t.b.submit({ goal: '查公开咖啡商品' }), pending = t.b.run(); await waiting;
    t.b.tasks.cancel(principal, job.id); release(); await pending;
    assert.equal(t.store.get(owner, job.id).state, 'canceled'); assert.equal(t.store.get(owner, job.id).artifact, undefined);
    const reads = t.store.ontology.query(owner, { type: 'CatalogRead' }).items;
    assert.equal(reads.length, 1); assert.equal(reads[0]!.properties.phase, 'prepared');
  } finally { release?.(); t.store.close(); }
});

test('Shopify evidence tampering invalidates ontology status without rewriting the accepted artifact', async () => {
  const t = setup(); try {
    t.b.submit({ goal: '查公开咖啡商品' }); const done = await t.b.run(), before = digest(done.artifact);
    const snapshot = (done.artifact!.data.result as { catalogSnapshot: CatalogSnapshot }).catalogSnapshot;
    const ref = { type: 'CatalogRead', id: snapshot.id }, record = t.store.ontology.read(owner, ref);
    t.store.ontology.ingest(owner, { objects: [{ ref, expectedRevision: record.revision, properties: { ...record.properties, displayTitle: 'tampered' } }] }, { kind: 'synthetic', id: 'test', observedAt: new Date().toISOString() });
    assert.equal(t.store.ontology.evaluate(owner, { function: 'catalogReadStatus', object: ref }).status, 'unknown');
    assert.equal(digest(t.store.get(owner, done.id).artifact), before);
    const changed = structuredClone(snapshot); changed.items[0]!.displayPrice.minor = '1'; assert.throws(() => checkedCatalogSnapshot(changed));
  } finally { t.store.close(); }
});
