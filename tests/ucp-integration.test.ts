import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { UCP_CONFIRM, UCP_PREPARE, UcpSandboxAdapter } from '../packages/capabilities/ucp/adapter.js';
import { JobStore } from '../packages/core/store.js';
import { backend, interpretation, owner, principal, reasoner } from './backend-fixture.js';
import { ucpMerchant } from './fixtures/ucp-merchant.js';
import type { Job } from '../packages/core/domain.js';
import { orderSnapshot } from '../packages/capabilities/ucp/snapshot.js';
import { UcpRestClient } from '../packages/capabilities/ucp/client.js';
import type { UcpOrder } from '../packages/capabilities/ucp/contracts.js';
import { assessCommerce, type CommerceSnapshot } from '../packages/ontology/commerce.js';
import { projectCommerceSnapshot } from '../packages/ontology/commerce-projection.js';

async function setup() {
  const merchant = await ucpMerchant(), store = new JobStore(':memory:'); let preparationTaskId = '';
  const catalog = createExecutionCatalog({ store, ucpSandbox: merchant.options });
  const b = backend(catalog, reasoner(req => {
    const prepare = req.originalGoal === 'Prepare a checkout only', id = prepare ? UCP_PREPARE : UCP_CONFIRM;
    return { ...interpretation(req, id, prepare ? { items: [{ id: 'roses', quantity: 2 }], fulfillmentProfile: 'office' } : { preparationTaskId, budget: { minor: '10000', currency: 'USD' } }), capabilityRef: { id, version: '1' } };
  }), store, { allowSandbox: true });
  const approve = (job: Job, effects = job.delegation!.authorizationRequest!.effects) => {
    const a = job.delegation!.authorizationRequest!;
    return b.tasks.authorize(principal, job.id, { action: 'approve_plan', requestId: randomUUID(), planDigest: a.planDigest, allowedEffects: effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' });
  };
  const prepare = async () => { b.submit({ goal: 'Prepare a checkout only', executionEnvironment: 'sandbox' }); const waiting = await b.run(); assert.equal(waiting.state, 'auth-required'); assert.equal(merchant.counts().creates, 0); approve(waiting); const done = await b.run(); assert.equal(done.state, 'completed'); preparationTaskId = done.id; return done; };
  const confirmation = async () => { const submitted = b.submit({ goal: 'Confirm the prepared purchase', executionEnvironment: 'sandbox', requirements: [{ id: 'budget', kind: 'budget', role: 'service_total', strength: 'hard', expected: { minor: '10000', currency: 'USD' } }] }); const waiting = await b.run(); assert.equal(waiting.id, submitted.id); return waiting; };
  const drain = async (id: string) => { for (let i = 0; i < 35; i++) { const current = store.get(owner, id); if (!['working', 'submitted'].includes(current.state)) return current; const claim = store.claim(['eigos.delegate'], 15000); if (claim) await b.coordinator.run(claim, new AbortController().signal); else await pause(100); } return store.get(owner, id); };
  return { merchant, store, catalog, b, approve, prepare, confirmation, drain, close: async () => { store.close(); await merchant.close(); } };
}

test('UCP preparation and confirmation share the runtime but require distinct authority and preserve business meaning', async () => {
  const t = await setup(); try {
    const prepared = await t.prepare(); assert.equal(t.merchant.counts().completes, 0);
    assert.equal(t.store.ontology.query(owner, { type: 'Order' }).items.length, 0);
    assert.equal(prepared.delegation!.plan!.completionTarget, 'artifact');
    const waiting = await t.confirmation(); assert.equal(waiting.state, 'auth-required');
    assert.deepEqual(waiting.delegation!.authorizationRequest!.effects, ['order', 'payment']);
    assert.equal(waiting.delegation!.authorizationRequest!.maxAmount.minor, '7500');
    t.approve(waiting, ['order']); const stillWaiting = await t.b.run(); assert.equal(stillWaiting.state, 'auth-required'); assert.equal(t.merchant.counts().completes, 0);
    t.approve(stillWaiting); const done = await t.b.run(); assert.equal(done.state, 'completed'); assert.equal(done.delegation!.acceptance!.accepted, true);
    assert.deepEqual(t.merchant.counts(), { creates: 1, completes: 1 }); assert.equal(t.merchant.flags.signatureMissing, false);
    const session = t.store.ontology.query(owner, { type: 'CheckoutSession' }).items[0]!;
    assert.equal((t.store.ontology.evaluate(owner, { function: 'commerceOrderOutcome', object: session.ref }).value as { status: string }).status, 'satisfied');
    const order = t.store.ontology.query(owner, { type: 'Order' }).items[0]!; assert.equal(order.properties.orderState, 'confirmed'); assert.equal(order.properties.fulfillmentState, 'pending');
    assert.equal(t.store.ontology.query(owner, { type: 'Payment' }).items.length, 0, 'Checkout completion is not a separate payment receipt');
    assert.equal(t.store.ontology.query('another-owner', { type: 'Order' }).items.length, 0);
    assert(!JSON.stringify(done).includes('success_token')); assert(!JSON.stringify(done.artifact).includes('123 Test Street'));
    assert.equal(t.store.get(owner, prepared.id).artifact!.id, prepared.artifact!.id, 'A later order must not rewrite the preparation artifact');
  } finally { await t.close(); }
});

test('UCP rechecks the approved quote before completion and never submits changed amounts', async () => {
  const t = await setup(); try {
    await t.prepare(); const waiting = await t.confirmation(); t.approve(waiting);
    const checkout = [...t.merchant.checkouts.values()][0]!; checkout.totals[0].amount += 100;
    const done = await t.b.run(); assert.equal(done.state, 'failed'); assert.equal(t.merchant.counts().completes, 0);
  } finally { await t.close(); }
});

test('UCP lost completion response recovers the original checkout and order without repeating the write', async () => {
  const t = await setup(); try {
    await t.prepare(); const waiting = await t.confirmation(); t.approve(waiting); t.merchant.flags.dropComplete = true;
    const unknown = await t.b.run(); assert.equal(unknown.state, 'working'); assert.equal(t.merchant.counts().completes, 1);
    const done = await t.drain(waiting.id); assert.equal(done.state, 'completed'); assert.equal(t.merchant.requests.filter(r => r.path.endsWith('/complete')).length, 1);
    assert.equal(t.merchant.orders.size, 1); assert(t.merchant.requests.some(r => r.method === 'GET' && r.path.startsWith('/orders/')));
  } finally { await t.close(); }
});

test('UCP lost creation response does not invent a lookup or create a second checkout', async () => {
  const t = await setup(); try {
    t.merchant.flags.dropCreate = true; const job = t.b.submit({ goal: 'Prepare a checkout only', executionEnvironment: 'sandbox' }); const waiting = await t.b.run(); t.approve(waiting);
    const unknown = await t.b.run(); assert.equal(unknown.state, 'working');
    await t.drain(job.id); assert.deepEqual(t.merchant.counts(), { creates: 1, completes: 0 }); assert.equal(t.merchant.requests.filter(r => r.method === 'POST').length, 1);
    assert.equal(t.store.get(owner, job.id).artifact, undefined);
  } finally { await t.close(); }
});

for (const issue of ['badOrderItems', 'badOrderDestination'] as const) test(`UCP independent order read rejects ${issue}`, async () => {
  const t = await setup(); try {
    await t.prepare(); const waiting = await t.confirmation(); t.approve(waiting); t.merchant.flags[issue] = true;
    const done = await t.b.run(); assert.equal(done.state, 'failed'); assert.equal(done.artifact, undefined); assert.equal(t.merchant.counts().completes, 1);
  } finally { await t.close(); }
});

test('UCP cancellation before dispatch prevents both order and mock payment', async () => {
  const t = await setup(); try {
    await t.prepare(); const waiting = await t.confirmation(); t.approve(waiting); t.b.tasks.cancel(principal, waiting.id);
    assert.equal(t.store.get(owner, waiting.id).state, 'canceled'); assert.equal(t.merchant.counts().completes, 0);
  } finally { await t.close(); }
});

test('UCP connections cannot target a live host, and preparation records cannot cross owners', async () => {
  const t = await setup(); try {
    assert.throws(() => new UcpRestClient({ ...t.merchant.options, baseUrl: 'https://merchant.example' }), /127.0.0.1/);
    assert.throws(() => new UcpRestClient({ ...t.merchant.options, baseUrl: 'http://127.0.0.1:1234@evil.example' }), /127.0.0.1/);
    const prep = await t.prepare(), adapter = new UcpSandboxAdapter('confirm', t.store, t.merchant.options);
    await assert.rejects(adapter.prepare({ owner: 'another-owner', request: { ...prep.delegation!.request, id: randomUUID() } }, { preparationTaskId: prep.id, budget: { minor: '10000', currency: 'USD' } }, new AbortController().signal), /local sandbox/);
    assert(!createExecutionCatalog().summaries(owner, 16, 'sandbox').some(c => c.ref.id === UCP_CONFIRM));
  } finally { await t.close(); }
});

test('UCP fulfillment uses unique actual delivered events, not fulfilled counters or shipping labels', async () => {
  const t = await setup(); try {
    await t.prepare(); const waiting = await t.confirmation(); t.approve(waiting); await t.b.run();
    const order = [...t.merchant.orders.values()][0]! as UcpOrder, now = new Date().toISOString(); order.line_items[0]!.quantity.fulfilled = 2;
    order.fulfillment.events = [{ id: 'event-shipped', type: 'shipped', occurred_at: now, line_items: [{ id: order.line_items[0]!.id, quantity: 2 }] }];
    const receipt = { id: 'receipt', method: 'GET', path: `/orders/${order.id}`, startedAt: now, receivedAt: now, status: 200, inputDigest: 'a'.repeat(64), responseSha256: 'b'.repeat(64), environment: 'sandbox' as const };
    assert.equal(orderSnapshot({ value: order, receipt }).fulfillment, 'pending');
    order.fulfillment.events[0]!.type = 'delivered'; order.fulfillment.events[0]!.line_items[0]!.quantity = 1;
    assert.equal(orderSnapshot({ value: order, receipt }).fulfillment, 'partial');
    order.fulfillment.events.push(structuredClone(order.fulfillment.events[0]!)); assert.throws(() => orderSnapshot({ value: order, receipt }), /Duplicate/);
    order.fulfillment.events.pop(); order.fulfillment.events[0]!.occurred_at = new Date(Date.now() + 60000).toISOString(); assert.throws(() => orderSnapshot({ value: order, receipt }), /future event/);
  } finally { await t.close(); }
});

test('UCP refuses unnegotiated versions, changed origins, redirects, HTTP-200 business failures and real payment handlers', async () => {
  const merchant = await ucpMerchant(); try {
    const client = new UcpRestClient(merchant.options), signal = new AbortController().signal;
    merchant.flags.profileVersion = '2026-08-25'; await assert.rejects(client.discover(signal));
    merchant.flags.profileVersion = '2026-04-08'; merchant.flags.foreignEndpoint = true; await assert.rejects(client.discover(signal), /origin/);
    merchant.flags.foreignEndpoint = false; merchant.flags.noMockHandler = true; await client.discover(signal); await assert.rejects(client.completeMockCheckout('checkout', 'key', signal), /mock payment handler/);
    merchant.flags.noMockHandler = false; await client.discover(signal);
    merchant.flags.redirectCreate = true; await assert.rejects(client.createCheckout({}, 'redirect-key', signal), /redirects/);
    merchant.flags.redirectCreate = false; merchant.flags.businessError200 = true; await assert.rejects(client.createCheckout({}, 'error-key', signal), /HTTP 200; out_of_stock/);
    assert.deepEqual(merchant.counts(), { creates: 0, completes: 0 });
  } finally { await merchant.close(); }
});

test('UCP does not reinterpret measured quantities or silently accept post-purchase changes', async () => {
  const t = await setup(); try {
    await t.prepare(); const waiting = await t.confirmation(); t.approve(waiting); const done = await t.b.run();
    const report = done.artifact!.data.result as { ucpSnapshot: CommerceSnapshot }, snapshot = structuredClone(report.ucpSnapshot);
    snapshot.order!.adjustmentCount = 1; assert.equal(assessCommerce(snapshot).status, 'unknown');
    const raw = [...t.merchant.orders.values()][0]! as UcpOrder;
    raw.line_items[0]!.item.quantity_unit = { unit: 'KGM', scale: 2 };
    assert.throws(() => orderSnapshot({ value: raw, receipt: snapshot.order!.receipt }), /measured quantities/);
    delete raw.line_items[0]!.item.quantity_unit;
    const order = [...t.merchant.orders.values()][0]!; order.adjustments = [{ id: 'return-in-progress', type: 'return', status: 'pending' }];
    const before = done.artifact!.id; t.b.tasks.reconcile(principal, done.id, randomUUID()); await t.b.run();
    assert.equal(t.store.get(owner, done.id).state, 'completed'); assert.equal(t.store.get(owner, done.id).artifact!.id, before);
    assert.equal(t.store.ontology.query(owner, { type: 'Order' }).items[0]!.properties.orderState, 'unknown');
  } finally { await t.close(); }
});

test('UCP late source projections do not overwrite newer order facts and stale evidence cannot remain valid', async () => {
  const t = await setup(); try {
    const prepared = await t.prepare(); const old = (prepared.artifact!.data.result as { ucpSnapshot: CommerceSnapshot }).ucpSnapshot;
    await pause(2); const waiting = await t.confirmation(); t.approve(waiting); const done = await t.b.run();
    const result = projectCommerceSnapshot(t.store.ontology, owner, prepared.delegation!.request, UCP_PREPARE, prepared.delegation!.plan!.steps[0]!.input, old);
    assert.equal(result.state, 'invalid_source');
    const session = t.store.ontology.query(owner, { type: 'CheckoutSession' }).items[0]!; assert.equal(session.properties.state, 'completed');
    t.store.ontology.ingest(owner, { objects: [{ ref: session.ref, expectedRevision: session.revision, properties: { ...session.properties, total: { minor: '1', currency: 'USD' } } }] }, { kind: 'synthetic', id: 'tampered-test', observedAt: new Date().toISOString() });
    assert.equal(t.store.ontology.evaluate(owner, { function: 'commerceOrderOutcome', object: session.ref }).status, 'unknown');
    assert.equal(t.store.get(owner, done.id).state, 'completed', 'Historical accepted task is not rewritten by later unverified data');
  } finally { await t.close(); }
});

test('one prepared checkout can have only one owned confirmation intent across tasks', async () => {
  const t = await setup(); try {
    const prepared = await t.prepare(), first = await t.confirmation(), adapter = new UcpSandboxAdapter('confirm', t.store, t.merchant.options);
    const otherRequest = { ...first.delegation!.request, id: randomUUID() };
    const attempted = await adapter.prepare({ owner, request: otherRequest }, { preparationTaskId: prepared.id, budget: { minor: '10000', currency: 'USD' } }, new AbortController().signal);
    assert.equal(attempted.kind, 'unavailable'); if (attempted.kind === 'unavailable') assert.equal(attempted.details?.originalTaskId, first.id);
    const originalIntent = t.store.intents(owner, first.id)[0]!; assert(first.delegation!.plan!.steps[0]!.operationScope);
    assert.equal(t.store.intentByBusinessKey('another-owner', originalIntent.businessOperationKey), undefined);
    t.approve(first); const done = await t.b.run(); assert.equal(done.state, 'completed');
    assert.equal(t.merchant.requests.find(r => r.path.endsWith('/complete'))!.key, originalIntent.businessOperationKey);
    assert.equal(t.merchant.counts().completes, 1);
  } finally { await t.close(); }
});

test('UCP preparation only uses own configured fulfillment profiles and confirmation requires the mock handler before a plan', async () => {
  const t = await setup(); try {
    const created = t.b.submit({ goal: 'Prepare a checkout only', executionEnvironment: 'sandbox' });
    const creator = new UcpSandboxAdapter('prepare', t.store, t.merchant.options);
    const invalid = await creator.prepare({ owner, request: created.delegation!.request }, { items: [{ id: 'roses', quantity: 2 }], fulfillmentProfile: 'constructor' }, new AbortController().signal); assert.equal(invalid.kind, 'unavailable');
    t.b.tasks.cancel(principal, created.id);
    const prepared = await t.prepare(); t.merchant.flags.noMockHandler = true;
    const confirm = new UcpSandboxAdapter('confirm', t.store, t.merchant.options);
    const unsupported = await confirm.prepare({ owner, request: { ...prepared.delegation!.request, id: randomUUID() } }, { preparationTaskId: prepared.id, budget: { minor: '10000', currency: 'USD' } }, new AbortController().signal);
    assert.equal(unsupported.kind, 'unavailable'); assert.equal(t.merchant.counts().completes, 0);
  } finally { await t.close(); }
});

test('a late UCP completion after task cancellation is retained as evidence without advancing the canceled task or its ontology', async () => {
  const t = await setup(); let release = () => {};
  try {
    await t.prepare(); const waiting = await t.confirmation(); t.approve(waiting);
    let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    t.merchant.flags.beforeCompleteResponse = async () => { entered(); await held; };
    const running = t.b.run(); await Promise.race([reached, pause(2000).then(() => { throw new Error('Expected the independent merchant to complete the order'); })]);
    t.b.tasks.cancel(principal, waiting.id); release(); await running;
    const canceled = t.store.get(owner, waiting.id); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.artifact, undefined);
    assert.equal(t.merchant.orders.size, 1); assert.equal(t.merchant.counts().completes, 1);
    assert(t.store.intents(owner, waiting.id)[0]!.latestObservationId, 'The external effect must remain in the action ledger');
    assert.equal(t.store.ontology.query(owner, { type: 'Order' }).items.length, 0, 'The canceled claim must not project a new business result');
  } finally { release(); await t.close(); }
});
