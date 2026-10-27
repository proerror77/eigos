import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ParticipantBookingProgram } from '../packages/capabilities/free-booking/program.js';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { DefinitionService } from '../packages/ontology/definition-service.js';
import { securityFixture } from './fixtures/security.js';
import { securedProgramFixture } from './fixtures/secured-program.js';
import { participantFixture } from './fixtures/free-booking.js';
import { participantIntake, pipelineEventType } from './fixtures/ontology-pipeline.js';
import { OntologyModel } from '../packages/ontology/model.js';
import { z } from 'zod';

function foundationValidationFixture(parentLifetimeMs = 3600000) {
  let offset = 0;
  const now = () => Date.now() + offset;
  const source = participantFixture(), calls: string[] = [], call = source.source.call.bind(source.source);
  source.source.call = async (...args) => { calls.push(args[1]); return call(...args); };
  const base = securityFixture(now, { unified: true });
  const f = securedProgramFixture(() => new ParticipantBookingProgram(source.source), source.input, (ctx, access) => {
    access.session.call('describe_ontology', { search: 'RegistrationTask', limit: 1 });
    access.session.call('query_ontology', { object: ctx.state.scope });
    const record = ctx.state.observations.at(-1);
    if (record) {
      access.session.call('query_ontology', { object: record });
      access.session.call('evaluate_ontology', { function: 'registrationStatus', object: record });
    }
    return { kind: record ? 'complete' : 'execute', requestRevision: ctx.request.revision, message: 'Read an existing synthetic registration only',
      steps: record ? [] : [{ id: 'read', action: 'ReadParticipantRegistration', argumentsJson: JSON.stringify({ scope: ctx.state.scope }), dependsOn: [], inputRefs: [] }],
      completionJson: record ? JSON.stringify({ registration: record, rationale: 'Independent read of an existing synthetic registration' }) : '' };
  }, base, { nativeTaskContext: true, grantExpiresAt: new Date(now() + parentLifetimeMs).toISOString() });
  const intake = participantIntake(f.jobs.ontology.model, f.program);
  intake.actions = intake.actions.filter(action => action.actionId === 'ReadParticipantRegistration');
  const namespace = f.jobs.definitions.namespace('eigos.business');
  let draft = f.jobs.definitions.createDraft(f.owner, namespace.id, 'Synthetic read-only service validation', true);
  draft = f.jobs.definitions.putPipeline(f.owner, draft.id, draft.revision, intake, true);
  f.jobs.definitions.validatePipeline(f.owner, draft.id, draft.revision, intake.serviceId, new Date(now() + 3600000).toISOString(), true);
  const release = f.jobs.definitions.publish(f.owner, draft.id, draft.revision, true).release;
  f.jobs.definitions.activate(f.owner, release, namespace.generation, true);
  const definitions = new DefinitionService(f.jobs, f.tasks, f.catalog);
  const request = () => ({ ontologyId: namespace.id, release, serviceId: intake.serviceId, requestId: randomUUID(),
    goal: 'Read and independently confirm an existing synthetic registration; do not submit or pay', expiresAt: new Date(now() + 300000).toISOString() });
  const status = () => f.jobs.ontology.pipelineStatus(f.owner, f.program.ref, f.program.configurationDigest, 'ReadParticipantRegistration');
  return { ...f, intake, release, definitions, request, status, now, calls, source,
    elapse: (milliseconds: number) => { f.coordinator.close(); offset += milliseconds; f.coordinator.start(); }, close: () => { f.close(); source.store.close(); } };
}

test('foundation validation uses the unified authority, current parent grant and a bounded read-only task', async () => {
  const f = foundationValidationFixture();
  try {
    assert.equal(f.status().status, 'verification_required');
    assert.equal(f.jobs.ontology.model.ref.digest, f.jobs.security.model.ref.digest);
    assert.notEqual(f.jobs.ontology.model.ref.version, f.jobs.security.model.ref.version, 'The published intake keeps its own immutable release label');
    const args = f.request();
    assert.throws(() => f.tasks.preparePipelineValidation({ ...f.p, scopes: f.p.scopes.filter(scope => scope !== 'ontology:publish') }, args), /scope|permission|AUTHORIZATION_REQUIRED/i);
    assert.throws(() => f.tasks.preparePipelineValidation(f.p, { ...args, expiresAt: new Date(f.now() + 601000).toISOString() }), /ten minutes/);
    const task = f.tasks.preparePipelineValidation(f.p, args);
    assert.equal(task.authorityId, f.authority!.id);
    assert.equal(f.tasks.preparePipelineValidation(f.p, args).id, task.id);
    const grant = f.jobs.security.taskGrant(f.jobs.security.agentContext(f.p), task.id), authority = f.jobs.security.workAuthority(f.owner, task.id)!;
    assert.equal(grant.purpose, 'delegated_task');
    assert.equal(grant.expiresAt, args.expiresAt);
    assert.equal(authority.expiresAt, grant.expiresAt);
    assert.equal(grant.parentGrant.id, f.jobs.security.agentGrant(f.a.id).id);
    const graph = f.jobs.ontologyForJob(f.owner, task.id);
    assert.equal(graph.pipelineStatus(f.owner, f.program.ref, f.program.configurationDigest, 'ReadParticipantRegistration').status, 'validation_only');
    assert.equal(graph.pipelineStatus(f.owner, f.program.ref, f.program.configurationDigest, 'SubmitFreeRegistrationSandbox').status, 'definition_only');
    const db = new DatabaseSync(f.database, { readOnly: true });
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM plan_grants').get()!.n, 0); } finally { db.close(); }
    assert.equal(f.calls.length, 0);
    const done = await f.advance(task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.deepEqual(f.calls, ['ReadParticipantRegistration']);
    assert.equal(f.source.counters().submits, 0);
    assert.equal(f.status().status, 'verification_required', 'Task completion cannot enroll its own execution evidence');
    const reader = new JobStore(f.database, { securityMode: 'foundation', securityNow: f.now, authority: f.authority });
    try {
      const readback = new TaskService(reader, { catalog: new ExecutionCatalog([], [], []) }).get(f.p, task.id);
      assert.equal(readback.authorityId, f.authority!.id);
      assert.equal('accepted' in readback && readback.accepted, true);
      assert(!Object.hasOwn(readback, 'delegation'));
    } finally { reader.close(); }
    const original = f.jobs.ontology.model.definitionSnapshot();
    const changed = new OntologyModel({ ...original, objects: original.objects.map(object => object.id === 'ServiceRequest' ? { ...object, description: 'Unreviewed business definition' } : object) });
    assert.throws(() => f.jobs.security.withAgent(f.p, task.id, 'task.query', () => graph.forModel(changed, { ontologyId: graph.ontologyId, releaseRef: f.release }).read(f.owner, { type: 'ServiceRequest', id: task.id })), /POLICY_CHANGED/);
    f.coordinator.revokeInstallation(f.member.id, f.a.id);
    assert.throws(() => f.tasks.get(f.p, task.id), /ACCESS_REVOKED/);
  } finally { f.close(); }
});

test('Foundation intake publication cannot adopt unreviewed business definitions or legacy metadata edits', () => {
  const f = foundationValidationFixture();
  try {
    const active = f.jobs.definitions.namespace('eigos.business');
    let draft = f.jobs.definitions.createDraft(f.owner, active.id, 'Unreviewed schema candidate', true);
    assert.throws(() => f.definitions.command(f.p, { operation: 'put_definition', ontologyId: active.id, draftId: draft.id,
      expectedRevision: draft.revision, kind: 'object', definition: pipelineEventType }), /separately reviewed Foundation interface/);
    // Simulate an existing operator-authored draft from the separate model
    // review workflow. The public Pipeline path cannot publish its new fields.
    draft = f.jobs.definitions.putResource(f.owner, draft.id, draft.revision, 'object', pipelineEventType, true);
    assert.throws(() => f.definitions.command(f.p, { operation: 'publish_draft', ontologyId: active.id, draftId: draft.id, expectedRevision: draft.revision }), /POLICY_CHANGED/);
    assert.equal(f.jobs.definitions.draft(draft.id).status, 'open');
    const published = f.jobs.definitions.publish(f.owner, draft.id, draft.revision, true);
    assert.throws(() => f.definitions.command(f.p, { operation: 'activate_release', ontologyId: active.id, release: published.release, expectedGeneration: active.generation }), /POLICY_CHANGED/);
    assert.deepEqual(f.jobs.definitions.namespace(active.id), active);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('foundation validation rejects missing source authority atomically and preserves controller isolation', () => {
  const f = foundationValidationFixture();
  try {
    const other = f.installation('No delegated source'), parent = f.approve(other.id);
    const p = { ...f.principal, access: f.coordinator.authenticate(f.principal, other.token) }, args = f.request();
    assert.throws(() => f.tasks.preparePipelineValidation(p, args), /AUTHORIZATION_REQUIRED|SOURCE_NOT_AUTHORIZED/);
    assert.equal(f.jobs.list(f.owner, { offset: 0, limit: 10 }).total, 0);
    assert(!f.jobs.security.listGrants(f.owner).some(grant => grant.kind === 'task_data'));
    assert.equal(f.jobs.security.agentGrant(other.id).id, parent.id);
    assert.equal(f.calls.length, 0);
    const task = f.tasks.preparePipelineValidation(f.p, args);
    const query = { operation: 'get_pipeline_task_uses', ontologyId: 'eigos.business', taskId: task.id };
    assert.throws(() => f.definitions.query(p, query), /AUTHORIZATION_REQUIRED/);
    assert.throws(() => f.definitions.query({ ...f.p, subject: 'different-member' }, query), /AUTHORIZATION_REQUIRED/);
    const source = f.policy.sources(f.owner, f.a.id)[0]!;
    f.policy.revokeSource(f.owner, f.a.id, source.bindingId, f.policy.revision());
    assert.equal(f.jobs.security.workAuthority(f.owner, task.id), undefined);
    assert.equal(f.jobs.claim(['eigos.delegate'], 30000), undefined);
    assert.throws(() => f.tasks.preparePipelineValidation(f.p, args), /AUTHORIZATION_REQUIRED|ACCESS_REVOKED/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

for (const parentLifetimeMs of [120000, 3600000]) test(`foundation validation expires with the shorter task or parent window (${parentLifetimeMs})`, () => {
  const f = foundationValidationFixture(parentLifetimeMs);
  try {
    const args = f.request(), task = f.tasks.preparePipelineValidation(f.p, args), actor = f.jobs.security.agentContext(f.p);
    const grant = f.jobs.security.taskGrant(actor, task.id), parent = f.jobs.security.agentGrant(f.a.id);
    assert.equal(Date.parse(grant.expiresAt), Math.min(Date.parse(args.expiresAt), Date.parse(parent.expiresAt)));
    const count = f.jobs.security.listGrants(f.owner).length;
    f.elapse(Date.parse(grant.expiresAt) - f.now() + 1);
    assert.equal(f.jobs.security.workAuthority(f.owner, task.id), undefined);
    assert.equal(f.jobs.claim(['eigos.delegate'], 30000, f.now()), undefined);
    assert.throws(() => f.tasks.get(f.p, task.id), /AUTHORIZATION_REQUIRED|ACCESS_REVOKED/);
    assert.throws(() => f.tasks.preparePipelineValidation(f.p, args), /AUTHORIZATION_REQUIRED|ACCESS_REVOKED/);
    assert.equal(f.jobs.security.listGrants(f.owner).length, count, 'An idempotent retry cannot renew an expired grant');
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

for (const invalidation of ['expired', 'revoked'] as const) test(`foundation evidence enables ordinary tasks, then ${invalidation} evidence blocks new source selection`, async () => {
  const f = foundationValidationFixture();
  try {
    const prepared = z.object({ task: z.object({ id: z.uuid() }).passthrough(), validationOnly: z.literal(true) }).parse(f.definitions.command(f.p, { operation: 'prepare_pipeline_validation', ...f.request() }).result);
    assert(!Object.hasOwn(prepared.task, 'delegation'), 'Management preparation must retain the public task projection');
    const done = await f.advance(prepared.task.id); assert.equal(done.state, 'completed');
    const review = f.jobs.definitions.createDraft(f.owner, 'eigos.business', 'Review independently accepted read', true);
    const verification = z.object({ id: z.string(), level: z.literal('synthetic'), authorizationProof: z.literal(false) }).parse(f.definitions.command(f.p, { operation: 'verify_pipeline_task', ontologyId: 'eigos.business',
      draftId: review.id, expectedRevision: review.revision, serviceId: f.intake.serviceId, taskId: done.id, expiresAt: new Date(f.now() + 60000).toISOString() }).result);
    assert.equal(verification.level, 'synthetic'); assert.equal(verification.authorizationProof, false);
    assert.equal(f.status().status, 'verified');
    const uses = z.object({ items: z.array(z.object({ status: z.string() })) }).parse(f.definitions.query(f.p, { operation: 'get_pipeline_task_uses', ontologyId: 'eigos.business', taskId: done.id }).result);
    assert(uses.items.length > 0 && uses.items.every(use => use.status === 'validation_only'));
    const observer = f.installation('Task metadata observer'), observerParent = f.approve(observer.id), until = observerParent.expiresAt;
    f.policy.setRole({ subjectKind: 'installation', subjectId: observer.id, resource: { kind: 'namespace', id: f.policy.model.ref.id, version: f.policy.model.ref.digest }, role: 'Viewer', expiresAt: until }, f.policy.revision());
    f.policy.setRecipient(observer.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'], channels: ['agent_response'], expiresAt: until }, f.policy.revision());
    const controllerGrant = f.jobs.security.taskGrant(f.jobs.security.agentContext(f.p), done.id);
    f.jobs.security.issueTaskGrant({ ...controllerGrant, id: randomUUID(), installationId: observer.id, parentGrant: { id: observerParent.id, revision: observerParent.revision },
      inputs: [], outputs: [], operations: ['task.query', 'task.result.read'], channels: ['agent_response'] });
    const observerPrincipal = { ...f.principal, access: f.coordinator.authenticate(f.principal, observer.token) };
    const hiddenUses = z.object({ items: z.array(z.unknown()) }).parse(f.definitions.query(observerPrincipal, { operation: 'get_pipeline_task_uses', ontologyId: 'eigos.business', taskId: done.id }).result);
    assert.deepEqual(hiddenUses.items, [], 'Task metadata read authority must not reveal another installation\'s source-use ledger');
    const ordinary = f.tasks.submit(f.p, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Read the existing synthetic registration only', executionEnvironment: 'sandbox' });
    const actionQuery = (taskId: string) => z.object({ items: z.array(z.object({ bindings: z.array(z.object({ readiness: z.string() })) })) }).parse(f.definitions.query(f.p, {
      operation: 'discover_task_actions', ontologyId: 'eigos.business', taskId, query: { actionId: 'ReadParticipantRegistration' },
    }).result);
    assert(actionQuery(ordinary.id).items.some(item => item.bindings.some(binding => binding.readiness === 'ready')));
    assert.equal((await f.advance(ordinary.id)).state, 'completed');
    assert.deepEqual(f.calls, ['ReadParticipantRegistration', 'ReadParticipantRegistration']);
    if (invalidation === 'expired') f.elapse(61000);
    else f.definitions.command(f.p, { operation: 'revoke_pipeline_verification', ontologyId: 'eigos.business', serviceId: f.intake.serviceId, verificationId: verification.id });
    assert.equal(f.status().status, invalidation);
    const blocked = f.tasks.submit(f.p, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Read after evidence invalidation', executionEnvironment: 'sandbox' });
    const discovery = actionQuery(blocked.id);
    assert(discovery.items.length > 0 && discovery.items[0]!.bindings.length > 0 && discovery.items[0]!.bindings.every(binding => binding.readiness === 'pipeline_unverified'));
    assert.equal(f.calls.length, 2);
    assert.equal(f.source.counters().submits, 0);
  } finally { f.close(); }
});
