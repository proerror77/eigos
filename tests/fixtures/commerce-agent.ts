// Synthetic model decisions against a separate signed HTTP business simulator.
// Actual PA and LLM execution is verified by a separate end-to-end observer.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createCommerceSandboxProvider, type CommerceSandboxScenario } from '../../packages/capabilities/commerce-sandbox/provider.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { JobStore } from '../../packages/core/store.js';
import { digest } from '../../packages/core/delegation.js';
import { backend, evidence, interpretation, owner, principal } from '../backend-fixture.js';
import type { AgentPlanningContext, PlanningAccess, Reasoner } from '../../packages/coordinator/coordinator.js';
import type { AgentDecision, AgentStep } from '../../packages/ontology/agent-actions.js';
import type { CommerceObservation, CommerceEntityType } from '../../packages/ontology/commerce-journey.js';
import { commerceDestinationChoice } from '../../packages/ontology/commerce-journey-functions.js';
import type { Job } from '../../packages/core/domain.js';
import type { ObjectRef } from '../../packages/ontology/model.js';

export const commerceStep = (id: string, action: string, args: object, dependsOn: string[] = [], inputRefs: AgentStep['inputRefs'] = []): AgentStep => ({ id, action, argumentsJson: JSON.stringify(args), dependsOn, inputRefs });
export const commerceDecision = (ctx: AgentPlanningContext, steps: AgentStep[] = [], result?: unknown): AgentDecision => ({ kind: result ? 'complete' : 'execute', requestRevision: ctx.request.revision, message: 'Synthetic decision from currently observed commerce facts', steps, completionJson: result ? JSON.stringify(result) : '' });
export function commerceReads(ctx: AgentPlanningContext, access: PlanningAccess) {
  access.session.call('describe_ontology', { search: 'CommerceTask', limit: 1 });
  access.session.call('query_ontology', { object: ctx.state.scope });
  const cache = new Map<string, { ref: ObjectRef; snapshot: CommerceObservation; assessment?: { status: string; gaps: { fact: string }[] } }>();
  const read = (ref: ObjectRef, evaluate = false) => {
    let value = cache.get(ref.id);
    if (!value) { const query = access.session.call('query_ontology', { object: ref }) as { items: { properties: { snapshot: CommerceObservation } }[] }; value = { ref, snapshot: query.items[0]!.properties.snapshot }; cache.set(ref.id, value); }
    if (evaluate && !value.assessment) { const r = access.session.call('evaluate_ontology', { function: 'commerceObservationStatus', object: ref }) as { status: string; value?: { assessment: { status: string; gaps: { fact: string }[] } }; reason?: string }; value.assessment = r.status === 'known' ? r.value!.assessment : { status: 'unknown', gaps: [{ fact: r.reason ?? 'source_unknown' }] }; }
    return value;
  };
  const last = (type: CommerceEntityType, evaluate = false) => { const ref = ctx.state.observations.filter(r => r.type === type).at(-1); return ref ? read(ref, evaluate) : undefined; };
  return { read, last };
}
export function commerceChoice(options: { target?: 'quote' | 'cart' | 'checkout' | 'order' | 'delivery'; optionId?: string; cart?: boolean } = {}) {
  return (ctx: AgentPlanningContext, access: PlanningAccess): AgentDecision => {
    const { last } = commerceReads(ctx, access), scope = ctx.state.scope, target = options.target ?? 'delivery';
    const existingOrder = last('CommerceOrderObservation', true);
    if (existingOrder) {
      if (existingOrder.snapshot.action !== 'ReadCommerceOrder') return commerceDecision(ctx, [commerceStep('read_order', 'ReadCommerceOrder', { scope, order: existingOrder.ref })]);
      if (target === 'order') return commerceDecision(ctx, [], { selected: existingOrder.ref, order: existingOrder.ref, rationale: 'Independent original order read' });
      const payment = last('CommercePaymentObservation', true), delivery = last('CommerceDeliveryObservation', true), cart = options.cart === false ? undefined : last('Cart', true);
      if (!payment || !delivery) return commerceDecision(ctx, [...(!payment ? [commerceStep('payment', 'ReadCommercePayment', { scope, order: existingOrder.ref })] : []), ...(!delivery ? [commerceStep('delivery', 'ReadCommerceDelivery', { scope, order: existingOrder.ref })] : [])]);
      return commerceDecision(ctx, [], { selected: existingOrder.ref, ...(cart ? { cart: cart.ref } : {}), order: existingOrder.ref, payment: payment.ref, delivery: delivery.ref, rationale: 'Independent original order, separate payment and exact package events' });
    }
    const context = target === 'cart' ? undefined : last('FulfillmentContext', true), directory = last('CommerceMerchantSearch');
    if ((!context && target !== 'cart') || !directory) return commerceDecision(ctx, [...(!context && target !== 'cart' ? [commerceStep('context', 'ReadCommerceContext', { scope })] : []), ...(!directory ? [commerceStep('directory', 'SearchCommerceMerchants', { scope, query: 'coffee' })] : [])]);
    if (context && context.assessment?.status !== 'satisfied') return { ...commerceDecision(ctx), kind: 'clarify', message: '请选择家庭地址或工作地址；请以 destination 位置条件返回所选标签。', informationRequest: { fact: 'destination_choice', evidenceRefs: [context.ref] } };
    const product = last('CommerceProduct'), inventory = target === 'cart' ? undefined : last('InventoryObservation', true);
    if (!product) return commerceDecision(ctx, [commerceStep('product', 'ReadCommerceProduct', { scope, discovery: directory!.ref, merchantId: 'harbor-cn', query: 'coffee' })]);
    if (target !== 'cart' && (!inventory || inventory.snapshot.data.variantId !== product.snapshot.data.variantId)) return commerceDecision(ctx, [commerceStep('inventory', 'ReadCommerceInventory', { scope, product: product.ref, quantity: 2 })]);
    if (inventory?.assessment?.status !== 'satisfied' && target !== 'cart') {
      if (product.snapshot.data.merchantId === 'harbor-cn') return commerceDecision(ctx, [commerceStep('alternative', 'ReadCommerceProduct', { scope, discovery: directory!.ref, merchantId: 'cedar-ca', query: 'coffee' })]);
      return { ...commerceDecision(ctx), kind: 'no_feasible_plan', message: 'The bounded sandbox merchant directory has no evidenced capacity for this request.' };
    }
    let quote: ReturnType<typeof last>;
    if (target !== 'cart') {
      const fulfillment = last('FulfillmentPlan');
      if (!fulfillment) { const chosen = commerceDestinationChoice(context!.snapshot.data as never, ctx.request.requirements)!; return commerceDecision(ctx, [commerceStep('route', 'ReadCommerceFulfillment', { scope, product: product.ref, inventory: inventory!.ref, context: context!.ref, addressId: chosen.id, quantity: 2 })]); }
      const optionId = options.optionId ?? (fulfillment.snapshot.data.options as { id: string }[])[0]!.id, customs = last('CustomsAssessment', true);
      if (!customs) return commerceDecision(ctx, [commerceStep('customs', 'ReadCommerceCustoms', { scope, product: product.ref, fulfillment: fulfillment.ref, optionId })]);
      if (customs.assessment?.status !== 'satisfied') return { ...commerceDecision(ctx), kind: 'no_feasible_plan', message: 'The selected sandbox route lacks resolved import eligibility.' };
      quote = last('LandedCostQuote', true);
      if (!quote) return commerceDecision(ctx, [commerceStep('quote', 'QuoteCommerceLandedCost', { scope, product: product.ref, inventory: inventory!.ref, fulfillment: fulfillment.ref, optionId, customs: customs.ref })]);
      if (quote.assessment?.status !== 'satisfied') return { ...commerceDecision(ctx), kind: 'no_feasible_plan', message: 'The observed sandbox quote does not establish bounded cost and required delivery terms.' };
      if (target === 'quote') return commerceDecision(ctx, [], { selected: quote.ref, rationale: 'Complete source quote evaluated' });
    }
    const cart = options.cart === false ? undefined : last('Cart', target === 'cart');
    if (!cart && options.cart !== false) return commerceDecision(ctx, [commerceStep('cart', 'CreateCommerceCart', { scope, product: product.ref, quantity: 2 })]);
    if (target === 'cart') return commerceDecision(ctx, [], { selected: cart!.ref, rationale: 'Owned draft exists without purchase' });
    const checkout = last('CommerceCheckout', true);
    if (!checkout) return commerceDecision(ctx, [commerceStep('checkout', 'PrepareCommerceCheckout', { scope, quote: quote!.ref, ...(cart ? { cart: cart.ref } : {}) })]);
    if (target === 'checkout') return commerceDecision(ctx, [], { selected: checkout.ref, rationale: 'Exact sandbox checkout prepared' });
    return commerceDecision(ctx, [commerceStep('submit', 'SubmitCommerceOrder', { scope, checkout: checkout.ref })]);
  };
}
export async function setupCommerce(options: { scenario?: CommerceSandboxScenario; target?: 'quote' | 'cart' | 'checkout' | 'order' | 'delivery'; optionId?: string; cart?: boolean; choice?: (ctx: AgentPlanningContext, access: PlanningAccess) => AgentDecision; databasePath?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-commerce-test-')), provider = await createCommerceSandboxProvider({ scenario: { ambiguousAddress: false, ...options.scenario } }), tokenFile = join(directory, 'token');
  writeFileSync(tokenFile, provider.token, { mode: 0o600 });
  const store = new JobStore(options.databasePath ?? ':memory:'), settings = { endpoint: provider.endpoint, tokenFile, auditDirectory: join(directory, 'http') }, catalog = createExecutionCatalog({ store, commerceSandbox: settings });
  const diagnostics: { stage: string; action: string; error: string }[] = [], program = catalog.agentProgram({ id: 'commerce.journey.sandbox', version: '1' }, owner)!;
  const invoke=program.invoke.bind(program),project=program.project.bind(program),recover=program.recover!.bind(program);
  const diagnostic=(stage:string,action:string,error:unknown)=>diagnostics.push({stage,action,error:(error instanceof Error?`${error.name}: ${error.message}`:String(error)).replaceAll(provider.token,'[redacted]').slice(0,2000)});
  program.invoke=async(...args)=>{try{return await invoke(...args);}catch(error){diagnostic('invoke',args[1],error);throw error;}};
  program.project=(...args)=>{try{return project(...args);}catch(error){diagnostic('project',args[1],error);throw error;}};
  program.recover=async(...args)=>{try{return await recover(...args);}catch(error){diagnostic('recover',args[1],error);throw error;}};
  const choice = options.choice ?? commerceChoice(options);
  const model: Reasoner = { ground: async request => ({ decision: { ...interpretation(request, 'commerce.journey.sandbox', { query: 'coffee', quantity: 2, contextKey: null, target: options.target ?? 'delivery' }), capabilityRef: { id: 'commerce.journey.sandbox', version: '1' } }, evidence: evidence() }), plan: async () => { throw new Error('Legacy preparation must not run'); }, act: async (ctx, _signal, access) => { const decision = choice(ctx, access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } }; } };
  const b = backend(catalog, model, store, { allowSandbox: true });
  const submit = () => b.submit({ goal: '在沙箱选择能供两袋整豆咖啡的商家并完成所需交易阶段；先查询保存的地址和跨境信息。', executionEnvironment: 'sandbox', requirements: [{ id: 'quantity', kind: 'quantity', role: 'item_quantity', strength: 'hard', expected: { amount: '2', unit: 'piece' } }, ...(options.target === 'cart' ? [] : [{ id: 'budget', kind: 'budget', role: 'service_total', strength: 'hard', expected: { minor: '50000', currency: 'CNY' } }, { id: 'arrival', kind: 'deadline', role: 'arrival', strength: 'hard', expected: { at: new Date(Date.now() + 7 * 86400000).toISOString(), timezone: 'UTC', original: 'within seven days' } }]), { id: 'sandbox', kind: 'condition', strength: 'hard', expected: { predicate: 'commerce.sandbox_only' } }] });
  const approve = (job: Job, effects = job.delegation!.authorizationRequest!.effects) => { const a = job.delegation!.authorizationRequest!; return b.tasks.authorize(principal, job.id, { requestId: randomUUID(), action: 'approve_plan', planDigest: a.planDigest, allowedEffects: effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }); };
  const finish = async (id: string, autoApprove = true) => {
    const deadline = Date.now() + 120000;
    let work = 0;
    while (Date.now() < deadline && work < 80) {
      const job = store.get(owner, id);
      if (job.state === 'auth-required' && autoApprove) { approve(job); work++; continue; }
      if (!['working', 'submitted'].includes(job.state)) return job;
      const claim = store.claim(['eigos.delegate'], 15000);
      if (!claim) {
        // Timers can wake slightly before nextAt, especially on a busy runner.
        // A healthy queued task is not a missing/failed execution attempt.
        await pause(Math.min(100, Math.max(5, (job.delegation?.nextAt ?? 0) - Date.now())));
        continue;
      }
      work++;
      try { await b.coordinator.run(claim, new AbortController().signal); }
      finally { store.release(claim); }
    }
    throw new Error('Commerce fixture did not settle within its bounded execution wait');
  };
  return { provider, directory, tokenFile, settings, store, catalog, b, model, submit, approve, finish, diagnostics, close: async () => { store.close(); await provider.close(); rmSync(directory, { recursive: true, force: true }); } };
}
