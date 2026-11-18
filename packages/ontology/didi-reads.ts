import { z } from 'zod';
import { objectRefSchema as ref, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';
import { coordinates } from './location.js';

export const didiAppLinkInput = z.strictObject({ request: ref, estimate: ref.optional() });
const coordinateLimits = new Map([
  ['slat', 90], ['dlat', 90], ['fromlat', 90], ['tolat', 90],
  ['slng', 180], ['dlng', 180], ['fromlng', 180], ['tolng', 180],
]);
const selectedVehicles = z.array(z.strictObject({
  product_category: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  is_selected: z.union([z.literal(0), z.literal(1)]),
})).min(1).max(20);
const vehicleSelection = z.strictObject({
  multi_require_product: z.string().max(1024).refine(value => {
    try { return selectedVehicles.safeParse(JSON.parse(value)).success; }
    catch { return false; }
  }),
});
const miniProgramSelection = vehicleSelection.extend({ from_type: z.number().int() });

function allowedRideLinkQuery(query: URLSearchParams) {
  const keys = new Set<string>();
  for (const [key, value] of query) {
    if (keys.has(key)) return false;
    keys.add(key);
    const limit = coordinateLimits.get(key);
    if (limit !== undefined) {
      if (!/^-?\d+(?:\.\d+)?$/.test(value) || Math.abs(Number(value)) > limit) return false;
    } else if (key === 'source') {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) return false;
    } else if (key === 'estimate_params' || key === 'extra_request_pramas') {
      const schema = key === 'estimate_params' ? vehicleSelection : miniProgramSelection;
      try { if (!schema.safeParse(JSON.parse(value)).success) return false; }
      catch { return false; }
    } else return false;
  }
  return true;
}
const shortLink = z.url({ protocol: /^https$/, hostname: /^v\.didi\.cn$/ }).max(2048)
  .refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.port && !url.hash
      && /^\/(?:p\/)?[a-zA-Z0-9]+$/.test(url.pathname) && allowedRideLinkQuery(url.searchParams);
  }, 'Expected a DiDi short link with valid ride parameters');
export const didiAppLinks = z.strictObject({
  appLink: shortLink, miniprogramLink: shortLink.optional(), browserLink: shortLink.optional(),
});
const point = z.strictObject({ ...coordinates, coordinateSystem: z.enum(['provider_unspecified', 'gcj02']) });
export const didiReverseInput = z.strictObject({ point });
export const didiAddress = z.strictObject({
  address: z.string().min(1).max(1500),
  city: z.string().max(500).optional(),
  district: z.string().max(500).optional(),
});
export const didiNearbyInput = z.strictObject({
  point, query: z.string().trim().min(1).max(200), radiusMeters: z.number().int().min(100).max(5000),
});
export const didiMapRouteInput = z.discriminatedUnion('mode', [
  z.strictObject({ origin: point, destination: point, mode: z.enum(['walking', 'bicycling']) }),
  z.strictObject({ origin: point, destination: point, mode: z.literal('transit'), city: z.string().trim().min(1).max(200) }),
]);
export const didiMapRoute = z.strictObject({
  durationSeconds: z.number().int().nonnegative().max(604800),
  distanceMeters: z.number().int().nonnegative().max(20000000),
  summary: z.string().max(1500).optional(),
});
export const didiMapRoutes = z.array(didiMapRoute).min(1).max(5);
const receipt = {
  provider: z.literal('Didi'),
  observedAt: time,
  evidence: z.enum(['live_readonly', 'provider_mock', 'fixture']),
  receiptDigest: z.string().length(64),
};
const place = z.strictObject({
  name: z.string(), address: z.string(), city: z.string(), point,
});
export const didiReadDefinitions: OntologyDocument['functionTypes'] = [
  {
    apiName: 'generateDidiRideAppLink',
    description: 'Generate DiDi App, mini-program and browser links from a resolved ride inquiry. Supply a quote reference only for a vehicle the user selected. The user completes the order on DiDi.',
    parameters: json(didiAppLinkInput), returns: json(didiAppLinks.extend(receipt)), source: 'Didi',
    dependencies: {
      objectTypes: ['RideRequest', 'Route', 'Place', 'RideEstimate', 'SourceReceipt'],
      interfaceTypes: ['RideEstimatable', 'PriceEstimate'],
      linkTypes: ['RequestRoute', 'RouteOrigin', 'RouteDestination', 'EstimateRequest', 'EstimateSource', 'PlaceSource'],
    },
  },
  {
    apiName: 'reverseGeocodeDidi',
    description: 'Read the address for a DiDi-native or GCJ-02 coordinate. Preserve the input coordinate system.',
    parameters: json(didiReverseInput), returns: json(didiAddress.extend({ ...receipt, point })), source: 'Didi', dependencies: {},
  },
  {
    apiName: 'searchDidiNearbyPlaces',
    description: 'Read up to 50 DiDi places matching a keyword and a bounded radius about a DiDi-native or GCJ-02 coordinate.',
    parameters: json(didiNearbyInput), returns: json(z.strictObject({ ...receipt, places: z.array(place).max(50) })),
    source: 'Didi', dependencies: {},
  },
  {
    apiName: 'estimateDidiMapRoute',
    description: 'Read walking, bicycling or public transit route estimates from DiDi for explicit endpoints. Use a full city name for public transit.',
    parameters: json(didiMapRouteInput),
    returns: json(z.strictObject({ ...receipt, mode: z.enum(['walking', 'bicycling', 'transit']), routes: didiMapRoutes })),
    source: 'Didi', dependencies: {},
  },
];
