import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const fliggyFlightBookingType = 'FliggyFlightBooking';
export const fliggyFlightTradeSource = 'FliggyFlightJinghang';
const code = z.string().regex(/^[A-Z]{3}$/);
const item = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const money = z.number().int().nonnegative().safe();
export const partnerFlightSearch = z.strictObject({
  origin: code, destination: code, departureDate: z.iso.date(),
});
const segment = z.strictObject({
  dep_airport: code, arr_airport: code, marketing_flight_no: z.string().min(2).max(12),
  dep_time: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
  arr_time: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
});
export const partnerFlightQuote = z.strictObject({
  itemId: item, segment, cabin: z.string().min(1).max(8),
  fareYuan: money, fuelYuan: money, constructionYuan: money, taxYuan: money, amountMinor: money,
  refundTerms: z.string().min(1).max(12000), currency: z.literal('CNY'),
});
export const prepareFlightBookingInput = z.strictObject({
  search: partnerFlightSearch, itemId: item, bookingKey: z.uuid(),
  profileId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
});
export const flightBookingRef = z.strictObject({ booking: objectRefSchema });
export const approveFlightBookingInput = flightBookingRef.extend({
  approvedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  amountMinor: money,
});
const facts = {
  id: z.string(), name: z.string(), search: partnerFlightSearch, quote: partnerFlightQuote,
  profileId: prepareFlightBookingInput.shape.profileId, approvalDigest: z.string(), outOrderNo: z.string(),
  merchantOrderId: z.string().nullable(), supplierStatus: z.string().nullable(), paid: z.boolean(),
  issued: z.boolean(), closed: z.boolean(), expiresAt: time, observedAt: time,
  evidence: z.enum(['synthetic', 'provider']), independentRead: z.boolean(),
};
export const fliggyFlightPublic = z.object(facts);
export const flightIssuanceState = z.enum(['unpaid', 'payment_unverified', 'awaiting_issuance', 'issued', 'closed']);
const observationStatus = z.enum(['watching', 'finished', 'source_unavailable', 'timed_out']);
const storedFacts = { ...facts, authority: z.string(), profileDigest: z.string() };
export const fliggyFlightBooking = z.object(storedFacts).extend({
  issuanceState: flightIssuanceState.optional(), issuanceObservation: observationStatus.optional(),
});
const actions = [
  ['PrepareFliggyFlightBooking', 'prepareFliggyFlightBooking', prepareFlightBookingInput,
    'Verify a dated adult domestic nonstop Jinghang offer and prepare exact review terms.'],
  ['CreateFliggyFlightBooking', 'createFliggyFlightBooking', approveFlightBookingInput,
    'Create one original Jinghang order with explicit PA approval of the itinerary and amount.'],
  ['PayFliggyFlightBooking', 'payFliggyFlightBooking', approveFlightBookingInput,
    'Pay the original reviewed Jinghang order from the configured partner payment account.'],
  ['CloseFliggyFlightBooking', 'closeFliggyFlightBooking', approveFlightBookingInput,
    'Close a reviewed unpaid Jinghang order after explicit PA approval.'],
  ['RefreshFliggyFlightBooking', 'refreshFliggyFlightBooking', flightBookingRef,
    'Read or reconcile the original Jinghang order and confirm payment and ticket issuance independently.'],
] as const;
export const fliggyFlightBookingDefinition: Pick<OntologyDocument, 'objectTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: [{
    apiName: fliggyFlightBookingType, displayName: 'Fliggy domestic flight booking',
    description: 'An approved Jinghang fare with independently read order, payment and issuance evidence.',
    primaryKey: 'id', titleProperty: 'name', interfaces: {},
    properties: {
      ...Object.fromEntries(Object.entries(storedFacts).map(([name, schema]) =>
        [name, { description: name, required: true, schema: json(schema) }])),
      issuanceState: { description: 'Issuance progress of the original Jinghang order based on verified payment and ticket evidence',
        required: false, schema: json(flightIssuanceState) },
      issuanceObservation: { description: 'Status of bounded, read-only checks following the original payment dispatch',
        required: false, schema: json(observationStatus) },
    },
  }],
  functionTypes: [
    ...actions.map(([, apiName, input, description]) => ({
      apiName, description, parameters: json(input), returns: json(objectRefSchema), edits: true,
      source: fliggyFlightTradeSource, dependencies: { objectTypes: [fliggyFlightBookingType] },
    })),
    { apiName: 'readFliggyFlightQuotes', description: 'Read domestic nonstop adult fares from Jinghang with supplier item identity and displayed conditions.',
      parameters: json(partnerFlightSearch), returns: json(z.object({ quotes: z.array(partnerFlightQuote).max(20), complete: z.literal(false) })),
      source: fliggyFlightTradeSource, dependencies: {} },
    { apiName: 'readFliggyFlightBooking', description: 'Read the original flight booking evidence without exposing passenger information.',
      parameters: json(flightBookingRef), returns: json(fliggyFlightPublic),
      source: fliggyFlightTradeSource, dependencies: { objectTypes: [fliggyFlightBookingType] } },
  ],
  actionTypes: actions.map(([apiName, fn, input, description]) => ({
    apiName, description, parameters: json(input), function: fn,
    objectParameters: ('booking' in input.shape ? { booking: fliggyFlightBookingType } : {}) as Record<string, string>,
    submissionCriteria: [],
  })),
};
