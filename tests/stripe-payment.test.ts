import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setupStripe, stripeFixture } from './fixtures/stripe.js';
import { owner, principal } from './backend-fixture.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { StripeTestClient } from '../packages/capabilities/stripe/client.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { commerceDecision, commerceReads } from './fixtures/commerce-agent.js';
import { stripeChoice } from './fixtures/stripe.js';

const ref = { id: 'commerce.journey.stripe-test', version: '1' };
export async function pendingStripeAction(t: Awaited<ReturnType<typeof setupStripe>>, id: string, action = 'PayStripePayment') {
  for (let n = 0; n < 5; n++) {
    const job = await t.finish(id, false);
    assert.equal(job.state, 'auth-required', JSON.stringify({ state: job.state, feedback: job.delegation?.agent?.feedback, diagnostics: t.diagnostics }));
    const plan = job.delegation!.agent!.plans.find(p => p.id === job.delegation!.agent!.pendingPlanId)!;
    if (plan.steps.some(s => s.action === action)) return job;
    t.approve(job);
  }
  throw new Error('Expected exact Stripe frontier');
}

test('Stripe test capability is inert, opt-in, sandbox-only and consistently configured for Gateway/Worker', async () => {
  const t = await setupStripe(); try {
    assert(!createExecutionCatalog().summaries(owner, 32, 'sandbox').some(c => c.ref.id === ref.id));
    assert(!t.catalog.summaries(owner, 32, 'live').some(c => c.ref.id === ref.id));
    assert(!t.catalog.summaries('unrelated-owner', 32, 'sandbox').some(c => c.ref.id === ref.id));
    const program = t.catalog.agentProgram(ref, owner)!;
    assert.throws(() => program.schema('SubmitCommerceOrder')); assert.throws(() => program.schema('ReadCommercePayment'));
    assert.equal(t.stripe.calls.length, 0);
    const env = { EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(40), EIGOS_ACTION_SANDBOX: 'true', EIGOS_COMMERCE_SANDBOX_URL: t.provider.endpoint, EIGOS_COMMERCE_SANDBOX_TOKEN_FILE: t.tokenFile, EIGOS_STRIPE_TEST_ENABLED: 'true', EIGOS_STRIPE_TEST_SECRET_KEY_FILE: t.stripe.options.secretKeyFile, EIGOS_STRIPE_TEST_ACCOUNT_ID: t.stripe.options.accountId, EIGOS_STRIPE_TEST_MERCHANT_ID: t.stripe.options.merchantId };
    assert.throws(() => readConfig(env), /not an EIGOS runtime capability/);
    assert.throws(() => readWorkerConfig(env), /not an EIGOS runtime capability/);
    for (const changed of [{ EIGOS_STRIPE_TEST_ENABLED: 'false' }, { EIGOS_STRIPE_TEST_SECRET_KEY_FILE: 'relative' }, { EIGOS_STRIPE_TEST_ACCOUNT_ID: undefined }, { EIGOS_COMMERCE_SANDBOX_URL: undefined }, { NODE_ENV: 'production' }, { EIGOS_ACTION_SANDBOX: 'false' }]) assert.throws(() => readWorkerConfig({ ...env, ...changed }));
  } finally { await t.close(); }
});

for (const scenario of ['live-key', 'public-key', 'public-file'] as const) test(`Stripe rejects ${scenario} before any network request`, async () => {
  const t = stripeFixture(); try {
    if (scenario === 'public-file') chmodSync(t.options.secretKeyFile, 0o644);
    else writeFileSync(t.options.secretKeyFile, scenario === 'live-key' ? 'sk_live_forbiddenCredential' : 'pk_test_unusableCredential');
    await assert.rejects(new StripeTestClient(t.options).verifyAccount(new AbortController().signal), /test secret|private/);
    assert.equal(t.calls.length, 0);
  } finally { t.close(); }
});

test('Agent obtains a separate exact payment permit and completes only after original Stripe capture readback', async () => {
  const t = await setupStripe(); try {
    const id = t.submit().id, waiting = await pendingStripeAction(t, id), a = waiting.delegation!.authorizationRequest!;
    assert.deepEqual(a.effects, ['payment']); assert.deepEqual(a.maxAmount, { minor: '27000', currency: 'CNY' }); assert.deepEqual(a.payeeIds, ['stripe-test:acct_fixture:cedar-ca']);
    assert.equal(t.provider.counts().SubmitCommerceUnpaidOrder, 1); assert.equal(t.provider.counts().SubmitCommerceOrder, undefined); assert.equal(t.provider.counts().ReadCommercePayment, undefined);
    assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 0);
    const orderGrant = t.store.grants(owner, id).find(g => g.allowedEffects.includes('order'))!; assert.equal(orderGrant.maxAmount.minor, '0'); assert(!orderGrant.allowedEffects.includes('payment'));
    for (const change of [{ payeeIds: ['stripe-test:acct_other:cedar-ca'] }, { maxAmount: { minor: '27001', currency: 'CNY' } }, { maxAmount: { minor: '27000', currency: 'USD' } }, { planDigest: 'a'.repeat(64) }]) assert.throws(() => t.b.tasks.authorize(principal, id, { requestId: randomUUID(), action: 'approve_plan', planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox', ...change }));
    t.approve(waiting);
    const done = await t.finish(id);
    assert.equal(done.state, 'completed', JSON.stringify({ feedback: done.delegation?.agent?.feedback, diagnostics: t.diagnostics, error: done.error }));
    const result = done.artifact!.data.result as any;
    assert.equal(result.payment.status, 'succeeded'); assert.equal(result.payment.independentRead, true); assert.equal(result.payment.charge.captured, true);
    assert.equal(result.payment.livemode, false); assert.equal(result.paymentEvidenceLevel, 'synthetic'); assert.equal(result.bankSettlementVerified, false);
    assert.equal(result.payment.tokenSource, 'stripe_test_helper'); assert.equal(result.order.paymentProvider, 'stripe_test');
    assert.equal(t.stripe.calls.filter(c => c.path === '/v1/payment_intents' && c.method === 'POST').length, 1); assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 1);
    const last = t.stripe.calls.at(-1)!; assert.equal(last.method, 'GET'); assert.equal(last.path, `/v1/payment_intents/${result.payment.paymentIntentId}`);
    const paymentIntent = t.store.intents(owner, id).find(i => i.effect === 'payment')!;
    assert.equal(t.store.budget(owner, id).filter(r => r.state === 'consumed').length, 1); assert.equal(paymentIntent.state, 'effect_confirmed');
    const serialized = JSON.stringify({ done, intents: t.store.intents(owner, id), receipts: t.store.ontology.query(owner, { type: 'SourceReceipt' }) });
    for (const secret of [t.stripe.key, '_secret_', ...t.stripe.tokens.keys()]) assert(!serialized.includes(secret), `Credential leaked: ${secret.slice(0, 8)}`);
    const payment = done.delegation!.agent!.observations.filter(r => r.type === 'StripePaymentObservation').at(-1)!;
    assert.equal((t.store.ontology.evaluate(owner, { function: 'stripePaymentStatus', object: payment }).value as any).status, 'test_paid');
    assert.throws(() => t.store.ontology.read('another-owner', payment));
  } finally { await t.close(); }
});

for (const loss of ['create', 'confirm'] as const) test(`Lost Stripe ${loss} response recovers by GET and never repeats the original write`, async () => {
  const t = await setupStripe(); try {
    const id = t.submit().id, waiting = await pendingStripeAction(t, id, loss === 'create' ? 'PrepareStripePayment' : 'PayStripePayment');
    if (loss === 'create') t.stripe.flags.dropCreate = true; else t.stripe.flags.dropConfirm = true;
    t.approve(waiting); await t.b.run();
    const intent = t.store.intents(owner, id).find(i => i.stepId === (loss === 'create' ? 'prepare_payment' : 'pay'))!;
    assert.equal(intent.state, 'effect_unknown');
    const done = await t.finish(id); assert.equal(done.state, 'completed', JSON.stringify({ feedback: done.delegation?.agent?.feedback, diagnostics: t.diagnostics }));
    assert.equal(t.stripe.intents.size, 1); assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 1);
    assert.equal(t.store.attempts(owner, intent.id).filter(a => a.kind === 'dispatch').length, 1); assert.equal(t.store.attempts(owner, intent.id).filter(a => a.kind === 'reconcile').length, 1);
    if (loss === 'create') assert(t.stripe.calls.some(c => c.path === '/v1/payment_intents/search'));
  } finally { await t.close(); }
});

test('An eventually consistent Stripe search miss leaves the original preparation unresolved', async () => {
  const t = await setupStripe(); try {
    const id = t.submit().id, waiting = await pendingStripeAction(t, id, 'PrepareStripePayment');
    t.stripe.flags.dropCreate = true; t.stripe.flags.hideSearch = true; t.approve(waiting);
    const held = await t.finish(id); assert.equal(held.state, 'input-required'); assert.equal(held.artifact, undefined);
    assert.equal(t.stripe.calls.filter(c => c.method === 'POST').length, 1); assert(t.stripe.calls.filter(c => c.path === '/v1/payment_intents/search').length <= 3); assert.equal(t.stripe.intents.size, 1);
    assert.equal(t.store.intents(owner, id).find(i => i.stepId === 'prepare_payment')!.state, 'needs_review');
  } finally { await t.close(); }
});

test('Confirmation HTTP 400 cannot release funds when the original PaymentIntent already succeeded', async () => {
  const t = await setupStripe(); try {
    const id = t.submit().id, waiting = await pendingStripeAction(t, id);
    t.stripe.flags.confirmErrorAfterSuccess = true; t.approve(waiting); await t.b.run();
    const intent = t.store.intents(owner, id).find(i => i.effect === 'payment')!;
    assert.equal(intent.state, 'effect_unknown'); assert.equal(t.store.budget(owner, id).find(r => r.intent_id === intent.id)!.state, 'held');
    const done = await t.finish(id); assert.equal(done.state, 'completed', JSON.stringify(t.diagnostics));
    assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 1); assert.equal(t.store.budget(owner, id).find(r => r.intent_id === intent.id)!.state, 'consumed');
  } finally { await t.close(); }
});

for (const status of ['requires_action', 'processing'] as const) test(`Stripe ${status} never becomes paid, releases no held budget, and does not confirm again`, async () => {
  const t = await setupStripe(); try {
    t.stripe.flags.outcome = status;
    const id = t.submit().id, held = await t.finish(id);
    assert.equal(held.state, 'input-required', JSON.stringify(t.diagnostics)); assert.equal(held.artifact, undefined);
    assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 1);
    const intent = t.store.intents(owner, id).find(i => i.effect === 'payment')!;
    assert.equal(intent.state, 'needs_review'); assert.equal(t.store.budget(owner, id).find(r => r.intent_id === intent.id)!.state, 'held');
    assert.equal(t.store.ontology.query(owner, { type: 'StripePaymentObservation' }).items.length, 1);
    assert(t.diagnostics.some(d => d.error.includes(status)));
  } finally { await t.close(); }
});

test('A Stripe decline releases the reservation and cannot manufacture a payment receipt', async () => {
  const t = await setupStripe(); try {
    t.stripe.flags.outcome = 'declined';
    const id = t.submit().id, done = await t.finish(id); assert.equal(done.state, 'rejected', JSON.stringify(done.delegation?.agent?.feedback)); assert.equal(done.artifact, undefined);
    const intent = t.store.intents(owner, id).find(i => i.effect === 'payment')!;
    assert.equal(intent.state, 'rejected'); assert.equal(t.store.budget(owner, id).find(r => r.intent_id === intent.id)!.state, 'released');
    assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 1);
    assert(!JSON.stringify(done).includes('spt_private_error')); assert(!JSON.stringify(t.diagnostics).includes('spt_private_error'));
  } finally { await t.close(); }
});

for (const changed of ['amount', 'currency', 'account', 'binding', 'identity', 'live', 'token_limit', 'transfer_payee'] as const) test(`Changed Stripe ${changed} prevents payment confirmation`, async () => {
  const t = await setupStripe(); try {
    const id = t.submit().id, waiting = await pendingStripeAction(t, id);
    const pi = [...t.stripe.intents.values()][0]!;
    if (changed === 'amount') pi.amount++;
    if (changed === 'currency') pi.currency = 'usd';
    if (changed === 'binding') pi.metadata.eigos_binding = 'changed';
    if (changed === 'transfer_payee') pi.transfer_data = { destination: 'acct_other' };
    if (changed === 'identity') pi.id = 'pi_other';
    if (changed === 'account') t.stripe.flags.wrongAccount = true;
    if (changed === 'live') t.stripe.flags.liveResponse = true;
    if (changed === 'token_limit') t.stripe.flags.badTokenLimit = true;
    t.approve(waiting); const held = await t.finish(id); assert.equal(held.state, 'input-required'); assert.equal(held.artifact, undefined);
    assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 0);
    const intent = t.store.intents(owner, id).find(i => i.effect === 'payment')!; assert.equal(t.store.budget(owner, id).find(r => r.intent_id === intent.id)!.state, 'held');
  } finally { await t.close(); }
});

for (const change of ['uncaptured', 'refunded', 'disputed'] as const) test(`Independent ${change} charge readback prevents payment completion`, async () => {
  const t = await setupStripe(); try {
    const id = t.submit().id, waiting = await pendingStripeAction(t, id); t.approve(waiting); await t.b.run();
    const pi = [...t.stripe.intents.values()][0]!;
    assert.equal(pi.status, 'succeeded');
    if (change === 'uncaptured') pi.latest_charge.captured = false;
    if (change === 'refunded') { pi.latest_charge.refunded = true; pi.latest_charge.amount_refunded = pi.amount; }
    if (change === 'disputed') pi.latest_charge.disputed = true;
    const done = await t.finish(id); assert.equal(done.state, 'rejected'); assert.equal(done.artifact, undefined);
    assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 1);
    const latest = done.delegation!.agent!.observations.filter(r => r.type === 'StripePaymentObservation').at(-1)!;
    assert.notEqual((t.store.ontology.evaluate(owner, { function: 'stripePaymentStatus', object: latest }).value as any).status, 'test_paid');
  } finally { await t.close(); }
});

test('Stripe writes require actual current Ontology evaluation and cannot use a different task order', async () => {
  const t = await setupStripe(); try {
    const id = t.submit().id, waiting = await pendingStripeAction(t, id), program = t.catalog.agentProgram(ref, owner)!;
    const state = waiting.delegation!.agent!, ctx = { graph: t.store.ontology, owner, request: waiting.delegation!.request, state };
    const plan = state.plans.find(p => p.id === state.pendingPlanId)!, step = plan.steps[0]!;
    assert.throws(() => program.validatePlanning!(ctx, step.action, step.input, { ...plan.ontologyPlanning, reads: [] }), /must evaluate/);
    assert.throws(() => program.validate({ ...ctx, request: { ...ctx.request, id: 'other-task' } }, step.action, step.input), /unpaid order/);
    t.b.tasks.revokeAuthorization(principal, id, randomUUID());
    assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 0);
  } finally { await t.close(); }
});

for (const end of ['cancel', 'revoke', 'lease'] as const) test(`A ${end} between token preparation and confirmation stops the charge`, async () => {
  const t = await setupStripe(); let release = () => {}; try {
    const id = t.submit().id, waiting = await pendingStripeAction(t, id); t.approve(waiting);
    let entered!: () => void; const reached = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    t.stripe.flags.beforeReturn = async path => { if (path.startsWith('/v1/shared_payment/granted_tokens/')) { entered(); await gate; } };
    const claim = t.store.claim(['eigos.delegate'], 15000)!;
    const running = t.b.coordinator.run(claim, new AbortController().signal).finally(() => t.store.release(claim));
    await reached;
    if (end === 'cancel') t.b.tasks.cancel(principal, id);
    else if (end === 'revoke') t.b.tasks.revokeAuthorization(principal, id, randomUUID());
    else { const replacement = t.store.claim(['eigos.delegate'], 15000, Date.now() + 20000)!; assert(replacement); t.store.release(replacement); }
    release(); await running; delete t.stripe.flags.beforeReturn;
    assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 0); assert.equal(t.store.get(owner, id).artifact, undefined);
    assert.equal(t.store.ontology.query(owner, { type: 'StripePaymentObservation' }).items.length, 1);
  } finally { release(); await t.close(); }
});

test('A late successful payment after cancellation is recovered without completing or projecting a paid task', async () => {
  const t = await setupStripe(); let release = () => {}; try {
    const id = t.submit().id, waiting = await pendingStripeAction(t, id); t.approve(waiting);
    let entered!: () => void; const reached = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    t.stripe.flags.beforeReturn = async path => { if (path.endsWith('/confirm')) { entered(); await gate; } };
    const claim = t.store.claim(['eigos.delegate'], 15000)!, running = t.b.coordinator.run(claim, new AbortController().signal).finally(() => t.store.release(claim));
    await reached; t.b.tasks.cancel(principal, id); release(); await running; delete t.stripe.flags.beforeReturn;
    await t.b.run();
    const canceled = t.store.get(owner, id); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.artifact, undefined);
    assert.equal(canceled.delegation!.recoveryPending, false); assert.equal(t.store.intents(owner, id).find(i => i.effect === 'payment')!.state, 'effect_confirmed');
    assert.equal(t.store.ontology.query(owner, { type: 'StripePaymentObservation' }).items.length, 1); assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 1);
  } finally { release(); await t.close(); }
});

test('Successful confirmation alone cannot close the task without independent Stripe readback', async () => {
  let premature = false;
  const t = await setupStripe({ choice: (ctx, access) => {
    const decision = stripeChoice(ctx, access);
    if (!premature && decision.steps.some(s => s.action === 'ReadStripePayment')) {
      premature = true; const { last } = commerceReads(ctx, access), order = last('CommerceOrderObservation', true)!;
      return commerceDecision(ctx, [], { selected: order.ref, order: order.ref, payment: ctx.state.observations.filter(r => r.type === 'StripePaymentObservation').at(-1), rationale: 'Attempt premature confirmation-only completion' });
    }
    return decision;
  } }); try {
    const done = await t.finish(t.submit().id); assert.equal(done.state, 'completed'); assert(premature);
    assert(done.delegation!.agent!.feedback.some(f => f.message.includes('independently read')));
    assert.equal((done.artifact!.data.result as any).payment.independentRead, true);
  } finally { await t.close(); }
});
