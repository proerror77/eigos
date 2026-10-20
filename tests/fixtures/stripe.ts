import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentPlanningContext, PlanningAccess } from '../../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../../packages/ontology/agent-actions.js';
import type { StripeTestOptions } from '../../packages/capabilities/stripe/client.js';
import { STRIPE_API_VERSION } from '../../packages/capabilities/stripe/client.js';
import { commerceChoice, commerceDecision, commerceReads, commerceStep, setupCommerce } from './commerce-agent.js';

/** Isolated wire-contract fixture, never a Stripe-connected integration test. */
export function stripeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-stripe-fixture-')), secretKeyFile = join(directory, 'stripe-test-key');
  const key = 'sk_test_fixtureOnlyNeverARealCredential';
  writeFileSync(secretKeyFile, key, { mode: 0o600 });
  const intents = new Map<string, Record<string, any>>(), tokens = new Map<string, Record<string, any>>();
  const calls: { method: string; path: string; body: Record<string, string>; idempotency?: string | null }[] = [];
  const writes = new Map<string, string>();
  const flags: { outcome?: 'declined' | 'requires_action' | 'processing'; dropCreate?: boolean; dropConfirm?: boolean; confirmErrorAfterSuccess?: boolean; hideSearch?: boolean; wrongAccount?: boolean; liveResponse?: boolean; badTokenLimit?: boolean; beforeReturn?: (path: string) => Promise<void> } = {};
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', headers = new Headers(init?.headers), body = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    assert.equal(url.origin, 'https://api.stripe.com'); assert.equal(headers.get('authorization'), `Bearer ${key}`); assert.equal(headers.get('stripe-version'), STRIPE_API_VERSION); assert.equal(init?.redirect, 'error');
    const call = { method, path: url.pathname, body, idempotency: headers.get('idempotency-key') }; calls.push(call);
    if (method === 'POST') { assert.match(call.idempotency!, /^eigos-[a-f0-9]{64}$/); const old = writes.get(call.idempotency!); assert.equal(old, undefined, 'The runtime must not replay a Stripe business write'); writes.set(call.idempotency!, JSON.stringify(body)); }
    let result: unknown, status = 200;
    if (url.pathname === '/v1/account') result = { object: 'account', id: flags.wrongAccount ? 'acct_other' : 'acct_fixture' };
    else if (url.pathname === '/v1/payment_intents' && method === 'POST') {
      assert.equal(body.confirm, 'false'); assert.equal(body.capture_method, 'automatic'); assert.equal(body['payment_method_types[0]'], 'card');
      const id = `pi_${randomUUID().replaceAll('-', '')}`;
      const pi = { object: 'payment_intent', id, amount: Number(body.amount), currency: body.currency, amount_received: 0, status: 'requires_payment_method', capture_method: 'automatic', confirmation_method: 'automatic', payment_method_types: ['card'], transfer_data: null, on_behalf_of: null, application_fee_amount: null, setup_future_usage: null, livemode: false, metadata: { eigos_binding: body['metadata[eigos_binding]'], eigos_prepare: body['metadata[eigos_prepare]'] }, latest_charge: null, last_payment_error: null, client_secret: `${id}_secret_MUST_NOT_LEAK` };
      intents.set(id, pi); result = pi;
      if (flags.dropCreate) { flags.dropCreate = false; throw new Error('fixture response lost after create'); }
    } else if (url.pathname === '/v1/payment_intents/search') {
      const expected = url.searchParams.get('query')?.match(/metadata\['eigos_prepare'\]:'([a-f0-9]{64})'/)?.[1]; assert(expected);
      result = { object: 'search_result', data: flags.hideSearch ? [] : [...intents.values()].filter(p => p.metadata.eigos_prepare === expected), has_more: false };
    } else if (url.pathname === '/v1/test_helpers/shared_payment/granted_tokens') {
      assert.equal(body.payment_method, 'pm_card_visa');
      const id = `spt_${randomUUID().replaceAll('-', '')}`;
      const token = { id, object: 'shared_payment.granted_token', livemode: false, deactivated_at: null, usage_limits: { currency: body['usage_limits[currency]'], max_amount: Number(body['usage_limits[max_amount]']) + (flags.badTokenLimit ? 1 : 0), expires_at: Number(body['usage_limits[expires_at]']) }, payment_method_details: { card: { last4: '4242' } } };
      tokens.set(id, token); result = token;
    } else if (url.pathname.startsWith('/v1/shared_payment/granted_tokens/')) result = tokens.get(url.pathname.split('/').at(-1)!);
    else if (url.pathname.startsWith('/v1/payment_intents/pi_')) {
      const id = url.pathname.split('/')[3]!, pi = intents.get(id); assert(pi);
      if (url.pathname.endsWith('/confirm')) {
        const token = tokens.get(body['payment_method_data[shared_payment_granted_token]']!); assert(token); assert.equal(token.usage_limits.max_amount, pi.amount); assert.equal(token.usage_limits.currency, pi.currency); assert(token.usage_limits.expires_at > Date.now() / 1000);
        if (flags.outcome === 'declined') { pi.last_payment_error = { code: 'card_declined', message: 'spt_private_error_should_not_leak' }; result = { error: pi.last_payment_error }; status = 402; }
        else if (flags.outcome) pi.status = flags.outcome;
        else { pi.status = 'succeeded'; pi.amount_received = pi.amount; pi.latest_charge = { id: `ch_${randomUUID().replaceAll('-', '')}`, object: 'charge', payment_intent: pi.id, amount: pi.amount, currency: pi.currency, paid: true, captured: true, refunded: false, amount_refunded: 0, disputed: false, livemode: false }; }
        if (flags.dropConfirm) { flags.dropConfirm = false; throw new Error('fixture response lost after confirmation'); }
        if (flags.confirmErrorAfterSuccess) { status = 400; result = { error: { code: 'payment_intent_unexpected_state', message: 'Fixture original PaymentIntent already succeeded' } }; }
      } else assert.equal(url.searchParams.get('expand[0]'), 'latest_charge');
      result ??= pi;
    } else assert.fail(`Unexpected Stripe fixture request ${method} ${url.pathname}`);
    if (flags.liveResponse && result && typeof result === 'object' && 'livemode' in result) (result as any).livemode = true;
    await flags.beforeReturn?.(url.pathname);
    return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json', 'request-id': `req_${randomUUID().replaceAll('-', '')}` } });
  };
  const options: StripeTestOptions = { secretKeyFile, accountId: 'acct_fixture', merchantId: 'cedar-ca', transport };
  return { options, key, directory, calls, flags, intents, tokens, close: () => rmSync(directory, { recursive: true, force: true }) };
}

export function stripeChoice(ctx: AgentPlanningContext, access: PlanningAccess): AgentDecision {
  if (ctx.actionOutcomes?.some(o => o.state === 'rejected' && o.stepId === 'pay')) {
    commerceReads(ctx, access);
    return { ...commerceDecision(ctx), kind: 'no_feasible_plan', message: 'The original test payment was declined; a new payment must not be silently attempted.' };
  }
  if (!ctx.state.observations.some(r => r.type === 'CommerceOrderObservation')) {
    const decision = commerceChoice({ target: 'order', cart: false })(ctx, access);
    decision.steps = decision.steps.map(s => ({ ...s, action: s.action === 'SubmitCommerceOrder' ? 'SubmitCommerceUnpaidOrder' : s.action }));
    return decision;
  }
  const { last } = commerceReads(ctx, access), order = last('CommerceOrderObservation', true)!, scope = ctx.state.scope;
  if (order.snapshot.action !== 'ReadCommerceOrder') return commerceDecision(ctx, [commerceStep('read_order', 'ReadCommerceOrder', { scope, order: order.ref })]);
  const payment = ctx.state.observations.filter(r => r.type === 'StripePaymentObservation').at(-1);
  if (!payment) return commerceDecision(ctx, [commerceStep('prepare_payment', 'PrepareStripePayment', { scope, order: order.ref })]);
  const query = access.session.call('query_ontology', { object: payment }) as any;
  const evaluated = access.session.call('evaluate_ontology', { function: 'stripePaymentStatus', object: payment }) as any;
  if (evaluated.status === 'known' && evaluated.value.status === 'prepared') return commerceDecision(ctx, [commerceStep('pay', 'PayStripePayment', { scope, order: order.ref, payment })]);
  if (query.items[0].properties.snapshot.action !== 'ReadStripePayment') return commerceDecision(ctx, [commerceStep('read_payment', 'ReadStripePayment', { scope, order: order.ref, payment })]);
  if (evaluated.status !== 'known' || evaluated.value.status !== 'test_paid') return { ...commerceDecision(ctx), kind: 'no_feasible_plan', message: 'Independent Stripe readback does not confirm an exact unrefunded test capture.' };
  return commerceDecision(ctx, [], { selected: order.ref, order: order.ref, payment, rationale: 'Independent test PaymentIntent and captured charge match the original unpaid order' });
}
export async function setupStripe(options: Parameters<typeof setupCommerce>[0] = {}) {
  const stripe = stripeFixture();
  const commerce = await setupCommerce({ target: 'payment', cart: false, ...options, stripe: stripe.options, choice: options.choice ?? stripeChoice });
  return { ...commerce, stripe, close: async () => { await commerce.close(); stripe.close(); } };
}
