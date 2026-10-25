import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { paFactsFixture } from './fixtures/pa-questions.js';
import { owner, principal } from './backend-fixture.js';

test('PA facts stay in the same task and require no connection, provider IDs, write intent or grant', async () => {
  const f = paFactsFixture();
  try {
    const task = f.submit(), waiting = await f.until(task.id, job => job.delegation?.phase === 'awaiting_pa_answer');
    const q = waiting.delegation!.paQuestion!.question;
    assert.equal(q.informationOnly, true); assert.equal(q.connectionsStayWithPA, true);
    assert.equal(q.grantsConnectionAccess, false); assert.equal(q.grantsActionAuthority, false);
    assert(!JSON.stringify(q).includes('accountRef')); assert(!JSON.stringify(q).includes('calendarId'));
    assert.equal(waiting.state, 'input-required'); assert.equal(waiting.messages.at(-1)!.id, q.id);
    f.answer(waiting);
    const done = await f.until(task.id, job => job.state === 'completed');
    assert.equal(done.id, task.id); assert.equal(done.delegation!.outcome!.evidenceLevel, 'pa_reported');
    const output = done.artifact!.data.result as Record<string, unknown>;
    assert.equal(output.authorizationTransferred, false); assert.equal(output.calendarOperationExecutedByEigos, false);
    assert(f.store.intents(owner, task.id).every(intent => intent.effect === 'read'));
    assert.equal(f.store.budget(owner, task.id).length, 0);
    assert(!done.delegation!.authorizationRequest);
  } finally { f.close(); }
});

test('unknown, needs_user and inferred answers remain unresolved; a confirmed revision resumes the original query', async () => {
  const f = paFactsFixture();
  try {
    const task = f.submit(); let current = await f.until(task.id, job => job.state === 'input-required');
    const count = f.modelCalls(), initialIntent = f.store.intents(owner, task.id)[0]!.id;
    for (const answer of [{ status: 'unknown' as const, reason: 'No current information', observedAt: new Date().toISOString() }, { status: 'needs_user' as const, reason: 'User decision pending', observedAt: new Date().toISOString() }, { ...f.known(), basis: 'inferred' as const }]) {
      current = f.answer(current, answer);
      assert.equal(current.state, 'input-required'); assert.equal(current.delegation!.phase, 'awaiting_pa_answer'); assert(!current.artifact);
      assert.equal(f.modelCalls(), count); assert.equal(f.store.claim(['eigos.delegate'], 1000), undefined);
    }
    f.answer(current); const done = await f.until(task.id, job => job.state === 'completed');
    assert.equal(done.delegation!.paQuestion!.answerRevision, 4);
    assert.deepEqual(f.store.intents(owner, task.id).map(i => i.id), [initialIntent]);
  } finally { f.close(); }
});

test('PA answers enforce owner, original client, exact question, revision, event and freshness, including retry authentication', async () => {
  const f = paFactsFixture();
  try {
    const task = f.submit(), waiting = await f.until(task.id, job => job.state === 'input-required'), report = f.report(waiting);
    assert.throws(() => f.tasks.answerPAQuestion({ ...principal, subject: 'other' }, report), /not found/i);
    assert.throws(() => f.tasks.answerPAQuestion({ ...principal, clientId: 'other-pa' }, report), /original requesting PA/);
    assert.throws(() => f.tasks.answerPAQuestion(principal, report, randomUUID()), /Context/);
    assert.throws(() => f.tasks.answerPAQuestion(principal, { ...report, questionDigest: 'b'.repeat(64) }), /question/);
    assert.throws(() => f.tasks.answerPAQuestion(principal, { ...report, expectedAnswerRevision: 1 }), /revision/);
    const known = f.known(); assert(known.status === 'known');
    assert.throws(() => f.tasks.answerPAQuestion(principal, { ...report, answer: { ...known, facts: { ...known.facts, subjectKey: 'other-event' } } }), /another event/);
    assert.throws(() => f.tasks.answerPAQuestion(principal, { ...report, answer: { ...known, observedAt: new Date(Date.now() - 600000).toISOString() } }), /fresh/);
    assert.throws(() => f.tasks.answerPAQuestion(principal, { ...report, accessToken: 'not-an-accepted-field' }));
    const accepted = f.tasks.answerPAQuestion(principal, report);
    assert.equal(f.tasks.answerPAQuestion(principal, report).delegation!.paQuestion!.answerRevision, 1);
    assert.throws(() => f.tasks.answerPAQuestion({ ...principal, clientId: 'other-pa' }, report), /original requesting PA/);
    assert.throws(() => f.tasks.answerPAQuestion(principal, { ...report, answer: { ...known, basis: 'user_confirmed' } }), /different input/);
    assert.equal(accepted.id, task.id);
  } finally { f.close(); }
});

test('late answers after cancellation are recorded without reopening or adding successful evidence', async () => {
  const f = paFactsFixture();
  try {
    const task = f.submit(), waiting = await f.until(task.id, job => job.state === 'input-required');
    f.tasks.cancel(principal, task.id);
    const late = f.tasks.answerPAQuestion(principal, f.report(waiting));
    assert.equal(late.state, 'canceled'); assert(!late.artifact);
    assert.equal(f.store.paQuestions.get(owner, waiting.delegation!.paQuestion!.question.id).answerRevision, 1);
    assert(late.delegation!.events.some(event => event.event === 'late_pa_answer_audit_only'));
    assert(!late.delegation!.agent!.observations.some(ref => ref.type === 'PACalendarAnswer'));
    assert.equal(f.store.claim(['eigos.delegate'], 1000), undefined);
  } finally { f.close(); }
});

test('pending factual questions and answer revisions survive worker and gateway restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-pa-facts-')), f = paFactsFixture(join(dir, 'tasks.db'));
  let restarted: JobStore | undefined;
  try {
    const task = f.submit(), waiting = await f.until(task.id, job => job.state === 'input-required'); f.close();
    restarted = new JobStore(join(dir, 'tasks.db'));
    const catalog = createExecutionCatalog({ store: restarted }), tasks = new TaskService(restarted, { catalog });
    tasks.answerPAQuestion(principal, f.report(waiting));
    const worker = new Coordinator(restarted, f.model, catalog);
    for (let i = 0; i < 8 && restarted.get(owner, task.id).state !== 'completed'; i++) {
      const claim = restarted.claim(['eigos.delegate'], 15000); assert(claim); await worker.run(claim, new AbortController().signal);
    }
    assert.equal(restarted.get(owner, task.id).state, 'completed');
    assert.equal(restarted.intents(owner, task.id).length, 1);
  } finally { restarted?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('standing observation asks PA again without transferring its connection; changed facts invalidate earlier success', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = paFactsFixture();
  try {
    const task = f.submit({ monitoring: { until: new Date(Date.now() + 600000).toISOString(), maxQueries: 8 } });
    f.answer(await f.until(task.id, job => job.state === 'input-required'));
    await f.until(task.id, job => job.delegation?.phase === 'watching');
    const before = f.modelCalls(); t.mock.timers.tick(60001); await f.run();
    const pending = f.store.get(owner, task.id); assert.equal(pending.delegation!.phase, 'awaiting_pa_answer');
    const q = pending.delegation!.paQuestion!.question; assert(q.observation); assert.equal(q.grantsActionAuthority, false);
    assert.equal(f.modelCalls(), before);
    assert.throws(() => f.answer(pending, { ...f.known(), observedAt: new Date(Date.parse(q.askedAt) - 1).toISOString() }), /fresh/);
    f.answer(pending); await f.run();
    const resumed = await f.until(task.id, job => job.delegation?.phase === 'watching'); assert.equal(resumed.state, 'working');
    assert.equal(f.modelCalls(), before, 'Same confirmed facts refresh validity without another model call');
    t.mock.timers.tick(60001); await f.run();
    const next = f.store.get(owner, task.id), known = f.known(); assert(known.status === 'known' && known.facts.exists);
    f.answer(next, { ...known, facts: { ...known.facts, arrangement: { ...known.facts.arrangement, location: '场馆 B' } } });
    const changed = await f.until(task.id, job => job.state === 'input-required');
    assert(!changed.artifact); assert.equal(changed.delegation!.phase, 'clarifying'); assert(f.modelCalls() > before);
    const resumedTask = f.tasks.reply(principal, { taskId: task.id, requestId: randomUUID(), answer: '目标仍是场馆 A，请继续向 PA 核对当前事实。' });
    assert.equal(resumedTask.delegation!.request.revision, 2); assert(!resumedTask.delegation!.paQuestion);
    const revised = await f.until(task.id, job => job.delegation?.phase === 'awaiting_pa_answer');
    assert.equal(revised.delegation!.paQuestion!.question.requestRevision, 2);
    assert.deepEqual(f.store.situations.summary(owner, task.id)!.watches, []);
  } finally { f.close(); t.mock.timers.reset(); }
});

test('revoking a pending PA observation keeps a late answer inert and explicit resume asks a new question', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = paFactsFixture();
  try {
    const task = f.submit({ monitoring: { until: new Date(Date.now() + 600000).toISOString(), maxQueries: 8 } });
    f.answer(await f.until(task.id, job => job.state === 'input-required'));
    await f.until(task.id, job => job.delegation?.phase === 'watching');
    t.mock.timers.tick(60001); await f.run(); const pending = f.store.get(owner, task.id), watchId = pending.delegation!.paQuestion!.question.observation!.watchId;
    f.tasks.revokeObservation(principal, { action: 'revoke_observation', taskId: task.id, watchId, requestId: randomUUID() });
    const late = f.answer(pending); assert.equal(late.state, 'input-required'); assert.equal(late.delegation!.phase, 'clarifying');
    assert(late.delegation!.events.some(e => e.event === 'late_pa_answer_audit_only'));
    f.tasks.resumeObservation(principal, { action: 'resume_observation', taskId: task.id, watchId, requestId: randomUUID() });
    await f.run(); const fresh = f.store.get(owner, task.id); assert.equal(fresh.delegation!.phase, 'awaiting_pa_answer');
    assert.notEqual(fresh.delegation!.paQuestion!.question.id, pending.delegation!.paQuestion!.question.id);
    f.answer(fresh); const continued = await f.until(task.id, job => job.delegation?.phase === 'watching'); assert.equal(continued.state, 'working');
  } finally { f.close(); t.mock.timers.reset(); }
});
