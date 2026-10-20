import { z } from 'zod';
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

const selectedRef = objectRefSchema;
const completion = z.strictObject({ selected: selectedRef, cart: selectedRef.optional(), order: selectedRef.optional(), payment: selectedRef.optional(), delivery: selectedRef.optional(), rationale: z.string().min(1).max(2000) });
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const supportedPredicates = ['commerce.sandbox_only', 'commerce.stock_confirmed', 'commerce.customs_checked', 'commerce.all_buyer_fees', 'commerce.delivery_promised', 'commerce.cart_created', 'commerce.checkout_prepared', 'commerce.order_confirmed', 'commerce.payment_settled', 'commerce.delivery_verified'];
export class CommerceAgentProgram implements AgentProgram {
  readonly ref = { id: 'commerce.journey.sandbox', version: '2' };
  readonly actionIds = Object.keys(commerceJourneyActionSchemas);
  readonly configurationDigest: string;
  readonly limits = { modelTurns: 72, plans: 24, actions: 56 };
  readonly completionSchema = z.toJSONSchema(completion);
  readonly connector: CommerceSandboxConnector;
  readonly guidance = [
    'This is the explicitly isolated commerce sandbox. All merchant, PA-context, customs, payment and shipping responses are synthetic source evidence; never present them as real-world transactions or tariff rules. You decide the business action sequence and which merchant, product and shipping option to select. Queries and drafts are not purchase authority.',
    'The CommerceTask starts without merchant or country facts. Query authorized PA context and merchant directory yourself. A merchant registration country, actual dispatch warehouse, goods customs origin, shopping market and delivery country are different facts. Read provider facts through the available source actions; do not ask PA to supply merchant warehouse, HS code, taxes or shipping facts that these actions can query.',
    'Query the supplied CommerceTask and relevant exact observation refs; commerceJourneyStatus reports evidence and stage gaps. commerceObservationStatus independently validates one observation and returns assessment.status plus gaps. You must actually evaluate the quote before PrepareCommerceCheckout and the checkout before SubmitCommerceOrder. Each sandbox write uses a separate frontier and requires the exact PA permit through the existing authorization interface.',
    `Read policy through query_ontology with from=the current ServiceRequest and link="customsRuleSets", then read the same request's link="regulatoryReferences". These direct request relationships work with your scoped permissions; do not search owner-wide objects or traverse arbitrary relationships. The current rule set is ${JSON.stringify(CUSTOMS_RULE_REF)}. Official reference documents are supporting information, not legal eligibility or permission. Before QuoteCommerceLandedCost, evaluate customsGateStatus on its exact CustomsAssessment; before PrepareCommerceCheckout, evaluate it on the exact LandedCostQuote; before SubmitCommerceOrder, evaluate it on the exact CommerceCheckout. In the same decision, query the rule set and its reference documents before evaluating. Only pass_sandbox may proceed. First obtain observations, then evaluate; an unobserved future action output cannot satisfy this gate.`,
    'Missing, expired, conflicting or unsupported regulatory evidence stops purchasing. A PA authorization cannot override that result. Tobacco and unsupported regulated categories are outside this program; do not propose procurement or forwarding routes for them. If an actually read and evaluated directory contains no merchants, report the limited registered-source coverage through no_feasible_plan; do not infer worldwide unavailability or ask PA to repair a missing provider integration.',
    'For ambiguous saved addresses, first read and evaluate FulfillmentContext. Then clarify with informationRequest={fact:"destination_choice",evidenceRefs:[contextRef]}, listing the source labels in message and asking PA to return the chosen label as a structured location requirement with role destination. Do not infer a choice from PA location, IP or language. A single usable address or explicit preferredAddressId can be used without an unnecessary question. A missing quantity or query can be clarified with fact requested_quantity or product_need. Other missing facts must be queried from their source.',
    'Do not create a fixed search/detail/shipping recipe. Read the exact facts required for the next decision, inspect alternative merchants when supply or terms fail, and adapt to changed evidence. A quote may cover seller-borne unknown tax amounts only with explicit responsibility evidence; never treat unknown buyer fees as zero. Shipment promises must cover every package, quantity and destination and satisfy any hard arrival deadline.',
    'For complete: selected identifies the current terminal evidence for target quote/cart/checkout/order, or the independently read order for target delivery; include order/payment/delivery refs when required. Every selected ref must have been read and evaluated with commerceObservationStatus in this decision. Delivery requires a separately read original order, settled simulated payment and actual synthetic delivery events for every package. Order confirmation alone proves neither settlement nor arrival.',
    'If a write response is lost, the runtime reads only its original idempotency key. Never select a duplicate write to solve uncertainty. Retain the original business identity. No live checkout, payment or merchant endpoint is supported.',
  ].join('\n');
  constructor(options: CommerceSandboxOptions & { connector?: CommerceSandboxConnector }) {
    this.connector = options.connector ?? new HttpCommerceSandboxConnector(options);
    this.configurationDigest = digest({ connector: this.connector.configurationDigest, semantics: 'commerce-journey-v2', customsPolicyDigest: CUSTOMS_POLICY_DIGEST });
  }
  permitted(owner: string) { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: { id: 'eigos.commerce.journey', version: '2' }, name: 'Agent 自主沙箱交易与履约', environment: 'sandbox', tags: ['commerce', 'agent', 'sandbox', 'cross-border'],
      description: '仅在隔离沙箱比较商家、查询 PA 保存地址、库存、仓库、跨境税费和配送承诺，自主形成报价或创建模拟购物车、结账、订单、付款与交付回读。商家、国家与地址无需预先提供，缺失时 input query/quantity/contextKey 可为 null；先通过动作获取事实，只有用户选择才问 PA。数量为所选商品变体件数，袋装咖啡的一袋是一件 piece。target 明确为 quote/cart/checkout/order/delivery；购物车可以独立准备。所有业务证据为 synthetic，禁止真实购买付款。',
      inputSchema: z.toJSONSchema(commerceJourneyInputSchema), constraintEvaluation: 'staged', actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: commerceActionMetadata[id as CommerceJourneyAction].effect, additionalEffects: commerceActionMetadata[id as CommerceJourneyAction].additionalEffects })),
      predicates: supportedPredicates.map(id => ({ id, description: ({ 'commerce.sandbox_only': 'All activity stays in the isolated sandbox; no real transaction', 'commerce.stock_confirmed': 'Source confirms capacity for the requested quantity', 'commerce.customs_checked': 'Applicable synthetic import and customs requirements are resolved', 'commerce.all_buyer_fees': 'Buyer total includes every mandatory buyer-paid charge', 'commerce.delivery_promised': 'Source arrival commitments cover all selected packages and hard deadlines', 'commerce.cart_created': 'Owned sandbox draft cart exists', 'commerce.checkout_prepared': 'Exact sandbox checkout is prepared', 'commerce.order_confirmed': 'Original sandbox order independently read and matched', 'commerce.payment_settled': 'Separate simulated payment receipt confirms settlement', 'commerce.delivery_verified': 'Separate synthetic delivered events cover the exact ordered goods and destination' } as Record<string, string>)[id]! })), outcomePredicates: supportedPredicates,
      requirementRoles: [{ kind: 'quantity', role: 'item_quantity', description: 'Selected merchant variant count in piece units' }, { kind: 'budget', role: 'service_total', description: 'Complete buyer cost including all buyer-paid freight, tax, duty and clearance fees' }, { kind: 'deadline', role: 'arrival', description: 'All ordered packages must arrive by the explicit source-bound deadline' }, { kind: 'location', role: 'destination', description: 'Explicit saved-address label or ID selected by PA; an unspecified saved address is discovered through ReadCommerceContext' }], locationSemantics: 'destination',
      ontology: { objects: ['CommerceTask', 'FulfillmentContext', 'CommerceProduct', 'InventoryObservation', 'FulfillmentPlan', 'CustomsAssessment', 'LandedCostQuote', 'Cart', 'CommerceCheckout', 'CommerceOrderObservation', 'CommercePaymentObservation', 'CommerceDeliveryObservation', 'CustomsRuleSet', 'RegulatoryReference'], functions: ['commerceJourneyStatus', 'commerceObservationStatus', 'customsGateStatus'], execution: 'agent_selected_atomic_actions', realSourceConnected: false }, verifierRef: { id: 'commerce.journey.independent', version: '2' }, completion: 'domain' };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown) {
    if (!this.permitted(owner) || request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'Commerce journey is available only to the configured local sandbox identity');
    const input = commerceJourneyInputSchema.parse(raw), scope = { type: 'CommerceTask', id: `${request.id}:r${request.revision}` };
    const requirements = request.requirements.map(({ provenance: _provenance, ...requirement }) => requirement);
    const quantities = requirements.filter(r => r.kind === 'quantity' && r.strength === 'hard' && (!r.role || r.role === 'item_quantity'));
    if (input.quantity === null && quantities.length === 1 && quantities[0]!.kind === 'quantity' && quantities[0]!.expected.unit === 'piece') input.quantity = Number(quantities[0]!.expected.amount);
    commerceJourneyInputSchema.parse(input);
    for (const r of requirements) if (r.kind === 'quantity' && r.strength === 'hard' && (!r.role || r.role === 'item_quantity') && (r.expected.unit !== 'piece' || input.quantity !== null && String(input.quantity) !== r.expected.amount)) fail('The selected quantity must match the explicit user item count');
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: 'Agent 沙箱交易范围', requestRevision: request.revision, input, requirements, configurationDigest: this.configurationDigest, allowedActions: this.actionIds, environment: 'sandbox' } }], links: [{ type: 'CommerceTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    seedCustomsPolicy(graph, owner, scope, { type: 'ServiceRequest', id: request.id });
    return { scope, input };
  }
  schema(action: string) { if (!Object.hasOwn(commerceJourneyActionSchemas, action)) throw new DomainError('FORBIDDEN', 'Unknown commerce action'); return commerceJourneyActionSchemas[action as CommerceJourneyAction]; }
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
    if (action === 'SubmitCommerceOrder') { this.ready(ctx, get('checkout', 'CommerceCheckout').s); this.requireCustomsGate(ctx, objectRefSchema.parse(input.checkout)); }
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
  validatePlanning(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot) {
    const gateInput = action === 'QuoteCommerceLandedCost' ? input.customs : action === 'PrepareCommerceCheckout' ? input.quote : action === 'SubmitCommerceOrder' ? input.checkout : undefined;
    if (gateInput) {
      const ref = objectRefSchema.parse(gateInput), call = { function: 'customsGateStatus', object: ref }, result = ctx.graph.evaluate(ctx.owner, call);
      if (result.status !== 'known' || (result.value as { status?: string } | undefined)?.status !== 'pass_sandbox') fail('The current customs hard gate has not passed');
      const evaluated = reads.reads.find(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(call) && r.outputDigest === digest(result));
      const queried = (ref: ObjectRef) => reads.reads.some(r => r.tool === 'query_ontology' && r.status === 'ok' && evaluated && r.at <= evaluated.at && (r.objects.some(o => equal(o.ref, ref)) || r.inputDigest === digest({ object: ref }) || r.inputDigest === digest({ from: { type: 'ServiceRequest', id: ctx.request.id }, link: ref.type === 'CustomsRuleSet' ? 'customsRuleSets' : 'regulatoryReferences' })));
      if (!queried(CUSTOMS_RULE_REF) || CUSTOMS_REFERENCE_REFS.some(ref => !queried(ref)) || !evaluated) fail('The Agent must query the exact customs rule set and references, then evaluate customsGateStatus for this decision');
    }
    if (action === 'PrepareCommerceCheckout') this.requireEvaluation(ctx, objectRefSchema.parse(input.quote), reads, true);
    if (action === 'SubmitCommerceOrder') this.requireEvaluation(ctx, objectRefSchema.parse(input.checkout), reads, true);
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
    if (action === 'SubmitCommerceOrder') { const s = this.facts(ctx, input.checkout, 'CommerceCheckout'), d = parseCommerceEntity('CommerceCheckout', s.data); return { cost: { ...d.total, payeeId: d.merchantId }, operationScope: `commerce-order:${digest({ configuration: this.configurationDigest, merchant: d.merchantId, checkoutId: d.checkoutId })}` }; }
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
    if (action === 'SubmitCommerceOrder') { const c = get('checkout', 'CommerceCheckout').data; return { checkoutId: c.checkoutId, quoteDigest: c.quoteDigest, expectedTotal: c.total, expectedDestinationDigest: c.destinationDigest }; }
    const order = get('order', 'CommerceOrderObservation').data; return { orderId: order.orderId, merchantId: order.merchantId };
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    const result = await this.connector.call(ctx, action as CommerceJourneyAction, this.transportInput(ctx, action as CommerceJourneyAction, input), signal);
    this.validateResult(action, result); return { value: result, evidenceRefs: [result.receipt.id] };
  }
  async recover(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult | undefined> {
    const result = await this.connector.recover(ctx, signal); if (!result) return;
    this.validateResult(action, result); return { value: result, evidenceRefs: [result.receipt.id] };
  }
  private validateResult(action: string, result: CommerceSourceResult) {
    const m = commerceActionMetadata[action as CommerceJourneyAction];
    if (result.payload.type !== m.type || result.receipt.source !== m.source) fail('Source returned a different business object or source role');
    parseCommerceEntity(result.payload.type, result.payload.data);
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult) { return projectCommerceObservation(ctx, action, input, result.value as CommerceSourceResult); }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    const proposal = completion.parse(raw), scope = this.scope(ctx);
    for (const ref of [proposal.selected, proposal.cart, proposal.order, proposal.payment, proposal.delivery].filter((r): r is ObjectRef => !!r)) this.requireEvaluation(ctx, ref, reads, true);
    const selected = this.facts(ctx, proposal.selected), expectedType = ({ quote: 'LandedCostQuote', cart: 'Cart', checkout: 'CommerceCheckout', order: 'CommerceOrderObservation', delivery: 'CommerceOrderObservation' } as const)[scope.target];
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
      const gateRead = plan.ontologyPlanning.reads.find(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest({ function: 'customsGateStatus', object: assessmentRef })) ?? fail('The selected quote has no recorded model customs gate evaluation');
      if (step?.action !== 'QuoteCommerceLandedCost') fail('The selected quote came from a different action');
      data.customsPolicy = { ruleSet: CUSTOMS_RULE_REF, policyDigest: CUSTOMS_POLICY_DIGEST, evaluatedAt: gateRead.at, modelRunId: plan.modelRunId, evaluationDigest: gateRead.outputDigest, coverage: 'synthetic_commerce_only', legalApproval: false, references: CUSTOMS_REFERENCES.map(r => ({ title: r.title, url: r.url, documentVersion: r.documentVersion, capturedAt: r.capturedAt })) };
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
    if (scope.target === 'order' || scope.target === 'delivery') {
      order = this.facts(ctx, proposal.order ?? proposal.selected, 'CommerceOrderObservation');
      if (order.action !== 'ReadCommerceOrder' || !parseCommerceEntity('CommerceOrderObservation', order.data).independentRead || !quote) fail('Read the original order independently after submission before completing');
      if (!equal(order.data, selected.data)) fail('Selected completion order differs from the separately supplied order');
      conditions.push('commerce.order_confirmed', 'commerce.checkout_prepared'); data.order = order.data; evidenceRefs.push(order.receipt.id);
    }
    if (proposal.payment) {
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
    return { artifact: { id: digest({ request: ctx.request.id, revision: ctx.request.revision, data }), name: 'commerce-sandbox-result.json', data: { goal: ctx.request.originalGoal, deliverable: `Agent 已核验沙箱 ${scope.target} 结果；商家、地址、库存、跨境费用及履约事实均按来源证据记录，未发生真实交易。`, execution: 'completed', result: data } }, facts, evidenceRefs };
  }
}
