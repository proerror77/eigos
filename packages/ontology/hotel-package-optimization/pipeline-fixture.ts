import type { SyntheticPackageFeed } from './pipeline.js';
import type { Component, Quote, Request, Sku } from './contracts.js';

/** Source-shaped, entirely invented records. All prices, quantities, eligibility
 * and stock assumptions are explicit fixture facts; no provider defaults. */
export function syntheticPackageFeed(scenario: 'dinner' | 'breakfast' | 'qualification' = 'dinner'): SyntheticPackageFeed {
  const sourceId = `synthetic.hotel-packages.${scenario}`, observedAt = '2030-01-01T00:00:00Z', date = '2030-01-10', expiresAt = '2030-01-01T01:00:00Z';
  const rows: SyntheticPackageFeed['rows'] = [];
  function add(mappingId: string, sourceKey: string, attributes: Record<string, unknown>, relations: Record<string, unknown> = {}) {
    rows.push({ mappingId, eventId: `${mappingId}:${sourceKey}:1`, providerVersion: 1,
      payload: { sourceKey, label: 'Synthetic ' + sourceKey, ...attributes, relations } });
  }
  add('hotel', 'hotel-001', { hotel_name: 'Synthetic Hotel', address: 'Synthetic address', timezone: 'Asia/Shanghai' });
  add('room', 'king-001', { room_name: 'Synthetic king', hotel_key: 'hotel-001', max_adults: 2, max_children: 0, capacity: 2, bed: 'Synthetic king bed' }, { hotel: 'hotel-001' });
  add('rate', 'rate-001', { revision: '1', hotel_key: 'hotel-001', room_key: 'king-001' }, { hotel: 'hotel-001', room: 'king-001' });
  for (const code of ['breakfast', 'dinner']) add('entitlement', code, { meaning: { code, unit: 'person_use', inventoryRequired: false } });
  const stay: Component = { kind: 'stay', rooms: 1, nights: 1, conditionsKnown: true };
  const meal = (repeat: 'per_package' | 'per_night' | 'per_stay', dayOffset: number): Component =>
    ({ kind: 'benefit', quantity: 2, repeat, dayOffset, optional: false, conditionsKnown: true });
  const skuIds: string[] = [], quoteIds: string[] = [], poolIds: string[] = [], productIds = new Set<string>();
  function sku(id: string, product: string, category: Sku['category'], components: { id: string; terms: Component; entitlement?: string }[], prerequisites: string[] = []) {
    if (!productIds.has(product)) { add('product', product, { product: { sourceProductId: product } }); productIds.add(product); }
    add('variant', id, { product_ref: { namespace: 'synthetic:hotel-package-feed', id: product }, specification: [{ name: 'native_sku', value: id }], revision: '1' }, { product });
    for (const component of components) add('component', component.id, { terms: component.terms }, component.terms.kind === 'stay'
      ? { rooms: ['king-001'], rate: 'rate-001' } : { entitlement: component.entitlement });
    add('sku', id, { spec: { version: '1', category, maxUnits: 1, saleState: 'available', eligibility: 'eligible', termsKnown: true, platformCommissionMinor: null } },
      { variant: id, components: components.map(c => c.id), prerequisites });
    skuIds.push(id);
    pool('sale-' + id, 'sale', null, [], [id]);
  }
  function pool(id: string, kind: 'room' | 'sale', stockDate: string | null, rooms: string[], skus: string[]) {
    add('pool', id, { stock: { kind, unit: kind === 'room' ? 'room_night' : 'package', state: 'known', capacity: 1, date: stockDate, expiresAt } }, { rooms, skus });
    poolIds.push(id);
  }
  function quote(id: string, amountMinor: string, room: boolean) {
    const quoteId = id + '-date-price', uses = [id + '-sale-use', ...(room ? [id + '-room-use'] : [])];
    add('use', uses[0]!, { use: { quantity: 1, condition: 'always' } }, { pool: 'sale-' + id });
    if (room) add('use', uses[1]!, { use: { quantity: 1, condition: 'always' } }, { pool: 'room-night' });
    const pricing: Quote = { skuVersion: '1', variantRevision: 1, anchorDate: date, currency: 'CNY', priceKind: 'exact', amountMinor,
      feesKnown: true, fees: [], discount: { state: 'none', amountMinor: '0', limited: false }, guest: { adults: 2, childrenAges: [] },
      availability: 'available', cancellation: { state: 'known', freeUntil: null }, expiresAt };
    add('quote', quoteId, { pricing }, { sku: id, ...(room ? { room: 'king-001' } : {}), uses }); quoteIds.push(quoteId);
  }
  pool('room-night', 'room', date, ['king-001'], []);
  if (scenario === 'qualification') {
    // CNY 500 + 200 loses to CNY 600 + 20. The cheaper meal is available
    // only after the qualifying room's simulated redemption for this room/day.
    sku('room-basic', 'room-product', 'room', [{ id: 'basic-stay', terms: stay }]);
    sku('room-premium', 'room-product', 'room', [{ id: 'premium-stay', terms: stay }]);
    sku('dinner-regular', 'meal-product', 'benefit', [{ id: 'regular-meal', terms: meal('per_package', 0), entitlement: 'dinner' }]);
    add('prerequisite', 'premium-meal-rule', { rule: { quantity: 1, basis: 'per_plan', scope: 'same_room', anchor: 'covers_date', dayOffset: 0, phase: 'redemption' } }, { sku: 'room-premium' });
    sku('dinner-discount', 'meal-product', 'benefit', [{ id: 'discount-meal', terms: meal('per_package', 0), entitlement: 'dinner' }], ['premium-meal-rule']);
    quote('room-basic', '50000', true); quote('room-premium', '60000', true); quote('dinner-regular', '20000', false); quote('dinner-discount', '2000', false);
  } else {
    sku('room', 'room-product', 'room', [{ id: 'room-stay', terms: stay }]);
    sku('breakfast', 'meal-product', 'benefit', [{ id: 'breakfast-meal', terms: meal('per_package', 1), entitlement: 'breakfast' }]);
    sku('dinner', 'meal-product', 'benefit', [{ id: 'dinner-meal', terms: meal('per_package', 0), entitlement: 'dinner' }]);
    sku('bundle', 'bundle-product', 'bundle', [{ id: 'bundle-stay', terms: stay },
      { id: 'bundle-breakfast', terms: meal('per_night', 1), entitlement: 'breakfast' }, { id: 'bundle-dinner', terms: meal('per_stay', 0), entitlement: 'dinner' }]);
    quote('room', '59900', true); quote('breakfast', '6000', false); quote('dinner', '12000', false); quote('bundle', '69900', true);
  }
  add('study', 'catalog', { catalog: { datasetId: sourceId, evidenceLevel: 'synthetic', completeness: 'complete' } },
    { products: [...productIds], skus: skuIds, quotes: quoteIds, pools: poolIds, entitlements: ['breakfast', 'dinner'] });
  const requirements: Request = { checkIn: date, checkOut: '2030-01-11', currency: 'CNY', rooms: [{ adults: 2, childrenAges: [] }],
    benefits: scenario === 'qualification' ? [{ code: 'dinner', date, roomIndex: 0, quantity: 2 }]
      : [{ code: 'breakfast', date: '2030-01-11', roomIndex: 0, quantity: 2 }, ...(scenario === 'dinner' ? [{ code: 'dinner', date, roomIndex: 0, quantity: 2 }] : [])],
    allowSplitStay: true, allowRoomTypeChange: false, allowQualificationPurchases: true, cancellationAt: null, maxTotalMinor: null, maxPurchases: 12 };
  add('request', 'request', { requirements }, { study: 'catalog', hotel: 'hotel-001', rooms: ['king-001'] });
  return { format: 'eigos.synthetic.hotel-package-feed.v1', environment: 'synthetic', sourceId, sourceAccount: 'synthetic-account', sourceRevision: '1', observedAt, rows };
}
