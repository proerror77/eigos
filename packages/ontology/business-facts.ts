import { z } from 'zod';
import type { LinkDefinition, ObjectTypeDefinition, PropertyDefinition } from './model.js';

const text = z.string().min(1).max(2000), time = z.iso.datetime({ offset: true });
const decimal = z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,6})?$/);
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, required = true): PropertyDefinition =>
  ({ kind, schema, description, required, source: 'Validated source observation; identity, scope and freshness are retained independently from fulfillment' });
const str = (description: string, required = true) => p('string', text, description, required);
const stamp = (description: string) => p('timestamp', time, description);
const integer = (description: string) => p('integer', z.number().int().positive(), description);
const type = (id: string, name: string, description: string, fields: Record<string, PropertyDefinition>, timed = true): ObjectTypeDefinition => ({
  id, version: '1', name, aliases: [id, name], description, primaryKey: 'id', titleKey: 'displayTitle',
  interfaces: [{ id: 'EvidenceBacked' }],
  properties: { id: str('Source-scoped identity'), displayTitle: str('Business label, never identity'),
    ...(timed ? { observedAt: stamp('Actual source observation time'), expiresAt: stamp('Local freshness deadline, not a provider commitment') } : {}), ...fields },
});

export const businessFactObjects: ObjectTypeDefinition[] = [
  type('RideEstimate', '车型费用估计', 'One source-observed estimate for a specific route and service category. Not a confirmed offer, order or final fare.', {
    requestRevision: integer('Exact request revision to which this estimate applies'),
    productCategory: str('Provider service category'), productName: str('Provider service name'), priceText: str('Original bounded price display', false),
    estimatedAmount: p('decimal', decimal, 'Estimated CNY major units, only when the source supplies an exact amount', false),
    currency: p('string', z.literal('CNY'), 'Explicit estimate currency', false),
    priceKind: p('string', z.literal('estimate'), 'Estimate, never a final fare'), feesComplete: p('string', z.literal('unknown'), 'Full mandatory fees are not proven'),
  }),
  type('HotelPrice', '酒店参考价格', 'A hotel search price for the exact check-in date, nights and adults. Room, availability, tax and price basis remain unknown unless independently sourced.', {
    hotelRevision: integer('Exact hotel description revision seen with this reference price'),
    requestRevision: integer('Exact request revision to which these search conditions apply'),
    checkInDate: p('string', z.iso.date(), 'Requested local check-in date'), stayNights: integer('Requested nights'), adultCount: integer('Requested adults'),
    referenceAmount: p('decimal', decimal, 'Provider numeric reference price in major units; not assumed to be nightly or stay total', false),
    currency: p('string', z.string().regex(/^[A-Z]{3}$/), 'Currency explicitly attached to the returned price', false),
    hasPrice: p('boolean', z.boolean(), 'Provider price availability flag'), priceKind: p('string', z.literal('reference'), 'Reference price, not a bookable offer'),
    priceBasis: p('string', z.literal('provider_unspecified'), 'The source does not specify nightly versus whole-stay basis'),
  }),
  type('Event', '活动或预约场次', 'Source-identified event or appointment session. Its URL identifies the source event; no venue or attendance is inferred.', {
    serviceUrl: str('Canonical source service URL'), title: str('Source event title'), kind: p('string', z.enum(['event_registration', 'appointment']), 'Source service kind'),
    startsAt: stamp('Source start time'), endsAt: stamp('Source end time'), timeZone: str('Source IANA time zone'),
  }, false),
  type('EventRegistration', '参与者报名', 'Stable registration identity scoped to the source, event and participant. Current state and independent confirmation remain separate facts.', {
    eventRevision: integer('Exact event schedule revision observed for this registration'),
    sourceVersion: integer('Monotonic version of this source registration'),
    state: p('string', z.enum(['submitted', 'pending_approval', 'waitlisted', 'confirmed', 'rejected', 'canceled', 'expired', 'unknown']), 'Observed registration state'),
    independentRead: p('boolean', z.boolean(), 'Whether this state came from an independent source read'),
    submittedAt: { ...stamp('Source submission time'), required: false }, confirmedAt: { ...stamp('Source confirmation time'), required: false },
  }),
  type('CheckoutItem', '结账商品明细', 'One observed selected variant and quantity at a merchant. It is not an order line or inventory reservation.', {
    variantRevision: integer('Exact known product specification revision at this observation'),
    requestRevision: integer('Exact request revision for the selected quantity'),
    quantity: integer('Selected number of source sale units'), unitPriceMinor: p('decimal', z.string().regex(/^(0|[1-9]\d{0,17})$/), 'Unit display price in currency minor units'),
    currency: p('string', z.string().regex(/^[A-Z]{3}$/), 'Source price currency'), available: p('boolean', z.boolean(), 'Source sale availability, not stock reservation', false),
  }),
];
export const businessFactTypes = businessFactObjects.map(o => o.id);
const link = (id: string, from: string, name: string, to: string, reverse: string, many = false, required = false): LinkDefinition => ({
  id, description: `${from}.${name} ↔ ${to}.${reverse}`, from: { type: from, name, many, required }, to: { type: to, name: reverse, many: true },
});
export const businessFactLinks: LinkDefinition[] = [
  ...businessFactTypes.map(id => link(`${id}Evidence`, id, 'sourceReceipts', 'SourceReceipt', `${id[0]!.toLowerCase()}${id.slice(1)}Facts`, true, true)),
  ...['RideEstimate', 'HotelPrice', 'CheckoutItem'].map(id => link(`${id}Request`, id, 'request', 'ServiceRequest', `${id[0]!.toLowerCase()}${id.slice(1)}Facts`, false, true)),
  link('RequestEventRegistration', 'ServiceRequest', 'eventRegistrations', 'EventRegistration', 'requests', true),
  link('DidiObservationPlaces', 'DidiPlaceObservation', 'places', 'Place', 'didiObservations', true),
  link('RideRouteOriginPlace', 'RideRoute', 'originPlace', 'Place', 'departingRideRoutes'),
  link('RideRouteDestinationPlace', 'RideRoute', 'destinationPlace', 'Place', 'arrivingRideRoutes'),
  link('RideObservationEstimates', 'RideEstimateObservation', 'estimates', 'RideEstimate', 'observations', true),
  link('RideEstimateBusinessRoute', 'RideEstimate', 'route', 'RideRoute', 'priceEstimates', false, true),
  link('RideEstimateBusinessProvider', 'RideEstimate', 'provider', 'Provider', 'ridePriceEstimates', false, true),
  link('RollingGoObservationHotels', 'RollingGoSearchObservation', 'hotels', 'HotelProperty', 'rollingGoObservations', true),
  link('RollingGoObservationPrices', 'RollingGoSearchObservation', 'prices', 'HotelPrice', 'observations', true),
  link('HotelPriceHotel', 'HotelPrice', 'hotel', 'HotelProperty', 'referencePrices', false, true),
  link('HotelPriceProvider', 'HotelPrice', 'provider', 'Provider', 'hotelReferencePrices', false, true),
  ...['RegistrationOffer', 'RegistrationRecord'].map(id => link(`${id}Event`, id, 'event', 'Event', `${id[0]!.toLowerCase()}${id.slice(1)}Observations`)),
  link('RegistrationRecordRegistration', 'RegistrationRecord', 'registration', 'EventRegistration', 'observations'),
  link('EventRegistrationEvent', 'EventRegistration', 'event', 'Event', 'registrations', false, true),
  ...['ShopifyCheckoutProducts', 'ShopifyCheckoutObservation'].map(id => link(`${id}Items`, id, 'items', 'CheckoutItem', `${id[0]!.toLowerCase()}${id.slice(1)}Observations`, true)),
  link('CheckoutItemVariant', 'CheckoutItem', 'productVariant', 'ProductVariant', 'checkoutItems', false, true),
  link('CheckoutItemProvider', 'CheckoutItem', 'provider', 'Provider', 'checkoutItems', false, true),
  link('MeituanObservationPlaces', 'MeituanReadObservation', 'places', 'Place', 'meituanObservations', true),
  link('MeituanObservationQuote', 'MeituanReadObservation', 'quote', 'DeliveryQuote', 'meituanObservations'),
];
