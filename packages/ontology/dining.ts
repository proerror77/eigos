import { z } from 'zod';
import type { OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const noteSource = 'Xiaohongshu';
export const historySource = 'PAWeatherHistory';
export const diningSource = 'PADiningAvailability';
const text = z.string().trim().min(1).max(200);
const https = z.url({ protocol: /^https$/ }).max(1000);
const evidence = z.enum(['pa_reported', 'synthetic']);
const status = z.strictObject({ status: z.enum(['denied', 'unavailable']), reason: text });

export const noteSearch = z.strictObject({ query: text.max(100), limit: z.number().int().min(1).max(10).default(5) });
const note = z.strictObject({
  title: text, url: z.string().regex(/^https:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item)\/[A-Za-z0-9]{1,64}$/),
});
export const notesResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), observedAt: time, evidence: z.enum(['provider', 'pa_reported', 'synthetic']), notes: z.array(note).max(10) }),
  status,
]);
export const paNotesResult = z.discriminatedUnion('status', [
  notesResult.options[0].extend({ evidence }), status,
]);

export const historyQuery = z.strictObject({ city: text, startDate: z.iso.date(), endDate: z.iso.date() });
export const historyResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), city: text, observedAt: time, sourceUrl: https,
    evidence, kind: z.enum(['station_observation', 'reanalysis']), complete: z.boolean(), days: z.array(z.strictObject({
      date: z.iso.date(), minC: z.number().min(-100).max(70),
    })).min(1).max(14) }),
  status,
]);

export const diningQuery = z.strictObject({
  restaurant: text, address: text, dish: text, start: time, end: time,
});
export const diningAnswer = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), sourceUrl: https, sourceKind: z.enum(['restaurant_menu', 'restaurant_confirmation']),
    observedAt: time, expiresAt: time, evidence }),
  status,
]);
export const diningResult = z.discriminatedUnion('status', [
  z.strictObject({ ...diningQuery.shape, ...diningAnswer.options[0].shape, requestId: z.uuid() }),
  status,
]);
export const diningEvidence = diningResult.options[0].omit({ status: true }).extend({ taskId: z.uuid() });

export const diningResearchFunctions: OntologyDocument['functionTypes'] = [
  { apiName: 'searchRestaurantNotes', source: noteSource, parameters: json(noteSearch), returns: json(notesResult), dependencies: {},
    description: 'Search authorized Xiaohongshu public restaurant mentions. Return source links as discovery evidence. Use a public venue or dish keyword without calendar or personal location data.' },
  { apiName: 'readWeatherHistory', source: historySource, parameters: json(historyQuery), returns: json(historyResult), dependencies: {},
    description: 'Request recent historical daily minimum temperatures through the original PA. Separate station observations and reanalysis. Use readWeather for Amap forecasts.' },
  { apiName: 'readDiningAvailability', source: diningSource, parameters: json(diningQuery), returns: json(diningResult), dependencies: {},
    description: 'Ask the original PA to verify the exact dish and meal window from a dated restaurant source. Return an evidence request ID for the proposed activity. This is a read-only supply check.' },
];
