import { z } from 'zod';

const identity = z.union([z.string().min(1).max(128), z.number().int().nonnegative().safe()]);
export const paotuiPublicPlaceSchema = z.object({
  name: z.string().min(1).max(300), address: z.string().max(1000).optional(),
  city: z.string().max(100).optional(), cityId: identity.optional(),
  id: identity.optional(), poiId: identity.optional(),
  lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(),
  coordinateUnit: z.literal('degree').optional(),
}).strict().refine(place => (place.lat === undefined && place.lng === undefined) || place.coordinateUnit === 'degree',
  { message: 'Public coordinates require an explicit degree unit' });

// The official search_poi CLI emits integer microdegrees. Normalize before the
// Ontology receipt hashes the result; never infer units from the value's size.
export function normalizePaotuiPublicPlaces(input: unknown) {
  const places = z.array(z.record(z.string(), z.unknown())).max(100).parse(input);
  return places.map(place => {
    const result: Record<string, unknown> = Object.fromEntries(
      ['name', 'address', 'city', 'cityId', 'id', 'poiId'].filter(key => place[key] !== undefined).map(key => [key, place[key]]));
    for (const [key, limit] of [['lat', 90], ['lng', 180]] as const) if (place[key] !== undefined) {
      result[key] = z.number().int().safe().min(-limit * 1_000_000).max(limit * 1_000_000).parse(place[key]) / 1_000_000;
      result.coordinateUnit = 'degree';
    }
    return paotuiPublicPlaceSchema.parse(result);
  });
}
