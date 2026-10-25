import test from 'node:test';
import assert from 'node:assert/strict';
import { situationFixture } from './fixtures/situation.js';
import { owner, principal } from './backend-fixture.js';
import { randomUUID } from 'node:crypto';
import { AgentReadError } from '../packages/core/agent-program.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { JobStore } from '../packages/core/store.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

test('SA05 a model-selected ongoing observation refreshes unchanged evidence without another model response', async () => {
  const f = situationFixture();
  try {
    const job = f.submit(); const waiting = await f.until(job.id, job => job.delegation?.phase === 'watching');
    assert.equal(waiting.state, 'working'); assert(!waiting.artifact); assert.equal(f.registration.counters().submits, 1);
    const calls = f.modelCalls(), reads = f.registration.counters().reads;
    f.notify(job.id); await f.run();
    const current = f.store.get(owner, job.id);
    assert.equal(current.delegation!.phase, 'watching', JSON.stringify(current.delegation!.agent!.feedback));
    assert.equal(f.modelCalls(), calls); assert.equal(f.registration.counters().reads, reads + 1);
    assert.equal(current.delegation!.agent!.components!.registration!.result!.validity, 'valid');
  } finally { f.close(); }
});

test('SA10 a lost synthetic calendar write response reconciles its original operation without duplicate items', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-calendar-recovery-')), calendarPath = join(directory, 'calendar.sqlite');
  const f = situationFixture({ calendar: true, calendarPath }), call = f.calendar.call.bind(f.calendar); let loseResponse = true;
  f.calendar.call = async (...args) => {
    const result = await call(...args);
    if (args[1] === 'CreateCalendarEntrySandbox' && !args[4] && loseResponse) { loseResponse = false; throw new Error('Synthetic response lost after committed calendar operation'); }
    return result;
  };
  try {
    const job = f.submit(), done = await f.until(job.id, current => current.delegation?.phase === 'watching');
    const intent = f.store.intents(owner, job.id).find(i => i.effect === 'change')!;
    assert.equal(intent.state, 'effect_confirmed');
    assert.equal(f.store.attempts(owner, intent.id).filter(a => a.kind === 'dispatch').length, 1);
    assert.equal(f.store.attempts(owner, intent.id).filter(a => a.kind === 'reconcile').length, 1);
    const db = new DatabaseSync(calendarPath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM calendar_items').get()!.n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM calendar_operations').get()!.n, 1);
    } finally { db.close(); }
    assert.equal(done.delegation!.agent!.components!.calendar!.result!.validity, 'valid');
  } finally { f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SA07 an event move invalidates consumed inputs and repairs their generations without another registration', async () => {
  const f = situationFixture();
  try {
    const job = f.submit(); await f.until(job.id, job => job.delegation?.phase === 'watching');
    const original = f.store.get(owner, job.id).delegation!.agent!.components!;
    const oldDidiScope = original.didi!.scope;
    f.event.venueName = '场馆 B'; f.event.venueAddress = '北京市场馆 B'; f.notify(job.id);
    await f.run();
    const changed = f.store.get(owner, job.id).delegation!.agent!.components!;
    assert.equal(changed.didi!.validity, 'stale');
    const waiting = await f.until(job.id, job => job.delegation?.phase === 'watching' && job.delegation.agent!.components!.didi!.generation === 2);
    const components = waiting.delegation!.agent!.components!;
    assert.equal(components.registration!.generation, 2); assert.equal(components.didi!.input!.keywords, '北京市场馆 B');
    assert.notDeepEqual(components.didi!.scope, oldDidiScope);
    assert.equal(components.didi!.history![0]!.result!.validity, 'superseded');
    assert.equal(f.registration.counters().submits, 1);
    assert.deepEqual(f.didi.calls.filter(call => call.name === 'maps_textsearch').map(call => call.args!.keywords), ['北京市场馆 A', '北京市场馆 B']);
  } finally { f.close(); }
});

test('SA07 a changed non-consumed event title preserves the already accepted transport component', async () => {
  const f = situationFixture();
  try {
    const job = f.submit(); await f.until(job.id, job => job.delegation?.phase === 'watching');
    const original = f.store.get(owner, job.id).delegation!.agent!.components!.didi!.result!.ref;
    f.event.title = 'Updated exhibition title'; f.notify(job.id); await f.run();
    const waiting = await f.until(job.id, job => job.delegation?.phase === 'watching');
    assert.equal(waiting.delegation!.agent!.components!.didi!.generation, 1);
    assert.deepEqual(waiting.delegation!.agent!.components!.didi!.result!.ref, original);
    assert.equal(f.didi.calls.filter(call => call.name === 'maps_textsearch').length, 1);
  } finally { f.close(); }
});

test('SA09 cancellation stops standing reads and does not reopen a task after a source notification', async () => {
  const f = situationFixture();
  try {
    const job = f.submit(); await f.until(job.id, job => job.delegation?.phase === 'watching');
    const watch = f.store.situations.watches(owner, job.id)[0]!, calls = f.registration.counters().reads;
    f.tasks.cancel(principal, job.id);
    f.store.situations.receive(owner, watch.selection.source, { eventId: 'late', contentDigest: 'a'.repeat(64), kind: 'provider_hint' });
    assert.equal(f.store.get(owner, job.id).state, 'canceled'); assert.equal(f.store.situations.due(owner, job.id).length, 0);
    assert.equal(f.registration.counters().reads, calls);
  } finally { f.close(); }
});

test('SA07 three services repair a changed venue using the original calendar item and a separate exact update grant', async () => {
  const f = situationFixture({ calendar: true });
  try {
    const job = f.submit(); await f.until(job.id, job => job.delegation?.phase === 'watching');
    const first = f.store.get(owner, job.id).delegation!.agent!.components!.calendar!;
    const eventId = f.store.ontology.read(owner, first.scope!).properties.originalEventId;
    assert(eventId);
    f.event.venueAddress = '北京市场馆 B'; f.notify(job.id); await f.run();
    const waiting = await f.until(job.id, job => job.delegation?.phase === 'watching' && job.delegation.agent!.components!.calendar!.generation === 2);
    const second = waiting.delegation!.agent!.components!.calendar!;
    assert.equal(f.store.ontology.read(owner, second.scope!).properties.originalEventId, eventId);
    assert.equal(second.input!.location, '北京市场馆 B');
    assert.equal((second.result!.delivery.artifact.data.result as { calendar: { providerEventId: string; entry: { location: string } } }).calendar.entry.location, '北京市场馆 B');
    assert.equal(f.calendarCalls.filter(action => action === 'CreateCalendarEntrySandbox').length, 1);
    assert.equal(f.calendarCalls.filter(action => action === 'UpdateCalendarEntrySandbox').length, 1);
    assert.equal(f.registration.counters().submits, 1);
    assert.equal(f.store.grants(owner, job.id).length, 3, 'Registration, calendar creation and calendar update have distinct exact grants');
    const situation = f.tasks.evaluateOntology(principal, { function: 'situationStatus', object: { type: 'ServiceRequest', id: job.id } });
    assert.equal(situation.status, 'known'); assert.equal((situation.value as { status: string }).status, 'satisfied');
    assert.equal(waiting.state, 'working', 'Current satisfaction does not complete a future monitoring horizon');
  } finally { f.close(); }
});

test('SA13 observation uses cumulative budgets and can outlive the ordinary task wall-clock limit', async () => {
  const f = situationFixture({ maxQueries: 2 });
  try {
    const job = f.submit(), old = f.store.get(owner, job.id); old.createdAt = new Date(Date.now() - 2 * 86400000).toISOString(); f.store.save(owner, old);
    await f.until(job.id, job => job.delegation?.phase === 'watching');
    const calls = f.modelCalls();
    for (let i = 0; i < 3; i++) { f.notify(job.id); await f.run(); }
    const stopped = f.store.get(owner, job.id), summary = f.store.situations.summary(owner, job.id)!;
    assert.equal(stopped.state, 'input-required'); assert.equal(summary.queries, 2); assert.equal(f.modelCalls(), calls);
    const watch = f.store.situations.watches(owner, job.id).find(w => w.status === 'paused')!;
    assert.throws(() => f.tasks.resumeObservation(principal, { action: 'resume_observation', taskId: job.id, watchId: watch.id, requestId: randomUUID() }), /budget ended/);
  } finally { f.close(); }
});

test('SA05 three failed source reads pause only that observation; explicit resumption preserves its budget and task identity', async () => {
  const f = situationFixture();
  try {
    const job = f.submit(); await f.until(job.id, job => job.delegation?.phase === 'watching');
    const original = f.registration.source.call, calls = f.modelCalls();
    f.registration.source.call = async () => { throw new AgentReadError('Synthetic source offline'); };
    for (let i = 0; i < 3; i++) { f.notify(job.id); await f.run(); }
    const paused = f.store.situations.watches(owner, job.id).find(w => w.selection.componentId === 'registration')!;
    assert.equal(paused.status, 'paused'); assert.equal(f.modelCalls(), calls); assert.equal(f.store.get(owner, job.id).state, 'input-required');
    f.registration.source.call = original;
    f.tasks.resumeObservation(principal, { action: 'resume_observation', taskId: job.id, watchId: paused.id, requestId: randomUUID() });
    const done = await f.until(job.id, job => job.delegation?.phase === 'watching');
    assert.equal(done.id, job.id); assert(f.store.situations.summary(owner, job.id)!.queries >= 4); assert.equal(f.registration.counters().submits, 1);
  } finally { f.close(); }
});

test('SA14 a source notice arriving during a completion decision prevents stale goal acceptance', async () => {
  const f = situationFixture();
  try {
    const original = f.model.act!; let injected = false;
    f.model.act = async (...args) => {
      const result = await original(...args);
      if (!injected && result.decision.kind === 'complete') { injected = true; f.event.venueAddress = '北京市场馆 B'; f.notify(args[0].request.id); }
      return result;
    };
    const job = f.submit();
    await f.until(job.id, current => current.delegation!.events.some(event => event.event === 'agent_decision_superseded_by_source_change'));
    const blocked = f.store.get(owner, job.id);
    assert(!blocked.artifact); assert.equal(blocked.delegation!.agent!.monitoringSelection, undefined);
    const waiting = await f.until(job.id, current => current.delegation?.phase === 'watching');
    assert.equal(waiting.delegation!.agent!.components!.didi!.input!.keywords, '北京市场馆 B');
  } finally { f.close(); }
});

test('SA16 a new store and coordinator resume durable watches and repair the existing graph', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-observation-restart-')), path = join(directory, 'tasks.sqlite');
  const f = situationFixture({ path }); let restarted: JobStore | undefined;
  try {
    const job = f.submit(); await f.until(job.id, current => current.delegation?.phase === 'watching');
    const initialModels = f.modelCalls();
    restarted = new JobStore(path);
    const catalog = createExecutionCatalog({ store: restarted, participantBookingSource: f.registration.source, didi: { ...f.didi.binding, connector: f.didi.connector } });
    const coordinator = new Coordinator(restarted, f.model, catalog, { allowSandbox: true });
    const watch = restarted.situations.watches(owner, job.id).find(w => w.selection.componentId === 'registration')!;
    restarted.situations.receive(owner, watch.selection.source, { eventId: 'restart-read', contentDigest: 'a'.repeat(64), kind: 'provider_hint' });
    await coordinator.run(restarted.claim(['eigos.delegate'], 15000)!, new AbortController().signal);
    assert.equal(f.modelCalls(), initialModels, 'Unchanged read after restart does not restart planning');
    f.event.venueAddress = '北京市场馆 B'; restarted.situations.receive(owner, watch.selection.source, { eventId: 'restart-change', contentDigest: 'b'.repeat(64), kind: 'provider_hint' });
    for (let i = 0; i < 20; i++) {
      const current = restarted.get(owner, job.id);
      if (current.delegation!.phase === 'watching' && current.delegation!.agent!.components!.didi!.generation === 2) break;
      const claim = restarted.claim(['eigos.delegate'], 15000); assert(claim); await coordinator.run(claim, new AbortController().signal);
    }
    const final = restarted.get(owner, job.id);
    assert.equal(final.delegation!.phase, 'watching'); assert.equal(final.delegation!.agent!.components!.didi!.input!.keywords, '北京市场馆 B');
    assert.equal(f.registration.counters().submits, 1);
  } finally { restarted?.close(); f.close(); rmSync(directory, { recursive: true, force: true }); }
});
