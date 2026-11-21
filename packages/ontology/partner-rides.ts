import { z } from 'zod';
import type { OntologyDocument } from './schema.js';
import { json } from './service-contracts.js';

const point = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  address: z.string().trim().min(1).max(500),
});
export const partnerRideRoute = z.strictObject({
  coordinateSystem: z.literal('WGS84'), pickup: point, dropoff: point,
}).refine(({ pickup, dropoff }) => pickup.latitude !== dropoff.latitude || pickup.longitude !== dropoff.longitude,
  'Pickup and destination must differ');
export const partnerRideProvider = z.enum(['Uber', 'Grab']);
export const partnerRideEnvironment = z.enum(['production', 'sandbox']);
export const partnerRideServices = {
  Uber: { function: 'estimateUberRide', capability: 'ride.uber.estimate' },
  Grab: { function: 'estimateGrabRide', capability: 'ride.grab.estimate' },
} as const;
export const partnerRideRequest = z.strictObject({
  provider: partnerRideProvider, environment: partnerRideEnvironment,
  bindingId: z.uuid(), route: partnerRideRoute,
});

const decimal = z.string().regex(/^\d{1,24}(?:\.\d{1,8})?$/);
export const uberFareRange = z.strictObject({ lower: decimal, upper: decimal });
const product = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  name: z.string().min(1).max(400).optional(),
  etaSeconds: z.number().int().nonnegative().optional(),
  fare: z.strictObject({
    currency: z.string().regex(/^[A-Z]{3}$/), point: decimal.optional(),
    range: uberFareRange.optional(), expiresAt: z.iso.datetime({ offset: true }).optional(),
  }),
});
const service = z.strictObject({
  id: z.number().int().positive(), name: z.string().min(1).max(400),
  etaSeconds: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/),
  minAmount: z.number().nonnegative(), maxAmount: z.number().nonnegative(),
  appLink: z.string().min(1).max(8192),
});
export const partnerRideQuotes = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('Uber'), amountUnit: z.literal('provider_wire_unverified'), quotes: z.array(product).min(1).max(100) }),
  z.strictObject({ provider: z.literal('Grab'), amountUnit: z.literal('major'), quotes: z.array(service).min(1).max(100) }),
]);
export const partnerRideResponse = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['authorization-required', 'no-estimate', 'source-unavailable']) }),
  z.strictObject({
    status: z.literal('quoted'), requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    observedAt: z.iso.datetime(), data: partnerRideQuotes,
  }),
]);
const handoffLink = z.string().url().max(8192);
const result = z.discriminatedUnion('status', [
  partnerRideResponse.options[0],
  z.strictObject({
    status: z.literal('quoted'), provider: partnerRideProvider, route: partnerRideRoute,
    observedAt: z.iso.datetime(), environment: partnerRideEnvironment, evidence: z.literal('pa_reported'),
    orderCreated: z.literal(false), paymentInitiated: z.literal(false),
    handoff: z.literal('user_action_required'), paRequestId: z.uuid(),
    amountUnit: z.enum(['provider_wire_unverified', 'major']),
    quotes: z.array(z.union([product.extend({ appLink: handoffLink }), service.extend({ appLink: handoffLink })])).min(1).max(100),
  }),
]);

export const partnerRideDefinitions: OntologyDocument['functionTypes'] = partnerRideProvider.options.map(provider => ({
  apiName: partnerRideServices[provider].function, source: provider, dependencies: {},
  parameters: json(partnerRideRoute), returns: json(result),
  description: `Ask the original Personal Agent for a read-only ${provider} estimate for confirmed WGS84 endpoints. Return an App handoff requiring user confirmation. Use only on the original task and only when the user requests this provider. Never claim a booking or payment.`,
}));
