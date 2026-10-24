// Mock provider receipts exercise the production live authority contract. All data
// and model decisions here are synthetic; this test is never live Shopify proof.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { JobStore } from '../../packages/core/store.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { AgentReadError } from '../../packages/core/agent-program.js';
import type { Reasoner } from '../../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../../packages/ontology/agent-actions.js';
import type { ActionDiscoveryPage } from '../../packages/core/action-bindings.js';
import { digest } from '../../packages/core/delegation.js';
import { SHOP_MCP_ENDPOINT, SHOP_MCP_PROTOCOL, checkoutIdempotencyKey, type ShopCheckoutConnector, type ShopTool, type ShopCallResult, type ShopCallContext, type ShopCheckoutInput } from '../../packages/capabilities/shopify/checkout-contracts.js';
import { backend, observeTaskContext, acknowledgeReads, evidence, owner, principal } from '../backend-fixture.js';

export const checkoutMerchant = { id: 'coffee', name: 'Fixture Coffee', shopId: 'gid://shopify/Shop/12', domain: 'coffee.myshopify.com' };
export const checkoutVariant = 'gid://shopify/ProductVariant/34';
export const checkoutInput = { mode: 'prepare', merchantId: 'coffee', items: [{ variantId: checkoutVariant, quantity: 1 }] } satisfies ShopCheckoutInput;

export function checkoutFixture() {
  const calls: { tool: ShopTool; args: Record<string, unknown>; context: ShopCallContext }[] = [];
  const creations = new Map<string, { context: ShopCallContext; args: Record<string, unknown>; result: ShopCallResult }>();
  const checkouts = new Map<string, Record<string, any>>();
  const flags = { available: true, wrongSeller: false, price: 2900, lostCreate: false, journalLost: false, afterCreate: undefined as (() => void) | undefined, wrongItems: false, unsafeUrl: false, before: undefined as ((tool: ShopTool) => Promise<void>) | undefined };
  let creates = 0;
  const result = (tool: ShopTool, args: Record<string, unknown>, context: ShopCallContext, value: unknown): ShopCallResult => {
    const raw = Buffer.from(JSON.stringify(value)), at = new Date().toISOString();
    return { value: structuredClone(value), isError: false, receipt: { id: randomUUID(), endpoint: SHOP_MCP_ENDPOINT, protocolVersion: SHOP_MCP_PROTOCOL, tool, startedAt: at, receivedAt: at, httpStatus: 200, requestDigest: digest(args), responseSha256: createHash('sha256').update(raw).digest('hex'), responseBytes: raw.length,
      ...(tool === 'create_checkout' ? { operationKey: context.operationKey, idempotencyKey: checkoutIdempotencyKey(context.operationKey) } : {}) } };
  };
  const connector: ShopCheckoutConnector = {
    evidenceKind: 'provider',
    async call(tool, args, context, signal) {
      await flags.before?.(tool); signal.throwIfAborted();
      if (tool === 'create_checkout') context.assertDispatchAllowed!();
      calls.push({ tool, args: structuredClone(args), context });
      if (tool === 'lookup_catalog') return result(tool, args, context, { ucp: { version: '2026-08-25' }, products: [{ title: 'Fixture coffee', variants: [{ id: checkoutVariant, title: 'Fixture coffee 12 oz', price: { amount: flags.price, currency: 'USD' }, availability: { available: flags.available }, seller: { id: flags.wrongSeller ? 'gid://shopify/Shop/99' : checkoutMerchant.shopId, domain: checkoutMerchant.domain, name: checkoutMerchant.name }, inputs: [{ id: checkoutVariant, match: 'exact' }] }] }], messages: [] });
      if (tool === 'create_checkout') {
        assert(!creations.has(context.operationKey), 'Creation must never be repeated');
        assert.equal((args.meta as any)['idempotency-key'], checkoutIdempotencyKey(context.operationKey));
        assert.deepEqual(Object.keys(args.checkout as object), ['line_items']);
        creates++;
        const id = `gid://shopify/Checkout/fixture${creates}?key=private-checkout-key`, quantity = (args.checkout as any).line_items[0].quantity;
        const checkout = { ucp: { version: '2026-08-25', payment_handlers: { 'dev.shopify.shop_pay': [{ id: 'shop_pay', config: { shop_id: '12' } }] } }, id, status: 'requires_escalation', currency: 'USD',
          line_items: [{ id: 'line-1', item: { id: flags.wrongItems ? 'gid://shopify/ProductVariant/35' : checkoutVariant, title: 'Fixture coffee 12 oz', price: flags.price }, quantity }],
          totals: [{ type: 'subtotal', amount: flags.price * quantity }, { type: 'total', amount: flags.price * quantity }], payment: { instruments: [] },
          messages: [{ type: 'error', code: 'delivery_address_required', content: 'A destination address is required.', severity: 'recoverable' }],
          continue_url: flags.unsafeUrl ? 'https://untrusted.example/checkouts/123' : `https://shop.app/checkouts/r/fixture${creates}?experience=finalizer`, expires_at: new Date(Date.now() + 86400000).toISOString() };
        checkouts.set(id, checkout);
        const response = result(tool, args, context, checkout);
        creations.set(context.operationKey, { context, args: structuredClone(args), result: response });
        flags.afterCreate?.();
        if (flags.lostCreate) { flags.lostCreate = false; if (flags.journalLost) creations.clear(); throw new AgentReadError('Synthetic lost create response'); }
        return response;
      }
      assert.equal(tool, 'get_checkout'); assert.equal(args.shop, checkoutMerchant.domain);
      const checkout = checkouts.get(String(args.id)); assert(checkout, 'Read the exact original checkout key');
      return result(tool, args, context, checkout);
    },
    originalCreation(context, requestDigest) {
      const found = creations.get(context.operationKey); if (!found) return;
      assert.equal(found.context.ownerDigest, context.ownerDigest); assert.equal(found.context.requestId, context.requestId); assert.equal(found.context.intentId, context.intentId); assert.equal(digest(found.args), requestDigest);
      return structuredClone(found.result);
    },
  };
  return { connector, calls, flags, checkouts, countCreates: () => creates };
}

export function setupCheckout(options: { allowExternalDrafts?: boolean; store?: JobStore; staleCompletion?: boolean } = {}) {
  const f = checkoutFixture(), store = options.store ?? new JobStore(':memory:'), inputs = new Map<string, ShopCheckoutInput>();
  const catalog = createExecutionCatalog({ store, shopifyCheckout: { merchants: [checkoutMerchant], connector: f.connector } });
  const model: Reasoner = {
    ground: async (request, _capabilities, _signal, access) => {
      observeTaskContext(access); const input = inputs.get(request.id)!;
      const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'Synthetic fixed checkout goal', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify([{ id: 'checkout_result', predicate: input.mode === 'prepare' ? 'shopify.checkout.unpaid_prepared' : 'shopify.checkout.status_observed', phase: 'fact', description: request.originalGoal, messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: ['no_purchase'] }]) };
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
    plan: async () => { throw new Error('No legacy fixed workflow'); },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access);
      const pin = (actionId: string) => (access.session.call('discover_actions', { actionId }) as ActionDiscoveryPage).items[0]!.bindings.find(binding => binding.readiness === 'ready')!.pin;
      const base: AgentDecision = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Synthetic decision after source reads', steps: [], completionJson: '' };
      const input = inputs.get(ctx.request.id)!; let decision: AgentDecision;
      if (!ctx.state.composition!.contexts.length) decision = { ...base, kind: 'prepare', contexts: [{ id: 'checkout', bindingDigest: pin(input.mode === 'prepare' ? 'ReadShopifyCheckoutProducts' : 'ReadShopifyCheckout').digest, inputJson: JSON.stringify(input) }] };
      else {
        const component = ctx.state.composition!.contexts[0]!, scope = component.scope;
        const scopeRead = access.session.call('query_ontology', { object: scope }) as any;
        const observations = ctx.state.observations.map(ref => {
          access.session.call('query_ontology', { object: ref });
          const evaluated = access.session.call('evaluate_ontology', { function: 'shopifyCheckoutObservationStatus', object: ref }) as any;
          return { ref, evaluated, action: evaluated.value?.action };
        });
        const readbacks = observations.filter(value => value.action === 'ReadShopifyCheckout');
        const read = options.staleCompletion ? (readbacks.length >= 2 ? readbacks[0] : undefined) : readbacks.at(-1);
        if (read) decision = { ...base, kind: 'complete', completionJson: JSON.stringify({ components: [{ contextId: 'checkout', proposalJson: JSON.stringify({ checkout: read.ref }) }], criteria: [{ id: 'checkout_result', contextIds: ['checkout'] }], conditions: [] }) };
        else {
          const created = observations.find(value => value.action === 'CreateShopifyCheckout'), products = observations.find(value => value.ref.type === 'ShopifyCheckoutProducts');
          let action: string, args: Record<string, unknown>;
          if (input.mode === 'status') {
            assert(scopeRead.items[0].properties.sourceCheckout);
            action = 'ReadShopifyCheckout'; args = { scope };
          } else if (created) { action = 'ReadShopifyCheckout'; args = { scope, checkout: created.ref }; }
          else if (products) { action = 'CreateShopifyCheckout'; args = { scope, products: products.ref }; }
          else { action = 'ReadShopifyCheckoutProducts'; args = { scope }; }
          decision = { ...base, steps: [{ id: `step${ctx.state.plans.length}`, action, argumentsJson: JSON.stringify(args), dependsOn: [], inputRefs: [], contextId: 'checkout', bindingDigest: pin(action).digest, contributesTo: ['checkout_result'] }] };
        }
      }
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
  };
  const b = backend(catalog, model, store, { allowExternalDrafts: options.allowExternalDrafts ?? true });
  const submit = (input: ShopCheckoutInput = checkoutInput) => {
    const job = b.submit({ goal: input.mode === 'prepare' ? 'Prepare one selected coffee item in an unpaid checkout and return its original link and readback. Do not order or pay.' : `Read the original checkout from task ${input.sourceTaskId} without creating or paying.`, requirements: [{ id: 'no_purchase', kind: 'condition', strength: 'hard', expected: { predicate: 'shopify.checkout.no_purchase' } }] });
    inputs.set(job.id, input); return job;
  };
  const run = async () => { const claim = store.claim(['eigos.delegate'], 60000); if (!claim) return false; await b.coordinator.run(claim, new AbortController().signal); return true; };
  const finish = async (id: string) => {
    for (let n = 0; n < 100; n++) { const job = store.get(owner, id); if (!['working', 'submitted'].includes(job.state)) return job; if (!await run()) await delay(50); }
    throw new Error(`Checkout task did not settle: ${JSON.stringify(store.get(owner, id).delegation?.agent?.feedback)}`);
  };
  const approve = (id: string, changes: Record<string, unknown> = {}) => {
    const request = store.get(owner, id).delegation!.authorizationRequest!; assert.equal(request.kind, 'external_draft');
    if (request.kind !== 'external_draft') throw new Error('Expected exact draft authorization');
    return b.tasks.authorize(principal, id, { requestId: randomUUID(), action: 'approve_external_draft', planDigest: request.planDigest, draft: request.draft, environment: 'live', expiresAt: request.draft.sourceExpiresAt, ...changes });
  };
  return { ...f, b, store, catalog, model, submit, run, finish, approve, inputs };
}
