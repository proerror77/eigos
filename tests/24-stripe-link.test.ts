import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StripeSandbox } from '../packages/capabilities/payments/stripe-sandbox.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import type { AgentDriver } from '../packages/runtime/agent.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { fixture, principal } from './fixture.js';

const account = 'acct_Sandbox';
const session = 'cs_test_Checkout';
const checkoutUrl = 'https://checkout.stripe.com/g/pay/' + session;
const expires = Math.floor(Date.now() / 1000) + 3600;

function simulatedStripe() {
  let order: string | null = null;
  let creates = 0;
  let method: 'card' | 'link' | undefined;
  let loseCreateResponse = false;
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.stripe.com');
    requests.push(init?.method + ' ' + url.pathname);
    if (url.pathname === '/v1/account') return Response.json({ id: account });
    if (init?.method === 'POST') {
      assert.equal(url.pathname, '/v1/checkout/sessions');
      assert(init.body instanceof URLSearchParams);
      order = init.body.get('client_reference_id');
      assert.equal(init.body.get('mode'), 'payment');
      assert.equal(init.body.get('payment_method_types[1]'), 'link');
      assert.equal(init.body.get('line_items[0][price_data][unit_amount]'), '100');
      assert.equal(new Headers(init.headers).get('Idempotency-Key'), order);
      creates++;
      if (loseCreateResponse) throw new Error('Checkout created but response lost');
    } else {
      assert.equal(url.pathname, '/v1/checkout/sessions/' + session);
      assert.equal(url.searchParams.get('expand[]'), 'payment_intent.latest_charge');
    }
    return Response.json({
      id: session, livemode: false, mode: 'payment', status: method ? 'complete' : 'open',
      payment_status: method ? 'paid' : 'unpaid', amount_total: 100, currency: 'usd',
      client_reference_id: order, expires_at: expires, payment_method_types: ['card', 'link'],
      url: method ? null : checkoutUrl,
      payment_intent: method ? {
        id: 'pi_Sandbox', livemode: false, status: 'succeeded', amount_received: 100, currency: 'usd',
        latest_charge: { id: 'ch_Sandbox', livemode: false, paid: true, captured: true, amount: 100,
          currency: 'usd', payment_method_details: { type: method } },
      } : null,
    });
  };
  const client = new StripeSandbox('Test merchant', 'binding', account, async () => 'sk_test_fixture', fetcher);
  return {
    client, requests, get creates() { return creates; }, get order() { return order; },
    setMethod(value: 'card' | 'link') { method = value; }, loseResponse() { loseCreateResponse = true; },
  };
}

const resolver = (stripe: ReturnType<typeof simulatedStripe>) => async (owner: string) => {
  assert.equal(owner, principal.owner);
  return { merchant: stripe.client.merchant, authorityId: stripe.client.authorityId, evidence: 'synthetic' as const,
    verifyAccount: stripe.client.verifyAccount.bind(stripe.client), create: stripe.client.create.bind(stripe.client),
    read: stripe.client.read.bind(stripe.client) };
};

test('published payment Interface Actions deliver only to the original PA owner and read back the exact Link payment', async () => {
  const stripe = simulatedStripe();
  const driver: AgentDriver = {
    model: 'fixture-payment-actions',
    async run(prompt, tools) {
      const task = JSON.parse(prompt.split('\n').at(-1)!);
      const payment = JSON.parse(task.userRequest.message);
      const action = { type: 'ManualPayment', object: payment, action: 'handoff' };
      const result = await tools.get('apply_action')!.invoke({ interface: action, input: { payment } }) as { waitingForPA?: boolean };
      if (result.waitingForPA) return;
      await tools.get('complete_with_object_set')!.invoke({ set: { op: 'query', query: { type: 'ManualPayment' } } });
    },
  };
  const f = await fixture(driver, undefined, resolver(stripe));
  try {
    const key = randomUUID(), graph = new Objects(f.db, f.model, f.access);
    const apply = (action: string, input: Record<string, unknown>) =>
      f.capabilities.actions.apply(f.access, f.model, action, input, randomUUID());
    const applyInterface = (ref: {type: string; id: string}, type: string, action: string, input: Record<string, unknown>) => {
      const selected = f.model.resolveAction(ref, type, action, input);
      return apply(selected.action, selected.input);
    };
    const order = await apply('CreateStripeSandboxOrder', { orderKey: key });
    assert.deepEqual(await apply('CreateStripeSandboxOrder', { orderKey: key }), order);
    assert.equal(stripe.creates, 1);
    const payment = await applyInterface(order, 'PayableOrder', 'prepare', { order });
    assert.deepEqual((await graph.follow(payment, 'order', 'ManualPayment'))[0]?.ref, order);
    assert.equal((await graph.read(payment)).properties.status, 'awaiting_payment');
    const task = await f.tasks.submit(principal, { requestId: randomUUID(), message: JSON.stringify(payment) });
    await f.worker.runOne();
    const pa = new PARequests(f.tasks), inbox = await pa.pending(principal);
    assert.equal(inbox.items.length, 1);
    const request = inbox.items[0]!.request;
    assert.equal(request.capability, 'payments.manual_checkout');
    assert.equal(request.input.checkoutUrl, checkoutUrl);
    assert.equal(request.input.merchantOrderId, order.id);
    const other = { ...principal, owner: 'another-sandbox-pa' };
    await setGrants(f.db, other.owner, memberGrants(f.model));
    assert.equal((await pa.pending(other)).items.length, 0);
    assert.equal((await new Objects(f.db, f.model, await Access.load(f.db, other)).query({ type: 'ManualPayment' })).items.length, 0);
    await assert.rejects(pa.respond(other, task.id, { requestId: request.requestId, response: { decision: 'check_status' } }), /unavailable/);
    await pa.respond(principal, task.id, { requestId: request.requestId, response: { decision: 'check_status' } });
    await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'completed');
    assert.equal((await graph.read(payment)).properties.status, 'awaiting_payment');
    stripe.setMethod('link');
    assert.deepEqual(await applyInterface(payment, 'ManualPayment', 'refresh', { payment }), payment);
    const paid = await graph.read(payment);
    assert.equal(paid.properties.status, 'paid');
    assert.equal(paid.properties.transactionId, 'pi_Sandbox');
    assert.equal(paid.properties.evidence, 'synthetic');
    assert.equal(paid.properties.independentRead, true);
    assert.equal(stripe.requests.filter(item => item.startsWith('POST')).length, 1);
  } finally { await f.close(); }
});

test('recovering a lost response registers the same provider order without creating another checkout', async () => {
  const stripe = simulatedStripe();
  stripe.loseResponse();
  const f = await fixture(undefined, undefined, resolver(stripe));
  try {
    const orderKey = randomUUID();
    const apply = (action: string, input: Record<string, unknown>) =>
      f.capabilities.actions.apply(f.access, f.model, action, input, randomUUID());
    await assert.rejects(apply('CreateStripeSandboxOrder', { orderKey }), /unresolved result/);
    await assert.rejects(apply('CreateStripeSandboxOrder', { orderKey }), /before any further submission/);
    await assert.rejects(apply('RecoverStripeSandboxOrder', {
      merchantOrderId: '0'.repeat(64), sessionId: session,
    }), /No unresolved/);
    const recovered = await apply('RecoverStripeSandboxOrder', { merchantOrderId: stripe.order, sessionId: session });
    assert.equal(recovered.id, stripe.order);
    assert.deepEqual(await apply('CreateStripeSandboxOrder', { orderKey }), recovered);
    assert.equal(stripe.creates, 1);
  } finally { await f.close(); }
});

test('Stripe adapter distinguishes a card payment and rejects live credentials before any request', async () => {
  const stripe = simulatedStripe(), signal = AbortSignal.timeout(5000);
  await stripe.client.create('sandbox-order', signal);
  stripe.setMethod('card');
  assert.equal((await stripe.client.read('sandbox-order', session, signal)).status, 'paid_other_method');
  await assert.rejects(stripe.client.read('different-order', session, signal), /identity/);
  const live = new StripeSandbox('Test merchant', 'binding', account, async () => 'sk_live_fixture',
    async () => { assert.fail('Live credentials must never be sent'); });
  await assert.rejects(live.verifyAccount(signal), /sandbox key/);
});
