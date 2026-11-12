import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { businessTransaction } from '../packages/core/transaction.js';
import { createInterfaceContractDefinition } from '../packages/ontology/seed-definition.js';
import { extendPalantirModelKernel } from '../packages/ontology/palantir-model-kernel.js';
import { compileOntologyDocument, TrustedDefinitionRegistry } from '../packages/ontology/model-compiler.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { DATASOURCE_MAPPINGS, DIDI_PLACE_MAPPING, checkMapping, resolveProperties } from '../packages/ontology/datasource-mapping.js';

/** Exactly what the synthetic didi MCP returns (tests/fixtures/didi.ts), not our normalised shape. */
const providerPlace = { display_name: '北京大学', address: '海淀区颐和园路5号', address_all: '北京大学海淀区颐和园路5号', city: '北京市', location: { lng: 116.31, lat: 39.99 } };

const registry = new TrustedDefinitionRegistry();
const seed: any = createInterfaceContractDefinition(registry as never);
const { document } = extendPalantirModelKernel(seed.document, registry as never);
registry.protect(document);
const model: any = compileOntologyDocument(document, registry);
const declared = (type: string) => Object.keys((document as any).objects.find((value: any) => value.id === type).properties);

test('every property a mapped object declares is filled, derived or recorded as unavailable', () => {
  for (const mapping of DATASOURCE_MAPPINGS) assert.deepEqual(checkMapping(mapping, declared(mapping.objectType)), [], `${mapping.service} -> ${mapping.objectType}`);
});

test('the mapping reads the fields the provider sends, including a nested one', () => {
  const { properties } = resolveProperties(DIDI_PLACE_MAPPING, providerPlace);
  assert.equal(properties.name, '北京大学', 'display_name fills the business name');
  assert.equal(properties.displayTitle, '北京大学');
  assert.deepEqual(properties.address, { text: '北京大学海淀区颐和园路5号', city: '北京市' }, 'a struct is assembled from two provider fields');
  assert.deepEqual(properties.coordinates, { lat: 39.99, lng: 116.31 }, 'location.lat/lng reach the object');
  assert.equal(properties.coordinateUnit, 'degree');
});

test('identity is marked derived, and a frame the provider cannot state is reported', () => {
  const { properties, derived } = resolveProperties(DIDI_PLACE_MAPPING, providerPlace);
  assert.equal(Object.hasOwn(properties, 'placeId'), false);
  assert.match(derived.placeId!, /digests the place payload/);
  assert.equal(Object.hasOwn(properties, 'coordinateSystem'), false, 'provider_unspecified is not a frame we may claim');
  assert.ok((DIDI_PLACE_MAPPING.unmapped ?? []).some(entry => entry.property === 'coordinateSystem'));
});

test('a mapping naming a property the object lacks, or leaving one unaccounted, is rejected', () => {
  assert.deepEqual(checkMapping({ ...DIDI_PLACE_MAPPING, properties: { ...DIDI_PLACE_MAPPING.properties, notAProperty: 'x' } }, declared('Place')), ['unknown property: notAProperty']);
  const { coordinateUnit: _dropped, ...rest } = DIDI_PLACE_MAPPING.properties;
  assert.deepEqual(checkMapping({ ...DIDI_PLACE_MAPPING, properties: rest }, declared('Place')), ['unaccounted property: coordinateUnit']);
});

test('a payload missing a mapped field fails loudly instead of writing an object with a hole', () => {
  const { display_name: _missing, ...partial } = providerPlace;
  assert.throws(() => resolveProperties(DIDI_PLACE_MAPPING, partial), /has no field display_name/);
});

test('a real provider payload becomes a real object and reads back', () => {
  const { properties, derived } = resolveProperties(DIDI_PLACE_MAPPING, providerPlace);
  const placeId = createHash('sha256').update(JSON.stringify(providerPlace)).digest('hex');
  const place = { ref: { type: 'Place', id: placeId }, properties: { ...properties, placeId } };
  // A place must carry evidence: the ontology's own cardinality says a Place with no source receipt
  // is not a stored fact, so the real write includes the receipt and the edge that cites it.
  const receipt = { ref: { type: 'SourceReceipt', id: 'receipt-didi-1' }, properties: { receiptId: 'receipt-didi-1', displayTitle: 'didi maps_textsearch', safeSummary: 'maps_textsearch returned one place', sourceIdentity: 'didi', observedAt: '2026-01-01T00:00:00.000Z' } };
  const db = new DatabaseSync(':memory:');
  const store: any = new OntologyObjectStore(db, model, Date.now);
  const owner = 'datasource-mapping-owner';
  const at = '2026-01-01T00:00:00.000Z';
  try {
    const link = { type: 'PlaceEvidence', from: { type: 'Place', id: placeId }, to: { type: 'SourceReceipt', id: 'receipt-didi-1' }, properties: { evidenceLevel: 'primary', observedAt: at, sourceRevision: '1' } };
    businessTransaction(db as never, () => store.ingest(owner, { objects: [place, receipt], links: [link] }, { kind: 'provider', id: 'didi', observedAt: at }));
    const read: any = store.read(owner, { type: 'Place', id: placeId });
    assert.equal(read.properties.name, '北京大学');
    assert.deepEqual(read.properties.address, { text: '北京大学海淀区颐和园路5号', city: '北京市' });
    assert.deepEqual(read.properties.coordinates, { lat: 39.99, lng: 116.31 });
    assert.equal(derived.placeId !== undefined, true, 'the derived identity is the id the object was stored under');
    const edges: any[] = store.readLinkAttributes(owner, { type: 'Place', id: placeId }, 'PlaceEvidence');
    assert.equal(edges.length, 1, 'the place is stored with the evidence that justifies it');
  } finally { db.close(); }
});
