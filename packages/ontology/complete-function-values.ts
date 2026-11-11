import { z } from 'zod';
import { objectRefSchema, type OntologyModel } from './model.js';
import { quantitySchema } from './business-model.js';
import { productAttributesSchema, orderLineSourceAgreementSchema, shipmentExpectedAllocationSchema } from './product-attributes.js';
import { commerceEntitySchemas } from './commerce-journey.js';
import { identityKindSchema } from './identity-model.js';
import { serviceDomains } from './service-domains.js';

const text = z.string(), time = z.iso.datetime({ offset: true }), sha = z.string().regex(/^[a-f0-9]{64}$/);
const strings = z.array(text), refs = z.array(objectRefSchema), no = z.literal(false), yes = z.literal(true), unknown = z.literal('unknown');
const verdict = z.enum(['satisfied', 'unsatisfied', 'unknown']);
const criterion = z.strictObject({ id: text, result: z.enum(['pass', 'fail', 'unknown']), reason: text });
const assessment = z.strictObject({ status: verdict, criteria: z.array(criterion), endpoint: text });
const comparison = { status: z.enum(['matches', 'different']), matches: z.boolean(), missing: strings, different: strings };

/** Reuse the actual published source parsers. A result contract must not replace
 * a source's structured data with a guessed type or a permissive unknown value. */
function unwrapped(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (['optional', 'nullable', 'default', 'prefault', 'catch', 'readonly', 'nonoptional'].includes(current._zod.def.type)
    && 'innerType' in current._zod.def) current = current._zod.def.innerType as z.ZodType;
  return current;
}
function field(schema: z.ZodType, ...path: string[]): z.ZodType {
  let current = schema;
  for (const key of path) {
    const object = unwrapped(current);
    if (!('shape' in object) || !object.shape || typeof object.shape !== 'object' || !Object.hasOwn(object.shape, key)) throw new Error(`Missing source result schema field: ${path.join('.')}`);
    current = (object.shape as Record<string, z.ZodType>)[key]!;
  }
  return current;
}
function extend(schema: z.ZodType, fields: Record<string, z.ZodType>): z.ZodType {
  const source = unwrapped(schema);
  if ('safeExtend' in source && typeof source.safeExtend === 'function') return source.safeExtend(fields) as z.ZodType;
  if ('options' in source && Array.isArray(source.options)) return z.union((source.options as z.ZodType[]).map(option => extend(option, fields)));
  throw new Error('A spread result requires an actual object source schema');
}

/** Every entry follows the corresponding handler return expression. The source
 * schemas retain their existing enum/refinement/opaque-payload boundaries. */
export function completeFunctionValueSchemas(model: OntologyModel): ReadonlyMap<string, z.ZodType> {
  const property = (type: string, name: string) => {
    const value = model.properties(type)[name];
    if (!value) throw new Error(`Missing result source property: ${type}.${name}`);
    return value.schema;
  };
  const maybe = (type: string, name: string) => model.properties(type)[name]?.required ? property(type, name) : property(type, name).optional();
  const snapshot = (type: string, ...path: string[]) => field(property(type, 'snapshot'), ...path);
  const data = (type: string, ...path: string[]) => path.length ? field(property(type, 'data'), ...path) : property(type, 'data');
  const values = new Map<string, z.ZodType>();
  const set = (names: string | readonly string[], value: z.ZodType) => { for (const name of typeof names === 'string' ? [names] : names) values.set(name, value); };

  set('offerFreshness', z.boolean());
  set('remainingQuantity', quantitySchema);
  set('actualArrival', time);
  set('reservationStatus', z.union([property('Reservation', 'reservationState'), z.literal('expired')]));
  set(['deliveryQuoteMatches', 'withinBudget', 'reservationMatches', 'productOfferMatches', 'slotAvailability'], z.enum(['pass', 'fail']));
  set('authorizationStatus', z.enum(['unknown', 'revoked', 'expired', 'active']));
  set('taskOutcomeStatus', z.strictObject({
    status: maybe('OutcomeAssessment', 'judgment'), taskState: maybe('OutcomeAssessment', 'taskState'), requestedOutcome: maybe('ServiceRequest', 'requestedOutcome'),
    criterionResults: maybe('OutcomeAssessment', 'criterionResults'), sourceReceiptRefs: maybe('OutcomeAssessment', 'evidenceRefs'),
    goalCoverage: z.union([field(property('GoalCoverage', 'review'), 'verdict'), z.literal('caller_contract'), z.literal('unreviewed')]),
    callerExecutionRefs: refs.optional(), assessedAt: maybe('OutcomeAssessment', 'assessedAt'),
    meaning: z.literal('Historical task acceptance, not a fresh provider observation or new authority'),
  }));
  set('productAttributesMatch', z.strictObject({ ...comparison, requested: productAttributesSchema, actual: productAttributesSchema, grantsAuthority: no }));
  set('orderLineAgreementStatus', z.strictObject({ status: z.literal('fixed_source_agreement'), sourceAgreement: orderLineSourceAgreementSchema, agreedAttributes: productAttributesSchema.optional(), physicalAttributes: unknown, grantsAuthority: no, provesDelivery: no }));
  const pieces = z.strictObject({ amount: z.string().regex(/^(0|[1-9]\d{0,3})$/), unit: z.literal('piece') });
  set('shipmentAllocationStatus', z.strictObject({ status: z.enum(['source_reported_quantity_complete', 'partial', 'pending']), sourceGroupId: shipmentExpectedAllocationSchema.shape.sourceGroupId,
    orderLine: shipmentExpectedAllocationSchema.shape.orderLine, sourceQuote: shipmentExpectedAllocationSchema.shape.sourceQuote,
    expectedQuantity: shipmentExpectedAllocationSchema.shape.quantity, receivedQuantity: pieces, remainingQuantity: pieces,
    physicalAttributes: unknown, grantsAuthority: no, provesPhysicalAttributes: no }));
  set(['entityIdentityBetween', 'entityIdentityStatus'], z.strictObject({ status: z.enum(['equivalent', 'different', 'unknown', 'conflict', 'revoked', 'expired']), identityKind: identityKindSchema,
    left: objectRefSchema, right: objectRefSchema, reasons: strings, requestedAssertion: objectRefSchema.optional(), superseded: z.boolean().optional(),
    currentAssertions: refs, grantsAuthority: no, mergesObjects: no, transfersTerms: no }));
  set('errandQuoteMatches', z.strictObject({ ...comparison, status: z.enum(['matches', 'different', 'unsupported']), binding: z.literal('read_only_delivery_preview'), grantsAuthority: no, provesFulfillment: no }));
  set('transactionRoleStatus', z.union([
    z.strictObject({ status: z.literal('superseded'), successors: refs, grantsAuthority: no }),
    z.strictObject({ status: z.enum(['revoked', 'expired', 'declared', 'assigned']), role: field(property('TransactionPartyRole', 'assignment'), 'role'),
      scope: field(property('TransactionPartyRole', 'assignment'), 'scope'), party: field(property('TransactionPartyRole', 'assignment'), 'party'), grantsAuthority: no }),
  ]));
  for (const domain of serviceDomains) {
    set(domain.eligibleFunction, assessment);
    set(domain.outcomeFunction, assessment.safeExtend({ serviceVariant: z.enum(['instant', 'chauffeured', 'self_drive']).optional(), variantEndpoint: text.optional() }));
  }

  set('checkoutReadiness', z.strictObject({ status: verdict, scope: z.literal('protocol_readiness_only'), purchaseFeasibility: unknown,
    checkoutState: snapshot('CheckoutSession', 'checkout', 'state'), total: snapshot('CheckoutSession', 'checkout', 'total'), grantsAuthority: no, orderCreated: z.boolean(), paymentState: unknown,
    fulfillment: z.union([snapshot('CheckoutSession', 'order', 'fulfillment'), unknown]) }));
  set('commerceOrderOutcome', assessment.safeExtend({ endpoint: z.enum(['checkout_prepared', 'order_confirmed']) }));
  set('catalogReadStatus', z.strictObject({ phase: snapshot('CatalogRead', 'phase'), query: snapshot('CatalogRead', 'query'), merchant: snapshot('CatalogRead', 'merchant'),
    itemCount: z.number().int().nonnegative(), items: snapshot('CatalogRead', 'items'), completeness: snapshot('CatalogRead', 'completeness'), stockQuantity: unknown,
    deliveryCommitment: unknown, partnerTrust: z.literal('unverified'), grantsAuthority: no, noBusinessWrites: yes }));
  const catalogShape: Record<string, z.ZodType> = {};
  for (const name of ['action', 'merchant', 'country', 'items', 'observedAt', 'expiresAt', 'completeness', 'stockQuantity', 'deliveryCommitment', 'partnerTrust']) catalogShape[name] = snapshot('CatalogObservation', name);
  set('catalogObservationStatus', z.strictObject({ ...catalogShape, receiptId: snapshot('CatalogObservation', 'receipt', 'id'), grantsAuthority: no, noBusinessWrites: yes }));
  set('paotuiObservationStatus', extend(property('PaotuiObservation', 'summary'), { grantsAuthority: no }));
  set('meituanReadStatus', z.strictObject({ data: snapshot('MeituanReadObservation', 'data'), observedAt: snapshot('MeituanReadObservation', 'observedAt'), freshnessPolicyUntil: snapshot('MeituanReadObservation', 'expiresAt'), noBusinessWrites: yes }));
  set('rollingGoSearchStatus', z.strictObject({ hotels: snapshot('RollingGoSearchObservation', 'hotels'), input: snapshot('RollingGoSearchObservation', 'input'), priceKind: z.literal('reference'), providerExpiry: unknown, noBusinessWrites: yes }));
  set('paymentCommerceReadStatus', z.strictObject({ provider: snapshot('PaymentCommerceReadObservation', 'provider'), query: snapshot('PaymentCommerceReadObservation', 'query'), result: snapshot('PaymentCommerceReadObservation', 'result'), noBusinessWrites: yes, paymentPerformedByEigos: no }));
  set('didiOrderStatus', extend(snapshot('DidiOrderObservation', 'source', 'data'), { evidenceKind: snapshot('DidiOrderObservation', 'evidenceKind'), realOperationsAllowed: no }));
  set('didiOrderTestStatus', z.strictObject({ data: snapshot('DidiTestOrderObservation', 'data'), testOnly: yes, realOrder: no, realPayment: no, evidenceKind: snapshot('DidiTestOrderObservation', 'evidenceKind') }));
  set('didiOrderTestIdentity', z.strictObject({ orderId: text, historicalIdentityOnly: yes, currentStateKnown: no }));
  set('selectDidiOrderTestPlace', z.strictObject({ placeId: sha }));

  const shopBase = { merchant: snapshot('ShopifyCheckoutProducts', 'merchant'), observedAt: snapshot('ShopifyCheckoutProducts', 'observedAt'), expiresAt: snapshot('ShopifyCheckoutProducts', 'expiresAt'),
    receiptId: snapshot('ShopifyCheckoutProducts', 'receipt', 'id'), evidenceKind: snapshot('ShopifyCheckoutProducts', 'evidenceKind'), paymentActionsAllowed: no, orderActionsAllowed: no };
  set('shopifyCheckoutObservationStatus', z.union([
    z.strictObject({ ...shopBase, action: z.literal('ReadShopifyCheckoutProducts'), items: unwrapped(snapshot('ShopifyCheckoutProducts', 'products')) }),
    z.strictObject({ ...shopBase, action: z.enum(['CreateShopifyCheckout', 'ReadShopifyCheckout']), checkout: unwrapped(snapshot('ShopifyCheckoutObservation', 'checkout')) }),
  ]));
  set('shopifyPAPaymentStatus', z.union([
    z.strictObject({ status: z.literal('known'), data: data('ShopifyPaymentProducts') }),
    z.strictObject({ status: data('ShopifyPaymentCheckoutObservation', 'checkout', 'status'), independentRead: z.boolean(), readyForPayment: z.boolean(), data: data('ShopifyPaymentCheckoutObservation') }),
    z.strictObject({ status: data('ShopifyCheckoutPaymentObservation', 'state'), paid: z.boolean(), data: data('ShopifyCheckoutPaymentObservation') }),
  ]));
  set('bookingObservationStatus', z.union([
    z.strictObject({ status: z.literal('known'), data: data('BookingOffers'), evidenceLevel: z.literal('synthetic') }),
    z.strictObject({ status: data('BookingObservation', 'state'), independentRead: z.boolean(), readyForPayment: z.boolean(), data: data('BookingObservation'), evidenceLevel: z.literal('synthetic') }),
    z.strictObject({ status: data('BookingPaymentObservation', 'state'), independentRead: z.boolean(), paid: z.boolean(), data: data('BookingPaymentObservation'), evidenceLevel: z.literal('synthetic') }),
  ]));
  const registrationLevel = snapshot('RegistrationOffer', 'evidenceLevel');
  set('registrationStatus', z.union([
    z.strictObject({ status: z.literal('known'), free: z.boolean(), canSubmit: z.boolean(), data: data('RegistrationOffer'), evidenceLevel: registrationLevel }),
    z.strictObject({ status: data('RegistrationRecord', 'state'), free: z.boolean(), independentRead: z.boolean(), submitted: z.boolean(), confirmed: z.boolean(), data: data('RegistrationRecord'), evidenceLevel: registrationLevel }),
  ]));
  set('stripePaymentStatus', z.strictObject({ status: z.enum(['test_paid', 'prepared', 'failed', 'pending']), data: data('StripePaymentObservation'), evidenceLevel: snapshot('StripePaymentObservation', 'evidenceLevel'), tokenSource: z.literal('stripe_test_helper'), bankSettlementVerified: no, realPayment: no }));

  const gap = z.strictObject({ fact: text, source: text, reason: text, suggestedActions: strings });
  const readiness = z.strictObject({ status: verdict, gaps: z.array(gap) });
  const commerceTypes = Object.keys(commerceEntitySchemas) as [keyof typeof commerceEntitySchemas, ...(keyof typeof commerceEntitySchemas)[]];
  set('commerceObservationStatus', z.union(commerceTypes.map(type => z.strictObject({ type: z.literal(type), data: commerceEntitySchemas[type], sourceId: text, sourceVersion: z.number().int().positive(), observedAt: time, expiresAt: time, assessment: readiness, evidenceLevel: z.literal('synthetic'), realOperationsAllowed: no }))));
  set('commerceJourneyStatus', z.strictObject({ target: field(property('CommerceTask', 'input'), 'target'), facts: z.array(z.union([
    z.strictObject({ object: objectRefSchema, type: z.enum(commerceTypes), sourceId: text, status: z.literal('known'), readiness }),
    z.strictObject({ object: objectRefSchema, type: z.enum(commerceTypes), sourceId: z.literal(''), status: z.literal('unknown') }),
  ])), missingFacts: z.array(gap.omit({ reason: true })), note: z.literal('These are evidence gaps, not a prescribed action order. Select and compare candidates yourself; a known object can still have unsatisfied or unknown readiness.'), realOperationsAllowed: no }));
  const shipping = z.strictObject({ status: z.enum(['known', 'unknown']), regime: z.enum(['domestic', 'regional', 'customs', 'mixed', 'unknown']), customsRequired: z.union([z.boolean(), unknown]), routeDigest: sha,
    groups: z.array(z.strictObject({ id: text, regime: z.enum(['domestic', 'regional', 'customs']), customsRequired: z.boolean(), reason: text })), reason: text.optional() });
  const customsScope: Record<string, z.ZodType> = {};
  for (const name of ['merchantId', 'variantId', 'quantity', 'destinationCountry', 'dispatchCountries', 'goodsOriginCountry', 'hsCode', 'sourceRuleVersion']) customsScope[name] = field(commerceEntitySchemas.CustomsAssessment, name);
  set(['customsGateStatus', 'shippingGateStatus'], z.strictObject({ status: z.enum(['pass_sandbox', 'blocked', 'unknown']), policyDigest: sha, ruleSet: objectRefSchema, coverage: z.literal('synthetic_commerce_only'), legalApproval: no,
    checks: z.array(z.strictObject({ id: text, result: z.enum(['pass', 'blocked', 'unknown']), reason: text })), references: refs, sourceRefs: refs, shipping: shipping.optional(), customsApplicability: z.enum(['required', 'not_applicable', 'unknown']).optional(), scope: z.strictObject(customsScope).optional() }));
  const view = (type: string) => z.strictObject(Object.fromEntries(Object.entries(model.properties(type)).map(([name, definition]) => [name, definition.required ? definition.schema : definition.schema.optional()])));
  set('businessFactStatus', z.strictObject({ currentObservation: yes, businessCompletion: no, properties: z.union([view('ObservedFact'), view('MonetaryFact')]) }));
  return values;
}
