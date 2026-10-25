import { compositionObjects, compositionLinks, compositionActions } from './composition.js';
import { registrationObjects, registrationLinks, registrationActions, registrationFunctions } from './free-booking.js';
import { meituanReadObjects, meituanReadLinks, meituanReadActions, meituanReadFunctions } from './meituan-read.js';
import { bookingObjects, bookingLinks, bookingActions, bookingFunctions } from './booking.js';
import { stripePaymentObjects, stripePaymentLinks, stripePaymentActions, stripePaymentFunctions } from './stripe-payment.js';
import { z } from 'zod';
import { goalReviewSchema } from './goal-coverage.js';
import { domainActions, domainConditionSchemas, domainFunctions, domainLinks, domainObjects, domainNames } from './service-domains.js';
import { commerceActions, commerceFunctions, commerceLinks, commerceObjects } from './commerce.js';
import { catalogReadFunctions, catalogReadLinks, catalogReadObjects } from './catalog-read.js';
import { rideEstimateActions, rideEstimateFunctions, rideEstimateLinks, rideEstimateObjects } from './ride-estimate.js';
import { catalogAgentActions, catalogAgentFunctions, catalogAgentLinks, catalogAgentObjects } from './catalog-agent.js';
import { commerceJourneyActions, commerceJourneyFunctions, commerceJourneyLinks, commerceJourneyObjects } from './commerce-journey.js';
import { customsPolicyObjects, customsPolicyLinks, customsPolicyFunctions } from './customs-policy.js';
import { OntologyModel, objectRefSchema, type ModelDefinition, type ObjectTypeDefinition, type PropertyDefinition as P, type LinkDefinition } from './model.js';

export const decimalSchema = z.string().regex(/^(0|[1-9]\d{0,14})(?:\.\d{1,6})?$/);
export const quantitySchema = z.object({ amount: decimalSchema, unit: z.enum(['kg', 'g', 'piece', 'cup', 'person']) }).strict().refine(q => !['piece', 'cup', 'person'].includes(q.unit) || !q.amount.includes('.'), 'Count units require integers');
const massQuantitySchema = quantitySchema.refine(q => ['kg', 'g'].includes(q.unit), 'Parcel weight requires a mass unit');
export const moneyValueSchema = z.object({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.enum(['CNY', 'USD', 'EUR']) }).strict();
export const timeZoneSchema = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } });
export const addressValueSchema = z.object({ text: z.string().min(1).max(1000), city: z.string().min(1).max(100).optional(), sourceRevision: z.string().max(200).optional() }).strict();
export const pricingSchema = z.object({
  total: moneyValueSchema.optional(), scope: z.enum(['all_mandatory_fees', 'partial', 'unknown']),
  components: z.array(z.object({ role: z.enum(['service', 'goods', 'delivery', 'packing', 'tax', 'deposit', 'discount']), amount: moneyValueSchema }).strict()).max(20),
}).strict();
const conditionSource = z.object({ messageId: z.string().min(1).max(200), quote: z.string().min(1).max(2000) }).strict();
const condition = (predicate: string, types: [string, ...string[]], role: string, phases: [string, ...string[]], operator: string, expected: z.ZodType) => z.object({
  id: z.string().min(1).max(100), predicateRef: z.object({ id: z.literal(predicate), version: z.literal('1') }).strict(),
  subject: z.object({ type: z.enum(types), role: z.literal(role), object: objectRefSchema.optional() }).strict(),
  phase: z.enum(phases), strength: z.enum(['hard', 'preference']), operator: z.literal(operator), expected, source: conditionSource,
}).strict();
// Conditions are domain data. The N2 planner must explicitly bind them; N1 never
// reinterprets an old generic requirement or lets a condition grant authority.
export const businessConditionSchema = z.union([
  ...domainConditionSchemas,
  condition('geo.query_scope_matches', ['Place'], 'search_area', ['result'], 'eq', z.object({ city: z.string().min(1).max(100), keyword: z.string().min(1).max(200) }).strict()),
  condition('parcel.quote_matches_request', ['DeliveryQuote'], 'parcel_quote', ['result'], 'eq', z.object({ weight: quantitySchema.refine(v => ['kg', 'g'].includes(v.unit)), serviceLevel: z.enum(['ordinary', 'express']), parcel: objectRefSchema.extend({ type: z.literal('Parcel') }).optional(), route: objectRefSchema.extend({ type: z.literal('DeliveryRoute') }).optional() }).strict()),
  condition('offer.total_within_budget', ['DeliveryQuote', 'ProductOffer'], 'total_price', ['precondition'], 'lte', z.object({ amount: moneyValueSchema, priceBasis: z.enum(['estimate', 'firm_quote']), scope: z.literal('all_mandatory_fees') }).strict()),
  condition('goods.variant_matches', ['ProductOffer', 'OrderLine'], 'product_variant', ['precondition', 'result'], 'eq', objectRefSchema.extend({ type: z.literal('ProductVariant') })),
  condition('goods.capacity_covers_quantity', ['ProductOffer'], 'capacity', ['precondition'], 'gte', quantitySchema),
  condition('delivery.commitment_covers_deadline', ['ProductOffer'], 'delivery_commitment', ['precondition'], 'lte', z.object({ at: z.iso.datetime({ offset: true }), timeZone: timeZoneSchema, originalText: z.string().min(1).max(200) }).strict()),
  condition('delivery.receipt_matches_request', ['OrderLine'], 'actual_delivery', ['result'], 'eq', z.object({ quantity: quantitySchema, specificationRef: z.string().min(1).max(200), destination: addressValueSchema, deadline: z.iso.datetime({ offset: true }) }).strict()),
  condition('reservation.slot_matches_request', ['ReservationSlot'], 'reservation_slot', ['precondition'], 'eq', z.object({ venue: objectRefSchema.extend({ type: z.literal('Venue') }), startsAt: z.iso.datetime({ offset: true }), timeZone: timeZoneSchema, partySize: z.number().int().min(1).max(1000) }).strict()),
  condition('reservation.confirmation_effective', ['Reservation'], 'confirmation', ['result'], 'eq', z.literal('confirmed')),
  condition('execution.within_authority', ['Authorization'], 'business_action', ['precondition'], 'eq', z.object({ action: z.string().min(1).max(100), authorized: z.literal(true) }).strict()),
]).superRefine((value, ctx) => {
  if (value.subject.object && value.subject.object.type !== value.subject.type) ctx.addIssue({ code: 'custom', message: 'Condition subject type mismatch' });
});
export type BusinessCondition = z.infer<typeof businessConditionSchema>;
const source = 'Versioned owner-scoped source mapping';
const p = (kind: P['kind'], schema: z.ZodType, description: string, extra: Partial<P> = {}): P => ({ kind, schema, description, source, ...extra });
const str = (description: string, max = 500, extra: Partial<P> = {}) => p('string', z.string().min(1).max(max), description, extra);
const time = (description: string, extra: Partial<P> = {}) => p('timestamp', z.iso.datetime({ offset: true }), description, extra);
const choice = (values: [string, ...string[]], description: string, extra: Partial<P> = {}) => p('string', z.enum(values), description, extra);
const integer = (description: string) => p('integer', z.number().int().min(0).max(1_000_000), description);
const textArray = (description: string) => p('array', z.array(z.string().min(1).max(200)).max(40), description);
const quantity = (description: string, extra: Partial<P> = {}) => p('struct', quantitySchema, description, extra);
const money = (description: string) => p('struct', moneyValueSchema, description);
const identity = p('struct', z.object({ namespace: z.string().min(1).max(150), id: z.string().min(1).max(200) }).strict(), 'Source namespaced identity');
const id = str('Stable object identity', 200, { required: true });
const title = str('Human-readable display title; never used as identity', 500, { required: true });
const address = p('struct', addressValueSchema, 'Selected address value with explicit role at the containing property');
const specification = p('array', z.array(z.object({ name: z.string().min(1).max(80), value: z.string().min(1).max(200) }).strict()).min(1).max(30), 'Observed product attributes; a matching name alone proves no equivalence');
const offerProperties: Record<string, P> = {
  offerId: id, observedAt: time('Source observation time', { required: true }), expiresAt: time('Expiry or explicit local refresh limit'),
  validityBasis: choice(['provider_expiry', 'local_refresh_limit', 'unknown'], 'Authority for the validity window', { required: true }),
  priceKind: choice(['display_price', 'estimate', 'firm_quote', 'unknown'], 'Price commitment semantics', { required: true }),
  pricingCompleteness: choice(['complete', 'partial', 'unknown'], 'Coverage of required fees', { required: true }),
  isFresh: p('boolean', z.boolean(), 'Freshness evaluated at query time', { derived: 'offerFreshness' }),
};
const evidenceTypes = ['Place', 'DeliveryQuote', 'ProductOffer', 'ReservationOffer', 'ReservationSlot', 'Order', 'Shipment', 'DeliveryEvent', 'DeliveryAllocation', 'Reservation', 'Payment', 'Refund'];
const type = (idName: string, name: string, primaryKey: string, properties: Record<string, P>, options: Partial<ObjectTypeDefinition> = {}): ObjectTypeDefinition => ({
  id: idName, version: '1', name, aliases: [name, idName], description: name, primaryKey, titleKey: 'displayTitle', properties: { [primaryKey]: id, displayTitle: title, ...properties },
  ...(evidenceTypes.includes(idName) ? { interfaces: [{ id: 'EvidenceBacked' }] } : {}), ...options,
});
const offer = (idName: string, name: string, primaryKey: string, properties: Record<string, P>) => {
  const { offerId: _key, ...common } = offerProperties;
  return type(idName, name, primaryKey, { ...common, ...properties },
    { interfaces: [{ id: 'Offer', propertyMap: { offerId: primaryKey } }] });
};
const objects: ObjectTypeDefinition[] = [
  type('GoalCoverage', '目标覆盖核查', 'coverageId', {
    requestRevision: integer('Reviewed request revision'), requestDigest: str('Exact reviewed request digest'), capabilityRef: p('struct', z.strictObject({ id: z.string(), version: z.string() }), 'Selected capability'),
    capabilityDigest: str('Reviewed capability definition digest'), input: p('struct', z.record(z.string(), z.unknown()), 'Reviewed normalized business input; never connector credentials'), inputDigest: str('Reviewed input digest'),
    review: p('struct', goalReviewSchema, 'Independent semantic coverage review with exact message partitions; not business evidence'), modelRunId: str('Actual independent model response'), assessedAt: time('Coverage review time'), digest: str('Pinned coverage record digest'),
  }),
  type('ExecutionFeedback', '任务执行反馈', 'feedbackId', {
    requestRevision: integer('Current request revision'), bindingRef: p('struct', z.strictObject({ id: z.string(), version: z.string() }), 'Program or provider binding'), bindingDigest: str('Exact execution configuration'),
    taskState: str('Protocol task state'), judgment: choice(['satisfied', 'unsatisfied', 'unknown', 'needs_human'], 'Current independent outcome'), evidenceLevel: str('Actual verification scope; never automatically promoted'),
    evidenceRefs: p('array', z.array(z.string().max(1000)).max(200), 'Source receipt references'), observedAt: time('Outcome observation time'),
  }),
  type('ServiceRequest', '服务委托', 'requestId', { originalGoal: str('Original PA goal', 10000, { required: true, source: 'Authenticated user or PA message' }), revision: integer('Business request revision'), requestedOutcome: str('Requested business outcome', 100), conditions: p('array', z.array(businessConditionSchema).max(40), 'Versioned conditions with subject, role, phase, typed value, unit and quoted instruction; no inferred authority'), progress: choice(['received', 'clarifying', 'planning', 'awaiting_authorization', 'executing', 'accepted', 'unmet', 'needs_review', 'canceled'], 'Request progress, not provider state'), projectionState: choice(['request_only', 'typed_result', 'invalid_source'], 'Coverage of this read projection; never business completion'), createdAt: time('Received time') }, { titleKey: 'originalGoal' }),
  type('Proposal', '选择方案', 'proposalId', { requestRevision: integer('Fixed request revision'), selectedAt: time('Decision time'), termsVersion: str('Fixed terms version'), decisionReason: str('Decision rationale', 2000) }),
  type('Authorization', '业务许可记录', 'authorizationId', { actor: str('Authenticated approving actor'), allowedActions: textArray('Allowed actions'), dataScope: textArray('Permitted data scope'), limits: money('Maximum permitted amount'), expiresAt: time('Grant expiry'), revoked: p('boolean', z.boolean(), 'Revocation state') }),
  type('OutcomeAssessment', '结果核验', 'assessmentId', { requestRevision: integer('Assessed revision'), judgment: choice(['satisfied', 'unsatisfied', 'unknown', 'needs_human'], 'Evidence-backed assessment'), assessedAt: time('Assessment time'), criterionResults: p('array', z.array(z.object({ criterion: z.string().max(100), result: z.enum(['pass', 'fail', 'unknown', 'needs_human']), evidenceIds: z.array(z.string().max(200)).max(30) }).strict()).max(40), 'Per-criterion results') }),
  type('Provider', '服务主体', 'providerId', { name: title, verifiedIdentityRefs: textArray('Verified identity mappings; not name similarity') }, { titleKey: 'name' }),
  type('Channel', '服务渠道', 'channelId', { name: title, accessScope: textArray('Verified access scope'), supportedOperationRefs: textArray('Registered provider operations') }, { titleKey: 'name' }),
  type('ChannelParticipation', '渠道主体关系', 'participationId', { role: choice(['seller', 'fulfiller', 'aggregator', 'booking_agent'], 'Role in this channel'), validFrom: time('Role valid from'), validUntil: time('Role valid until'), verificationRef: str('Role verification reference') }),
  type('ServiceEngagement', '提供者沟通', 'engagementId', { progress: choice(['waiting', 'returned', 'needs_input', 'unavailable'], 'Provider interaction state'), startedAt: time('Interaction start'), waitingQuestion: str('Business question', 2000), remoteReference: str('Remote task reference') }),
  type('Place', '公开地点', 'placeId', { name: title, address, coordinates: p('struct', z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict(), 'Coordinates; unit and reference system are separate'), coordinateUnit: choice(['degree'], 'Explicit coordinate unit'), coordinateSystem: str('Reference system, including explicit unknown', 100) }, { titleKey: 'name' }),
  type('SavedAddress', '本人保存地址', 'savedAddressId', { label: str('User address label'), address, contactInstructions: str('Private contact and delivery instructions', 2000, { restricted: true }), sourceReference: str('Private source address identifier', 200, { restricted: true }) }),
  type('Parcel', '包裹', 'parcelId', { contentsCategory: str('Declared goods category', 100), declaredWeight: p('struct', massQuantitySchema, 'User-declared mass, not a measurement'), declaredContents: str('Declared parcel contents') }),
  type('DeliveryRoute', '配送路线', 'routeId', { originSnapshot: address, destinationSnapshot: address, selectedAt: time('Route selection time') }),
  offer('DeliveryQuote', '配送报价', 'quoteId', { serviceLevel: choice(['ordinary', 'express'], 'Selected delivery service'), quotedWeight: p('struct', massQuantitySchema, 'Weight actually priced'), requestRevision: integer('Priced business request revision'), parcelRevision: integer('Priced parcel snapshot revision'), routeRevision: integer('Priced route snapshot revision'), estimatedArrival: time('Provider estimate, not a commitment'), pricingTerms: p('struct', pricingSchema, 'Scoped delivery price') }),
  type('ProductVariant', '商品规格', 'variantId', { name: title, sourceProductRef: identity, specification, specificationRevision: str('Specification revision') }, { titleKey: 'name' }),
  offer('ProductOffer', '商品报价', 'offerId', { offeredQuantity: quantity('Quoted product quantity'), pricingTerms: p('struct', pricingSchema, 'Scoped product and delivery price'), capacityObservationRef: str('Capacity observation reference'), capacity: choice(['confirmed', 'unavailable', 'unknown'], 'Current evidenced capacity'), deliveryDestination: address, estimatedArrival: time('Provider estimate; not a commitment'), deliveryCommitment: time('Provider commitment, not an ETA') }),
  type('Order', '订单', 'orderId', { providerOrderReference: str('Provider-issued order reference'), orderState: choice(['requested', 'pending', 'confirmed', 'canceled', 'unknown'], 'Provider order state'), createdAt: time('Order observation time'), total: money('Authoritative observed order total'), fulfillmentState: choice(['pending', 'partial', 'delivered', 'failed', 'unknown'], 'Evidence-backed fulfillment, separate from order confirmation'), sourceStartedAt: time('Local HTTP observation start; not a provider revision') }),
  type('OrderLine', '订单项', 'orderLineId', { quantityOrdered: quantity('Agreed quantity, never reduced to match a short delivery'), agreedSpecificationRef: str('Fixed specification version'), agreedPriceRef: str('Fixed price reference'), remainingQuantity: quantity('Undelivered quantity from accepted allocations', { derived: 'remainingQuantity' }) }),
  type('Shipment', '配送批次', 'shipmentId', { providerReference: str('Provider shipment reference'), shipmentState: choice(['pending', 'partial', 'delivered', 'failed', 'disputed', 'unknown'], 'Shipment state'), actualArrivalAt: time('Arrival derived from accepted delivery events', { derived: 'actualArrival' }) }),
  type('DeliveryEvent', '交付事件', 'eventId', { occurredAt: time('Business occurrence time'), observedAt: time('Receipt observation time'), sourceVersion: integer('Provider event version'), eventKind: choice(['delivered', 'partial', 'retracted'], 'Source event meaning'), sourceEventKey: str('Stable source event identity', 200) }),
  type('DeliveryAllocation', '交付数量分配', 'allocationId', { deliveredQuantity: quantity('Quantity allocated to an order line'), acceptedSpecificationRef: str('Verified delivered specification'), verificationState: choice(['pending', 'accepted', 'rejected', 'revoked'], 'Independent allocation verification'), evidenceRef: str('Source evidence reference') }),
  type('Venue', '餐厅', 'venueId', { name: title, address, timeZone: p('string', timeZoneSchema, 'Venue IANA timezone') }, { titleKey: 'name' }),
  type('ReservationSlot', '可订时段', 'slotId', { startsAt: time('Slot start'), timeZone: p('string', timeZoneSchema, 'IANA timezone'), partySizeEligibility: integer('Maximum supported party size from provider'), availabilityObservedAt: time('Availability observation'), expiresAt: time('Availability expiry') }),
  offer('ReservationOffer', '预订报价', 'offerId', { depositTerms: p('struct', z.object({ required: z.boolean(), amount: moneyValueSchema.optional() }).strict(), 'Whether a deposit is required and its amount'), cancellationTerms: str('Provider cancellation terms', 2000), holdTerms: str('Provider hold terms', 2000) }),
  type('Reservation', '餐厅预订', 'reservationId', { providerReference: str('Provider reservation reference'), reservationState: choice(['requested', 'pending', 'held', 'confirmed', 'rejected', 'expired', 'canceled', 'unknown'], 'Reservation state; paid never implies confirmed'), partySize: integer('Confirmed party size'), confirmedSlotRevision: integer('Slot revision bound by provider confirmation'), confirmedAt: time('Provider confirmation time'), holdExpiresAt: time('Hold deadline'), depositRequired: p('boolean', z.boolean(), 'Provider deposit condition'), requiredDeposit: money('Required deposit'), effectiveStatus: str('Derived reservation effectiveness', 100, { derived: 'reservationStatus' }) }),
  type('Payment', '付款记录', 'paymentId', { providerReference: str('Provider payment reference'), purpose: choice(['goods', 'deposit'], 'Payment business purpose'), amount: money('Observed payment amount'), paymentState: choice(['not_started', 'pending', 'paid', 'failed', 'unknown'], 'Payment source state'), observedAt: time('Payment observation') }),
  type('Refund', '退款记录', 'refundId', { providerReference: str('Provider refund reference'), amount: money('Observed refund amount'), refundState: choice(['not_started', 'pending', 'refunded', 'rejected', 'unknown'], 'Refund state; acceptance is not receipt of funds'), observedAt: time('Refund observation') }),
  type('AfterSalesCase', '售后事项', 'caseId', { requestedRemedy: choice(['cancel', 'refund', 'redelivery'], 'Requested remedy'), progress: choice(['requested', 'processing', 'resolved', 'rejected', 'unknown'], 'Remedy state'), originalBusinessReference: str('Original owned business reference') }),
  type('SourceReceipt', '来源回执', 'receiptId', { sourceIdentity: str('Verified source identity'), sourceEventId: str('Provider event or read receipt identity'), scope: choice(['public_locations', 'delivery_quote', 'goods_offer', 'checkout_session', 'order', 'delivery', 'reservation', 'payment', 'refund', ...domainNames.map(d => `domain_${d}`)], 'Business scope validated by the source mapping'), observedAt: time('Receipt time'), evidenceLevel: choice(['synthetic', 'provider_test', 'user_asserted', 'live_readonly', 'live_operation', 'live_fulfillment'], 'Evidence strength; synthetic is never promoted'), contentDigest: p('string', z.string().regex(/^[a-f0-9]{64}$/), 'Digest of validated source content'), subjects: p('array', z.array(z.object({ object: objectRefSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), linksDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(100), 'Source mapping binds normalized properties and outgoing business relationships'), safeSummary: str('Curated source receipt summary', 500, { required: true }), privatePayload: str('Private source payload reference', 1000, { restricted: true }) }, { titleKey: 'safeSummary' }),
];
// Only changed definitions advance. Historical object fingerprints are never rewritten.
objects.find(o => o.id === 'ServiceRequest')!.version = '5';
objects.find(o => o.id === 'ServiceRequest')!.properties.currentAssessment = p('struct', objectRefSchema, 'Current result assessment; historical assessments remain linked');
const assessment = objects.find(o => o.id === 'OutcomeAssessment')!;
assessment.version = '2';
assessment.properties.criterionResults = p('array', z.array(z.strictObject({ criterion: z.string().max(100), result: z.enum(['pass', 'fail', 'unknown', 'needs_human']), evidenceIds: z.array(z.string().max(1000)).max(200) })).max(100), 'Per-criterion evidence-backed checks');
assessment.properties.reason = str('Independent assessment explanation', 4000);
assessment.properties.evidenceRefs = p('array', z.array(z.string().max(1000)).max(200), 'Original source receipt references');
assessment.properties.evidenceLevel = str('Source evidence level; semantic coverage is not provider evidence');
assessment.properties.taskState = str('Task state when assessed');
objects.find(o => o.id === 'Order')!.version = '2';
const receiptType = objects.find(o => o.id === 'SourceReceipt')!;
receiptType.version = '4';
receiptType.properties.queryScope = p('struct', z.object({ city: z.string().min(1).max(100), keyword: z.string().min(1).max(200) }).strict(), 'Actual public query scope, bound to the validated source input digest');
const productOfferType = objects.find(o => o.id === 'ProductOffer')!;
productOfferType.version = '2';
productOfferType.properties.variantRevision = integer('Product specification object revision actually quoted');
const providerType = objects.find(o => o.id === 'Provider')!;
providerType.version = '2';
providerType.description = '服务参与主体。报价提供者可能只是履约方或代理，不能据此认定销售商家；在对应 ChannelParticipation 中核对 seller、fulfiller 或代理角色及其证据。';

const links: LinkDefinition[] = [];
const link = (idName: string, fromType: string, fromName: string, fromMany: boolean, toType: string, toName: string, toMany: boolean, required = false, reverseRequired = false) => links.push({ id: idName, description: `${fromType}.${fromName} ↔ ${toType}.${toName}`, from: { type: fromType, name: fromName, many: fromMany, required }, to: { type: toType, name: toName, many: toMany, required: reverseRequired } });
link('EngagementRequest', 'ServiceEngagement', 'request', false, 'ServiceRequest', 'engagements', true, true);
link('EngagementProvider', 'ServiceEngagement', 'provider', false, 'Provider', 'engagements', true, true);
link('ParticipationProvider', 'ChannelParticipation', 'provider', false, 'Provider', 'participations', true, true);
link('ParticipationChannel', 'ChannelParticipation', 'channel', false, 'Channel', 'participations', true, true);
link('ParcelRequest', 'Parcel', 'request', false, 'ServiceRequest', 'parcels', true, true);
link('RouteRequest', 'DeliveryRoute', 'request', false, 'ServiceRequest', 'routes', true, true);
link('SelectedRoute', 'ServiceRequest', 'selectedRoute', false, 'DeliveryRoute', 'selectedForRequest', false);
link('RouteOrigin', 'DeliveryRoute', 'originAddress', false, 'SavedAddress', 'originRoutes', true);
link('RouteDestination', 'DeliveryRoute', 'destinationAddress', false, 'SavedAddress', 'destinationRoutes', true);
link('QuoteParcel', 'DeliveryQuote', 'parcel', false, 'Parcel', 'quotes', true, true);
link('QuoteRoute', 'DeliveryQuote', 'route', false, 'DeliveryRoute', 'quotes', true, true);
link('OfferRequest', 'Offer', 'request', false, 'ServiceRequest', 'offers', true, true);
link('OfferProvider', 'Offer', 'provider', false, 'Provider', 'offers', true, true);
link('OfferChannel', 'Offer', 'channel', false, 'Channel', 'offers', true, true);
link('ReceiptRequest', 'SourceReceipt', 'request', false, 'ServiceRequest', 'sourceReceipts', true);
link('ProposalRequest', 'Proposal', 'request', false, 'ServiceRequest', 'proposals', true, true);
link('ProposalOffer', 'Proposal', 'selectedOffer', false, 'Offer', 'proposals', true, true);
link('SelectedProposal', 'ServiceRequest', 'selectedProposal', false, 'Proposal', 'selectedForRequest', false);
link('AuthorizationProposal', 'Authorization', 'proposal', false, 'Proposal', 'authorizations', true, true);
link('AssessmentRequest', 'OutcomeAssessment', 'request', false, 'ServiceRequest', 'assessments', true, true);
link('GoalCoverageRequest', 'GoalCoverage', 'request', false, 'ServiceRequest', 'goalCoverage', true, true);
link('AssessmentCoverage', 'OutcomeAssessment', 'goalCoverage', false, 'GoalCoverage', 'assessments', true);
link('AssessmentEvidence', 'OutcomeAssessment', 'sourceReceipts', true, 'SourceReceipt', 'assessments', true);
link('ExecutionFeedbackRequest', 'ExecutionFeedback', 'request', false, 'ServiceRequest', 'executionFeedback', true, true);
link('ExecutionFeedbackAssessment', 'ExecutionFeedback', 'assessment', false, 'OutcomeAssessment', 'feedback', true, true);
link('ProductOfferVariant', 'ProductOffer', 'productVariant', false, 'ProductVariant', 'offers', true, true);
link('OrderRequest', 'Order', 'request', false, 'ServiceRequest', 'orders', true, true);
link('OrderLineOrder', 'OrderLine', 'order', false, 'Order', 'lines', true, true, true);
link('OrderLineVariant', 'OrderLine', 'productVariant', false, 'ProductVariant', 'orderLines', true, true);
link('ShipmentOrder', 'Shipment', 'order', false, 'Order', 'shipments', true, true);
link('AllocationShipment', 'DeliveryAllocation', 'shipment', false, 'Shipment', 'allocations', true, true);
link('AllocationOrderLine', 'DeliveryAllocation', 'orderLine', false, 'OrderLine', 'allocations', true, true);
link('AllocationEvent', 'DeliveryAllocation', 'deliveryEvent', false, 'DeliveryEvent', 'allocations', true, true);
link('EventShipment', 'DeliveryEvent', 'shipment', false, 'Shipment', 'deliveryEvents', true, true);
link('SlotVenue', 'ReservationSlot', 'venue', false, 'Venue', 'slots', true, true);
link('ReservationOfferSlot', 'ReservationOffer', 'slot', false, 'ReservationSlot', 'offers', true, true);
link('ReservationSlot', 'Reservation', 'slot', false, 'ReservationSlot', 'reservations', true, true);
link('ReservationRequest', 'Reservation', 'request', false, 'ServiceRequest', 'reservations', true, true);
link('VenueProvider', 'Venue', 'provider', false, 'Provider', 'venues', true, true);
link('PaymentReservation', 'Payment', 'reservation', false, 'Reservation', 'depositPayments', true);
link('PaymentOrder', 'Payment', 'order', false, 'Order', 'payments', true);
link('RefundPayment', 'Refund', 'originalPayment', false, 'Payment', 'refunds', true, true);
link('RefundCase', 'Refund', 'case', false, 'AfterSalesCase', 'refunds', true, true);
link('CaseOrder', 'AfterSalesCase', 'order', false, 'Order', 'afterSalesCases', true);
link('CaseReservation', 'AfterSalesCase', 'reservation', false, 'Reservation', 'afterSalesCases', true);
for (const idName of evidenceTypes) link(`${idName}Evidence`, idName, 'sourceReceipts', true, 'SourceReceipt', idName[0]!.toLowerCase() + idName.slice(1) + 's', true, true);
links.find(l => l.id === 'OfferProvider')!.description = '报价关联的提供主体；不是销售商家身份的证明。跨渠道比较时同时核对参与角色及身份依据。';

export const BUSINESS_MODEL_DEFINITION: ModelDefinition = { id: 'eigos.business', version: '19', objects: [...objects, ...compositionObjects, ...meituanReadObjects, ...rideEstimateObjects, ...domainObjects, ...commerceObjects, ...catalogReadObjects, ...catalogAgentObjects, ...commerceJourneyObjects, ...customsPolicyObjects, ...stripePaymentObjects, ...bookingObjects, ...registrationObjects], links: [...links, ...compositionLinks, ...meituanReadLinks, ...rideEstimateLinks, ...domainLinks, ...commerceLinks, ...catalogReadLinks, ...catalogAgentLinks, ...commerceJourneyLinks, ...customsPolicyLinks, ...stripePaymentLinks, ...bookingLinks, ...registrationLinks],
  interfaces: [
    { id: 'EvidenceBacked', description: 'Objects traceable to source receipts; no automatic evidence promotion', properties: {}, links: [{ name: 'sourceReceipts', target: 'SourceReceipt', many: true }] },
    { id: 'CommerceFact', description: 'Source-bound commerce observation with explicit versioned dependencies', parents: ['EvidenceBacked'], properties: {}, links: [{ name: 'dependsOn', target: 'CommerceFact', many: true }] },
    { id: 'Offer', description: '报价共性接口；具体实例是配送、商品或预订报价', parents: ['EvidenceBacked'], properties: offerProperties, links: [{ name: 'request', target: 'ServiceRequest', many: false }, { name: 'provider', target: 'Provider', many: false }, { name: 'channel', target: 'Channel', many: false }] },
  ],
  actions: [...compositionActions,
    ...commerceJourneyActions, ...stripePaymentActions, ...bookingActions, ...registrationActions,
    ...catalogAgentActions,
    ...rideEstimateActions, ...meituanReadActions,
    ...commerceActions,
    ...domainActions,
    { id: 'RequestDeliveryQuote', description: 'Record the decision to request a quote; does not create a price or order', inputs: { request: 'ServiceRequest', parcel: 'Parcel', route: 'DeliveryRoute' }, changes: ['ServiceRequest.progress', 'ServiceRequest.selectedRoute'], submissionCriteria: ['same_owner', 'current_request_revision', 'explicit_read_scope', 'complete_route_and_parcel'], providerOperation: 'delivery_preview' },
    { id: 'SelectOffer', description: 'Record a version-bound choice; grants no payment or order authority', inputs: { request: 'ServiceRequest', offer: 'Offer' }, changes: ['Proposal', 'Proposal.selectedOffer', 'ServiceRequest.selectedProposal'], submissionCriteria: ['same_owner', 'same_request', 'current_request_revision', 'fresh_offer', 'hard_preconditions_pass'] },
  ],
  functions: [
    { id: 'taskOutcomeStatus', version: '1', inputTypes: ['ServiceRequest'], description: 'Read the current request-version assessment, goal coverage and original source receipt references; historical task acceptance never refreshes provider facts or grants authority' },
    ...customsPolicyFunctions,
    ...commerceJourneyFunctions, ...stripePaymentFunctions, ...bookingFunctions, ...registrationFunctions,
    ...catalogAgentFunctions,
    ...rideEstimateFunctions, ...meituanReadFunctions,
    ...commerceFunctions,
    ...catalogReadFunctions,
    ...domainFunctions,
    { id: 'offerFreshness', version: '1', inputTypes: ['Offer'], description: 'Evidence-backed freshness at the server clock; local refresh windows are not provider commitments' },
    { id: 'remainingQuantity', version: '1', inputTypes: ['OrderLine'], description: 'Ordered quantity minus accepted delivery allocations, with unit, specification and event checks' },
    { id: 'actualArrival', version: '1', inputTypes: ['Shipment'], description: 'Actual arrival from accepted delivery events; an ETA is never an arrival' },
    { id: 'reservationStatus', version: '1', inputTypes: ['Reservation'], description: 'Provider confirmation plus required deposit evidence; paid alone is not confirmation' },
    { id: 'deliveryQuoteMatches', version: '1', inputTypes: ['DeliveryQuote'], description: 'Match quote to request, selected route, parcel versions, weight and service' },
    { id: 'withinBudget', version: '1', inputTypes: ['DeliveryQuote', 'ProductOffer', 'ReservationOffer'], description: 'Compare a complete scoped total and price basis; a reservation deposit is not a total' },
    { id: 'reservationMatches', version: '1', inputTypes: ['Reservation'], description: 'Check effective confirmation for the exact venue, time, timezone and party size' },
    { id: 'productOfferMatches', version: '2', inputTypes: ['ProductOffer'], description: 'Check the quoted product specification revision, quantity, capacity, complete total, destination and commitment' },
    { id: 'slotAvailability', version: '1', inputTypes: ['ReservationSlot'], description: 'Check current evidenced slot eligibility for venue, time, timezone and party size' },
  ],
};
export const businessModel = new OntologyModel(BUSINESS_MODEL_DEFINITION);
