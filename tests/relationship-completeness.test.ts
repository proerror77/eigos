import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { OntologyModel } from '../packages/ontology/model.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { currentKernelImplementation } from '../packages/ontology/definition-store.js';
import { sourceProof } from '../packages/ontology/object-evidence.js';
import { readRegistration } from '../packages/ontology/free-booking-functions.js';
import { registrationHistory } from './fixtures/registration-history.js';

test('bounded internal relationships reject an incomplete page; external queries can continue', () => {
  const model = new OntologyModel({ id: 'relationship.review', version: '1', interfaces: [], actions: [], functions: [], objects: [{ id: 'Node', version: '1', name: 'Node', aliases: [], description: 'Synthetic node', primaryKey: 'id', titleKey: 'id', properties: { id: { kind: 'string', schema: z.string().min(1), required: true, description: 'Identity', source: 'synthetic' }, payload: { kind: 'string', schema: z.string().max(10000), description: 'Synthetic payload', source: 'synthetic' } } }],
    links: [{ id: 'Neighbors', description: 'Synthetic neighbors', from: { type: 'Node', name: 'children', many: true }, to: { type: 'Node', name: 'parents', many: true } }] });
  const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, model), root = { type: 'Node', id: 'root' };
  try {
    const refs = Array.from({ length: 51 }, (_, i) => ({ type: 'Node', id: `n${String(i).padStart(2, '0')}` }));
    graph.ingest('owner', { objects: [root, ...refs.slice(0, 50)].map(ref => ({ ref, properties: { id: ref.id } })), links: refs.slice(0, 50).map(to => ({ type: 'Neighbors', from: root, to })) }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
    assert.equal(graph.related('owner', root, 'children', { remaining: 1000 }).length, 50);
    graph.ingest('owner', { objects: [{ ref: refs[50]!, properties: { id: refs[50]!.id } }], links: [{ type: 'Neighbors', from: root, to: refs[50]! }] }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
    assert.deepEqual(graph.related('owner', refs[0]!, 'children', { remaining: 1000 }), [], 'A complete empty read stays empty');
    assert.throws(() => graph.related('owner', root, 'children', { remaining: 1000 }), /Relationship read is incomplete/);
    const first = graph.query('owner', { from: root, link: 'children', limit: 50 });
    assert.equal(first.items.length, 50); assert.equal(first.page.hasMore, true);
    const last = graph.query('owner', { from: root, link: 'children', limit: 50, cursor: first.page.cursor });
    assert.equal(last.items.length, 1); assert.equal(last.page.hasMore, false);
    const wide = { type: 'Node', id: 'wide-root' }, wideRefs = Array.from({ length: 20 }, (_, i) => ({ type: 'Node', id: `wide-${i}` }));
    graph.ingest('owner', { objects: [wide, ...wideRefs].map(ref => ({ ref, properties: { id: ref.id, payload: 'x'.repeat(5000) } })), links: wideRefs.map(to => ({ type: 'Neighbors', from: wide, to })) }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
    assert.throws(() => graph.related('owner', wide, 'children', { remaining: 1000 }), /Relationship read is incomplete/, 'The byte bound also cannot become empty history');
  } finally { db.close(); }
});

test('registration supersession cannot be skipped when history exceeds the response bound', () => {
  const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, currentKernelImplementation());
  try {
    const f = registrationHistory(graph, 51), original = f.refs[0]!;
    assert(sourceProof(graph, f.owner, original, { remaining: 1000 }), 'The original sealed evidence is valid');
    assert.throws(() => readRegistration(graph, f.owner, original), /Relationship read is incomplete/);
    const status = graph.evaluate(f.owner, { function: 'registrationStatus', object: original });
    assert.equal(status.status, 'unknown'); assert.match(status.reason!, /Relationship read is incomplete/);
    assert(!Object.hasOwn(status, 'value'), 'An incomplete history cannot certify canSubmit=true');
  } finally { db.close(); }
});
