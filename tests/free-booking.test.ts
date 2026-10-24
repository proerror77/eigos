const validationBlocked = (job: import('../packages/core/domain.js').Job) => job.state === 'paused' && job.delegation?.recovery?.code === 'validation_stalled' && job.delegation.recovery.state === 'blocked' && job.delegation.recovery.ownerInputRequired === false;
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { participantFixture } from './fixtures/free-booking.js';
import { owner, principal } from './backend-fixture.js';
import { readConfig } from '../packages/core/config.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { registrationInputSchema } from '../packages/ontology/free-booking.js';
import type { Job } from '../packages/core/domain.js';
import { initialActionIds, bindInitialSelection } from '../packages/coordinator/initial-selection.js';
import { interpretation } from './backend-fixture.js';

test('the retained initial MCP read optimization cannot draft participant operations before their source and exact grant', async () => {
  const f = participantFixture(); try {
    f.submit(); const job = await f.run(), program = f.catalog.agentProgram({ id: 'booking.participant.free', version: '1' }, owner)!;
    assert.deepEqual(initialActionIds(f.store.ontology, program), []);
    for (const action of ['InspectRegistrationPage', 'SubmitFreeRegistrationSandbox']) {
      assert.throws(() => bindInitialSelection(f.store.ontology, program, job.delegation!.agent!.scope, { ...interpretation(job.delegation!.request, program.ref.id, f.input), capabilityRef: program.ref, initialSteps: [{ id: 'unapproved', action, argumentsJson: '{}', scopeInputs: ['scope'] }] }), /read-only MCP actions/);
    }
    assert.equal(f.counters().submits, 0);
  } finally { f.store.close(); }
});

for (const kind of ['event_registration', 'appointment'] as const) test(`${kind}: proven free participant reservation completes after an independent read without payment`, async () => {
  const f = participantFixture({ kind });
  try {
    f.submit(); const job = await f.until(j => j.state === 'completed');
    assert.equal(job.delegation!.acceptance!.accepted, true);
    assert.equal(job.delegation!.agent!.paPayment, undefined);
    assert.equal((job.artifact!.data.result as any).registration.state, 'confirmed');
    assert.equal((job.artifact!.data.result as any).evidenceLevel, 'synthetic');
    assert.equal((job.artifact!.data.result as any).paymentRequired, false);
    assert.equal(f.counters().submits, 1);
    assert(f.store.intents(owner, job.id).every(i => !['payment', 'order'].includes(i.effect)));
    assert(job.delegation!.agent!.plans.some(p => p.steps.some(s => s.action === 'ReadParticipantRegistration')));
    assert.throws(() => f.store.ontology.read('other-owner', f.last(job, 'RegistrationRecord')));
  } finally { f.store.close(); }
});

test('submission-only target accepts an independently read pending application; confirmation target keeps tracking it', async () => {
  const submitted = participantFixture({ target: 'submitted', state: 'pending_approval' });
  try { submitted.submit(); const done = await submitted.until(j => j.state === 'completed'); assert.equal((done.artifact!.data.result as any).registration.state, 'pending_approval'); assert.match(done.artifact!.data.deliverable, /提交回执/); } finally { submitted.store.close(); }
  const confirmed = participantFixture({ state: 'pending_approval' });
  try {
    confirmed.submit(); const waiting = await confirmed.until(j => (j.delegation?.nextAt ?? 0) > Date.now() && j.delegation?.agent?.plans.at(-1)?.steps[0]?.action === 'WaitForRegistration');
    assert.equal(waiting.state, 'working'); assert.equal(waiting.artifact, undefined);
    assert(!confirmed.store.intents(owner, waiting.id).some(i => i.state === 'needs_review'));
    confirmed.setState('confirmed'); const done = await confirmed.until(j => j.state === 'completed');
    assert.equal((done.artifact!.data.result as any).registration.state, 'confirmed'); assert.equal(confirmed.counters().submits, 1);
  } finally { confirmed.store.close(); }
});

test('waitlist is a durable in-progress state, not a failure or confirmed participation', async () => {
  const f = participantFixture({ state: 'waitlisted' });
  try {
    f.submit(); const waiting = await f.until(j => (j.delegation?.nextAt ?? 0) > Date.now() && j.delegation?.agent?.plans.at(-1)?.steps[0]?.action === 'WaitForRegistration');
    assert.equal(waiting.artifact, undefined); assert.equal(waiting.state, 'working');
    const computed = f.store.ontology.evaluate(owner, { function: 'registrationStatus', object: f.last(waiting, 'RegistrationRecord') });
    assert.equal((computed.value as any).status, 'waitlisted'); assert.equal((computed.value as any).confirmed, false);
    f.setState('confirmed'); await f.until(j => j.state === 'completed'); assert.equal(f.counters().submits, 1);
  } finally { f.store.close(); }
});

for (const flag of ['paid', 'missingFees', 'consent'] as const) test(`${flag}: unproven free terms or additional consent prevent a participant write`, async () => {
  const f = participantFixture(); f.flags[flag] = true;
  try { f.submit(); const rejected = await f.until(j => j.state === 'rejected'); assert.equal(rejected.artifact, undefined); assert.equal(f.counters().submits, 0); } finally { f.store.close(); }
});

test('a browser observation for another signed-in participant cannot authorize registration', async () => {
  const f = participantFixture(); f.flags.wrongParticipant = true;
  try { f.submit(); const blocked = await f.until(validationBlocked); assert.equal(blocked.artifact, undefined); assert.equal(f.counters().submits, 0); } finally { f.store.close(); }
});

test('an asynchronous source stays on its original key through more than three healthy pending reads', async () => {
  const f = participantFixture({ asyncSubmit: true });
  try {
    f.submit(); const pending = await f.until(() => f.counters().recoveries >= 4);
    assert.equal(pending.state, 'working'); assert.equal(f.counters().submits, 1);
    const write = f.store.intents(owner, pending.id).find(i => i.effect === 'reserve')!;
    assert.equal(write.state, 'awaiting_remote'); assert.equal(write.failedQueries, 0);
    f.release(); await f.until(j => j.state === 'completed'); assert.equal(f.counters().submits, 1);
  } finally { f.store.close(); }
});

test('canceling an accepted participant operation preserves cancellation through late source recovery', async () => {
  const f = participantFixture({ asyncSubmit: true });
  try {
    f.submit(); const pending = await f.until(j => f.store.intents(owner, j.id).some(i => i.state === 'awaiting_remote'));
    f.tasks.cancel(principal, pending.id); f.release();
    const claim = f.store.claim(['eigos.delegate'], 15000);
    if (claim) await f.coordinator.run(claim, new AbortController().signal);
    const canceled = f.store.get(owner, pending.id); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.artifact, undefined); assert.equal(f.counters().submits, 1);
  } finally { f.store.close(); }
});

test('a definitive rejection returned during asynchronous readback releases the reservation instead of becoming unknown', async () => {
  const f = participantFixture({ asyncSubmit: true }); f.flags.rejectSubmit = true;
  try {
    f.submit(); await f.until(j => f.store.intents(owner, j.id).some(i => i.state === 'awaiting_remote')); f.release();
    const rejected = await f.until(j => f.store.intents(owner, j.id).some(i => i.effect === 'reserve' && i.state === 'rejected'));
    const intent = f.store.intents(owner, rejected.id).find(i => i.effect === 'reserve')!;
    assert.equal(intent.failedQueries, 0); assert.equal(rejected.artifact, undefined); assert.equal(f.counters().submits, 1);
    assert(f.store.budget(owner, rejected.id).every(b => b.state === 'released'));
  } finally { f.store.close(); }
});

test('a fresh task cannot create another registration for the same participant, event and occurrence', async () => {
  const f = participantFixture();
  try {
    f.submit(); await f.until(j => j.state === 'completed');
    const second = f.submit(); const blocked = await f.until(j => j.id === second.id && validationBlocked(j));
    assert.equal(blocked.artifact, undefined); assert.equal(f.counters().submits, 1);
  } finally { f.store.close(); }
});

test('readback cannot replace the original registration reference or complete without confirmation evidence', async () => {
  const f = participantFixture();
  try {
    f.submit(); await f.until(j => !!j.delegation?.agent?.observations.some(r => r.type === 'RegistrationRecord'));
    f.flags.changedReference = true;
    const blocked = await f.until(validationBlocked); assert.equal(blocked.artifact, undefined); assert.equal(f.counters().submits, 1);
  } finally { f.store.close(); }
  const missing = participantFixture(); missing.flags.noConfirmation = true;
  try {
    missing.submit(); const read = await missing.until(j => !!j.delegation?.agent?.observations.filter(r => r.type === 'RegistrationRecord').length && (missing.store.ontology.read(owner, missing.last(j, 'RegistrationRecord')).properties.data as any).independentRead);
    const state = missing.store.ontology.evaluate(owner, { function: 'registrationStatus', object: missing.last(read, 'RegistrationRecord') }); assert.equal((state.value as any).confirmed, false); assert.equal(read.artifact, undefined);
  } finally { missing.store.close(); }
});

test('participant config is explicit, account-bound and loopback-only; grants do not authorize another environment', async () => {
  const base = { EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(40) };
  assert.throws(() => readConfig({ ...base, EIGOS_FREE_BOOKING_BRIDGE_URL: 'http://127.0.0.1:3456' }));
  const config = { ...base, EIGOS_FREE_BOOKING_BRIDGE_URL: 'http://127.0.0.1:3456', EIGOS_FREE_BOOKING_TOKEN_FILE: '/private/participant-token', EIGOS_FREE_BOOKING_BINDING_ID: 'fixture', EIGOS_FREE_BOOKING_ATTENDEE_SHA256: 'a'.repeat(64) };
  assert(readConfig(config));
  for (const changed of [{ EIGOS_FREE_BOOKING_BRIDGE_URL: 'https://example.com' }, { EIGOS_FREE_BOOKING_TOKEN_FILE: 'relative' }, { NODE_ENV: 'production' }]) assert.throws(() => readConfig({ ...config, ...changed }));
  assert(!createExecutionCatalog().summaries(owner, 30, 'live').some(c => c.ref.id === 'booking.participant.free'));
  assert.throws(() => registrationInputSchema.parse({ kind: 'event_registration', serviceUrl: 'http://example.com/e', completionTarget: 'confirmed', participants: 1, startsAt: null }));
  const f = participantFixture();
  try {
    f.submit(); const ready: Job = await f.until(j => j.state === 'auth-required'); const a = ready.delegation!.authorizationRequest!;
    assert.throws(() => f.tasks.authorize(principal, ready.id, { action: 'approve_plan', requestId: randomUUID(), planDigest: a.planDigest, allowedEffects: ['reserve'], maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'live_free' }));
    assert.equal(f.counters().submits, 0);
  } finally { f.store.close(); }
});

for (const requirement of [
  { id: 'two-people', kind: 'quantity', role: 'participant_count', strength: 'hard', expected: { amount: '2', unit: 'person' } },
  { id: 'unsupported-venue', kind: 'location', strength: 'hard', expected: { ref: 'specific-venue-not-proven-by-source' } },
]) test(`${requirement.id}: hard requirements block a partial participant registration before writing`, async () => {
  const f = participantFixture();
  try { f.submit({ requirements: [requirement] }); const blocked = await f.until(validationBlocked); assert.equal(blocked.artifact, undefined); assert.equal(f.counters().submits, 0); } finally { f.store.close(); }
});
