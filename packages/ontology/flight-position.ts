import { z } from 'zod';
import { flightPositionSource, searchFlight } from './flight.js';
import type { OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const flightPositionInput = z.strictObject({
  flightNumber: searchFlight.shape.flightNumber,
  origin: searchFlight.shape.origin,
  destination: searchFlight.shape.destination,
});
const code = z.string().regex(/^[A-Z]{3}$/).nullable();
export const flightPositionResult = z.strictObject({
  provider: z.literal(flightPositionSource), fetchedAt: time,
  positions: z.array(z.strictObject({
    trackingId: z.string().regex(/^[a-f0-9]{6,32}$/i),
    flightNumber: searchFlight.shape.flightNumber, callsign: z.string().max(12).nullable(),
    origin: code, destination: code, observedAt: time,
    latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
    coordinateSystem: z.literal('wgs84'), altitudeFeet: z.number().nullable(),
    groundSpeedKnots: z.number().nonnegative().nullable(), estimatedArrivalAt: time.nullable(),
    signalSource: z.string().max(32).nullable(),
  })).max(8),
});

export const flightPositionFunction: OntologyDocument['functionTypes'][number] = {
  apiName: 'readLiveFlightPosition',
  description: 'Read aircraft currently tracked by Flightradar24 for a commercial flight number. Empty results mean no matching tracked aircraft was returned. This may use supplier credits.',
  parameters: json(flightPositionInput), returns: json(flightPositionResult), source: flightPositionSource, dependencies: {},
};
