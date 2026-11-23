import { z } from 'zod';
import { pickupCoordinateEvidence } from './maps.js';
import { personalPlaceRef, personalPlaceType, privateLocation } from './personal-places.js';
import { objectRefSchema, type OntologyDocument } from './schema.js';

export const rideEndpoints = ['origin', 'destination'] as const;
export const estimateWithEndpoints = 'EstimateRideWithEndpoints';
export const prepareWithEndpoints = 'prepareRideInquiryWithEndpoints';
export const bookWithEndpoints = 'BookDidiRideWithEndpoints';
export const bookWithEndpointsFunction = 'bookDidiRideWithEndpoints';
export const immediateRideRouteLink = 'ImmediateRideRoute';

const revision = z.number().int().positive();
export const savedRideEndpoint = z.strictObject({ place: personalPlaceRef, revision });
export const resolvedRideEndpoints = z.strictObject({
  origin: objectRefSchema, destination: objectRefSchema,
  pickup: pickupCoordinateEvidence.optional(),
  originPersonalPlace: savedRideEndpoint.optional(), destinationPersonalPlace: savedRideEndpoint.optional(),
});
export type ResolvedRideEndpoints = z.infer<typeof resolvedRideEndpoints>;

export const ridePersonalPlaceRevisions = z.strictObject({
  origin: revision.optional(), destination: revision.optional(),
});

export const ridePersonalPlaceLinks: OntologyDocument['linkTypes'] = rideEndpoints.map(side => ({
  apiName: side === 'origin' ? 'RouteOriginPersonalPlace' : 'RouteDestinationPersonalPlace',
  description: 'The confirmed personal place used for this route endpoint at the revision recorded on the route.',
  classification: privateLocation,
  from: { type: 'Route', name: side + 'PersonalPlace', cardinality: 'one' },
  to: { type: personalPlaceType, name: side === 'origin' ? 'departures' : 'arrivals', cardinality: 'many' },
}));
