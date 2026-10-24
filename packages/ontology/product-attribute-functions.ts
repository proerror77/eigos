import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ObjectRef } from './model.js';
import type { Computation } from './object-functions.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';
import { sourceProof } from './object-evidence.js';
import { checkedAgentCatalogObservation, catalogEntityRefs } from './catalog-agent-projection.js';
import { readCommerceObservation, checkedCommerceObservation } from './commerce-journey-functions.js';
import { evaluateAgentCatalogFunction } from './catalog-agent-functions.js';
import { parseCommerceEntity } from './commerce-journey.js';
import { productAttributesSchema, productAttributeFunctionSchemas, orderLineSourceAgreementSchema, shipmentExpectedAllocationSchema, deliveryVariantVerificationSchema, type ProductAttributes } from './product-attributes.js';

const same = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : digest(a) === digest(b);
const unknown = (reason: string, evidenceRefs: ObjectRef[] = [], evidenceLevels: string[] = []): Computation => ({ status: 'unknown', reason, evidenceRefs, evidenceLevels });
function storageBytes(value: { amount: number; unit: string }) {
  const factor = { GB: 1000n ** 3n, TB: 1000n ** 4n, GiB: 1024n ** 3n, TiB: 1024n ** 4n }[value.unit];
  return factor === undefined ? undefined : BigInt(value.amount) * factor;
}
function content(value: { amount: string; unit: string }) {
  const [whole = '0', part = ''] = value.amount.split('.');
  return { amount: (BigInt(whole) * 1000n + BigInt(part.padEnd(3, '0'))) * (['kg', 'l'].includes(value.unit) ? 1000n : 1n), dimension: ['g', 'kg'].includes(value.unit) ? 'mass' : 'volume' };
}
export function compareProductAttributes(actual: unknown, requested: unknown): { status: 'matches' | 'different' | 'unknown'; missing: string[]; different: string[] } {
  const constraints = productAttributesSchema.parse(requested), parsed = productAttributesSchema.safeParse(actual);
  if (!parsed.success) return { status: 'unknown', missing: ['typedAttributes'], different: [] };
  const attrs = parsed.data, missing: string[] = [], different: string[] = [];
  if (attrs.profile !== constraints.profile) return { status: 'different', missing, different: ['profile'] };
  const values = attrs as Record<string, unknown>;
  const compareRequestedFields = (found: Record<string, unknown>, wanted: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(wanted)) {
      const path = `${prefix}.${key}`;
      if (found[key] === undefined) missing.push(path);
      else if (Array.isArray(value) && Array.isArray(found[key])) { if (!same([...found[key] as unknown[]].sort(), [...value].sort())) different.push(path); }
      else if (value && typeof value === 'object') compareRequestedFields(found[key] as Record<string, unknown>, value as Record<string, unknown>, path);
      else if (!same(found[key], value)) different.push(path);
    }
  };
  for (const [key, wanted] of Object.entries(constraints)) {
    if (['schemaVersion', 'profile'].includes(key)) continue;
    const found = values[key];
    if (found === undefined) { missing.push(key); continue; }
    let equal = same(found, wanted);
    if (key === 'storage') equal = storageBytes(found as { amount: number; unit: string }) === storageBytes(wanted as { amount: number; unit: string });
    if (key === 'netContent') {
      const a = content(found as { amount: string; unit: string }), b = content(wanted as { amount: string; unit: string });
      equal = a.dimension === b.dimension && a.amount === b.amount;
    }
    if (key === 'size' && (found as { system: string; manufacturer?: string }).system === 'manufacturer' && !(found as { manufacturer?: string }).manufacturer) { missing.push('size.manufacturer'); continue; }
    if (!['storage', 'netContent'].includes(key) && wanted && typeof wanted === 'object' && !Array.isArray(wanted)) { compareRequestedFields(found as Record<string, unknown>, wanted as Record<string, unknown>, key); continue; }
    if (!equal) different.push(key);
  }
  return { status: different.length ? 'different' : missing.length ? 'unknown' : 'matches', missing, different };
}

export function evaluateProductAttributeFunction(graph: OntologyObjectStore, owner: string, raw: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (raw.function === 'orderLineAgreementStatus') return orderLineAgreementStatus(graph, owner, raw.object, budget);
  if (raw.function === 'shipmentAllocationStatus') return shipmentAllocationStatus(graph, owner, raw.object, budget);
  if (raw.function !== 'productAttributesMatch') return;
  const input = productAttributeFunctionSchemas[0]!.parse(raw);
  if (!['ProductVariant', 'ProductOffer', 'CommerceProduct'].includes(input.object.type)) throw new DomainError('INVALID_INPUT', 'Product matching requires a variant, product offer or source product observation');
  const object = graph.read(owner, input.object, budget), refs = [input.object], levels: string[] = [];
  let attrs: ProductAttributes | undefined;
  let variant = object;
  if (object.ref.type === 'ProductOffer') {
    const proof = sourceProof(graph, owner, object.ref, budget), variants = graph.related(owner, object.ref, 'productVariant', budget);
    if (!proof || variants?.length !== 1 || object.properties.variantRevision !== variants[0]!.revision) return unknown('Offer evidence or its fixed variant revision is missing or changed', refs);
    if (!object.properties.expiresAt || Date.parse(String(object.properties.expiresAt)) <= graph.now()) return unknown('Product offer validity is unknown or expired', refs);
    variant = variants[0]!; refs.push(variant.ref, ...proof.refs); levels.push(...proof.levels);
  }
  if (variant.ref.type === 'CommerceProduct') {
    const proof = sourceProof(graph, owner, variant.ref, budget);
    if (!proof) return unknown('Product observation is not sealed by a source receipt', refs);
    let s; try { s = readCommerceObservation(graph, owner, variant.ref, { budget }); } catch { return unknown('Product observation is stale or its source dependencies changed', refs); }
    attrs = parseCommerceEntity('CommerceProduct', s.data).typedAttributes; refs.push(...proof.refs); levels.push(...proof.levels);
  } else {
    const candidates: ProductAttributes[] = [];
    for (const observation of graph.related(owner, variant.ref, 'currentCatalogObservation', budget) ?? []) {
      const proof = sourceProof(graph, owner, observation.ref, budget);
      if (!proof) return unknown('Current catalog source receipt no longer seals the facts', refs);
      if (evaluateAgentCatalogFunction(graph, owner, { function: 'catalogObservationStatus', object: observation.ref }, budget)?.status !== 'known') return unknown('Current catalog task, source or request is no longer valid', refs);
      const s = checkedAgentCatalogObservation(observation.properties.snapshot);
      if (Date.parse(s.observedAt) > graph.now() || Date.parse(s.expiresAt) <= graph.now()) return unknown('Current catalog observation expired or is in the future', refs);
      const item = s.items.find(item => same(catalogEntityRefs(s, item.variantId).variant, variant.ref));
      if (!item || !same(item.typedAttributes, variant.properties.typedAttributes)) return unknown('Variant attributes no longer match the exact catalog source', refs);
      if (item.typedAttributes) candidates.push(item.typedAttributes); refs.push(observation.ref, ...proof.refs); levels.push(...proof.levels);
    }
    for (const observation of graph.related(owner, variant.ref, 'currentCommerceProduct', budget) ?? []) {
      const proof = sourceProof(graph, owner, observation.ref, budget);
      if (!proof) return unknown('Current commerce product source receipt no longer seals the facts', refs);
      let s; try { s = readCommerceObservation(graph, owner, observation.ref, { budget }); } catch { return unknown('Current commerce product observation is stale or out of scope', refs); }
      const data = parseCommerceEntity('CommerceProduct', s.data);
      const variants = graph.related(owner, observation.ref, 'productVariant', budget);
      if (variants?.length !== 1 || !same(variants[0]!.ref, variant.ref) || !same(data.typedAttributes, variant.properties.typedAttributes)) return unknown('Variant attributes no longer match the current source product', refs);
      if (data.typedAttributes) candidates.push(data.typedAttributes); refs.push(observation.ref, ...proof.refs); levels.push(...proof.levels);
    }
    if (candidates.some(candidate => !same(candidate, candidates[0]))) return unknown('Current source observations disagree about the typed specification', refs, levels);
    attrs = candidates[0];
  }
  const comparison = compareProductAttributes(attrs, input.constraints);
  if (comparison.status === 'unknown') return unknown(`Requested source attributes are missing or untyped: ${comparison.missing.join(', ')}`, refs, levels);
  return { status: 'known', value: { matches: comparison.status === 'matches', ...comparison, requested: input.constraints, actual: attrs, grantsAuthority: false }, evidenceRefs: refs, evidenceLevels: [...new Set(levels)] };
}

/** Contract readback deliberately checks immutable historical observations,
 * rather than interpreting current catalog freshness as the old agreement. */
function orderLineAgreementStatus(graph: OntologyObjectStore, owner: string, ref: ObjectRef, budget: ReadBudget): Computation {
  if (ref.type !== 'OrderLine') throw new DomainError('INVALID_INPUT', 'Agreement status requires an order line');
  const line = graph.read(owner, ref, budget), parsed = orderLineSourceAgreementSchema.safeParse(line.properties.sourceAgreement), refs = [ref];
  if (!parsed.success) return unknown('This historical line has no explicit source-observation agreement; do not infer or backfill one', refs);
  const agreement = parsed.data;
  if (line.properties.agreedSpecificationRef !== digest(agreement) || line.properties.agreedPriceRef !== agreement.quote.contentDigest) return unknown('Fixed order-line agreement references changed', refs);
  const receipts = graph.related(owner, ref, 'agreementReceipt', budget);
  if (receipts?.length !== 1) return unknown('Fixed agreement receipt is missing or ambiguous', refs);
  const receipt = receipts[0]!, subjects = receipt.properties.subjects as { object: ObjectRef; digest: string; linksDigest: string }[] | undefined;
  if (receipt.properties.scope !== 'order' || !receipt.properties.sourceIdentity || !receipt.properties.sourceEventId || receipt.properties.evidenceLevel === 'user_asserted'
    || !subjects?.some(subject => same(subject.object, ref) && subject.digest === digest(line.properties) && subject.linksDigest === graph.relationshipDigest(owner, ref, budget))) return unknown('Fixed agreement facts or relationships no longer match their original source receipt', refs);
  refs.push(receipt.ref);
  const levels = [String(receipt.properties.evidenceLevel)], observations = new Map<string, ReturnType<typeof checkedCommerceObservation>>();
  for (const [field, relationship] of [['product', 'agreedProduct'], ['quote', 'agreedQuote'], ['checkout', 'agreedCheckout'], ['order', 'agreementOrderObservation']] as const) {
    const pinned = agreement[field], related = graph.related(owner, ref, relationship, budget);
    if (related?.length !== 1 || !same(related[0]!.ref, pinned.object)) return unknown('An original source agreement endpoint changed', refs, levels);
    const proof = sourceProof(graph, owner, pinned.object, budget);
    if (!proof) return unknown('An original source agreement endpoint lost its source proof', refs, levels);
    let observed;
    try { observed = checkedCommerceObservation(related[0]!.properties.snapshot); } catch { return unknown('An original source agreement snapshot is invalid', refs, levels); }
    if (observed.contentDigest !== pinned.contentDigest || observed.sourceId !== pinned.sourceId || observed.sourceVersion !== pinned.sourceVersion
      || observed.receipt.ownerDigest !== digest(owner) || Date.parse(observed.observedAt) > Date.parse(pinned.checkedAt) || Date.parse(observed.expiresAt) <= Date.parse(pinned.checkedAt)) return unknown('Original agreement does not bind an exact source version valid at its historical check time', refs, levels);
    observations.set(field, observed); refs.push(pinned.object, ...proof.refs); levels.push(...proof.levels);
  }
  const product = parseCommerceEntity('CommerceProduct', observations.get('product')!.data), quote = parseCommerceEntity('LandedCostQuote', observations.get('quote')!.data), checkout = parseCommerceEntity('CommerceCheckout', observations.get('checkout')!.data), order = parseCommerceEntity('CommerceOrderObservation', observations.get('order')!.data);
  const ordered = order.lines.find(item => item.variantId === agreement.variantId && item.merchantId === agreement.merchantId);
  if (product.merchantId !== agreement.merchantId || product.variantId !== agreement.variantId || quote.merchantId !== agreement.merchantId || quote.variantId !== agreement.variantId
    || !ordered || !same(line.properties.quantityOrdered, { amount: String(ordered.quantity), unit: 'piece' }) || quote.quantity !== ordered.quantity
    || order.checkoutId !== checkout.checkoutId || order.quoteId !== agreement.quote.sourceId || order.quoteDigest !== agreement.quote.contentDigest || checkout.quoteDigest !== agreement.quote.contentDigest
    || checkout.quoteId !== agreement.quote.sourceId || order.destinationDigest !== checkout.destinationDigest || checkout.destinationDigest !== quote.destinationDigest
    || !same(order.total, checkout.total) || !same(checkout.total, quote.buyerTotal) || !same(order.costComponents, checkout.costComponents) || !same(checkout.costComponents, quote.components)
    || !same(order.lines, checkout.lines)) return unknown('The fixed source agreement contains inconsistent item or checkout terms', refs, levels);
  return { status: 'known', value: { status: 'fixed_source_agreement', sourceAgreement: agreement, ...(product.typedAttributes ? { agreedAttributes: product.typedAttributes } : {}),
    physicalAttributes: 'unknown', grantsAuthority: false, provesDelivery: false }, evidenceRefs: refs, evidenceLevels: [...new Set(levels)] };
}

function shipmentAllocationStatus(graph: OntologyObjectStore, owner: string, ref: ObjectRef, budget: ReadBudget): Computation {
  if (ref.type !== 'Shipment') throw new DomainError('INVALID_INPUT', 'Package allocation status requires a shipment');
  const shipment = graph.read(owner, ref, budget), parsed = shipmentExpectedAllocationSchema.safeParse(shipment.properties.expectedAllocation), refs = [ref];
  if (!parsed.success) return unknown('This shipment has no fixed expected allocation; actual receipts cannot invent its original plan', refs);
  const expected = parsed.data, proof = sourceProof(graph, owner, ref, budget), lines = graph.related(owner, ref, 'expectedOrderLine', budget), quotes = graph.related(owner, ref, 'expectedQuote', budget), orders = graph.related(owner, ref, 'order', budget);
  if (!proof || lines?.length !== 1 || quotes?.length !== 1 || orders?.length !== 1 || !same(lines[0]!.ref, expected.orderLine) || !same(quotes[0]!.ref, expected.sourceQuote)) return unknown('The planned package source or exact order-line/quote links changed', refs);
  const line = lines[0]!, agreement = orderLineSourceAgreementSchema.safeParse(line.properties.sourceAgreement), quoteProof = sourceProof(graph, owner, expected.sourceQuote, budget);
  if (!agreement.success || !quoteProof || line.properties.agreedSpecificationRef !== expected.agreedSpecificationRef || !same(agreement.data.quote.object, expected.sourceQuote) || agreement.data.quote.contentDigest !== expected.sourceQuoteDigest) return unknown('Planned allocation is not bound to this line\'s original source agreement', refs);
  const agreementStatus = orderLineAgreementStatus(graph, owner, line.ref, budget);
  if (agreementStatus.status !== 'known') return unknown('The package original agreement is not independently sealed', refs);
  const snapshot = checkedCommerceObservation(quotes[0]!.properties.snapshot), quote = parseCommerceEntity('LandedCostQuote', snapshot.data), group = quote.groups.filter(group => group.id === expected.sourceGroupId);
  if (snapshot.contentDigest !== expected.sourceQuoteDigest || group.length !== 1 || group[0]!.variantId !== agreement.data.variantId || group[0]!.destinationDigest !== expected.destinationDigest
    || String(group[0]!.quantity) !== expected.quantity.amount) return unknown('Planned quantity differs from its exact original quote group', refs);
  const siblings = graph.related(owner, orders[0]!.ref, 'shipments', budget);
  if (!siblings) return unknown('Planned package coverage exceeds the read bound', refs);
  const plans = siblings.flatMap(sibling => {
    const plan = shipmentExpectedAllocationSchema.safeParse(sibling.properties.expectedAllocation);
    return plan.success && same(plan.data.orderLine, expected.orderLine) ? [plan.data] : [];
  });
  if (new Set(plans.map(plan => `${plan.sourceQuoteDigest}:${plan.sourceGroupId}`)).size !== plans.length
    || plans.some(plan => plan.sourceQuoteDigest !== expected.sourceQuoteDigest) || plans.reduce((sum, plan) => sum + Number(plan.quantity.amount), 0) > quote.quantity) return unknown('Planned packages duplicate a group or over-allocate the original order line', refs);
  const allocations = graph.related(owner, ref, 'allocations', budget);
  if (!allocations) return unknown('Actual allocation coverage exceeds the read bound', refs);
  let received = 0;
  const eventKeys = new Set<string>(), levels = [...proof.levels, ...quoteProof.levels, ...agreementStatus.evidenceLevels]; refs.push(...proof.refs, ...quoteProof.refs, ...agreementStatus.evidenceRefs, line.ref, expected.sourceQuote);
  for (const allocation of allocations) {
    if (allocation.properties.verificationState !== 'accepted') continue;
    const allocationProof = sourceProof(graph, owner, allocation.ref, budget), allocationLines = graph.related(owner, allocation.ref, 'orderLine', budget), events = graph.related(owner, allocation.ref, 'deliveryEvent', budget);
    const basis = deliveryVariantVerificationSchema.safeParse(allocation.properties.verificationBasis), quantity = allocation.properties.deliveredQuantity as { amount?: string; unit?: string } | undefined;
    if (!allocationProof || allocationLines?.length !== 1 || !same(allocationLines[0]!.ref, line.ref) || events?.length !== 1 || !basis.success || basis.data.reportedVariantId !== agreement.data.variantId
      || allocation.properties.acceptedSpecificationRef !== expected.agreedSpecificationRef || quantity?.unit !== 'piece' || !/^[1-9]\d{0,3}$/.test(quantity.amount ?? '')) return unknown('Actual allocation lacks matching independent source identity and quantity evidence', refs, levels);
    const event = events[0]!, eventProof = sourceProof(graph, owner, event.ref, budget), eventKey = String(event.properties.sourceEventKey ?? '');
    if (!eventProof || !eventKey || eventKeys.has(eventKey) || !['delivered', 'partial'].includes(String(event.properties.eventKind)) || !event.properties.occurredAt || !Number.isFinite(Date.parse(String(event.properties.occurredAt))) || Date.parse(String(event.properties.occurredAt)) > graph.now()) return unknown('Actual delivery event is duplicated, unproven or not an accepted receipt', refs, levels);
    eventKeys.add(eventKey); received += Number(quantity!.amount); refs.push(allocation.ref, event.ref, ...allocationProof.refs, ...eventProof.refs); levels.push(...allocationProof.levels, ...eventProof.levels);
  }
  const remaining = Number(expected.quantity.amount) - received;
  if (remaining < 0) return unknown('Actual quantities exceed this package\'s original planned allocation', refs, levels);
  return { status: 'known', value: { status: remaining === 0 ? 'source_reported_quantity_complete' : received ? 'partial' : 'pending', sourceGroupId: expected.sourceGroupId,
    orderLine: expected.orderLine, sourceQuote: expected.sourceQuote, expectedQuantity: expected.quantity, receivedQuantity: { amount: String(received), unit: 'piece' }, remainingQuantity: { amount: String(remaining), unit: 'piece' },
    physicalAttributes: 'unknown', grantsAuthority: false, provesPhysicalAttributes: false }, evidenceRefs: refs, evidenceLevels: [...new Set(levels)] };
}
