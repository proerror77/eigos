import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Job } from '../packages/core/domain.js';
import { BACKEND_VERSION, type ServiceRequest } from '../packages/ontology/execution.js';
import { executionContextRef, projectExecution } from '../packages/ontology/execution-projection.js';
import { OntologyObjectStore, type ObjectBatch, type ObjectSource } from '../packages/ontology/object-store.js';
import { projectTask } from '../packages/ontology/task-projection.js';

class CountingObjectStore extends OntologyObjectStore {
  imports: ObjectBatch[] = [];
  override ingest(owner: string, input: ObjectBatch, source: ObjectSource): void {
    this.imports.push(input);
    super.ingest(owner, input, source);
  }
}
function fixture() {
  const db = new DatabaseSync(':memory:'), graph = new CountingObjectStore(db), owner = 'projection-noop-owner', at = '2026-10-20T03:00:00.000Z';
  const request: ServiceRequest = { id: 'request', revision: 1, originalGoal: 'Read the current task', requirements: [],
    messages: [{ id: 'instruction', text: 'Read the current task', receivedAt: at }] };
  const job: Job = { id: request.id, contextId: 'context', service: 'eigos.delegate', goal: request.originalGoal, state: 'working', revision: 1,
    createdAt: at, updatedAt: at, messages: [], delegation: { backendVersion: BACKEND_VERSION, request, phase: 'planning', events: [] } };
  const source: ObjectSource = { kind: 'task', id: request.id, observedAt: at };
  projectTask(graph, owner, job);
  const project = () => {
    db.exec('SAVEPOINT fixture_projection');
    try { projectExecution(graph, owner, job); db.exec('RELEASE fixture_projection'); }
    catch (error) { db.exec('ROLLBACK TO fixture_projection; RELEASE fixture_projection'); throw error; }
  };
  return { db, graph, owner, job, request, source, project };
}

test('unchanged execution projection performs no imports while immutable history is still checked', () => {
  const f = fixture();
  try {
    f.project(); assert(f.graph.imports.length > 0);
    const before = f.graph.revision(f.owner);
    f.graph.imports = [];
    f.job.updatedAt = '2026-10-20T03:01:00.000Z';
    f.job.delegation!.events.push({ at: f.job.updatedAt, event: 'synthetic_bookkeeping' });
    f.project();
    assert.deepEqual(f.graph.imports, [], 'Unchanged task and instruction nodes must not repeat ontology imports/cardinality work');
    assert.equal(f.graph.revision(f.owner), before);
    const instruction = f.graph.query(f.owner, { type: 'RequestInstruction' }).items[0]!;
    f.graph.ingest(f.owner, { objects: [{ ref: instruction.ref, expectedRevision: instruction.revision, properties: { ...instruction.properties, text: 'Changed historical instruction' } }] }, f.source);
    f.graph.imports = [];
    assert.throws(f.project, /Immutable execution graph data changed/);
    assert.deepEqual(f.graph.imports, [], 'An unchanged-node optimization must never repair an immutable mismatch');
  } finally { f.db.close(); }
});

test('state changes still update the mutable execution context', () => {
  const f = fixture();
  try {
    f.project(); f.graph.imports = [];
    f.job.state = 'paused'; f.job.delegation!.phase = 'paused';
    f.project();
    assert(f.graph.imports.some(batch => batch.objects.some(object => object.ref.type === 'ExecutionContext')));
    assert.equal(f.graph.read(f.owner, executionContextRef(f.request.id, 1)).properties.state, 'paused');
  } finally { f.db.close(); }
});

test('mutable specification links are added and removed even when its properties are unchanged', () => {
  const f = fixture();
  try {
    f.project();
    const specification = f.graph.query(f.owner, { type: 'RequestSpecification' }).items[0]!;
    const instruction = f.graph.related(f.owner, specification.ref, 'instructions', { remaining: 1000 })![0]!;
    const edge = { type: 'RequestSpecificationInstruction', from: specification.ref, to: instruction.ref };
    f.graph.ingest(f.owner, { objects: [], removeLinks: [edge] }, f.source);
    f.graph.imports = []; f.project();
    assert(f.graph.imports.some(batch => batch.links?.some(link => link.type === edge.type && link.to.id === instruction.ref.id)));
    assert.deepEqual(f.graph.related(f.owner, specification.ref, 'instructions', { remaining: 1000 })!.map(object => object.ref), [instruction.ref]);

    const extra = { type: 'RequestInstruction', id: 'unselected-instruction' };
    f.graph.ingest(f.owner, { objects: [{ ref: extra, properties: { ...instruction.properties, id: extra.id, messageId: 'unselected-message', sequence: 1 } }],
      links: [{ type: 'RequestInstructionRequest', from: extra, to: { type: 'ServiceRequest', id: f.request.id } }, { type: edge.type, from: specification.ref, to: extra }] }, f.source);
    f.graph.imports = []; f.project();
    assert(f.graph.imports.some(batch => batch.removeLinks?.some(link => link.to.id === extra.id)));
    assert.deepEqual(f.graph.related(f.owner, specification.ref, 'instructions', { remaining: 1000 })!.map(object => object.ref), [instruction.ref]);
    assert.equal(f.graph.read(f.owner, extra).properties.messageId, 'unselected-message', 'Historical nodes are retained even when no longer selected');
  } finally { f.db.close(); }
});
