import { z } from 'zod';
import { coordinates } from './location.js';
import { gcjPoint } from './maps.js';
import type { OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const dianpingSource = 'Dianping';
const text = z.string().trim().min(1).max(200);
const shopId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const filters = {
  query: text.optional(),
  page: z.number().int().min(1).max(10).default(1),
  limit: z.number().int().min(1).max(25).default(10),
};

export const dianpingSearch = z.union([
  z.strictObject({ ...filters, city: text }),
  z.strictObject({ ...filters, city: text.optional(), center: gcjPoint, radiusMeters: z.number().int().min(1).max(5000).default(1000) }),
]);
export const dianpingShopRead = z.strictObject({ shopId });

const httpLink = z.url({ protocol: /^https$/ }).max(2000);
const count = z.number().int().nonnegative().safe();
const amount = z.number().nonnegative().finite();
const label = { provider: z.literal(dianpingSource), observedAt: time, evidence: z.enum(['live_readonly', 'provider_mock']) };
const shop = z.strictObject({
  shopId, name: text, branchName: text.optional(), address: z.string().min(1).max(600).optional(),
});
export const dianpingSearchResult = z.strictObject({
  ...label, page: filters.page, limit: filters.limit, totalCount: count.optional(),
  shops: z.array(shop.extend({ category: text.optional(), distanceMeters: z.number().min(0).max(5000).optional() })).max(25),
});

export const dianpingShopResult = z.strictObject({
  ...label,
  shop: shop.extend({
    city: text.optional(),
    location: z.strictObject({ ...coordinates, coordinateSystem: z.literal('unknown') }).optional(),
    categories: z.array(text).max(20).optional(),
    businessHours: z.string().min(1).max(600).optional(),
    rating: z.number().min(0).max(5).optional(),
    averageSpend: amount.optional(),
    reviewCount: count.optional(),
    reviewTags: z.array(z.strictObject({ label: text, count: count.optional() })).max(10).optional(),
    recommendedDishes: z.array(z.strictObject({ name: text, price: amount.optional(), recommendationCount: count.optional() })).max(10).optional(),
    detailUrl: httpLink.optional(),
    reviewsUrl: httpLink.optional(),
    supportsBooking: z.boolean().optional(),
    bookingUrl: httpLink.optional(),
  }),
});

export const dianpingResearchFunctions: OntologyDocument['functionTypes'] = [
  {
    apiName: 'searchDianpingRestaurants', source: dianpingSource, parameters: json(dianpingSearch), returns: json(dianpingSearchResult), dependencies: {},
    description: 'Find Dianping restaurant POIs by a keyword and city or an explicit GCJ-02 point. For a named landmark, resolve its point through Amap first. Use the returned shopId to inspect a selected branch.',
  },
  {
    apiName: 'readDianpingRestaurant', source: dianpingSource, parameters: json(dianpingShopRead), returns: json(dianpingShopResult), dependencies: {},
    description: 'Read the selected Dianping shop ID, including the permitted rating, average spend, review counts and tags, recommended dishes and official booking link. A booking link is a handoff for the user to check availability and reserve.',
  },
];
