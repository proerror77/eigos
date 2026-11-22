import { z } from 'zod';
import { gcjPoint } from './maps.js';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const restaurantProviders = z.enum(['Amap', 'Dianping', 'MeituanDining', 'TableCheck', 'Resy']);
export type RestaurantProvider = z.infer<typeof restaurantProviders>;
export const restaurantName = z.string().trim().min(1).max(160);
export const nativeRestaurantId = z.string().trim().min(1).max(160);
const webAddress = z.url({ protocol: /^https$/ }).max(2000);
export const restaurantLocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const restaurantGuests = z.number().int().min(1).max(20);
export const restaurantSearchType = 'RestaurantSearchResult';
export const restaurantVenueType = 'RestaurantSourceVenue';
export const restaurantVisitType = 'RestaurantVisitOption';
export const restaurantVenueLink = 'RestaurantSearchVenues';
export const restaurantVisitLink = 'RestaurantVisitVenue';
export const restaurantSearchInput = z.strictObject({
  query: restaurantName, city: restaurantName, center: gcjPoint.optional(),
  radiusMeters: z.number().int().min(100).max(5000).optional(),
  providers: z.array(restaurantProviders).min(1).max(5).optional(),
  limit: z.number().int().min(1).max(10).optional(),
});
export const venueFacts = z.strictObject({
  provider: restaurantProviders, nativeId: nativeRestaurantId, name: restaurantName, city: restaurantName,
  branch: restaurantName.optional(), address: z.string().trim().min(1).max(600).optional(),
  timeZone: restaurantName.optional(), bookingUrl: webAddress.optional(), supportsBooking: z.boolean().optional(),
  observedAt: time, evidence: z.enum(['live_readonly', 'provider_mock', 'provider_sandbox', 'pa_reported']),
});
export const restaurantQueryOutcome = z.strictObject({
  provider: restaurantProviders,
  status: z.enum(['observed', 'authorization_required', 'unavailable', 'location_required', 'pa_required']),
  count: z.number().int().min(0).max(10),
});
const searchProperties = z.strictObject({
  id: z.string(), name: restaurantName, city: restaurantName, observedAt: time,
  outcomes: z.array(restaurantQueryOutcome).min(1).max(5),
});
export const visitInput = z.strictObject({
  venue: objectRefSchema, date: z.iso.date(), partySize: restaurantGuests,
  channel: z.enum(['provider', 'official_web', 'wechat']).optional(),
});
export const visitChoices = z.strictObject({
  status: z.enum(['observed', 'handoff', 'unsupported', 'unavailable', 'pa_required', 'authorization_required']),
  evidence: z.enum(['live_readonly', 'provider_mock', 'provider_sandbox', 'pa_reported']).optional(),
  bookingUrl: webAddress.optional(), timeZone: restaurantName.optional(),
  availableTimes: z.array(restaurantLocalTime).max(96).optional(),
  availableInstants: z.array(time).max(96).optional(), supportsBooking: z.boolean().optional(),
  observedAt: time, expiresAt: time,
});
const visitProperties = visitChoices.extend({
  id: z.string(), name: restaurantName, date: z.iso.date(), partySize: restaurantGuests,
  channel: visitInput.shape.channel.unwrap(),
});
export const restaurantVisitRecord = visitProperties;
export const meituanDiningQuery = restaurantSearchInput.pick({ query: true, city: true, radiusMeters: true, limit: true })
  .extend({ center: gcjPoint });
export const resyVenueQuery = restaurantSearchInput.pick({ query: true, city: true, limit: true });
export const resyVenueSearch = restaurantQueryOutcome.omit({ count: true }).extend({
  provider: z.literal('Resy'), rows: z.array(venueFacts).max(10),
});
export const restaurantVenueRecord = venueFacts.extend({ id: z.string() });
export const restaurantResultRef = z.strictObject({ search: objectRefSchema });
export const restaurantVisitRef = z.strictObject({ visit: objectRefSchema });

type Props = OntologyDocument['objectTypes'][number]['properties'];
export function restaurantProperties(shape: Record<string, z.ZodType>): Props {
  return Object.fromEntries(Object.entries(shape).map(([name, field]) => [name, {
    description: name, required: !(field instanceof z.ZodOptional),
    schema: json(field instanceof z.ZodOptional ? field.unwrap() as z.ZodType : field),
  }]));
}
const nameProperty = restaurantProperties({ name: restaurantName });
const visitParameters = { venue: 'RestaurantVenue' };
const dependencies = {
  objectTypes: [restaurantSearchType, restaurantVenueType, restaurantVisitType], interfaceTypes: ['RestaurantVenue'],
  linkTypes: [restaurantVenueLink, restaurantVisitLink],
};
const operations = [
  ['FindRestaurants', restaurantSearchInput, {}, 'Search authorized restaurant sources and link each result to its source-specific venue.'],
  ['ReviewRestaurantVisit', visitInput, visitParameters, 'Check an exact date and party size or return the venue’s official booking handoff.'],
] as const;
const fnName = (name: string) => name[0]!.toLowerCase() + name.slice(1);
const searchConstraint = { parameters: json(restaurantSearchInput), objectParameters: {}, required: true };
const visitConstraint = { parameters: json(visitInput), objectParameters: visitParameters, required: true };

export const restaurantServices: Pick<OntologyDocument, 'objectTypes' | 'interfaceTypes' | 'linkTypes' | 'functionTypes' | 'actionTypes'> = {
  interfaceTypes: [
    { apiName: 'RestaurantVenue', description: 'A restaurant identity as reported by one source.',
      properties: restaurantProperties({ name: restaurantName, city: restaurantName, provider: restaurantProviders }),
      optionalProperties: [], links: {}, actions: {} },
    { apiName: 'RestaurantDiscovery', description: 'Find restaurant venues through authorized sources.',
      properties: nameProperty, optionalProperties: [],
      links: { venues: { target: 'RestaurantVenue', cardinality: 'many', required: true } },
      actions: { search: searchConstraint } },
    { apiName: 'RestaurantVisitReview', description: 'Review availability or a booking handoff for an exact venue and party.',
      properties: nameProperty, optionalProperties: [],
      links: { venue: { target: 'RestaurantVenue', cardinality: 'one', required: true } },
      actions: { review: visitConstraint } },
  ],
  objectTypes: [
    { apiName: restaurantVenueType, displayName: '餐厅门店来源记录', primaryKey: 'id', titleProperty: 'name',
      description: 'A bounded venue observation with a source-native identity.',
      properties: restaurantProperties(restaurantVenueRecord.shape),
      interfaces: { RestaurantVenue: { properties: { name: 'name', city: 'city', provider: 'provider' }, links: {}, actions: {} } } },
    { apiName: restaurantSearchType, displayName: '餐厅搜索结果', primaryKey: 'id', titleProperty: 'name',
      description: 'Source outcomes and matched venues for one restaurant search.',
      properties: restaurantProperties(searchProperties.shape),
      interfaces: { RestaurantDiscovery: { properties: { name: 'name' }, links: { venues: 'venues' },
        actions: { search: { action: 'FindRestaurants', parameters: { query: 'query', city: 'city', center: 'center',
          radiusMeters: 'radiusMeters', providers: 'providers', limit: 'limit' } } } } } },
    { apiName: restaurantVisitType, displayName: '餐厅空位或预订入口', primaryKey: 'id', titleProperty: 'name',
      description: 'A dated availability observation or supplier booking handoff for one venue.',
      properties: restaurantProperties(visitProperties.shape),
      interfaces: { RestaurantVisitReview: { properties: { name: 'name' }, links: { venue: 'venue' },
        actions: { review: { action: 'ReviewRestaurantVisit', parameters: { venue: 'venue', date: 'date',
          partySize: 'partySize', channel: 'channel' } } } } } },
  ],
  linkTypes: [
    { apiName: restaurantVenueLink, description: 'The venue observations returned in this search.',
      from: { type: restaurantSearchType, name: 'venues', cardinality: 'many' },
      to: { type: restaurantVenueType, name: 'search', cardinality: 'one' } },
    { apiName: restaurantVisitLink, description: 'The exact venue evaluated by this visit option.',
      from: { type: restaurantVisitType, name: 'venue', cardinality: 'one' },
      to: { type: restaurantVenueType, name: 'visitOptions', cardinality: 'many' } },
  ],
  actionTypes: operations.map(([apiName, schema, objectParameters, description]) => ({
    apiName, description, parameters: json(schema), objectParameters: { ...objectParameters }, function: fnName(apiName), submissionCriteria: [],
  })),
  functionTypes: [
    { apiName: 'searchMeituanDiningRestaurants', source: 'MeituanDining', description: 'Search Meituan Enterprise dine-in venues around a verified GCJ-02 point.',
      parameters: json(meituanDiningQuery), returns: json(z.array(venueFacts).max(10)), dependencies: {} },
    { apiName: 'searchResyRestaurants', source: 'Resy', description: 'Ask the original PA to run the official Resy connector and return verified venue candidates.',
      parameters: json(resyVenueQuery), returns: json(resyVenueSearch), dependencies: {} },
    ...operations.map(([name, schema, , description]) => ({
      apiName: fnName(name), description, parameters: json(schema), returns: json(objectRefSchema), edits: true,
      dependencies: { ...dependencies, functions: ['searchMapPlaces', 'searchNearbyPlaces', 'searchDianpingRestaurants',
        'readDianpingRestaurant', 'readDiningWebAvailability', 'readDiningMiniProgramAvailability',
        'searchMeituanDiningRestaurants', 'searchResyRestaurants'] },
    })),
    { apiName: 'readRestaurantSearch', description: 'Read authorized venues and source outcomes from a restaurant search.',
      parameters: json(restaurantResultRef), returns: json(searchProperties.extend({ venues: z.array(restaurantVenueRecord).max(50) })), dependencies },
    { apiName: 'readRestaurantVisit', description: 'Read the selected venue, dated availability and any official booking handoff.',
      parameters: json(restaurantVisitRef), returns: json(visitProperties.extend({ venue: restaurantVenueRecord })), dependencies },
  ],
};
