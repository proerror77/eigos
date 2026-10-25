import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { situationFixture, chooseSituation } from './fixtures/situation.js';
import { participantFixture, participantChoice } from './fixtures/free-booking.js';
import { owner, principal } from './backend-fixture.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';

test('SA06 evidence expiration wakes an unwatched component even without a provider notification', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = situationFixture({ durationMs: 2 * 86400000, registrationFreshnessMs: 3600000, choice: (ctx, access) => {
    const decision = chooseSituation(ctx, access), action = decision.steps[0];
    if (action?.action === 'StartObservationWatch') {
      const args = JSON.parse(action.argumentsJson);
      if (args.componentId === 'didi') return { kind: 'complete', requestRevision: ctx.request.revision, message: 'Only the event source has a standing read; transport freshness remains explicit', steps: [], completionJson: '{"rationale":"Current sources verified"}' };
      args.policy = { intervalMs: 3600000, maxAgeMs: 3600000 }; action.argumentsJson = JSON.stringify(args);
    }
    return decision;
  } });
  try {
    const job = f.submit(); const first = await f.until(job.id, current => current.delegation?.phase === 'watching');
    const before = f.modelCalls(), expiresAt = Date.parse(first.delegation!.agent!.components!.didi!.result!.delivery.validUntil!);
    assert.equal(first.delegation!.nextAt, expiresAt, 'The earlier component deadline, not the one-hour source watch, schedules wakeup');
    t.mock.timers.tick(300001);
    await f.run();
    const waiting = await f.until(job.id, current => current.delegation?.phase === 'watching');
    assert(f.modelCalls() > before); assert.equal(waiting.delegation!.agent!.components!.didi!.generation, 2);
    assert.equal(f.didi.calls.filter(call => call.name === 'maps_textsearch').length, 2); assert.equal(f.registration.counters().submits, 1);
  } finally { f.close(); t.mock.timers.reset(); }
});

test('SA15 the horizon triggers final independent readback before the root can complete', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = situationFixture({ durationMs: 10000, calendar: true });
  try {
    const job = f.submit(); await f.until(job.id, current => current.delegation?.phase === 'watching');
    assert.equal(f.store.get(owner, job.id).state, 'working');
    const reads = f.registration.counters().reads;
    t.mock.timers.tick(10001);
    const done = await f.until(job.id, current => current.state === 'completed');
    assert(f.registration.counters().reads > reads);
    assert.equal(done.delegation!.outcome!.status, 'satisfied'); assert.equal(done.delegation!.outcome!.evidenceLevel, 'synthetic');
    assert(f.store.situations.watches(owner, job.id).every(watch => watch.status === 'ended'));
    const report = f.tasks.get(principal, job.id).delegation!.situation!;
    assert.equal(report.status, 'ended'); assert.equal(report.effective, false);
  } finally { f.close(); t.mock.timers.reset(); }
});

test('SA15 an event canceled at the horizon cannot be hidden by earlier component success', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = situationFixture({ durationMs: 10000 });
  try {
    const job = f.submit(); await f.until(job.id, current => current.delegation?.phase === 'watching');
    f.event.state = 'canceled'; t.mock.timers.tick(10001);
    const stopped = await f.until(job.id, current => current.state === 'rejected');
    assert(!stopped.artifact); assert.equal(stopped.delegation!.outcome!.status, 'unsatisfied'); assert.equal(f.registration.counters().submits, 1);
  } finally { f.close(); t.mock.timers.reset(); }
});

test('A standalone participant task uses the same explicit read schedule without re-registering', async () => {
  const f = participantFixture({ choice: (ctx, access) => {
    const decision = participantChoice(ctx, access);
    if (decision.kind === 'complete' && ctx.request.monitoring && Date.now() < Date.parse(ctx.request.monitoring.until) && !ctx.situation?.watches.some(w => w.status === 'active')) {
      const completion = JSON.parse(decision.completionJson);
      return { ...decision, kind: 'execute', completionJson: '', steps: [{ id: 'watch', action: 'StartTaskObservationWatch', dependsOn: [], inputRefs: [],
        argumentsJson: JSON.stringify({ scope: ctx.state.scope, observation: completion.registration, action: 'ReadParticipantRegistration', argumentsJson: JSON.stringify({ scope: ctx.state.scope, previous: completion.registration }),
          policy: { intervalMs: 60000, maxAgeMs: 300000 }, refreshCompletion: true, completionJson: decision.completionJson }) }] } satisfies AgentDecision;
    }
    return decision;
  } });
  try {
    const job = f.submit({ monitoring: { until: new Date(Date.now() + 60000).toISOString(), maxQueries: 10 } });
    await f.until(current => current.delegation?.phase === 'watching');
    const before = f.store.get(owner, job.id).runs!.length, watch = f.store.situations.watches(owner, job.id)[0]!;
    f.tasks.reportSourceChange(principal, { action: 'report_source_change', taskId: job.id, watchId: watch.id, eventId: 'pa-notice', note: 'Please recheck the current source', requestId: randomUUID() });
    await f.run();
    const current = f.store.get(owner, job.id);
    assert.equal(current.runs!.length, before); assert.equal(current.delegation!.phase, 'watching'); assert.equal(f.counters().submits, 1);
    assert.equal((f.tasks.evaluateOntology(principal, { function: 'situationStatus', object: { type: 'ServiceRequest', id: job.id } }).value as { status: string }).status, 'satisfied');
  } finally { f.store.close(); }
});
