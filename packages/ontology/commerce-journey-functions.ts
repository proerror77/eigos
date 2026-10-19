import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { commerceObservationSchema, commerceEntitySchemas, commerceJourneyInputSchema, parseCommerceEntity, type CommerceObservation, type CommerceEntityType, type CommerceEntityData, type PostalAddress } from './commerce-journey.js';
import { requirementSchema, type RequirementInput } from './execution.js';
import { sourceProof } from './object-evidence.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';
import type { Computation } from './object-functions.js';

const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
export function postalAddressDigest(address: PostalAddress) { return digest(address); }
export function addressHasDeliveryStructure(address: PostalAddress) { return !!(address.street?.trim() && (address.city?.trim() || address.postalCode?.trim())); }
export function sourcePayloadDigest(s: Pick<CommerceObservation, 'type' | 'sourceId' | 'sourceVersion' | 'data' | 'expiresAt'>) { return digest({ type: s.type, sourceId: s.sourceId, sourceVersion: s.sourceVersion, data: s.data, expiresAt: s.expiresAt }); }
export function checkedCommerceObservation(raw: unknown): CommerceObservation {
  const s = commerceObservationSchema.parse(raw), { contentDigest, ...body } = s;
  parseCommerceEntity(s.type, s.data);
  if (digest(body) !== contentDigest || s.receipt.requestId !== s.requestId || s.receipt.requestRevision !== s.requestRevision || s.receipt.action !== s.action || Date.parse(s.expiresAt) <= Date.parse(s.observedAt) || Date.parse(s.observedAt) !== Date.parse(s.receipt.receivedAt)) fail('Commerce observation provenance or validity changed');
  if (!s.projectedFrom && s.receipt.payloadDigest !== sourcePayloadDigest(s)) fail('Commerce facts differ from the validated source payload');
  return s;
}
const contractual = (type: string) => ['CommerceOrderObservation', 'CommercePaymentObservation', 'CommerceDeliveryObservation'].includes(type);
const businessData = (s: CommerceObservation) => { const { independentRead: _read, ...data } = s.data; return data; };
export function readCommerceObservation(graph: OntologyObjectStore, owner: string, ref: ObjectRef, options: { at?: number; budget?: ReadBudget; memo?: Map<string, CommerceObservation>; active?: Set<string> } = {}): CommerceObservation {
  if (!Object.hasOwn(commerceEntitySchemas, ref.type)) fail('Not a commerce source observation');
  const at = options.at ?? graph.now(), budget = options.budget ?? { remaining: 5000 }, memo = options.memo ?? new Map<string, CommerceObservation>(), active = options.active ?? new Set<string>();
  const key = digest({ ref, at }); if (memo.has(key)) return memo.get(key)!; if (active.has(key) || active.size >= 24) fail('Cyclic or excessive commerce evidence dependencies');
  active.add(key);
  try {
    const record = graph.read(owner, ref, budget), s = checkedCommerceObservation(record.properties.snapshot), proof = sourceProof(graph, owner, ref, budget);
    if (!proof || s.type !== ref.type || !equal(record.properties.data, s.data) || s.receipt.ownerDigest !== digest(owner) || Date.parse(s.observedAt) > at || Date.parse(s.expiresAt) <= at) fail('Commerce facts are unproven, expired or from the future');
    const scopes = graph.related(owner, ref, 'scope', budget), requests = graph.related(owner, ref, 'request', budget);
    if (scopes?.length !== 1 || !equal(scopes[0]!.ref, s.scope) || scopes[0]!.properties.configurationDigest !== s.configurationDigest || scopes[0]!.properties.requestRevision !== s.requestRevision || requests?.length !== 1 || requests[0]!.ref.id !== s.requestId || requests[0]!.properties.revision !== s.requestRevision) fail('Commerce facts are outside the current owner, request or configured scope');
    const dependencies = graph.related(owner, ref, 'dependsOn', budget) ?? [];
    if (dependencies.length !== s.dependencies.length || s.dependencies.some(d => !dependencies.some(o => equal(o.ref, d.ref)))) fail('Commerce dependency relationships changed');
    for (const sibling of graph.related(owner, s.scope, `observed${s.type}`, budget) ?? []) {
      if (equal(sibling.ref, ref)) continue;
      const other = checkedCommerceObservation(sibling.properties.snapshot);
      if (other.sourceId !== s.sourceId || other.receipt.sourceIdentity !== s.receipt.sourceIdentity || Date.parse(other.observedAt) > at || !sourceProof(graph, owner, sibling.ref, budget)) continue;
      if (other.sourceVersion > s.sourceVersion || other.sourceVersion === s.sourceVersion && !equal(businessData(other), businessData(s))) fail('A newer or conflicting source version supersedes this commerce observation');
    }
    if (s.dependencyCheckedAt && Date.parse(s.dependencyCheckedAt) > Date.parse(s.observedAt)) fail('Commerce dependency check occurs after its observation');
    const parentAt = contractual(s.type) ? Date.parse(s.dependencyCheckedAt ?? s.receipt.startedAt) : at;
    for (const dependency of s.dependencies) {
      // Once an order is submitted, its agreed contract is verified as it was at
      // dispatch. New order/payment/delivery reads themselves remain current.
      const childRecord = graph.read(owner, dependency.ref, budget), child = checkedCommerceObservation(childRecord.properties.snapshot);
      const dependencyAt = dependency.checkedAt ? Date.parse(dependency.checkedAt) : contractual(s.type) && contractual(child.type) ? Date.parse(child.receipt.receivedAt) : parentAt;
      if (dependencyAt > at || dependency.checkedAt && dependencyAt > Date.parse(s.observedAt)) fail('Commerce dependency claims a future validation time');
      const checked = readCommerceObservation(graph, owner, dependency.ref, { at: dependencyAt, budget, memo, active });
      if (checked.contentDigest !== dependency.contentDigest) fail('Commerce input facts differ from the pinned source version');
    }
    if (s.projectedFrom) {
      const parent = readCommerceObservation(graph, owner, s.projectedFrom.parent, { at, budget, memo, active });
      let value: unknown = parent.data;
      for (const part of s.projectedFrom.path) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) fail('Derived commerce source path is unavailable'); value = (value as Record<string, unknown>)[part]; }
      if (!equal(value, s.data) || !equal(parent.receipt, s.receipt)) fail('Derived business facts do not match their original source');
    }
    memo.set(key, s); return s;
  } finally { active.delete(key); }
}

export interface CommerceReadiness { status: 'satisfied' | 'unsatisfied' | 'unknown'; gaps: { fact: string; source: string; reason: string; suggestedActions: string[] }[] }
export function assessLandedCost(data: CommerceEntityData<'LandedCostQuote'>, requirements: RequirementInput[], now = Date.now()): CommerceReadiness {
  const gaps: CommerceReadiness['gaps'] = []; let failed = false;
  const missing = (fact: string, source: string, reason: string, actions: string[], fail = false) => { gaps.push({ fact, source, reason, suggestedActions: actions }); if (fail) failed = true; };
  if (data.scope !== 'all_buyer_mandatory_fees' || data.priceKind !== 'firm') missing('bounded_buyer_cost', 'merchant', 'An estimate or partial quote cannot establish a firm complete buyer cost', ['QuoteCommerceLandedCost']);
  let sum = 0n;
  for (const c of data.components) {
    if (c.payer === 'unknown') missing('cost_responsibility', 'merchant', 'A mandatory cost has no evidenced payer', ['ReadCommerceCustoms', 'QuoteCommerceLandedCost']);
    if (c.payer === 'seller' && (!c.responsibilityEvidence || !c.coveredByTotal)) missing('seller_cost_coverage', 'merchant', 'Seller-borne unknown amounts need an explicit all-inclusive responsibility statement', ['QuoteCommerceLandedCost']);
    if (c.payer !== 'buyer') continue;
    if (!c.coveredByTotal || c.amountStatus !== 'fixed' || !c.amount || c.amount.currency !== data.buyerTotal.currency) { missing('buyer_cost_component', 'merchant', 'A buyer charge is unbounded, estimated or outside the total', ['QuoteCommerceLandedCost']); continue; }
    sum += (c.category === 'discount' ? -1n : 1n) * BigInt(c.amount.minor);
  }
  if (sum !== BigInt(data.buyerTotal.minor)) missing('cost_arithmetic', 'merchant', 'Buyer charge components do not reconcile to the quoted total', ['QuoteCommerceLandedCost'], true);
  const allocated = data.groups.reduce((n, g) => n + g.quantity, 0);
  if (new Set(data.groups.map(g => g.id)).size !== data.groups.length || data.groups.some(g => g.variantId !== data.variantId || g.destinationDigest !== data.destinationDigest) || allocated !== data.quantity) missing('package_allocation', 'fulfillment', 'Shipping groups do not cover exactly the selected goods and destination', ['ReadCommerceFulfillment'], true);
  for (const r of requirements.filter(r => r.strength === 'hard')) {
    if (r.kind === 'budget' && (!r.role || r.role === 'service_total') && (r.expected.currency !== data.buyerTotal.currency || BigInt(data.buyerTotal.minor) > BigInt(r.expected.minor))) missing('within_budget', 'merchant', 'Complete buyer cost exceeds the fixed budget or uses a different currency', ['ReadCommerceProduct', 'QuoteCommerceLandedCost'], true);
    if (r.kind === 'quantity' && (!r.role || r.role === 'item_quantity') && (r.expected.unit !== 'piece' || String(data.quantity) !== r.expected.amount)) missing('requested_quantity', 'merchant', 'The quoted item count differs from the requested count', ['ReadCommerceInventory'], true);
    if (r.kind === 'deadline' && (!r.role || ['arrival', 'completion'].includes(r.role))) {
      for (const g of data.groups) {
        const applicable = data.promises.filter(p => p.groupIds.includes(g.id) && p.milestone === 'arrival' && p.destinationDigest === data.destinationDigest);
        const promise = applicable.find(p => p.kind === 'commitment' && p.latestAt && Date.parse(p.expiresAt) > now && p.conditions.every(c => c.status === 'met'));
        if (!promise) missing('arrival_commitment', 'fulfillment', 'Each package needs a current arrival commitment whose conditions are met', ['ReadCommerceFulfillment']);
        else if (Date.parse(promise.latestAt!) > Date.parse(r.expected.at)) missing('arrival_deadline', 'fulfillment', 'A package commitment misses the requested deadline', ['ReadCommerceFulfillment'], true);
      }
    }
  }
  return { status: failed ? 'unsatisfied' : gaps.length ? 'unknown' : 'satisfied', gaps };
}

export function commerceScopeRequirements(graph: OntologyObjectStore, owner: string, scope: ObjectRef) { return z.array(requirementSchema).parse(graph.read(owner, scope).properties.requirements); }
export function commerceDestinationChoice(context: CommerceEntityData<'FulfillmentContext'>, requirements: RequirementInput[]) {
  const expected = requirements.filter(r => r.kind === 'location' && r.strength === 'hard' && (!r.role || r.role === 'destination')).map(r => r.kind === 'location' ? r.expected.ref : '');
  if (expected.length) { const matches = context.addresses.filter(a => expected.every(e => e === a.id || e === a.label)); return matches.length === 1 ? matches[0] : undefined; }
  if (context.preferredAddressId) return context.addresses.find(a => a.id === context.preferredAddressId);
  return context.addresses.length === 1 ? context.addresses[0] : undefined;
}
export function commerceObservationReadiness(graph: OntologyObjectStore, owner: string, s: CommerceObservation): CommerceReadiness {
  const dependencies = s.dependencies.map(d => checkedCommerceObservation(graph.read(owner, d.ref).properties.snapshot));
  const unknown = (fact: string, source: string, reason: string, actions: string[]): CommerceReadiness => ({ status: 'unknown', gaps: [{ fact, source, reason, suggestedActions: actions }] });
  const invalid = (fact: string, source: string, reason: string, actions: string[]): CommerceReadiness => ({ ...unknown(fact, source, reason, actions), status: 'unsatisfied' });
  const ancestor = (value: CommerceObservation, type: CommerceEntityType, seen = new Set<string>()): CommerceObservation | undefined => {
    if (value.type === type) return value; if (seen.has(value.contentDigest) || seen.size > 40) return; seen.add(value.contentDigest);
    for (const d of value.dependencies) { const found = ancestor(checkedCommerceObservation(graph.read(owner, d.ref).properties.snapshot), type, seen); if (found) return found; }
  };
  if (s.type === 'FulfillmentContext') {
    const data = parseCommerceEntity(s.type, s.data), selected = commerceDestinationChoice(data, commerceScopeRequirements(graph, owner, s.scope));
    if (!data.available || !data.addresses.length) return unknown('delivery_address', 'pa_context', 'The authorized PA context has no delivery address', []);
    if (!selected) return unknown('destination_choice', 'pa_choice', 'Several saved destinations exist without a current user choice', []);
    if (!selected.usable || !addressHasDeliveryStructure(selected.address)) return unknown('delivery_address', 'pa_choice', 'The selected address lacks the source-validated delivery structure', []);
  }
  if (s.type === 'InventoryObservation') {
    const data = parseCommerceEntity(s.type, s.data), supplied = data.locations.filter(l => l.availability === 'confirmed' && l.quantityState === 'sellable').reduce((n, l) => n + (l.confirmedQuantity ?? 0), 0);
    if (supplied < data.requestedQuantity) return { status: data.locations.every(l => l.availability === 'unavailable') ? 'unsatisfied' : 'unknown', gaps: [{ fact: 'quantity_capacity', source: 'inventory', reason: 'Current sellable capacity does not establish the requested quantity', suggestedActions: ['ReadCommerceInventory', 'ReadCommerceProduct'] }] };
  }
  if (s.type === 'CustomsAssessment') {
    const data = parseCommerceEntity(s.type, s.data);
    const route = dependencies.find(d => d.type === 'FulfillmentPlan'), product = dependencies.find(d => d.type === 'CommerceProduct');
    if (!route || !product) return unknown('customs_inputs', 'customs', 'Customs assessment lacks its source product and route', ['ReadCommerceProduct', 'ReadCommerceFulfillment']);
    const f = parseCommerceEntity('FulfillmentPlan', route.data), p = parseCommerceEntity('CommerceProduct', product.data), option = f.options.find(o => o.id === data.optionId);
    if (!option || data.fulfillmentId !== route.sourceId || data.merchantId !== p.merchantId || data.variantId !== p.variantId || data.quantity !== f.quantity || data.destinationCountry !== f.destination.countryCode || data.destinationDigest !== f.destinationDigest || !equal([...data.dispatchCountries].sort(), [...new Set(option.groups.map(g => g.dispatchCountry))].sort()) || data.goodsOriginCountry !== p.goodsOriginCountry || data.hsCode !== p.hsCode || data.status === 'not_applicable' && option.groups.some(g => g.dispatchCountry !== f.destination.countryCode) || option.incoterm === 'DDP' && (data.dutyPayer !== 'seller' || data.importer !== 'seller')) return invalid('customs_scope', 'customs', 'Customs facts contradict the selected product, route or agreed responsibility', ['ReadCommerceCustoms']);
    if (data.status === 'restricted' || data.requirements.some(r => r.status === 'unmet')) return { status: 'unsatisfied', gaps: [{ fact: 'import_eligibility', source: 'customs', reason: 'This route or product is restricted by the simulated applicable rules', suggestedActions: ['ReadCommerceFulfillment', 'ReadCommerceProduct'] }] };
    if (data.status === 'unknown' || data.requirements.some(r => r.status === 'unknown') || data.status !== 'not_applicable' && (!data.hsCode || !data.goodsOriginCountry || data.importer === 'unknown' || data.dutyPayer === 'unknown')) return unknown('customs_evidence', 'customs', 'Import eligibility, classification or responsibility is unresolved', ['ReadCommerceProduct', 'ReadCommerceCustoms']);
  }
  if (s.type === 'FulfillmentPlan') {
    const data = parseCommerceEntity(s.type, s.data), context = dependencies.find(d => d.type === 'FulfillmentContext'), inventory = dependencies.find(d => d.type === 'InventoryObservation'), product = dependencies.find(d => d.type === 'CommerceProduct');
    if (!context || !inventory || !product) return unknown('fulfillment_inputs', 'fulfillment', 'Shipping choices lack bound buyer, product or stock evidence', ['ReadCommerceContext', 'ReadCommerceInventory']);
    const c = parseCommerceEntity('FulfillmentContext', context.data), i = parseCommerceEntity('InventoryObservation', inventory.data), p = parseCommerceEntity('CommerceProduct', product.data), address = commerceDestinationChoice(c, commerceScopeRequirements(graph, owner, s.scope));
    if (!address || data.contextKey !== c.contextKey || data.addressId !== address.id || data.addressRevision !== address.revision || !equal(data.destination, address.address) || data.destinationDigest !== postalAddressDigest(address.address) || data.merchantId !== p.merchantId || data.variantId !== p.variantId || data.quantity !== i.requestedQuantity || i.merchantId !== p.merchantId || i.variantId !== p.variantId) return invalid('fulfillment_scope', 'fulfillment', 'Shipping source changed the selected address, goods or quantity', ['ReadCommerceFulfillment']);
    for (const option of data.options.filter(o => o.status === 'available')) {
      if (new Set(option.groups.map(g => g.id)).size !== option.groups.length || option.groups.reduce((n,g)=>n+g.quantity,0) !== data.quantity || option.groups.some(g => g.variantId !== data.variantId || g.destinationDigest !== data.destinationDigest || !i.locations.some(l => l.warehouseId === g.warehouseId && l.dispatchCountry === g.dispatchCountry && l.availability === 'confirmed' && l.quantityState === 'sellable')) || i.locations.some(l => option.groups.filter(g=>g.warehouseId===l.warehouseId).reduce((n,g)=>n+g.quantity,0) > (l.confirmedQuantity ?? 0))) return invalid('package_stock_allocation', 'fulfillment', 'Package quantities or origins exceed the source warehouse capacity', ['ReadCommerceInventory', 'ReadCommerceFulfillment']);
    }
    if (!data.options.some(o => o.status === 'available')) return unknown('shipping_option', 'fulfillment', 'No available shipping option was returned in this source response', ['ReadCommerceFulfillment']);
  }
  if (s.type === 'LandedCostQuote') {
    const customs = dependencies.find(d => d.type === 'CustomsAssessment'), inventory = dependencies.find(d => d.type === 'InventoryObservation'), route = dependencies.find(d => d.type === 'FulfillmentPlan'), product = dependencies.find(d => d.type === 'CommerceProduct');
    if (!customs || !inventory || !route || !product) return unknown('quote_inputs', 'merchant', 'The quote lacks its bound inventory, route, product and customs observations', ['ReadCommerceInventory', 'ReadCommerceCustoms']);
    for (const input of [customs, inventory, route]) { const assessment = commerceObservationReadiness(graph, owner, input); if (assessment.status !== 'satisfied') return assessment; }
    const q = parseCommerceEntity('LandedCostQuote', s.data), f = parseCommerceEntity('FulfillmentPlan', route.data), p = parseCommerceEntity('CommerceProduct', product.data), c = parseCommerceEntity('CustomsAssessment', customs.data), option = f.options.find(o=>o.id===q.optionId);
    if (!option || q.merchantId !== p.merchantId || q.variantId !== p.variantId || q.quantity !== f.quantity || q.inventoryId !== inventory.sourceId || q.inventoryVersion !== inventory.sourceVersion || !equal(q.unitPrice,p.unitPrice) || q.fulfillmentId !== route.sourceId || q.customsId !== customs.sourceId || q.optionId !== c.optionId || q.destinationDigest !== f.destinationDigest || !equal(q.groups,option.groups) || q.incoterm !== option.incoterm || q.incoterm === 'DDP' && q.components.some(c=>['duty','tax','clearance'].includes(c.category)&&c.payer!=='seller')) return invalid('fixed_quote_scope', 'merchant', 'Quote changed the chosen product, route, allocation, price or responsibility', ['QuoteCommerceLandedCost']);
    return assessLandedCost(parseCommerceEntity(s.type, s.data), commerceScopeRequirements(graph, owner, s.scope), graph.now());
  }
  if (s.type === 'Cart' && parseCommerceEntity('Cart', s.data).state === 'canceled') return invalid('cart_state', 'merchant', 'This cart is canceled', ['ReadCommerceCart']);
  if (s.type === 'CommerceCheckout') {
    const quote = dependencies.find(d => d.type === 'LandedCostQuote'), checkout = parseCommerceEntity(s.type, s.data);
    if (!quote || checkout.state !== 'ready') return unknown('checkout_ready', 'merchant', 'The checkout does not identify a ready, fixed source quote', ['PrepareCommerceCheckout']);
    const q = parseCommerceEntity('LandedCostQuote', quote.data);
    if (checkout.quoteDigest !== quote.contentDigest || checkout.quoteId !== quote.sourceId || checkout.destinationDigest !== q.destinationDigest || !equal(checkout.total, q.buyerTotal) || !equal(checkout.costComponents, q.components) || checkout.lines.length !== 1 || checkout.lines[0]!.variantId !== q.variantId || checkout.lines[0]!.quantity !== q.quantity || !equal(checkout.lines[0]!.unitPrice, q.unitPrice)) return { status: 'unsatisfied', gaps: [{ fact: 'fixed_checkout_terms', source: 'merchant', reason: 'Checkout changed its selected source quote, item, address or cost allocation', suggestedActions: ['PrepareCommerceCheckout'] }] };
    return commerceObservationReadiness(graph, owner, quote);
  }
  if (s.type === 'CommerceOrderObservation') {
    const data = parseCommerceEntity(s.type, s.data), previous = dependencies.find(d => d.type === 'CommerceCheckout' || d.type === 'CommerceOrderObservation');
    if (!previous || data.state !== 'confirmed') return unknown('order_confirmation', 'merchant', 'Original order is not independently established', ['ReadCommerceOrder']);
    const p = previous.data;
    if (data.checkoutId !== p.checkoutId || data.merchantId !== p.merchantId || data.quoteId !== p.quoteId || data.quoteDigest !== p.quoteDigest || data.destinationDigest !== p.destinationDigest || !equal(data.lines, p.lines) || !equal(data.total, p.total) || !equal(data.costComponents, p.costComponents)) return { status: 'unsatisfied', gaps: [{ fact: 'original_order_terms', source: 'merchant', reason: 'Original order differs from its approved checkout contract', suggestedActions: ['ReadCommerceOrder'] }] };
  }
  if (s.type === 'CommercePaymentObservation') {
    const data = parseCommerceEntity(s.type, s.data), prior = dependencies.find(d=>d.type==='CommerceOrderObservation');
    if (!prior) return unknown('original_payment_order', 'payment', 'Payment receipt has no original order binding', ['ReadCommerceOrder']);
    const o = parseCommerceEntity('CommerceOrderObservation', prior.data);
    if (data.orderId !== o.orderId || data.merchantId !== o.merchantId || !equal(data.amount,o.total) || Date.parse(data.observedAt)>Date.parse(s.observedAt)) return invalid('payment_identity', 'payment', 'Payment identity, amount or business timestamp differs from the original order', ['ReadCommercePayment']);
    if (data.state === 'failed' || data.state === 'refunded') return invalid('payment_settlement', 'payment', 'Payment is failed or refunded', ['ReadCommercePayment']);
    if (data.state !== 'settled') return unknown('payment_settlement', 'payment', 'Separate settlement evidence is still pending', ['ReadCommercePayment']);
  }
  if (s.type === 'CommerceDeliveryObservation') {
    const data = parseCommerceEntity(s.type, s.data), prior = dependencies.find(d=>d.type==='CommerceOrderObservation'), quote = prior && ancestor(prior,'LandedCostQuote');
    if (!prior || !quote) return unknown('original_delivery_contract', 'carrier', 'Delivery events lack the original order and package contract', ['ReadCommerceOrder']);
    const o=parseCommerceEntity('CommerceOrderObservation',prior.data), q=parseCommerceEntity('LandedCostQuote',quote.data), arrived=data.events.filter(e=>e.milestone==='delivered');
    if(data.orderId!==o.orderId||data.merchantId!==o.merchantId||data.destinationDigest!==o.destinationDigest||new Set(data.events.map(e=>e.id)).size!==data.events.length||data.events.some(e=>Date.parse(e.occurredAt)>Date.parse(s.observedAt)||e.destinationDigest!==o.destinationDigest||!q.groups.some(g=>g.id===e.groupId&&g.variantId===e.variantId))||q.groups.some(g=>arrived.filter(e=>e.groupId===g.id&&e.variantId===g.variantId).reduce((n,e)=>n+e.quantity,0)>g.quantity))return invalid('delivery_event_identity','carrier','Delivery events are duplicated, future-dated, over-allocated or bound to different goods or destination',['ReadCommerceDelivery']);
    if(data.state==='failed'||data.events.some(e=>e.milestone==='returned'))return invalid('delivery_failed','carrier','A delivery failure or return is evidenced',['ReadCommerceDelivery']);
    if(data.state!=='delivered'||q.groups.some(g=>arrived.filter(e=>e.groupId===g.id&&e.variantId===g.variantId).reduce((n,e)=>n+e.quantity,0)!==g.quantity))return unknown('remaining_delivery','carrier','Not every original package has a matching delivered quantity',['ReadCommerceDelivery']);
    for(const r of commerceScopeRequirements(graph,owner,s.scope))if(r.kind==='deadline'&&r.strength==='hard'&&(!r.role||['arrival','completion'].includes(r.role))&&arrived.some(e=>Date.parse(e.occurredAt)>Date.parse(r.expected.at)))return invalid('actual_arrival_deadline','carrier','An actual package arrival missed the fixed deadline',[]);
  }
  return { status: 'satisfied', gaps: [] };
}

export function evaluateCommerceJourneyFunction(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (!['commerceObservationStatus', 'commerceJourneyStatus'].includes(input.function)) return;
  if (input.function === 'commerceObservationStatus') {
    try {
      const s = readCommerceObservation(graph, owner, input.object, { budget });
      const assessment = commerceObservationReadiness(graph, owner, s);
      return { status: 'known', value: { type: s.type, data: s.data, sourceId: s.sourceId, sourceVersion: s.sourceVersion, observedAt: s.observedAt, expiresAt: s.expiresAt, assessment, evidenceLevel: 'synthetic', realOperationsAllowed: false }, evidenceRefs: [input.object, ...s.dependencies.map(d => d.ref)], evidenceLevels: ['synthetic'] };
    } catch (error) { return { status: 'unknown', reason: error instanceof DomainError ? error.message : 'Commerce source schema or evidence is invalid', evidenceRefs: [input.object], evidenceLevels: [] }; }
  }
  if (input.object.type !== 'CommerceTask') throw new DomainError('INVALID_INPUT', 'Commerce progress requires a CommerceTask');
  const task = graph.read(owner, input.object, budget), scope = commerceJourneyInputSchema.parse(task.properties.input);
  const facts: { object: ObjectRef; type: string; sourceId: string; status: string; readiness?: CommerceReadiness }[] = [], refs: ObjectRef[] = [input.object], memo = new Map<string, CommerceObservation>(), at = graph.now();
  for (const type of Object.keys(commerceEntitySchemas).filter(t => !['FactRequirement', 'DeliveryPromise', 'CartLine', 'FulfillmentGroup', 'InventoryReservation'].includes(t))) for (const record of graph.related(owner, input.object, `observed${type}`, budget) ?? []) {
    try { const s = readCommerceObservation(graph, owner, record.ref, { at, budget, memo }); facts.push({ object: record.ref, type, sourceId: s.sourceId, status: 'known', readiness: commerceObservationReadiness(graph, owner, s) }); refs.push(record.ref); }
    catch { facts.push({ object: record.ref, type, sourceId: '', status: 'unknown' }); }
  }
  const missing: { fact: string; source: string; suggestedActions: string[] }[] = [];
  if (!scope.query) missing.push({ fact: 'product_need', source: 'pa_choice', suggestedActions: [] });
  if (!scope.quantity) missing.push({ fact: 'requested_quantity', source: 'pa_choice', suggestedActions: [] });
  const expected: [string, string, string, string][] = [['merchant_candidates', 'merchant_directory', 'CommerceMerchantSearch', 'SearchCommerceMerchants'], ['product_facts', 'merchant', 'CommerceProduct', 'ReadCommerceProduct']];
  if (scope.target !== 'cart') expected.push(['delivery_context', 'pa_context', 'FulfillmentContext', 'ReadCommerceContext'], ['quantity_capacity', 'inventory', 'InventoryObservation', 'ReadCommerceInventory'], ['route_options', 'fulfillment', 'FulfillmentPlan', 'ReadCommerceFulfillment'], ['import_eligibility', 'customs', 'CustomsAssessment', 'ReadCommerceCustoms'], ['landed_cost', 'merchant', 'LandedCostQuote', 'QuoteCommerceLandedCost']);
  for (const [fact, source, type, action] of expected) if (!facts.some(f => f.type === type && f.status === 'known')) missing.push({ fact, source, suggestedActions: [action] });
  return { status: 'known', value: { target: scope.target, facts, missingFacts: missing, note: 'These are evidence gaps, not a prescribed action order. Select and compare candidates yourself; a known object can still have unsatisfied or unknown readiness.', realOperationsAllowed: false }, evidenceRefs: refs, evidenceLevels: ['synthetic'] };
}
