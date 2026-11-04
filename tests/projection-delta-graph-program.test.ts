import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { DomainError, type Job } from '../packages/core/domain.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { projectTask } from '../packages/ontology/task-projection.js';
import { projectExecution, projectExecutionProgram, readRequestProjection, readRequestProjectionProgram } from '../packages/ontology/execution-projection.js';
import { runGraphProgramAsync, type GraphStorage, type ProjectionMetadata } from '../packages/ontology/graph-program.js';

function fixture() {
  const at = '2026-10-20T03:00:00.000Z', db = new DatabaseSync(':memory:');
  const graph = new OntologyObjectStore(db, undefined, () => Date.parse(at)), owner = 'synthetic-async-projection';
  const job: Job = { id: 'original-task', contextId: 'original-context', service: 'eigos.delegate', goal: 'Read synthetic task', state: 'working', revision: 1,
    createdAt: at, updatedAt: at, messages: [], delegation: { backendVersion: BACKEND_VERSION, phase: 'planning', events: [],
      request: { id: 'original-task', revision: 1, originalGoal: 'Read synthetic task', requirements: [], messages: [{ id: 'original-message', text: 'Read synthetic task', receivedAt: at }] } } };
  projectTask(graph, owner, job);
  const metadata: ProjectionMetadata = { model: graph.model, releaseRef: graph.releaseRef, now: graph.now };
  return { db, graph, owner, job, metadata };
}
function asynchronousStorage(graph: OntologyObjectStore, beforeIngest?: () => void) {
  let pending = false, operations = 0;
  const invoke = async <T>(action: () => T): Promise<T> => {
    assert.equal(pending, false, 'Graph operations must be awaited in their original order'); pending = true;
    try { await setImmediate(); operations++; return action(); } finally { pending = false; }
  };
  const storage: GraphStorage = {
    read: (...args) => invoke(() => graph.read(...args)), readPrivate: (...args) => invoke(() => graph.readPrivate(...args)),
    query: (...args) => invoke(() => graph.query(...args)), related: (...args) => invoke(() => graph.related(...args)),
    ingest: (...args) => invoke(() => { beforeIngest?.(); return graph.ingest(...args); }),
    containsLinks: (...args) => invoke(() => graph.containsLinks(...args)), relationshipDigest: (...args) => invoke(() => graph.relationshipDigest(...args)),
    evidencePropertiesDigest: (...args) => invoke(() => graph.evidencePropertiesDigest(...args)), tombstone: (...args) => invoke(() => graph.tombstone(...args)),
  };
  return { storage, operations: () => operations };
}

test('the shared projection and verified request bundle retain their asynchronous storage path', async () => {
  const sync = fixture(), async = fixture();
  try {
    projectExecution(sync.graph, sync.owner, sync.job);
    const port = asynchronousStorage(async.graph);
    await runGraphProgramAsync(port.storage, projectExecutionProgram(async.metadata, async.owner, async.job));
    const bundle = await runGraphProgramAsync(port.storage, readRequestProjectionProgram(async.metadata, async.owner, async.job.id));
    assert.deepEqual(bundle, readRequestProjection(sync.graph, sync.owner, sync.job.id));
    assert.equal(bundle.instructions[0]!.properties.messageId, 'original-message');
    assert.equal(bundle.request.id, 'original-task');
    assert.equal(bundle.request.revision, bundle.specification.properties.requestRevision);
    assert(port.operations() > 1, 'Absent SQLite delta adapter must execute the real graph program');
    async.db.prepare("UPDATE ontology_objects SET body=json_set(body,'$.properties.text','tampered') WHERE owner=? AND type='RequestInstruction'").run(async.owner);
    await assert.rejects(runGraphProgramAsync(port.storage, readRequestProjectionProgram(async.metadata, async.owner, async.job.id)), /differs from its sealed specification/);
    await assert.rejects(runGraphProgramAsync(port.storage, projectExecutionProgram(async.metadata, async.owner, async.job)), /Immutable execution graph data changed/);
  } finally { sync.db.close(); async.db.close(); }
});

test('an asynchronous storage denial propagates without sealing a fragment or retaining partial writes', async () => {
  const f = fixture();
  try {
    const before = f.db.prepare('SELECT count(*) AS count FROM ontology_objects').get();
    const port = asynchronousStorage(f.graph, () => { throw new DomainError('FORBIDDEN', 'Synthetic current authorization revoked'); });
    f.db.exec('BEGIN');
    try { await assert.rejects(runGraphProgramAsync(port.storage, projectExecutionProgram(f.metadata, f.owner, f.job)), /current authorization revoked/); }
    finally { f.db.exec('ROLLBACK'); }
    assert.deepEqual(f.db.prepare('SELECT count(*) AS count FROM ontology_objects').get(), before);
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM ontology_projection_checkpoints').get()!.count, 0);
  } finally { f.db.close(); }
});
