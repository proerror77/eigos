import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { businessModel, BUSINESS_MODEL_DEFINITION, businessConditionSchema } from '../packages/ontology/business-model.js';
import { OntologyModel } from '../packages/ontology/model.js';
import { OntologyObjectStore, type ObjectWrite } from '../packages/ontology/object-store.js';
import { syntheticOntology } from './fixtures/ontology-objects.js';

function definition() {
  const d = BUSINESS_MODEL_DEFINITION;
  return { ...d, objects: d.objects.map(o => ({ ...o, properties: { ...o.properties }, interfaces: structuredClone(o.interfaces) })), interfaces: d.interfaces.map(i => ({ ...i, parents: [...(i.parents ?? [])], properties: { ...i.properties }, links: structuredClone(i.links) })), links: structuredClone(d.links), actions: structuredClone(d.actions) };
}
function fixture() {
  const data = syntheticOntology(), db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, businessModel, () => data.now);
  graph.ingest('alice', data.batch, data.source);
  return { ...data, db, graph };
}

test('Ontology compiles core, service, checkout and catalog types, inherited interfaces and bounded metadata', () => {
  assert.equal(BUSINESS_MODEL_DEFINITION.objects.length, 100);
  assert(businessModel.hasType('MeituanReadTask'));
  assert(businessModel.implements('MeituanReadObservation', 'EvidenceBacked'));
  assert.deepEqual(businessModel.concreteTypes('Offer'), ['DeliveryQuote', 'ProductOffer', 'ReservationOffer']);
  assert(businessModel.implements('DeliveryQuote', 'EvidenceBacked'));
  assert.equal(businessModel.propertyName('DeliveryQuote', 'Offer', 'offerId'), 'quoteId');
  const all: string[] = []; let after: string | undefined;
  do {
    const page = businessModel.describe({ limit: 2, ...(after ? { after } : {}) });
    assert(page.types.length <= 2); assert(page.actions.every(a => a.execution === 'definition_only'));
    all.push(...page.types.map(t => (t as { id: string }).id)); after = page.next;
  } while (after);
  assert.equal(new Set(all).size, BUSINESS_MODEL_DEFINITION.objects.length + BUSINESS_MODEL_DEFINITION.interfaces.length);
  assert(businessModel.implements('StripePaymentObservation', 'EvidenceBacked'));
  assert.equal(businessModel.action('PayStripePayment').operation?.effect, 'payment');
  assert(businessModel.implements('CatalogRead', 'EvidenceBacked'));
  assert(businessModel.implements('CatalogObservation', 'EvidenceBacked'));
  assert(businessModel.implements('CatalogEndpoint', 'EvidenceBacked'));
  assert(businessModel.implements('LandedCostQuote', 'CommerceFact'));
  assert(businessModel.implements('DeliveryPromise', 'EvidenceBacked'));
  assert.equal(businessModel.action('SubmitCommerceOrder').operation?.environment, 'sandbox');
  assert((businessModel.describe({ search: '报价' }).types as { id: string }[]).length > 0);
  const metadata = businessModel.describeType('DeliveryQuote') as { interfaces: { id: string }[] };
  metadata.interfaces[0]!.id = 'tampered';
  assert(businessModel.implements('DeliveryQuote', 'Offer'));
});

test('N1 rejects ambiguous, cyclic, unresolved and incompatible model contracts', () => {
  let d = definition(); d.objects.push(d.objects[0]!); assert.throws(() => new OntologyModel(d), /Duplicate/);
  d = definition(); d.interfaces[0]!.parents = ['Offer']; assert.throws(() => new OntologyModel(d), /cyclic/);
  d = definition(); d.links[0]!.to.type = 'Missing'; assert.throws(() => new OntologyModel(d), /Unresolved/);
  d = definition(); d.objects.find(o => o.id === 'DeliveryQuote')!.properties.observedAt = { ...d.objects.find(o => o.id === 'DeliveryQuote')!.properties.observedAt!, schema: z.number() }; assert.throws(() => new OntologyModel(d), /Incompatible/);
  d = definition(); d.links.push({ ...d.links[0]!, id: 'DuplicateNavigation' }); assert.throws(() => new OntologyModel(d), /Ambiguous/);
  d = definition(); d.objects[0]!.titleKey = 'missing'; assert.throws(() => new OntologyModel(d), /Keys/);
  d = definition(); d.links = d.links.filter(l => l.id !== 'DeliveryQuoteEvidence'); assert.throws(() => new OntologyModel(d), /interface link/);
  d = definition(); d.actions[0]!.changes = ['Payment.imaginaryProperty']; assert.throws(() => new OntologyModel(d), /change path/);
  d = definition(); d.actions[0]!.changes = ['OrderLine.remainingQuantity']; assert.throws(() => new OntologyModel(d), /derived/);
  d = definition(); d.functions = []; assert.throws(() => new OntologyModel(d), /derived function/);
});

test('N1 persists objects and both directions of links with concrete interface identities', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-n1-')), path = join(directory, 'objects.sqlite'), data = syntheticOntology();
  let db = new DatabaseSync(path);
  try {
    let graph = new OntologyObjectStore(db, businessModel, () => data.now); graph.ingest('alice', data.batch, data.source);
    const first = graph.query('alice', { type: 'Offer', select: ['offerId', 'priceKind'], limit: 2 });
    assert.equal(first.items[0]!.properties.offerId, 'quote-D'); assert(first.page.hasMore && first.page.cursor);
    const next = graph.query('alice', { type: 'Offer', select: ['offerId', 'priceKind'], limit: 2, cursor: first.page.cursor });
    assert.equal(next.items.length, 1); assert.equal(next.page.hasMore, false);
    assert.equal(graph.query('alice', { from: data.ids.line!, link: 'order' }).items[0]!.ref.id, 'order');
    assert.equal(graph.query('alice', { from: data.ids.order!, link: 'lines' }).items[0]!.ref.id, 'line');
    const before = graph.read('alice', data.ids.reservation!);
    db.close(); db = new DatabaseSync(path); graph = new OntologyObjectStore(db, businessModel, () => data.now);
    assert.deepEqual(graph.read('alice', data.ids.reservation!), before);
    assert.equal(graph.query('alice', { from: data.ids['receipt-quote-D']!, link: 'deliveryQuotes' }).items[0]!.ref.id, 'quote-D');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('N1 owner isolation applies to search, traversal, functions and attempted link imports', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.graph.query('bob', { type: 'Offer' }).items, []);
    assert.throws(() => f.graph.query('bob', { from: f.ids.D!, link: 'offers' }), /not found/);
    assert.throws(() => f.graph.evaluate('bob', { function: 'remainingQuantity', object: f.ids.line }), /not found/);
    assert.throws(() => f.graph.ingest('bob', { objects: [{ ref: { type: 'ServiceEngagement', id: 'private-link' }, properties: { engagementId: 'private-link', displayTitle: 'Test' } }], links: [{ type: 'EngagementProvider', from: { type: 'ServiceEngagement', id: 'private-link' }, to: f.ids.provider! }] }, f.source), /not found/);
    assert.deepEqual(f.graph.query('bob', { type: 'ServiceEngagement' }).items, []);
    const page = f.graph.query('alice', { type: 'Offer', limit: 1 });
    assert.throws(() => f.graph.query('bob', { type: 'Offer', limit: 1, cursor: page.page.cursor }), /context changed/);
  } finally { f.db.close(); }
});

test('N1 private fields cannot be read, selected, filtered or used as an existence oracle', () => {
  const f = fixture();
  try {
    const views = f.graph.query('alice', { type: 'SavedAddress' });
    assert(!JSON.stringify(views).includes('PRIVATE_'));
    assert(!JSON.stringify(f.graph.read('alice', f.ids['address-A']!)).includes('PRIVATE_'));
    for (const property of ['sourceReference', 'contactInstructions']) {
      assert.throws(() => f.graph.query('alice', { type: 'SavedAddress', select: [property] }), /Restricted/);
      assert.throws(() => f.graph.query('alice', { type: 'SavedAddress', where: [{ property, op: 'eq', value: 'PRIVATE_CONTACT_MARKER' }] }), /Restricted/);
    }
    assert(!JSON.stringify(f.graph.query('alice', { type: 'SourceReceipt' })).includes('PRIVATE_RECEIPT'));
    assert(!JSON.stringify(f.graph.query('alice', { object: f.ids['address-A']! })).includes('PRIVATE_'));
    assert.throws(() => f.graph.query('alice', { object: f.ids['address-A']!, select: ['contactInstructions'] }), /Restricted/);
    assert.throws(() => f.graph.query('bob', { object: f.ids['address-A']! }), /not found/);
    assert.deepEqual(f.graph.query('alice', { type: 'Provider', where: [{ property: 'name', op: 'eq', value: "x' OR 1=1 --" }] }).items, []);
    assert.throws(() => f.graph.query('alice', { type: 'Provider', where: [{ property: '__proto__', op: 'eq', value: 'x' }] }));
    assert.throws(() => f.graph.query('alice', { type: 'Provider', where: [{ property: 'toString', op: 'eq', value: 'x' }] }), /registered property/);
  } finally { f.db.close(); }
});

test('N1 atomic imports enforce schemas, immutable keys, derived properties and relationship cardinality', () => {
  const f = fixture();
  try {
    const revision = f.graph.revision('alice');
    const invalid = [
      { ref: { type: 'Offer', id: 'x' }, properties: { offerId: 'x' } },
      { ref: { type: 'Parcel', id: 'x' }, properties: { parcelId: 'other', displayTitle: 'x' } },
      { ref: { type: 'Parcel', id: 'x' }, properties: { parcelId: 'x', displayTitle: 'x', declaredWeight: { amount: '1.5', unit: 'cup' } } },
      { ref: { type: 'OrderLine', id: 'x' }, properties: { orderLineId: 'x', displayTitle: 'x', remainingQuantity: { amount: '0', unit: 'cup' } } },
      { ref: { type: 'Parcel', id: 'x' }, properties: { parcelId: 'x', displayTitle: 'x', arbitrary: true } },
    ];
    for (const object of invalid) assert.throws(() => f.graph.ingest('alice', { objects: [object] }, f.source));
    assert.throws(() => f.graph.ingest('alice', { objects: [{ ref: { type: 'DeliveryRoute', id: 'route-2' }, properties: { routeId: 'route-2', displayTitle: 'x' } }], links: [{ type: 'SelectedRoute', from: f.ids.D!, to: { type: 'DeliveryRoute', id: 'route-2' } }] }, f.source), /cardinality/);
    assert.throws(() => f.graph.read('alice', { type: 'DeliveryRoute', id: 'route-2' }), /not found/);
    assert.throws(() => f.graph.ingest('alice', { objects: [], links: [{ type: 'QuoteRoute', from: f.ids['quote-D']!, to: f.ids.parcel! }] }, f.source), /endpoint/);
    assert.throws(() => f.graph.ingest('alice', { objects: [], removeLinks: [{ type: 'QuoteRoute', from: f.ids['quote-D']!, to: f.ids.route! }] }, f.source), /cardinality/);
    assert.throws(() => f.graph.ingest('alice', { objects: [], links: [{ type: 'PaymentOrder', from: f.ids.payment!, to: f.ids.order! }] }, f.source), /exactly one/);
    assert.equal(f.graph.revision('alice'), revision);
  } finally { f.db.close(); }
});

test('N1 version checks reject stale updates and changed definitions without legacy reinterpretation', () => {
  const f = fixture();
  try {
    const before = f.graph.read('alice', f.ids.parcel!);
    f.graph.ingest('alice', { objects: [{ ref: before.ref, properties: { ...before.properties, declaredContents: 'new synthetic contents' }, expectedRevision: before.revision }] }, f.source);
    assert.throws(() => f.graph.ingest('alice', { objects: [{ ref: before.ref, properties: before.properties, expectedRevision: before.revision }] }, f.source), /revision/);
    const page = f.graph.query('alice', { type: 'Offer', limit: 1 });
    f.graph.ingest('alice', { objects: [{ ref: { type: 'Provider', id: 'new' }, properties: { providerId: 'new', displayTitle: 'new', name: 'new' } }] }, f.source);
    assert.throws(() => f.graph.query('alice', { type: 'Offer', limit: 1, cursor: page.page.cursor }), /context changed/);
    const d = definition(); d.objects.find(o => o.id === 'Parcel')!.version = '2';
    assert.throws(() => new OntologyObjectStore(f.db, new OntologyModel(d)).read('alice', f.ids.parcel!), /definition changed/);
  } finally { f.db.close(); }
});

test('N1 pagination bounds scanned rows, preserves empty-page continuation and caps response bytes', () => {
  const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db), source = syntheticOntology().source;
  try {
    for (let offset = 0; offset < 450; offset += 150) {
      const objects = Array.from({ length: 150 }, (_, n): ObjectWrite => { const id = String(offset + n).padStart(4, '0'); return { ref: { type: 'Provider', id }, properties: { providerId: id, displayTitle: id, name: id === '0449' ? 'target' : 'other' } }; });
      graph.ingest('alice', { objects }, source);
    }
    const query = { type: 'Provider', where: [{ property: 'name', op: 'eq' as const, value: 'target' }], limit: 1 };
    const first = graph.query('alice', query); assert.equal(first.items.length, 0); assert.equal(first.page.scanned, 200); assert(first.page.cursor);
    const second = graph.query('alice', { ...query, cursor: first.page.cursor }); assert.equal(second.items.length, 0); assert(second.page.cursor);
    const third = graph.query('alice', { ...query, cursor: second.page.cursor }); assert.equal(third.items[0]!.ref.id, '0449'); assert.equal(third.page.hasMore, false);
    assert.throws(() => graph.query('alice', { type: 'Provider', limit: 51 }));
    assert.throws(() => graph.query('alice', { type: 'Provider', cursor: 'bad' }), /cursor/);
    assert.throws(() => graph.query('alice', { type: 'Provider', limit: 1, cursor: first.page.cursor }), /context changed/);
    for (let i = 0; i < 3; i++) graph.ingest('alice', { objects: [{ ref: { type: 'ServiceRequest', id: String(i) }, properties: { requestId: String(i), displayTitle: 'long fixture', originalGoal: '测'.repeat(9000) } }] }, source);
    const large = graph.query('alice', { type: 'ServiceRequest', limit: 50 });
    assert(Buffer.byteLength(JSON.stringify(large)) < 64000); assert(large.page.hasMore && large.page.cursor);
    const rest = graph.query('alice', { type: 'ServiceRequest', limit: 50, cursor: large.page.cursor });
    assert.equal(large.items.length + rest.items.length, 3);
  } finally { db.close(); }
});

test('N1 typed conditions bind semantic roles, phases, units, rule versions and owned references', () => {
  const data = syntheticOntology();
  const condition = (data.batch.objects.find(o => o.ref.id === 'D')!.properties.conditions as object[])[0]!;
  assert(businessConditionSchema.safeParse(condition).success);
  for (const override of [
    { phase: 'precondition' }, { operator: 'lte' },
    { subject: { type: 'Place', role: 'search_area' } },
    { predicateRef: { id: 'parcel.quote_matches_request', version: 'unknown' } },
    { expected: { weight: { amount: '1', unit: 'cup' }, serviceLevel: 'ordinary', parcel: data.ids.parcel, route: data.ids.route } },
    { source: { messageId: '', quote: '' } },
  ]) assert.equal(businessConditionSchema.safeParse({ ...condition, ...override }).success, false);
  const f = fixture();
  try {
    const request = f.graph.read('alice', f.ids.D!);
    const invalid = { ...condition, subject: { type: 'DeliveryQuote', role: 'parcel_quote', object: { type: 'DeliveryQuote', id: 'foreign' } } };
    assert.throws(() => f.graph.ingest('alice', { objects: [{ ref: request.ref, properties: { ...request.properties, conditions: [invalid] }, expectedRevision: request.revision }] }, f.source), /not found/);
    assert.deepEqual(f.graph.read('alice', request.ref), request);
  } finally { f.db.close(); }
});
