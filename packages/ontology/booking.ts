import { z } from 'zod';
import { moneySchema } from './execution.js';
import { paPaymentTermsSchema } from '../core/pa-payment.js';
import { objectRefSchema, type ActionDefinition, type FunctionDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';

const id = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/), instant = z.iso.datetime({ offset: true });
const count = z.number().int().min(1).max(100);
export const bookingInputSchema = z.strictObject({ query: z.string().trim().min(1).max(300), participants: count, startsAt: instant.nullable() });
export const bookingOfferSchema = z.strictObject({
  id, providerId: id, serviceId: id, title: z.string().min(1).max(300), venue: id,
  startsAt: instant, endsAt: instant, timeZone: z.string().min(1).max(100), participants: count,
  total: moneySchema, feesComplete: z.boolean(), cancellationPolicy: z.string().min(1).max(500), termsVersion: id,
  paymentRequirement: z.enum(['not_required', 'required', 'unknown']).optional(),
  availability: z.enum(['available', 'unavailable', 'unknown']), expiresAt: instant,
});
export const bookingDataSchema = z.strictObject({
  bookingId: id, providerId: id, offer: bookingOfferSchema, termsDigest: sha,
  state: z.enum(['awaiting_payment', 'confirmed', 'canceled', 'expired', 'unknown']),
  holdExpiresAt: instant, confirmedAt: instant.optional(), independentRead: z.boolean(),
  paymentHandler: paPaymentTermsSchema.shape.handler,
  checkout: paPaymentTermsSchema.shape.checkout,
});
export const bookingPaymentDataSchema = z.strictObject({
  bookingId: id, providerId: id, payeeId: id, bookingTermsDigest: sha,
  amount: moneySchema, paidAmount: moneySchema, state: z.enum(['not_required', 'unpaid', 'processing', 'paid', 'failed', 'refunded', 'unknown']),
  paymentId: id.optional(), capturedAt: instant.optional(), independentRead: z.literal(true),
});
export const bookingEntitySchemas = {
  BookingOffers: z.strictObject({ query: z.string().min(1).max(300), offers: z.array(bookingOfferSchema).max(20) }),
  BookingObservation: bookingDataSchema,
  BookingPaymentObservation: bookingPaymentDataSchema,
};
export type BookingEntityType = keyof typeof bookingEntitySchemas;
export type BookingData = z.infer<typeof bookingDataSchema>;
export const bookingSourceContextSchema = z.strictObject({ ownerDigest: sha, requestId: z.uuid(), requestRevision: z.number().int().positive(), action: id, planId: id, intentId: id, attemptId: id, modelRunId: id, operationKey: id, readbackSequence: z.number().int().nonnegative() });
export const bookingPayloadSchema = z.strictObject({ type: z.enum(['BookingOffers', 'BookingObservation', 'BookingPaymentObservation']), sourceId: id, sourceVersion: z.number().int().positive(), data: z.record(z.string(), z.unknown()), expiresAt: instant });
export const bookingReceiptSchema = bookingSourceContextSchema.extend({ id: sha, sourceIdentity: id, method: z.enum(['GET', 'POST']), path: z.string().min(1).max(500), status: z.literal(200), responseSha256: sha, payloadDigest: sha, signature: sha, startedAt: instant, receivedAt: instant });
export const bookingSnapshotSchema = z.strictObject({
  payload: bookingPayloadSchema, receipt: bookingReceiptSchema,
  scope: objectRefSchema.extend({ type: z.literal('BookingTask') }), configurationDigest: sha,
  dependencies: z.array(z.strictObject({ ref: objectRefSchema, contentDigest: sha })).max(4),
  evidenceLevel: z.literal('synthetic'), contentDigest: sha,
});
export type BookingSnapshot = z.infer<typeof bookingSnapshotSchema>;
export type BookingSourceResult = { payload: z.infer<typeof bookingPayloadSchema>; receipt: z.infer<typeof bookingReceiptSchema> };
const scope = objectRefSchema.extend({ type: z.literal('BookingTask') });
const booking = objectRefSchema.extend({ type: z.literal('BookingObservation') });
export const bookingActionSchemas = {
  SearchBookingOffers: z.strictObject({ scope, query: z.string().min(1).max(300) }),
  CreatePendingBooking: z.strictObject({ scope, offers: objectRefSchema.extend({ type: z.literal('BookingOffers') }), offerId: id }),
  ReadProviderBooking: z.strictObject({ scope, booking }),
  ReadProviderPayment: z.strictObject({ scope, booking }),
  RequestPAPayment: z.strictObject({ scope, booking, payment: objectRefSchema.extend({ type: z.literal('BookingPaymentObservation') }) }),
  WaitForPAPayment: z.strictObject({ scope, booking, payment: objectRefSchema.extend({ type: z.literal('BookingPaymentObservation') }) }),
};
export type BookingAction = keyof typeof bookingActionSchemas;
export const bookingActionMetadata = {
  SearchBookingOffers: { effect: 'read', type: 'BookingOffers', description: 'Read source service availability and exact terms. Choose a source offer yourself; a listed slot grants no booking or payment authority.' },
  CreatePendingBooking: { effect: 'reserve', type: 'BookingObservation', description: 'Create one unpaid sandbox booking for the evaluated source offer. Requires exact reservation authority with zero payment spend. Never pays or confirms service delivery.' },
  ReadProviderBooking: { effect: 'read', type: 'BookingObservation', description: 'Independently read the original provider booking, fixed terms and confirmation status. Can use an expired observation for identity only.' },
  ReadProviderPayment: { effect: 'read', type: 'BookingPaymentObservation', description: 'Independently read the provider payment linked to the original booking. A PA report is only a notification; it cannot supply these facts.' },
  RequestPAPayment: { effect: 'local', type: 'PAPaymentRequest', description: 'After independently reading both the booking and its unpaid payment state, publish exact terms to the PA and pause. PA uses its own wallet directly with the provider. This local action never issues payment credentials or charges money.' },
  WaitForPAPayment: { effect: 'local', type: 'PAPaymentRequest', description: 'Pause on the same payment request after independently reading unresolved payment or booking status. Preserve the original identity and tell the PA to query, not pay again.' },
} as const;
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Owned task or independently signed sandbox provider; no live payment or booking' });
const common = { id: p('string', id, 'Immutable owned identity'), displayTitle: p('string', id, 'Business label'), requestRevision: p('integer', z.number().int().positive(), 'Fixed request revision') };
export const bookingObjects: ObjectTypeDefinition[] = [
  { id: 'BookingTask', version: '1', name: 'PA 付款预约任务', aliases: ['BookingTask', '预约付款'], description: 'Agent-selected booking with payment authority retained by the PA', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common, input: p('struct', bookingInputSchema, 'Requested service, participant count and optional exact start'), configurationDigest: p('string', sha, 'Configured source identity'), allowedActions: p('array', z.array(id), 'Atomic actions; no EIGOS payment action') } },
  ...Object.entries(bookingEntitySchemas).map(([type, schema]): ObjectTypeDefinition => ({ id: type, version: type === 'BookingObservation' ? '2' : '1', name: type, aliases: [type], description: 'Independent provider observation; payment and booking confirmation are separate facts', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { ...common, data: p('struct', schema, 'Normalized source facts'), snapshot: p('struct', bookingSnapshotSchema, 'Source, task, model and HTTP provenance') } })),
  { id: 'PAPaymentRequest', version: '2', name: '交给 PA 的付款请求', aliases: ['PAPaymentRequest'], description: 'Local immutable payment handoff. Contains no wallet credentials and is never proof of payment.', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common, terms: p('struct', paPaymentTermsSchema, 'Original booking and authorized provider payment route'), configurationDigest: p('string', sha, 'Configured source identity') } },
];
export const bookingLinks: LinkDefinition[] = [
  { id: 'BookingTaskRequest', description: 'Owned booking scope', from: { type: 'BookingTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'bookingTasks', many: true } },
  ...bookingObjects.filter(o => o.id !== 'BookingTask').flatMap(o => [
    { id: `${o.id}Request`, description: 'Owned request revision', from: { type: o.id, name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: `booking${o.id}`, many: true } },
    { id: `${o.id}Scope`, description: 'Configured booking scope', from: { type: o.id, name: 'scope', many: false, required: true }, to: { type: 'BookingTask', name: `observed${o.id}`, many: true } },
    ...(o.id === 'PAPaymentRequest' ? [] : [{ id: `${o.id}Evidence`, description: 'Source seals properties and relationships', from: { type: o.id, name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: `booking${o.id}`, many: true } }]),
  ]),
  { id: 'BookingSelectedOffers', description: 'Exact offers used to create the original booking', from: { type: 'BookingObservation', name: 'offers', many: false }, to: { type: 'BookingOffers', name: 'bookings', many: true } },
  { id: 'BookingOriginalObservation', description: 'Original booking identity for a fresh read', from: { type: 'BookingObservation', name: 'original', many: false }, to: { type: 'BookingObservation', name: 'readbacks', many: true } },
  { id: 'BookingPaymentBooking', description: 'Payment belongs to this original booking', from: { type: 'BookingPaymentObservation', name: 'booking', many: false, required: true }, to: { type: 'BookingObservation', name: 'payments', many: true } },
  { id: 'PAPaymentBooking', description: 'Payment request binds the provider booking', from: { type: 'PAPaymentRequest', name: 'booking', many: false, required: true }, to: { type: 'BookingObservation', name: 'paymentRequests', many: true } },
  { id: 'PAPaymentUnpaidProof', description: 'Independently verified unpaid state before requesting PA payment', from: { type: 'PAPaymentRequest', name: 'unpaidObservation', many: false, required: true }, to: { type: 'BookingPaymentObservation', name: 'paymentRequests', many: true } },
];
export const bookingActions: ActionDefinition[] = Object.entries(bookingActionSchemas).map(([id, schema]) => {
  const m = bookingActionMetadata[id as BookingAction];
  return { id, description: m.description, inputs: { scope: 'BookingTask' }, changes: [m.type], submissionCriteria: ['same_owner', 'current_request_revision', 'exact_source_terms', 'sandbox_only', ...(m.effect === 'reserve' ? ['exact_reservation_authority'] : [])], ...(m.effect === 'read' ? { read: { version: '1', effect: m.effect, inputSchema: z.toJSONSchema(schema), resultType: m.type } } : { operation: { version: '1', effect: m.effect, environment: 'sandbox', inputSchema: z.toJSONSchema(schema), resultType: m.type } }) };
});
export const bookingFunctions: FunctionDefinition[] = [{ id: 'bookingObservationStatus', version: '2', inputTypes: Object.keys(bookingEntitySchemas), description: 'Validate owned source receipts, exact original terms, freshness and independent provider read. PA requests and reports never establish payment or booking completion.' }];
