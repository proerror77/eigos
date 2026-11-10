import { z } from 'zod';
import didiProductCategories from './definitions/didi/service-tiers.json' with { type: 'json' };

const tiers = z.enum(['discounted', 'express', 'premium', 'premiumSixSeat', 'luxury']);
type RideServiceTier = z.infer<typeof tiers>;

// A ride service tier is what the rider requests. It establishes neither
// the physical vehicle nor its capacity, dispatch status, or final fare.
const tierByLabel = new Map<string, RideServiceTier>([
  ['惊喜特价', 'discounted'],
  ['快车', 'express'],
  ['专车', 'premium'],
  ['六座专车', 'premiumSixSeat'],
  ['豪华车', 'luxury'],
]);

const didiCategoryByTier = z.record(tiers, z.string().regex(/^[1-9]\d*$/)).parse(didiProductCategories);
if (new Set(Object.values(didiCategoryByTier)).size !== tiers.options.length) throw new Error('DiDi service tiers must map to distinct source categories');

const normalizedLabel = (value: string) => value.replace(/\s+/g, '').toLowerCase();

export function didiEstimateMatchesServiceTier(requestedClass: string, item: { productCategory: string; productName: string }): boolean {
  const requested = normalizedLabel(requestedClass);
  const name = normalizedLabel(item.productName);
  const requestedTier = tierByLabel.get(requested);
  // Preserve explicit requests for other exact provider product names.
  if (!requestedTier) return name === requested;
  const namedTier = tierByLabel.get(name);
  return item.productCategory === didiCategoryByTier[requestedTier] && (!namedTier || namedTier === requestedTier);
}
