import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { digest } from '../packages/core/delegation.js';
import { CatalogAgentProgram } from '../packages/capabilities/catalog-agent.js';
import { SHOPIFY_CATALOG_ORIGIN, shopifyMerchantOrigin } from '../packages/capabilities/shopify/read-only.js';
import { catalogEntityRefs, checkedAgentCatalogObservation, projectAgentCatalogObservation } from '../packages/ontology/catalog-agent-projection.js';
import { catalogObservationSchema, type CatalogObservation } from '../packages/ontology/catalog-agent.js';
import { sourceProof } from '../packages/ontology/object-evidence.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import { setup, merchant, ids, productId } from './fixtures/catalog-agent.js';
import { owner } from './backend-fixture.js';

function context() {
  const f = setup(), graph = f.store.ontology, start = Date.now() - 60000;
  let sequence = 0;
  const task = (seller = merchant) => {
    const job = f.b.submit({ goal: 'Compare public coffee catalog observations' }), program = new CatalogAgentProgram([seller], { connector: f.connector });
    const initialized = program.initialize(graph, owner, job.delegation!.request, { merchantIds: [seller.id], country: 'US' });
    return { job, program, ...initialized, merchant: seller };
  };
  const observe = (scope: ReturnType<typeof task>, options: { title?: string; sku?: string; price?: string | null; action?: 'SearchPublicCatalog' | 'ReadMerchantVariants'; startedAt?: number; observedAt?: number } = {}) => {
    const action = options.action ?? 'SearchPublicCatalog', started = options.startedAt ?? start + ++sequence * 1000, observed = options.observedAt ?? started + 100;
    const id = randomUUID(), actionInput = action === 'SearchPublicCatalog'
      ? { scope: scope.scope, merchantId: scope.merchant.id, query: 'coffee', limit: 10 }
      : { scope: scope.scope, merchantId: scope.merchant.id, endpoint: { type: 'CatalogEndpoint', id: 'synthetic-endpoint-reference' }, variantIds: [ids[0]!] };
    const items = [{ productId, variantId: ids[0]!, title: options.title ?? 'Coffee — Whole Bean', sku: options.sku ?? 'BEAN-1',
      ...(options.price === null ? {} : { displayPrice: { minor: options.price ?? '1250', currency: 'USD' } }) }];
    const body = { id, requestId: scope.job.id, requestRevision: 1, configurationDigest: scope.program.configurationDigest,
      action, actionInput, scope: scope.scope, planId: randomUUID(), intentId: randomUUID(), attemptId: randomUUID(), modelRunId: randomUUID(),
      merchant: scope.merchant, country: 'US', evidenceKind: 'fixture',
      receipt: { id, endpoint: `${action === 'ReadMerchantVariants' ? shopifyMerchantOrigin(scope.merchant.domain) : SHOPIFY_CATALOG_ORIGIN}/api/ucp/mcp`,
        operation: action === 'ReadMerchantVariants' ? 'lookup_catalog' : 'search_catalog', startedAt: new Date(started).toISOString(), receivedAt: new Date(observed).toISOString(),
        httpStatus: 200, authentication: 'anonymous', inputSha256: digest(actionInput), responseSha256: digest(items), responseBytes: 1000 },
      observedAt: new Date(observed).toISOString(), expiresAt: new Date(started + 300000).toISOString(), validityBasis: 'local_refresh_limit',
      items, completeness: 'partial_or_unknown', stockQuantity: 'unknown', deliveryCommitment: 'unknown', partnerTrust: 'unverified', noBusinessWrites: true };
    return checkedAgentCatalogObservation(catalogObservationSchema.parse({ ...body, contentDigest: digest(body) }));
  };
  const project = (snapshot: CatalogObservation) => f.store.transaction(() => projectAgentCatalogObservation(graph, owner, snapshot));
  const related = (from: ObjectRef, link: string) => graph.related(owner, from, link, { remaining: 1000 }) ?? [];
  return { ...f, graph, task, observe, project, related, start };
}

test('catalog merchant and variant identities survive repeated observations and different tasks; offers remain immutable observations', () => {
  const f = context();
  try {
    const firstTask = f.task(), first = f.observe(firstTask), firstRef = f.project(first);
    const refs = catalogEntityRefs(first, ids[0]!), variant = f.graph.read(owner, refs.variant!), provider = f.graph.read(owner, refs.provider), channel = f.graph.read(owner, refs.channel);
    const offer = f.related(firstRef, 'offers')[0]!, oldSnapshot = f.graph.read(owner, firstRef);
    const secondTask = f.task(), second = f.observe(secondTask, { price: '1500' }), secondRef = f.project(second);
    assert.deepEqual(catalogEntityRefs(second, ids[0]!), refs);
    assert.deepEqual(f.graph.read(owner, refs.variant!), variant, 'Price refresh does not rewrite the product specification');
    assert.deepEqual(f.graph.read(owner, refs.provider), provider); assert.deepEqual(f.graph.read(owner, refs.channel), channel);
    assert.deepEqual(f.related(firstRef, 'variants').map(v => v.ref), [refs.variant]);
    assert.deepEqual(f.related(refs.variant!, 'currentCatalogObservation').map(o => o.ref), [secondRef]);
    assert.equal(f.graph.query(owner, { type: 'Provider' }).items.length, 1);
    assert.equal(f.graph.query(owner, { type: 'Channel' }).items.length, 1);
    assert.equal(f.graph.query(owner, { type: 'ProductVariant' }).items.length, 1);
    assert.equal(f.graph.query(owner, { type: 'ProductOffer' }).items.length, 2);
    assert.equal(f.related(secondRef, 'offers')[0]!.properties.variantRevision, variant.revision);
    assert.deepEqual(f.graph.read(owner, firstRef), oldSnapshot); assert.deepEqual(f.graph.read(owner, offer.ref), offer);
    assert(sourceProof(f.graph, owner, firstRef, { remaining: 1000 })); assert(sourceProof(f.graph, owner, offer.ref, { remaining: 1000 }));
    assert.equal(f.graph.evaluate(owner, { function: 'catalogObservationStatus', object: firstRef }).status, 'known', 'Historical observation is still truthful inside its validity window');
    assert.throws(() => f.project(first), /immutable/);
    assert.equal(f.calls.length, 0, 'Projection tests never invoke even the fixture connector');
  } finally { f.store.close(); }
});

test('changed catalog specification advances the stable variant revision and old offers no longer apply to current specification', () => {
  const f = context();
  try {
    const task = f.task(), initial = f.observe(task), initialRef = f.project(initial), refs = catalogEntityRefs(initial, ids[0]!);
    const original = f.graph.read(owner, refs.variant!), oldOffer = f.related(initialRef, 'offers')[0]!;
    const changed = f.observe(task, { title: 'Coffee — Ground', sku: 'GROUND-1' }), changedRef = f.project(changed);
    assert.equal(f.graph.read(owner, refs.variant!).revision, original.revision + 1);
    assert.equal(f.related(changedRef, 'offers')[0]!.properties.variantRevision, original.revision + 1);
    assert.equal(f.graph.read(owner, oldOffer.ref).properties.variantRevision, original.revision);
    assert(sourceProof(f.graph, owner, oldOffer.ref, { remaining: 1000 }));
    const applicable = f.graph.evaluate(owner, { function: 'productOfferMatches', object: oldOffer.ref, variant: refs.variant!,
      quantity: { amount: '1', unit: 'piece' }, budget: { minor: '99999', currency: 'USD' }, deadline: new Date(Date.now() + 86400000).toISOString(), destination: { text: 'Synthetic destination' } });
    assert.equal(applicable.status, 'unknown'); assert.match(applicable.reason!, /specification revision is not current/);
    assert.deepEqual(f.related(refs.variant!, 'currentCatalogObservation').map(o => o.ref), [changedRef]);
    assert.equal(f.calls.length, 0);
  } finally { f.store.close(); }
});

test('same-content observations advance provenance without entity revision, and an older conflicting read cannot displace that evidence', () => {
  const f = context();
  try {
    const task = f.task(), original = f.observe(task, { startedAt: f.start + 1000, observedAt: f.start + 1100 }), originalRef = f.project(original);
    const variantRef = catalogEntityRefs(original, ids[0]!).variant!, entity = f.graph.read(owner, variantRef);
    const fresh = f.observe(task, { startedAt: f.start + 5000, observedAt: f.start + 5100 }), freshRef = f.project(fresh);
    assert.deepEqual(f.graph.read(owner, variantRef), entity);
    assert.deepEqual(f.related(variantRef, 'currentCatalogObservation').map(o => o.ref), [freshRef]);
    const older = f.observe(task, { title: 'Old conflicting title', startedAt: f.start + 3000, observedAt: f.start + 6000 });
    assert.throws(() => f.project(older), /older or overlapping/);
    assert.equal(f.graph.query(owner, { type: 'CatalogObservation' }).items.length, 2);
    assert.deepEqual(f.graph.read(owner, variantRef), entity);
    assert.deepEqual(f.related(variantRef, 'currentCatalogObservation').map(o => o.ref), [freshRef]);
    const olderSame = f.observe(task, { startedAt: f.start + 2000, observedAt: f.start + 7000 });
    f.project(olderSame);
    assert.deepEqual(f.related(variantRef, 'currentCatalogObservation').map(o => o.ref), [freshRef], 'A late identical read is historical, not current provenance');
    assert(sourceProof(f.graph, owner, originalRef, { remaining: 1000 }));
  } finally { f.store.close(); }
});

test('different trusted merchants never merge by product name or reused native variant ID, and channels identify the actual source endpoint', () => {
  const f = context();
  try {
    const first = f.observe(f.task()), firstRef = f.project(first);
    const otherMerchant = { id: 'other', name: merchant.name, shopId: 'gid://shopify/Shop/99', domain: 'other.myshopify.com' };
    const other = f.observe(f.task(otherMerchant)), otherRef = f.project(other);
    const firstIds = catalogEntityRefs(first, ids[0]!), otherIds = catalogEntityRefs(other, ids[0]!);
    assert.notDeepEqual(firstIds.provider, otherIds.provider); assert.notDeepEqual(firstIds.variant, otherIds.variant);
    assert.deepEqual(firstIds.channel, otherIds.channel, 'Both observations use the same public global catalog channel');
    const native = f.observe(f.task(), { action: 'ReadMerchantVariants' }), nativeRef = f.project(native), nativeIds = catalogEntityRefs(native, ids[0]!);
    assert.deepEqual(nativeIds.provider, firstIds.provider); assert.deepEqual(nativeIds.variant, firstIds.variant); assert.notDeepEqual(nativeIds.channel, firstIds.channel);
    assert.equal(f.graph.query(owner, { type: 'Provider' }).items.length, 2); assert.equal(f.graph.query(owner, { type: 'ProductVariant' }).items.length, 2);
    assert.equal(f.graph.query(owner, { type: 'Channel' }).items.length, 2);
    for (const ref of [firstRef, otherRef, nativeRef]) assert(sourceProof(f.graph, owner, ref, { remaining: 1000 }));
    assert.throws(() => f.graph.read('another-owner', firstIds.variant!));
  } finally { f.store.close(); }
});

test('an unpriced product is still a real variant linked to its observation, without an invented offer', () => {
  const f = context();
  try {
    const snapshot = f.observe(f.task(), { price: null }), ref = f.project(snapshot), variant = catalogEntityRefs(snapshot, ids[0]!).variant!;
    assert.deepEqual(f.related(ref, 'variants').map(v => v.ref), [variant]);
    assert.equal(f.related(ref, 'offers').length, 0); assert.equal(f.graph.query(owner, { type: 'ProductOffer' }).items.length, 0);
    assert.equal(f.graph.read(owner, variant).revision, 1);
    assert.equal(f.graph.evaluate(owner, { function: 'catalogObservationStatus', object: ref }).status, 'known');
  } finally { f.store.close(); }
});

test('future or expired catalog responses cannot update stable business entities', () => {
  const f = context();
  try {
    const task = f.task(), first = f.observe(task), firstRef = f.project(first), refs = catalogEntityRefs(first, ids[0]!);
    const current = f.graph.read(owner, refs.variant!);
    for (const startedAt of [Date.now() + 1000, Date.now() - 400000]) {
      const invalid = f.observe(task, { title: 'Unusable source update', startedAt, observedAt: startedAt + 100 });
      assert.throws(() => f.project(invalid), /current catalog response/);
    }
    assert.deepEqual(f.graph.read(owner, refs.variant!), current);
    assert.deepEqual(f.related(refs.variant!, 'currentCatalogObservation').map(o => o.ref), [firstRef]);
    assert.equal(f.graph.query(owner, { type: 'CatalogObservation' }).items.length, 1);
  } finally { f.store.close(); }
});
