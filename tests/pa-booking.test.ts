import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setupPABooking, bookingProgramRef } from './fixtures/pa-booking.js';
import { owner, principal } from './backend-fixture.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { bookingChoice } from './fixtures/pa-booking.js';
import { commerceStep } from './fixtures/commerce-agent.js';
import { digest } from '../packages/core/delegation.js';
import { JobStore } from '../packages/core/store.js';
import { backend } from './backend-fixture.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('PA booking capability requires explicit isolated provider configuration and has no payment action', async () => {
  const t = await setupPABooking(); try {
    assert(!createExecutionCatalog().summaries(owner, 32, 'sandbox').some(c => c.ref.id === bookingProgramRef.id));
    assert(!t.catalog.summaries(owner, 32, 'live').some(c => c.ref.id === bookingProgramRef.id));
    const program = t.catalog.agentProgram(bookingProgramRef, owner)!;
    assert(program.capability().actions.every(a => a.effect !== 'payment')); assert.throws(() => program.schema('PayStripePayment'));
    assert.equal(t.provider.audit().length, 0);
    const env = { EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(40), EIGOS_ACTION_SANDBOX: 'true', EIGOS_BOOKING_SANDBOX_URL: t.provider.endpoint, EIGOS_BOOKING_SANDBOX_TOKEN_FILE: t.settings.tokenFile };
    assert.equal(readConfig(env).EIGOS_BOOKING_SANDBOX_URL, readWorkerConfig(env).EIGOS_BOOKING_SANDBOX_URL);
    for (const changed of [{ EIGOS_ACTION_SANDBOX: 'false' }, { NODE_ENV: 'production' }, { EIGOS_BOOKING_SANDBOX_URL: 'https://real-merchant.example' }, { EIGOS_BOOKING_SANDBOX_TOKEN_FILE: 'relative' }, { EIGOS_STRIPE_TEST_ENABLED: 'true' }]) assert.throws(() => readWorkerConfig({ ...env, ...changed }));
  } finally { await t.close(); }
});

test('EIGOS pauses on an unpaid booking, PA pays separately, then both independent provider reads close the same task', async () => {
  const t = await setupPABooking(); try {
    const id = t.submit().id, handoff = await t.finish(id);
    assert.equal(handoff.state, 'input-required', JSON.stringify({ feedback: handoff.delegation?.agent?.feedback, error: handoff.error })); assert.equal(handoff.delegation!.phase, 'awaiting_pa_payment'); assert.equal(handoff.artifact, undefined);
    const payment = handoff.delegation!.agent!.paPayment!;
    assert.equal(payment.status, 'awaiting_pa'); assert.equal(payment.request.terms.amount.minor, '12500'); assert.equal(t.provider.countBookings(), 1);
    assert.equal(t.wallet.attempts.length, 0); assert(t.provider.audit().every(a => a.caller === 'eigos_source'));
    assert.equal(t.store.grants(owner, id).length, 1); assert.deepEqual(t.store.grants(owner, id)[0]!.allowedEffects, ['reserve']); assert.equal(t.store.grants(owner, id)[0]!.maxAmount?.minor, '0');
    const grant = t.store.grants(owner, id)[0]!;
    const authorization = t.store.ontology.read(owner, { type: 'Authorization', id: grant.id });
    assert.deepEqual(authorization.properties.allowedActions, ['CreatePendingBooking']);
    assert.deepEqual(authorization.properties.allowedEffects, ['reserve']);
    const proposals = t.store.ontology.related(owner, authorization.ref, 'proposal', { remaining: 1000 })!;
    assert.equal(proposals.length, 1); assert.equal(proposals[0]!.properties.kind, 'execution');
    assert.equal(proposals[0]!.properties.authorizationMode, 'required');
    assert.equal(proposals[0]!.properties.completionTarget, 'domain');
    assert.equal(proposals[0]!.properties.termsVersion, grant.planDigest);
    const plans = t.store.ontology.related(owner, authorization.ref, 'executionPlan', { remaining: 1000 })!;
    assert.equal(plans[0]!.properties.planDigest, grant.planDigest);
    const step = t.store.ontology.related(owner, plans[0]!.ref, 'steps', { remaining: 1000 })![0]!;
    assert.equal(step.properties.effect, 'reserve');
    await t.wallet.pay(payment.request);
    assert.equal(t.store.get(owner, id).state, 'input-required', 'Provider payment alone does not rewrite the task');
    t.report(handoff);
    const done = await t.finish(id);
    assert.equal(done.state, 'completed', JSON.stringify({ feedback: done.delegation?.agent?.feedback, error: done.error }));
    const data = done.artifact!.data.result as any;
    assert.equal(data.payment.state, 'paid'); assert.equal(data.booking.state, 'confirmed'); assert.equal(data.handoffId, payment.request.id); assert.equal(data.paymentAuthority, 'pa_owned'); assert.equal(data.realPayment, false);
    assert.equal(data.payment.bookingId, data.booking.bookingId); assert.equal(data.booking.bookingId, payment.request.terms.bookingId);
    assert.equal(done.delegation!.agent!.paPayment!.status, 'verified'); assert.equal(t.provider.audit().filter(a => a.caller === 'pa_wallet').length, 1);
    assert.equal(t.store.intents(owner, id).filter(i => i.effect === 'payment').length, 0); assert(!t.store.budget(owner, id).some(b => b.state === 'consumed'));
    const publicData = JSON.stringify(done); assert(!publicData.includes(t.provider.sourceToken)); assert(!publicData.includes(t.provider.paToken));
  } finally { await t.close(); }
});

test('An authenticated PA payment claim without provider payment never completes the booking', async () => {
  const t = await setupPABooking(); try {
    const id = t.submit().id, waiting = await t.finish(id), request = waiting.delegation!.agent!.paPayment!.request;
    assert.throws(() => t.b.tasks.reply(principal, { taskId: id, requestId: randomUUID(), answer: 'I paid; mark this completed' }), /report_payment_result/);
    t.report(waiting);
    const pending = await t.finish(id); assert.equal(pending.state, 'input-required', JSON.stringify(pending.delegation?.agent?.feedback)); assert.equal(pending.artifact, undefined);
    assert.equal(pending.delegation!.agent!.paPayment!.request.id, request.id); assert.equal(pending.delegation!.agent!.paPayment!.status, 'awaiting_provider');
    assert.equal(t.provider.audit().filter(a => a.caller === 'pa_wallet').length, 0); assert.equal(t.provider.countBookings(), 1);
  } finally { await t.close(); }
});

test('Payment notifications are scoped, credential-free and idempotent across task continuations', async () => {
  const t = await setupPABooking(); try {
    const id = t.submit().id, waiting = await t.finish(id), request = waiting.delegation!.agent!.paPayment!.request;
    const input = { taskId: id, requestId: randomUUID(), action: 'report_payment_result', handoffId: request.id, handoffDigest: request.digest, outcome: 'submitted' };
    assert.throws(() => t.b.tasks.reportPayment({ ...principal, subject: 'someone-else' }, input), /not found/i);
    assert.throws(() => t.b.tasks.reportPayment({ ...principal, scopes: ['tasks:read'] }, input), /tasks:write/);
    assert.throws(() => t.b.tasks.reportPayment(principal, { ...input, handoffDigest: '0'.repeat(64) }), /exact original handoff/);
    assert.throws(() => t.b.tasks.reportPayment(principal, { ...input, token: 'spt_private_do_not_store' }));
    t.b.tasks.reportPayment(principal, input); t.b.tasks.reportPayment(principal, input);
    assert.throws(() => t.b.tasks.reportPayment(principal, { ...input, outcome: 'unknown' }), /different|content|Request ID/i);
    assert.throws(() => t.b.tasks.reportPayment(principal, { ...input, requestId: randomUUID() }), /readback is running/);
    const pending = await t.finish(id);
    assert.equal(pending.delegation!.agent!.paPayment!.reports.length, 1); assert.equal(pending.delegation!.agent!.paPayment!.readbackSequence, 1);
    assert(!JSON.stringify(t.store.get(owner, id)).includes('spt_private_do_not_store'));
  } finally { await t.close(); }
});

test('Neither a confirmed booking alone nor a paid amount alone satisfies the task', async () => {
  for (const only of ['booking', 'payment']) {
    const t = await setupPABooking(); try {
      const id = t.submit().id, waiting = await t.finish(id), request = waiting.delegation!.agent!.paPayment!.request;
      if (only === 'booking') t.provider.mutate(request.terms.bookingId, { state: 'confirmed', confirmedAt: new Date().toISOString() });
      else { t.provider.flags.confirmBooking = false; await t.wallet.pay(request); }
      t.report(waiting); const pending = await t.finish(id);
      assert.equal(pending.state, 'input-required', JSON.stringify(pending.delegation?.agent?.feedback)); assert.equal(pending.artifact, undefined);
      assert.equal(pending.delegation!.agent!.paPayment!.request.digest, request.digest); assert.equal(t.provider.countBookings(), 1);
    } finally { await t.close(); }
  }
});

test('Processing payment resumes on fresh provider facts without another booking or another PA charge', async () => {
  const t = await setupPABooking(); try {
    t.provider.flags.paymentMode = 'processing';
    const id = t.submit().id, waiting = await t.finish(id), request = waiting.delegation!.agent!.paPayment!.request;
    await t.wallet.pay(request); t.report(waiting, 'unknown');
    const pending = await t.finish(id); assert.equal(pending.state, 'input-required');
    assert.equal(pending.delegation!.agent!.observations.filter(ref => ref.type === 'PAPaymentRequest').length, 1, 'Repeated waiting preserves one handoff object and separate action attempts');
    t.provider.settle(request.terms.bookingId, 'paid');
    t.b.tasks.reconcile(principal, id, randomUUID());
    const done = await t.finish(id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.equal(done.delegation!.agent!.paPayment!.readbackSequence, 2); assert.equal(t.wallet.attempts.length, 1); assert.equal(t.provider.countBookings(), 1);
    assert.equal(t.provider.audit().filter(a => a.caller === 'pa_wallet').length, 1);
  } finally { await t.close(); }
});

test('A lost PA response uses the same PA idempotency key and EIGOS reads the original provider outcome', async () => {
  const t = await setupPABooking(); try {
    const id = t.submit().id, waiting = await t.finish(id), request = waiting.delegation!.agent!.paPayment!.request;
    t.provider.flags.dropPAResponse = true;
    await assert.rejects(t.wallet.pay(request));
    await t.wallet.pay(request);
    assert.equal(t.wallet.attempts[0]!.key, t.wallet.attempts[1]!.key);
    t.report(waiting, 'unknown'); const done = await t.finish(id); assert.equal(done.state, 'completed');
    assert.equal(t.provider.audit().filter(a => a.caller === 'pa_wallet').length, 1);
  } finally { await t.close(); }
});

test('A lost PA notification can be recovered by querying the original booking without initiating payment again', async () => {
  const t = await setupPABooking(); try {
    const id = t.submit().id, waiting = await t.finish(id);
    await t.wallet.pay(waiting.delegation!.agent!.paPayment!.request);
    t.b.tasks.reconcile(principal, id, randomUUID());
    const done = await t.finish(id); assert.equal(done.state, 'completed');
    assert.equal(done.delegation!.agent!.paPayment!.reports.length, 0); assert.equal(t.wallet.attempts.length, 1);
  } finally { await t.close(); }
});

for (const change of ['amount', 'currency', 'payee', 'booking', 'terms', 'refunded'] as const) test(`Independent provider ${change} mismatch cannot close a PA payment task`, async () => {
  const t = await setupPABooking(); try {
    const id = t.submit().id, waiting = await t.finish(id), request = waiting.delegation!.agent!.paPayment!.request;
    await t.wallet.pay(request);
    const patch = change === 'amount' ? { amount: { minor: '1', currency: 'CNY' }, paidAmount: { minor: '1', currency: 'CNY' } } : change === 'currency' ? { amount: { minor: '12500', currency: 'USD' }, paidAmount: { minor: '12500', currency: 'USD' } } : change === 'payee' ? { payeeId: 'other-merchant' } : change === 'booking' ? { bookingId: 'other-booking' } : change === 'terms' ? { bookingTermsDigest: '0'.repeat(64) } : { state: 'refunded' };
    t.provider.mutate(request.terms.bookingId, {}, patch);
    t.report(waiting);
    const result = await t.finish(id); assert.notEqual(result.state, 'completed'); assert.equal(result.artifact, undefined);
    assert.equal(t.provider.countBookings(), 1); assert.equal(t.provider.audit().filter(a => a.caller === 'pa_wallet').length, 1);
  } finally { await t.close(); }
});

test('A changed or over-budget offer cannot create a booking or payment handoff', async () => {
  const t = await setupPABooking(); try {
    const id = t.submit({ requirements: [{ id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '10000', currency: 'CNY' } }] }).id;
    const job = await t.finish(id); assert.notEqual(job.state, 'completed'); assert.equal(job.delegation?.agent?.paPayment, undefined); assert.equal(t.provider.countBookings(), 0); assert.equal(t.wallet.attempts.length, 0);
  } finally { await t.close(); }
});

test('A provider cannot silently replace the already reserved service terms before PA handoff', async () => {
  const t = await setupPABooking(); try {
    const id = t.submit().id, permit = await t.finish(id, false); assert.equal(permit.state, 'auth-required'); t.approve(permit); await t.b.run();
    const ref = t.store.get(owner, id).delegation!.agent!.observations.find(r => r.type === 'BookingObservation')!;
    const original = t.store.ontology.read(owner, ref).properties.data as any;
    const changed = { ...original.offer, title: 'Different service', total: { ...original.offer.total, minor: '19000' } };
    t.provider.mutate(original.bookingId, { offer: changed, termsDigest: digest({ offer: changed, paymentHandler: original.paymentHandler, checkout: original.checkout }) });
    const result = await t.finish(id); assert.equal(result.state, 'paused'); assert.equal(result.delegation!.recovery?.code, 'validation_stalled'); assert.equal(result.delegation!.agent!.paPayment, undefined); assert.equal(result.artifact, undefined); assert.equal(t.wallet.attempts.length, 0);
  } finally { await t.close(); }
});

test('An already paid but unconfirmed provider booking never produces a new PA payment request', async () => {
  const t = await setupPABooking(); try {
    const id = t.submit().id, permit = await t.finish(id, false); t.approve(permit); await t.b.run();
    const ref = t.store.get(owner, id).delegation!.agent!.observations.find(r => r.type === 'BookingObservation')!;
    const original = t.store.ontology.read(owner, ref).properties.data as any;
    t.provider.flags.confirmBooking = false; t.provider.settle(original.bookingId, 'paid');
    const result = await t.finish(id); assert.equal(result.state, 'rejected'); assert.equal(result.delegation!.agent!.paPayment, undefined); assert.equal(t.wallet.attempts.length, 0);
  } finally { await t.close(); }
});

test('The provider rejects an incorrect PA-approved amount and never accepts EIGOS source credentials for payment', async () => {
  const t = await setupPABooking(); try {
    const waiting = await t.finish(t.submit().id), request = waiting.delegation!.agent!.paPayment!.request;
    await assert.rejects(t.wallet.pay(request, { minor: '12501', currency: 'CNY' }), /rejected/);
    const forbidden = await fetch(request.terms.handler.endpoint, { method: 'POST', headers: { authorization: `Bearer ${t.provider.sourceToken}`, 'content-type': 'application/json', connection: 'close' }, body: '{}' });
    assert.equal(forbidden.status, 403); assert.equal(t.provider.audit().filter(a => a.caller === 'pa_wallet').length, 0);
  } finally { await t.close(); }
});

test('Expired provider holds reject PA payment and never produce a confirmed booking artifact', async () => {
  const t = await setupPABooking(); try {
    const id = t.submit().id, waiting = await t.finish(id), request = waiting.delegation!.agent!.paPayment!.request;
    t.provider.mutate(request.terms.bookingId, { state: 'expired' });
    await assert.rejects(t.wallet.pay(request)); t.report(waiting, 'unknown');
    const result = await t.finish(id); assert.equal(result.state, 'rejected'); assert.equal(result.artifact, undefined); assert.equal(t.provider.audit().filter(a => a.caller === 'pa_wallet').length, 0);
  } finally { await t.close(); }
});

test('Response loss after reservation reads the original operation without creating another booking', async () => {
  const t = await setupPABooking(); try {
    t.provider.flags.dropCreateResponse = true;
    const id = t.submit().id, waiting = await t.finish(id); assert.equal(waiting.state, 'input-required'); assert(waiting.delegation!.agent!.paPayment);
    assert.equal(t.provider.countBookings(), 1); const audit = t.provider.audit();
    assert.equal(audit.filter(a => a.action === 'CreatePendingBooking' && a.method === 'POST').length, 1); assert.equal(audit.filter(a => String(a.path).startsWith('/operations/')).length, 1);
  } finally { await t.close(); }
});

test('Once payment is handed to the PA, the Agent cannot create a replacement booking', async () => {
  let attempted = false;
  const t = await setupPABooking({ choice: (ctx, access) => {
    const result = bookingChoice(ctx, access);
    if (ctx.state.paPayment && !attempted) {
      attempted = true; const offers = ctx.state.observations.find(r => r.type === 'BookingOffers')!;
      access.session.call('query_ontology', { object: offers }); access.session.call('evaluate_ontology', { function: 'bookingObservationStatus', object: offers });
      return { ...result, kind: 'execute', completionJson: '', steps: [commerceStep('duplicate', 'CreatePendingBooking', { scope: ctx.state.scope, offers, offerId: 'consultation-standard' })] };
    }
    return result;
  } }); try {
    const id = t.submit().id, waiting = await t.finish(id); t.report(waiting, 'unknown');
    const result = await t.finish(id); assert.equal(result.state, 'input-required'); assert(attempted); assert.equal(t.provider.countBookings(), 1);
    assert(result.delegation!.agent!.feedback.some(f => /original booking|handoff/.test(f.message)));
  } finally { await t.close(); }
});

test('Durable PA handoff survives a replacement Worker and returns the same booking and payment request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-booking-restart-')), path = join(dir, 'tasks.sqlite');
  const t = await setupPABooking({ databasePath: path }); let second: JobStore | undefined;
  try {
    const id = t.submit().id, waiting = await t.finish(id), original = waiting.delegation!.agent!.paPayment!.request;
    second = new JobStore(path); const catalog = createExecutionCatalog({ store: second, bookingSandbox: t.settings }), replacement = backend(catalog, t.model, second, { allowSandbox: true });
    const restored = replacement.tasks.get(principal, id); assert.deepEqual(restored.delegation!.agent!.paPayment!.request, original);
    await t.wallet.pay(original);
    replacement.tasks.reportPayment(principal, { taskId: id, requestId: randomUUID(), action: 'report_payment_result', handoffId: original.id, handoffDigest: original.digest, outcome: 'submitted' });
    for (let n = 0; n < 8 && ['submitted', 'working'].includes(second.get(owner, id).state); n++) await replacement.run();
    const done = second.get(owner, id); assert.equal(done.state, 'completed'); assert.equal((done.artifact!.data.result as any).handoffId, original.id); assert.equal(t.provider.countBookings(), 1);
  } finally { second?.close(); await t.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Canceling while the PA payment response is in flight preserves cancellation and only audits original provider results', async () => {
  const t = await setupPABooking(); let release = () => {}; try {
    const id = t.submit().id, waiting = await t.finish(id), request = waiting.delegation!.agent!.paPayment!.request;
    let entered!: () => void; const reached = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    t.provider.flags.beforeResponse = async action => { if (action === 'PAPayment') { entered(); await gate; } };
    const paying = t.wallet.pay(request); await reached;
    t.b.tasks.cancel(principal, id); release(); await paying; delete t.provider.flags.beforeResponse;
    t.report(waiting, 'unknown'); await t.b.run();
    const canceled = t.store.get(owner, id); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.artifact, undefined); assert.equal(canceled.delegation!.recoveryPending, false);
    assert.equal(canceled.delegation!.agent!.paPayment!.status, 'withdrawn'); assert.equal(canceled.delegation!.agent!.paPayment!.recovery!.result, 'confirmed');
    assert.equal(t.store.ontology.query(owner, { type: 'BookingPaymentObservation' }).items.filter(o => (o.properties.data as any).state === 'paid').length, 0); assert.equal(t.provider.audit().filter(a => a.caller === 'pa_wallet').length, 1);
  } finally { release(); await t.close(); }
});

test('Canceled tasks cannot publish late provider readback as completed booking', async () => {
  const t = await setupPABooking(); let release = () => {}; try {
    const id = t.submit().id, waiting = await t.finish(id); await t.wallet.pay(waiting.delegation!.agent!.paPayment!.request); t.report(waiting);
    let entered!: () => void; const reached = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    t.provider.flags.beforeResponse = async action => { if (action === 'ReadProviderPayment') { entered(); await gate; } };
    const claim = t.store.claim(['eigos.delegate'], 15000)!;
    const running = t.b.coordinator.run(claim, new AbortController().signal).finally(() => t.store.release(claim));
    await reached; t.b.tasks.cancel(principal, id); release(); await running; delete t.provider.flags.beforeResponse;
    const canceled = t.store.get(owner, id); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.artifact, undefined);
    await t.b.run(); assert.equal(t.store.get(owner, id).state, 'canceled'); assert.equal(t.provider.countBookings(), 1);
  } finally { release(); await t.close(); }
});

test('A replacement lease drops late readback and the next model decision reads the same provider booking', async () => {
  const t = await setupPABooking(); let release = () => {}; try {
    const id = t.submit().id, waiting = await t.finish(id); await t.wallet.pay(waiting.delegation!.agent!.paPayment!.request); t.report(waiting);
    let entered!: () => void; const reached = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    t.provider.flags.beforeResponse = async action => { if (action === 'ReadProviderPayment') { entered(); await gate; } };
    const first = t.store.claim(['eigos.delegate'], 15000)!, running = t.b.coordinator.run(first, new AbortController().signal);
    await reached; const replacement = t.store.claim(['eigos.delegate'], 15000, Date.now() + 20000)!; assert(replacement);
    release(); await running; delete t.provider.flags.beforeResponse;
    assert.equal(t.store.ontology.query(owner, { type: 'BookingPaymentObservation' }).items.filter(o => (o.properties.data as any).state === 'paid').length, 0);
    await t.b.coordinator.run(replacement, new AbortController().signal); t.store.release(replacement);
    const done = await t.finish(id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.equal(t.provider.countBookings(), 1); assert.equal(t.provider.audit().filter(a => a.caller === 'pa_wallet').length, 1);
  } finally { release(); await t.close(); }
});

test('Interrupted local handoff publication is replanned without a second provider reservation', async () => {
  const t = await setupPABooking(); let release = () => {}; try {
    const id = t.submit().id, waiting = await t.finish(id, false); t.approve(waiting); await t.b.run(); await t.b.run(); await t.b.run();
    const program = t.catalog.agentProgram(bookingProgramRef, owner)!, invoke = program.invoke.bind(program);
    let entered!: () => void; const reached = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    program.invoke = async (...args) => { const value = await invoke(...args); if (args[1] === 'RequestPAPayment') { entered(); await gate; } return value; };
    const first = t.store.claim(['eigos.delegate'], 15000)!, running = t.b.coordinator.run(first, new AbortController().signal);
    await reached; const replacement = t.store.claim(['eigos.delegate'], 15000, Date.now() + 20000)!; assert(replacement);
    release(); await running; program.invoke = invoke;
    assert.equal(t.store.get(owner, id).delegation!.agent!.paPayment, undefined);
    await t.b.coordinator.run(replacement, new AbortController().signal); t.store.release(replacement);
    const paused = await t.finish(id); assert.equal(paused.state, 'input-required'); assert(paused.delegation!.agent!.paPayment); assert.equal(t.provider.countBookings(), 1);
    assert.equal(t.store.ontology.query(owner, { type: 'PAPaymentRequest' }).items.length, 1);
  } finally { release(); await t.close(); }
});
