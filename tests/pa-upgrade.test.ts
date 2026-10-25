import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
const { assertUpgradeIdle }: { assertUpgradeIdle(path: string, backend: string | undefined): void } = await import(new URL('../scripts/pa-upgrade.mjs', import.meta.url).href);

test('Upgrade preflight preserves retired tasks while blocking current tasks and uncertain external effects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-upgrade-')), file = join(dir, 'tasks.sqlite'), db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE jobs(id TEXT,state TEXT,body TEXT); CREATE TABLE action_intents(job_id TEXT,state TEXT,body TEXT)');
    db.prepare('INSERT INTO jobs VALUES(?,?,?)').run('retired', 'submitted', JSON.stringify({ delegation: { backendVersion: 'retired' } }));
    assertUpgradeIdle(file, 'active');
    db.prepare('INSERT INTO jobs VALUES(?,?,?)').run('current', 'working', JSON.stringify({ delegation: { backendVersion: 'active' } }));
    assert.throws(() => assertUpgradeIdle(file, 'active'), /1 active tasks/);
    db.exec("UPDATE jobs SET state='failed' WHERE id='current'");
    db.prepare('INSERT INTO action_intents VALUES(?,?,?)').run('current', 'effect_unknown', JSON.stringify({ effect: 'reserve' }));
    assert.throws(() => assertUpgradeIdle(file, 'active'), /1 uncertain business operations/);
    db.exec("UPDATE action_intents SET state='effect_confirmed'"); assertUpgradeIdle(file, 'active');
    assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get()!.n, 2);
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});

test('Explicit current-definition queries coexist with untouched historical object versions', () => {
  const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db);
  try {
    for (const id of ['old', 'current']) graph.ingest('owner', { objects: [{ ref: { type: 'ServiceRequest', id }, properties: { requestId: id, displayTitle: id, originalGoal: id, revision: 1 } }] }, { kind: 'task', id, observedAt: new Date().toISOString() });
    db.prepare("UPDATE ontology_objects SET definition_digest='historical-fingerprint' WHERE id='old'").run();
    assert.throws(() => graph.query('owner', { type: 'ServiceRequest' }), /definition changed/);
    const current = graph.query('owner', { type: 'ServiceRequest', currentDefinitionsOnly: true });
    assert.equal(current.definitionScope, 'current_definitions_only'); assert.deepEqual(current.items.map(o => o.ref.id), ['current']);
    assert.throws(() => graph.read('owner', { type: 'ServiceRequest', id: 'old' }), /definition changed/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ontology_objects').get()!.n, 2);
    assert.equal(graph.query('other', { type: 'ServiceRequest', currentDefinitionsOnly: true }).items.length, 0);
  } finally { db.close(); }
});
