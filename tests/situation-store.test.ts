import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SituationStore } from '../packages/core/situation-store.js';
import { digest } from '../packages/core/delegation.js';
import type { SourceSample, WatchSelection } from '../packages/ontology/situation.js';

const owner = 'member-A', job = 'task-A';
const source = { bindingId: 'test-event', bindingDigest: digest('source'), accountRef: 'account-A', subjectId: 'event-1', mappingVersion: '1' };
function fixture(path = ':memory:') {
  let now = Date.now(), active = true, wakes = 0;
  const db = new DatabaseSync(path), store = new SituationStore(db, { active: () => active, wake: () => { wakes++; } }, () => now);
  const sample = (version: number | undefined, venue = 'A', id = `event-${version}-${now}`): SourceSample => ({ source, eventId: id,
    ...(version === undefined ? {} : { providerVersion: version }), observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 5000).toISOString(),
    authoritativeRead: true, data: { venue, title: 'Exhibition' }, evidenceRefs: [id], evidenceLevel: 'synthetic', object: { type: 'RegistrationRecord', id } });
  const selection: WatchSelection = { source, componentId: 'registration', generation: 1, scope: { type: 'RegistrationTask', id: job }, programRef: { id: 'booking.participant.free', version: '1' }, programDigest: digest('program'),
    action: 'ReadParticipantRegistration', input: { scope: { type: 'RegistrationTask', id: job } }, fields: ['venue'], modelRunId: 'model-selection', planId: 'model-plan', refreshCompletion: true };
  const contract = { until: new Date(now + 60_000).toISOString(), maxQueries: 10 };
  const start = (initial = sample(1)) => { store.establish(owner, job, 1, contract); return store.start(owner, job, 1, selection, { intervalMs: 1000, maxAgeMs: 5000 }, initial); };
  return { db, store, sample, selection, contract, start, now: () => now, advance: (ms: number) => { now += ms; }, setActive: (value: boolean) => { active = value; }, wakes: () => wakes, close: () => db.close() };
}

test('SA01 independent notices deduplicate across restart without claiming a business fact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-situation-')), path = join(directory, 'state.sqlite');
  const f = fixture(path);
  try {
    const watch = f.start(), notice = { eventId: 'provider-3', contentDigest: digest({ venue: 'B' }), kind: 'provider_hint' as const };
    const first = f.store.receive(owner, source, notice);
    assert.equal(f.store.receive(owner, source, notice).duplicate, true);
    assert.equal(f.wakes(), 1); assert.equal(f.store.watch(owner, watch.id).sample!.data.venue, 'A');
    const restarted = new SituationStore(f.db, { active: () => true, wake: () => { throw new Error('Duplicate must not wake'); } }, f.now);
    assert.equal(restarted.receive(owner, source, notice).id, first.id);
    assert.equal(restarted.pending(owner, job), true);
    assert.throws(() => restarted.assertCurrent(owner, job, restarted.revision(owner, job)), /current observation/);
  } finally { f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SA02 older source versions cannot replace current facts and same-version conflicts remain unknown', () => {
  const f = fixture();
  try {
    const watch = f.start();
    f.advance(100);
    const read = f.store.beginRead(owner, watch.id, 'lease');
    assert.equal(f.store.finishRead(read, f.sample(3, 'C'), () => true).changed, true);
    const revision = f.store.revision(owner, job);
    f.advance(100);
    const older = f.store.beginRead(owner, watch.id, 'lease');
    assert.equal(f.store.finishRead(older, f.sample(2, 'B'), () => true).applied, false);
    assert.equal(f.store.watch(owner, watch.id).sample!.data.venue, 'C');
    assert.equal(f.store.revision(owner, job), revision);
    const conflict = f.store.beginRead(owner, watch.id, 'lease');
    assert.equal(f.store.finishRead(conflict, f.sample(3, 'D', 'conflict'), () => true).conflicted, true);
    assert.equal(f.store.watch(owner, watch.id).sample!.data.venue, 'C');
    assert.equal(f.store.summary(owner, job)!.watches[0]!.health, 'conflicted');
    assert.throws(() => f.store.assertCurrent(owner, job, f.store.revision(owner, job)), /conflicted/);
  } finally { f.close(); }
});

test('SA03 an unversioned read started before another accepted read cannot overwrite it', () => {
  const f = fixture();
  try {
    const watch = f.start(f.sample(undefined));
    const oldRead = f.store.beginRead(owner, watch.id, 'old-lease');
    const newRead = f.store.beginRead(owner, watch.id, 'new-lease');
    f.advance(100);
    assert.equal(f.store.finishRead(newRead, f.sample(undefined, 'B', 'read-B'), () => true).applied, true);
    assert.equal(f.store.finishRead(oldRead, f.sample(undefined, 'A', 'read-A'), () => true).applied, false);
    assert.equal(f.store.watch(owner, watch.id).sample!.data.venue, 'B');
  } finally { f.close(); }
});

test('SA04 source projection, freshness, invalidation and wake roll back atomically', () => {
  const f = fixture();
  try {
    const watch = f.start(), initial = f.store.revision(owner, job), read = f.store.beginRead(owner, watch.id, 'lease');
    assert.throws(() => f.store.finishRead(read, f.sample(2, 'B'), () => true, () => { throw new Error('projection crash'); }), /projection crash/);
    assert.equal(f.store.watch(owner, watch.id).sample!.data.venue, 'A');
    assert.equal(f.store.revision(owner, job), initial);
    assert.equal(f.store.summary(owner, job)!.queries, 1, 'A dispatched read still consumes its query budget');
    assert.equal(f.store.finishRead(read, f.sample(2, 'B'), () => true).applied, true);
    assert.equal(f.store.changes(owner, job).length, 1);
  } finally { f.close(); }
});

test('SA05 unchanged observations refresh health without waking the decision loop; expiration is observable once', () => {
  const f = fixture();
  try {
    const watch = f.start(), revision = f.store.revision(owner, job);
    f.advance(1000);
    const read = f.store.beginRead(owner, watch.id, 'lease');
    assert.equal(f.store.finishRead(read, f.sample(1), () => true).changed, false);
    assert.equal(f.store.revision(owner, job), revision); assert.equal(f.wakes(), 0);
    f.advance(5001); f.store.expire(owner, job); f.store.expire(owner, job);
    assert.equal(f.wakes(), 1); assert.equal(f.store.summary(owner, job)!.status, 'observing'); assert.equal(f.store.summary(owner, job)!.effective, false);
    assert.equal(f.store.changes(owner, job).at(-1)!.reason, 'stale');
  } finally { f.close(); }
});

test('SA08 a notice arriving during a source read cannot be acknowledged by that read', () => {
  const f = fixture();
  try {
    const watch = f.start(), read = f.store.beginRead(owner, watch.id, 'lease');
    f.store.receive(owner, source, { eventId: 'new-event', contentDigest: digest('changed'), kind: 'provider_hint' });
    let projected = false;
    assert.equal(f.store.finishRead(read, f.sample(2, 'B'), () => true, () => { projected = true; }).applied, false);
    assert.equal(projected, false); assert.equal(f.store.pending(owner, job), true);
    const next = f.store.beginRead(owner, watch.id, 'lease');
    assert.equal(f.store.finishRead(next, f.sample(2, 'B'), () => true).applied, true);
    assert.equal(f.store.pending(owner, job), false);
  } finally { f.close(); }
});

test('SA09 revocation and late reads preserve audit but cannot change task facts or restart observation', () => {
  const f = fixture();
  try {
    const watch = f.start(), read = f.store.beginRead(owner, watch.id, 'lease');
    f.store.stop(owner, job, 'revoked', 'User revoked the contract');
    f.setActive(false);
    let projected = false;
    assert.equal(f.store.finishRead(read, f.sample(2, 'B'), () => true, () => { projected = true; }).applied, false);
    assert.equal(projected, false); assert.equal(f.store.watch(owner, watch.id).sample!.data.venue, 'A');
    assert.throws(() => f.store.beginRead(owner, watch.id, 'new-lease'), /authority ended/);
    assert.throws(() => f.store.start(owner, job, 1, f.selection, watch.policy, f.sample(2)), /authority/);
    assert.equal(f.store.due(owner, job).length, 0);
  } finally { f.close(); }
});

test('SA11 owner, source account and evidence level boundaries are enforced', () => {
  const f = fixture();
  try {
    const watch = f.start();
    assert.throws(() => f.store.watch('member-B', watch.id), /not found/);
    assert.throws(() => f.store.receive(owner, { ...source, accountRef: 'account-B' }, { eventId: 'x', contentDigest: digest('x'), kind: 'provider_hint' }), /No owned/);
    const read = f.store.beginRead(owner, watch.id, 'lease');
    assert.throws(() => f.store.finishRead(read, { ...f.sample(2), evidenceLevel: 'user_asserted' }, () => true), /user statement/);
    assert.throws(() => f.store.finishRead(read, { ...f.sample(2), source: { ...source, accountRef: 'B' } }, () => true), /owned binding/);
  } finally { f.close(); }
});

test('SA13 query and active-time budgets survive watch rebinding and request revisions', () => {
  const f = fixture();
  try {
    f.contract.maxQueries = 1;
    const watch = f.start(); f.store.beginRead(owner, watch.id, 'lease'); f.store.recordActiveTime(owner, job, 150);
    f.store.start(owner, job, 1, { ...f.selection, generation: 2 }, watch.policy, f.sample(1));
    assert.throws(() => f.store.beginRead(owner, watch.id, 'lease'), /budget exhausted/);
    f.store.establish(owner, job, 2, f.contract);
    assert.equal(f.store.summary(owner, job)!.queries, 1); assert.equal(f.store.summary(owner, job)!.activeMs, 150);
    assert.deepEqual(f.store.summary(owner, job)!.watches, [], 'Superseded watches do not pause the revised request');
    assert.equal(f.store.watch(owner, watch.id).superseded, true, 'Historical watch remains auditable');
  } finally { f.close(); }
});

test('SA15 final observation is bounded and preserves the last source result after the horizon', () => {
  const f = fixture();
  try {
    const watch = f.start(); f.advance(60_001);
    const read = f.store.beginRead(owner, watch.id, 'lease');
    f.store.finishRead(read, f.sample(1), () => true);
    assert.equal(f.store.watch(owner, watch.id).status, 'ended');
    assert.equal(f.store.summary(owner, job)!.status, 'ended');
    assert.equal(f.store.due(owner, job).length, 0);
  } finally { f.close(); }
});
