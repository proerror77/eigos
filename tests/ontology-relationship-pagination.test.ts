import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import { OntologyModel } from '../packages/ontology/model.js';
import { OntologyObjectStore, type OntologyGraphContext } from '../packages/ontology/object-store.js';

function fixture(scoped: boolean, compatibleDefinition?: OntologyGraphContext['compatibleDefinition']) {
  const field = { kind: 'string' as const, schema: z.string().min(1), description: 'Synthetic value', source: 'test', required: true };
  const model = new OntologyModel({ id: 'test.relationship-pages', version: '1', objects: [
    { id: 'Node', version: '1', name: 'Node', aliases: [], description: 'Node', primaryKey: 'id', titleKey: 'label', properties: { id: field, label: field } },
  ], interfaces: [], actions: [], functions: [], links: [
    { id: 'Historical', description: 'Source relation', writePolicy: 'source', from: { type: 'Node', name: 'history', many: true }, to: { type: 'Node', name: 'origins', many: true } },
    { id: 'Current', description: 'Managed relation', writePolicy: 'managed', from: { type: 'Node', name: 'current', many: true }, to: { type: 'Node', name: 'parents', many: true } },
  ] });
  const db = new DatabaseSync(':memory:'), ontologyId = scoped ? model.ref.id : 'eigos.business';
  const context = { ontologyId, skipLegacyMigration: true, compatibleDefinition };
  const graph = new OntologyObjectStore(db, model, Date.now, undefined, context);
  const source = { kind: 'synthetic' as const, id: 'relationship-pages', observedAt: new Date().toISOString() };
  const hub = { type: 'Node', id: 'hub' }, owner = 'alice';
  graph.ingest(owner, { objects: [{ ref: hub, properties: { id: hub.id, label: 'hub' } }] }, source);
  return { db, graph, model, context, source, owner, hub, ontologyId, scoped,
    objects: scoped ? 'ontology_scoped_objects' : 'ontology_objects', links: scoped ? 'ontology_scoped_links' : 'ontology_links',
    prefix: scoped ? [ontologyId, owner] : [owner] };
}
type Fixture = ReturnType<typeof fixture>;
const neighbor = (i: number) => ({ type: 'Node', id: `n${String(i).padStart(6, '0')}` });

// Bulk fixture construction only; the measured/read path is the real store.
function populate(f: Fixture, count: number) {
  const object = f.db.prepare(`INSERT INTO ${f.objects} VALUES(${f.scoped ? '?,' : ''}?,?,?,?,?,?)`);
  const link = f.db.prepare(`INSERT INTO ${f.links} VALUES(${f.scoped ? '?,' : ''}?,?,?,?,?,?,?)`);
  const definition = f.model.fingerprint('Node');
  f.db.exec('BEGIN');
  try {
    for (let i = 0; i < count; i++) {
      const ref = neighbor(i);
      object.run(...f.prefix, ref.type, ref.id, 1, definition, JSON.stringify({ createdAt: f.source.observedAt, properties: { id: ref.id, label: ref.id }, source: f.source }));
      for (const type of ['Historical', 'Current']) {
        const pin = digest(f.model.link(type));
        link.run(...f.prefix, type, f.hub.type, f.hub.id, ref.type, ref.id, pin);
        link.run(...f.prefix, type, ref.type, ref.id, f.hub.type, f.hub.id, pin);
      }
    }
    f.db.exec('COMMIT');
  } catch (error) { f.db.exec('ROLLBACK'); throw error; }
}

// Always-true predicates count database candidate visits, including rows that
// never reach JavaScript. No elapsed-time or EXPLAIN-output assertions.
function probe(t: TestContext, db: DatabaseSync) {
  const counts = { targets: 0, definitions: 0 }, prepare = db.prepare.bind(db);
  db.function('page_target_visit', (_id: unknown) => { counts.targets++; return 1; });
  db.function('page_definition_visit', (_definition: unknown) => { counts.definitions++; return 1; });
  t.mock.method(db, 'prepare', (sql: string) => {
    if (sql.startsWith('SELECT DISTINCT definition_digest') || sql.startsWith('WITH RECURSIVE relationship_definitions')) {
      sql = sql.replace(/(?:from|to)_id=\?/g, '$& AND page_definition_visit(definition_digest)');
    }
    sql = sql.replace(/o\.id=l\.(?:from_id|to_id|id)\b/g, '$& AND page_target_visit(o.id)');
    return prepare(sql);
  });
  return { counts, reset: () => { counts.targets = 0; counts.definitions = 0; } };
}

for (const scoped of [false, true]) {
  test(`repeated definitions are skipped independently of the target-page limit (scoped=${scoped})`, t => {
    const f = fixture(scoped);
    try {
      populate(f, 10_000);
      const p = probe(t, f.db);
      assert.equal(f.graph.query(f.owner, { from: f.hub, link: 'history', limit: 1 }).items.length, 1);
      assert(p.counts.definitions <= 2, `One pinned definition visited ${p.counts.definitions} repeated edges`);
    } finally { f.db.close(); }
  });

  test(`large forward/reverse pages bound database visits and seek through every neighbor (scoped=${scoped})`, t => {
    const f = fixture(scoped), size = 10_000;
    try {
      populate(f, size);
      const p = probe(t, f.db);
      for (const link of ['history', 'origins', 'current', 'parents']) {
        const query = { from: f.hub, link, limit: 1 };
        const first = f.graph.query(f.owner, query);
        assert.equal(first.items[0]!.ref.id, neighbor(0).id);
        assert(p.counts.targets <= 201, `First page visited ${p.counts.targets} targets`);
        assert(p.counts.definitions <= 2, `One definition visited ${p.counts.definitions} edges`);
        p.reset();
        const next = f.graph.query(f.owner, { ...query, cursor: first.page.cursor });
        assert.equal(next.items[0]!.ref.id, neighbor(1).id);
        assert(p.counts.targets <= 201, `Second page visited ${p.counts.targets} targets`);
        assert(p.counts.definitions <= 2);
        p.reset();
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const page = f.graph.query(f.owner, { from: f.hub, link, limit: 50, cursor });
          assert(page.page.scanned <= 200);
          ids.push(...page.items.map(v => v.ref.id));
          if (!page.page.hasMore) break;
          assert(page.page.cursor && page.page.cursor !== cursor, 'Every continuation must advance');
          cursor = page.page.cursor;
        } while (ids.length <= size);
        assert.deepEqual(ids, Array.from({ length: size }, (_, i) => neighbor(i).id));
        p.reset();
      }
    } finally { f.db.close(); }
  });

  test(`deleted and dangling prefixes yield bounded empty pages without losing later targets (scoped=${scoped})`, t => {
    const f = fixture(scoped);
    try {
      populate(f, 650);
      const tombstone = f.db.prepare('INSERT INTO ontology_tombstones VALUES(?,?,?,?,?,?,?,?)');
      for (let i = 0; i < 250; i++) tombstone.run(f.ontologyId, f.owner, 'Node', neighbor(i).id, 2, f.model.fingerprint('Node'), '{}', f.source.observedAt);
      f.db.prepare(`DELETE FROM ${f.objects} WHERE ${f.scoped ? 'ontology_id=? AND ' : ''}owner=? AND id>=? AND id<?`).run(...f.prefix, neighbor(250).id, neighbor(450).id);
      const p = probe(t, f.db), query = { from: f.hub, link: 'current', limit: 1 };
      const first = f.graph.query(f.owner, query);
      assert.deepEqual(first.items, []);
      assert.equal(first.page.scanned, 200);
      assert.equal(first.page.hasMore, true);
      assert(p.counts.targets <= 201);
      const second = f.graph.query(f.owner, { ...query, cursor: first.page.cursor });
      assert.deepEqual(second.items, []);
      assert(second.page.hasMore && second.page.cursor !== first.page.cursor);
      const third = f.graph.query(f.owner, { ...query, cursor: second.page.cursor });
      assert.equal(third.items[0]!.ref.id, neighbor(450).id);
      const history = f.graph.query(f.owner, { from: f.hub, link: 'history', limit: 1 });
      assert.equal(history.items[0]!.tombstone?.revision, 2);
    } finally { f.db.close(); }
  });

  test(`all pinned definitions, even a dangling last edge, are validated before the first page (scoped=${scoped})`, () => {
    const f = fixture(scoped);
    try {
      populate(f, 1_000);
      for (const [type, definition] of [['Historical', 'incompatible'], ['Current', '']] as const) {
        f.db.prepare(`UPDATE ${f.links} SET definition_digest=?,to_id='missing' WHERE ${f.scoped ? 'ontology_id=? AND ' : ''}owner=? AND type=? AND from_id=? AND to_id=?`)
          .run(definition, ...f.prefix, type, f.hub.id, neighbor(999).id);
        assert.throws(() => f.graph.query(f.owner, { from: f.hub, link: type === 'Historical' ? 'history' : 'current', limit: 1 }), /link definition changed/);
      }
    } finally { f.db.close(); }
  });

  test(`compatible historical definitions retain the exact 200/201 bound (scoped=${scoped})`, () => {
    const seen = new Set<string>(), f = fixture(scoped, args => { seen.add(args.storedDigest); return args.kind === 'link' && args.storedDigest.startsWith('legacy-'); });
    try {
      populate(f, 1_000);
      const update = f.db.prepare(`UPDATE ${f.links} SET definition_digest=? WHERE ${f.scoped ? 'ontology_id=? AND ' : ''}owner=? AND type='Historical' AND from_id=? AND to_id=?`);
      for (let i = 0; i < 199; i++) update.run(`legacy-${i}`, ...f.prefix, f.hub.id, neighbor(i).id);
      assert.equal(f.graph.query(f.owner, { from: f.hub, link: 'history', limit: 1 }).items.length, 1);
      assert.equal(seen.size, 199);
      update.run('legacy-199', ...f.prefix, f.hub.id, neighbor(199).id);
      assert.throws(() => f.graph.query(f.owner, { from: f.hub, link: 'history', limit: 1 }), /definition read bound exceeded/);
    } finally { f.db.close(); }
  });

  test(`definition seeks ignore another owner and ontology with identical endpoints (scoped=${scoped})`, () => {
    const f = fixture(scoped);
    try {
      populate(f, 300);
      f.db.prepare(`INSERT INTO ${f.links} VALUES(${scoped ? '?,' : ''}?,?,?,?,?,?,?)`)
        .run(...(scoped ? [f.ontologyId] : []), 'bob', 'Historical', f.hub.type, f.hub.id, 'Node', neighbor(0).id, 'incompatible');
      f.db.prepare('INSERT INTO ontology_scoped_links VALUES(?,?,?,?,?,?,?,?)')
        .run('foreign.ontology', f.owner, 'Historical', f.hub.type, f.hub.id, 'Node', neighbor(0).id, 'incompatible');
      assert.equal(f.graph.query(f.owner, { from: f.hub, link: 'history', limit: 1 }).items[0]!.ref.id, neighbor(0).id);
    } finally { f.db.close(); }
  });

  test(`a write after the definition read rejects the mixed page (scoped=${scoped})`, t => {
    const f = fixture(scoped);
    try {
      populate(f, 300);
      const prepare = f.db.prepare.bind(f.db);
      let changed = false;
      t.mock.method(f.db, 'prepare', (sql: string) => {
        const statement = prepare(sql);
        if (sql.startsWith('WITH RECURSIVE relationship_definitions')) {
          const all = statement.all.bind(statement);
          t.mock.method(statement, 'all', (...args: Parameters<typeof all>) => {
            const rows = all(...args);
            if (!changed) {
              changed = true;
              f.graph.ingest(f.owner, { objects: [{ ref: f.hub, expectedRevision: 1, properties: { id: f.hub.id, label: 'changed during query' } }] }, f.source);
            }
            return rows;
          });
        }
        return statement;
      });
      assert.throws(() => f.graph.query(f.owner, { from: f.hub, link: 'history', limit: 1 }), /Objects changed during query/);
      assert(changed);
    } finally { f.db.close(); }
  });

  test(`continuations reject changed revisions and cannot cross owners or relationships (scoped=${scoped})`, () => {
    const f = fixture(scoped);
    try {
      populate(f, 300);
      const query = { from: f.hub, link: 'history', limit: 1 }, first = f.graph.query(f.owner, query);
      for (const [owner, changed] of [['bob', query], [f.owner, { ...query, link: 'origins' }]] as const) {
        assert.throws(() => f.graph.query(owner, { ...changed, cursor: first.page.cursor }), /context changed/);
      }
      f.graph.ingest(f.owner, { objects: [{ ref: f.hub, expectedRevision: 1, properties: { id: f.hub.id, label: 'changed' } }] }, f.source);
      assert.throws(() => f.graph.query(f.owner, { ...query, cursor: first.page.cursor }), /context changed/);
    } finally { f.db.close(); }
  });

  test(`opening a populated old database adds definition indexes idempotently without changing facts (scoped=${scoped})`, t => {
    const f = fixture(scoped);
    try {
      populate(f, 1_000);
      for (const table of ['ontology_links', 'ontology_scoped_links']) for (const side of ['forward', 'reverse']) f.db.exec(`DROP INDEX IF EXISTS ${table}_${side}_definitions`);
      const before = f.graph.query(f.owner, { from: f.hub, link: 'history', limit: 1 });
      const reopened = new OntologyObjectStore(f.db, f.model, Date.now, undefined, f.context);
      new OntologyObjectStore(f.db, f.model, Date.now, undefined, f.context);
      const p = probe(t, f.db), after = reopened.query(f.owner, { from: f.hub, link: 'history', limit: 1 });
      assert.deepEqual(after, before);
      assert(p.counts.definitions <= 2);
      assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${f.objects}`).get()!.n, 1_001);
    } finally { f.db.close(); }
  });
}
