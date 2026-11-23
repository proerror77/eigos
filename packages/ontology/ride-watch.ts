import { z } from 'zod';
import { objectRefSchema as ref, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const rideWatchType = 'DidiRideWatch';
export const rideWatchState = z.enum([
  'watching', 'matching', 'driver_assigned', 'driver_arrived', 'in_trip', 'completed',
  'provider_terminal', 'unavailable', 'stopped', 'expired',
]);
export const rideWatchClosed = new Set<z.infer<typeof rideWatchState>>([
  'completed', 'provider_terminal', 'unavailable', 'stopped', 'expired',
]);
const label = z.string().min(1).max(120);
export const rideDriver = z.strictObject({
  name: label.nullable(), carModel: label.nullable(), carPlate: label.nullable(),
});
export const rideProgress = z.strictObject({
  orderId: z.string().min(1).max(500),
  statusCode: z.number().int().min(0).max(9999),
  observedAt: time,
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  driver: rideDriver.nullable(),
  distanceKm: z.number().nonnegative().nullable(),
  etaMinutes: z.number().nonnegative().nullable(),
});
export const ridePosition = z.strictObject({
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  coordinateSystem: z.literal('provider_unspecified'),
  observedAt: time,
});
export const rideArrival = z.strictObject({ version: z.number().int().positive(), observedAt: time, validUntil: time });
export const rideWatchStart = z.strictObject({
  order: ref, expiresAt: time, notifyArrival: z.boolean().default(false),
});
export const rideWatchRef = z.strictObject({ watch: ref });
const observation = z.strictObject({
  state: rideWatchState,
  statusCode: rideProgress.shape.statusCode.nullable(),
  observedAt: time.nullable(),
  contentDigest: rideProgress.shape.contentDigest.nullable(),
  driver: rideDriver.nullable(),
  distanceKm: rideProgress.shape.distanceKm,
  etaMinutes: rideProgress.shape.etaMinutes,
  reason: z.enum(['awaiting_provider', 'provider_status', 'provider_terminal', 'source_retry',
    'source_unavailable', 'stopped', 'expired']),
  expiresAt: time,
  nextCheckAt: time.nullable(),
  arrivalAt: time.nullable(),
  arrivalVersion: z.number().int().nonnegative(),
  arrival: rideArrival.nullable(),
});
export const rideWatchFields = observation.extend({
  id: z.string(), name: z.string(),
  scheduleId: z.string().min(1), sourceAuthority: z.string().min(1),
  notifyArrival: z.boolean(), failures: z.number().int().min(0).max(3),
  followup: z.strictObject({ taskId: z.uuid(), requestId: z.uuid(), expiresAt: time }).optional(),
});
export const rideWatchRead = observation.extend({
  watch: ref, order: ref, revision: z.number().int().positive(),
  settlement: z.literal('unverified'),
});
const functions = [
  ['startDidiRideWatch', rideWatchStart, 'Authorize bounded read-only tracking of an existing linked DiDi order. Optionally enable arrival notice delivery.', true, ref, 'Didi'],
  ['checkDidiRideWatch', rideWatchRef, 'Scheduled read of the original DiDi order. Update the process and schedule the next authorized check.', true, ref, 'Didi'],
  ['stopDidiRideWatch', rideWatchRef, 'Stop checking this order and withdraw a pending arrival notice. Does not cancel the ride.', true, ref],
  ['readDidiRideWatch', rideWatchRef, 'Read provider-backed pickup progress, ETA and the current arrival notice.', false, rideWatchRead],
  ['readDidiDriverPosition', rideWatchRef, 'Fetch the current driver coordinates for the verified active order when requested.', false, ridePosition, 'Didi'],
] as const;

export const rideWatchDefinition: OntologyDocument = {
  id: 'EigosRideWatch', version: '1', interfaceTypes: [], dataSources: [],
  objectTypes: [{
    apiName: rideWatchType, displayName: 'DiDi ride tracking',
    description: 'Bounded, read-only observations of an original DiDi order.',
    primaryKey: 'id', titleProperty: 'name', interfaces: {},
    properties: Object.fromEntries(Object.entries(rideWatchFields.shape).map(([name, schema]) =>
      [name, { description: name, required: !schema.isOptional(), schema: json(schema) }])),
  }],
  linkTypes: [{
    apiName: 'RideWatchOrder', description: 'The original verified provider order for this tracking process.',
    from: { type: rideWatchType, name: 'order', cardinality: 'one' },
    to: { type: 'DidiRideOrder', name: 'watches', cardinality: 'many' },
  }],
  functionTypes: functions.map(([apiName, input, description, edits, output, source]) => ({
    apiName, description, parameters: json(input), returns: json(output), ...(edits ? { edits: true } : {}),
    ...(source ? { source } : {}),
    dependencies: { objectTypes: [rideWatchType, 'DidiRideOrder', 'EventTrip'], linkTypes: ['RideWatchOrder', 'TripOrder'] },
  })),
  actionTypes: functions.filter(([, , , edits]) => edits).map(([name, input, description]) => {
    const objectParameters: Record<string, string> = name === 'startDidiRideWatch'
      ? { order: 'DidiRideOrder' } : { watch: rideWatchType };
    return { apiName: name[0]!.toUpperCase() + name.slice(1), description, parameters: json(input),
      function: name, objectParameters, submissionCriteria: [] };
  }),
};
