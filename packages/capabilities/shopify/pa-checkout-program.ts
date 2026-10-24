import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError, type Job } from '../../core/domain.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../../core/agent-program.js';
import { objectResultProjection } from '../../core/composed-actions.js';
import type { Delivery } from '../../core/catalog.js';
import { objectRefSchema, type ObjectRef } from '../../ontology/model.js';
import type { OntologyObjectStore } from '../../ontology/object-store.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import type { AgentDecision } from '../../ontology/agent-actions.js';
import type { ServiceCapability, ServiceRequest } from '../../ontology/execution.js';
import { paCheckoutPaymentRequestSchema, recordPAPaymentHandoff, verifyPAPaymentSelection, type PACheckoutPaymentTerms, type PAPaymentState } from '../payment-handoff.js';
import { shopifyPAActionSchemas, shopifyPAActionMetadata, shopifyPACompletionSchema, type ShopifyPAAction } from '../../ontology/shopify-pa-payment.js';
import { readShopifyPAObservation, projectShopifyPAObservation } from '../../ontology/shopify-pa-payment-functions.js';
import { SHOPIFY_PA_REF, shopifyPAInputSchema, shopifyPAProductsSchema, shopifyPACheckoutSchema, shopifyPAPaymentSchema,
  shopifyPATermsDigest, type ShopifyPACheckout, type ShopifyPASourceResult } from './pa-checkout-contracts.js';
import { ShopifyPASandboxConnector, type ShopifyPASandboxOptions } from './pa-checkout-connector.js';

const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
export class ShopifyPAPaymentProgram implements AgentProgram {
  readonly ref = SHOPIFY_PA_REF;
  readonly actionIds = Object.keys(shopifyPAActionSchemas);
  readonly limits = { modelTurns: 48, plans: 20, actions: 32 };
  readonly completionSchema = z.toJSONSchema(shopifyPACompletionSchema);
  readonly connector: ShopifyPASandboxConnector;
  readonly configurationDigest: string;
  readonly guidance = [
    'This is an isolated Shopify contract simulator. All merchant, checkout, payment and order evidence is synthetic, testMode=true, realPayment=false. No live Shopify or payment account is connected. EIGOS has no PA wallet or card credential and no payment action.',
    'Read the owned scope and current Ontology facts before choosing atomic actions. ReadShopifyPaymentProducts establishes the selected native variant IDs, quantities and complete price. Evaluate shopifyPAPaymentStatus before CreateShopifyPaymentCheckout, which requires a separate exact reservation grant with zero payment spend. Create at most one unpaid checkout. Uncertain creation results require original-operation recovery, never replacement.',
    'Independently read the original checkout AND its separate unpaid payment before RequestShopifyPAPayment. Evaluate both in this decision. The checkout must be ready, unexpired, have a final total and no order; the payment must still be unpaid and unattempted. This local action publishes a version-3 immutable handoff and pauses.',
    'The user Personal Agent keeps its own payment authority. It chooses a supported pa_vault or pa_payment_account capability using select_payment_route, then uses its own isolated test payment executor. EIGOS must not request cards, account tokens or credentials. Payment-route selection grants no new spending authority.',
    'After the handoff, only read the original checkout/payment and wait locally. A payment report is unverified and wakes this same task. Read BOTH observations freshly for the current readbackSequence after each report or reconcile; a redirect, PA statement or checkout ID does not prove payment.',
    'If payment or order is unresolved, evaluate both and use WaitForShopifyPAPayment, keeping the original request and operation ID. A submitted, failed, timed out or unknown attempt never authorizes another payment or a route switch. If the source proves cancellation or refund, report that bounded outcome.',
    'Complete only after the merchant independently confirms the original checkout is completed, the same order is confirmed, and the original PA operation is paid for the exact currency, amount, payee and terms. Evaluate both source refs before completion. This proves an isolated test order and test payment, never fulfillment or real commerce.',
  ].join('\n');
  constructor(options: ShopifyPASandboxOptions) { this.connector = new ShopifyPASandboxConnector(options); this.configurationDigest = digest({ source: this.connector.configurationDigest, semantics: 'shopify-pa-owned-checkout-v1' }); }
  permitted(owner: string) { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  capability(): ServiceCapability {
    const predicates = ['shopify.pa.sandbox_only', 'shopify.pa.order_confirmed', 'shopify.pa.payment_confirmed'];
    return { ref: this.ref, ontologyRef: { id: 'shopify.pa-checkout', version: '1' }, name: 'Shopify 测试结账交给 PA 付款并独立确认',
      description: '在隔离 Shopify 合约模拟器中，创建一次选定商品的未付款结账，交给用户 PA 的测试 Vault 或测试支付账户付款，再独立回读原付款和订单。无真实 Shopify 商店、真实扣款或履约。',
      tags: ['shopify', 'checkout', 'pa-payment', 'vault', 'sandbox'], environment: 'sandbox', inputSchema: z.toJSONSchema(shopifyPAInputSchema), constraintEvaluation: 'staged',
      actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: shopifyPAActionMetadata[id as ShopifyPAAction].effect })),
      predicates: predicates.map(id => ({ id, description: id })), outcomePredicates: predicates,
      goalOutcomes: [{ predicate: predicates[0]!, phase: 'fact', description: 'Only isolated synthetic merchant and payment operations' }, { predicate: predicates[1]!, phase: 'commitment', description: 'Independent confirmation of the original test checkout order' }, { predicate: predicates[2]!, phase: 'payment', description: 'Independent exact payment readback for the PA original test operation' }],
      completion: 'domain', verifierRef: { id: 'shopify.pa-checkout.independent', version: '1' },
      requirementRoles: [{ kind: 'quantity', role: 'item_quantity', description: 'Sum of selected checkout line-item quantities in pieces' }, { kind: 'budget', role: 'service_total', description: 'Complete test purchase amount including every mandatory fee' }, { kind: 'deadline', role: 'completion', description: 'Deadline for test payment and order confirmation' }],
      ontology: { objects: ['ShopifyPaymentTask', 'ShopifyPaymentProducts', 'ShopifyPaymentCheckoutObservation', 'ShopifyCheckoutPaymentObservation', 'PAPaymentRequest'], functions: ['shopifyPAPaymentStatus'], paymentAuthority: 'pa_owned', realSourceConnected: false } };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown, component?: { id: string; scopeKey: string }) {
    if (!this.permitted(owner) || request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'Shopify PA checkout is isolated-test only');
    const input = shopifyPAInputSchema.parse(raw), scope = { type: 'ShopifyPaymentTask', id: digest({ request: request.id, revision: request.revision, input, component: component?.scopeKey }) };
    const count = input.items.reduce((sum, item) => sum + item.quantity, 0);
    for (const requirement of request.requirements) if (requirement.strength === 'hard' && requirement.kind === 'quantity' && (!requirement.role || requirement.role === 'item_quantity') && (requirement.expected.unit !== 'piece' || requirement.expected.amount !== String(count))) fail('Checkout item quantity differs from the user request');
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: 'Shopify 测试结账与 PA 自有支付能力', requestRevision: request.revision, input, configurationDigest: this.configurationDigest, allowedActions: this.actionIds } }], links: [{ type: 'ShopifyPaymentTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  schema(action: string) { if (!Object.hasOwn(shopifyPAActionSchemas, action)) throw new DomainError('FORBIDDEN', 'Unknown Shopify test action; EIGOS cannot pay'); return shopifyPAActionSchemas[action as ShopifyPAAction]; }
  definition(graph: OntologyObjectStore, action: string) {
    const definition = graph.model.action(action), operation = definition.read ?? definition.operation;
    if (!operation || !same(operation.inputSchema, z.toJSONSchema(this.schema(action))) || operation.effect !== shopifyPAActionMetadata[action as ShopifyPAAction].effect) fail('Checkout action differs from its published contract');
    return definition;
  }
  private scope(ctx: AgentProgramContext) {
    const record = ctx.graph.read(ctx.owner, ctx.state.scope);
    if (!this.permitted(ctx.owner) || ctx.request.executionEnvironment !== 'sandbox' || !same(ctx.state.programRef, this.ref) || ctx.state.programDigest !== this.configurationDigest
      || record.ref.type !== 'ShopifyPaymentTask' || record.properties.configurationDigest !== this.configurationDigest || record.properties.requestRevision !== ctx.request.revision
      || ctx.state.requestRevision !== ctx.request.revision || !same(record.properties.input, ctx.state.input) || !same(record.properties.allowedActions, this.actionIds)) fail('Shopify checkout owner, scope or source configuration changed');
    const parents = ctx.graph.related(ctx.owner, record.ref, 'request', { remaining: 1000 });
    if (parents?.length !== 1 || parents[0]!.ref.id !== ctx.request.id) fail('Checkout scope belongs to another request');
    if (ctx.state.paPayment) {
      const request = paCheckoutPaymentRequestSchema.parse(ctx.state.paPayment.request), { digest: expected, ...body } = request;
      const ref = { type: 'PAPaymentRequest', id: request.id }, stored = ctx.graph.read(ctx.owner, ref);
      if (digest(body) !== expected || request.ownerDigest !== digest(ctx.owner) || request.taskId !== ctx.request.id || request.requestRevision !== ctx.request.revision
        || request.configurationDigest !== this.configurationDigest || stored.properties.configurationDigest !== this.configurationDigest || stored.properties.requestRevision !== ctx.request.revision
        || !same(stored.properties.terms, request.terms)) fail('Original checkout payment handoff changed');
      for (const [relation, target] of [['request', { type: 'ServiceRequest', id: ctx.request.id }], ['checkoutScope', ctx.state.scope], ['checkout', request.terms.checkoutObservation], ['checkoutUnpaidProof', request.terms.unpaidObservation]] as const) {
        const linked = ctx.graph.related(ctx.owner, ref, relation, { remaining: 1000 });
        if (linked?.length !== 1 || !same(linked[0]!.ref, target)) fail('Checkout payment handoff lost its original source relationship');
      }
      verifyPAPaymentSelection(ctx.state.paPayment);
    }
    return shopifyPAInputSchema.parse(record.properties.input);
  }
  assertContext(ctx: AgentProgramContext) { this.scope(ctx); }
  private observation(ctx: AgentProgramContext, raw: unknown, historical = false) {
    const ref = objectRefSchema.parse(raw);
    if (!ctx.state.observations.some(value => same(value, ref))) fail('Use an accepted original checkout observation from this component');
    const snapshot = readShopifyPAObservation(ctx.graph, ctx.owner, ref, { historical });
    if (!same(snapshot.scope, ctx.state.scope) || snapshot.configurationDigest !== ctx.state.programDigest || snapshot.receipt.requestId !== ctx.request.id || snapshot.receipt.requestRevision !== ctx.request.revision) fail('Checkout evidence belongs to another component');
    return snapshot;
  }
  private checkout(ctx: AgentProgramContext, raw: unknown, historical = false) {
    const snapshot = this.observation(ctx, raw, historical);
    if (snapshot.payload.type !== 'ShopifyPaymentCheckoutObservation') fail('Select the original checkout observation');
    const data = shopifyPACheckoutSchema.parse(snapshot.payload.data);
    if (data.checkout.continue_url !== `${this.connector.origin}/checkout/${encodeURIComponent(data.checkout.id)}`
      || data.routes.some(route => route.endpoint !== this.connector.origin + '/pa/payments') || data.termsDigest !== shopifyPATermsDigest(data)) fail('Checkout payment endpoints or original terms escaped the configured source');
    return { snapshot, data };
  }
  private checkPrice(ctx: AgentProgramContext, amount: { minor: string; currency: string }, checkDeadline = true) {
    for (const requirement of ctx.request.requirements.filter(value => value.strength === 'hard')) {
      if (requirement.kind === 'budget' && (!requirement.role || requirement.role === 'service_total') && (requirement.expected.currency !== amount.currency || BigInt(amount.minor) > BigInt(requirement.expected.minor))) fail('The complete checkout price exceeds the user test budget');
      if (checkDeadline && requirement.kind === 'deadline' && (!requirement.role || requirement.role === 'completion') && Date.parse(requirement.expected.at) <= Date.now()) fail('The user checkout deadline expired');
    }
  }
  private evaluate(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot) {
    const call = { function: 'shopifyPAPaymentStatus', object: objectRefSchema.parse(raw) }, current = ctx.graph.evaluate(ctx.owner, call);
    if (current.status !== 'known' || !reads.reads.some(read => read.tool === 'evaluate_ontology' && read.status === 'ok' && read.inputDigest === digest(call) && read.outputDigest === digest(current))) fail('Actually read and evaluate these exact current checkout facts in this decision');
  }
  validate(ctx: AgentProgramContext, action: string, raw: Record<string, unknown>) {
    const scope = this.scope(ctx), input = this.schema(action).parse(raw) as Record<string, unknown>; this.definition(ctx.graph, action);
    if (!same(input, raw) || !same(input.scope, ctx.state.scope)) fail('Checkout arguments escaped their exact scope');
    if (ctx.state.paPayment && !['ReadShopifyPaymentCheckout', 'ReadShopifyCheckoutPayment', 'WaitForShopifyPAPayment'].includes(action)) fail('Preserve the original checkout after handing payment to the PA');
    if (action === 'CreateShopifyPaymentCheckout') {
      const observed = this.observation(ctx, input.products), products = shopifyPAProductsSchema.parse(observed.payload.data);
      if (observed.payload.type !== 'ShopifyPaymentProducts' || products.merchant.id !== scope.merchantId || !same(products.items.map(item => ({ variantId: item.variantId, quantity: item.quantity })), scope.items)
        || products.items.some(item => !item.available) || Date.parse(products.expiresAt) <= Date.now()) fail('Read current exact available variants before preparing their checkout');
      if (ctx.state.observations.some(ref => ref.type === 'ShopifyPaymentCheckoutObservation')) fail('An original checkout already exists; read it instead of creating another');
      this.checkPrice(ctx, products.total);
    } else if (action !== 'ReadShopifyPaymentProducts') {
      const historical = action.startsWith('Read'), checkout = this.checkout(ctx, input.checkout, historical);
      if (ctx.state.paPayment) {
        const terms = paCheckoutPaymentRequestSchema.parse(ctx.state.paPayment.request).terms;
        if (checkout.data.checkout.id !== terms.resource.id || checkout.data.termsDigest !== terms.resource.termsDigest) fail('Only the original PA-funded checkout may be read');
      }
      if (action === 'RequestShopifyPAPayment') this.assertUnpaid(ctx, objectRefSchema.parse(input.checkout), objectRefSchema.parse(input.payment));
      if (action === 'WaitForShopifyPAPayment') {
        const handoff = ctx.state.paPayment ?? fail('Waiting requires the original payment request'), observed = this.observation(ctx, input.payment), payment = shopifyPAPaymentSchema.parse(observed.payload.data);
        if (checkout.snapshot.receipt.readbackSequence !== handoff.readbackSequence || observed.receipt.readbackSequence !== handoff.readbackSequence
          || observed.receipt.action !== 'ReadShopifyCheckoutPayment' || checkout.snapshot.receipt.action !== 'ReadShopifyPaymentCheckout'
          || payment.checkoutId !== checkout.data.checkout.id) fail('Read the original checkout and payment for this exact notification before waiting');
        if (checkout.data.checkout.status === 'canceled' || payment.state === 'refunded' || this.matchesPayment(ctx, checkout.data, payment)) fail('Select the independently observed terminal outcome instead of waiting');
      }
    }
  }
  private assertUnpaid(ctx: AgentProgramContext, checkoutRef: ObjectRef, paymentRef: ObjectRef) {
    const checkout = this.checkout(ctx, checkoutRef), observed = this.observation(ctx, paymentRef), payment = shopifyPAPaymentSchema.parse(observed.payload.data);
    this.checkPrice(ctx, checkout.data.total);
    if (checkout.snapshot.receipt.action !== 'ReadShopifyPaymentCheckout' || !checkout.data.independentRead || checkout.data.checkout.status !== 'ready_for_complete'
      || checkout.data.checkout.order || checkout.data.orderConfirmation || checkout.data.checkout.payment.instruments.length || Date.parse(checkout.data.expiresAt) <= Date.now()
      || observed.receipt.action !== 'ReadShopifyCheckoutPayment' || payment.checkoutId !== checkout.data.checkout.id || payment.termsDigest !== checkout.data.termsDigest
      || payment.providerId !== checkout.data.providerId || payment.payeeId !== checkout.data.payeeId || !same(payment.amount, checkout.data.total)
      || payment.state !== 'unpaid' || payment.paidAmount.minor !== '0' || payment.paymentId || payment.operationId || payment.orderId || payment.capturedAt) fail('Payment handoff requires independently verified exact unpaid checkout and payment');
    return checkout.data;
  }
  validatePaymentRoute(ctx: AgentProgramContext, payment: PAPaymentState) {
    this.scope(ctx); const terms = paCheckoutPaymentRequestSchema.parse(payment.request).terms;
    const checkout = ctx.state.observations.filter(ref => ref.type === 'ShopifyPaymentCheckoutObservation').at(-1), unpaid = ctx.state.observations.filter(ref => ref.type === 'ShopifyCheckoutPaymentObservation').at(-1);
    if (!checkout || !unpaid) fail('Read the original checkout and payment before selecting a PA capability');
    const current = this.assertUnpaid(ctx, checkout, unpaid);
    if (current.checkout.id !== terms.resource.id || current.termsDigest !== terms.resource.termsDigest || !same(current.routes, terms.routes)
      || current.checkout.continue_url !== terms.checkout.url || !same(current.total, terms.amount)
      || [checkout, unpaid].some(ref => this.observation(ctx, ref).receipt.readbackSequence !== payment.readbackSequence)) fail('PA route requires the current original unpaid checkout terms');
  }
  validatePlanning(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot) {
    if (action === 'CreateShopifyPaymentCheckout') this.evaluate(ctx, input.products, reads);
    if (['RequestShopifyPAPayment', 'WaitForShopifyPAPayment'].includes(action)) { this.evaluate(ctx, input.checkout, reads); this.evaluate(ctx, input.payment, reads); }
  }
  validatePause(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot) {
    if (decision.kind === 'clarify' && ctx.state.paPayment) fail('Wait on the original payment handoff using WaitForShopifyPAPayment');
    if (decision.kind === 'no_feasible_plan' && !ctx.state.observations.some(ref => reads.objects.some(object => same(object.ref, ref)))) fail('Read merchant evidence before rejecting the checkout outcome');
  }
  authority(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    this.validate(ctx, action, input); if (action !== 'CreateShopifyPaymentCheckout') fail('Only unpaid test checkout preparation has an EIGOS source write');
    const products = shopifyPAProductsSchema.parse(this.observation(ctx, input.products).payload.data);
    return { cost: { minor: '0', currency: products.total.currency, payeeId: products.merchant.id },
      budgetImpact: { key: `shopify-pa:${digest(ctx.state.scope)}`, kind: 'commitment' as const, role: 'service_total' as const, amount: products.total },
      operationScope: `shopify-pa:${digest({ owner: ctx.owner, task: ctx.request.id, scope: ctx.state.scope })}` };
  }
  private terms(ctx: AgentProgramContext, checkout: ObjectRef, payment: ObjectRef): PACheckoutPaymentTerms {
    const data = this.assertUnpaid(ctx, checkout, payment);
    return { providerId: data.providerId, payeeId: data.payeeId, resource: { type: 'shopify_checkout', id: data.checkout.id, termsDigest: data.termsDigest },
      checkoutObservation: { type: 'ShopifyPaymentCheckoutObservation', id: checkout.id }, unpaidObservation: { type: 'ShopifyCheckoutPaymentObservation', id: payment.id },
      description: `${data.merchant.name}: ${data.checkout.line_items.map(line => `${line.item.title} × ${line.quantity}`).join(', ')}`, amount: data.total,
      checkout: { id: data.checkout.id, type: 'provider_checkout', url: data.checkout.continue_url!, testMode: true }, routes: data.routes, routePolicy: 'pa_selects_authorized_capability',
      expiresAt: data.expiresAt, environment: 'sandbox', evidenceLevel: 'synthetic' };
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    if (['RequestShopifyPAPayment', 'WaitForShopifyPAPayment'].includes(action)) {
      const terms = action === 'RequestShopifyPAPayment' ? this.terms(ctx, objectRefSchema.parse(input.checkout), objectRefSchema.parse(input.payment)) : paCheckoutPaymentRequestSchema.parse(ctx.state.paPayment!.request).terms;
      return { value: { terms }, evidenceRefs: [`local:pa-checkout:${digest({ intent: ctx.intentId, terms })}`] };
    }
    const products = action === 'CreateShopifyPaymentCheckout' ? this.observation(ctx, input.products) : undefined;
    const payload = action === 'ReadShopifyPaymentProducts' ? this.scope(ctx) : products ? { productsId: products.payload.sourceId, productsDigest: digest(products.payload) } : { checkoutId: this.checkout(ctx, input.checkout, true).data.checkout.id };
    const result = (await this.connector.call(ctx, action, payload, signal))!;
    if (result.payload.type !== shopifyPAActionMetadata[action as ShopifyPAAction].type) fail('Test provider returned another action result type');
    return { value: result, evidenceRefs: [result.receipt.id] };
  }
  async recover(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal) {
    if (['RequestShopifyPAPayment', 'WaitForShopifyPAPayment'].includes(action)) return this.invoke(ctx, action, input, signal);
    if (action !== 'CreateShopifyPaymentCheckout') return;
    const result = await this.connector.call(ctx, action, {}, signal, true);
    if (result) return { value: result, evidenceRefs: [result.receipt.id] };
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult) {
    if (!['RequestShopifyPAPayment', 'WaitForShopifyPAPayment'].includes(action)) return projectShopifyPAObservation(ctx, action, input, result.value as ShopifyPASourceResult);
    const terms = (result.value as { terms: PACheckoutPaymentTerms }).terms, ref = { type: 'PAPaymentRequest', id: digest({ request: ctx.request.id, revision: ctx.request.revision, configuration: this.configurationDigest, checkout: terms.resource }) };
    if (action === 'WaitForShopifyPAPayment') { if (!same(ctx.graph.read(ctx.owner, ref).properties.terms, terms)) fail('Original payment request changed'); return ref; }
    if (!same(terms, this.terms(ctx, objectRefSchema.parse(input.checkout), objectRefSchema.parse(input.payment)))) fail('Payment request differs from independently observed checkout');
    ctx.graph.ingest(ctx.owner, { objects: [{ ref, properties: { id: ref.id, displayTitle: '交给 PA 自有支付能力的测试结账', requestRevision: ctx.request.revision, terms, configurationDigest: this.configurationDigest } }],
      links: [{ type: 'PAPaymentRequestRequest', from: ref, to: { type: 'ServiceRequest', id: ctx.request.id } }, { type: 'PAPaymentCheckoutScope', from: ref, to: ctx.state.scope }, { type: 'PAPaymentCheckout', from: ref, to: terms.checkoutObservation }, { type: 'PAPaymentCheckoutUnpaidProof', from: ref, to: terms.unpaidObservation }] }, { kind: 'task', id: ctx.request.id, observedAt: new Date().toISOString() });
    return ref;
  }
  onAccepted(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef, job: Job) {
    if (!['RequestShopifyPAPayment', 'WaitForShopifyPAPayment'].includes(action)) return;
    const plan = ctx.state.plans.find(value => value.id === ctx.planId), step = plan?.steps.find(value => value.intentId === ctx.intentId);
    if (step?.effect !== 'local' || plan!.steps.length !== 1 || object.type !== 'PAPaymentRequest') fail('Publish the payment handoff through its single local action');
    recordPAPaymentHandoff(job, ctx.owner, object.id, (result.value as { terms: PACheckoutPaymentTerms }).terms, action === 'RequestShopifyPAPayment' ? 'request' : 'wait', step.contextId);
  }
  onCompletionAccepted(ctx: AgentProgramContext, job: Job) { if (ctx.state.paPayment && job.delegation?.agent?.paPayment?.request.digest === ctx.state.paPayment.request.digest) job.delegation.agent.paPayment.status = 'verified'; }
  projectOutputs(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef) {
    return objectResultProjection(object, { origin: object.type === 'PAPaymentRequest' ? 'managed' : 'synthetic', refs: result.evidenceRefs, observedAt: ctx.graph.read(ctx.owner, object).source.observedAt },
      !!ctx.graph.model.action(action).composition?.outputs.identity, true);
  }
  private matchesPayment(ctx: AgentProgramContext, checkout: ShopifyPACheckout, payment: z.infer<typeof shopifyPAPaymentSchema>) {
    if (!ctx.state.paPayment?.selection) return false;
    const terms = paCheckoutPaymentRequestSchema.parse(ctx.state.paPayment.request).terms, selection = ctx.state.paPayment.selection, order = checkout.orderConfirmation;
    return checkout.termsDigest === shopifyPATermsDigest(checkout) && checkout.checkout.id === terms.resource.id && checkout.termsDigest === terms.resource.termsDigest
      && checkout.providerId === terms.providerId && checkout.payeeId === terms.payeeId && same(checkout.total, terms.amount) && same(checkout.routes, terms.routes)
      && checkout.checkout.continue_url === terms.checkout.url && checkout.expiresAt === terms.expiresAt && checkout.checkout.status === 'completed'
      && !!order && order.id === checkout.checkout.order?.id && order.checkoutId === terms.resource.id && same(order.amount, terms.amount) && Date.parse(order.confirmedAt) <= Date.now()
      && payment.checkoutId === terms.resource.id && payment.providerId === terms.providerId && payment.payeeId === terms.payeeId && payment.termsDigest === terms.resource.termsDigest
      && same(payment.amount, terms.amount) && same(payment.paidAmount, terms.amount) && payment.state === 'paid' && !!payment.paymentId && !!payment.capturedAt
      && Date.parse(payment.capturedAt) <= Date.now() && Date.parse(payment.capturedAt) <= Date.parse(terms.expiresAt) && payment.orderId === order.id
      && payment.operationId === selection.operationId && payment.route === selection.route;
  }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    this.scope(ctx); const selected = shopifyPACompletionSchema.parse(raw); this.evaluate(ctx, selected.checkout, reads); this.evaluate(ctx, selected.payment, reads);
    const checkout = this.checkout(ctx, selected.checkout), observed = this.observation(ctx, selected.payment), payment = shopifyPAPaymentSchema.parse(observed.payload.data);
    const handoff = ctx.state.paPayment ?? fail('No original PA payment request'), after = Date.parse(handoff.reports.at(-1)?.receivedAt ?? handoff.request.createdAt);
    if (handoff.readbackSequence < 1 || checkout.snapshot.receipt.readbackSequence !== handoff.readbackSequence || observed.receipt.readbackSequence !== handoff.readbackSequence
      || checkout.snapshot.receipt.action !== 'ReadShopifyPaymentCheckout' || !checkout.data.independentRead || observed.receipt.action !== 'ReadShopifyCheckoutPayment'
      || Date.parse(checkout.snapshot.receipt.startedAt) < after || Date.parse(observed.receipt.startedAt) < after || !this.matchesPayment(ctx, checkout.data, payment)) fail('Fresh independent payment AND order readback must match the original checkout and PA operation');
    this.checkPrice(ctx, checkout.data.total, false);
    const evidenceRefs = [checkout.snapshot.receipt.id, observed.receipt.id], result = { environment: 'sandbox', evidenceLevel: 'synthetic', providerKind: 'shopify_contract_simulator', realPayment: false,
      paymentAuthority: 'pa_owned', paymentRoute: handoff.selection!.route, handoffId: handoff.request.id, checkout: checkout.data, payment, sourceRefs: selected, receiptIds: evidenceRefs };
    const quantity = { amount: String(checkout.data.checkout.line_items.reduce((sum, line) => sum + line.quantity, 0)), unit: 'piece' as const };
    return { artifact: { id: digest(result), name: 'shopify-pa-payment-result.json', data: { goal: ctx.request.originalGoal, deliverable: '原测试结账已由 PA 自有测试支付能力付款；EIGOS 已独立核验同一订单与付款。来源为隔离模拟器，没有真实扣款或履约。', execution: 'completed', result } },
      facts: { conditions: ['shopify.pa.sandbox_only', 'shopify.pa.order_confirmed', 'shopify.pa.payment_confirmed'], totalPrice: checkout.data.total, amounts: { service_total: checkout.data.total }, quantity, quantities: { item_quantity: quantity }, deliveryBy: checkout.data.orderConfirmation!.confirmedAt, deadlines: { completion: checkout.data.orderConfirmation!.confirmedAt } }, evidenceRefs };
  }
  terminalHandoff(ctx: AgentProgramContext) {
    const payment = ctx.state.paPayment; if (!payment) return;
    return { canRecover: (payment.recoveryAttempts ?? 0) < 3, recover: (signal: AbortSignal) => this.reconcilePayment(ctx, signal),
      record: (job: Job, result: unknown | undefined) => {
        const current = job.delegation!.agent!.paPayment!; if (current.request.digest !== payment.request.digest) fail('Original checkout payment changed during terminal readback');
        current.recoveryAttempts = (current.recoveryAttempts ?? 0) + 1;
        if (result) current.recovery = result as NonNullable<typeof current.recovery>;
        job.delegation!.recoveryPending = !result && current.recoveryAttempts < 3; job.delegation!.nextAt = Date.now() + 1000; job.updatedAt = new Date().toISOString();
        job.delegation!.events.push({ at: job.updatedAt, event: result ? 'terminal_pa_payment_readback' : 'terminal_pa_payment_readback_unknown', evidence: current.request.digest });
      } };
  }
  private async reconcilePayment(ctx: AgentProgramContext, signal: AbortSignal) {
    this.scope(ctx); const payment = ctx.state.paPayment ?? fail('Original handoff missing'), request = paCheckoutPaymentRequestSchema.parse(payment.request);
    const step = ctx.state.plans.flatMap(plan => plan.steps.map(value => ({ plan, value }))).find(item => item.value.action === 'RequestShopifyPAPayment' && (!ctx.state.composition || item.value.contextId === ctx.state.composition.paymentContextId)) ?? fail('Original handoff plan missing');
    const context: AgentActionContext = { ...ctx, planId: step.plan.id, intentId: step.value.intentId, attemptId: randomUUID(), modelRunId: step.plan.modelRunId, operationKey: `terminal-pa-read:${request.id}` };
    const [checkoutResult, paymentResult] = await Promise.all(['ReadShopifyPaymentCheckout', 'ReadShopifyCheckoutPayment'].map(action => this.connector.call({ ...context, attemptId: randomUUID() }, action, { checkoutId: request.terms.resource.id }, signal)));
    const checkout = shopifyPACheckoutSchema.parse(checkoutResult!.payload.data), paid = shopifyPAPaymentSchema.parse(paymentResult!.payload.data);
    if (checkoutResult!.receipt.sourceIdentity !== request.terms.providerId || paymentResult!.receipt.sourceIdentity !== request.terms.providerId || checkout.checkout.id !== request.terms.resource.id
      || paid.checkoutId !== request.terms.resource.id || checkout.termsDigest !== request.terms.resource.termsDigest || paid.termsDigest !== request.terms.resource.termsDigest) fail('Terminal readback returned another checkout');
    return { observedAt: new Date().toISOString(), result: this.matchesPayment(ctx, checkout, paid) ? 'confirmed' as const : ['ready_for_complete', 'complete_in_progress'].includes(checkout.checkout.status) ? 'pending' as const : 'mismatch' as const, evidenceRefs: [checkoutResult!.receipt.id, paymentResult!.receipt.id] };
  }
}
