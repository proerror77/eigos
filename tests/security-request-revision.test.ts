import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { securityFixture } from './fixtures/security.js';
import { fixtureCapability, syntheticGoalReview } from './backend-fixture.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { TaskService } from '../packages/core/tasks.js';
import { createGoalCoverage, assertGoalCoverage } from '../packages/ontology/goal-coverage.js';
import { currentKernelImplementation } from '../packages/ontology/definition-store.js';
import { withAuthorization } from '../packages/security/context.js';
import { taskContextFields } from '../packages/security/task-context.js';
import { groundRequirements } from '../packages/coordinator/requirements.js';
import { executionContextRef } from '../packages/ontology/execution-projection.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';

async function fixture(options: { context?: boolean } = {}) {
  const f = securityFixture(Date.now, { unified: true }), installation = f.installation('Revision-scoped PA');
  const policy = f.jobs.security.policies, until = new Date(Date.now() + 3600000).toISOString(), model = currentKernelImplementation();
  const resources = ['ServiceRequest', 'GoalCoverage', 'OutcomeAssessment', 'ExecutionFeedback', ...(options.context ? Object.keys(taskContextFields) : [])].map(type => ({ type,
    fields: Object.entries(policy.fields(type)).filter(([field, definition]) => !definition.restricted && policy.fieldPolicy(type, field) !== 'internal_only').map(([field]) => field) }));
  const parent = f.coordinator.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: ['brief.prepare'], resources,
    sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt: until });
  policy.setRole({ subjectKind: 'installation', subjectId: installation.id, resource: { kind: 'namespace', id: model.ref.id, version: model.ref.digest }, role: 'Viewer', expiresAt: until }, policy.revision());
  policy.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private', 'personal_data', ...(options.context ? ['precise_location', 'financial', 'health'] : [])], channels: ['agent_response', 'registered_model'], expiresAt: until }, policy.revision());
  const principal = { ...f.principal, access: f.coordinator.authenticate(f.principal, installation.token) };
  const tasks = new TaskService(f.jobs, { catalog: new ExecutionCatalog([], [], []) });
  const task = tasks.submit(principal, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Prepare a brief for Old station' });
  const job = f.jobs.get(f.owner, task.id), capability = { ...fixtureCapability, ref: { id: 'brief.prepare', version: '2' } }, input = { goal: job.goal };
  if (options.context) job.delegation!.request.requirements = [{ id: 'destination', strength: 'hard', kind: 'location', role: 'destination', expected: { ref: 'Old station' },
    provenance: { source: 'pa', interpretation: 'quoted_text', messageId: job.delegation!.request.messages[0]!.id, receivedAt: job.createdAt, quote: 'Old station' } }];
  const review = await syntheticGoalReview({ request: job.delegation!.request, capability, input });
  const coverage = createGoalCoverage({ request: job.delegation!.request, capability, input }, review.decision, review.evidence);
  job.state = 'input-required'; job.question = 'Which public place should the brief use?'; job.delegation!.goalCoverage = coverage;
  f.jobs.save(f.owner, job);
  const previousGrant = f.jobs.security.taskGrant(f.jobs.security.agentContext(principal), task.id);
  const db = new DatabaseSync(f.database);
  const storedCoverage = () => db.prepare("SELECT body,revision FROM ontology_objects WHERE owner=? AND type='GoalCoverage' AND id=?").get(f.owner, coverage.digest);
  const originalCoverage = storedCoverage();
  return { ...f, installation, principal, tasks, task, capability, input, coverage, parent, previousGrant, db, storedCoverage, originalCoverage,
    reply: () => tasks.reply(principal, { taskId: task.id, requestId: randomUUID(), expectedRevision: task.revision, answer: 'Use the public subway station' }),
    close: () => { db.close(); f.close(); } };
}

test('a Foundation reply retires the old goal review and the next Worker claims the same task under its new grant', async () => {
  const f = await fixture();
  try {
    const reply = f.reply();
    const claim = f.jobs.claim(['eigos.delegate'], 60000);
    assert(claim); assert.equal(claim.job.id, f.task.id); assert.equal(reply.id, f.task.id);
    const current = f.jobs.get(f.owner, f.task.id), grant = f.jobs.security.taskGrant(f.jobs.security.agentContext(f.principal), f.task.id);
    assert.equal(current.delegation!.request.revision, 2); assert.equal(current.delegation!.outcome!.requestRevision, 2);
    assert.equal(current.delegation!.goalCoverage, undefined); assert.deepEqual(current.delegation!.goalCoverageHistory, [f.coverage]);
    assert.throws(() => assertGoalCoverage(current, f.capability), /independently reviewed goal/);
    assert.notEqual(grant.id, f.previousGrant.id); assert.equal(grant.requestRevision, 2); assert.equal(grant.expiresAt, f.previousGrant.expiresAt);
    assert.equal(f.jobs.security.listGrants(f.owner).find(value => value.id === f.previousGrant.id)!.status, 'revoked');
    assert.deepEqual(f.jobs.security.agentGrant(f.installation.id), f.parent);
    assert.deepEqual(f.storedCoverage(), f.originalCoverage, 'The prior immutable review remains available for audit');
    const query = (id: string) => f.tasks.queryOntology(f.principal, { version: 2, taskId: f.task.id, query: { object: { type: 'GoalCoverage', id } } });
    assert.throws(() => query(f.coverage.digest), /not available/, 'The new grant cannot read the old review');
    const context = { request: current.delegation!.request, capability: f.capability, input: f.input }, review = await syntheticGoalReview(context);
    const next = createGoalCoverage(context, review.decision, review.evidence);
    const scope = f.jobs.security.workerScope(f.owner, f.task.id, claim.securityAuthorityId!, claim.token);
    assert.equal(withAuthorization(scope, () => f.jobs.checkpoint(claim, job => { job.delegation!.goalCoverage = next; })), true);
    assert.equal(query(next.digest).items[0]!.ref.id, next.digest, 'A fresh review can be bound to the current grant');
  } finally { f.close(); }
});

test('the next claim repairs a persisted prior-revision review without rewriting its history or task authorization', async () => {
  const f = await fixture();
  try {
    f.reply();
    const legacy = f.jobs.get(f.owner, f.task.id); legacy.delegation!.goalCoverage = f.coverage; delete legacy.delegation!.goalCoverageHistory;
    // Reproduce the canonical record left by the older reply path, only in this synthetic database.
    f.db.prepare('UPDATE jobs SET body=? WHERE owner=? AND id=?').run(JSON.stringify(legacy), f.owner, legacy.id);
    const grants = f.jobs.security.listGrants(f.owner), claim = f.jobs.claim(['eigos.delegate'], 60000);
    assert(claim); assert.equal(claim.job.id, legacy.id); assert.equal(claim.job.delegation!.request.revision, 2);
    assert.equal(claim.job.delegation!.goalCoverage, undefined); assert.deepEqual(claim.job.delegation!.goalCoverageHistory, [f.coverage]);
    f.jobs.save(f.owner, claim.job);
    assert.deepEqual(f.jobs.get(f.owner, legacy.id).delegation!.goalCoverageHistory, [f.coverage]);
    assert.deepEqual(f.jobs.security.listGrants(f.owner), grants); assert.deepEqual(f.storedCoverage(), f.originalCoverage);
  } finally { f.close(); }
});

test('a future-revision goal review still fails the Foundation projection boundary', async () => {
  const f = await fixture();
  try {
    const current = f.jobs.get(f.owner, f.task.id), request = { ...current.delegation!.request, revision: 2 };
    const context = { request, capability: f.capability, input: f.input }, review = await syntheticGoalReview(context);
    current.delegation!.goalCoverage = createGoalCoverage(context, review.decision, review.evidence);
    assert.throws(() => f.jobs.save(f.owner, current), /POLICY_CHANGED/);
    assert.deepEqual(f.jobs.get(f.owner, f.task.id).delegation!.goalCoverage, f.coverage);
  } finally { f.close(); }
});

test('re-grounding a corrected input retains its observed predecessor lineage and current label checks', async () => {
  const f = await fixture({ context: true });
  try {
    f.reply(); const claim = f.jobs.claim(['eigos.delegate'], 60000)!;
    const scope = f.jobs.security.workerScope(f.owner, f.task.id, claim.securityAuthorityId!, claim.token), graph = f.jobs.ontologyForJob(f.owner, claim.job);
    const specification = executionContextRef(f.task.id, 2).id;
    const constraint = () => String(f.db.prepare("SELECT to_id FROM ontology_links WHERE owner=? AND type='RequestSpecificationConstraint' AND from_id=?").get(f.owner, specification)!.to_id);
    const oldRef = { type: 'RequestConstraint', id: constraint() }, oldObject = f.db.prepare("SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?").get(f.owner, oldRef.type, oldRef.id)!;
    withAuthorization(scope, () => {
      graph.read(f.owner, oldRef);
      const request = f.jobs.get(f.owner, f.task.id).delegation!.request, message = request.messages.at(-1)!;
      const grounded = groundRequirements(request, JSON.stringify([{ requirement: { id: 'destination', strength: 'hard', kind: 'location', role: 'destination', expected: { ref: 'public subway station' } },
        messageId: message.id, quote: 'public subway station' }]), [], [{ kind: 'location', role: 'destination', description: 'Fixture destination' }]);
      assert.equal(f.jobs.checkpoint(claim, job => { job.delegation!.request = grounded; }), true);
    });
    const nextRef = { type: 'RequestConstraint', id: constraint() }; assert.notEqual(nextRef.id, oldRef.id);
    assert.deepEqual(f.db.prepare("SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?").get(f.owner, oldRef.type, oldRef.id), oldObject);
    const query = (ref: typeof oldRef) => f.tasks.queryOntology(f.principal, { version: 2, taskId: f.task.id, query: { object: ref } });
    assert.equal(query(oldRef).items[0]!.ref.id, oldRef.id);
    assert.deepEqual(query(nextRef).items[0]!.properties.expected, { ref: 'public subway station' });
    f.jobs.security.policies.restrictObject({ ownerKey: f.owner, object: oldRef, expectedObjectRevision: Number(oldObject.revision), field: 'expected', classification: 'internal', requiredMarkings: ['member_private'], channels: [] }, f.jobs.security.policies.revision());
    assert.throws(() => query(nextRef), /not available|OUTPUT_NOT_ALLOWED/, 'Current restrictions on historical inputs still taint their derived interpretation');
  } finally { f.close(); }
});

test('predecessor links cannot import another task or a future input revision into current task metadata', async () => {
  const f = await fixture({ context: true });
  try {
    const current = f.db.prepare("SELECT to_id FROM ontology_links WHERE owner=? AND type='RequestSpecificationConstraint' AND from_id=?").get(f.owner, executionContextRef(f.task.id, 1).id)!;
    const from = { type: 'RequestConstraint', id: String(current.to_id) }, raw = new OntologyObjectStore(f.db, currentKernelImplementation(), Date.now, undefined, { skipLegacyMigration: true });
    const original = raw.read(f.owner, from), future = { type: 'RequestConstraint', id: randomUUID() };
    const other = f.tasks.submit(f.principal, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Another task for Foreign station' }), otherJob = f.jobs.get(f.owner, other.id);
    otherJob.delegation!.request.requirements = [{ id: 'destination', strength: 'hard', kind: 'location', role: 'destination', expected: { ref: 'Foreign station' }, provenance: {
      source: 'pa', interpretation: 'quoted_text', messageId: otherJob.delegation!.request.messages[0]!.id, receivedAt: otherJob.createdAt, quote: 'Foreign station' } }];
    f.jobs.save(f.owner, otherJob);
    const foreign = { type: 'RequestConstraint', id: String(f.db.prepare("SELECT to_id FROM ontology_links WHERE owner=? AND type='RequestSpecificationConstraint' AND from_id=?").get(f.owner, executionContextRef(other.id, 1).id)!.to_id) };
    assert.equal(f.tasks.queryOntology(f.principal, { version: 2, taskId: other.id, query: { object: foreign } }).items[0]!.ref.id, foreign.id);
    raw.ingest(f.owner, { objects: [], links: [{ type: 'RequestConstraintPredecessor', from, to: foreign }] }, { kind: 'task', id: f.task.id, observedAt: new Date().toISOString() });
    f.jobs.security.policies.bindTaskProjection(f.owner, f.task.id);
    const query = (ref: typeof from) => f.tasks.queryOntology(f.principal, { version: 2, taskId: f.task.id, query: { object: ref } });
    assert.throws(() => query(foreign), /not available/);
    raw.ingest(f.owner, { objects: [{ ref: future, properties: { ...original.properties, id: future.id, introducedRevision: 2 } }],
      removeLinks: [{ type: 'RequestConstraintPredecessor', from, to: foreign }], links: [{ type: 'RequestConstraintPredecessor', from, to: future },
        { type: 'RequestConstraintRequest', from: future, to: { type: 'ServiceRequest', id: f.task.id } }] }, { kind: 'task', id: f.task.id, observedAt: new Date().toISOString() });
    f.jobs.security.policies.bindTaskProjection(f.owner, f.task.id);
    assert.throws(() => query(future), /not available/);
    assert.equal(query(from).items[0]!.ref.id, from.id);
  } finally { f.close(); }
});
