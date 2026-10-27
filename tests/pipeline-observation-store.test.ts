import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { PipelineObservationStore } from '../packages/core/pipeline-observation-store.js';
import { businessTransaction } from '../packages/core/transaction.js';

function fixture(maxReads = 20, maxActiveMs = 60000) {
  const db = new DatabaseSync(':memory:'); let now = Date.now();
  const store = new PipelineObservationStore(db, () => now), owner = 'synthetic-owner', taskId = randomUUID();
  const atomic = <T>(action: () => T) => businessTransaction(db, action);
  const budget = { until: new Date(now + 120000).toISOString(), maxReads, maxActiveMs };
  const input = { scope: { type: 'RegistrationTask', id: 'synthetic-scope' } };
  atomic(() => store.establish(owner, taskId, 1, budget));
  const spec = { owner, taskId, requestRevision: 1, release: { ontologyId: 'eigos.business', releaseId: randomUUID(), digest: 'a'.repeat(64) },
    intakeDigest: 'b'.repeat(64), programRef: { id: 'synthetic.reader', version: '1' }, configurationDigest: 'c'.repeat(64), action: 'ReadParticipantRegistration',
    planId: randomUUID(), stepId: 'read', intentId: randomUUID(), modelRunId: randomUUID(),
    selection: { step: { type: 'ExecutionStep' as const, id: 'synthetic-step' }, object: { type: 'SavedAddress', id: 'pipeline:synthetic' }, fields: ['label'], intervalMs: 1000 },
    target: { serviceId: 'synthetic.service', mappingId: 'address', sourceAccount: 'synthetic-account', nativeId: 'address-1' },
    input, inputDigest: 'd'.repeat(64), lastValuesDigest: 'e'.repeat(64), lastObservedAt: new Date(now).toISOString(), validUntil: new Date(now + 60000).toISOString() };
  const watch = atomic(() => store.start(spec));
  return { db, store, owner, taskId, budget, spec, watch, atomic, now: () => now, elapse: (ms: number) => { now += ms; } };
}

test('pending reads retain one source operation and charge every query without counting healthy waiting as failure', () => {
  const f = fixture();
  try {
    let operation: string | undefined;
    for (let i = 0; i < 4; i++) {
      const read = f.atomic(() => f.store.begin(f.owner, f.watch.id, 1));
      operation ??= read.operationKey; assert.equal(read.operationKey, operation);
      f.elapse(25); f.atomic(() => f.store.finish(read, { kind: 'pending', retryAfterMs: 1000 }));
      f.elapse(1000);
    }
    const watch = f.store.watch(f.owner, f.watch.id);
    assert.equal(watch.failedReads, 0); assert.equal(watch.status, 'active');
    assert.equal(f.store.contract(f.owner, f.taskId)!.reads, 4);
    assert.equal(f.store.contract(f.owner, f.taskId)!.activeMs, 100);
    assert.equal(f.atomic(() => f.store.start(f.spec)).id, f.watch.id, 'Returning to observation must retain the watch and budget');
  } finally { f.db.close(); }
});

test('restart and stop/resume preserve cumulative limits and fence late receipts', () => {
  const f = fixture(2);
  try {
    const first = f.atomic(() => f.store.begin(f.owner, f.watch.id, 1));
    const restored = new PipelineObservationStore(f.db, f.now);
    assert.equal(restored.contract(f.owner, f.taskId)!.reads, 1);
    f.atomic(() => restored.stop(f.owner, f.watch.id));
    f.elapse(100);
    f.atomic(() => restored.finish(first, { kind: 'accepted', changed: true, valuesDigest: 'new', observedAt: new Date(f.now()).toISOString(), validUntil: new Date(f.now() + 60000).toISOString(), evidenceRefs: ['synthetic'] }));
    assert.equal(restored.watch(f.owner, f.watch.id).lastValuesDigest, f.spec.lastValuesDigest);
    assert.equal(JSON.parse(String(f.db.prepare('SELECT body FROM pipeline_observation_receipts WHERE id=?').get(first.id)!.body)).status, 'late');
    f.atomic(() => restored.resume(f.owner, f.watch.id, 1));
    const second = f.atomic(() => restored.begin(f.owner, f.watch.id, 1));
    f.elapse(20); f.atomic(() => restored.finish(second, { kind: 'pending', retryAfterMs: 1000 }));
    f.atomic(() => restored.settle(f.owner, f.taskId, 1));
    assert.equal(restored.watch(f.owner, f.watch.id).reason, 'observation_budget_exhausted');
    assert.throws(() => f.atomic(() => restored.resume(f.owner, f.watch.id, 1)), /budget/);
    f.atomic(() => restored.establish(f.owner, f.taskId, 2, f.budget));
    assert.equal(restored.contract(f.owner, f.taskId)!.reads, 2);
    assert.throws(() => f.atomic(() => restored.start({ ...f.spec, requestRevision: 2 })), /budget/);
    assert.throws(() => f.db.exec('DELETE FROM pipeline_observation_receipts'), /immutable/);
  } finally { f.db.close(); }
});

test('a superseded read cannot overwrite a new call or refund its reservation twice', () => {
  const f = fixture();
  try {
    const first = f.atomic(() => f.store.begin(f.owner, f.watch.id, 1));
    f.elapse(10);
    const second = f.atomic(() => f.store.begin(f.owner, f.watch.id, 1));
    assert.equal(second.operationKey, first.operationKey);
    f.elapse(10); f.atomic(() => f.store.finish(first, { kind: 'failed', reason: 'old_call' }));
    assert.equal(f.store.watch(f.owner, f.watch.id).failedReads, 0);
    const charged = f.store.contract(f.owner, f.taskId)!.activeMs;
    f.atomic(() => f.store.finish(first, { kind: 'failed', reason: 'duplicate' }));
    assert.equal(f.store.contract(f.owner, f.taskId)!.activeMs, charged);
    f.atomic(() => f.store.finish(second, { kind: 'accepted', changed: false, valuesDigest: f.spec.lastValuesDigest,
      observedAt: new Date(f.now()).toISOString(), validUntil: new Date(f.now() + 60000).toISOString(), evidenceRefs: ['synthetic'] }));
    assert.equal(f.store.watch(f.owner, f.watch.id).health, 'fresh');
    assert.throws(() => f.store.watch('another-owner', f.watch.id), /unavailable/);
  } finally { f.db.close(); }
});

test('three unchanged failures pause observation and hints cannot extend the original deadline', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 3; i++) { const r = f.atomic(() => f.store.begin(f.owner, f.watch.id, 1)); f.atomic(() => f.store.finish(r, { kind: 'failed', reason: 'source_unavailable' })); f.elapse(10000); }
    assert.equal(f.store.watch(f.owner, f.watch.id).status, 'paused');
    assert.throws(() => f.atomic(() => f.store.hint(f.owner, f.watch.id, 'hint', 'a'.repeat(64))), /not active/);
    assert.throws(() => f.atomic(() => f.store.establish(f.owner, f.taskId, 1, { ...f.budget, until: new Date(f.now() + 3600000).toISOString() })), /original lifetime budget/);
    f.elapse(120000);
    assert.throws(() => f.atomic(() => f.store.resume(f.owner, f.watch.id, 1)), /horizon/);
  } finally { f.db.close(); }
});

test('elapsed time alone cannot complete observation across a freshness gap', () => {
  const f = fixture();
  try {
    f.elapse(70000);
    const read = f.atomic(() => f.store.begin(f.owner, f.watch.id, 1));
    f.atomic(() => f.store.finish(read, { kind: 'accepted', changed: false, valuesDigest: f.spec.lastValuesDigest,
      observedAt: new Date(f.now()).toISOString(), validUntil: new Date(f.now() + 60000).toISOString(), evidenceRefs: ['synthetic'] }));
    assert.equal(f.store.watch(f.owner, f.watch.id).coverageGapAt, f.spec.validUntil);
    f.elapse(50000); f.atomic(() => f.store.settle(f.owner, f.taskId, 1));
    assert.equal(f.store.watch(f.owner, f.watch.id).status, 'paused');
    assert.equal(f.store.watch(f.owner, f.watch.id).reason, 'observation_horizon_unverified');
  } finally { f.db.close(); }
});

test('a continuously fresh independent read can cover the authorized horizon', () => {
  const f = fixture();
  try {
    f.elapse(50000);
    const read = f.atomic(() => f.store.begin(f.owner, f.watch.id, 1));
    f.atomic(() => f.store.finish(read, { kind: 'accepted', changed: false, valuesDigest: f.spec.lastValuesDigest,
      observedAt: new Date(f.now()).toISOString(), validUntil: f.budget.until, evidenceRefs: ['synthetic'] }));
    f.elapse(70000); f.atomic(() => f.store.settle(f.owner, f.taskId, 1));
    assert.equal(f.store.watch(f.owner, f.watch.id).status, 'ended');
    assert.equal(f.store.watch(f.owner, f.watch.id).coverageGapAt, undefined);
  } finally { f.db.close(); }
});
