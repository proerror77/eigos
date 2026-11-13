import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { businessTransaction } from '../packages/core/transaction.js';
import { compiledSeedModel, createPalantirModelDefinition } from '../packages/ontology/seed-definition.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { digest } from '../packages/core/delegation.js';

const seed = createPalantirModelDefinition();
const model = compiledSeedModel(seed, seed.registry);
const at = '2026-01-01T00:00:00.000Z';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const store = new OntologyObjectStore(db, model, Date.now);
  const owner = 'interface-journey-owner';
  const place = { ref: { type: 'Place', id: 'place-1' }, properties: { placeId: 'place-1', displayTitle: '上海站', name: '上海站', address: { text: '上海站', city: '上海市' }, coordinates: { lat: 31.2, lng: 121.4 }, coordinateUnit: 'degree', coordinateSystem: 'provider_unspecified' } };
  const receipt = { ref: { type: 'SourceReceipt', id: 'receipt-1' }, properties: { receiptId: 'receipt-1', displayTitle: '回执', safeSummary: '合成地点证据', sourceIdentity: 'synthetic:places', observedAt: at, evidenceLevel: 'synthetic', contentDigest: digest(place.properties) } };
  const source = { kind: 'synthetic' as const, id: 'r1', observedAt: at };
  businessTransaction(db, () => store.ingest(owner, { objects: [place, receipt], links: [{ type: 'PlaceEvidence', from: place.ref, to: receipt.ref }] }, source));
  return { db, store, owner };
}

test('an interface answers which concrete types serve it', () => {
  const concrete: string[] = model.concreteTypes('EvidenceBacked');
  assert.ok(concrete.length > 0, 'an interface with no implementers is not queryable');
  assert.ok(concrete.includes('Place'), 'Place implements EvidenceBacked');
  assert.ok(!concrete.includes('SourceReceipt'), 'a source receipt is not itself evidence-backed');
});

test('the same interface property resolves to a different column per implementer', () => {
  assert.equal(model.propertyName('Place', 'Addressable', 'id'), 'placeId');
});

test('a relationship declared once is navigable from the side that carries it', () => {
  const outward = model.navigation('Place', 'sourceReceipts');
  assert.equal(outward.link.id, 'PlaceEvidence');
  assert.equal(outward.direction, 'forward');
  assert.equal(outward.other.type, 'SourceReceipt');
  const inward = model.navigation('SourceReceipt', 'places');
  assert.equal(inward.link.id, 'PlaceEvidence', 'the other end resolves to the same link type');
  assert.equal(inward.direction, 'reverse');
});

test('query, walk and read back: an evidence edge leads to a real object', () => {
  const { db, store, owner } = fixture();
  try {
    const places = store.query(owner, { type: 'Addressable', select: ['id'] }).items;
    assert.deepEqual(places.map(item => item.properties), [{ id: 'place-1' }]);
    assert.throws(() => store.query(owner, { type: 'EvidenceBacked' }), /does not support object-set searches/);
    const receipts = store.query(owner, { from: places[0]!.ref, as: 'EvidenceBacked', link: 'sourceReceipts' }).items;
    assert.deepEqual(receipts.map(item => item.ref), [{ type: 'SourceReceipt', id: 'receipt-1' }]);
    assert.equal(receipts[0]!.properties.evidenceLevel, 'synthetic');
  } finally { db.close(); }
});

test('a definition-only evidence action does not resolve as an implemented capability', () => {
  assert.equal(model.actionBindingStatus('LinkEvidence').state, 'unbound');
  assert.throws(() => model.resolveInterfaceAction('Place', 'EvidenceBacked', 'LinkEvidence'), /not implemented/);
});
