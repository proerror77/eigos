import { z } from 'zod';
import { objectRefSchema as ref, type OntologyDocument } from './schema.js';
import { json, time, shortText, evidence } from './service-contracts.js';

export const driveInput = z.strictObject({ origin: ref, destination: ref });
export const tripInput = z.strictObject({
  plan: ref,
  event: ref,
  travel: ref,
  sourceTaskId: z.uuid().optional(),
  waitMinutes: z.number().int().min(0).max(120).default(10),
  entryMinutes: z.number().int().min(0).max(120).default(10),
});
export const tripRef = z.strictObject({ trip: ref });
export const permitSchema = z.strictObject({
  category: shortText,
  maxEstimateMinor: z.string().regex(/^(0|[1-9]\d{0,11})$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  earliestCall: time,
  latestCall: time,
  acceptVariableFinalFare: z.literal(true),
  venueConfirmed: z.literal(true),
  registration: ref,
});
export const authorizeTripInput = tripRef.extend({ revision: z.number().int().positive(), permit: permitSchema });
export const registrationInput = z.strictObject({ event: ref, ticketId: shortText, sourceTaskId: z.uuid().optional() });
export const registrationRef = z.strictObject({ registration: ref });
export const registrationAuthorization = registrationRef.extend({
  revision: z.number().int().positive(),
  expiresAt: time,
});
export const registrationReply = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.enum(['confirmed', 'pending_approval', 'waitlisted', 'rejected']),
    eventId: shortText,
    ticketId: shortText,
    registrationId: shortText,
    participantRef: shortText,
    accountRef: shortText,
    amountMinor: z.literal('0'),
    independentRead: z.literal(true),
    observedAt: time,
    proofDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ status: z.enum(['unsupported', 'unavailable', 'denied', 'unknown']), reason: shortText }),
]);
const props = (shape: Record<string, z.ZodType>) =>
  Object.fromEntries(
    Object.entries(shape).map(([name, schema]) => [
      name,
      { description: name, schema: json(schema), required: !schema.isOptional() },
    ]),
  );
const base = { id: z.string(), name: z.string() };
const object = (apiName: string, shape: Record<string, z.ZodType>, description: string) => ({
  apiName,
  displayName: apiName,
  description,
  primaryKey: 'id',
  titleProperty: 'name',
  properties: props({ ...base, ...shape }),
  interfaces: {},
});
const link = (apiName: string, from: string, name: string, to: string, reverse: string, many = false) => ({
  apiName,
  description: apiName,
  from: { type: from, name, cardinality: many ? ('many' as const) : ('one' as const) },
  to: { type: to, name: reverse, cardinality: 'many' as const },
});
const functions = [
  ['observeDidiDrivingTime', driveInput, 'Read current DiDi driving duration for provider-resolved endpoints.', 'Didi'],
  ['planEventTrip', tripInput, 'Reserve travel and attendance time in a scenario using a fresh driving observation.'],
  [
    'authorizeEventTrip',
    authorizeTripInput,
    'The PA explicitly authorizes one trip, bounded timing, selected category and maximum estimated fare. Final fare is variable.',
  ],
  [
    'executeEventTrip',
    tripRef,
    'Refresh event, route and PA availability; replan within the permit; dispatch at the calculated time.',
    'Didi',
  ],
  [
    'cancelEventTrip',
    tripRef,
    'Stop pending scheduled execution. Does not cancel an already dispatched provider order.',
  ],
  [
    'prepareEventRegistration',
    registrationInput,
    'Prepare an exact zero-charge participant ticket registration for PA authorization.',
  ],
  [
    'authorizeEventRegistration',
    registrationAuthorization,
    'Authorize this exact participant registration, never an organizer guest-list edit.',
  ],
  [
    'executeEventRegistration',
    registrationRef,
    'Ask the original PA to execute or read back the authorized participant registration.',
  ],
  [
    'refreshEventRegistration',
    registrationRef,
    'Read the original participant registration again, including pending approval or waitlist transitions. Never submit another registration.',
    'Luma',
  ],
  [
    'refreshDidiRideOrder',
    tripRef,
    'Independently read the original provider order; no unscoped account-order query.',
    'Didi',
  ],
] as const;
export const travelDefinition: OntologyDocument = {
  id: 'EigosTravel',
  version: '1',
  objectTypes: [
    object(
      'DidiDrivingEstimate',
      {
        durationSeconds: z.number().int().positive(),
        distanceMeters: z.number().int().nonnegative(),
        bindingId: z.string(),
        authorityId: z.string(),
        observedAt: time,
        expiresAt: time,
        evidence,
        receiptDigest: z.string(),
      },
      'A current route duration; an estimate, not an arrival guarantee.',
    ),
    object(
      'EventTrip',
      {
        eventStart: time,
        eventEnd: time,
        callAt: time,
        departAt: time,
        arriveAt: time,
        waitMinutes: z.number(),
        entryMinutes: z.number(),
        state: z.enum(['proposed', 'authorized', 'dispatched', 'canceled']),
        permit: permitSchema.nullable(),
        scheduleId: z.string().nullable(),
        sourceTaskId: z.string().nullable(),
        eventIdentity: z.string(),
        eventBindingId: z.string(),
        sourceAuthority: z.string(),
        venueAddress: z.string(),
        nextCheckAt: time.nullable(),
      },
      'A plan linking an event, calendar allocation, travel estimate and authorized timed ride.',
    ),
    object(
      'EventRegistration',
      {
        ticketId: z.string(),
        eventId: z.string(),
        state: z.enum(['proposed', 'authorized', 'confirmed', 'pending_approval', 'waitlisted', 'rejected', 'unknown']),
        expiresAt: time.nullable(),
        scheduleId: z.string().nullable(),
        sourceTaskId: z.string().nullable(),
        registrationId: z.string().nullable(),
        participantRef: z.string().nullable(),
        evidence: z.enum(['none', 'pa_reported']),
        observedAt: time.nullable(),
        proofDigest: z.string().nullable(),
        independentRead: z.boolean(),
      },
      'Participant registration. A proposed operation or PA-reported result is distinct from a direct provider receipt.',
    ),
    object(
      'DidiRideOrder',
      {
        orderId: z.string(),
        status: z.string(),
        state: z.enum(['created', 'reported', 'unknown']),
        independentRead: z.boolean(),
        evidence: z.enum(['live', 'provider_mock', 'synthetic']),
        observedAt: time,
        contentDigest: z.string(),
        bindingId: z.string(),
      },
      'The exact original ride order and latest independent status report. Creation does not mean arrival or completion.',
    ),
  ],
  interfaceTypes: [
    {
      apiName: 'AttendableEvent',
      description: 'An event that can be selected for participant registration and travel planning.',
      properties: props({
        name: z.string(),
        start: time,
        end: time,
        timeZone: z.string(),
        status: z.enum(['active', 'canceled', 'unknown']),
        locationPrecision: z.enum(['exact', 'coarse', 'online', 'unknown']),
        registrationOpen: z.boolean(),
        approvalRequired: z.boolean(),
      }),
      optionalProperties: [],
      links: {
        registrations: { target: 'EventRegistration', cardinality: 'many', required: true },
        trips: { target: 'EventTrip', cardinality: 'many', required: true },
      },
      actions: {
        register: {
          parameters: json(registrationInput),
          objectParameters: { event: 'AttendableEvent' },
          required: true,
        },
      },
    },
    {
      apiName: 'DrivingEstimate',
      description: 'Provider-neutral road travel duration and endpoints; choose a concrete routing implementation.',
      properties: props({
        name: z.string(),
        durationSeconds: z.number().int(),
        distanceMeters: z.number().int(),
        observedAt: time,
        expiresAt: time,
        evidence,
      }),
      optionalProperties: [],
      links: {
        origin: { target: 'Location', cardinality: 'one', required: true },
        destination: { target: 'Location', cardinality: 'one', required: true },
      },
      actions: {
        observe: {
          parameters: json(driveInput),
          objectParameters: { origin: 'Location', destination: 'Location' },
          required: true,
        },
      },
    },
    {
      apiName: 'RideOrder',
      description: 'Original ride order identity and observed status, independent of supplier.',
      properties: props({
        name: z.string(),
        orderId: z.string(),
        status: z.string(),
        state: z.string(),
        observedAt: time,
        independentRead: z.boolean(),
        evidence: z.enum(['live', 'provider_mock', 'synthetic']),
      }),
      optionalProperties: [],
      links: {},
      actions: {},
    },
  ],
  linkTypes: [
    link('DrivingOrigin', 'DidiDrivingEstimate', 'origin', 'Place', 'drivingOrigins'),
    link('DrivingDestination', 'DidiDrivingEstimate', 'destination', 'Place', 'drivingDestinations'),
    link('TripEvent', 'EventTrip', 'event', 'LumaEvent', 'trips'),
    link('TripPlan', 'EventTrip', 'plan', 'SchedulePlan', 'trips'),
    link('TripTravel', 'EventTrip', 'travel', 'DidiDrivingEstimate', 'trips'),
    link('TripActivities', 'EventTrip', 'activities', 'ScheduledActivity', 'trip', true),
    link('RegistrationEvent', 'EventRegistration', 'event', 'LumaEvent', 'registrations'),
    link('TripRegistration', 'EventTrip', 'registration', 'EventRegistration', 'trips'),
    link('TripOrder', 'EventTrip', 'order', 'DidiRideOrder', 'trips'),
  ],
  functionTypes: [
    ...functions.map(([apiName, input, description, source]) => ({
      apiName,
      description,
      parameters: json(input),
      returns: json(ref),
      edits: true,
      ...(source ? { source } : {}),
    })),
    {
      apiName: 'readDrivingEstimate',
      description: 'Read the current routing observation and exact endpoints from its implementation.',
      parameters: json(z.strictObject({ travel: ref })),
      returns: json(z.record(z.string(), z.unknown())),
    },
    {
      apiName: 'readEventTrip',
      description: 'Read the trip and correlated scheduled task without confusing a submitted plan with fulfillment.',
      parameters: json(tripRef),
      returns: json(z.record(z.string(), z.unknown())),
    },
    {
      apiName: 'readEventRegistration',
      description: 'Read the participant registration and its original execution task.',
      parameters: json(registrationRef),
      returns: json(z.record(z.string(), z.unknown())),
    },
  ],
  actionTypes: functions.map(([name, input, description]) => {
    const objectParameters: Record<string, string> =
      name === 'observeDidiDrivingTime'
        ? { origin: 'Place', destination: 'Place' }
        : name === 'planEventTrip'
          ? { plan: 'SchedulePlan', event: 'AttendableEvent', travel: 'DrivingEstimate' }
          : name === 'prepareEventRegistration'
            ? { event: 'AttendableEvent' }
            : name.includes('Registration')
              ? { registration: 'EventRegistration' }
              : { trip: 'EventTrip' };
    return {
      apiName: name[0]!.toUpperCase() + name.slice(1),
      description,
      parameters: json(input),
      objectParameters,
      submissionCriteria: [],
      function: name,
    };
  }),
  dataSources: [],
};
travelDefinition.objectTypes.find((type) => type.apiName === 'DidiDrivingEstimate')!.interfaces.DrivingEstimate = {
  properties: Object.fromEntries(
    ['name', 'durationSeconds', 'distanceMeters', 'observedAt', 'expiresAt', 'evidence'].map((n) => [n, n]),
  ),
  links: { origin: 'origin', destination: 'destination' },
  actions: {
    observe: { action: 'ObserveDidiDrivingTime', parameters: { origin: 'origin', destination: 'destination' } },
  },
};
travelDefinition.objectTypes.find((type) => type.apiName === 'DidiRideOrder')!.interfaces.RideOrder = {
  properties: Object.fromEntries(
    ['name', 'orderId', 'status', 'state', 'observedAt', 'independentRead', 'evidence'].map((n) => [n, n]),
  ),
  links: {},
  actions: {},
};
