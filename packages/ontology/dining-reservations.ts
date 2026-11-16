import { sandboxAgentCapability } from './agent-profiles.js';
import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

const venueName = z.string().trim().min(1).max(160);
const webUrl = z.url({ protocol: /^https$/ }).max(1000);
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const bookingId = z.string().min(1).max(120);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const diningWebSource = 'DiningWebBooking';
export const diningMiniProgramSource = 'PADiningMiniProgram';
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

export const diningWebTerms = diningWebQuery.extend({ time: localTime });
export const diningMiniProgramQuery = diningWebQuery.extend({ branch: venueName });
export const diningMiniProgramTerms = diningMiniProgramQuery.extend({ time: localTime });
export const diningReservationTerms = diningWebTerms.extend({ branch: venueName.optional() });
export const diningBookingReceipt = z.strictObject({
  ...diningReservationTerms.shape, reference: digest, bookingId, observedAt: time,
  verifiedBy: z.enum(['confirmation-page', 'original-order-lookup']), evidence: z.literal('synthetic'),
});
export const diningReservationRef = z.strictObject({ reservation: objectRefSchema });
export const diningReservationData = z.strictObject({
  id: digest, name: venueName, terms: diningReservationTerms,
  environment: z.literal('synthetic'), channel: z.enum(['web', 'miniprogram']), binding: digest,
  state: z.enum(['prepared', 'unknown', 'confirmed']), receipt: diningBookingReceipt.nullable(),
});

export const diningMiniProgramTarget = z.strictObject({
  name: venueName, publisher: venueName, timeZone: venueName,
});
export const diningMiniProgramRead = diningMiniProgramQuery.extend({ miniProgram: diningMiniProgramTarget });
const miniUnavailable = z.enum(['venue-not-connected', 'date-out-of-range', 'login-required', 'page-unavailable', 'unsupported-screen']);
export const diningMiniProgramObservation = z.discriminatedUnion('status', [
  diningMiniProgramRead.extend({
    status: z.literal('observed'), evidence: z.literal('pa_reported'), observedAt: time,
    availableTimes: z.array(localTime).max(96),
  }),
  z.strictObject({ status: z.literal('unavailable'), reason: miniUnavailable }),
]);
const miniObserved = diningMiniProgramObservation.options[0];
const diningMiniProgramAvailability = z.discriminatedUnion('status', [
  miniObserved.extend({ paRequestId: z.uuid() }), diningMiniProgramObservation.options[1],
]);
export const diningMiniProgramTestRequest = z.strictObject({
  environment: z.literal('synthetic'), testId: digest, reference: digest,
  terms: diningMiniProgramTerms,
});
export const diningMiniProgramTestAttempt = z.strictObject({ status: z.enum(['attempted', 'unknown']) });
export const diningMiniProgramTestLookup = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('found'), receipt: diningBookingReceipt }),
  z.strictObject({ status: z.literal('unresolved') }),
]);
export const diningMiniProgramCapabilities = {
  availability: 'dining.miniprogram.availability',
  submitTest: 'dining.miniprogram.test.submit',
  lookupTest: 'dining.miniprogram.test.lookup',
} as const;

const edit = (apiName: string, parameters: z.ZodType, description: string, existing = false) => ({
  apiName, description, parameters: json(parameters),
  objectParameters: existing ? { reservation: diningReservationType } as Record<string, string> : {},
  function: apiName[0]!.toLowerCase() + apiName.slice(1), submissionCriteria: [], typeClasses: [sandboxAgentCapability],
});
const edits = [
  edit('PrepareDiningTestReservation', diningWebTerms, 'Prepare exact terms for an explicitly requested synthetic restaurant web reservation.'),
  edit('PrepareDiningMiniProgramTestReservation', diningMiniProgramTerms, 'Prepare exact terms for a synthetic WeChat mini-program reservation at the matching configured branch.'),
  edit('SubmitDiningTestReservation', diningReservationRef, 'Submit a prepared synthetic reservation through its recorded channel. Look up its original reference if the response is lost.', true),
  edit('RefreshDiningTestReservation', diningReservationRef, 'Look up an already attempted synthetic reservation using its original reference and record a verified receipt.', true),
];

export const diningReservations: Pick<OntologyDocument, 'objectTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: [{
    apiName: diningReservationType, typeClasses: [sandboxAgentCapability], displayName: '餐厅订位', primaryKey: 'id', titleProperty: 'name', interfaces: {},
    description: 'Exact dining reservation terms and merchant-confirmed outcome for the synthetic reservation pilot.',
    properties: Object.fromEntries(Object.entries(diningReservationData.shape).map(([name, schema]) =>
      [name, { description: name, required: true, schema: json(schema) }])),
  }],
  functionTypes: [
    {
      apiName: 'readDiningWebAvailability', source: diningWebSource, parameters: json(diningWebQuery),
      returns: json(diningWebAvailability), dependencies: {},
      description: 'Discover an online booking entry from the configured restaurant’s official homepage and read live openings for the exact local date and party size. Pass the restaurant and city, without a booking URL.',
    },
    {
      apiName: 'readDiningMiniProgramAvailability', source: diningMiniProgramSource, parameters: json(diningMiniProgramQuery),
      returns: json(diningMiniProgramAvailability), dependencies: {},
      description: 'Ask the original PA to read available table times in the configured official WeChat mini program for the exact restaurant branch, local date and number of guests.',
    },
    ...edits.map(action => ({
      apiName: action.function, description: action.description, parameters: action.parameters, returns: json(objectRefSchema),
      ...(action.apiName === 'PrepareDiningMiniProgramTestReservation' ? { source: diningMiniProgramSource } :
        action.apiName === 'PrepareDiningTestReservation' ? { source: diningWebSource } : {}),
      edits: true, typeClasses: [sandboxAgentCapability], dependencies: { objectTypes: [diningReservationType] },
    })),
    {
      apiName: 'readDiningReservation', typeClasses: [sandboxAgentCapability], parameters: json(diningReservationRef), dependencies: { objectTypes: [diningReservationType] },
      returns: json(diningReservationData.omit({ binding: true })),
      description: 'Read this reservation’s recorded state, exact terms and verified merchant receipt.',
    },
  ],
  actionTypes: edits,
};
