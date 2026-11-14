import { z } from 'zod';
import { json, time } from './service-contracts.js';
import type { OntologyDocument } from './schema.js';

export const coordinates = {
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
};
export const coordinateSystem = z.enum(['wgs84', 'gcj02']);
export const locationUse = z.enum(['luckin_pickup', 'waimai_delivery', 'nearby_search', 'map_route', 'weather']);
export const locationPlace = z.string().trim().min(1).max(240);
export const locationSelection = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('current') }),
  z.strictObject({ source: z.literal('specified'), place: locationPlace }),
  z.strictObject({ source: z.literal('planned'), place: locationPlace }),
]);
export const serviceLocation = z.strictObject({
  locationRequestId: z.uuid(),
});
export const requestLocationForService = z.strictObject({
  location: locationSelection.optional(),
});
export const taskLocationInput = z.strictObject({
  use: locationUse,
  selection: locationSelection,
  coordinateSystem,
});
export const deviceLocation = z.strictObject({
  ...coordinates,
  coordinateSystem,
  observedAt: time,
  accuracyMeters: z.number().positive(),
});
const locationFields = z.strictObject({ ...coordinates, coordinateSystem });
export const taskLocation = z.discriminatedUnion('source', [
  deviceLocation.extend({ source: z.literal('device') }),
  locationFields.extend({ source: z.literal('specified'), place: locationPlace }),
  locationFields.extend({ source: z.literal('planned'), place: locationPlace }),
]);

export const locationRequest = z.strictObject({
  use: locationUse,
  selection: locationSelection,
  coordinateSystem,
  maxAgeMs: z.number().int().positive(),
  maxAccuracyMeters: z.number().positive(),
  acceptDeviceWgs84: z.literal(true).optional(),
  coordinateProvider: z.literal('Amap').optional(),
});
export const locationReply = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), location: taskLocation }),
  z.strictObject({ status: z.enum(['declined', 'unavailable']) }),
]);
const locationMetadata = { requestId: z.uuid(), coordinateSystem, expiresAt: time };
export const locationReference = z.discriminatedUnion('source', [
  z.strictObject({ ...locationMetadata, source: z.literal('device'), observedAt: time, accuracyMeters: z.number().positive() }),
  z.strictObject({ ...locationMetadata, source: z.literal('specified'), place: locationPlace }),
  z.strictObject({ ...locationMetadata, source: z.literal('planned'), place: locationPlace }),
]);
export const locationCapability = 'location.resolve';
export const locationFunctions: OntologyDocument['functionTypes'] = [
  {
    apiName: 'resolveTaskLocation', source: 'PALocation', parameters: json(taskLocationInput),
    returns: json(locationReference), dependencies: {},
    description: 'Resolve an authorized location for this task. Use current for nearby pickup or delivery with no selected location. Use specified for a user-selected place or planned for an itinerary location. Returns an expiring task-scoped reference without private coordinates.',
  },
];
export const taskLocationValueType = {
  apiName: 'TaskLocation', version: '1',
  description: 'A PA-supplied location scoped to the task, with clear device, specified, or planned provenance and coordinate system.',
  schema: json(taskLocation),
};
