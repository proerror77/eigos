import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  businessSavepoint,
  businessTransaction,
  hasTransaction,
  assertBusinessTransaction,
} from '../packages/core/transaction.js';
import { owner } from './backend-fixture.js';
import { setupDidi } from './fixtures/didi.js';

test('registered savepoints work without isTransaction and preserve outer ownership and rollback', () => {
  const db = new DatabaseSync(':memory:');
  const connection = { exec: db.exec.bind(db) };
  db.exec('CREATE TABLE sample(value TEXT)');
  try {
    assert(!hasTransaction(connection));
    businessSavepoint(connection, 'outer', () => {
      assertBusinessTransaction(connection);
      db.prepare('INSERT INTO sample VALUES(?)').run('retained');
      assert.throws(
        () =>
          businessSavepoint(connection, 'inner', () => {
            assertBusinessTransaction(connection);
            db.prepare('INSERT INTO sample VALUES(?)').run('rolled back');
            throw Error('expected');
          }),
        /expected/,
      );
      assertBusinessTransaction(connection);
    });
    assert(!hasTransaction(connection));
    assert.deepEqual(
      db
        .prepare('SELECT value FROM sample')
        .all()
        .map((r) => r.value),
      ['retained'],
    );
    businessTransaction(connection, () =>
      businessSavepoint(connection, 'inside_begin', () =>
        assertBusinessTransaction(connection),
      ),
    );
    assert(!hasTransaction(connection));
  } finally {
    db.close();
  }
});

test('standalone task save and intent save work on the oldest supported transaction API and roll back atomically', async (t) => {
  const f = setupDidi();
  const db = (f.store as unknown as { db: DatabaseSync }).db;
  t.diagnostic(
    JSON.stringify({
      node: process.version,
      nativeTransactionState: typeof db.isTransaction === 'boolean',
    }),
  );
  try {
    const submitted = f.b.submit({
      goal: '只查北京西站到西二旗地铁站的滴滴估价，不下单不付款',
    });
    const job = await f.finish(submitted.id);
    f.store.save(owner, job);
    const intent = f.store.intents(owner, job.id)[0]!;
    f.store.saveIntent(owner, intent);
    const snapshot = () =>
      JSON.stringify(
        [
          'jobs',
          'action_intents',
          'ontology_objects',
          'ontology_links',
          'ontology_projection_epochs',
          'ontology_projection_checkpoints',
        ].map((table) =>
          db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ),
      );
    const before = snapshot();
    const store = f.store as unknown as {
      projectExecution: (...args: unknown[]) => void;
    };
    const original = store.projectExecution;
    t.mock.method(
      store,
      'projectExecution',
      function (this: typeof store, ...args: unknown[]) {
        Reflect.apply(original, this, args);
        db.prepare(
          "UPDATE ontology_objects SET revision=revision+1 WHERE owner=? AND type='ServiceRequest'",
        ).run(owner);
        throw Error('forced projection failure');
      },
    );
    assert.throws(() => f.store.save(owner, job), /forced projection failure/);
    assert.equal(snapshot(), before);
    assert.throws(
      () => f.store.saveIntent(owner, intent),
      /forced projection failure/,
    );
    assert.equal(snapshot(), before);
    assert(!hasTransaction(db));
  } finally {
    f.close();
  }
});
