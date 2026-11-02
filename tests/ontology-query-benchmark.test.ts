import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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
