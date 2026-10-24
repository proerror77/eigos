import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { JobStore } from '../../packages/core/store.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { createShopifyPASandbox, SHOPIFY_TEST_MERCHANT, SHOPIFY_TEST_VARIANT } from '../../packages/capabilities/shopify/pa-checkout-sandbox.js';
import { SHOPIFY_PA_REF, type ShopifyPAEntity, type ShopifyPASnapshot } from '../../packages/capabilities/shopify/pa-checkout-contracts.js';
import { paCheckoutPaymentRequestSchema, paCheckoutSelectionSchema, type PAHandoffRequest, type PAHandoffSelection } from '../../packages/core/pa-payment.js';
import { digest } from '../../packages/core/delegation.js';
import type { AgentPlanningContext, PlanningAccess, Reasoner } from '../../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../../packages/ontology/agent-actions.js';
import type { Job } from '../../packages/core/domain.js';
import { backend, evidence, interpretation, owner, principal, observeTaskContext, acknowledgeReads } from '../backend-fixture.js';
import { commerceDecision as decision, commerceStep as step } from './commerce-agent.js';

export const shopifyPaymentInput = { merchantId: SHOPIFY_TEST_MERCHANT.id, items: [{ variantId: SHOPIFY_TEST_VARIANT, quantity: 1 }] };
export function shopifyPaymentChoice(ctx: AgentPlanningContext, access: PlanningAccess): AgentDecision {
  observeTaskContext(access); access.session.call('query_ontology', { object: ctx.state.scope });
  const last = (type: ShopifyPAEntity) => {
    const ref = ctx.state.observations.filter(value => value.type === type).at(-1); if (!ref) return;
    const read = access.session.call('query_ontology', { object: ref }) as { items: { properties: { snapshot: ShopifyPASnapshot } }[] };
    const status = access.session.call('evaluate_ontology', { function: 'shopifyPAPaymentStatus', object: ref }) as { status: string; value?: Record<string, any> };
    return { ref, snapshot: read.items[0]!.properties.snapshot, status: status.status === 'known' ? status.value : undefined };
  };
  const scope = ctx.state.scope, checkout = last('ShopifyPaymentCheckoutObservation');
  if (!checkout) {
    const products = last('ShopifyPaymentProducts');
    if (!products) return decision(ctx, [step('products', 'ReadShopifyPaymentProducts', { scope })]);
    if (!(products.snapshot.payload.data.items as { available: boolean }[]).every(value => value.available)) return { ...decision(ctx), kind: 'no_feasible_plan', message: 'The selected test products are unavailable.' };
    return decision(ctx, [step('create', 'CreateShopifyPaymentCheckout', { scope, products: products.ref })]);
  }
  if (!checkout.snapshot.payload.data.independentRead) return decision(ctx, [step('read_checkout', 'ReadShopifyPaymentCheckout', { scope, checkout: checkout.ref })]);
  const payment = last('ShopifyCheckoutPaymentObservation');
  if (!ctx.state.paPayment) {
    if (!payment) return decision(ctx, [step('read_unpaid', 'ReadShopifyCheckoutPayment', { scope, checkout: checkout.ref })]);
    if (!checkout.status?.readyForPayment || payment.snapshot.payload.data.state !== 'unpaid') return { ...decision(ctx), kind: 'no_feasible_plan', message: 'The original checkout is not independently verified unpaid.' };
    return decision(ctx, [step('handoff', 'RequestShopifyPAPayment', { scope, checkout: checkout.ref, payment: payment.ref })]);
  }
  const sequence = ctx.state.paPayment.readbackSequence;
  const needCheckout = checkout.snapshot.receipt.readbackSequence !== sequence, needPayment = !payment || payment.snapshot.receipt.readbackSequence !== sequence;
  if (needCheckout || needPayment) return decision(ctx, [
    ...(needCheckout ? [step('read_checkout', 'ReadShopifyPaymentCheckout', { scope, checkout: checkout.ref })] : []),
    ...(needPayment ? [step('read_payment', 'ReadShopifyCheckoutPayment', { scope, checkout: checkout.ref })] : []),
  ]);
  if (checkout.status?.status === 'canceled' || payment.snapshot.payload.data.state === 'refunded') return { ...decision(ctx), kind: 'no_feasible_plan', message: 'The source reports the original test checkout canceled or payment refunded.' };
  if (checkout.status?.status === 'completed' && payment.status?.paid) return decision(ctx, [], { checkout: checkout.ref, payment: payment.ref, rationale: 'Separate exact merchant order and original PA payment readbacks' });
  return decision(ctx, [step('wait', 'WaitForShopifyPAPayment', { scope, checkout: checkout.ref, payment: payment.ref })]);
}

/** Independent PA fixture. Its credential never enters the EIGOS configuration. */
export class FixtureCheckoutPA {
  readonly operations = new Map<string, string>();
  constructor(readonly endpoint: string, private credential: string) {}
  async pay(raw: PAHandoffRequest, selected: PAHandoffSelection, approvedAmount = raw.terms.amount) {
    const handoff = paCheckoutPaymentRequestSchema.parse(raw), selection = paCheckoutSelectionSchema.parse(selected);
    const { digest: expected, ...body } = handoff, { digest: selectedDigest, ...selectionBody } = selection;
    assert.equal(digest(body), expected); assert.equal(digest(selectionBody), selectedDigest); assert.equal(selection.handoffDigest, expected);
    assert(handoff.terms.routes.some(route => route.id === selection.route && route.supported && route.endpoint === this.endpoint + '/pa/payments'));
    assert(!this.operations.has(handoff.id), 'A prior PA dispatch must be recovered by query, never pay again');
    this.operations.set(handoff.id, selection.operationId);
    const instrument = selection.route === 'pa_vault' ? { type: 'test_card', number: '4242424242424242', expiry: '12/30', cvc: '123' } : { type: 'test_account', id: 'pa-test-account' };
    const response = await fetch(this.endpoint + '/pa/payments', { method: 'POST', headers: { authorization: `Bearer ${this.credential}`, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ handoff, selection, approvedAmount, instrument }), redirect: 'error' });
    if (!response.ok) throw new Error(`Test PA payment rejected (${response.status})`);
    return response.json() as Promise<{ state: string }>;
  }
  async query(operationId: string) {
    const response = await fetch(this.endpoint + '/pa/payments/' + encodeURIComponent(operationId), { headers: { authorization: `Bearer ${this.credential}`, connection: 'close' }, redirect: 'error' });
    if (!response.ok) throw new Error(`Original PA operation unavailable (${response.status})`);
    return response.json() as Promise<{ state: string }>;
  }
}
export async function setupShopifyPayment(options: { databasePath?: string; provider?: Awaited<ReturnType<typeof createShopifyPASandbox>>; holdMs?: number; choice?: (ctx: AgentPlanningContext, access: PlanningAccess) => AgentDecision } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-shopify-pa-')), provider = options.provider ?? await createShopifyPASandbox({ holdMs: options.holdMs });
  const tokenFile = join(directory, 'source-token'); writeFileSync(tokenFile, provider.sourceToken, { mode: 0o600 });
  const settings = { endpoint: provider.endpoint, tokenFile }, store = new JobStore(options.databasePath ?? ':memory:'), catalog = createExecutionCatalog({ store, shopifyPaymentSandbox: settings });
  const model: Reasoner = { ground: async (request, _caps, _signal, access) => ({ decision: { ...interpretation(observeTaskContext(access) ?? request, SHOPIFY_PA_REF.id, shopifyPaymentInput), capabilityRef: SHOPIFY_PA_REF }, evidence: evidence() }),
    plan: async () => { throw new Error('Legacy fixed checkout workflow must not run'); }, act: async (ctx, _signal, access) => { const selected = (options.choice ?? shopifyPaymentChoice)(ctx, access); acknowledgeReads(access); return { decision: selected, evidence: { ...evidence(), decisionDigest: digest(selected) } }; } };
  const b = backend(catalog, model, store, { allowSandbox: true }), pa = new FixtureCheckoutPA(provider.endpoint, provider.paToken);
  const submit = (extra: object = {}) => b.submit({ goal: '在隔离 Shopify 测试环境购买一件测试咖啡，预算 1 美元。把原结账交给我的 PA 使用它自己的测试 Vault 或支付账户付款，再独立确认同一笔订单与付款；不要真实付款。', executionEnvironment: 'sandbox', requirements: [
    { id: 'quantity', kind: 'quantity', role: 'item_quantity', strength: 'hard', expected: { amount: '1', unit: 'piece' } },
    { id: 'budget', kind: 'budget', role: 'service_total', strength: 'hard', expected: { minor: '100', currency: 'USD' } },
    { id: 'order', kind: 'condition', strength: 'hard', expected: { predicate: 'shopify.pa.order_confirmed' } },
    { id: 'paid', kind: 'condition', strength: 'hard', expected: { predicate: 'shopify.pa.payment_confirmed' } },
  ], ...extra });
  const approve = (job: Job) => { const a = job.delegation!.authorizationRequest!; return b.tasks.authorize(principal, job.id, { requestId: randomUUID(), action: 'approve_plan', planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 300000).toISOString(), environment: 'sandbox' }); };
  const report = (job: Job, outcome: 'submitted' | 'unknown' | 'declined' | 'canceled' = 'submitted', requestId = randomUUID()) => { const request = job.delegation!.agent!.paPayment!.request; return b.tasks.reportPayment(principal, { action: 'report_payment_result', taskId: job.id, requestId, handoffId: request.id, handoffDigest: request.digest, outcome }); };
  const select = (job: Job, route: 'pa_vault' | 'pa_payment_account' = 'pa_vault', requestId = randomUUID()) => { const request = job.delegation!.agent!.paPayment!.request; return b.tasks.selectPaymentRoute(principal, { action: 'select_payment_route', taskId: job.id, requestId, handoffId: request.id, handoffDigest: request.digest, capability: { route, status: 'available', environment: 'sandbox', observedAt: new Date().toISOString() } }); };
  const finish = async (id: string, autoApprove = true) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const job = store.get(owner, id); if (job.state === 'auth-required' && autoApprove) { approve(job); continue; }
      if (!['working', 'submitted'].includes(job.state)) return job;
      const claim = store.claim(['eigos.delegate'], 60000); if (!claim) { await delay(20); continue; }
      try { await b.coordinator.run(claim, new AbortController().signal); } finally { store.release(claim); }
    }
    throw new Error(`Shopify payment fixture did not settle: ${JSON.stringify(store.get(owner, id).delegation?.agent?.feedback)}`);
  };
  return { directory, provider, settings, store, catalog, model, b, pa, submit, approve, select, report, finish,
    close: async () => { store.close(); if (!options.provider) await provider.close(); rmSync(directory, { recursive: true, force: true }); } };
}
