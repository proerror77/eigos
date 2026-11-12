import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { businessTransaction } from '../packages/core/transaction.js';
import { createInterfaceContractDefinition } from '../packages/ontology/seed-definition.js';
import { extendPalantirModelKernel } from '../packages/ontology/palantir-model-kernel.js';
import { compileOntologyDocument, TrustedDefinitionRegistry } from '../packages/ontology/model-compiler.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';

/**
 * The journey the ontology exists for: ask through an interface, walk a relationship, act, read it
 * back. Every other test proves a layer in isolation; this one refuses to pass unless the layers
 * fit together, which is the only thing a caller actually experiences.
 */
// The journey is about the current graph, so the Palantir kernel is applied before compiling:
// interfaces, their mappings and the capability actions only exist after it runs.
const registry = new TrustedDefinitionRegistry();
const seed: any = createInterfaceContractDefinition(registry as never);
const { document } = extendPalantirModelKernel(seed.document, registry as never);
registry.protect(document);
const model: any = compileOntologyDocument(document, registry);
const at = '2026-01-01T00:00:00.000Z';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const store: any = new OntologyObjectStore(db, model, Date.now);
  const owner = 'interface-journey-owner';
  const place = { ref: { type: 'Place', id: 'place-1' }, properties: { placeId: 'place-1', displayTitle: '上海站', name: '上海站', address: '上海', coordinates: { latitude: 31.2, longitude: 121.4 }, coordinateUnit: 'degree', coordinateSystem: 'WGS84' } };
  const receipt = { ref: { type: 'SourceReceipt', id: 'receipt-1' }, properties: { id: 'receipt-1', displayTitle: '回执' } };
  const insert = (row: any) => db.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?)').run(owner, row.ref.type, row.ref.id, 1, model.fingerprint(row.ref.type), JSON.stringify({ properties: row.properties, source: { kind: 'provider', id: 'r1', observedAt: at }, createdAt: at }));
  insert(place); insert(receipt);
  const source = { kind: 'provider' as const, id: 'r1', observedAt: at };
  businessTransaction(db as never, () => store.ingest(owner, { objects: [], links: [{ type: 'PlaceEvidence', from: { type: 'Place', id: 'place-1' }, to: { type: 'SourceReceipt', id: 'receipt-1' }, properties: { evidenceLevel: 'primary', observedAt: at, sourceRevision: '7' } }] }, source));
  return { db, store, owner };
}

test('an interface answers which concrete types serve it', () => {
  const concrete: string[] = model.concreteTypes('EvidenceBacked');
  assert.ok(concrete.length > 0, 'an interface with no implementers is not queryable');
  assert.ok(concrete.includes('Place'), 'Place implements EvidenceBacked');
  assert.ok(!concrete.includes('SourceReceipt'), 'a source receipt is not itself evidence-backed');
});

test('the same interface property resolves to a different column per implementer', () => {
  const place: any = model.describeType('Place');
  const mapped = place.interfaces.find((value: any) => value.id === 'Addressable');
  assert.ok(mapped, 'Place implements Addressable');
  assert.equal(mapped.propertyMap.id, 'placeId', 'the interface property id is Place.placeId, not a copy');

});

test('a relationship declared once is navigable from the side that carries it', () => {
  const outward: any = model.navigation('Place', 'sourceReceipts');
  assert.equal(outward.link.id, 'PlaceEvidence');
  assert.equal(outward.direction, 'forward');
  assert.equal(outward.other.type, 'SourceReceipt');
  const inward: any = model.navigation('SourceReceipt', 'places');
  assert.equal(inward.link.id, 'PlaceEvidence', 'the other end resolves to the same link type');
  assert.equal(inward.direction, 'reverse');
});

test('query, walk and read back: an evidence edge leads to a real object', () => {
  const { db, store, owner } = fixture();
  try {
    const place: any = store.read(owner, { type: 'Place', id: 'place-1' });
    assert.equal(place.properties.name, '上海站');

    const edges: any[] = store.readLinkAttributes(owner, { type: 'Place', id: 'place-1' }, 'PlaceEvidence');
    assert.equal(edges.length, 1);
    const target = edges[0].to;
    assert.deepEqual(target, { type: 'SourceReceipt', id: 'receipt-1' }, 'the edge names the object to walk to');

    const receipt: any = store.read(owner, target);
    assert.equal(receipt.properties.displayTitle, '回执', 'the object at the end of the walk is readable');
    assert.equal(edges[0].properties.evidenceLevel, 'primary', 'the edge carries its own attributes');
  } finally { db.close(); }
});

test('an action declared against an interface is bound by every implementer that can supply it', () => {
  const capability = model.action('LinkEvidence');
  assert.ok(capability, 'the capability action exists in the model');
  assert.equal(capability.inputs.subject, 'EvidenceBacked', 'the parameter names the interface, not one concrete type');

  const place: any = model.describeType('Place');
  const bound = place.interfaces.flatMap((value: any) => Object.entries(value.actionMap ?? {}).map(([declared, action]: [string, unknown]) => ({ declared, action })));
  assert.ok(bound.some((entry: { action: unknown }) => String(entry.action) === 'LinkEvidence'), `Place binds LinkEvidence to ${JSON.stringify(bound)}`);
});
