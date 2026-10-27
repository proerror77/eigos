import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { digest } from '../packages/core/delegation.js';
import { observerFixture } from './fixtures/pipeline-observer.js';
import { PipelineObserver } from '../packages/coordinator/pipeline-observer.js';

for (const secured of [false, true]) test(`${secured ? 'foundation' : 'legacy'}: bounded source polling stays quiet on unchanged facts and re-enters planning on a meaningful change`, async () => {
  const f = observerFixture(secured);
  try {
    await f.install(); const task = f.submit();
    await f.until(task.id, job => job.delegation?.phase === 'observing');
    const modelCalls = f.modelCalls(), calls = f.program.calls, watch = f.store.observationWatches.watches(f.owner, task.id)[0]!;
    const before = f.store.pipelineFacts.current(f.owner, watch.release.ontologyId, watch.selection.object)!;
    f.elapse(1200); await f.tick();
    assert.equal(f.modelCalls(), modelCalls); assert.equal(f.program.calls, calls + 1);
    assert.equal(f.store.pipelineFacts.current(f.owner, watch.release.ontologyId, watch.selection.object)!.semanticRevision, before.semanticRevision);
    assert.equal(f.store.observationWatches.contract(f.owner, task.id)!.reads, 1);
    f.program.venue.secret = 'ANOTHER_PRIVATE_SOURCE_VALUE'; f.elapse(1200); await f.tick();
    assert.equal(f.modelCalls(), modelCalls, 'A hidden, unconsumed field change must not wake the model');
    f.program.venue.address.text = '北京市合成会场修正地址 2 号'; f.elapse(1200); await f.tick();
    assert.equal(f.modelCalls(), modelCalls + 1);
    const changed = f.store.pipelineFacts.current(f.owner, watch.release.ontologyId, watch.selection.object)!;
    assert.equal((changed.properties.address as { text: string }).text, f.program.venue.address.text);
    assert.equal(f.store.get(f.owner, task.id).state, 'working');
    const visible = f.tasks.get(f.actor, task.id);
    assert(visible.observation?.watches.length);
    assert(!JSON.stringify(visible.observation).includes('PRIVATE_SOURCE'));
    if (f.foundation) {
      assert(!f.foundation.modelInputs.join('\n').includes('PRIVATE_OBSERVATION_SOURCE_ONLY'));
      assert(!f.foundation.modelInputs.join('\n').includes('ANOTHER_PRIVATE_SOURCE_VALUE'));
    }
    assert(f.store.intents(f.owner, task.id).every(intent => intent.effect === 'read'));
    f.control(task.id, 'stop_observation');
    const done = await f.until(task.id, job => job.state === 'completed');
    assert.equal(done.delegation!.acceptance!.accepted, true);
    assert.equal(f.store.observationWatches.watches(f.owner, task.id)[0]!.status, 'stopped');
    if (f.foundation) {
      const policy = f.foundation.policy, object = f.store.pipelineFacts.current(f.owner, watch.release.ontologyId, watch.selection.object)!;
      const revision = f.store.security.withAgent(f.actor, task.id, 'task.query', () => f.store.ontologyForJob(f.owner, task.id).read(f.owner, object.object).revision);
      policy.restrictObject({ ownerKey: f.owner, object: object.object, expectedObjectRevision: revision,
        field: 'address', classification: 'sensitive', requiredMarkings: ['member_private', 'personal_data'], channels: ['controlled_download'] }, policy.revision());
      const restricted = f.tasks.get(f.actor, task.id);
      assert.equal(restricted.artifact, undefined, 'Historical observation evidence cannot bypass current recipient restrictions');
      assert(!(JSON.stringify(restricted.observation) ?? '').includes(f.program.venue.address.text));
    }
  } finally { f.close(); }
});

test('a different source field layout uses the same observer runtime and cannot execute business writes', async () => {
  const f = observerFixture(false, 'b');
  try {
    await f.install(); const task = f.submit(); await f.until(task.id, job => job.delegation?.phase === 'observing');
    const before = f.modelCalls(); f.elapse(1200); await f.tick();
    assert.equal(f.modelCalls(), before);
    const watch = f.store.observationWatches.watches(f.owner, task.id)[0]!;
    assert.equal(watch.target.mappingId, 'saved-venue');
    assert.equal(watch.action, 'ReadParticipantRegistration');
    assert(!f.store.intents(f.owner, task.id).some(intent => ['reserve', 'order', 'payment'].includes(intent.effect)));
  } finally { f.close(); }
});

test('observation hints are idempotent hints and never replace source truth', async () => {
  const f = observerFixture();
  try {
    await f.install(); const task = f.submit(); await f.until(task.id, job => job.delegation?.phase === 'observing');
    const watch = f.store.observationWatches.watches(f.owner, task.id)[0]!, original = f.store.pipelineFacts.current(f.owner, watch.release.ontologyId, watch.selection.object)!;
    const args = { action: 'report_observation_change' as const, taskId: task.id, watchId: watch.id, expectedRevision: task.revision, requestId: randomUUID(), eventId: 'same-hint', contentDigest: digest('untrusted hint') };
    f.tasks.controlObservation(f.actor, args); f.tasks.controlObservation(f.actor, args);
    assert.equal(f.store.observationWatches.watch(f.owner, watch.id).hintSequence, 1);
    assert.equal(f.store.pipelineFacts.current(f.owner, watch.release.ontologyId, watch.selection.object)!.semanticDigest, original.semanticDigest);
    const calls = f.modelCalls(); f.elapse(1200); await f.tick(); assert.equal(f.modelCalls(), calls);
    assert.throws(() => f.tasks.controlObservation({ ...f.actor, subject: 'foreign-member' }, { ...args, requestId: randomUUID() }));
    assert.throws(() => f.tasks.controlObservation(f.actor, { ...args, requestId: randomUUID(), expectedRevision: 999 }));
  } finally { f.close(); }
});

for (const interruption of ['cancel', 'stop', 'lease'] as const) test(`${interruption} fences a late independent source read before canonical mutation`, async () => {
  const f = observerFixture(interruption === 'cancel');
  try {
    await f.install(); const task = f.submit(); await f.until(task.id, job => job.delegation?.phase === 'observing');
    const watch = f.store.observationWatches.watches(f.owner, task.id)[0]!;
    const before = f.store.pipelineFacts.current(f.owner, watch.release.ontologyId, watch.selection.object)!;
    f.program.venue.address.text = 'Late source value must not be accepted';
    f.program.beforeReturn = async () => {
      if (interruption === 'cancel') f.tasks.cancel(f.actor, task.id);
      else if (interruption === 'stop') f.control(task.id, 'stop_observation');
      else f.elapse(31000);
    };
    const modelCalls = f.modelCalls(); f.elapse(1200); await f.tick();
    if (interruption !== 'stop') assert.equal(f.modelCalls(), modelCalls);
    assert.equal(f.store.pipelineFacts.current(f.owner, watch.release.ontologyId, watch.selection.object)!.semanticDigest, before.semanticDigest);
    assert.equal(f.store.observationWatches.contract(f.owner, task.id)!.reads, 1);
    if (interruption === 'cancel') assert.equal(f.store.get(f.owner, task.id).state, 'canceled');
  } finally { f.close(); }
});

test('the final authorized read runs once and budget exhaustion cannot be reset by resuming', async () => {
  const f = observerFixture();
  try {
    await f.install(); const task = f.submit({ maxReads: 1 }); await f.until(task.id, job => job.delegation?.phase === 'observing');
    const calls = f.program.calls, modelCalls = f.modelCalls(); f.elapse(1200); await f.tick();
    assert.equal(f.program.calls, calls + 1); assert.equal(f.modelCalls(), modelCalls);
    assert.equal(f.store.get(f.owner, task.id).state, 'paused');
    assert.equal(f.store.observationWatches.watches(f.owner, task.id)[0]!.reason, 'observation_budget_exhausted');
    assert.throws(() => f.control(task.id, 'resume_observation'), /budget/);
    assert.equal(f.store.observationWatches.contract(f.owner, task.id)!.reads, 1);
    f.control(task.id, 'stop_observation'); await f.until(task.id, job => job.state === 'completed');
  } finally { f.close(); }
});

test('healthy pending source queries keep one operation and explicit stop/resume keeps the accumulated budget', async () => {
  const f = observerFixture();
  try {
    await f.install(); const task = f.submit(); await f.until(task.id, job => job.delegation?.phase === 'observing');
    f.program.pendingReads = true; const models = f.modelCalls(); let operation: string | undefined;
    for (let i = 0; i < 4; i++) {
      f.elapse(1200); await f.tick();
      const watch = f.store.observationWatches.watches(f.owner, task.id)[0]!;
      operation ??= watch.pending!.operationKey; assert.equal(watch.pending!.operationKey, operation);
      assert.equal(watch.failedReads, 0); assert.equal(watch.status, 'active');
    }
    assert.equal(f.modelCalls(), models);
    f.control(task.id, 'stop_observation'); f.control(task.id, 'resume_observation');
    assert.equal(f.store.observationWatches.contract(f.owner, task.id)!.reads, 4);
    f.program.pendingReads = false; await f.tick();
    assert.equal(f.store.observationWatches.watches(f.owner, task.id)[0]!.health, 'fresh');
    assert.equal(f.store.observationWatches.contract(f.owner, task.id)!.reads, 5);
  } finally { f.close(); }
});

test('revoked published verification blocks future observation without replaying the original operation', async () => {
  const f = observerFixture();
  try {
    const { intake, release } = await f.install(); const task = f.submit(); await f.until(task.id, job => job.delegation?.phase === 'observing');
    const status = f.store.ontologyForJob(f.owner, task.id).pipelineStatus(f.owner, f.program.ref, f.program.configurationDigest, 'ReadParticipantRegistration');
    const calls = f.program.calls, ids = f.store.intents(f.owner, task.id).map(intent => intent.id);
    f.store.definitions.pipeline.event(release.ontologyId, f.owner, intake.serviceId, { kind: 'verification_revoked', verificationId: status.verificationIds[0]! });
    f.elapse(1200); await f.tick();
    assert.equal(f.program.calls, calls); assert.equal(f.store.get(f.owner, task.id).state, 'paused');
    assert.deepEqual(f.store.intents(f.owner, task.id).map(intent => intent.id), ids);
    assert.throws(() => f.control(task.id, 'resume_observation'), /verified/);
  } finally { f.close(); }
});

test('a source freshness gap cannot turn clock expiry into completed observation', async () => {
  const f = observerFixture();
  try {
    await f.install(); const task = f.submit({ until: new Date(f.now() + 90000).toISOString() });
    await f.until(task.id, job => job.delegation?.phase === 'observing');
    const models = f.modelCalls(); f.elapse(92000); await f.tick();
    assert.equal(f.modelCalls(), models); const current = f.store.get(f.owner, task.id);
    assert.equal(current.state, 'paused'); assert.equal(current.delegation?.acceptance, undefined);
    assert.equal(f.store.observationWatches.watches(f.owner, task.id)[0]!.reason, 'observation_horizon_unverified');
    assert.throws(() => new PipelineObserver(f.store, f.catalog).assertCompletion(f.owner, current), /not finished/);
  } finally { f.close(); }
});

test('changed context inputs block only their consumers and cannot be refreshed by replaying an old context', async () => {
  const f = observerFixture();
  try {
    await f.install(); const task = f.submit(); await f.until(task.id, job => job.delegation?.phase === 'observing');
    const watch = f.store.observationWatches.watches(f.owner, task.id)[0]!, graph = f.store.ontologyForJob(f.owner, task.id);
    const original = f.store.intents(f.owner, task.id).map(intent => ({ id: intent.id, operation: intent.businessOperationKey, accepted: intent.acceptedOutput }));
    f.store.transaction(() => {
      f.store.pipelineFacts.track(f.owner, graph.ontologyId, task.id, 1, 'calendar', watch.selection.object, ['address'], true);
      f.store.pipelineFacts.track(f.owner, graph.ontologyId, task.id, 1, 'transport', watch.selection.object, ['address'], true);
      f.store.pipelineFacts.track(f.owner, graph.ontologyId, task.id, 1, 'registration', watch.selection.object, ['label'], true);
    });
    f.program.venue.address.text = 'Corrected destination'; f.elapse(1200); await f.tick();
    for (const id of ['calendar', 'transport']) assert.throws(() => graph.assertPipelineContextCurrent(f.owner, task.id, 1, id), /prepare a new explicit context/);
    graph.assertPipelineContextCurrent(f.owner, task.id, 1, 'registration');
    f.store.transaction(() => f.store.pipelineFacts.track(f.owner, graph.ontologyId, task.id, 1, 'calendar', watch.selection.object, ['address']));
    assert.throws(() => graph.assertPipelineContextCurrent(f.owner, task.id, 1, 'calendar'), /changed/);
    f.store.transaction(() => f.store.pipelineFacts.track(f.owner, graph.ontologyId, task.id, 1, 'calendar-reprepared', watch.selection.object, ['address'], true));
    graph.assertPipelineContextCurrent(f.owner, task.id, 1, 'calendar-reprepared');
    assert.deepEqual(f.store.intents(f.owner, task.id).map(intent => ({ id: intent.id, operation: intent.businessOperationKey, accepted: intent.acceptedOutput })), original);
    const changes = f.store.pipelineFacts.changes(f.owner, task.id, 1);
    assert(changes.some(change => change.componentId === 'calendar')); assert(changes.some(change => change.componentId === 'transport'));
    assert(!changes.some(change => change.componentId === 'registration'));
  } finally { f.close(); }
});

test('Foundation source revocation fences an in-flight poll and cannot be bypassed by historical Pipeline evidence', async () => {
  const f = observerFixture(true);
  try {
    await f.install(); const task = f.submit(); await f.until(task.id, job => job.delegation?.phase === 'observing');
    const watch = f.store.observationWatches.watches(f.owner, task.id)[0]!;
    const before = f.store.pipelineFacts.current(f.owner, watch.release.ontologyId, watch.selection.object)!;
    f.program.venue.address.text = 'Source reply received after authority revocation';
    f.program.beforeReturn = async () => {
      const policy = f.foundation!.policy;
      policy.revokeSource(f.owner, f.foundation!.a.id, f.catalog.securityProfiles(f.owner)[0]!.bindingId, policy.revision());
    };
    f.elapse(1200); await f.tick();
    assert.equal(f.store.pipelineFacts.current(f.owner, watch.release.ontologyId, watch.selection.object)!.semanticDigest, before.semanticDigest);
    assert.equal(f.store.claim(['eigos.delegate'], 30000, f.now()), undefined);
    assert.throws(() => f.tasks.get(f.actor, task.id));
    assert.throws(() => f.control(task.id, 'resume_observation'));
  } finally { f.close(); }
});

test('a trusted shared-fact update wakes the same task and is independently read before the next decision', async () => {
  const f = observerFixture();
  try {
    const { intake, release } = await f.install(); const task = f.submit(); await f.until(task.id, job => job.delegation?.phase === 'observing');
    const watch = f.store.observationWatches.watches(f.owner, task.id)[0]!, before = f.store.pipelineFacts.current(f.owner, release.ontologyId, watch.selection.object)!;
    f.program.venue.address.text = 'Independent shared source update';
    f.store.ingestPipelineObservation(f.owner, release, intake.serviceId, 'saved-venue', { eventId: randomUUID(), sourceAccount: watch.target.sourceAccount,
      sourceRevision: intake.source.revision, sourceDigest: intake.source.digest, observedAt: new Date(f.now()).toISOString(), receivedAt: new Date(f.now()).toISOString(),
      independentRead: true, evidenceLevel: 'synthetic', evidenceRefs: ['synthetic:shared-source'], payload: { key: f.program.venue.nativeId, title: f.program.venue.title, postal: f.program.venue.address, memo: f.program.venue.secret } }, before.revision);
    const models = f.modelCalls(), calls = f.program.calls; await f.tick();
    assert.equal(f.program.calls, calls + 1); assert.equal(f.modelCalls(), models + 1);
    assert.equal(f.store.get(f.owner, task.id).delegation!.phase, 'observing');
    assert.equal(f.store.observationWatches.contract(f.owner, task.id)!.reads, 1);
  } finally { f.close(); }
});

for (const state of ['input-required', 'auth-required'] as const) test(`a paused background watch preserves the original ${state} question`, async () => {
  const f = observerFixture();
  try {
    await f.install(); const task = f.submit(); await f.until(task.id, job => job.delegation?.phase === 'observing');
    const pending = f.store.get(f.owner, task.id); pending.state = state; pending.question = 'Original pending business question';
    pending.delegation!.phase = state === 'input-required' ? 'clarifying' : 'awaiting_authorization'; f.store.save(f.owner, pending);
    const models = f.modelCalls(); f.program.failReads = true;
    for (let i = 0; i < 3; i++) { f.elapse(10000); await f.tick(); }
    assert.equal(f.modelCalls(), models);
    assert.equal(f.store.get(f.owner, task.id).state, state);
    assert.equal(f.store.get(f.owner, task.id).question, pending.question);
    assert.equal(f.store.observationWatches.watches(f.owner, task.id)[0]!.status, 'paused');
    f.control(task.id, 'stop_observation');
    assert.equal(f.store.get(f.owner, task.id).state, state);
    assert.equal(f.store.get(f.owner, task.id).question, pending.question);
  } finally { f.close(); }
});
