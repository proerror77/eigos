import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { OntologyModel } from '../packages/ontology/model.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';

function fixture(scoped: boolean) {
  const field = { kind: 'string' as const, schema: z.string().min(1), description: 'Synthetic value', source: 'test', required: true };
  const model = new OntologyModel({ id: 'test.read-joins', version: '1', objects: [
    { id: 'Node', version: '1', name: 'Node', aliases: [], description: 'Synthetic node', primaryKey: 'id', titleKey: 'label', properties: { id: field, label: field } },
  ], interfaces: [], actions: [], functions: [], links: [
    { id: 'Historical', description: 'Retained source relation', writePolicy: 'source', from: { type: 'Node', name: 'history', many: true }, to: { type: 'Node', name: 'origins', many: true } },
    { id: 'Current', description: 'Current managed relation', writePolicy: 'managed', from: { type: 'Node', name: 'current', many: true }, to: { type: 'Node', name: 'parents', many: true } },
  ] });
  const db = new DatabaseSync(':memory:'), ontologyId = scoped ? model.ref.id : 'eigos.business';
  const graph = new OntologyObjectStore(db, model, Date.now, undefined, { ...(scoped ? { ontologyId } : {}), skipLegacyMigration: true });
  const source = { kind: 'synthetic' as const, id: 'join-regression', observedAt: new Date().toISOString() };
  const a = { type: 'Node', id: 'a' }, b = { type: 'Node', id: 'b' };
  graph.ingest('alice', { objects: [a, b].map(ref => ({ ref, properties: { id: ref.id, label: ref.id } })), links: [
    { type: 'Historical', from: a, to: b }, { type: 'Current', from: a, to: b },
  ] }, source);
  return { db, graph, ontologyId, a, b };
}

for (const scoped of [false, true]) {
  test(`joined deletion state preserves historical/current semantics and isolation (scoped=${scoped})`, () => {
    const f = fixture(scoped);
    try {
      assert.equal(f.graph.related('alice', f.a, 'history', { remaining: 100 }).length, 1);
      // Another owner and another ontology may use the same object identity.
      for (const [ontology, owner] of [[f.ontologyId, 'bob'], ['another.ontology', 'alice']] as const) {
        f.db.prepare('INSERT INTO ontology_tombstones VALUES(?,?,?,?,?,?,?,?)').run(ontology, owner, 'Node', 'b', 2, 'test', '{}', '2030-01-01T00:00:00Z');
      }
      assert.equal(f.graph.read('alice', f.b).ref.id, 'b');
      assert.equal(f.graph.related('alice', f.a, 'history', { remaining: 100 })[0]!.tombstone, undefined);
      f.db.prepare('INSERT INTO ontology_tombstones VALUES(?,?,?,?,?,?,?,?)').run(f.ontologyId, 'alice', 'Node', 'b', 2, 'test', '{}', '2030-01-01T00:00:00Z');
      assert.throws(() => f.graph.read('alice', f.b), /tombstoned/);
      assert.deepEqual(f.graph.related('alice', f.a, 'history', { remaining: 100 })[0]!.tombstone, { revision: 2, deletedAt: '2030-01-01T00:00:00Z' });
      assert.deepEqual(f.graph.related('alice', f.a, 'current', { remaining: 100 }), []);
      assert.throws(() => f.graph.related('bob', f.a, 'history', { remaining: 100 }), /not found/);
    } finally { f.db.close(); }
  });

  test(`empty traversals retain validation and do not cache absence (scoped=${scoped})`, () => {
    const f = fixture(scoped);
    try {
      const query = { from: f.b, link: 'history' };
      assert.deepEqual(f.graph.query('alice', query).items, []);
      assert.throws(() => f.graph.query('alice', { ...query, select: ['unknown'] }), /Unknown selected/);
      assert.throws(() => f.graph.query('alice', { ...query, where: [{ property: 'unknown', op: 'eq', value: 'x' }] }), /registered property/);
      assert.throws(() => f.graph.query('alice', { from: f.b, link: 'unknown' }), /navigation|relationship/i);
      assert.throws(() => f.graph.query('alice', { ...query, cursor: 'invalid' }), /cursor/);
      f.graph.ingest('alice', { objects: [], links: [{ type: 'Historical', from: f.b, to: f.a }] }, { kind: 'synthetic', id: 'join-regression', observedAt: new Date().toISOString() });
      assert.equal(f.graph.query('alice', query).items[0]!.ref.id, 'a');
      // A dangling edge must still have its pinned definition validated.
      const table = scoped ? 'ontology_scoped_links' : 'ontology_links';
      f.db.prepare(`UPDATE ${table} SET definition_digest='incompatible',to_id='missing' WHERE owner='alice' AND from_id='b'`).run();
      assert.throws(() => f.graph.query('alice', query), /link definition changed/);
    } finally { f.db.close(); }
  });
}
