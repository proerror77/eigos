import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { digest } from '../packages/core/delegation.js';
import { parsePipelineIntake, verificationCoversAction, type PipelineIntake, type PipelineVerification } from '../packages/ontology/pipeline/contracts.js';
import { mapPipelineFields, mapPipelineObservation } from '../packages/ontology/pipeline/mapping.js';
import { participantFixture } from './fixtures/free-booking.js';
import { eventIntake, participantIntake, pipelineEventType } from './fixtures/ontology-pipeline.js';
import { owner, principal } from './backend-fixture.js';

const expiry = () => new Date(Date.now() + 3600000).toISOString();

test('an independently read final task result does not erase or promote individual action evidence levels', () => {
  // Synthetic DTOs exercise evidence classification only; no live operation.
  const actions: PipelineIntake['actions'] = [{ actionId: 'Submit', definitionDigest: 'a'.repeat(64), requiredEvidence: 'live_operation', readbackActionId: 'Read' },
    { actionId: 'Read', definitionDigest: 'b'.repeat(64), requiredEvidence: 'live_readonly' }];
  const proof: PipelineVerification = { id: 'synthetic-proof', intakeDigest: 'c'.repeat(64), mappingDigest: 'd'.repeat(64), contractDigest: 'e'.repeat(64),
    kind: 'task_evidence', level: 'live_readonly', actionIds: ['Submit', 'Read'], evidenceRefs: ['synthetic:final-read'], verifiedAt: '2026-10-26T01:00:00Z', expiresAt: '2026-10-26T02:00:00Z',
    availabilityProof: false, authorizationProof: false, actionEvidence: { Submit: { level: 'live_operation', evidenceRefs: ['synthetic:write'], observedAt: '2026-10-26T00:59:00Z' }, Read: { level: 'live_readonly', evidenceRefs: ['synthetic:read'], observedAt: '2026-10-26T01:00:00Z' } } };
  assert.equal(verificationCoversAction(actions[0]!, actions, proof), true);
  assert.equal(verificationCoversAction(actions[1]!, actions, proof), true);
  proof.level = 'live_fulfillment'; proof.actionEvidence!.Submit!.level = 'synthetic';
  assert.equal(verificationCoversAction(actions[0]!, actions, proof), false);
  proof.actionEvidence!.Submit!.level = 'live_operation'; delete proof.actionEvidence!.Read;
  assert.equal(verificationCoversAction(actions[0]!, actions, proof), false);
});
function eventDraft(store: JobStore) {
  const namespace = store.definitions.createNamespace(owner, { id: 'pipeline.events', name: 'Synthetic events' });
  let draft = store.definitions.createDraft(owner, namespace.id, 'Add source contract');
  draft = store.definitions.putResource(owner, draft.id, draft.revision, 'object', pipelineEventType);
  const intake = eventIntake(store.ontology.model);
  draft = store.definitions.putPipeline(owner, draft.id, draft.revision, intake);
  return { namespace, draft, intake };
}

test('intakes are versioned with releases, need exact validation, and retain immutable restart history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-pipeline-')), path = join(directory, 'jobs.sqlite');
  let store = new JobStore(path);
  try {
    const { namespace, draft, intake } = eventDraft(store);
    assert.equal(store.definitions.validate(draft.id).valid, false);
    assert.throws(() => store.definitions.publish(owner, draft.id, draft.revision), /fresh mapping validation/);
    const checked = store.definitions.validatePipeline(owner, draft.id, draft.revision, intake.serviceId, expiry());
    assert.equal(checked.valid, true, JSON.stringify(checked));
    const first = store.definitions.publish(owner, draft.id, draft.revision);
    store.definitions.activate(owner, first.release, namespace.generation);
    const original = store.definitions.resolve(first.release).document.pipeline!;
    let next = store.definitions.createDraft(owner, namespace.id, 'Change source mapping');
    const changed = { ...intake, source: { ...intake.source, revision: '2', digest: digest('contract-v2') } };
    next = store.definitions.putPipeline(owner, next.id, next.revision, changed);
    assert.equal(store.definitions.validate(next.id).valid, false);
    assert.throws(() => store.definitions.putPipeline(owner, next.id, next.revision - 1, changed), /revision/);
    assert.throws(() => store.definitions.putPipeline('foreign-owner', next.id, next.revision, changed), /owner|managed|belong|permission/i);
    assert.equal(store.definitions.validatePipeline(owner, next.id, next.revision, changed.serviceId, expiry()).valid, true);
    const second = store.definitions.publish(owner, next.id, next.revision);
    assert.notEqual(second.release.digest, first.release.digest);
    assert.deepEqual(store.definitions.resolve(first.release).document.pipeline, original);
    const db = new DatabaseSync(path);
    try {
      for (const table of ['ontology_pipeline_intakes', 'ontology_pipeline_verifications']) assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable/);
    } finally { db.close(); }
    store.close(); store = new JobStore(path);
    assert.deepEqual(store.definitions.resolve(first.release).document.pipeline, original);
    assert.equal(store.definitions.pipeline.intake(namespace.id, original[0]!).source.revision, '1');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('two provider mappings preserve waitlist semantics, source identity, provenance and freshness', () => {
  const store = new JobStore(':memory:');
  try {
    const f = eventDraft(store);
    store.definitions.validatePipeline(owner, f.draft.id, f.draft.revision, f.intake.serviceId, expiry());
    const release = store.definitions.publish(owner, f.draft.id, f.draft.revision).release, model = store.definitions.resolve(release).model;
    const a = f.intake, b = eventIntake(model, 'b');
    assert.deepEqual(mapPipelineFields(a.mappings[0]!, a.fixtures[0]!.input), mapPipelineFields(b.mappings[0]!, b.fixtures[0]!.input));
    assert.equal(mapPipelineFields(a.mappings[0]!, { ...a.fixtures[0]!.input, state: 'not_documented' }).status, 'unknown');
    const now = Date.now(), sample = { eventId: 'e1', sourceAccount: 'account-a', sourceRevision: a.source.revision, sourceDigest: a.source.digest,
      observedAt: new Date(now - 1000).toISOString(), receivedAt: new Date(now).toISOString(), evidenceRefs: ['synthetic:source'], evidenceLevel: 'synthetic' as const, payload: a.fixtures[0]!.input };
    const first = mapPipelineObservation(model, owner, a, a.mappings[0]!, sample, now);
    assert.equal(first.properties.status, 'waitlisted');
    const moved = mapPipelineObservation(model, owner, a, a.mappings[0]!, { ...sample, payload: { ...sample.payload, place: '场馆 B' } }, now);
    assert.deepEqual(moved.ref, first.ref); assert.notEqual(moved.semanticDigest, first.semanticDigest);
    const other = mapPipelineObservation(model, owner, b, b.mappings[0]!, { ...sample, sourceDigest: b.source.digest, payload: b.fixtures[0]!.input }, now);
    assert.notEqual(other.ref.id, first.ref.id);
    assert.notEqual(mapPipelineObservation(model, 'other-owner', a, a.mappings[0]!, sample, now).ref.id, first.ref.id);
    assert.throws(() => mapPipelineObservation(model, owner, a, a.mappings[0]!, sample, now + 60000), /stale/);
    assert.throws(() => mapPipelineObservation(model, owner, a, a.mappings[0]!, { ...sample, sourceDigest: digest('drift') }, now), /contract changed/);
    assert.throws(() => mapPipelineObservation(model, owner, a, a.mappings[0]!, { ...sample, evidenceLevel: 'live_operation' }, now), /environment/);
    assert.throws(() => parsePipelineIntake({ ...a, mappings: [{ ...a.mappings[0]!, fields: [{ from: ['value'], to: ['constructor'] }] }] }));
  } finally { store.close(); }
});

test('actual accepted task evidence admits only its owner and scope; source drift blocks later dispatch', async t => {
  const f = participantFixture();
  try {
    f.submit(); const proof = await f.until(job => job.state === 'completed');
    const program = f.catalog.agentProgram({ id: 'booking.participant.free', version: '1' }, owner)!;
    const intake = participantIntake(f.store.ontology.model, program), namespace = f.store.definitions.namespace('eigos.business');
    let draft = f.store.definitions.createDraft(owner, namespace.id, 'Participant intake', true);
    draft = f.store.definitions.putPipeline(owner, draft.id, draft.revision, intake, true);
    f.store.definitions.validatePipeline(owner, draft.id, draft.revision, intake.serviceId, expiry(), true);
    const current = f.store.definitions.pipelineDraft(owner, draft.id, draft.revision, intake.serviceId, true);
    const check = () => f.store.definitions.pipeline.verifyTask(namespace.id, owner, current.ref, current.model, f.store.get(owner, proof.id), id => f.store.intent(owner, id), expiry());
    const verified = check(); assert.equal(verified.level, 'synthetic');
    assert(verified.actionIds.includes('ReadParticipantRegistration'));
    const published = f.store.definitions.publish(owner, draft.id, draft.revision, true);
    f.store.definitions.activate(owner, published.release, namespace.generation, true);
    const graph = f.store.ontology, status = () => graph.pipelineStatus(owner, program.ref, program.configurationDigest, 'SubmitFreeRegistrationSandbox');
    assert.equal(status().status, 'verified'); assert.equal(status().availabilityProof, false);
    const clock = t.mock.method(f.store.definitions.pipeline, 'now', () => Date.now() + 3600001);
    assert.equal(status().status, 'expired'); clock.mock.restore();
    assert.equal(graph.pipelineStatus('another-owner', program.ref, program.configurationDigest, 'SubmitFreeRegistrationSandbox').status, 'verification_required');
    assert.equal(graph.pipelineStatus(owner, program.ref, digest('changed-config'), 'SubmitFreeRegistrationSandbox').status, 'contract_changed');
    f.input.serviceUrl = f.event.serviceUrl = 'https://luma.com/eigos-synthetic-next';
    f.submit(); const admitted = await f.until(job => job.state === 'completed');
    assert.notEqual(admitted.id, proof.id); assert.equal(f.counters().submits, 2);
    assert.equal(admitted.runs?.length, proof.runs?.length, 'Pipeline checks must not add model calls');
    const unavailableRegion = f.catalog.discoverActions(graph, owner, admitted.delegation!.request, { actionId: 'SubmitFreeRegistrationSandbox', serviceConditions: { region: 'not-declared' } });
    assert(unavailableRegion.items[0]!.bindings.every(binding => binding.readiness === 'conditions_unmet'));
    const allowedRegion = f.catalog.discoverActions(graph, owner, admitted.delegation!.request, { actionId: 'SubmitFreeRegistrationSandbox', serviceConditions: { region: 'CN', paymentModes: ['not_required'], operatorAvailable: false } });
    assert(allowedRegion.items[0]!.bindings.some(binding => binding.readiness === 'ready'));
    assert(f.catalog.discoverActions(graph, owner, admitted.delegation!.request, { search: '展览预约' }).items.some(item => item.action.id === 'SubmitFreeRegistrationSandbox'));
    const uses = f.store.definitions.pipeline.uses(owner, admitted.id);
    assert.equal(uses.length, 3); assert(uses.every(use => use.intakeDigest === current.ref.intakeDigest && use.verificationIds.includes(verified.id)));
    assert.deepEqual(f.store.ontologyReleaseForJob(owner, proof), proof.delegation!.ontologyRelease);
    f.input.serviceUrl = f.event.serviceUrl = 'https://luma.com/eigos-synthetic-blocked';
    const pending = f.submit(); await f.until(job => job.state === 'auth-required');
    f.store.definitions.pipeline.event(namespace.id, owner, intake.serviceId, { kind: 'source_changed', sourceDigest: digest('provider-contract-v2') });
    assert.equal(status().status, 'source_changed');
    f.approve(f.store.get(owner, pending.id));
    const blocked = await f.until(job => job.state === 'paused');
    assert.equal(f.counters().submits, 2); assert(blocked.delegation!.agent!.feedback.some(item => item.message.includes('source_changed')));
    const discovery = f.catalog.discoverActions(f.store.ontologyForJob(owner, blocked), owner, blocked.delegation!.request, { actionId: 'SubmitFreeRegistrationSandbox' });
    assert(discovery.items[0]!.bindings.every(binding => binding.readiness === 'pipeline_unverified'));
    f.store.definitions.pipeline.event(namespace.id, owner, intake.serviceId, { kind: 'source_changed', sourceDigest: intake.source.digest });
    f.store.definitions.pipeline.event(namespace.id, owner, intake.serviceId, { kind: 'verification_revoked', verificationId: verified.id });
    assert.equal(status().status, 'revoked');
    let newer = f.store.definitions.createDraft(owner, namespace.id, 'New source version', true);
    newer = f.store.definitions.putPipeline(owner, newer.id, newer.revision, { ...intake, source: { ...intake.source, revision: '2', digest: digest('provider-contract-v2') } }, true);
    const updated = f.store.definitions.pipelineDraft(owner, newer.id, newer.revision, intake.serviceId, true);
    assert.throws(() => f.store.definitions.pipeline.verifyTask(namespace.id, owner, updated.ref, updated.model, proof, id => f.store.intent(owner, id), expiry()), /different source or mapping/);
  } finally { f.store.close(); }
});

test('source updates are atomic and ordered; only consumers of changed fields are invalidated', () => {
  let now = Date.now(); const store = new JobStore(':memory:', { securityNow: () => now });
  try {
    const f = eventDraft(store);
    store.definitions.validatePipeline(owner, f.draft.id, f.draft.revision, f.intake.serviceId, expiry());
    const release = store.definitions.publish(owner, f.draft.id, f.draft.revision).release;
    store.definitions.activate(owner, release, f.namespace.generation);
    const graph = store.ontologyForRelease(release), tasks = new TaskService(store, { catalog: createExecutionCatalog({ store }) });
    const task = tasks.submit(principal, { ontologyId: f.namespace.id, goal: 'Synthetic exhibition, calendar and route', requestId: randomUUID() });
    const sample = { eventId: 'event-1', sourceAccount: 'fixture-account', sourceRevision: f.intake.source.revision, sourceDigest: f.intake.source.digest,
      providerVersion: 1, observedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), evidenceRefs: ['synthetic:event-1'], evidenceLevel: 'synthetic' as const, payload: f.intake.fixtures[0]!.input };
    const apply = (input = sample, revision = 0) => store.ingestPipelineObservation(owner, release, f.intake.serviceId, 'event', input, revision);
    const first = apply(); assert.equal(first.status, 'applied');
    const original = graph.read(owner, first.object);
    const snapshot = { ref: original.ref, revision: original.revision, propertiesDigest: digest(original.properties), linksDigest: digest([]) };
    assert.equal(apply().duplicate, true); assert.equal(graph.read(owner, first.object).revision, original.revision);
    store.transaction(() => {
      for (const component of ['calendar', 'transport']) store.pipelineFacts.track(owner, f.namespace.id, task.id, 1, component, first.object, ['startsAt', 'venue']);
      store.pipelineFacts.track(owner, f.namespace.id, task.id, 1, 'registration', first.object, ['status']);
    });
    const unchanged = apply({ ...sample, eventId: 'event-2', providerVersion: 2 }, 1);
    assert.equal(unchanged.status, 'unchanged'); assert.equal(unchanged.semanticRevision, 1);
    assert.equal(graph.read(owner, first.object).revision, original.revision);
    assert.deepEqual(store.pipelineFacts.changes(owner, task.id, 1), []);
    const moved = apply({ ...sample, eventId: 'event-3', providerVersion: 3, payload: { ...sample.payload, place: '合成场馆 B' } }, 2);
    assert.equal(moved.semanticRevision, 2); assert.equal(graph.read(owner, first.object).properties.venue, '合成场馆 B');
    assert.throws(() => store.pipelineFacts.assertSnapshots(owner, f.namespace.id, [snapshot]), /changed after planning/);
    const changes = store.pipelineFacts.changes(owner, task.id, 1);
    assert.deepEqual(changes.map(change => change.componentId).sort(), ['calendar', 'transport']);
    assert(changes.every(change => change.fields.join(',') === 'venue'));
    assert.equal(apply({ ...sample, eventId: 'late', providerVersion: 1 }, 3).status, 'stale');
    assert.equal(graph.read(owner, first.object).properties.venue, '合成场馆 B');
    assert.equal(apply({ ...sample, eventId: 'conflict', providerVersion: 3 }, 4).status, 'conflicted');
    assert.throws(() => store.pipelineFacts.assertFresh(owner, f.namespace.id, [first.object]), /conflicted/);
    apply({ ...sample, eventId: 'fresh', providerVersion: 4, payload: { ...sample.payload, place: '合成场馆 B' } }, 5);
    store.pipelineFacts.assertFresh(owner, f.namespace.id, [first.object]);
    assert.equal(apply({ ...sample, eventId: 'event-1', providerVersion: 1, payload: { ...sample.payload, place: '旧消息中的冲突地点' } }, 6).status, 'stale');
    store.pipelineFacts.assertFresh(owner, f.namespace.id, [first.object]);
    apply({ ...sample, eventId: 'changed-time', providerVersion: 5, payload: { ...sample.payload, place: '合成场馆 B', time: '2030-01-01T15:00:00+08:00' } }, 7);
    assert(store.pipelineFacts.changes(owner, task.id, 1).filter(change => ['calendar', 'transport'].includes(change.componentId)).every(change => change.fields.includes('venue') && change.fields.includes('startsAt')));
    now += 61000;
    store.transaction(() => store.pipelineFacts.expireForTask(owner, task.id, 1));
    assert.throws(() => store.pipelineFacts.assertFresh(owner, f.namespace.id, [first.object]), /stale/);
    const count = store.pipelineFacts.changes(owner, task.id, 1).length;
    store.transaction(() => store.pipelineFacts.expireForTask(owner, task.id, 1));
    assert.equal(store.pipelineFacts.changes(owner, task.id, 1).length, count);
    assert.equal(store.pipelineFacts.current('foreign-owner', f.namespace.id, first.object), undefined);
    assert.deepEqual(store.pipelineFacts.changes('foreign-owner', task.id, 1), []);
  } finally { store.close(); }
});

test('unversioned observations require independent reads and compare the original read revision', () => {
  const store = new JobStore(':memory:');
  try {
    const f = eventDraft(store);
    store.definitions.validatePipeline(owner, f.draft.id, f.draft.revision, f.intake.serviceId, expiry());
    const release = store.definitions.publish(owner, f.draft.id, f.draft.revision).release;
    store.definitions.activate(owner, release, f.namespace.generation);
    const now = new Date().toISOString(), sample = { eventId: 'read-1', sourceAccount: 'fixture-account', sourceRevision: f.intake.source.revision, sourceDigest: f.intake.source.digest,
      observedAt: now, receivedAt: now, evidenceRefs: ['synthetic:read'], evidenceLevel: 'synthetic' as const, payload: f.intake.fixtures[0]!.input };
    const apply = (value: typeof sample & { independentRead?: boolean }, revision: number) => store.ingestPipelineObservation(owner, release, f.intake.serviceId, 'event', value, revision);
    assert.throws(() => apply(sample, 0), /native ordering or an independent read/);
    const first = apply({ ...sample, independentRead: true }, 0);
    assert.equal(apply({ ...sample, eventId: 'racing-read', independentRead: true, payload: { ...sample.payload, place: '场馆 B' } }, 0).status, 'conflicted');
    assert.equal(store.pipelineFacts.current(owner, f.namespace.id, first.object)!.properties.venue, '合成场馆 A');
    assert.equal(apply({ ...sample, eventId: 'independent-refresh', independentRead: true, payload: { ...sample.payload, place: '场馆 B' } }, 2).status, 'applied');
    assert.equal(store.pipelineFacts.current(owner, f.namespace.id, first.object)!.providerVersion, undefined);
  } finally { store.close(); }
});

test('a bounded operator validation task bootstraps evidence without promoting an ordinary task or granting its effect', async () => {
  const f = participantFixture();
  try {
    const program = f.catalog.agentProgram({ id: 'booking.participant.free', version: '1' }, owner)!;
    const intake = participantIntake(f.store.ontology.model, program), namespace = f.store.definitions.namespace('eigos.business');
    let draft = f.store.definitions.createDraft(owner, namespace.id, 'New unverified service', true);
    draft = f.store.definitions.putPipeline(owner, draft.id, draft.revision, intake, true);
    f.store.definitions.validatePipeline(owner, draft.id, draft.revision, intake.serviceId, expiry(), true);
    const published = f.store.definitions.publish(owner, draft.id, draft.revision, true);
    f.store.definitions.activate(owner, published.release, namespace.generation, true);
    const status = () => f.store.ontology.pipelineStatus(owner, program.ref, program.configurationDigest, 'SubmitFreeRegistrationSandbox');
    assert.equal(status().status, 'verification_required');
    const args = { ontologyId: namespace.id, release: published.release, serviceId: intake.serviceId, requestId: randomUUID(),
      goal: '合成验证：免费报名并独立确认参加资格，不付款。', expiresAt: new Date(Date.now() + 60000).toISOString() };
    assert.throws(() => f.tasks.preparePipelineValidation({ ...principal, scopes: ['tasks:read', 'tasks:write'] }, args), /scope|permission/i);
    assert.throws(() => f.submit({ pipelineValidation: { serviceId: intake.serviceId } }));
    const manager = { ...principal, scopes: [...principal.scopes, 'ontology:read', 'ontology:publish', 'ontology:admin'] };
    const task = f.tasks.preparePipelineValidation(manager, args);
    assert.equal(f.tasks.preparePipelineValidation(manager, args).id, task.id);
    assert.throws(() => f.tasks.preparePipelineValidation(manager, { ...args, goal: 'different goal' }), /requestId|different|reused/i);
    const bound = f.store.ontologyForJob(owner, task);
    assert.equal(bound.pipelineStatus(owner, program.ref, program.configurationDigest, 'SubmitFreeRegistrationSandbox').status, 'validation_only');
    assert.equal(bound.pipelineStatus(owner, { id: 'unrelated-program', version: '1' }, program.configurationDigest, 'SubmitFreeRegistrationSandbox').status, 'definition_only');
    await f.until(job => job.state === 'auth-required');
    assert.equal(f.counters().submits, 0, 'A validation request must not approve a reservation');
    const done = await f.until(job => job.state === 'completed');
    assert.equal(done.id, task.id); assert.equal(status().status, 'verification_required', 'A completed validation must not automatically publish verification');
    assert(f.store.definitions.pipeline.uses(owner, task.id).every(value => value.status === 'validation_only'));
    const review = f.store.definitions.createDraft(owner, namespace.id, 'Review validation evidence', true);
    const current = f.store.definitions.pipelineDraft(owner, review.id, review.revision, intake.serviceId, true);
    const verified = f.store.definitions.pipeline.verifyTask(namespace.id, owner, current.ref, current.model, done, id => f.store.intent(owner, id), expiry());
    assert.equal(verified.level, 'synthetic'); assert.equal(status().status, 'verified');
  } finally { f.store.close(); }
});

test('revoking intake evidence blocks new calls without stranding an already dispatched original operation', async () => {
  const f = participantFixture();
  try {
    f.submit(); const proof = await f.until(job => job.state === 'completed');
    const program = f.catalog.agentProgram({ id: 'booking.participant.free', version: '1' }, owner)!;
    const intake = participantIntake(f.store.ontology.model, program), namespace = f.store.definitions.namespace('eigos.business');
    let draft = f.store.definitions.createDraft(owner, namespace.id, 'Verify original-operation recovery', true);
    draft = f.store.definitions.putPipeline(owner, draft.id, draft.revision, intake, true);
    f.store.definitions.validatePipeline(owner, draft.id, draft.revision, intake.serviceId, expiry(), true);
    const entry = f.store.definitions.pipelineDraft(owner, draft.id, draft.revision, intake.serviceId, true);
    const verification = f.store.definitions.pipeline.verifyTask(namespace.id, owner, entry.ref, entry.model, proof, id => f.store.intent(owner, id), expiry());
    const published = f.store.definitions.publish(owner, draft.id, draft.revision, true);
    f.store.definitions.activate(owner, published.release, namespace.generation, true);
    let allowReadback = false;
    const original = f.source.call.bind(f.source);
    f.source.call = async (ctx, action, input, signal, recovery) => {
      if (action.startsWith('Submit') && recovery && !allowReadback) return { value: { queued: true }, evidenceRefs: [], pending: { retryAfterMs: 100 } };
      const result = await original(ctx, action, input, signal, recovery);
      if (action.startsWith('Submit') && !recovery) throw new Error('Synthetic transport lost the response after the one provider write');
      return result;
    };
    f.input.serviceUrl = f.event.serviceUrl = 'https://luma.com/eigos-synthetic-recovery';
    const job = f.submit();
    await f.until(current => f.store.intents(owner, current.id).some(intent => intent.effect === 'reserve' && ['effect_unknown', 'awaiting_remote'].includes(intent.state)));
    const write = f.store.intents(owner, job.id).find(intent => intent.effect === 'reserve')!;
    f.store.definitions.pipeline.event(namespace.id, owner, intake.serviceId, { kind: 'verification_revoked', verificationId: verification.id });
    allowReadback = true;
    await f.until(current => f.store.intent(owner, write.id).state === 'effect_confirmed');
    assert.equal(f.counters().submits, 2); assert.equal(f.store.attempts(owner, write.id).filter(attempt => attempt.kind === 'dispatch').length, 1);
    assert(f.store.attempts(owner, write.id).some(attempt => attempt.kind === 'reconcile'));
    assert.equal(f.store.ontology.pipelineStatus(owner, program.ref, program.configurationDigest, 'SubmitFreeRegistrationSandbox').status, 'revoked');
  } finally { f.store.close(); }
});
