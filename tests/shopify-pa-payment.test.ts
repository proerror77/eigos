import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupShopifyPayment } from './fixtures/shopify-pa-payment.js';
import { owner, principal } from './backend-fixture.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { readConfig } from '../packages/core/config.js';
import { paCheckoutPaymentRequestSchema } from '../packages/core/pa-payment.js';
import { SHOPIFY_PA_REF } from '../packages/capabilities/shopify/pa-checkout-contracts.js';
import { createCheckoutKernelDefinition, CHECKOUT_KERNEL_MODEL_REF, createCurrentKernelDefinition } from '../packages/ontology/seed-definition.js';
import { createShopifyPASandbox } from '../packages/capabilities/shopify/pa-checkout-sandbox.js';

test('Checkout payment is explicitly isolated and historical v18 retains its exact model', () => {
  assert(!createExecutionCatalog().summaries(owner).some(value => value.ref.id === SHOPIFY_PA_REF.id));
  assert.deepEqual(createCheckoutKernelDefinition().audit.model, CHECKOUT_KERNEL_MODEL_REF);
  assert.equal(createCurrentKernelDefinition().audit.model.version, '20');
  const base = { EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'isolated-checkout-fixture'.repeat(3), EIGOS_ACTION_SANDBOX: 'true', EIGOS_SHOPIFY_PAYMENT_SANDBOX_TOKEN_FILE: '/private/source-token' };
  for (const url of ['https://mcp.shop.com', 'https://127.0.0.1:3437', 'http://localhost:3437', 'http://127.0.0.1:3437/payment']) assert.throws(() => readConfig({ ...base, EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL: url }), /isolated loopback/);
  assert.throws(() => readConfig({ ...base, EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL: 'http://127.0.0.1:3437', NODE_ENV: 'production' }));
  assert.throws(() => readConfig(base), /endpoint and source token/);
});

for (const route of ['pa_vault', 'pa_payment_account'] as const) test(`Shopify checkout → PA own ${route} → independent exact payment and order confirmation`, async () => {
  const t = await setupShopifyPayment();
  try {
    const authorizing = await t.finish(t.submit().id, false);
    assert.equal(authorizing.state, 'auth-required'); const grant = authorizing.delegation!.authorizationRequest!;
    assert.deepEqual(grant.effects, ['reserve']); assert.equal(grant.maxAmount!.minor, '0');
    t.approve(authorizing); const waiting = await t.finish(authorizing.id), handoff = paCheckoutPaymentRequestSchema.parse(waiting.delegation!.agent!.paPayment!.request);
    assert.equal(waiting.state, 'input-required'); assert.equal(handoff.version, '3'); assert.equal(t.provider.countPayments(), 0);
    assert.equal(handoff.terms.resource.id, handoff.terms.checkout.id); assert.equal(handoff.terms.amount.minor, '100');
    const selected = t.select(waiting, route), selection = selected.delegation!.agent!.paPayment!.selection!;
    assert.equal(selection.route, route); assert.equal((await t.pa.pay(handoff, selection)).state, 'paid');
    assert.equal(t.b.tasks.get(principal, waiting.id).state, 'input-required', 'PA payment alone cannot finish EIGOS');
    const requestId = randomUUID(); t.report(selected, 'submitted', requestId); t.report(selected, 'submitted', requestId);
    const done = await t.finish(waiting.id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.equal(done.delegation!.agent!.paPayment!.status, 'verified'); assert.equal(done.delegation!.agent!.paPayment!.reports.length, 1);
    const result = done.artifact!.data.result as any;
    assert.equal(result.realPayment, false); assert.equal(result.evidenceLevel, 'synthetic'); assert.equal(result.paymentRoute, route);
    assert.equal(result.checkout.checkout.id, handoff.terms.resource.id); assert.equal(result.payment.checkoutId, handoff.terms.resource.id);
    assert.equal(result.checkout.orderConfirmation.id, result.payment.orderId); assert.equal(result.payment.operationId, selection.operationId);
    assert.equal(t.provider.countCheckouts(), 1); assert.equal(t.provider.countPayments(), 1);
    assert.equal(t.store.intents(owner, done.id).filter(intent => intent.effect === 'payment').length, 0, 'Payment is executed by the PA, never an EIGOS payment action');
    assert(t.store.grants(owner, done.id).every(grant => grant.maxAmount?.minor === '0'), 'Checkout preparation grants no EIGOS payment spend');
    assert(!JSON.stringify(done).includes(t.provider.paToken)); assert(!JSON.stringify(done).includes(t.provider.sourceToken)); assert(!JSON.stringify(done).includes('4242424242424242'));
    const audit = t.provider.audit(), payIndex = audit.findIndex(value => value.action === 'pay');
    for (const action of ['ReadShopifyPaymentCheckout', 'ReadShopifyCheckoutPayment']) assert(audit.slice(payIndex + 1).some(value => value.action === action));
    await assert.rejects(t.pa.pay(handoff, selection), /prior PA dispatch/);
  } finally { await t.close(); }
});

test('A forged PA success notification only triggers readback and cannot complete an unpaid order', async () => {
  const t = await setupShopifyPayment();
  try {
    const waiting = await t.finish(t.submit().id), selected = t.select(waiting); t.report(selected);
    const pending = await t.finish(waiting.id); assert.equal(pending.state, 'input-required'); assert.equal(pending.delegation!.agent!.paPayment!.status, 'awaiting_provider');
    assert.equal(pending.artifact, undefined); assert.equal(t.provider.countPayments(), 0); assert.equal(t.provider.countCheckouts(), 1);
    assert.deepEqual(pending.delegation!.agent!.paPayment!.request, waiting.delegation!.agent!.paPayment!.request);
    assert.throws(() => t.select(pending, 'pa_payment_account'), /route or attempt already exists/);
  } finally { await t.close(); }
});

test('A lost PA payment response is recovered by original operation query without another payment', async () => {
  const t = await setupShopifyPayment();
  try {
    const waiting = await t.finish(t.submit().id), selected = t.select(waiting), payment = selected.delegation!.agent!.paPayment!;
    t.provider.flags.dropPAResponse = true; await assert.rejects(t.pa.pay(payment.request, payment.selection!));
    assert.equal((await t.pa.query(payment.selection!.operationId)).state, 'paid');
    t.report(selected, 'unknown'); const done = await t.finish(waiting.id); assert.equal(done.state, 'completed');
    assert.equal(t.provider.countPayments(), 1); assert.equal(t.provider.audit().filter(value => value.action === 'pay').length, 1);
  } finally { await t.close(); }
});

test('A lost checkout creation response queries the original operation and publishes only one handoff', async () => {
  const t = await setupShopifyPayment();
  try {
    t.provider.flags.dropCreateResponse = true;
    const waiting = await t.finish(t.submit().id); assert.equal(waiting.state, 'input-required');
    assert.equal(t.provider.countCheckouts(), 1); assert.equal(t.provider.countPayments(), 0);
    const creates = t.provider.audit().filter(value => value.action === 'CreateShopifyPaymentCheckout');
    assert.equal(creates.filter(value => value.method === 'POST').length, 1); assert(creates.some(value => value.method === 'GET' && value.path.startsWith('/operations/')));
    assert.equal(waiting.delegation!.agent!.observations.filter(ref => ref.type === 'PAPaymentRequest').length, 1);
  } finally { await t.close(); }
});

test('The independent merchant restarts with the same checkout and PA operation identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shopify-provider-restart-')), databasePath = join(directory, 'provider.sqlite');
  let provider = await createShopifyPASandbox({ databasePath });
  const t = await setupShopifyPayment({ provider });
  try {
    const waiting = await t.finish(t.submit().id), selected = t.select(waiting), payment = selected.delegation!.agent!.paPayment!;
    const settings = { databasePath, port: Number(new URL(provider.endpoint).port), sourceToken: provider.sourceToken, paToken: provider.paToken };
    await provider.close(); provider = await createShopifyPASandbox(settings);
    await t.pa.pay(payment.request, payment.selection!); t.report(selected);
    const done = await t.finish(waiting.id); assert.equal(done.state, 'completed');
    assert.equal(done.delegation!.agent!.paPayment!.request.digest, payment.request.digest); assert.equal(provider.countCheckouts(), 1); assert.equal(provider.countPayments(), 1);
  } finally { await t.close(); await provider.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Payment alone waits for order confirmation and reconciliation keeps the same checkout and operation', async () => {
  const t = await setupShopifyPayment();
  try {
    const waiting = await t.finish(t.submit().id), selected = t.select(waiting), payment = selected.delegation!.agent!.paPayment!;
    const request = paCheckoutPaymentRequestSchema.parse(payment.request); t.provider.flags.confirmOrder = false;
    await t.pa.pay(request, payment.selection!); t.report(selected);
    const pending = await t.finish(waiting.id); assert.equal(pending.state, 'input-required'); assert.equal(pending.artifact, undefined);
    t.provider.flags.confirmOrder = true; t.provider.settle(request.terms.resource.id);
    t.b.tasks.reconcile(principal, waiting.id, randomUUID()); const done = await t.finish(waiting.id); assert.equal(done.state, 'completed');
    assert.equal(done.delegation!.agent!.paPayment!.request.digest, request.digest); assert.equal(t.provider.countPayments(), 1); assert.equal(t.provider.countCheckouts(), 1);
  } finally { await t.close(); }
});

for (const field of ['amount', 'payee', 'order', 'operation'] as const) test(`Independent ${field} mismatch cannot complete the original Shopify test payment`, async () => {
  const t = await setupShopifyPayment();
  try {
    const waiting = await t.finish(t.submit().id), selected = t.select(waiting), payment = selected.delegation!.agent!.paPayment!, request = paCheckoutPaymentRequestSchema.parse(payment.request);
    await t.pa.pay(request, payment.selection!);
    t.provider.mutate(request.terms.resource.id, (_checkout, paid) => { if (field === 'amount') paid.paidAmount.minor = '99'; if (field === 'payee') paid.payeeId = 'another-payee'; if (field === 'order') paid.orderId = 'another-order'; if (field === 'operation') paid.operationId = randomUUID(); });
    t.report(selected); const result = await t.finish(waiting.id); assert.notEqual(result.state, 'completed'); assert.equal(result.artifact, undefined); assert.equal(t.provider.countPayments(), 1);
  } finally { await t.close(); }
});

test('EIGOS source credential cannot execute PA payment and another owner cannot select its route', async () => {
  const t = await setupShopifyPayment();
  try {
    const waiting = await t.finish(t.submit().id), request = waiting.delegation!.agent!.paPayment!.request;
    const response = await fetch(t.provider.endpoint + '/pa/payments', { method: 'POST', headers: { authorization: `Bearer ${t.provider.sourceToken}`, 'content-type': 'application/json' }, body: '{}' }); assert.equal(response.status, 403);
    assert.throws(() => t.b.tasks.selectPaymentRoute({ ...principal, subject: 'another-owner' }, { taskId: waiting.id, requestId: randomUUID(), action: 'select_payment_route', handoffId: request.id, handoffDigest: request.digest, capability: { route: 'pa_vault', status: 'available', environment: 'sandbox', observedAt: new Date().toISOString() } }));
    assert.equal(t.provider.countPayments(), 0);
  } finally { await t.close(); }
});

test('Cancellation followed by a late PA payment records readback but never reopens the canceled task', async () => {
  const t = await setupShopifyPayment();
  try {
    const waiting = await t.finish(t.submit().id), selected = t.select(waiting), payment = selected.delegation!.agent!.paPayment!;
    let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    t.provider.flags.beforeResponse = async action => { if (action === 'PAPayment') { entered(); await gate; } };
    const inFlight = t.pa.pay(payment.request, payment.selection!); await started; t.b.tasks.cancel(principal, waiting.id); release(); await inFlight;
    t.report(selected, 'unknown'); const claim = t.store.claim(['eigos.delegate'], 60000); assert(claim); try { await t.b.coordinator.run(claim, new AbortController().signal); } finally { t.store.release(claim); }
    const canceled = t.b.tasks.get(principal, waiting.id); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.artifact, undefined); assert.equal(canceled.delegation!.agent!.paPayment!.status, 'withdrawn'); assert.equal(canceled.delegation!.agent!.paPayment!.recovery!.result, 'confirmed');
  } finally { await t.close(); }
});
