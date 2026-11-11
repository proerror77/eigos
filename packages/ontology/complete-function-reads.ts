import type { OntologyModel } from './model.js';
import type { FunctionReadSet } from './function-contracts.js';
import { serviceDomains, domainEntityLinkName, domainBusinessLinksFor } from './service-domains.js';
import { commerceEntitySchemas } from './commerce-journey.js';
import { identityTypes } from './identity-model.js';

/** Reviewed program reads, not graph-wide reachability. Target types are closed
 * from these named links; no implicit all-links or all-types grant is generated. */
class Reads {
  private types = new Set<string>();
  private relationships = new Map<string, FunctionReadSet['relationships'][number]>();
  private proof = false;
  private extras: Partial<FunctionReadSet> = {};
  constructor(private model: OntologyModel, types: readonly string[] = []) { this.objects(...types); }
  objects(...types: string[]): this { for (const type of types) { if (!this.model.hasType(type)) throw new Error(`Unknown reviewed read type: ${type}`); this.types.add(type); } return this; }
  links(type: string, names: readonly string[], optional = false): this {
    this.objects(type);
    for (const name of names) {
      const as = this.model.isInterface(type) ? type : undefined;
      let found = false;
      for (const source of as ? this.model.concreteTypes(as) : [type]) {
        try { this.objects(this.model.navigation(source, name, as).other.type); found = true; }
        catch (error) { if (!optional) throw new Error(`Unavailable reviewed read relationship: ${source}.${name}`, { cause: error }); }
      }
      if (!found && !optional) throw new Error(`Unknown reviewed read relationship: ${type}.${name}`);
      this.relationships.set(`${type}.${name}`, { type, name, ...(optional ? { optional: true } : {}) });
    }
    return this;
  }
  /** A branch-specific link is present only on the indicated concrete variants. */
  variants(types: readonly string[], names: readonly string[]): this {
    for (const name of names) {
      let found = false;
      for (const type of types) if (this.model.sides(type).some(side => side.side.name === name)) { this.links(type, [name]); found = true; }
      if (!found) throw new Error(`No reviewed variant implements relationship: ${name}`);
    }
    return this;
  }
  evidence(...types: string[]): this { this.proof = true; this.objects('SourceReceipt'); for (const type of types) this.links(type, ['sourceReceipts']); return this; }
  privateSource(): this { this.proof = true; return this; }
  proofLinks(...ids: string[]): this {
    this.extras.linkProofs = [...new Set([...(this.extras.linkProofs ?? []), ...ids])];
    for (const id of ids) this.model.link(id);
    return this;
  }
  with(extras: Partial<FunctionReadSet>): this { this.extras = { ...this.extras, ...extras }; return this; }
  merge(other: FunctionReadSet): this {
    this.objects(...other.types); this.proof ||= other.sourceProof;
    for (const link of other.relationships) this.relationships.set(`${link.type}.${link.name}`, link);
    if (other.linkProofs) this.proofLinks(...other.linkProofs);
    for (const key of ['objectViews', 'relationshipViews'] as const) if (other[key]) this.extras[key] = [...new Set([...(this.extras[key] ?? []), ...other[key]!])];
    if (other.sourceContext) this.extras.sourceContext = other.sourceContext;
    return this;
  }
  finish(): FunctionReadSet { return { types: [...this.types].sort(), relationships: [...this.relationships.values()].sort((a, b) => `${a.type}.${a.name}`.localeCompare(`${b.type}.${b.name}`)), sourceProof: this.proof, ...this.extras }; }
}

export function completeFunctionReadSets(model: OntologyModel): ReadonlyMap<string, FunctionReadSet> {
  const result = new Map<string, FunctionReadSet>(), make = (...types: string[]) => new Reads(model, types);
  const set = (names: string | readonly string[], reads: Reads | FunctionReadSet) => { const value = reads instanceof Reads ? reads.finish() : reads; for (const id of typeof names === 'string' ? [names] : names) result.set(id, value); };
  const declaredInputs = (id: string) => model.function(id).inputTypes;
  const sourceObservation = (types: readonly string[], taskLink = 'scope') => {
    const reads = make(...types).evidence(...types);
    for (const type of types) reads.links(type, ['request', taskLink]);
    return reads;
  };
  set('authorizationStatus', make('Authorization'));
  set('offerFreshness', make('Offer').evidence('Offer'));
  set('remainingQuantity', make('OrderLine').links('OrderLine', ['allocations', 'order']).links('DeliveryAllocation', ['deliveryEvent', 'shipment'])
    .links('Shipment', ['order']).links('DeliveryEvent', ['shipment']).evidence('DeliveryEvent', 'DeliveryAllocation'));
  set('actualArrival', make('Shipment').links('Shipment', ['deliveryEvents']).links('DeliveryEvent', ['allocations']).links('DeliveryAllocation', ['shipment']).evidence('DeliveryEvent', 'DeliveryAllocation'));
  const reservation = make('Reservation').links('Reservation', ['slot', 'depositPayments']).evidence('Reservation', 'Payment').finish();
  set('reservationStatus', reservation);
  set('reservationMatches', make('Venue').merge(reservation).links('ReservationSlot', ['venue']));
  set('deliveryQuoteMatches', make('DeliveryQuote', 'ServiceRequest').links('DeliveryQuote', ['parcel', 'route', 'request'])
    .links('ServiceRequest', ['selectedRoute']).links('Parcel', ['request']).links('DeliveryRoute', ['request', 'originAddress', 'destinationAddress']).evidence('DeliveryQuote'));
  set('withinBudget', make(...declaredInputs('withinBudget')).evidence('DeliveryQuote', 'ProductOffer', 'FulfillmentOffer'));
  set('productOfferMatches', make('ProductOffer', 'ProductVariant').links('ProductOffer', ['productVariant']).evidence('ProductOffer'));
  set('slotAvailability', make('ReservationSlot', 'Venue').links('ReservationSlot', ['venue']).evidence('ReservationSlot'));
  set('errandQuoteMatches', make('DeliveryQuote').links('DeliveryQuote', ['request', 'parcel', 'route']).links('ServiceRequest', ['selectedRoute']).evidence('DeliveryQuote'));
  set('transactionRoleStatus', make('TransactionPartyRole', 'TransactionRoleScope', 'TransactionParty', 'ChannelParticipation').links('TransactionPartyRole', ['successors'])
    .links('ChannelParticipation', ['provider']).evidence('TransactionPartyRole').proofLinks('TransactionRoleScope', 'TransactionRoleParty', 'TransactionRoleParticipation', 'TransactionRolePredecessor'));

  const commerceTypes = Object.keys(commerceEntitySchemas);
  const commerce = sourceObservation(commerceTypes);
  for (const type of commerceTypes) commerce.links(type, ['dependsOn']);
  commerce.links('CommerceTask', commerceTypes.map(type => `observed${type}`));
  const commerceReads = commerce.finish();
  set(['commerceObservationStatus', 'commerceJourneyStatus'], commerceReads);
  set(['shippingGateStatus', 'customsGateStatus'], make().merge(commerceReads).links('CommerceTask', ['customsRuleSet']).links('CustomsRuleSet', ['references']));
  set('stripePaymentStatus', sourceObservation(['StripePaymentObservation']).merge(commerceReads).links('StripePaymentObservation', ['order']).links('CommerceTask', ['stripePayments']));
  set(['checkoutReadiness', 'commerceOrderOutcome'], make('CheckoutSession').evidence('CheckoutSession'));
  set('catalogReadStatus', make('CatalogRead').links('CatalogRead', ['offers']).evidence('CatalogRead', 'ProductOffer'));
  const catalog = sourceObservation(['CatalogObservation', 'CatalogEndpoint']).links('CatalogObservation', ['offers']).evidence('ProductOffer').finish();
  set('catalogObservationStatus', catalog);
  set('productAttributesMatch', make('ProductVariant', 'ProductOffer', 'CommerceProduct').merge(commerceReads).merge(catalog)
    .links('ProductOffer', ['productVariant']).links('ProductVariant', ['currentCatalogObservation', 'currentCommerceProduct']).links('CommerceProduct', ['productVariant']));
  const agreement = make('OrderLine').links('OrderLine', ['agreementReceipt', 'agreedProduct', 'agreedQuote', 'agreedCheckout', 'agreementOrderObservation'])
    .evidence('CommerceProduct', 'LandedCostQuote', 'CommerceCheckout', 'CommerceOrderObservation').finish();
  set('orderLineAgreementStatus', agreement);
  set('shipmentAllocationStatus', make('Shipment').merge(agreement).links('Shipment', ['expectedOrderLine', 'expectedQuote', 'order', 'allocations'])
    .links('Order', ['shipments']).links('DeliveryAllocation', ['orderLine', 'deliveryEvent']).evidence('Shipment', 'DeliveryAllocation', 'DeliveryEvent'));

  const booking = ['BookingOffers', 'BookingObservation', 'BookingPaymentObservation'];
  set('bookingObservationStatus', sourceObservation(booking).links('BookingTask', booking.map(type => `observed${type}`)).variants(booking, ['booking', 'offers', 'original']));
  const shopify = ['ShopifyPaymentProducts', 'ShopifyPaymentCheckoutObservation', 'ShopifyCheckoutPaymentObservation'];
  set('shopifyPAPaymentStatus', sourceObservation(shopify).links('ShopifyPaymentTask', shopify.map(type => `observed${type}`)).variants(shopify, ['checkout', 'products', 'original']));
  const registration = ['RegistrationOffer', 'RegistrationRecord'];
  set('registrationStatus', sourceObservation(registration, 'task').links('RegistrationTask', registration.map(type => `${type}Observations`)));
  set('shopifyCheckoutObservationStatus', sourceObservation(['ShopifyCheckoutProducts', 'ShopifyCheckoutObservation']).privateSource());
  set('meituanReadStatus', sourceObservation(['MeituanReadObservation']).links('MeituanReadObservation', ['dependencies']));
  set('paotuiObservationStatus', sourceObservation(['PaotuiObservation']).links('PaotuiObservation', ['quote']).links('ServiceRequest', ['selectedRoute'])
    .objects('Parcel', 'DeliveryRoute', 'SavedAddress').evidence('DeliveryQuote').privateSource());
  set('paymentCommerceReadStatus', sourceObservation(['PaymentCommerceReadObservation']));
  const rollingGo = sourceObservation(['RollingGoSearchObservation']).finish();
  set('rollingGoSearchStatus', rollingGo);
  set('didiOrderStatus', sourceObservation(['DidiOrderObservation']));
  set(['didiOrderTestStatus', 'didiOrderTestIdentity', 'selectDidiOrderTestPlace'], sourceObservation(['DidiOrderTestPlaceObservation', 'DidiOrderTestQuote', 'DidiTestOrderObservation']));

  const subjects = Object.values(identityTypes), observations = subjects.filter(type => model.hasType(`${type}Observation`)).map(type => `${type}Observation`);
  const identities = make('EntityIdentityAssertion', ...subjects, ...observations).merge(catalog).merge(commerceReads).merge(rollingGo)
    .evidence('EntityIdentityAssertion', ...subjects.filter(type => type !== 'ProductVariant'), ...observations)
    .links('ProductVariant', ['currentCatalogObservation', 'currentCommerceProduct']).links('CommerceProduct', ['productVariant']).links('RollingGoSearchObservation', ['hotels'])
    .proofLinks('IdentityAssertionLeft', 'IdentityAssertionRight', 'IdentityAssertionPredecessor');
  for (const type of subjects) if (model.sides(type).some(side => side.side.name === 'currentObservation')) identities.links(type, ['currentObservation']);
  for (const type of subjects) identities.links(type, ['identityAssertionsAsLeft', 'identityAssertionsAsRight']);
  for (const type of observations) identities.links(type, ['entity']);
  set(['entityIdentityBetween', 'entityIdentityStatus'], identities);

  for (const domain of serviceDomains) {
    // These domain records have both a requirements relation and their own
    // original request, but do not have a technical source-task scope.
    const eligible = sourceObservation([domain.candidateType], 'requirements').links(domain.requestType, ['request']).links(domain.candidateType, ['provider']).links(domain.requestType, ['options']);
    for (const type of domain.objects) {
      const name = domainEntityLinkName(type), observation = `${type}Observation`;
      eligible.links(domain.candidateType, [name, `${name}Observations`]).links(domain.requestType, [name])
        .links(type, ['currentObservation']).links(observation, ['entity', 'provider']).evidence(type, observation);
    }
    set(domain.eligibleFunction, eligible);
    const outcome = sourceObservation([domain.resultType], 'requirements').links(domain.requestType, ['request']).links(domain.resultType, ['selectedOption', 'provider']).links(domain.candidateType, ['request', 'requirements']);
    if (domain.id === 'hotel') outcome.links(domain.candidateType, ['hotelRatePlanObservations']).links('HotelRatePlanObservation', ['provider']).evidence('HotelRatePlanObservation');
    for (const type of domain.resultObjects) {
      const name = domainEntityLinkName(type), observation = `${type}Observation`;
      outcome.links(domain.resultType, [name, `${name}Observations`]).links(observation, ['entity', 'provider']).evidence(observation);
      if (['TransportAssignment', 'VehicleInspection'].includes(type)) outcome.links(observation, domainBusinessLinksFor(domain.id).filter(link => link.from === type).map(link => link.name));
    }
    set(domain.outcomeFunction, outcome);
  }
  set('taskOutcomeStatus', make('ServiceRequest', 'OutcomeAssessment').links('OutcomeAssessment', ['request', 'goalCoverage', 'callerPlan', 'acceptedArtifact']).links('ServiceArtifact', ['request'])
    .links('ExecutionPlan', ['request', 'context', 'steps']).links('ExecutionContext', ['request']).links('ExecutionStep', ['request', 'actionType', 'results'])
    .links('ExecutionResult', ['attempt', 'step']).links('ExecutionAttempt', ['step', 'authorization']).links('Authorization', ['request', 'executionPlan', 'approver']));
  set('businessFactStatus', make('ObservedFact').evidence('ObservedFact').links('ObservedFact', ['request', 'subject'], true)
    .with({ objectViews: ['ObservedFact', 'MonetaryFact'], relationshipViews: ['ObservedFact'], sourceContext: 'root_source_read_context' }));
  return result;
}
