import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { measureQuery, benchmarkHistory, benchmarkAuthorizedReads } from '../examples/ontology-query-benchmark.js';

test('benchmark counts repeated statement executions and restores the reader instrumentation', () => {
  const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db), original = { prepare: db.prepare, query: graph.query };
  try {
    const result = measureQuery(db, graph, () => { const statement = db.prepare('SELECT 1 AS n'); return [statement.get(), statement.get(), statement.all()]; }, 2, 0);
    assert.equal(result.first.sqlExecutions, 3); assert.equal(result.first.sqlRows, 3);
    assert.equal(result.warm.perCall.sqlExecutions!.median, 3);
    assert.equal(db.prepare, original.prepare); assert.equal(graph.query, original.query);
    assert.throws(() => measureQuery(db, graph, () => { throw new Error('unexpected failure'); }, 1, 0), /unexpected failure/);
    assert.equal(db.prepare, original.prepare); assert.equal(graph.query, original.query);
  } finally { db.close(); }
});

test('benchmark counts statements prepared before its window and reused across windows', () => {
  const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db), statement = db.prepare('SELECT 1 AS n');
  try {
    for (let window = 0; window < 2; window++) {
      const result = measureQuery(db, graph, () => statement.get(), 2, 1);
      assert.equal(result.first.sqlExecutions, 1);
      assert.equal(result.warm.perCall.sqlExecutions!.min, 1);
      assert.equal(result.warm.perCall.sqlExecutions!.max, 1);
      assert.equal(result.warm.perCall.sqlRows!.median, 1);
    }
  } finally { db.close(); }
});

test('benchmark does not stack instrumentation when prepare returns an existing statement', t => {
  const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db), statement = db.prepare('SELECT 1 AS n');
  const get = statement.get, all = statement.all, run = statement.run;
  try {
    t.mock.method(db, 'prepare', () => statement);
    const result = measureQuery(db, graph, () => db.prepare('SELECT 1 AS n').get(), 3, 0);
    assert.equal(result.first.sqlExecutions, 1);
    assert.equal(result.warm.perCall.sqlExecutions!.min, 1);
    assert.equal(result.warm.perCall.sqlExecutions!.max, 1);
    assert.equal(statement.get, get); assert.equal(statement.all, all); assert.equal(statement.run, run);
  } finally { db.close(); }
});

test('nested benchmark windows count each native execution and restore methods after errors', () => {
  const db = new DatabaseSync(':memory:'), other = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db);
  const first = db.prepare('SELECT 1 AS n'), second = other.prepare('SELECT 2 AS n');
  const original = { get: StatementSync.prototype.get, all: StatementSync.prototype.all, run: StatementSync.prototype.run };
  try {
    const outer = measureQuery(db, graph, () => {
      const inner = measureQuery(db, graph, () => [first.get(), second.get()], 1, 0);
      assert.equal(inner.first.sqlExecutions, 2);
      assert.equal(inner.warm.perCall.sqlExecutions!.median, 2);
      return inner;
    }, 1, 0);
    assert.equal(outer.first.sqlExecutions, 4);
    assert.equal(outer.warm.perCall.sqlExecutions!.median, 4);
    assert.throws(() => measureQuery(db, graph, () => { first.get(); throw new Error('stop measurement'); }, 1, 0), /stop measurement/);
    assert.equal(StatementSync.prototype.get, original.get);
    assert.equal(StatementSync.prototype.all, original.all);
    assert.equal(StatementSync.prototype.run, original.run);
    assert.equal(first.get()!.n, 1);
  } finally { other.close(); db.close(); }
});

test('authorized benchmark includes real Foundation checks and distinct evidence dependencies', () => {
  const [small, large] = benchmarkAuthorizedReads([1, 8], 1);
  assert.equal(small!.measurement.first.status, 'returned');
  assert.equal(large!.measurement.first.status, 'returned');
  assert(small!.measurement.first.sqlExecutions > 0);
  assert(large!.measurement.first.sqlExecutions > small!.measurement.first.sqlExecutions);
});

test('history benchmark measures real graph queries, batch reuse and incomplete-history refusal', () => {
  const [small, large] = benchmarkHistory([1, 51], 1);
  assert.deepEqual(small!.workloads.currentTerms!.warm.statuses, ['known']);
  assert.deepEqual(large!.workloads.currentTerms!.warm.statuses, ['unknown']);
  for (const sample of [small!, large!]) {
    assert.equal(sample.workloads.separateFacts!.first.graphQueries, 4);
    assert.equal(sample.workloads.batchedFacts!.first.graphQueries, 3);
    assert(sample.workloads.batchedFacts!.first.sqlExecutions < sample.workloads.separateFacts!.first.sqlExecutions);
    assert(sample.workloads.knownReference!.first.sqlExecutions > 0);
  }
});
