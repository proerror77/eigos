import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { setupPABooking } from './fixtures/pa-booking.js';
import { owner, principal } from './backend-fixture.js';
import type { LinkWalletAvailability, PAPaymentRequest } from '../packages/core/pa-payment.js';
import { digest } from '../packages/core/delegation.js';
import { TaskService } from '../packages/core/tasks.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';

const ready = (): LinkWalletAvailability => ({ status: 'available', reason: 'ready', observedAt: new Date().toISOString() });
const unavailable = (reason: Extract<LinkWalletAvailability, { status: 'unavailable' }>['reason'] = 'region_unsupported'): LinkWalletAvailability => ({ status: 'unavailable', reason, observedAt: new Date().toISOString() });
async function checkoutForm(request: PAPaymentRequest) {
  const response = await fetch(request.terms.checkout.url, { redirect: 'error' });
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /不会真实扣款/);
  assert.match(page, new RegExp(request.terms.bookingId));
  const fields = Object.fromEntries([...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(m => [m[1]!, m[2]!]));
  return { page, fields };
}
async function confirmCheckout(request: PAPaymentRequest, fields: Record<string, string>, origin = new URL(request.terms.checkout.url).origin) {
  return fetch(request.terms.checkout.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: new URLSearchParams(fields), redirect: 'manual' });
}

test('A ready Link Agent Wallet is preferred; both source routes retain the same immutable booking and amount', async () => {
  const t = await setupPABooking();
  try {
    const waiting = await t.finish(t.submit().id), original = waiting.delegation!.agent!.paPayment!.request;
    assert.equal(original.terms.checkout.bookingId, original.terms.bookingId);
    assert.equal(original.terms.routePolicy, 'prefer_link_agent_wallet');
    const selected = t.selectRoute(waiting, ready()), payment = selected.delegation!.agent!.paPayment!;
    assert.equal(payment.selection!.route, 'link_agent_wallet');
    assert.equal(payment.selection!.reason, 'wallet_ready');
    assert.deepEqual(payment.request, original);
    assert.equal(t.provider.audit().filter(a => a.caller !== 'eigos_source').length, 0);
    await t.wallet.pay(original, original.terms.amount, payment.selection!.operationId);
    t.report(selected);
    const done = await t.finish(waiting.id);
    assert.equal(done.state, 'completed');
    assert.equal((done.artifact!.data.result as any).paymentRoute, 'link_agent_wallet');
    assert.equal(t.provider.countBookings(), 1);
  } finally { await t.close(); }
});

for (const reason of ['region_unsupported', 'not_connected', 'connector_missing', 'wallet_unavailable'] as const) test(`Link wallet ${reason} falls back to the provider checkout; only independent payment and booking close the task`, async () => {
  const t = await setupPABooking();
  try {
    const waiting = await t.finish(t.submit().id), original = waiting.delegation!.agent!.paPayment!.request;
    const selected = t.selectRoute(waiting, unavailable(reason)), payment = selected.delegation!.agent!.paPayment!;
    assert.equal(payment.selection!.route, 'link_checkout');
    assert.equal(payment.selection!.reason, reason);
    assert.equal(payment.status, 'awaiting_user');
    assert.match(selected.question!, /请用户/);
    assert(selected.question!.includes(original.terms.checkout.url));
    assert.deepEqual(payment.request, original);
    const { fields } = await checkoutForm(original);
    assert.equal(t.provider.audit().filter(a => a.caller === 'checkout_user').length, 0);
    const response = await confirmCheckout(original, fields);
    assert.equal(response.status, 303);
    assert.equal(t.b.tasks.get(principal, waiting.id).state, 'input-required');
    t.report(selected);
    const done = await t.finish(waiting.id);
    assert.equal(done.state, 'completed');
    assert.equal((done.artifact!.data.result as any).paymentRoute, 'link_checkout');
    assert.equal((done.artifact!.data.result as any).realPayment, false);
    assert.equal(t.wallet.attempts.length, 0);
    assert.equal(t.provider.audit().filter(a => a.caller === 'checkout_user').length, 1);
    assert.equal(t.provider.countBookings(), 1);
  } finally { await t.close(); }
});

test('Provider wallet incompatibility uses ordinary Link, while an unavailable checkout never becomes a guessed URL', async () => {
  const t = await setupPABooking();
  try {
    t.provider.flags.walletUnavailable = true;
    const first = await t.finish(t.submit().id), chosen = t.selectRoute(first, ready());
    assert.equal(chosen.delegation!.agent!.paPayment!.selection!.reason, 'merchant_wallet_unavailable');
    t.provider.flags.checkoutUnavailable = true;
    const second = await t.finish(t.submit().id);
    assert.throws(() => t.selectRoute(second, unavailable()), /no usable Link payment route/);
    assert.equal(t.b.tasks.get(principal, second.id).delegation!.agent!.paPayment!.selection, undefined);
    assert.equal(t.provider.audit().filter(a => a.caller !== 'eigos_source').length, 0);
  } finally { await t.close(); }
});

test('Unknown or stale wallet availability cannot start a fallback payment', async () => {
  const t = await setupPABooking();
  try {
    const waiting = await t.finish(t.submit().id);
    assert.throws(() => t.selectRoute(waiting, { status: 'unknown', reason: 'unknown', observedAt: new Date().toISOString() }), /Unknown wallet/);
    assert.throws(() => t.selectRoute(waiting, { ...unavailable(), observedAt: new Date(Date.now() - 300001).toISOString() }), /current PA wallet/);
    assert.throws(() => t.selectRoute(waiting, { ...ready(), observedAt: new Date(Date.now() + 60000).toISOString() }), /current PA wallet/);
    assert.equal(t.b.tasks.get(principal, waiting.id).delegation!.agent!.paPayment!.selection, undefined);
    assert.equal(t.provider.countBookings(), 1);
  } finally { await t.close(); }
});

test('Provider-declared wallet incompatibility does not require connecting an unavailable PA wallet', async () => {
  const t = await setupPABooking();
  try {
    t.provider.flags.walletUnavailable = true;
    const waiting = await t.finish(t.submit().id);
    const selected = t.selectRoute(waiting, { status: 'unknown', reason: 'unknown', observedAt: new Date().toISOString() });
    assert.equal(selected.delegation!.agent!.paPayment!.selection!.route, 'link_checkout');
    assert.equal(selected.delegation!.agent!.paPayment!.selection!.reason, 'merchant_wallet_unavailable');
  } finally { await t.close(); }
});

test('A recomputed local handoff cannot replace the provider checkout URL or payee', async () => {
  const t = await setupPABooking();
  try {
    const waiting = await t.finish(t.submit().id), original = waiting.delegation!.agent!.paPayment!.request;
    for (const checkout of [{ ...original.terms.checkout, url: 'https://untrusted.example/pay' }, { ...original.terms.checkout, payeeId: 'another-payee' }, { ...original.terms.checkout, bookingId: 'another-booking' }]) {
      const changed = t.store.get(owner, waiting.id), payment = changed.delegation!.agent!.paPayment!;
      const { digest: _old, ...body } = payment.request;
      body.terms = { ...original.terms, checkout };
      payment.request = { ...body, digest: digest(body) };
      t.store.save(owner, changed);
      assert.throws(() => t.selectRoute(changed, unavailable()), /original independently read provider terms/);
      assert.equal(t.b.tasks.get(principal, waiting.id).delegation!.agent!.paPayment!.selection, undefined);
    }
  } finally { await t.close(); }
});

test('A disabled or changed provider configuration cannot issue an old checkout handoff', async () => {
  const t = await setupPABooking();
  try {
    const waiting = await t.finish(t.submit().id), request = waiting.delegation!.agent!.paPayment!.request;
    const input = { action: 'select_payment_route', taskId: waiting.id, requestId: randomUUID(), handoffId: request.id, handoffDigest: request.digest, wallet: unavailable() };
    for (const options of [
      { catalog: t.catalog, allowSandboxActions: false },
      { catalog: createExecutionCatalog(), allowSandboxActions: true },
      { catalog: createExecutionCatalog({ store: t.store, bookingSandbox: { ...t.settings, tokenFile: t.settings.tokenFile + '-different' } }), allowSandboxActions: true },
    ]) assert.throws(() => new TaskService(t.store, options).selectPaymentRoute(principal, input), /no longer enabled/);
    assert.equal(t.b.tasks.get(principal, waiting.id).delegation!.agent!.paPayment!.selection, undefined);
  } finally { await t.close(); }
});

test('An expired user completion deadline blocks payment selection even while the provider hold remains valid', async () => {
  const t = await setupPABooking();
  try {
    const deadline = new Date(Date.now() + 5000).toISOString();
    const waiting = await t.finish(t.submit({ requirements: [{ id: 'finish', kind: 'deadline', role: 'completion', strength: 'hard', expected: { at: deadline, timezone: 'UTC', original: deadline } }] }).id);
    assert.equal(waiting.state, 'input-required');
    assert(Date.parse(waiting.delegation!.agent!.paPayment!.request.terms.expiresAt) > Date.parse(deadline));
    await pause(Math.max(1, Date.parse(deadline) - Date.now() + 20));
    assert.throws(() => t.selectRoute(waiting, unavailable()), /completion deadline expired/);
    assert.equal(t.provider.audit().filter(a => a.caller !== 'eigos_source').length, 0);
  } finally { await t.close(); }
});

test('Route selection is owned, credential-free, idempotent and cannot be switched after issuance', async () => {
  const t = await setupPABooking();
  try {
    const waiting = await t.finish(t.submit().id), request = waiting.delegation!.agent!.paPayment!.request;
    const input = { action: 'select_payment_route', taskId: waiting.id, requestId: randomUUID(), handoffId: request.id, handoffDigest: request.digest, wallet: ready() };
    assert.throws(() => t.b.tasks.selectPaymentRoute({ ...principal, subject: 'other' }, input), /not found/i);
    assert.throws(() => t.b.tasks.selectPaymentRoute({ ...principal, scopes: ['tasks:read'] }, input), /tasks:write/);
    assert.throws(() => t.b.tasks.selectPaymentRoute(principal, { ...input, handoffDigest: '0'.repeat(64) }), /exact original/);
    assert.throws(() => t.b.tasks.selectPaymentRoute(principal, { ...input, walletToken: 'private' }));
    const selected = t.b.tasks.selectPaymentRoute(principal, input);
    assert.deepEqual(t.b.tasks.selectPaymentRoute(principal, input).delegation!.agent!.paPayment!.selection, selected.delegation!.agent!.paPayment!.selection);
    assert.throws(() => t.b.tasks.selectPaymentRoute(principal, { ...input, wallet: unavailable() }), /different|content|Request ID/i);
    assert.throws(() => t.selectRoute(selected, unavailable()), /already exists/);
    assert.equal(t.b.tasks.get(principal, waiting.id).delegation!.agent!.paPayment!.selection!.route, 'link_agent_wallet');
    assert.equal(t.provider.audit().filter(a => a.caller !== 'eigos_source').length, 0);
  } finally { await t.close(); }
});

test('A checkout return URL and a PA submitted notification are not proof of payment', async () => {
  const t = await setupPABooking();
  try {
    const waiting = await t.finish(t.submit().id), selected = t.selectRoute(waiting, unavailable()), request = selected.delegation!.agent!.paPayment!.request;
    const response = await fetch(request.terms.checkout.url + '?payment_status=paid&success=true');
    assert.equal(response.status, 200);
    t.report(selected);
    const pending = await t.finish(waiting.id);
    assert.equal(pending.state, 'input-required'); assert.equal(pending.artifact, undefined);
    assert.equal(pending.delegation!.agent!.paPayment!.status, 'awaiting_provider');
    assert.equal(pending.delegation!.agent!.paPayment!.selection!.route, 'link_checkout');
    assert.equal(t.provider.audit().filter(a => a.caller === 'checkout_user').length, 0);
  } finally { await t.close(); }
});

test('A lost wallet response and a declined attempt never trigger checkout fallback', async () => {
  const t = await setupPABooking();
  try {
    const waiting = await t.finish(t.submit().id), selected = t.selectRoute(waiting, ready()), request = selected.delegation!.agent!.paPayment!.request;
    t.provider.flags.dropPAResponse = true;
    await assert.rejects(t.wallet.pay(request));
    assert.throws(() => t.selectRoute(selected, unavailable()), /already exists|unpaid/);
    t.report(selected, 'unknown');
    assert.equal((await t.finish(waiting.id)).state, 'completed');
    assert.equal(t.provider.audit().filter(a => a.caller === 'pa_wallet').length, 1);
    assert.equal(t.provider.audit().filter(a => a.caller === 'checkout_user').length, 0);

    const other = await t.finish(t.submit().id), chosen = t.selectRoute(other, ready());
    t.report(chosen, 'declined');
    const declined = await t.finish(other.id);
    assert.equal(declined.state, 'input-required');
    assert.throws(() => t.selectRoute(declined, unavailable()), /already exists/);
  } finally { await t.close(); }
});

test('Checkout rejects changed amounts, bookings, CSRF nonces and origins before settling anything', async () => {
  const t = await setupPABooking();
  try {
    const waiting = await t.finish(t.submit().id), selected = t.selectRoute(waiting, unavailable()), request = selected.delegation!.agent!.paPayment!.request;
    const { fields } = await checkoutForm(request);
    const changes: Record<string, string>[] = [{ amountMinor: '1' }, { currency: 'USD' }, { bookingId: 'other' }, { csrfNonce: '0'.repeat(64) }, { termsDigest: '0'.repeat(64) }];
    for (const patch of changes) {
      assert.equal((await confirmCheckout(request, { ...fields, ...patch })).status, 403);
    }
    assert.equal((await confirmCheckout(request, fields, 'https://other.example')).status, 403);
    assert.equal(t.provider.audit().filter(a => a.caller === 'checkout_user').length, 0);
    t.report(selected, 'unknown');
    assert.equal((await t.finish(waiting.id)).state, 'input-required');
  } finally { await t.close(); }
});

test('Lost checkout response and duplicate form submission preserve one booking and one payment', async () => {
  const t = await setupPABooking();
  try {
    const waiting = await t.finish(t.submit().id), selected = t.selectRoute(waiting, unavailable()), request = selected.delegation!.agent!.paPayment!.request;
    const { fields } = await checkoutForm(request);
    t.provider.flags.dropCheckoutResponse = true;
    await assert.rejects(confirmCheckout(request, fields));
    assert.throws(() => t.selectRoute(selected, ready()), /already exists|unpaid/);
    assert.equal((await confirmCheckout(request, fields)).status, 303);
    assert.equal((await confirmCheckout(request, fields)).status, 303);
    t.report(selected, 'unknown');
    assert.equal((await t.finish(waiting.id)).state, 'completed');
    assert.equal(t.provider.audit().filter(a => a.caller === 'checkout_user').length, 1);
    assert.equal(t.provider.countBookings(), 1);
    await assert.rejects(t.wallet.pay(request), /rejected/);
  } finally { await t.close(); }
});

test('An expired checkout cannot be paid or replaced by a wallet route', async () => {
  const t = await setupPABooking({ holdMs: 3000 });
  try {
    const waiting = await t.finish(t.submit().id), selected = t.selectRoute(waiting, unavailable()), request = selected.delegation!.agent!.paPayment!.request;
    const { fields } = await checkoutForm(request);
    await pause(Math.max(1, Date.parse(request.terms.expiresAt) - Date.now() + 20));
    assert.equal((await confirmCheckout(request, fields)).status, 409);
    assert.throws(() => t.selectRoute(selected, ready()), /already exists|unpaid|expired/);
    assert.equal(t.provider.audit().filter(a => a.caller === 'checkout_user').length, 0);
  } finally { await t.close(); }
});

test('Canceling EIGOS while checkout is open preserves cancellation even after a late provider payment', async () => {
  const t = await setupPABooking();
  try {
    const waiting = await t.finish(t.submit().id), selected = t.selectRoute(waiting, unavailable()), request = selected.delegation!.agent!.paPayment!.request;
    const { fields } = await checkoutForm(request);
    t.b.tasks.cancel(principal, waiting.id);
    assert.throws(() => t.selectRoute(selected, ready()), /waiting task/);
    assert.equal((await confirmCheckout(request, fields)).status, 303);
    t.report(selected);
    const claimed = t.store.claim(['eigos.delegate'], 15000)!;
    assert(claimed);
    try { await t.b.coordinator.run(claimed, new AbortController().signal); } finally { t.store.release(claimed); }
    const canceled = t.store.get(owner, waiting.id);
    assert.equal(canceled.state, 'canceled'); assert.equal(canceled.artifact, undefined);
    assert.equal(canceled.delegation!.agent!.paPayment!.recovery!.result, 'confirmed');
  } finally { await t.close(); }
});
