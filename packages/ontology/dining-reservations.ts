import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

const venueName = z.string().trim().min(1).max(160);
const webUrl = z.url({ protocol: /^https$/ }).max(1000);
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const bookingId = z.string().min(1).max(120);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const diningWebSource = 'DiningWebBooking';
export const diningReservationType = 'DiningReservation';
export const diningWebQuery = z.strictObject({
  restaurant: venueName, city: venueName, date: z.iso.date(), partySize: z.number().int().min(1).max(8),
});
export const diningWebAvailability = z.discriminatedUnion('status', [
  z.strictObject({
    ...diningWebQuery.shape, status: z.literal('observed'), evidence: z.literal('live'),
    officialPage: webUrl, bookingPage: webUrl, timeZone: venueName, observedAt: time,
    availableTimes: z.array(localTime).max(96),
  }),
  z.strictObject({
    status: z.literal('unavailable'), reason: z.enum(['venue-not-connected', 'date-out-of-range', 'page-unavailable']),
  }),
]);

export const diningReservationTerms = diningWebQuery.extend({ time: localTime });
export const diningBookingReceipt = z.strictObject({
  ...diningReservationTerms.shape, reference: digest, bookingId, observedAt: time,
  verifiedBy: z.enum(['confirmation-page', 'original-order-lookup']), evidence: z.literal('synthetic'),
});
export const diningReservationRef = z.strictObject({ reservation: objectRefSchema });
export const diningReservationData = z.strictObject({
  id: digest, name: venueName, terms: diningReservationTerms,
  environment: z.literal('synthetic'), channel: z.literal('web'), binding: digest,
  state: z.enum(['prepared', 'unknown', 'confirmed']), receipt: diningBookingReceipt.nullable(),
});

const edit = (apiName: string, parameters: z.ZodType, description: string, existing = false) => ({
  apiName, description, parameters: json(parameters),
  objectParameters: existing ? { reservation: diningReservationType } as Record<string, string> : {},
  function: apiName[0]!.toLowerCase() + apiName.slice(1), submissionCriteria: [],
});
const edits = [
  edit('PrepareDiningTestReservation', diningReservationTerms, 'Prepare exact terms for an explicitly requested synthetic restaurant reservation.'),
  edit('SubmitDiningTestReservation', diningReservationRef, 'Submit a prepared synthetic reservation at the configured loopback merchant. Look up its original reference if the response is lost.', true),
  edit('RefreshDiningTestReservation', diningReservationRef, 'Look up an already attempted synthetic reservation using its original reference and record a verified receipt.', true),
];

export const diningReservations: Pick<OntologyDocument, 'objectTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: [{
    apiName: diningReservationType, displayName: '餐厅订位', primaryKey: 'id', titleProperty: 'name', interfaces: {},
    description: 'Exact dining reservation terms and merchant-confirmed outcome for the synthetic web pilot.',
    properties: Object.fromEntries(Object.entries(diningReservationData.shape).map(([name, schema]) =>
      [name, { description: name, required: true, schema: json(schema) }])),
  }],
  functionTypes: [
    {
      apiName: 'readDiningWebAvailability', source: diningWebSource, parameters: json(diningWebQuery),
      returns: json(diningWebAvailability), dependencies: {},
      description: 'Discover an online booking entry from the configured restaurant’s official homepage and read live openings for the exact local date and party size. Pass the restaurant and city, without a booking URL.',
    },
    ...edits.map(action => ({
      apiName: action.function, description: action.description, parameters: action.parameters, returns: json(objectRefSchema),
      source: diningWebSource, edits: true, dependencies: { objectTypes: [diningReservationType] },
    })),
    {
      apiName: 'readDiningReservation', parameters: json(diningReservationRef), dependencies: { objectTypes: [diningReservationType] },
      returns: json(diningReservationData.omit({ binding: true })),
      description: 'Read this reservation’s recorded state, exact terms and verified merchant receipt.',
    },
  ],
  actionTypes: edits,
};
