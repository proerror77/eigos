import { z } from 'zod';
import { objectRefSchema } from './schema.js';

export const serviceName = z.enum(['Luma', 'RollingGo', 'Shopify']);
export type ServiceName = z.infer<typeof serviceName>;
export const time = z.iso.datetime({ offset: true });
export const shortText = z.string().min(1).max(500);
export const evidence = z.enum(['live_readonly', 'pa_reported', 'provider_mock', 'synthetic']);
export const commonOffer = z.object({
  nativeId: shortText,
  name: shortText,
  url: z.url().max(2000).optional(),
});
export const eventFacts = commonOffer.extend({
  status: z.enum(['active', 'canceled', 'unknown']),
  start: time,
  end: time,
  timeZone: shortText,
  address: z.string().max(1500),
  locationPrecision: z.enum(['exact', 'coarse', 'online', 'unknown']),
  registrationOpen: z.boolean(),
  approvalRequired: z.boolean(),
  // A card price is not a ticket offer or authority to register.
  startingPrice: z.number().int().nonnegative().safe().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
});
export const hotelFacts = commonOffer.extend({
  address: z.string().max(1500),
  checkIn: z.iso.date(),
  nights: z.number().int().min(1).max(28),
  adults: z.number().int().min(1).max(20),
  amount: z.number().finite().nonnegative().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  priceKind: z.literal('reference'),
});
export const productFacts = commonOffer.extend({
  productId: shortText,
  variantId: shortText,
  sellerId: shortText,
  merchantDomain: shortText,
  amountMinor: z.number().int().nonnegative().safe().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  available: z.boolean().nullable(),
  deliveryTime: z.literal('unknown'),
});
export const eventSearchInput = z.strictObject({
  eventId: shortText.optional(),
  query: shortText.optional(),
  location: shortText.optional(),
  after: time.optional(),
  before: time.optional(),
  cursor: z.string().min(1).max(2000).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const lumaPAResponse = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    accountRef: shortText,
    observedAt: time,
    expiresAt: time,
    complete: z.boolean(),
    cursor: z.string().max(2000).nullable(),
    items: z.array(eventFacts).max(50),
    source: z.literal('https://mcp.luma.com'),
    proofDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ status: z.enum(['denied', 'unavailable', 'unsupported']), reason: shortText }),
]);
export const productSearchInput = z.strictObject({
  query: z.string().min(1).max(500),
  country: z.string().regex(/^[A-Z]{2}$/),
  limit: z.number().int().min(1).max(10).default(5),
});
export const hotelSearchInput = z.strictObject({
  place: shortText,
  checkIn: z.iso.date(),
  nights: z.number().int().min(1).max(28),
  adults: z.number().int().min(1).max(20),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('CNY'),
  limit: z.number().int().min(1).max(10).default(5),
});
const observation = z.object({
  bindingId: shortText,
  provider: serviceName,
  observedAt: time,
  expiresAt: time,
  evidence,
  complete: z.boolean(),
  cursor: z.string().max(2000).nullable(),
  inputDigest: z.string().length(64),
  contentDigest: z.string().length(64),
  proofDigest: z.string().length(64).optional(),
});
export const serviceObservation = z.discriminatedUnion('provider', [
  observation.extend({ provider: z.literal('Luma'), items: z.array(eventFacts).max(50) }),
  observation.extend({ provider: z.literal('RollingGo'), items: z.array(hotelFacts).max(10) }),
  observation.extend({ provider: z.literal('Shopify'), items: z.array(productFacts).max(100) }),
]);
export type ServiceObservation = z.infer<typeof serviceObservation>;
export const attachServiceInput = z.strictObject({ plan: objectRefSchema, service: objectRefSchema });
export const readServiceInput = z.strictObject({ service: objectRefSchema });
export const json = (schema: z.ZodType) => z.toJSONSchema(schema) as Record<string, unknown>;
