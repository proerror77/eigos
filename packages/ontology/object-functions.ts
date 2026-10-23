import { evaluateRegistrationFunction } from './free-booking-functions.js';
import { evaluateMeituanRead } from './meituan-read-projection.js';
import { evaluateRideEstimate } from './ride-estimate-functions.js';
import { evaluateBookingFunction } from './booking-functions.js';
import { evaluateStripePaymentFunction } from './stripe-payment-functions.js';
import { z } from 'zod';
import { objectRefSchema, type ObjectRef } from './model.js';
import { moneyValueSchema, quantitySchema, timeZoneSchema, addressValueSchema } from './business-model.js';
import { digest } from '../core/delegation.js';
import { sourceProof as proof } from './object-evidence.js';
import { evaluateDomainFunction } from './domain-functions.js';
import { evaluateCommerceFunction } from './commerce-functions.js';
import { evaluateCatalogFunction } from './catalog-functions.js';
import { evaluateAgentCatalogFunction } from './catalog-agent-functions.js';
import { evaluateCommerceJourneyFunction } from './commerce-journey-functions.js';
import { evaluateCustomsPolicyFunction } from './customs-policy-functions.js';
import { domainFunctionCallSchemas } from './service-domains.js';
import { DomainError } from '../core/domain.js';
import type { OntologyObjectStore, ObjectView, ReadBudget } from './object-store.js';

export interface Computation { status: 'known' | 'unknown'; value?: unknown; reason?: string; evidenceRefs: ObjectRef[]; evidenceLevels: string[] }
const simple = (name: string) => z.object({ function: z.literal(name), object: objectRefSchema }).strict();
export const functionCallSchema = z.union([
  simple('registrationStatus'), simple('bookingObservationStatus'), simple('stripePaymentStatus'),
  simple('customsGateStatus'), simple('shippingGateStatus'),
  simple('commerceObservationStatus'), simple('commerceJourneyStatus'),
  simple('checkoutReadiness'), simple('commerceOrderOutcome'),
  simple('catalogReadStatus'),
  simple('meituanReadStatus'), simple('catalogObservationStatus'), simple('rideEstimateStatus'),
  ...domainFunctionCallSchemas,
  simple('offerFreshness'), simple('remainingQuantity'), simple('actualArrival'), simple('reservationStatus'),
  z.object({ function: z.literal('deliveryQuoteMatches'), object: objectRefSchema, request: objectRefSchema, serviceLevel: z.enum(['ordinary', 'express']) }).strict(),
  z.object({ function: z.literal('withinBudget'), object: objectRefSchema, budget: moneyValueSchema, priceBasis: z.enum(['estimate', 'firm_quote']) }).strict(),
  z.object({ function: z.literal('reservationMatches'), object: objectRefSchema, venue: objectRefSchema, startsAt: z.iso.datetime({ offset: true }), timeZone: timeZoneSchema, partySize: z.number().int().min(1).max(1000) }).strict(),
  z.object({ function: z.literal('productOfferMatches'), object: objectRefSchema, variant: objectRefSchema, quantity: quantitySchema, budget: moneyValueSchema, deadline: z.iso.datetime({ offset: true }), destination: addressValueSchema }).strict(),
  z.object({ function: z.literal('slotAvailability'), object: objectRefSchema, venue: objectRefSchema, startsAt: z.iso.datetime({ offset: true }), timeZone: timeZoneSchema, partySize: z.number().int().min(1).max(1000) }).strict(),
]);
const unknown = (reason: string, evidenceRefs: ObjectRef[] = [], evidenceLevels: string[] = []): Computation => ({ status: 'unknown', reason, evidenceRefs, evidenceLevels });
const known = (value: unknown, evidenceRefs: ObjectRef[], evidenceLevels: string[] = []): Computation => ({ status: 'known', value, evidenceRefs: [...new Map(evidenceRefs.map(ref => [JSON.stringify(ref), ref])).values()], evidenceLevels: [...new Set(evidenceLevels)] });
const same = (a: ObjectRef, b: ObjectRef) => a.type === b.type && a.id === b.id;
const scaled = (amount: string) => { const [whole, part = ''] = amount.split('.'); return BigInt(whole!) * 1_000_000n + BigInt(part.padEnd(6, '0')); };
function quantity(value: unknown) {
  const parsed = quantitySchema.safeParse(value); if (!parsed.success) return undefined;
  const q = parsed.data, factor = q.unit === 'kg' ? 1000n : 1n;
  return { ...q, factor, dimension: ['kg', 'g'].includes(q.unit) ? 'mass' : q.unit, scaled: scaled(q.amount) * factor };
}
function fromScaled(value: bigint, factor: bigint) {
  if (value % factor) return undefined;
  const n = value / factor, whole = n / 1_000_000n, part = String(n % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return `${whole}${part ? '.' + part : ''}`;
}
function requireType(object: ObjectView, type: string) { if (object.ref.type !== type) throw new DomainError('INVALID_INPUT', 'Function requires its registered object type'); }
function one(store: OntologyObjectStore, owner: string, ref: ObjectRef, link: string, budget: ReadBudget) {
  const values = store.related(owner, ref, link, budget); return values?.length === 1 ? values[0] : undefined;
}
function freshness(store: OntologyObjectStore, owner: string, object: ObjectView, budget: ReadBudget): Computation {
  if (!store.model.implements(object.ref.type, 'Offer')) throw new DomainError('INVALID_INPUT', 'Freshness requires an Offer implementation');
  const evidence = proof(store, owner, object.ref, budget), p = object.properties;
  if (!evidence || !p.observedAt || !p.expiresAt || p.validityBasis === 'unknown' || Date.parse(String(p.observedAt)) > store.now()) return unknown('Freshness lacks a compatible, evidenced validity window', [object.ref]);
  return known(Date.parse(String(p.expiresAt)) > store.now(), [object.ref, ...evidence.refs], evidence.levels);
}

/** Registered read-only functions. Missing evidence is never replaced by zero or a model inference. */
export function evaluateFunction(store: OntologyObjectStore, owner: string, input: z.infer<typeof functionCallSchema>, budget: ReadBudget): Computation {
  const meituanResult = evaluateMeituanRead(store, owner, input, budget);
  if (meituanResult) return meituanResult;
  const rideResult = evaluateRideEstimate(store, owner, input, budget);
  if (rideResult) return rideResult;
  const registrationResult = evaluateRegistrationFunction(store, owner, input, budget);
  if (registrationResult) return registrationResult;
  const bookingResult = evaluateBookingFunction(store, owner, input, budget);
  if (bookingResult) return bookingResult;
  const stripeResult = evaluateStripePaymentFunction(store, owner, input, budget);
  if (stripeResult) return stripeResult;
  const customsResult = evaluateCustomsPolicyFunction(store, owner, input, budget);
  if (customsResult) return customsResult;
  const journeyResult = evaluateCommerceJourneyFunction(store, owner, input, budget);
  if (journeyResult) return journeyResult;
  const agentCatalogResult = evaluateAgentCatalogFunction(store, owner, input, budget);
  if (agentCatalogResult) return agentCatalogResult;
  const catalogResult = evaluateCatalogFunction(store, owner, input, budget);
  if (catalogResult) return catalogResult;
  const commerceResult = evaluateCommerceFunction(store, owner, input, budget);
  if (commerceResult) return commerceResult;
  const domainResult = evaluateDomainFunction(store, owner, input, budget);
  if (domainResult) return domainResult;
  const object = store.read(owner, input.object, budget), p = object.properties;
  if (input.function === 'offerFreshness') return freshness(store, owner, object, budget);
  if (input.function === 'remainingQuantity') {
    requireType(object, 'OrderLine'); const ordered = quantity(p.quantityOrdered);
    const allocations = store.related(owner, object.ref, 'allocations', budget);
    if (!ordered || !allocations) return unknown('Quantity or bounded allocation coverage is unavailable', [object.ref]);
    if (!allocations.length) return unknown('No delivery allocation observations; absence does not prove zero delivery', [object.ref]);
    let delivered = 0n; const eventKeys = new Set<string>(), refs = [object.ref], levels: string[] = [];
    const order = one(store, owner, object.ref, 'order', budget);
    for (const allocation of allocations) {
      if (allocation.properties.verificationState === 'revoked' || allocation.properties.verificationState === 'rejected') continue;
      if (allocation.properties.verificationState !== 'accepted') return unknown('An allocation has not been verified', refs);
      const amount = quantity(allocation.properties.deliveredQuantity), event = one(store, owner, allocation.ref, 'deliveryEvent', budget), shipment = one(store, owner, allocation.ref, 'shipment', budget);
      if (!amount || amount.dimension !== ordered.dimension || !event || !shipment || !order) return unknown('Allocation unit or relationship is unresolved', refs);
      const shipmentOrder = one(store, owner, shipment.ref, 'order', budget), eventShipment = one(store, owner, event.ref, 'shipment', budget);
      if (!shipmentOrder || !eventShipment || !same(shipmentOrder.ref, order.ref) || !same(eventShipment.ref, shipment.ref)) return unknown('Delivery evidence belongs to another business object', refs);
      const evidence = proof(store, owner, event.ref, budget), allocationProof = proof(store, owner, allocation.ref, budget), eventKey = event.properties.sourceEventKey;
      if (!evidence || !allocationProof || !eventKey || !['delivered', 'partial'].includes(String(event.properties.eventKind)) || !event.properties.occurredAt || Date.parse(String(event.properties.occurredAt)) > store.now() || allocation.properties.acceptedSpecificationRef !== p.agreedSpecificationRef) return unknown('Delivery evidence or specification is incompatible', refs);
      if (eventKeys.has(String(eventKey))) return unknown('Duplicate source event allocation cannot be counted twice', refs);
      eventKeys.add(String(eventKey)); delivered += amount.scaled;
      refs.push(allocation.ref, event.ref, ...evidence.refs, ...allocationProof.refs); levels.push(...evidence.levels, ...allocationProof.levels);
    }
    if (refs.length === 1) return unknown('No accepted allocation evidence', refs);
    if (delivered > ordered.scaled) return unknown('Observed allocations exceed the ordered quantity', refs, levels);
    const amount = fromScaled(ordered.scaled - delivered, ordered.factor);
    return amount === undefined ? unknown('Unit conversion exceeds supported precision', refs, levels) : known({ amount, unit: ordered.unit }, refs, levels);
  }
  if (input.function === 'actualArrival') {
    requireType(object, 'Shipment'); const events = store.related(owner, object.ref, 'deliveryEvents', budget);
    if (!events) return unknown('Delivery event coverage exceeds the read bound', [object.ref]);
    const accepted: { time: string; refs: ObjectRef[]; levels: string[] }[] = [];
    for (const event of events) {
      if (event.properties.eventKind !== 'delivered' || !event.properties.occurredAt || Date.parse(String(event.properties.occurredAt)) > store.now()) continue;
      const allocations = store.related(owner, event.ref, 'allocations', budget), evidence = proof(store, owner, event.ref, budget);
      if (!allocations || !evidence) return unknown('Delivery evidence is incomplete', [object.ref]);
      for (const allocation of allocations.filter(a => a.properties.verificationState === 'accepted')) {
        const shipment = one(store, owner, allocation.ref, 'shipment', budget), allocationProof = proof(store, owner, allocation.ref, budget);
        if (!shipment || !same(shipment.ref, object.ref) || !allocationProof) return unknown('Arrival allocation is not evidenced for this shipment', [object.ref, event.ref]);
        accepted.push({ time: String(event.properties.occurredAt), refs: [event.ref, allocation.ref, ...evidence.refs, ...allocationProof.refs], levels: [...evidence.levels, ...allocationProof.levels] });
      }
    }
    const final = accepted.sort((a, b) => Date.parse(b.time) - Date.parse(a.time))[0];
    return final ? known(final.time, [object.ref, ...final.refs], final.levels) : unknown('No accepted actual arrival event', [object.ref]);
  }
  if (input.function === 'reservationStatus') {
    requireType(object, 'Reservation'); const evidence = proof(store, owner, object.ref, budget);
    if (!evidence) return unknown('Reservation lacks a verified source receipt', [object.ref]);
    const refs = [object.ref, ...evidence.refs], levels = [...evidence.levels];
    if (p.reservationState === 'held' && p.holdExpiresAt && Date.parse(String(p.holdExpiresAt)) <= store.now()) return known('expired', refs, levels);
    if (p.reservationState !== 'confirmed') return p.reservationState && p.reservationState !== 'unknown' ? known(p.reservationState, refs, levels) : unknown('Confirmation state is unknown', refs, levels);
    if (!p.providerReference || !p.confirmedAt || Date.parse(String(p.confirmedAt)) > store.now() || !p.partySize) return unknown('Provider confirmation identity, time or party size is missing', refs, levels);
    const slot = one(store, owner, object.ref, 'slot', budget);
    if (!slot || p.confirmedSlotRevision !== slot.revision) return unknown('Confirmed slot snapshot changed', refs, levels);
    if (p.depositRequired === false) return known('confirmed', refs, levels);
    const deposit = moneyValueSchema.safeParse(p.requiredDeposit);
    if (p.depositRequired !== true || !deposit.success) return unknown('Reservation effectiveness conditions are missing', refs, levels);
    const payments = store.related(owner, object.ref, 'depositPayments', budget);
    if (!payments) return unknown('Payment coverage exceeds the read bound', refs, levels);
    let paid = 0n;
    for (const payment of payments) {
      const amount = moneyValueSchema.safeParse(payment.properties.amount), paymentProof = proof(store, owner, payment.ref, budget);
      if (payment.properties.paymentState !== 'paid') continue;
      if (!amount.success || amount.data.currency !== deposit.data.currency || payment.properties.purpose !== 'deposit' || !paymentProof) return unknown('Deposit payment evidence is incompatible', refs, levels);
      paid += BigInt(amount.data.minor); refs.push(payment.ref, ...paymentProof.refs); levels.push(...paymentProof.levels);
    }
    return paid >= BigInt(deposit.data.minor) ? known('confirmed', refs, levels) : unknown('Required deposit has not been evidenced in full', refs, levels);
  }
  if (input.function === 'deliveryQuoteMatches' && 'request' in input) {
    requireType(object, 'DeliveryQuote'); const request = store.read(owner, input.request, budget); requireType(request, 'ServiceRequest');
    const parcel = one(store, owner, object.ref, 'parcel', budget), route = one(store, owner, object.ref, 'route', budget), quoteRequest = one(store, owner, object.ref, 'request', budget), selectedRoute = one(store, owner, request.ref, 'selectedRoute', budget);
    const fresh = freshness(store, owner, object, budget);
    if (!parcel || !route || !quoteRequest || !selectedRoute || fresh.status !== 'known' || fresh.value !== true) return unknown('Quote applicability lacks a current route or fresh evidence', [object.ref, request.ref]);
    const declared = quantity(parcel.properties.declaredWeight), priced = quantity(p.quotedWeight);
    if (!declared || !priced || p.requestRevision === undefined || p.parcelRevision === undefined || p.routeRevision === undefined) return unknown('Quote input version or weight evidence is incomplete', [object.ref]);
    const parcelRequest = one(store, owner, parcel.ref, 'request', budget), routeRequest = one(store, owner, route.ref, 'request', budget);
    if (!parcelRequest || !routeRequest || !route.properties.originSnapshot || !route.properties.destinationSnapshot || !parcel.properties.declaredContents || !parcel.properties.contentsCategory) return unknown('The priced parcel or route is incomplete', [object.ref, parcel.ref, route.ref]);
    for (const [link, property] of [['originAddress', 'originSnapshot'], ['destinationAddress', 'destinationSnapshot']]) {
      const address = one(store, owner, route.ref, link!, budget);
      if (address && digest(address.properties.address) !== digest(route.properties[property!])) return known('fail', [object.ref, route.ref, address.ref, ...fresh.evidenceRefs], fresh.evidenceLevels);
    }
    const matches = same(quoteRequest.ref, request.ref) && same(parcelRequest.ref, request.ref) && same(routeRequest.ref, request.ref) && same(route.ref, selectedRoute.ref) && p.requestRevision === request.properties.revision && p.parcelRevision === parcel.revision && p.routeRevision === route.revision && declared.dimension === 'mass' && declared.dimension === priced.dimension && declared.scaled === priced.scaled && p.serviceLevel === input.serviceLevel;
    return known(matches ? 'pass' : 'fail', [object.ref, request.ref, parcel.ref, route.ref, ...fresh.evidenceRefs], fresh.evidenceLevels);
  }
  if (input.function === 'withinBudget' && 'budget' in input) {
    if (!['DeliveryQuote', 'ProductOffer'].includes(object.ref.type)) return unknown('This function compares a scoped total, not a reservation deposit', [object.ref]);
    const fresh = freshness(store, owner, object, budget), terms = p.pricingTerms as { total?: unknown; scope?: string } | undefined;
    const total = moneyValueSchema.safeParse(terms?.total);
    if (fresh.status !== 'known' || !fresh.value || p.priceKind !== input.priceBasis || p.pricingCompleteness !== 'complete' || terms?.scope !== 'all_mandatory_fees' || !total.success || total.data.currency !== input.budget.currency) return unknown('Comparable, complete and current price evidence is missing', [object.ref]);
    return known(BigInt(total.data.minor) <= BigInt(input.budget.minor) ? 'pass' : 'fail', fresh.evidenceRefs, fresh.evidenceLevels);
  }
  if (input.function === 'reservationMatches' && 'venue' in input) {
    requireType(object, 'Reservation'); const expectedVenue = store.read(owner, input.venue, budget); requireType(expectedVenue, 'Venue');
    const slot = one(store, owner, object.ref, 'slot', budget), status = evaluateFunction(store, owner, { function: 'reservationStatus', object: object.ref }, budget);
    const venue = slot && one(store, owner, slot.ref, 'venue', budget);
    if (!slot || !venue || !p.partySize || p.confirmedSlotRevision !== slot.revision || !slot.properties.startsAt || !slot.properties.timeZone || status.status !== 'known' || status.value !== 'confirmed') return unknown('Effective reservation confirmation is not established', [object.ref]);
    return known(same(venue.ref, expectedVenue.ref) && p.partySize === input.partySize && Date.parse(String(slot.properties.startsAt)) === Date.parse(input.startsAt) && slot.properties.timeZone === input.timeZone ? 'pass' : 'fail', [object.ref, slot.ref, venue.ref, ...status.evidenceRefs], status.evidenceLevels);
  }
  if (input.function === 'productOfferMatches' && 'variant' in input) {
    requireType(object, 'ProductOffer'); const requestedVariant = store.read(owner, input.variant, budget); requireType(requestedVariant, 'ProductVariant');
    const variant = one(store, owner, object.ref, 'productVariant', budget), requested = quantity(input.quantity), offered = quantity(p.offeredQuantity);
    const price = evaluateFunction(store, owner, { function: 'withinBudget', object: object.ref, budget: input.budget, priceBasis: 'firm_quote' }, budget);
    if (!variant || p.variantRevision !== variant.revision) return unknown('The quoted product specification revision is not current', [object.ref]);
    if (!requested || !offered) return unknown('Requested or quoted quantity is unavailable in a supported unit', [object.ref]);
    if (p.capacity === undefined || p.capacity === 'unknown' || !p.capacityObservationRef) return unknown('Current capacity for the quoted quantity is not evidenced', [object.ref]);
    if (!p.deliveryCommitment) return unknown('No provider delivery commitment is evidenced; an ETA is insufficient', [object.ref]);
    if (!p.deliveryDestination) return unknown('No delivery destination is bound to this quote', [object.ref]);
    if (price.status !== 'known') return unknown(price.reason ?? 'Complete scoped total is not evidenced', price.evidenceRefs, price.evidenceLevels);
    if (digest(p.deliveryDestination) !== digest(input.destination)) return unknown('No verified equivalence for this service destination', [object.ref]);
    return known(same(variant.ref, requestedVariant.ref) && offered.dimension === requested.dimension && offered.scaled === requested.scaled && p.capacity === 'confirmed' && price.value === 'pass' && Date.parse(String(p.deliveryCommitment)) <= Date.parse(input.deadline) ? 'pass' : 'fail', [object.ref, variant.ref, ...price.evidenceRefs], price.evidenceLevels);
  }
  if (input.function === 'slotAvailability' && 'venue' in input) {
    requireType(object, 'ReservationSlot'); const requestedVenue = store.read(owner, input.venue, budget); requireType(requestedVenue, 'Venue');
    const venue = one(store, owner, object.ref, 'venue', budget), evidence = proof(store, owner, object.ref, budget);
    if (!venue || !evidence || !p.expiresAt || Date.parse(String(p.expiresAt)) <= store.now() || p.partySizeEligibility === undefined || !p.startsAt || !p.timeZone) return unknown('Current slot availability is not evidenced', [object.ref]);
    return known(same(venue.ref, requestedVenue.ref) && Date.parse(String(p.startsAt)) === Date.parse(input.startsAt) && p.timeZone === input.timeZone && Number(p.partySizeEligibility) >= input.partySize ? 'pass' : 'fail', [object.ref, venue.ref, ...evidence.refs], evidence.levels);
  }
  throw new DomainError('INVALID_INPUT', 'Unknown registered ontology function');
}
export function deriveProperty(store: OntologyObjectStore, owner: string, ref: ObjectRef, name: string, budget: ReadBudget) {
  return evaluateFunction(store, owner, { function: name, object: ref }, budget);
}
