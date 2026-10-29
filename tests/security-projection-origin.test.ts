import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { securityFixture } from './fixtures/security.js';
import { TaskService } from '../packages/core/tasks.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { taskContextFields } from '../packages/security/task-context-contract.js';
import { withAuthorization } from '../packages/security/context.js';
import { assertModelChannel } from '../packages/security/model.js';
import type { ObjectBinding } from '../packages/security/policy-store.js';
import { digest } from '../packages/core/delegation.js';

function fixture() {
  const now = Date.now(), f = securityFixture(() => now), db = new DatabaseSync(f.database);
  const policy = f.jobs.security.policies, install = f.installation('projection origin'), until = new Date(now + 3600000).toISOString();
  const fields = ['placeId', 'displayTitle', 'name'], asset = { type: 'Place', id: 'later-read' };
  const resources = [
    { type: 'ServiceRequest', fields: ['requestId', 'displayTitle', 'originalGoal', 'revision', 'conditions', 'progress', 'projectionState', 'createdAt'] },
    ...Object.entries(taskContextFields).map(([type, fields]) => ({ type, fields: fields.filter(field => Object.hasOwn(policy.fields(type), field) && policy.fieldPolicy(type, field) !== 'internal_only') })),
    { type: 'Place', fields },
  ];
  f.coordinator.approveAgentGrant(f.member.id, { installationId: install.id, capabilityIds: ['brief.prepare'], resources,
    sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt: until });
  policy.setRole({ subjectKind: 'installation', subjectId: install.id, resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest },
    role: 'Viewer', expiresAt: until }, policy.revision());
  policy.setRecipient(install.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'],
    channels: ['agent_response', 'registered_model'], expiresAt: until }, policy.revision());
  policy.setModelChannel('projection-origin', { classification: 'sensitive', markings: ['member_private', 'personal_data'], expiresAt: until }, policy.revision());
  const raw = new OntologyObjectStore(db, policy.model, () => now, undefined, { skipLegacyMigration: true });
  raw.ingest(f.owner, { objects: [
    { ref: asset, properties: { placeId: asset.id, displayTitle: asset.id, name: 'Sensitive later input' } },
    { ref: { type: 'SourceReceipt', id: 'synthetic-receipt' }, properties: { receiptId: 'synthetic-receipt', displayTitle: 'Synthetic', safeSummary: 'Synthetic', evidenceLevel: 'synthetic' } },
  ], links: [{ type: 'PlaceEvidence', from: asset, to: { type: 'SourceReceipt', id: 'synthetic-receipt' } }] },
  { kind: 'synthetic', id: 'fixture', observedAt: new Date(now).toISOString() });
  const principal = { ...f.principal, access: f.coordinator.authenticate(f.principal, install.token) };
  const tasks = new TaskService(f.jobs, { catalog: new ExecutionCatalog([], [], []) });
  const task = tasks.submit(principal, { service: 'eigos.delegate', goal: 'Original owner instruction', requestId: randomUUID() });
  const authority = f.jobs.security.workAuthority(f.owner, task.id)!;
  const originalGrant = f.jobs.security.taskGrant(f.jobs.security.agentContext(principal), task.id);
  f.jobs.security.revokeGrant(f.owner, originalGrant.id, originalGrant.revision);
  const grant = f.jobs.security.issueTaskGrant({ ...originalGrant, id: randomUUID(), inputs: [{ object: asset, objectRevision: 1, fields }],
    operations: [...new Set([...originalGrant.operations, 'member_asset.read' as const])] });
  f.jobs.security.attachTaskAuthority({ ...authority, id: randomUUID(), dataGrant: { id: grant.id, revision: grant.revision },
    submittedScopes: [...new Set([...authority.submittedScopes, 'tasks:read', 'member_assets:read'])] });
  const claim = f.jobs.claim(['eigos.delegate'], 60000)!; assert(claim);
  const scope = () => f.jobs.security.workerScope(f.owner, task.id, claim.securityAuthorityId!, claim.token);
  withAuthorization(scope(), () => assert(f.jobs.checkpoint(claim, () => {})));
  const ref = (type: string) => {
    const row = db.prepare('SELECT object_id FROM security_bindings WHERE grant_id=? AND type=?').get(grant.id, type)!;
    assert(row); return { type, id: String(row.object_id) };
  };
  const binding = (type: string, grantId = grant.id): ObjectBinding => JSON.parse(String(db.prepare('SELECT body FROM security_bindings WHERE grant_id=? AND type=?').get(grantId, type)!.body));
  const graph = f.jobs.ontologyForJob(f.owner, task.id);
  return { ...f, db, policy, grant, claim, task, asset, graph, scope, ref, binding, principal,
    close: () => { f.jobs.release(claim); db.close(); f.close(); } };
}

test('later audited reads cannot retroactively become inputs of an unchanged instruction', () => {
  const f = fixture();
  try {
    const before = f.binding('RequestInstruction');
    withAuthorization(f.scope(), () => {
      f.graph.read(f.owner, f.asset);
      assert(f.jobs.checkpoint(f.claim, job => { job.delegation!.phase = 'planning'; }));
    });
    const after = f.binding('RequestInstruction'), changed = f.binding('ExecutionContext');
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.inputEnvelope, before.inputEnvelope, 'Unchanged content retains the evidence with which it was originally produced');
    assert(changed.inputEnvelope!.lineage.some(dependency => dependency.object.id === f.asset.id), 'The changed execution state still inherits the newly read sensitive input');
    const audit = f.db.prepare('SELECT body FROM security_reads WHERE grant_id=?').all(f.grant.id);
    assert(audit.some(row => JSON.parse(String(row.body)).lineage.some((dependency: { object: { id: string } }) => dependency.object.id === f.asset.id)), 'The later read remains in the audit history');
    f.policy.restrictObject({ ownerKey: f.owner, object: f.asset, expectedObjectRevision: 1, field: 'name',
      classification: 'sensitive', requiredMarkings: ['health'], channels: ['agent_response', 'registered_model'] }, f.policy.revision());
    withAuthorization(f.scope(), () => {
      assert.equal(f.graph.read(f.owner, f.ref('RequestInstruction')).properties.text, 'Original owner instruction');
      assert.throws(() => f.graph.read(f.owner, f.ref('ExecutionContext')), /not available|INSUFFICIENT_ACCESS|OUTPUT_NOT_ALLOWED/);
      assert.throws(() => assertModelChannel(f.graph, 'projection-origin'), /not available|INSUFFICIENT_ACCESS|OUTPUT_NOT_ALLOWED/,
        'A later model invocation still carries its prior sensitive reads');
    });
    f.policy.restrictObject({ ownerKey: f.owner, object: f.ref('RequestInstruction'), expectedObjectRevision: after.revision, field: 'text',
      classification: 'sensitive', requiredMarkings: ['health'], channels: ['agent_response', 'registered_model'] }, f.policy.revision());
    withAuthorization(f.scope(), () => assert.equal(f.graph.read(f.owner, f.ref('RequestInstruction')).properties.text, undefined,
      'Current field restrictions still redact the original instruction'));
  } finally { f.close(); }
});

test('rebinding unchanged versions does not rescan the entire request read history', t => {
  const f = fixture(), original = DatabaseSync.prototype.prepare;
  let historyScans = 0;
  try {
    withAuthorization(f.scope(), () => f.graph.read(f.owner, f.asset));
    t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
      if (sql.startsWith('SELECT r.body FROM security_reads r JOIN security_grants issued')) historyScans++;
      return original.call(this, sql);
    });
    const before = f.binding('RequestInstruction');
    withAuthorization(f.scope(), () => f.policy.bindTaskProjection(f.owner, f.task.id));
    assert.equal(historyScans, 0);
    assert.deepEqual(f.binding('RequestInstruction'), before);
  } finally { f.close(); }
});

test('changed projection content under the same version cannot reuse its original evidence', () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE ontology_objects SET body=json_set(body,'$.properties.text','Changed without a new version') WHERE owner=? AND type='RequestInstruction' AND id=?")
      .run(f.owner, f.ref('RequestInstruction').id);
    assert.throws(() => f.jobs.security.withAgent(f.principal, f.task.id, 'task.query', () => f.graph.read(f.owner, f.ref('RequestInstruction'))), /POLICY_CHANGED/);
    assert.throws(() => withAuthorization(f.scope(), () => f.policy.bindTaskProjection(f.owner, f.task.id)), /POLICY_CHANGED/);
  } finally { f.close(); }
});

test('a sealed projection cannot silently lose an existing input dependency', () => {
  const f = fixture();
  try {
    const binding = f.binding('RequestInstruction');
    assert(binding.inputEnvelope!.lineage.length);
    binding.inputEnvelope!.lineage = [];
    f.db.prepare("UPDATE security_bindings SET body=? WHERE grant_id=? AND type='RequestInstruction'")
      .run(JSON.stringify(binding), f.grant.id);
    assert.throws(() => f.jobs.security.withAgent(f.principal, f.task.id, 'task.query', () => f.graph.read(f.owner, f.ref('RequestInstruction'))), /POLICY_CHANGED/);
    assert.throws(() => withAuthorization(f.scope(), () => f.policy.bindTaskProjection(f.owner, f.task.id)), /POLICY_CHANGED/);
  } finally { f.close(); }
});

test('legacy projection bindings retain their existing restrictions when first sealed', () => {
  const f = fixture();
  try {
    const previous = f.binding('RequestInstruction');
    delete previous.projectionOrigin;
    f.db.prepare("UPDATE security_bindings SET body=? WHERE grant_id=? AND type='RequestInstruction'")
      .run(JSON.stringify(previous), f.grant.id);
    withAuthorization(f.scope(), () => {
      f.graph.read(f.owner, f.asset);
      f.policy.bindTaskProjection(f.owner, f.task.id);
    });
    const current = f.binding('RequestInstruction');
    assert(current.projectionOrigin);
    for (const old of previous.inputEnvelope!.lineage) assert(current.inputEnvelope!.lineage.some(value => JSON.stringify(value) === JSON.stringify(old)));
    assert(current.inputEnvelope!.lineage.some(value => value.object.id === f.asset.id), 'An unsealed legacy record is initialized conservatively');
  } finally { f.close(); }
});

test('an outgoing relationship change refreshes evidence even when object properties retain their version', () => {
  const f = fixture();
  try {
    const context = f.ref('ExecutionContext'), before = f.binding('ExecutionContext');
    const edge = f.db.prepare('SELECT * FROM ontology_links WHERE owner=? AND from_type=? AND from_id=?').get(f.owner, context.type, context.id)!;
    assert(edge);
    withAuthorization(f.scope(), () => {
      f.graph.read(f.owner, f.asset);
      f.db.prepare('DELETE FROM ontology_links WHERE owner=? AND type=? AND from_type=? AND from_id=? AND to_type=? AND to_id=?')
        .run(f.owner, edge.type!, edge.from_type!, edge.from_id!, edge.to_type!, edge.to_id!);
      f.policy.bindTaskProjection(f.owner, f.task.id);
    });
    const after = f.binding('ExecutionContext');
    assert.equal(after.revision, before.revision);
    assert.equal(after.projectionOrigin!.contentDigest, before.projectionOrigin!.contentDigest);
    assert.notEqual(after.projectionOrigin!.linksDigest, before.projectionOrigin!.linksDigest);
    assert(after.inputEnvelope!.lineage.some(value => value.object.id === f.asset.id));
    f.db.prepare(`INSERT INTO ontology_links (${Object.keys(edge).join(',')}) VALUES (${Object.keys(edge).map(() => '?').join(',')})`).run(...Object.values(edge));
    withAuthorization(f.scope(), () => f.policy.bindTaskProjection(f.owner, f.task.id));
    assert(f.binding('ExecutionContext').inputEnvelope!.lineage.some(value => value.object.id === f.asset.id), 'Restoring the relationship does not erase the intervening input restriction');
  } finally { f.close(); }
});

test('a new same-value output retains newly seen sensitive input constraints', () => {
  const f = fixture(), content = { answer: 'The same visible answer' };
  try {
    withAuthorization(f.scope(), () => {
      f.graph.read(f.owner, f.ref('RequestInstruction'));
      f.policy.recordOutput(f.owner, f.task.id, 'same-value', content, f.policy.outputEnvelope(f.owner));
      assert(f.policy.output(f.owner, f.task.id, 'same-value', content));
    });
    withAuthorization(f.scope(), () => {
      f.graph.read(f.owner, f.asset);
      f.policy.recordOutput(f.owner, f.task.id, 'same-value', content, f.policy.outputEnvelope(f.owner));
    });
    const row = f.db.prepare("SELECT body FROM security_outputs WHERE owner=? AND task_id=? AND output_id='same-value'").get(f.owner, f.task.id)!;
    assert(JSON.parse(String(row.body)).lineage.some((value: { object: { id: string } }) => value.object.id === f.asset.id));
    f.policy.restrictObject({ ownerKey: f.owner, object: f.asset, expectedObjectRevision: 1, field: 'name',
      classification: 'sensitive', requiredMarkings: ['health'], channels: ['agent_response', 'registered_model'] }, f.policy.revision());
    withAuthorization(f.scope(), () => assert.equal(f.policy.output(f.owner, f.task.id, 'same-value', content), undefined));
  } finally { f.close(); }
});

test('replacement consent retains object provenance without retaining withdrawn data permission', () => {
  const f = fixture();
  try {
    withAuthorization(f.scope(), () => {
      f.graph.read(f.owner, f.asset);
      assert(f.jobs.checkpoint(f.claim, job => { job.delegation!.phase = 'planning'; }));
    });
    const instruction = f.binding('RequestInstruction'), context = f.binding('ExecutionContext');
    f.jobs.release(f.claim);
    f.jobs.security.revokeGrant(f.owner, f.grant.id, f.grant.revision);
    const replacement = f.jobs.security.issueTaskGrant({ ...f.grant, id: randomUUID(), inputs: [] });
    f.policy.bindTaskProjection(f.owner, f.task.id);
    assert.deepEqual(f.binding('RequestInstruction', replacement.id).inputEnvelope, instruction.inputEnvelope);
    assert.deepEqual(f.binding('ExecutionContext', replacement.id).inputEnvelope, context.inputEnvelope);
    f.jobs.security.withAgent(f.principal, f.task.id, 'task.query', () => {
      assert.equal(f.graph.read(f.owner, f.ref('RequestInstruction')).properties.text, 'Original owner instruction');
      assert.throws(() => f.graph.read(f.owner, f.asset), /not available|INSUFFICIENT_ACCESS|OUTPUT_NOT_ALLOWED/);
      assert.throws(() => f.graph.read(f.owner, f.ref('ExecutionContext')), /not available|INSUFFICIENT_ACCESS|OUTPUT_NOT_ALLOWED/);
    });
  } finally { f.close(); }
});

test('distinct model decision identities cannot share provenance merely because their visible state matches', () => {
  const f = fixture(), raw = new OntologyObjectStore(f.db, f.policy.model, Date.now, undefined, { skipLegacyMigration: true });
  try {
    // Valid typed ledger projections only; these fixture records do not create
    // executable plans, model receipts or provider authority.
    const plan = (sequence: number) => {
      const ref = { type: 'ExecutionPlan', id: randomUUID() }, planId = randomUUID();
      raw.ingest(f.owner, { objects: [{ ref, properties: { id: ref.id, displayTitle: 'The same visible plan', planId,
        planDigest: digest(planId), requestRevision: 1, kind: 'agent', sequence, state: 'ready',
        structureDigest: digest('same visible action shape'), createdAt: new Date().toISOString(), modelRunId: randomUUID() } }], links: [
        { type: 'ExecutionPlanRequest', from: ref, to: { type: 'ServiceRequest', id: f.task.id } },
        { type: 'ExecutionPlanContext', from: ref, to: f.ref('ExecutionContext') },
      ] }, { kind: 'task', id: f.task.id, observedAt: new Date().toISOString() });
      return ref;
    };
    const first = plan(1);
    f.policy.bindTaskProjection(f.owner, f.task.id);
    let second: ReturnType<typeof plan>;
    withAuthorization(f.scope(), () => {
      f.graph.read(f.owner, f.asset);
      second = plan(2);
      f.policy.bindTaskProjection(f.owner, f.task.id);
    });
    const binding = (id: string): ObjectBinding => JSON.parse(String(f.db.prepare("SELECT body FROM security_bindings WHERE grant_id=? AND type='ExecutionPlan' AND object_id=?").get(f.grant.id, id)!.body));
    assert(!binding(first.id).inputEnvelope!.lineage.some(value => value.object.id === f.asset.id));
    assert(binding(second!.id).inputEnvelope!.lineage.some(value => value.object.id === f.asset.id));
    f.policy.restrictObject({ ownerKey: f.owner, object: f.asset, expectedObjectRevision: 1, field: 'name',
      classification: 'sensitive', requiredMarkings: ['health'], channels: ['agent_response', 'registered_model'] }, f.policy.revision());
    f.jobs.security.withAgent(f.principal, f.task.id, 'task.query', () => {
      assert.equal(f.graph.read(f.owner, first).properties.state, 'ready');
      assert.throws(() => f.graph.read(f.owner, second!), /not available|INSUFFICIENT_ACCESS|OUTPUT_NOT_ALLOWED/);
    });
    assert.equal(f.jobs.intents(f.owner, f.task.id).length, 0);
  } finally { f.close(); }
});
