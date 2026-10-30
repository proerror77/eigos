import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDidi } from './fixtures/didi.js';
import { participantFixture } from './fixtures/free-booking.js';
import { setupCheckout, checkoutMerchant, checkoutVariant } from './fixtures/shopify-checkout.js';
import { owner } from './backend-fixture.js';
import { sourceProof } from '../packages/ontology/object-evidence.js';
import { catalogEntityRefs } from '../packages/ontology/catalog-agent-projection.js';
import { createBusinessFactsKernelDefinition, createRollingGoKernelDefinition } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { OntologyObjectStore, type ObjectWrite } from '../packages/ontology/object-store.js';
import { checkedRideEstimate, projectRideEstimate } from '../packages/ontology/ride-estimate-projection.js';
import { digest } from '../packages/core/delegation.js';
import { randomUUID } from 'node:crypto';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import type { readRequestedFacts } from '../packages/coordinator/requested-facts.js';

test('the new fact release preserves every v23 object, action and historical model fingerprint', () => {
  const old = createRollingGoKernelDefinition(), current = createBusinessFactsKernelDefinition();
  const before = compileOntologyDocument(old.document, old.registry), after = compileOntologyDocument(current.document, current.registry);
  assert.equal(before.ref.digest, '2c39527a5973ae4b09b402f382ef192d13f1fca0f5cf3424bcd410b8c3c0a127');
  for (const type of old.document.objects) assert.equal(after.fingerprint(type.id), before.fingerprint(type.id));
  for (const action of old.document.actions) assert.deepEqual(after.action(action.id), before.action(action.id));
  assert.equal(after.navigation('ServiceRequest', 'requester').other.type, 'RequestingParty');
  assert.equal(after.navigation('RollingGoSearchObservation', 'hotels').other.type, 'HotelProperty');
});

test('repeated DiDi tasks reuse source places, provider and route while keeping queryable estimates and original evidence', async () => {
  const t = setupDidi();
  try {
    const run = async () => {
      const task = t.b.submit({ goal: '只查北京西站到西二旗地铁站的滴滴估价，不下单不付款' });
      const done = await t.finish(task.id); assert.equal(done.state, 'completed'); return done;
    };
    const first = await run(), graph = t.store.ontology;
    const places = graph.query(owner, { type: 'Place' }).items;
    assert.equal(places.length, 3, 'Identical non-target search results reuse the same source location');
    const provider = graph.query(owner, { type: 'Provider', where: [{ property: 'name', op: 'eq', value: '滴滴官方 MCP' }] }).items;
    assert.equal(provider.length, 1);
    const estimate = graph.query(owner, { type: 'RideEstimate', where: [{ property: 'estimatedAmount', op: 'lt', value: '80' }] }).items;
    assert.equal(estimate.length, 1); assert.equal(estimate[0]!.properties.currency, 'CNY');
    assert.equal(graph.evaluate(owner, { function: 'businessFactStatus', object: estimate[0]!.ref }).status, 'known');
    const session = new OntologyPlanningSession(graph, owner, first.delegation!.request, [], () => {}, () => {}, 'request', [estimate[0]!.ref], { taskContext: { purpose: 'agent', refs: [estimate[0]!.ref] } });
    const initial = session.call('read_task_context', {});
    assert(!JSON.stringify(initial).includes('"readContext":'), 'Technical source-query metadata is not a business property or model input');
    const callsBefore = t.calls.length;
    const batch = session.call('query_ontology', { facts: [
      { key: 'price', query: { object: estimate[0]!.ref, as: 'MonetaryFact', select: ['amount', 'currency', 'amountUnit'] }, evaluate: true },
      { key: 'validity', query: { object: estimate[0]!.ref, as: 'MonetaryFact', select: ['observedAt', 'expiresAt'] }, evaluate: true },
    ] }) as ReturnType<typeof readRequestedFacts>;
    assert.deepEqual(batch.reads, { requested: 2, performed: 1, reused: 1 }); assert.deepEqual(batch.needsRefresh, []);
    assert.equal(batch.facts[0]!.items[0]!.properties.amount, '73.05'); assert.equal(t.calls.length, callsBefore);
    assert.deepEqual(session.receipts().map(read => read.tool), ['read_task_context', 'query_ontology']);
    const route = graph.related(owner, estimate[0]!.ref, 'route', { remaining: 1000 })![0]!;
    assert.equal(graph.related(owner, route.ref, 'originPlace', { remaining: 1000 })![0]!.properties.name, '北京西站');
    await run();
    assert.deepEqual(graph.query(owner, { type: 'Place' }).items.map(o => [o.ref, o.revision]), places.map(o => [o.ref, o.revision]));
    assert.equal(graph.query(owner, { type: 'RideRoute' }).items.length, 1);
    assert.equal(graph.query(owner, { type: 'RideEstimate' }).items.length, 4);
    for (const ref of first.delegation!.agent!.observations) assert(sourceProof(graph, owner, ref, { remaining: 1000 }), 'Re-observation must preserve original source evidence');
    const originalRef = first.delegation!.agent!.observations.find(ref => ref.type === 'RideEstimateObservation')!;
    const original = checkedRideEstimate(graph.read(owner, originalRef).properties.snapshot);
    const { contentDigest: _oldDigest, ...next } = structuredClone(original), id = randomUUID(), observedAt = new Date().toISOString();
    if (next.data.kind !== 'estimate') throw new Error('Expected an estimate fixture');
    next.data.items[0]!.priceText = '83.05'; next.data.items[0]!.estimatedMoney = { minor: '8305', currency: 'CNY' };
    Object.assign(next, { id, observedAt, expiresAt: new Date(Date.parse(observedAt) + 300000).toISOString(), receipt: { ...next.receipt, id, startedAt: observedAt, receivedAt: observedAt, resultDigest: digest(next.data) } });
    projectRideEstimate(graph, owner, { ...next, contentDigest: digest(next) });
    assert.equal(graph.evaluate(owner, { function: 'businessFactStatus', object: estimate[0]!.ref }).status, 'unknown', 'A later price supersedes the earlier still-unexpired estimate');
    assert.throws(() => graph.read('other-owner', places[0]!.ref));
    const reused = graph.read(owner, places[0]!.ref);
    assert.throws(() => graph.ingest(owner, { objects: [{ ref: reused.ref, properties: reused.properties, expectedRevision: reused.revision + 1, reuseIfUnchanged: true }] }, reused.source), /exact source-authoritative revision/);
    const clock = graph.now;
    Object.defineProperty(graph, 'now', { value: () => clock() + 300001 });
    assert.equal(graph.evaluate(owner, { function: 'businessFactStatus', object: estimate[0]!.ref }).status, 'unknown');
  } finally { t.close(); }
});

test('participant observations link to one stable event and registration without inventing attendee identity or location', async () => {
  const t = participantFixture();
  try {
    t.submit(); const done = await t.until(job => job.state === 'completed'), graph = t.store.ontology;
    const records = graph.query(owner, { type: 'RegistrationRecord' }).items;
    const events = graph.query(owner, { type: 'Event' }).items, registrations = graph.query(owner, { type: 'EventRegistration' }).items;
    assert(records.length >= 2); assert.equal(events.length, 1); assert.equal(registrations.length, 1);
    for (const record of records) assert.deepEqual(graph.related(owner, record.ref, 'event', { remaining: 1000 })!.map(o => o.ref), [events[0]!.ref]);
    assert.equal(registrations[0]!.properties.state, 'confirmed'); assert.equal(registrations[0]!.properties.independentRead, true);
    assert.equal(graph.evaluate(owner, { function: 'businessFactStatus', object: registrations[0]!.ref }).status, 'known');
    assert.deepEqual(graph.related(owner, { type: 'ServiceRequest', id: done.id }, 'eventRegistrations', { remaining: 1000 })!.map(o => o.ref), [registrations[0]!.ref]);
    assert(!Object.hasOwn(events[0]!.properties, 'location')); assert(!Object.hasOwn(registrations[0]!.properties, 'participantRef'));
    for (const record of records) assert(sourceProof(graph, owner, record.ref, { remaining: 1000 }));
  } finally { t.store.close(); }
});

test('checkout observations reuse the catalog variant identity and retain per-observation quantities and prices', async () => {
  const t = setupCheckout();
  try {
    const task = t.submit().id; await t.finish(task); t.approve(task); const done = await t.finish(task);
    assert.equal(done.state, 'completed'); const graph = t.store.ontology;
    const variant = catalogEntityRefs({ merchant: checkoutMerchant, action: 'ReadMerchantVariants' }, checkoutVariant).variant!;
    const items = graph.query(owner, { type: 'CheckoutItem' }).items;
    assert(items.length >= 3); assert.equal(graph.query(owner, { type: 'ProductVariant' }).items.length, 1);
    const statuses: string[] = [];
    for (const item of items) {
      assert.deepEqual(graph.related(owner, item.ref, 'productVariant', { remaining: 1000 })!.map(o => o.ref), [variant]);
      assert.equal(item.properties.quantity, 1);
      statuses.push(graph.evaluate(owner, { function: 'businessFactStatus', object: item.ref }).status);
    }
    assert(statuses.includes('known')); assert(statuses.includes('unknown'), 'An independent readback supersedes the earlier checkout response');
    const before = graph.read(owner, variant);
    graph.ingest(owner, { objects: [{ ref: variant, properties: { ...before.properties, specificationRevision: 'changed-specification' }, expectedRevision: before.revision }] }, { kind: 'synthetic', id: 'changed-variant', observedAt: new Date().toISOString() });
    assert(items.every(item => graph.evaluate(owner, { function: 'businessFactStatus', object: item.ref }).status === 'unknown'));
    assert.equal(graph.query(owner, { type: 'Order' }).items.length, 0); assert.equal(graph.query(owner, { type: 'Payment' }).items.length, 0);
  } finally { t.store.close(); }
});

test('a partial checkout read preserves richer catalog facts without claiming to independently observe their fields', async t => {
  const f = setupCheckout(), graph = f.store.ontology;
  try {
    const variant = catalogEntityRefs({ merchant: checkoutMerchant, action: 'ReadMerchantVariants' }, checkoutVariant).variant!;
    const properties = { variantId: variant.id, displayTitle: 'Fixture coffee 12 oz', name: 'Fixture coffee 12 oz', sourceProductRef: { namespace: 'shopify', id: checkoutVariant },
      specification: [{ name: 'variant_id', value: checkoutVariant }, { name: 'sku', value: 'CATALOG-ONLY-SKU' }], specificationRevision: 'catalog-specification-v1' };
    graph.ingest(owner, { objects: [{ ref: variant, properties }] }, { kind: 'synthetic', id: 'catalog-fixture', observedAt: new Date(Date.now() - 1000).toISOString() });
    const writes: ObjectWrite[] = [], original = OntologyObjectStore.prototype.ingest;
    t.mock.method(OntologyObjectStore.prototype, 'ingest', function(this: OntologyObjectStore, ...args: Parameters<OntologyObjectStore['ingest']>) {
      writes.push(...args[1].objects.filter(o => o.ref.type === 'ProductVariant'));
      return original.apply(this, args);
    });
    const task = f.submit().id; await f.finish(task);
    assert(writes.length > 0);
    assert(writes.every(write => write.observedFields?.includes('variantId') && !write.observedFields.includes('specification') && !write.observedFields.includes('specificationRevision')));
    assert.deepEqual(graph.read(owner, variant).properties, properties); assert.equal(graph.read(owner, variant).revision, 1);
    assert.equal(f.countCreates(), 0);
  } finally { f.store.close(); }
});
