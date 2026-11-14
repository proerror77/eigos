import { z } from 'zod';
import { mapRouteResult, weatherResult } from './maps.js';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

const label = z.string().trim().min(1).max(250);
const identity = z.string().trim().min(1).max(1024);
export const journeyType = 'CalendarJourney';
export const journeyCalendarCapability = 'calendar.journey.read';
export const calendarEventKey = z.strictObject({ calendarId: identity, eventId: identity });
const eventVersion = calendarEventKey.extend({ revision: identity });
const activeEvent = eventVersion.extend({
  status: z.literal('confirmed'), name: label, start: time, end: time,
  location: label.nullable(),
});
const calendarEvent = z.discriminatedUnion('status', [
  activeEvent,
  calendarEventKey.extend({ status: z.literal('canceled'), revision: identity.optional() }),
]);
export const journeyCalendarRequest = z.strictObject({
  origin: calendarEventKey, destination: calendarEventKey,
});
export const journeyCalendarReply = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'), observedAt: time, evidence: z.enum(['pa_reported', 'synthetic']),
    origin: calendarEvent, destination: calendarEvent,
  }),
  z.strictObject({ status: z.literal('denied') }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export const journeySettings = journeyCalendarRequest.extend({
  monitorUntil: time, mode: z.enum(['driving', 'walking']),
  preparationMinutes: z.number().int().min(0).max(60).default(5),
  entryMinutes: z.number().int().min(0).max(90).default(10),
  rainBufferMinutes: z.number().int().min(0).max(30).default(5),
});
export const journeyInput = z.strictObject({ journey: objectRefSchema });

const reminderState = z.enum(['scheduled', 'due', 'risk']);
const reminderCause = z.enum(['initial', 'calendar_changed', 'route_estimate_changed', 'weather_buffer_changed', 'status_changed']);
const state = z.enum(['pending', 'scheduled', 'due', 'risk', 'unavailable', 'canceled', 'ended']);
const reason = z.enum([
  'pending', 'route_checked', 'calendar_conflict', 'departure_due', 'late_arrival',
  'calendar_unavailable', 'calendar_denied', 'check_failed', 'location_unavailable', 'route_unavailable',
  'calendar_canceled', 'monitor_canceled', 'event_started', 'outside_monitor_window', 'source_changed',
]);
export const journeyReminder = z.strictObject({
  version: z.number().int().positive(), prepareAt: time, state: reminderState,
  cause: reminderCause, eventKey: z.string(),
});
export const journeyTiming = z.strictObject({
  prepareAt: time, departAt: time, arriveBy: time, weatherBufferMinutes: z.number().int().nonnegative(),
  durationSeconds: z.number().int().nonnegative(),
});
const properties = z.strictObject({
  id: z.string(), name: label, settings: journeySettings, scheduleId: z.string(),
  mapAuthority: z.string().regex(/^[a-f0-9]{64}$/), state, reason,
  checkedAt: time.nullable(), validUntil: time.nullable(), nextCheckAt: time.nullable(),
  calendar: journeyCalendarReply.nullable(), route: mapRouteResult.nullable(), weather: weatherResult.nullable(),
  timing: journeyTiming.nullable(), reminder: journeyReminder.nullable(), reminderVersion: z.number().int().nonnegative(),
});
export const calendarJourney = properties;
export const journeyReadResult = z.strictObject({
  journey: objectRefSchema, revision: z.number().int().positive(),
  state: state.or(z.literal('expired')), reason, checkedAt: time.nullable(),
  nextCheckAt: time.nullable(), validUntil: time.nullable(), timing: journeyTiming.nullable(),
  reminder: journeyReminder.omit({ eventKey: true }).nullable(), reminderVersion: z.number().int().nonnegative(),
  calendarEvidence: z.enum(['pa_reported', 'synthetic']).nullable(),
  routeFetchedAt: time.nullable(), weatherCondition: label.nullable(),
  destination: z.strictObject({ name: label, start: time }).nullable(),
});

const actions = [
  { action: 'StartCalendarJourney', fn: 'startCalendarJourney', schema: journeySettings, existing: false,
    description: 'Explicitly authorize read-only monitoring of two selected events until monitorUntil. Does not edit the calendar or place orders.' },
  { action: 'CheckCalendarJourney', fn: 'checkCalendarJourney', schema: journeyInput, existing: true,
    description: 'A scheduled Worker check reads the original PA calendar events, refreshes route and weather, and commits a replacement travel reminder.' },
  { action: 'CancelCalendarJourney', fn: 'cancelCalendarJourney', schema: journeyInput, existing: true,
    description: 'Stop monitoring and withdraw the current travel reminder.' },
] as const;

export const calendarJourneyDefinition: Pick<OntologyDocument, 'objectTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: [{
    apiName: journeyType, displayName: 'Calendar journey',
    description: 'One trip between selected calendar events, with authorized observations and a versioned departure reminder.',
    primaryKey: 'id', titleProperty: 'name', interfaces: {},
    properties: Object.fromEntries(Object.entries(properties.shape)
      .map(([name, schema]) => [name, { description: name, required: true, schema: json(schema) }])),
  }],
  functionTypes: [
    ...actions.map(({ fn, schema, description }) => ({
      apiName: fn, description, parameters: json(schema), returns: json(objectRefSchema), edits: true,
      ...(fn === 'checkCalendarJourney' ? { source: 'PACalendar' } : {}),
      dependencies: { objectTypes: [journeyType],
        ...(fn === 'checkCalendarJourney' ? { functions: ['estimateMapRoute', 'readWeather'] } : {}) },
    })),
    { apiName: 'readCalendarJourney', description: 'Read the current trip timing and reminder version. Expired, canceled and superseded reminders are withdrawn.',
      source: 'PACalendar', parameters: json(journeyInput), returns: json(journeyReadResult),
      dependencies: { objectTypes: [journeyType] } },
  ],
  actionTypes: actions.map(({ action, fn, schema, existing, description }) => {
    const objectParameters: Record<string, string> = existing ? { journey: journeyType } : {};
    return { apiName: action, description, parameters: json(schema), objectParameters, function: fn, submissionCriteria: [] };
  }),
};
