import { z } from 'zod';
import { digest } from '../core/delegation.js';
import type { CommerceEntityData } from './commerce-journey.js';

const id = z.string().min(1).max(200), country = z.string().regex(/^[A-Z]{2}$/);
export const stockRegulationSchema = z.strictObject({
  customsTerritory: id, status: z.enum(['free_circulation', 'bonded', 'customs_controlled', 'unknown']),
  releaseEvidence: id.optional(),
});
export const shippingLegSchema = z.strictObject({ fromCountry: country, toCountry: country, fromTerritory: id, toTerritory: id });
export const shippingRegimeSchema = z.enum(['domestic', 'regional', 'customs', 'mixed', 'unknown']);

// This bounded mapping is a synthetic fixture contract, not a global legal map.
export const SHIPPING_RULES = Object.freeze({
  version: 'synthetic-shipping-v1',
  territories: Object.freeze({ CN: 'CN', HK: 'HK', MO: 'MO', US: 'US', CA: 'CA', DE: 'EU', FR: 'EU' } as Record<string, string>),
  transportCodes: Object.freeze(['commodity_carriage_check', 'carrier_acceptance']),
  regionalCodes: Object.freeze(['regional_transport_check']),
});
export interface ShippingRouteResult {
  status: 'known' | 'unknown'; regime: z.infer<typeof shippingRegimeSchema>;
  customsRequired: boolean | 'unknown'; routeDigest: string;
  groups: { id: string; regime: 'domestic' | 'regional' | 'customs'; customsRequired: boolean; reason: string }[];
  reason?: string;
}

/** Country of seller registration and goods origin deliberately do not select
 * the route. Each actual package, transit leg and warehouse status must agree. */
export function classifyShippingRoute(fulfillment: CommerceEntityData<'FulfillmentPlan'>, optionId: string,
  inventory: CommerceEntityData<'InventoryObservation'>): ShippingRouteResult {
  const option = fulfillment.options.find(value => value.id === optionId);
  const routeDigest = digest({ optionId, destination: fulfillment.destination, destinationTerritory: fulfillment.destinationCustomsTerritory, groups: option?.groups, inventory });
  const unknown = (reason: string): ShippingRouteResult => ({ status: 'unknown', regime: 'unknown', customsRequired: 'unknown', routeDigest, groups: [], reason });
  const destination = fulfillment.destination.countryCode, territory = fulfillment.destinationCustomsTerritory;
  if (!option || option.status !== 'available' || !territory || SHIPPING_RULES.territories[destination] !== territory) return unknown('No reviewed source-bound destination territory and available route');
  if (inventory.merchantId !== fulfillment.merchantId || inventory.variantId !== fulfillment.variantId || inventory.requestedQuantity !== fulfillment.quantity || option.groups.reduce((sum, group) => sum + group.quantity, 0) !== fulfillment.quantity || new Set(option.groups.map(g => g.id)).size !== option.groups.length) return unknown('Package, inventory and requested goods or quantity differ');
  const groups: ShippingRouteResult['groups'] = [];
  for (const group of option.groups) {
    const locations = inventory.locations.filter(location => location.warehouseId === group.warehouseId);
    if (locations.length !== 1) return unknown('Ambiguous source warehouse');
    const location = locations[0]!, stock = location.regulation, legs = group.legs;
    if (group.variantId !== fulfillment.variantId || group.destinationDigest !== fulfillment.destinationDigest || location.dispatchCountry !== group.dispatchCountry || location.availability !== 'confirmed' || location.quantityState !== 'sellable' || option.groups.filter(g => g.warehouseId === location.warehouseId).reduce((n, g) => n + g.quantity, 0) > (location.confirmedQuantity ?? 0)) return unknown('Route exceeds or contradicts current source warehouse stock');
    if (!stock || stock.status === 'unknown' || !legs?.length || !group.regulation || digest(group.regulation) !== digest(stock) || SHIPPING_RULES.territories[group.dispatchCountry] !== stock.customsTerritory) return unknown('Warehouse regulatory status or exact transport legs are missing or conflicting');
    if (stock.status === 'free_circulation' && !stock.releaseEvidence) return unknown('Local stock has no source evidence of free circulation');
    let previousCountry = group.dispatchCountry, previousTerritory = stock.customsTerritory;
    let crossTerritory = false, crossCountry = false;
    for (const leg of legs) {
      if (leg.fromCountry !== previousCountry || leg.fromTerritory !== previousTerritory || SHIPPING_RULES.territories[leg.fromCountry] !== leg.fromTerritory || SHIPPING_RULES.territories[leg.toCountry] !== leg.toTerritory) return unknown('Transport legs are discontinuous or have unreviewed territory mappings');
      crossTerritory ||= leg.fromTerritory !== leg.toTerritory; crossCountry ||= leg.fromCountry !== leg.toCountry;
      previousCountry = leg.toCountry; previousTerritory = leg.toTerritory;
    }
    const transit = [...new Set(legs.slice(0, -1).map(leg => leg.toCountry).filter(value => value !== group.dispatchCountry && value !== destination))].sort();
    if (previousCountry !== destination || previousTerritory !== territory || digest(transit) !== digest([...new Set(group.transitCountries)].sort())) return unknown('Route endpoint or declared transit differs from its legs');
    const customsRequired = crossTerritory || stock.status !== 'free_circulation';
    groups.push({ id: group.id, regime: customsRequired ? 'customs' : crossCountry ? 'regional' : 'domestic', customsRequired,
      reason: customsRequired ? crossTerritory ? 'Actual leg crosses a customs territory boundary' : 'Bonded or controlled stock requires a release assessment' : crossCountry ? 'Same customs territory; regional transport requirements still apply' : 'Local free-circulation stock; domestic transport requirements apply' });
  }
  const regimes = new Set(groups.map(group => group.regime));
  return { status: 'known', regime: regimes.size === 1 ? groups[0]!.regime : 'mixed', customsRequired: groups.some(group => group.customsRequired), routeDigest, groups };
}

export function requiredShippingCodes(route: ShippingRouteResult) {
  return [...SHIPPING_RULES.transportCodes, ...(route.groups.some(group => group.regime === 'regional') ? SHIPPING_RULES.regionalCodes : []), ...(route.customsRequired === true ? ['commodity_import_check'] : [])];
}
