import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { businessTransaction } from '../packages/core/transaction.js';
import { createInterfaceContractDefinition } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';

/**
 * A relationship carries attributes of its own. This is the round trip: the
 * projection writes the evidence attributes, the store validates them against the
 * link definition, and they come back with the edge instead of disappearing.
 */
const seed: any = createInterfaceContractDefinition();
const model: any = compileOntologyDocument(seed.document, seed.registry);
const at = '2026-01-01T00:00:00.000Z';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const store: any = new OntologyObjectStore(db, model, Date.now);
  const owner = 'relationship-attribute-owner';
  const place = { ref: { type: 'Place', id: 'place-1' }, properties: { placeId: 'place-1', displayTitle: '上海站', name: '上海站', address: '上海', coordinates: { latitude: 31.2, longitude: 121.4 }, coordinateUnit: 'degree', coordinateSystem: 'WGS84' } };
  const receipt = { ref: { type: 'SourceReceipt', id: 'receipt-1' }, properties: { id: 'receipt-1', displayTitle: '回执' } };
  const insert = (row: any) => db.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?)').run(owner, row.ref.type, row.ref.id, 1, model.fingerprint(row.ref.type), JSON.stringify({ properties: row.properties, source: { kind: 'provider', id: 'r1', observedAt: at }, createdAt: at }));
  insert(place); insert(receipt);
  const source = { kind: 'provider' as const, id: 'r1', observedAt: at };
  const evidence = (properties: Record<string, unknown>) => ({ type: 'PlaceEvidence', from: { type: 'Place', id: 'place-1' }, to: { type: 'SourceReceipt', id: 'receipt-1' }, properties });
  const write = (properties: Record<string, unknown>) => businessTransaction(db as never, () => store.ingest(owner, { objects: [], links: [evidence(properties)] }, source));
  return { db, store, owner, write };
}

test('an evidence edge keeps the attributes it was written with', () => {
  const { db, store, owner, write } = fixture();
  try {
    write({ evidenceLevel: 'primary', observedAt: at, sourceRevision: '7' });
    const edges = store.readLinkAttributes(owner, { type: 'Place', id: 'place-1' }, 'PlaceEvidence');
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0].to, { type: 'SourceReceipt', id: 'receipt-1' });
    assert.deepEqual(edges[0].properties, { evidenceLevel: 'primary', observedAt: at, sourceRevision: '7' });
  } finally { db.close(); }
});

test('an attribute the relationship does not declare is rejected, not silently dropped', () => {
  const { db, write } = fixture();
  try { assert.throws(() => write({ evidenceLevel: 'primary', bogus: 1 }), /does not declare property bogus/); }
  finally { db.close(); }
});

test('a declared attribute with the wrong type is rejected', () => {
  const { db, write } = fixture();
  try { assert.throws(() => write({ observedAt: 'not-a-time' }), /property observedAt is invalid/); }
  finally { db.close(); }
});
