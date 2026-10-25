import {commerceEntitySchemas} from '../ontology/commerce-journey.js';
import {permitsPersonalSource} from '../core/source-owner.js';
import { z } from 'zod';
import { objectResultProjection } from '../core/composed-actions.js';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../core/agent-program.js';
import type { Delivery } from '../core/catalog.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { AgentDecision } from '../ontology/agent-actions.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import { validatePlanningSnapshot } from '../coordinator/planning-session.js';
import type { ServiceCapability, ServiceRequest, RequirementInput, CandidateFacts } from '../ontology/execution.js';
import { commerceJourneyInputSchema, commerceJourneyActionSchemas, commerceActionMetadata, parseCommerceEntity, type CommerceJourneyAction, type CommerceEntityType, type CommerceObservation } from '../ontology/commerce-journey.js';
import { readCommerceObservation, checkedCommerceObservation, commerceObservationReadiness, commerceDestinationChoice, postalAddressDigest, addressHasDeliveryStructure } from '../ontology/commerce-journey-functions.js';
import { projectCommerceObservation, type CommerceSourceResult } from '../ontology/commerce-journey-projection.js';
import { HttpCommerceSandboxConnector, type CommerceSandboxConnector, type CommerceSandboxOptions } from './commerce-sandbox/connector.js';
import { CUSTOMS_POLICY_DIGEST, CUSTOMS_RULE_REF, CUSTOMS_REFERENCES, CUSTOMS_REFERENCE_REFS, seedCustomsPolicy } from '../ontology/customs-policy.js';
import { customsGateStatus, productRegulatoryBoundary } from '../ontology/customs-policy-functions.js';
import { StripeTestPayments } from './stripe/payment.js';
import type { StripeTestOptions } from './stripe/client.js';
import { stripePaymentActionSchemas, stripeActionMetadata, type StripePaymentAction } from '../ontology/stripe-payment.js';

const selectedRef = objectRefSchema;
const completion = z.strictObject({ selected: selectedRef, cart: selectedRef.optional(), order: selectedRef.optional(), payment: selectedRef.optional(), delivery: selectedRef.optional(), rationale: z.string().min(1).max(2000) });
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const supportedPredicates = ['commerce.sandbox_only', 'commerce.stock_confirmed', 'commerce.customs_checked', 'commerce.all_buyer_fees', 'commerce.delivery_promised', 'commerce.cart_created', 'commerce.checkout_prepared', 'commerce.order_confirmed', 'commerce.payment_settled', 'commerce.delivery_verified'];
export class CommerceAgentProgram implements AgentProgram {
  get projectionTypes(){return ['CommerceTask',...Object.keys(commerceEntitySchemas),'CustomsRuleSet','RegulatoryReference','SourceReceipt','Order','OrderLine','ProductVariant','Payment','Shipment','DeliveryEvent','DeliveryAllocation',...(this.stripe?['StripePaymentObservation']:[])];}
  readonly ref: { id: string; version: string };
  readonly actionIds: string[];
  readonly configurationDigest: string;
  readonly limits = { modelTurns: 72, plans: 24, actions: 56 };
  readonly completionSchema = z.toJSONSchema(completion);
  readonly connector: CommerceSandboxConnector;
  readonly stripe?: StripeTestPayments;
  readonly guidance = [
    'This is the explicitly isolated commerce sandbox. All merchant, PA-context, customs, payment and shipping responses are synthetic source evidence; never present them as real-world transactions or tariff rules. You decide the business action sequence and which merchant, product and shipping option to select. Queries and drafts are not purchase authority.',
    'The CommerceTask starts without merchant or country facts. Query authorized PA context and merchant directory yourself. A merchant registration country, actual dispatch warehouse, goods customs origin, shopping market and delivery country are different facts. Read provider facts through the available source actions; do not ask PA to supply merchant warehouse, HS code, taxes or shipping facts that these actions can query.',
    'Query the supplied CommerceTask and relevant exact observation refs; for commerce facts select=["data"] to avoid duplicating their raw snapshots. Evaluate commerceObservationStatus to obtain source version, validity and readiness. commerceJourneyStatus reports evidence and stage gaps. commerceObservationStatus independently validates one observation and returns assessment.status plus gaps. You must actually evaluate the quote before PrepareCommerceCheckout and the checkout before SubmitCommerceOrder. Each sandbox write uses a separate frontier and requires the exact PA permit through the existing authorization interface.',
    `Read policy through query_ontology with from=the current ServiceRequest and link="customsRuleSets", then read the same request's link="regulatoryReferences". These direct request relationships work with your scoped permissions; do not search owner-wide objects or traverse arbitrary relationships. The current rule set is ${JSON.stringify(CUSTOMS_RULE_REF)}. Official reference documents are supporting information, not legal eligibility or permission. Before QuoteCommerceLandedCost, evaluate shippingGateStatus on its exact CustomsAssessment; before PrepareCommerceCheckout, evaluate it on the exact LandedCostQuote; before SubmitCommerceOrder, evaluate it on the exact CommerceCheckout. In the same decision, query the rule set and its reference documents before evaluating. Only pass_sandbox may proceed. First obtain observations, then evaluate; an unobserved future action output cannot satisfy this gate.`,
    'Shipping rules depend on the actual route and stock status. Same-territory free-circulation local stock with release evidence uses domestic or regional transport checks, without an import clause. Bonded or controlled stock and any cross-territory leg still require customs checks. Merchant registration or goods origin alone never selects the regime. ReadCommerceCustoms returns the route-specific assessment for all regimes; shippingGateStatus (also available as customsGateStatus) enforces the selected checks.',
    'Missing, expired, conflicting or unsupported regulatory evidence stops purchasing. A PA authorization cannot override that result. Tobacco and unsupported regulated categories are outside this program; do not propose procurement or forwarding routes for them. If an actually read and evaluated directory contains no merchants, report the limited registered-source coverage through no_feasible_plan; do not infer worldwide unavailability or ask PA to repair a missing provider integration.',
    'For ambiguous saved addresses, first read and evaluate FulfillmentContext. Then clarify with informationRequest={fact:"destination_choice",evidenceRefs:[contextRef]}, listing the source labels in message and asking PA to return the chosen label as a structured location requirement with role destination. Do not infer a choice from PA location, IP or language. A single usable address or explicit preferredAddressId can be used without an unnecessary question. A missing quantity or query can be clarified with fact requested_quantity or product_need. Other missing facts must be queried from their source.',
    'Do not create a fixed search/detail/shipping recipe. Read the exact facts required for the next decision, inspect alternative merchants when supply or terms fail, and adapt to changed evidence. A quote may cover seller-borne unknown tax amounts only with explicit responsibility evidence; never treat unknown buyer fees as zero. Shipment promises must cover every package, quantity and destination and satisfy any hard arrival deadline.',
    'For complete: selected identifies the current terminal evidence for target quote/cart/checkout/order, or the independently read order for target delivery; include order/payment/delivery refs when required. Every selected ref must have been read and evaluated with commerceObservationStatus in this decision. Delivery requires a separately read original order, settled simulated payment and actual synthetic delivery events for every package. Order confirmation alone proves neither settlement nor arrival.',
    'If a write response is lost, the runtime reads only its original idempotency key. Never select a duplicate write to solve uncertainty. Retain the original business identity. No live checkout, payment or merchant endpoint is supported.',
  ].join('\n');
  constructor(options: CommerceSandboxOptions & { connector?: CommerceSandboxConnector; stripe?: StripeTestOptions }) {
    this.connector = options.connector ?? new HttpCommerceSandboxConnector(options);
    this.stripe = options.stripe ? new StripeTestPayments(options.stripe) : undefined;
    this.ref = this.stripe ? { id: 'commerce.journey.stripe-test', version: '1' } : { id: 'commerce.journey.sandbox', version: '2' };
    this.actionIds = Object.keys(commerceJourneyActionSchemas).filter(id => this.stripe ? !['SubmitCommerceOrder', 'ReadCommercePayment', 'ReadCommerceDelivery'].includes(id) : id !== 'SubmitCommerceUnpaidOrder');
    if (this.stripe) {
      this.actionIds.push(...Object.keys(stripePaymentActionSchemas));
      this.guidance = this.guidance.split('\n').filter(line => !line.startsWith('For complete:')).join('\n')
        .replace('All merchant, PA-context, customs, payment and shipping responses are synthetic source evidence', 'Merchant, PA-context, customs and shipping responses are synthetic. Stripe payment responses are provider_test only when the official API is called; injected test transports remain synthetic')
        .replaceAll('SubmitCommerceOrder', 'SubmitCommerceUnpaidOrder')
        .replace('reads only its original idempotency key', 'reads only its original provider operation')
        .replace('No live checkout, payment or merchant endpoint is supported.', 'No live checkout or payment is supported.')
        + '\nStripe test program: target payment means an independently read Stripe test capture for an unpaid synthetic order; target delivery is unavailable. SubmitCommerceUnpaidOrder has zero payment authority and never simulates settlement. Then select payment actions yourself. PrepareStripePayment creates one unconfirmed PaymentIntent; PayStripePayment uses a short-lived amount/currency-limited SPT generated by the Stripe sandbox test helper, not a customer wallet. Each needs its exact PA grant. Evaluate commerceObservationStatus on the independently read order and stripePaymentStatus on the prepared payment before a payment decision. ReadStripePayment is a separate GET after execution, and must be evaluated with stripePaymentStatus in the completion decision. Complete with selected/order referring to the independently read order and payment referring to the independent Stripe observation. Only test_paid satisfies commerce.payment_confirmed. Capture does not prove bank settlement, real purchase or fulfillment. If Stripe requires authentication or its outcome is unknown, retain the original operation and wait for readback; never create a second payment.';
    }
    this.configurationDigest = digest({ connector: this.connector.configurationDigest, semantics: 'commerce-journey-v3', customsPolicyDigest: CUSTOMS_POLICY_DIGEST, ...(this.stripe ? { stripe: this.stripe.client.configurationDigest } : {}) });
  }
  permitted(owner: string) { return permitsPersonalSource(this,owner); }
  capability(): ServiceCapability {
    const predicates = this.stripe ? [...supportedPredicates.filter(p => !['commerce.payment_settled', 'commerce.delivery_verified'].includes(p)), 'commerce.payment_confirmed'] : supportedPredicates;
    return { ref: this.ref, ontologyRef: { id: 'eigos.commerce.journey', version: '2' }, name: this.stripe ? 'Agent 沙箱订单与 Stripe 测试支付' : 'Agent 自主沙箱交易与履约', environment: 'sandbox', tags: ['commerce', 'agent', 'sandbox', 'cross-border'],
      description: this.stripe ? 'Agent 自主查询隔离商家、库存、运输及报价，建立未付款模拟订单，按准确授权通过 Stripe Shared Payment Token 测试助手确认付款，再独立回读 PaymentIntent 和捕获证据。target=payment；只接受测试密钥，禁止真实付款。商品和订单仍是 synthetic；Stripe HTTP 是 provider_test，注入测试是 synthetic。Shopify 公共查询不提供结账授权。' : '仅在隔离沙箱比较商家、查询 PA 保存地址、库存、仓库、跨境税费和配送承诺，自主形成报价或创建模拟购物车、结账、订单、付款与交付回读。商家、国家与地址无需预先提供，缺失时 input query/quantity/contextKey 可为 null；先通过动作获取事实，只有用户选择才问 PA。数量为所选商品变体件数，袋装咖啡的一袋是一件 piece。target 明确为 quote/cart/checkout/order/delivery；购物车可以独立准备。所有业务证据为 synthetic，禁止真实购买付款。',
      inputSchema: z.toJSONSchema(commerceJourneyInputSchema.extend({ target: this.stripe ? z.enum(['quote', 'cart', 'checkout', 'order', 'payment']) : z.enum(['quote', 'cart', 'checkout', 'order', 'delivery']) })), constraintEvaluation: 'staged', actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: Object.hasOwn(stripeActionMetadata, id) ? stripeActionMetadata[id as StripePaymentAction].effect : commerceActionMetadata[id as CommerceJourneyAction].effect, additionalEffects: Object.hasOwn(commerceActionMetadata, id) ? commerceActionMetadata[id as CommerceJourneyAction].additionalEffects : undefined })),
      predicates: predicates.map(id => ({ id, description: ({ 'commerce.sandbox_only': 'All activity stays in the isolated sandbox; no real transaction', 'commerce.stock_confirmed': 'Source confirms capacity for the requested quantity', 'commerce.customs_checked': 'Applicable synthetic import and customs requirements are resolved', 'commerce.all_buyer_fees': 'Buyer total includes every mandatory buyer-paid charge', 'commerce.delivery_promised': 'Source arrival commitments cover all selected packages and hard deadlines', 'commerce.cart_created': 'Owned sandbox draft cart exists', 'commerce.checkout_prepared': 'Exact sandbox checkout is prepared', 'commerce.order_confirmed': 'Original sandbox order independently read and matched', 'commerce.payment_confirmed': 'Independent original Stripe test PaymentIntent and captured charge match the unpaid sandbox order', 'commerce.payment_settled': 'Separate simulated payment receipt confirms settlement', 'commerce.delivery_verified': 'Separate synthetic delivered events cover the exact ordered goods and destination' } as Record<string, string>)[id]! })), outcomePredicates: predicates,
      goalOutcomes: predicates.map(predicate => ({ predicate, phase: ({ 'commerce.sandbox_only': 'fact', 'commerce.stock_confirmed': 'fact', 'commerce.customs_checked': 'fact', 'commerce.all_buyer_fees': 'quote', 'commerce.delivery_promised': 'quote', 'commerce.cart_created': 'fact', 'commerce.checkout_prepared': 'quote', 'commerce.order_confirmed': 'commitment', 'commerce.payment_confirmed': 'payment', 'commerce.payment_settled': 'payment', 'commerce.delivery_verified': 'delivery' } as Record<string, import('../core/goal-contract.js').GoalCriterion['phase']>)[predicate]!, description: predicate })),
      requirementRoles: [{ kind: 'quantity', role: 'item_quantity', description: 'Selected merchant variant count in piece units' }, { kind: 'budget', role: 'service_total', description: 'Complete buyer cost including all buyer-paid freight, tax, duty and clearance fees' }, { kind: 'deadline', role: 'arrival', description: 'All ordered packages must arrive by the explicit source-bound deadline' }, { kind: 'location', role: 'destination', description: 'Explicit saved-address label or ID selected by PA; an unspecified saved address is discovered through ReadCommerceContext' }], locationSemantics: 'destination',
      ontology: { objects: [...(this.stripe ? ['StripePaymentObservation'] : []), 'CommerceTask', 'FulfillmentContext', 'CommerceProduct', 'InventoryObservation', 'FulfillmentPlan', 'CustomsAssessment', 'LandedCostQuote', 'Cart', 'CommerceCheckout', 'CommerceOrderObservation', 'CommercePaymentObservation', 'CommerceDeliveryObservation', 'CustomsRuleSet', 'RegulatoryReference'], functions: [...(this.stripe ? ['stripePaymentStatus'] : []), 'commerceJourneyStatus', 'commerceObservationStatus', 'shippingGateStatus', 'customsGateStatus'], execution: 'agent_selected_atomic_actions', realSourceConnected: false, ...(this.stripe ? { paymentProvider: 'stripe_test', credentialSource: 'test_helper', providerConnectionVerified: false } : {}) }, verifierRef: { id: 'commerce.journey.independent', version: '2' }, completion: 'domain' };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown, component?: { id: string; scopeKey: string }) {
    if (!this.permitted(owner) || request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'Commerce journey is available only to the configured local sandbox identity');
    const input = commerceJourneyInputSchema.parse(raw), scope = { type: 'CommerceTask', id: `${request.id}:r${request.revision}${component ? `:c${component.scopeKey}` : ''}` };
    if (this.stripe ? input.target === 'delivery' : input.target === 'payment') fail('Completion target is unavailable in this configured commerce program');
    const requirements = request.requirements.map(({ provenance: _provenance, ...requirement }) => requirement);
    const quantities = requirements.filter(r => r.kind === 'quantity' && r.strength === 'hard' && (!r.role || r.role === 'item_quantity'));
    if (input.quantity === null && quantities.length === 1 && quantities[0]!.kind === 'quantity' && quantities[0]!.expected.unit === 'piece') input.quantity = Number(quantities[0]!.expected.amount);
    commerceJourneyInputSchema.parse(input);
    for (const r of requirements) if (r.kind === 'quantity' && r.strength === 'hard' && (!r.role || r.role === 'item_quantity') && (r.expected.unit !== 'piece' || input.quantity !== null && String(input.quantity) !== r.expected.amount)) fail('The selected quantity must match the explicit user item count');
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: 'Agent 沙箱交易范围', requestRevision: request.revision, input, requirements, configurationDigest: this.configurationDigest, allowedActions: this.actionIds, environment: 'sandbox' } }], links: [{ type: 'CommerceTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    seedCustomsPolicy(graph, owner, scope, { type: 'ServiceRequest', id: request.id });
    return { scope, input };
  }
  schema(action: string) { if (!this.actionIds.includes(action)) throw new DomainError('FORBIDDEN', 'Unknown or disabled commerce action'); return Object.hasOwn(stripePaymentActionSchemas, action) ? stripePaymentActionSchemas[action as StripePaymentAction] : commerceJourneyActionSchemas[action as CommerceJourneyAction]; }
  definition(graph: OntologyObjectStore, action: string) {
    const schema = this.schema(action), definition = graph.model.action(action), metadata = definition.read ?? definition.operation;
    if (!metadata || !equal(metadata.inputSchema, z.toJSONSchema(schema))) fail('Commerce action schema differs from its published Ontology definition');
    return definition;
  }
  private scope(ctx: AgentProgramContext) {
    if (!this.permitted(ctx.owner) || ctx.request.executionEnvironment !== 'sandbox' || ctx.state.programDigest !== this.configurationDigest || ctx.state.requestRevision !== ctx.request.revision) throw new DomainError('FORBIDDEN', 'Commerce program owner, environment or revision changed');
    const scope = ctx.graph.read(ctx.owner, ctx.state.scope);
    if (scope.properties.configurationDigest !== this.configurationDigest || scope.properties.requestRevision !== ctx.request.revision) fail('Commerce scope changed');
    return commerceJourneyInputSchema.parse(scope.properties.input);
  }
  private facts(ctx: AgentProgramContext, ref: unknown, type?: CommerceEntityType, historicalIdentity = false) {
    const parsed = objectRefSchema.parse(ref); if (type && parsed.type !== type) fail(`Expected an owned ${type} observation`);
    const observation = readCommerceObservation(ctx.graph, ctx.owner, parsed, historicalIdentity ? { at: Date.parse(checkedCommerceObservation(ctx.graph.read(ctx.owner, parsed).properties.snapshot).observedAt) } : {});
    if (!equal(observation.scope, ctx.state.scope) || observation.configurationDigest !== this.configurationDigest || observation.requestId !== ctx.request.id || observation.requestRevision !== ctx.request.revision) fail('Commerce input belongs to another task scope');
    return observation;
  }
  private requirements(ctx: AgentProgramContext): RequirementInput[] { return ctx.request.requirements.map(({ provenance: _provenance, ...r }) => r); }
  private quantity(ctx: AgentProgramContext, quantity: number) { if (this.scope(ctx).quantity === null || this.scope(ctx).quantity !== quantity) fail('Obtain the requested quantity from PA; do not invent or change it'); }
  private ready(ctx: AgentProgramContext, observation: CommerceObservation) { const result = commerceObservationReadiness(ctx.graph, ctx.owner, observation); if (result.status !== 'satisfied') fail(result.gaps.map(g => `${g.fact}: ${g.reason}; query ${g.source}`).join('; ') || 'Business readiness is not established'); }
  validate(ctx: AgentProgramContext, action: string, raw: Record<string, unknown>) {
    this.scope(ctx); const input = this.schema(action).parse(raw) as Record<string, unknown>;
    if (!equal(input.scope, ctx.state.scope)) fail('Action scope is not this task');
    if (Object.hasOwn(stripePaymentActionSchemas, action)) { this.stripe!.validate(ctx, action, input); return; }
    const identityRead = ['ReadCommerceCart', 'ReadCommerceOrder', 'ReadCommercePayment', 'ReadCommerceDelivery'].includes(action);
    const observations = Object.entries(input).filter(([key]) => key !== 'scope').flatMap(([, value]) => objectRefSchema.safeParse(value).success ? [this.facts(ctx, value, undefined, identityRead)] : []);
    const get = <T extends CommerceEntityType>(key: string, type: T) => { const s = this.facts(ctx, input[key], type, identityRead); return { s, data: parseCommerceEntity(type, s.data) }; };
    if (input.quantity !== undefined) this.quantity(ctx, Number(input.quantity));
    if (action === 'CreateCommerceCart' || action === 'UpdateCommerceCart') {
      const boundary = productRegulatoryBoundary(get('product', 'CommerceProduct').data);
      if (boundary.result !== 'pass') fail(boundary.reason);
    }
    if (action === 'ReadCommerceProduct') {
      const { data } = get('discovery', 'CommerceMerchantSearch'); if (!data.merchants.some(m => m.id === input.merchantId)) fail('Select a merchant from an actual directory observation');
    }
    if (action === 'ReadCommerceFulfillment') {
      const product = get('product', 'CommerceProduct'), inventory = get('inventory', 'InventoryObservation'), context = get('context', 'FulfillmentContext');
      this.ready(ctx, inventory.s); this.ready(ctx, context.s);
      const choice = commerceDestinationChoice(context.data, this.requirements(ctx));
      if (!choice || choice.id !== input.addressId || !choice.usable || !addressHasDeliveryStructure(choice.address)) fail('Resolve the destination choice with PA before selecting its source ID');
      if (product.data.merchantId !== inventory.data.merchantId || product.data.variantId !== inventory.data.variantId || inventory.data.requestedQuantity !== input.quantity) fail('Inventory belongs to different goods or quantity');
    }
    if (action === 'ReadCommerceCustoms' || action === 'QuoteCommerceLandedCost') {
      const product = get('product', 'CommerceProduct'), fulfillment = get('fulfillment', 'FulfillmentPlan'), option = fulfillment.data.options.find(o => o.id === input.optionId);
      this.ready(ctx, fulfillment.s);
      if (!option || option.status !== 'available' || product.data.merchantId !== fulfillment.data.merchantId || product.data.variantId !== fulfillment.data.variantId) fail('Select a currently available source shipping option for these goods');
      if (action === 'QuoteCommerceLandedCost') {
        const customs = get('customs', 'CustomsAssessment'), inventory = get('inventory', 'InventoryObservation'); this.ready(ctx, customs.s); this.ready(ctx, inventory.s);
        this.requireCustomsGate(ctx, objectRefSchema.parse(input.customs));
        if (customs.data.fulfillmentId !== fulfillment.s.sourceId || customs.data.optionId !== input.optionId || customs.data.destinationDigest !== fulfillment.data.destinationDigest || customs.data.variantId !== product.data.variantId || inventory.data.variantId !== product.data.variantId || inventory.data.merchantId !== product.data.merchantId || inventory.data.requestedQuantity !== fulfillment.data.quantity) fail('Quote inputs refer to different products, routes or quantities');
      }
    }
    if (action === 'UpdateCommerceCart' || action === 'CancelCommerceCart') {
      const cart = get('cart', 'Cart'); if (cart.data.state !== 'active') fail('Only an active current cart can be changed');
      if (action === 'UpdateCommerceCart' && get('product', 'CommerceProduct').data.merchantId !== cart.data.merchantId) fail('A cart cannot silently change merchants');
    }
    if (action === 'PrepareCommerceCheckout') {
      const quote = get('quote', 'LandedCostQuote'); this.ready(ctx, quote.s);
      this.requireCustomsGate(ctx, objectRefSchema.parse(input.quote));
      if (input.cart) { const cart = get('cart', 'Cart'); if (cart.data.state !== 'active' || cart.data.merchantId !== quote.data.merchantId || cart.data.lines.length !== 1 || cart.data.lines[0]!.variantId !== quote.data.variantId || cart.data.lines[0]!.quantity !== quote.data.quantity) fail('Cart contents differ from the selected firm quote'); }
    }
    if (['SubmitCommerceOrder', 'SubmitCommerceUnpaidOrder'].includes(action)) { this.ready(ctx, get('checkout', 'CommerceCheckout').s); this.requireCustomsGate(ctx, objectRefSchema.parse(input.checkout)); }
    if (action === 'SubmitCommerceUnpaidOrder' && get('checkout', 'CommerceCheckout').data.merchantId !== this.stripe?.client.options.merchantId) fail('Unpaid order merchant has no configured Stripe test account');
    if (['ReadCommerceOrder', 'ReadCommercePayment', 'ReadCommerceDelivery'].includes(action)) this.ready(ctx, get('order', 'CommerceOrderObservation').s);
    if (observations.some(s => s.evidenceLevel !== 'synthetic')) fail('Sandbox actions cannot consume real transaction evidence');
  }
  private requireEvaluation(ctx: AgentProgramContext, ref: ObjectRef, reads: PlanningSnapshot, ready = false) {
    const current = ctx.graph.evaluate(ctx.owner, { function: 'commerceObservationStatus', object: ref });
    if (current.status !== 'known' || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest({ function: 'commerceObservationStatus', object: ref }) && r.outputDigest === digest(current))) fail('The Agent must read and evaluate the exact current commerce evidence before using it for this decision');
    if (ready) this.ready(ctx, this.facts(ctx, ref));
  }
  private requireCustomsGate(ctx: AgentProgramContext, ref: ObjectRef) {
    const gate = customsGateStatus(ctx.graph, ctx.owner, ref);
    if (gate.status !== 'pass_sandbox') fail(`Customs hard gate ${gate.status}: ${gate.checks.filter(c => c.result !== 'pass').map(c => `${c.id}: ${c.reason}`).join('; ')}`);
    return gate;
  }
  private gateEvaluation(ctx: AgentProgramContext, ref: ObjectRef, reads: PlanningSnapshot) {
    for (const name of ['shippingGateStatus', 'customsGateStatus']) {
      const call = { function: name, object: ref }, result = ctx.graph.evaluate(ctx.owner, call);
      const receipt = reads.reads.find(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(call) && r.outputDigest === digest(result));
      if (receipt && result.status === 'known' && (result.value as { status?: string })?.status === 'pass_sandbox') return receipt;
    }
  }
  validatePlanning(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot) {
    if (Object.hasOwn(stripePaymentActionSchemas, action)) { this.stripe!.validatePlanning(ctx, action, input, reads); return; }
    const gateInput = action === 'QuoteCommerceLandedCost' ? input.customs : action === 'PrepareCommerceCheckout' ? input.quote : ['SubmitCommerceOrder', 'SubmitCommerceUnpaidOrder'].includes(action) ? input.checkout : undefined;
    if (gateInput) {
      const ref = objectRefSchema.parse(gateInput), evaluated = this.gateEvaluation(ctx, ref, reads);
      const queried = (ref: ObjectRef) => reads.reads.some(r => r.tool === 'query_ontology' && r.status === 'ok' && evaluated && r.at <= evaluated.at && (r.objects.some(o => equal(o.ref, ref)) || r.inputDigest === digest({ object: ref }) || r.inputDigest === digest({ from: { type: 'ServiceRequest', id: ctx.request.id }, link: ref.type === 'CustomsRuleSet' ? 'customsRuleSets' : 'regulatoryReferences' })));
      if (!queried(CUSTOMS_RULE_REF) || CUSTOMS_REFERENCE_REFS.some(ref => !queried(ref)) || !evaluated) fail('The Agent must query the exact customs rule set and references, then evaluate customsGateStatus for this decision');
    }
    if (action === 'PrepareCommerceCheckout') this.requireEvaluation(ctx, objectRefSchema.parse(input.quote), reads, true);
    if (['SubmitCommerceOrder', 'SubmitCommerceUnpaidOrder'].includes(action)) this.requireEvaluation(ctx, objectRefSchema.parse(input.checkout), reads, true);
  }
  validatePause(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot) {
    validatePlanningSnapshot(ctx.graph, ctx.owner, ctx.request, reads, true);
    if (decision.kind === 'no_feasible_plan') {
      const hasProviderFacts = ctx.state.observations.some(r => ['CommerceProduct', 'InventoryObservation', 'FulfillmentPlan', 'CustomsAssessment', 'LandedCostQuote'].includes(r.type));
      if (!hasProviderFacts) {
        const ref = ctx.state.observations.filter(r => r.type === 'CommerceMerchantSearch').at(-1) ?? fail('Query available merchant and fulfillment sources before rejecting the business goal');
        const directory = parseCommerceEntity('CommerceMerchantSearch', this.facts(ctx, ref, 'CommerceMerchantSearch').data);
        this.requireEvaluation(ctx, ref, reads);
        if (directory.query !== this.scope(ctx).query || directory.merchants.length) fail('Only an evaluated empty directory for the requested query establishes this registered-source coverage gap');
      }
      return;
    }
    const information = decision.informationRequest ?? fail('A commerce clarification must identify the missing PA fact in informationRequest');
    const scope = this.scope(ctx);
    if (information.fact === 'requested_quantity' && scope.quantity === null || information.fact === 'product_need' && scope.query === null) return;
    if (!['destination_choice', 'delivery_address'].includes(information.fact)) fail('This missing fact belongs to a provider source; query it instead of asking PA to invent business facts');
    const ref = information.evidenceRefs.find(r => r.type === 'FulfillmentContext') ?? fail('Read PA context before asking for its address information');
    this.requireEvaluation(ctx, ref, reads);
    const context = this.facts(ctx, ref, 'FulfillmentContext'), assessment = commerceObservationReadiness(ctx.graph, ctx.owner, context);
    if (!assessment.gaps.some(g => g.fact === information.fact)) fail('The selected PA context already resolves this question');
  }
  authority(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    this.validate(ctx, action, input);
    if (Object.hasOwn(stripePaymentActionSchemas, action)) return this.stripe!.authority(ctx, action, input);
    if (['SubmitCommerceOrder', 'SubmitCommerceUnpaidOrder'].includes(action)) { const s = this.facts(ctx, input.checkout, 'CommerceCheckout'), d = parseCommerceEntity('CommerceCheckout', s.data); return { cost: { ...d.total, ...(action === 'SubmitCommerceUnpaidOrder' ? { minor: '0' } : {}), payeeId: d.merchantId },
      budgetImpact: { key: `commerce-checkout:${digest({ merchant: d.merchantId, checkoutId: d.checkoutId })}`, kind: action === 'SubmitCommerceUnpaidOrder' ? 'commitment' as const : 'spend' as const, role: 'service_total' as const, amount: d.total },
      operationScope: `commerce-order:${digest({ configuration: this.configurationDigest, merchant: d.merchantId, checkoutId: d.checkoutId })}` }; }
    const ref = input.quote ?? input.cart ?? input.product, s = this.facts(ctx, ref), d = s.data as { merchantId: string; unitPrice?: { currency: string }; estimatedTotal?: { currency: string }; buyerTotal?: { currency: string }; cartId?: string; revision?: string };
    const currency = d.unitPrice?.currency ?? d.estimatedTotal?.currency ?? d.buyerTotal?.currency ?? fail('A sandbox draft needs an explicit source currency');
    return { cost: { minor: '0', currency, payeeId: d.merchantId }, ...(['UpdateCommerceCart', 'CancelCommerceCart'].includes(action) ? { operationScope: `commerce-cart:${digest({ configuration: this.configurationDigest, cartId: d.cartId, revision: d.revision, action })}` } : action === 'PrepareCommerceCheckout' ? { operationScope: `commerce-checkout:${digest({ configuration: this.configurationDigest, quote: s.sourceId })}` } : {}) };
  }
  private transportInput(ctx: AgentProgramContext, action: CommerceJourneyAction, input: Record<string, unknown>) {
    const get = <T extends CommerceEntityType>(key: string, type: T) => { const s = this.facts(ctx, input[key], type, ['ReadCommerceCart', 'ReadCommerceOrder', 'ReadCommercePayment', 'ReadCommerceDelivery'].includes(action)); return { s, data: parseCommerceEntity(type, s.data) }; };
    if (action === 'ReadCommerceContext') return { contextKey: this.scope(ctx).contextKey ?? 'default' };
    if (action === 'SearchCommerceMerchants') return { query: input.query };
    if (action === 'ReadCommerceProduct') { const budget = this.requirements(ctx).find(r => r.kind === 'budget'); return { merchantId: input.merchantId, query: input.query, ...(budget?.kind === 'budget' ? { currency: budget.expected.currency } : {}) }; }
    if (action === 'ReadCommerceInventory' || action === 'CreateCommerceCart') { const p = get('product', 'CommerceProduct').data; return { merchantId: p.merchantId, variantId: p.variantId, quantity: input.quantity, currency: p.unitPrice.currency }; }
    if (action === 'ReadCommerceFulfillment') { const p = get('product', 'CommerceProduct').data, inv = get('inventory', 'InventoryObservation'), c = get('context', 'FulfillmentContext'), a = c.data.addresses.find(a => a.id === input.addressId)!; return { merchantId: p.merchantId, variantId: p.variantId, quantity: input.quantity, inventoryId: inv.s.sourceId, contextKey: c.data.contextKey, addressId: a.id, addressRevision: a.revision, destinationDigest: postalAddressDigest(a.address), currency: p.unitPrice.currency }; }
    if (action === 'ReadCommerceCustoms') { const p = get('product', 'CommerceProduct').data, f = get('fulfillment', 'FulfillmentPlan'); return { merchantId: p.merchantId, variantId: p.variantId, fulfillmentId: f.s.sourceId, optionId: input.optionId }; }
    if (action === 'QuoteCommerceLandedCost') { const p = get('product', 'CommerceProduct').data; return { merchantId: p.merchantId, variantId: p.variantId, inventoryId: get('inventory', 'InventoryObservation').s.sourceId, fulfillmentId: get('fulfillment', 'FulfillmentPlan').s.sourceId, optionId: input.optionId, customsId: get('customs', 'CustomsAssessment').s.sourceId }; }
    if (action === 'UpdateCommerceCart') { const c = get('cart', 'Cart').data, p = get('product', 'CommerceProduct').data; return { cartId: c.cartId, expectedRevision: c.revision, merchantId: p.merchantId, variantId: p.variantId, quantity: input.quantity, currency: p.unitPrice.currency }; }
    if (action === 'CancelCommerceCart') { const c = get('cart', 'Cart').data; return { cartId: c.cartId, expectedRevision: c.revision }; }
    if (action === 'ReadCommerceCart') return { cartId: get('cart', 'Cart').data.cartId };
    if (action === 'PrepareCommerceCheckout') { const q = get('quote', 'LandedCostQuote'); return { quoteId: q.s.sourceId, sourceQuoteDigest: q.s.receipt.payloadDigest, quoteDigest: q.s.contentDigest, ...(input.cart ? { cartId: get('cart', 'Cart').data.cartId } : {}) }; }
    if (['SubmitCommerceOrder', 'SubmitCommerceUnpaidOrder'].includes(action)) { const c = get('checkout', 'CommerceCheckout').data; return { checkoutId: c.checkoutId, quoteDigest: c.quoteDigest, expectedTotal: c.total, expectedDestinationDigest: c.destinationDigest }; }
    const order = get('order', 'CommerceOrderObservation').data; return { orderId: order.orderId, merchantId: order.merchantId };
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    if (Object.hasOwn(stripePaymentActionSchemas, action)) return this.stripe!.invoke(ctx, action, input, signal);
    const result = await this.connector.call(ctx, action as CommerceJourneyAction, this.transportInput(ctx, action as CommerceJourneyAction, input), signal);
    this.validateResult(action, result); return { value: result, evidenceRefs: [result.receipt.id] };
  }
  async recover(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult | undefined> {
    if (Object.hasOwn(stripePaymentActionSchemas, action)) return this.stripe!.recover(ctx, action, _input, signal);
    const result = await this.connector.recover(ctx, signal); if (!result) return;
    this.validateResult(action, result); return { value: result, evidenceRefs: [result.receipt.id] };
  }
  private validateResult(action: string, result: CommerceSourceResult) {
    const m = commerceActionMetadata[action as CommerceJourneyAction];
    if (result.payload.type !== m.type || result.receipt.source !== m.source) fail('Source returned a different business object or source role');
    parseCommerceEntity(result.payload.type, result.payload.data);
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult) { return Object.hasOwn(stripePaymentActionSchemas, action) ? this.stripe!.project(ctx, action, result) : projectCommerceObservation(ctx, action, input, result.value as CommerceSourceResult); }
  projectOutputs(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef) {
    const view = ctx.graph.read(ctx.owner, object), snapshot = view.properties.snapshot as { expiresAt?: string };
    return objectResultProjection(object, { origin: view.source.kind === 'provider' ? 'provider' : 'synthetic', refs: result.evidenceRefs, observedAt: view.source.observedAt,
      ...(snapshot.expiresAt ? { expiresAt: snapshot.expiresAt } : {}) }, !!ctx.graph.model.action(action).composition?.outputs.identity, !!ctx.graph.model.action(action).composition?.outputs.citations);
  }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    const proposal = completion.parse(raw), scope = this.scope(ctx);
    for (const ref of [proposal.selected, proposal.cart, proposal.order, proposal.payment, proposal.delivery].filter((r): r is ObjectRef => !!r && r.type !== 'StripePaymentObservation')) this.requireEvaluation(ctx, ref, reads, true);
    const selected = this.facts(ctx, proposal.selected), expectedType = ({ quote: 'LandedCostQuote', cart: 'Cart', checkout: 'CommerceCheckout', order: 'CommerceOrderObservation', payment: 'CommerceOrderObservation', delivery: 'CommerceOrderObservation' } as const)[scope.target];
    if (selected.type !== expectedType) fail('Selected evidence does not match the requested completion endpoint');
    const conditions = ['commerce.sandbox_only'], evidenceRefs = [selected.receipt.id], data: Record<string, unknown> = { environment: 'sandbox', realOperationsAllowed: false, target: scope.target, selected: selected.data, source: proposal.selected, evidenceLevel: 'synthetic' };
    const facts: CandidateFacts = { conditions };
    const findQuote = (s: CommerceObservation, seen = new Set<string>()): CommerceObservation | undefined => {
      if (seen.has(s.contentDigest)) return; seen.add(s.contentDigest); if (s.type === 'LandedCostQuote') return s;
      for (const d of s.dependencies) { const found = findQuote(checkedCommerceObservation(ctx.graph.read(ctx.owner, d.ref).properties.snapshot), seen); if (found) return found; }
    };
    const quote = findQuote(selected);
    if (quote) {
      const q = parseCommerceEntity('LandedCostQuote', quote.data); data.quote = q;
      const plan = ctx.state.plans.find(p => p.id === quote.receipt.planId) ?? fail('The selected quote has no recorded model plan');
      const step = plan.steps.find(s => s.intentId === quote.receipt.intentId);
      const assessmentRef = quote.dependencies.find(d => d.ref.type === 'CustomsAssessment')?.ref ?? fail('The selected quote has no bound customs assessment');
      const gateRead = plan.ontologyPlanning.reads.find(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && ['shippingGateStatus', 'customsGateStatus'].some(name => r.inputDigest === digest({ function: name, object: assessmentRef }))) ?? fail('The selected quote has no recorded model shipping gate evaluation');
      if (step?.action !== 'QuoteCommerceLandedCost') fail('The selected quote came from a different action');
      data.customsPolicy = { ruleSet: CUSTOMS_RULE_REF, policyDigest: CUSTOMS_POLICY_DIGEST, evaluatedAt: gateRead.at, modelRunId: plan.modelRunId, evaluationDigest: gateRead.outputDigest, coverage: 'synthetic_commerce_only', legalApproval: false, references: CUSTOMS_REFERENCES.map(r => ({ title: r.title, url: r.url, documentVersion: r.documentVersion, capturedAt: r.capturedAt })) };
      const assessment = parseCommerceEntity('CustomsAssessment', checkedCommerceObservation(ctx.graph.read(ctx.owner, assessmentRef).properties.snapshot).data);
      data.shippingPolicy = { shipping: { regime: assessment.shippingRegime, routeDigest: assessment.routeDigest }, customsApplicability: assessment.status === 'not_applicable' ? 'not_applicable' : 'required', evaluatedAt: gateRead.at, evaluationDigest: gateRead.outputDigest, coverage: 'synthetic_commerce_only', legalApproval: false, policyDigest: CUSTOMS_POLICY_DIGEST };
      facts.totalPrice = q.buyerTotal; facts.amounts = { service_total: q.buyerTotal }; facts.quantity = { amount: String(q.quantity), unit: 'piece' }; facts.quantities = { item_quantity: facts.quantity };
      conditions.push('commerce.stock_confirmed', 'commerce.customs_checked', 'commerce.all_buyer_fees');
      const commitments = q.promises.filter(p => p.kind === 'commitment' && p.milestone === 'arrival' && p.latestAt && p.conditions.every(c => c.status === 'met'));
      if (q.groups.every(g => commitments.some(p => p.groupIds.includes(g.id)))) { conditions.push('commerce.delivery_promised'); facts.deliveryBy = commitments.map(p => p.latestAt!).sort().at(-1); facts.deadlines = { arrival: facts.deliveryBy, completion: facts.deliveryBy }; }
      const route = quote.dependencies.map(d => checkedCommerceObservation(ctx.graph.read(ctx.owner, d.ref).properties.snapshot)).find(s => s.type === 'FulfillmentPlan');
      if (route) { const f = parseCommerceEntity('FulfillmentPlan', route.data), context = route.dependencies.map(d => checkedCommerceObservation(ctx.graph.read(ctx.owner, d.ref).properties.snapshot)).find(s => s.type === 'FulfillmentContext');
        if (context) { const c = parseCommerceEntity('FulfillmentContext', context.data), address = c.addresses.find(a => a.id === f.addressId)!; data.destination = { label: address.label, address: address.address, revision: address.revision }; const required = this.requirements(ctx).find(r => r.kind === 'location' && (!r.role || r.role === 'destination')); facts.locationRef = required?.kind === 'location' ? required.expected.ref : address.label; facts.locations = { destination: facts.locationRef }; }
      }
    }
    if (scope.target === 'cart') { const cart = parseCommerceEntity('Cart', selected.data); if (cart.state !== 'active') fail('A canceled cart is not a prepared cart'); conditions.push('commerce.cart_created'); facts.quantity = { amount: String(cart.lines.reduce((n, l) => n + l.quantity, 0)), unit: 'piece' }; facts.quantities = { item_quantity: facts.quantity }; }
    if (scope.target === 'checkout') conditions.push('commerce.checkout_prepared');
    if (proposal.cart) { const cart = this.facts(ctx, proposal.cart, 'Cart'); if (cart.data.state === 'canceled') fail('A canceled cart cannot establish a current prepared cart'); data.cart = cart.data; conditions.push('commerce.cart_created'); evidenceRefs.push(cart.receipt.id); }
    let order: CommerceObservation | undefined;
    if (['order', 'payment', 'delivery'].includes(scope.target)) {
      order = this.facts(ctx, proposal.order ?? proposal.selected, 'CommerceOrderObservation');
      if (order.action !== 'ReadCommerceOrder' || !parseCommerceEntity('CommerceOrderObservation', order.data).independentRead || !quote) fail('Read the original order independently after submission before completing');
      if (!equal(order.data, selected.data)) fail('Selected completion order differs from the separately supplied order');
      conditions.push('commerce.order_confirmed', 'commerce.checkout_prepared'); data.order = order.data; evidenceRefs.push(order.receipt.id);
    }
    if (this.stripe && proposal.payment) {
      const payment = this.stripe.complete(ctx, proposal.payment, proposal.order ?? proposal.selected, reads);
      if (!order) fail('Stripe completion requires an independently selected original order');
      data.payment = payment.data; data.paymentEvidenceLevel = payment.evidenceLevel; data.bankSettlementVerified = false;
      conditions.push('commerce.payment_confirmed'); evidenceRefs.push(...payment.receipts.map(r => r.requestId));
    }
    if (scope.target === 'payment' && !conditions.includes('commerce.payment_confirmed')) fail('Payment completion requires independent Stripe test capture evidence');
    if (!this.stripe && proposal.payment) {
      const p = this.facts(ctx, proposal.payment, 'CommercePaymentObservation'), payment = parseCommerceEntity('CommercePaymentObservation', p.data), o = order && parseCommerceEntity('CommerceOrderObservation', order.data);
      if (!o || payment.orderId !== o.orderId || payment.merchantId !== o.merchantId || !equal(payment.amount, o.total)) fail('Payment receipt does not match the selected order and amount');
      if (payment.state === 'settled') conditions.push('commerce.payment_settled'); data.payment = payment; evidenceRefs.push(p.receipt.id);
    }
    if (scope.target === 'delivery') {
      if (!proposal.delivery || !proposal.payment || !conditions.includes('commerce.payment_settled')) fail('Delivery completion requires separate order, settled payment and delivery observations');
      const d = this.facts(ctx, proposal.delivery, 'CommerceDeliveryObservation'), delivery = parseCommerceEntity('CommerceDeliveryObservation', d.data), o = parseCommerceEntity('CommerceOrderObservation', order!.data), q = parseCommerceEntity('LandedCostQuote', quote!.data);
      if (delivery.orderId !== o.orderId || delivery.merchantId !== o.merchantId || delivery.destinationDigest !== o.destinationDigest || delivery.state !== 'delivered' || new Set(delivery.events.map(e => e.id)).size !== delivery.events.length) fail('Delivery identity, state or event uniqueness does not match the original order');
      const arrived = delivery.events.filter(e => e.milestone === 'delivered');
      if (!arrived.length || arrived.some(e => e.destinationDigest !== o.destinationDigest || Date.parse(e.occurredAt) > Date.parse(d.observedAt) || !q.groups.some(g => g.id === e.groupId && g.variantId === e.variantId)) || q.groups.some(g => arrived.filter(e => e.groupId === g.id && e.variantId === g.variantId).reduce((n, e) => n + e.quantity, 0) !== g.quantity)) fail('Actual delivered events do not cover every original package exactly');
      facts.deliveryBy = arrived.map(e => e.occurredAt).sort().at(-1); facts.deadlines = { arrival: facts.deliveryBy, completion: facts.deliveryBy };
      data.delivery = delivery; evidenceRefs.push(d.receipt.id); conditions.push('commerce.delivery_verified');
    }
    data.provenance = { sourceRefs: [proposal.selected, proposal.cart, proposal.order, proposal.payment, proposal.delivery].filter(Boolean), receiptIds: [...new Set(evidenceRefs)], modelSelected: true, noRealTransaction: true };
    // The overall commerce outcome still depends on synthetic orders; payment
    // keeps its separate source level in data.paymentEvidenceLevel.
    return { evidenceLevel: 'synthetic', artifact: { id: digest({ request: ctx.request.id, revision: ctx.request.revision, data }), name: this.stripe ? 'commerce-stripe-test-result.json' : 'commerce-sandbox-result.json', data: { goal: ctx.request.originalGoal, deliverable: this.stripe ? `Agent 已核验 ${scope.target} 测试结果；商品和订单属于隔离沙箱，Stripe 支付证据单独标记来源层级，未发生真实交易。` : `Agent 已核验沙箱 ${scope.target} 结果；商家、地址、库存、跨境费用及履约事实均按来源证据记录，未发生真实交易。`, execution: 'completed', result: data } }, facts, evidenceRefs };
  }
}
