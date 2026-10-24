import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { businessTransaction } from '../packages/core/transaction.js';
import { businessModel, businessModelV9 } from '../packages/ontology/business-model.js';
import { migrateIntegratedOntology } from '../packages/ontology/integration-migration.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';

test('migration reserves its writer before reading, so another connection cannot invalidate its snapshot', t => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-migration-race-')), path = join(dir, 'graph.sqlite');
  const db = new DatabaseSync(path), writer = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000');
    writer.exec('PRAGMA busy_timeout=0'); // Deterministic competing-write probe, not a runtime timeout change.
    new OntologyObjectStore(db);
    db.prepare('INSERT INTO ontology_revisions VALUES(?,?)').run('competing-writer', 0);
    let probed = false, competingWriteBlocked = false;
    const prepare = db.prepare.bind(db);
    t.mock.method(db, 'prepare', (sql: string) => {
      const statement = prepare(sql);
      if (!probed && sql === 'SELECT owner,id,definition_digest,body FROM ontology_objects WHERE type=?') {
        const all = statement.all.bind(statement);
        t.mock.method(statement, 'all', (...args: Parameters<typeof statement.all>) => {
          const rows = all(...args);
          if (!probed) {
            probed = true;
            try { writer.prepare('UPDATE ontology_revisions SET revision=revision+1 WHERE owner=?').run('competing-writer'); }
            catch (error) {
              assert.equal((error as { errcode?: number }).errcode, 5);
              competingWriteBlocked = true;
            }
          }
          return rows;
        });
      }
      return statement;
    });
    migrateIntegratedOntology(db, businessModelV9, businessModel);
    assert(probed, 'The competing write must be attempted after the migration actually reads');
    assert(competingWriteBlocked, 'Migration must own the writer reservation before opening its read snapshot');
    writer.prepare('UPDATE ontology_revisions SET revision=revision+1 WHERE owner=?').run('competing-writer');
    assert.equal(db.prepare('SELECT revision FROM ontology_revisions WHERE owner=?').get('competing-writer')!.revision, 1);
  } finally { t.mock.restoreAll(); writer.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('migration inside a shared business transaction neither commits nor takes ownership from its caller', () => {
  const db = new DatabaseSync(':memory:');
  try {
    new OntologyObjectStore(db);
    const stop = new Error('caller rollback');
    assert.throws(() => businessTransaction(db, () => {
      db.prepare('INSERT INTO ontology_revisions VALUES(?,?)').run('before-migration', 1);
      migrateIntegratedOntology(db, businessModelV9, businessModel);
      db.prepare('INSERT INTO ontology_revisions VALUES(?,?)').run('after-migration', 2);
      throw stop;
    }), error => error === stop);
    assert.deepEqual(db.prepare('SELECT * FROM ontology_revisions').all(), []);
    businessTransaction(db, () => {
      migrateIntegratedOntology(db, businessModelV9, businessModel);
      db.prepare('INSERT INTO ontology_revisions VALUES(?,?)').run('committed-by-caller', 3);
    });
    assert.equal(db.prepare('SELECT revision FROM ontology_revisions WHERE owner=?').get('committed-by-caller')!.revision, 3);
  } finally { db.close(); }
});
