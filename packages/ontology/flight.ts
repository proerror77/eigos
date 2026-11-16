import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

const iata = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const fnum = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$/);
export const flightNumberKey = (number: string) => number.replace(/^([A-Z0-9]{2})0+(?=[0-9])/, '$1');
const label = z.string().trim().min(1).max(160);
const nullableTime = time.nullable();
export const flightSource = 'VariFlight';
export const flightPositionSource = 'Flightradar24';
export const flightWatchSources = [flightSource, flightPositionSource] as const;
export const flightWatchType = 'FlightWatch';
export const searchFlight = z.strictObject({ flightNumber: fnum, departureDate: z.iso.date(),
  origin: iata.optional(), destination: iata.optional() });
const flightLeg = searchFlight.extend({ origin: iata, destination: iata });
const flightState = z.enum(['scheduled', 'delayed', 'cancelled', 'airborne', 'arrived', 'diverted', 'returned', 'unknown']);
export const flightStatus = flightLeg.extend({
  carrier: label.nullable(), codeshareFlightNumber: fnum.nullable(), status: flightState,
  providerStatus: label.nullable(), originName: label.nullable(), destinationName: label.nullable(),
  departureTerminal: label.nullable(), arrivalTerminal: label.nullable(), gate: label.nullable(),
  scheduledDeparture: time, estimatedDeparture: nullableTime, actualDeparture: nullableTime,
  scheduledArrival: nullableTime, estimatedArrival: nullableTime, actualArrival: nullableTime,
});
export const flightStatusRead = z.strictObject({
  provider: z.literal(flightSource), observedAt: time, flights: z.array(flightStatus).max(32),
});
const changed = z.enum(['status', 'departure_time', 'arrival_time', 'gate', 'departure_terminal']);
export const flightAlert = z.strictObject({
  version: z.number().int().positive(), createdAt: time, changes: z.array(changed).min(1), flight: flightStatus,
});
export const flightWatchSettings = flightLeg.extend({
  monitorUntil: time, maxChecks: z.number().int().min(2).max(24).default(8),
  sources: z.array(z.enum(flightWatchSources)).min(1).max(2)
    .describe('Omit to use VariFlight, or select one or both providers. Each check can use credits at each selected provider.').optional(),
});
export const flightWatchInput = z.strictObject({ watch: objectRefSchema });
const watchState = z.enum(['pending', 'monitoring', 'unavailable', 'cancelled', 'completed', 'ended']);
const watchReason = z.enum(['waiting', 'checked', 'no_match', 'source_unavailable', 'source_changed', 'check_failed', 'flight_finished', 'check_limit', 'deadline', 'user_cancelled']);
const nullableLabel = label.nullable();
const authorityId = z.string().regex(/^[a-f0-9]{64}$/);
const liveTracking = z.strictObject({
  provider: z.literal(flightPositionSource),
  state: z.enum(['pending', 'tracked', 'no_match', 'ambiguous', 'source_unavailable', 'source_changed']),
  checkedAt: nullableTime,
}).describe('Latest live match by flight number and airport pair. Scheduled departure dates and operational status come from VariFlight.');
export const flightWatch = z.strictObject({
  id: z.string(), name: label, settings: flightWatchSettings, scheduleId: z.string(),
  sourceAuthority: authorityId.nullable(), checks: z.number().int().nonnegative(),
  state: watchState, reason: watchReason, checkedAt: nullableTime, nextCheckAt: nullableTime,
  status: flightStatus.nullable(), observedAt: nullableTime,
  knownGate: nullableLabel, knownTerminal: nullableLabel, alert: flightAlert.nullable(),
  alertVersion: z.number().int().nonnegative(),
  liveTracking: liveTracking.extend({ authorityId }).nullable().optional(),
});
export const flightWatchRead = flightWatch.pick({
  state: true, reason: true, checks: true, nextCheckAt: true, checkedAt: true,
  status: true, observedAt: true, alert: true, alertVersion: true,
}).extend({
  watch: objectRefSchema, revision: z.number().int().positive(), monitorUntil: time,
  sources: flightWatchSettings.shape.sources, liveTracking: liveTracking.optional(),
});

const actions = [
  { name: 'StartFlightWatch', fn: 'startFlightWatch', input: flightWatchSettings, existing: false,
    description: 'Start bounded updates for one flight and airport pair. Select VariFlight for operational status, Flightradar24 for live aircraft tracking, or both.' },
  // Preserve the existing scheduled contract for VariFlight-only watches.
  { name: 'CheckFlightWatch', fn: 'checkFlightWatch', input: flightWatchInput, existing: true,
    description: 'Refresh authorized flight observations through the existing scheduled Worker and record meaningful changes.' },
  { name: 'RefreshFlightWatch', fn: 'refreshFlightWatch', input: flightWatchInput, existing: true,
    description: 'Refresh the selected VariFlight and Flightradar24 observations through the original scheduled watch.' },
  { name: 'CancelFlightWatch', fn: 'cancelFlightWatch', input: flightWatchInput, existing: true,
    description: 'Stop future supplier checks and withdraw any outstanding flight alert.' },
] as const;

export const flightDefinition: Pick<OntologyDocument, 'objectTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: [{
    apiName: flightWatchType, displayName: 'Flight watch', primaryKey: 'id', titleProperty: 'name', interfaces: {},
    description: 'A user-authorized bounded watch on a selected flight leg with supplier-backed state and versioned changes.',
    properties: Object.fromEntries(Object.entries(flightWatch.shape)
      .map(([name, schema]) => [name, { description: name, required: name !== 'liveTracking', schema: json(schema) }])),
  }],
  functionTypes: [
    { apiName: 'readFlightStatus', description: 'Read VariFlight operational status for a flight number on a departure-local date. Filter by the IATA airport codes to disambiguate. Each query uses provider credits.',
      parameters: json(searchFlight), returns: json(flightStatusRead), source: flightSource, dependencies: {} },
    ...actions.map(({ fn, input, description }) => ({
      apiName: fn, parameters: json(input), returns: json(objectRefSchema), description, edits: true,
      ...(fn === 'checkFlightWatch' ? { source: flightSource } : {}),
      dependencies: {
        objectTypes: [flightWatchType],
        ...(fn === 'checkFlightWatch' ? { functions: ['readFlightStatus'] } : {}),
        ...(fn === 'refreshFlightWatch' || fn === 'startFlightWatch' ? { functions: ['readFlightStatus', 'readLiveFlightPosition'] } : {}),
      },
    })),
    { apiName: 'readFlightWatch', description: 'Read authorized flight status, the latest live-tracking check and the versioned alert for a flight watch.',
      parameters: json(flightWatchInput), returns: json(flightWatchRead), dependencies: { objectTypes: [flightWatchType] } },
  ],
  actionTypes: actions.map(({ name, fn, input, existing, description }) => {
    const objectParameters: Record<string, string> = existing ? { watch: flightWatchType } : {};
    return { apiName: name, function: fn, parameters: json(input), description, objectParameters, submissionCriteria: [] };
  }),
};
