import { z } from 'zod';
import { json, time } from './service-contracts.js';
import { coordinates, requestLocationForService, serviceLocation } from './location.js';
import type { OntologyDocument } from './schema.js';

const addressId = z.string().trim().regex(/^[1-9][0-9]{0,20}$/);
const label = z.string().trim().min(1).max(300);
const minor = z.number().int().nonnegative().safe();
export const paotuiInput = z.strictObject({
  senderAddressId: addressId, recipientAddressId: addressId, goodsName: z.string().trim().min(1).max(100),
  category: z.enum(['文件', '快递', '餐饮']), weightKg: z.number().positive().max(50),
  service: z.enum(['ordinary', 'express']),
});
export const paotuiAddresses = z.array(z.strictObject({ addressId, label })).max(100);
export const paotuiQuote = z.strictObject({
  provider: z.literal('MeituanPaotui'), feeMinor: minor, originalFeeMinor: minor, currency: z.literal('CNY'),
  estimatedDelivery: z.string().min(1).max(150), distance: z.string().min(1).max(40).optional(),
  goods: paotuiInput.pick({ goodsName: true, category: true, weightKg: true, service: true }),
  evidence: z.literal('live_readonly'), observedAt: time,
});

const waimaiPoint = z.strictObject({ ...coordinates, coordinateSystem: z.literal('gcj02') });
const waimaiSearch = {
  query: z.string().trim().min(1).max(100).optional(),
  page: z.number().int().min(1).max(100).optional(),
};
export const waimaiShopsInput = z.union([
  waimaiPoint.extend(waimaiSearch),
  serviceLocation.extend(waimaiSearch),
  requestLocationForService.extend(waimaiSearch),
]);
const shopId = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const waimaiShops = z.strictObject({
  provider: z.literal('MeituanWaimai'), evidence: z.enum(['live_readonly', 'provider_sandbox']), observedAt: time,
  hasNextPage: z.boolean(), page: z.number().int().positive(), locationRequestId: z.uuid().optional(),
  shops: z.array(z.strictObject({
    shopId, name: label, address: label.optional(),
    status: z.enum(['deliverable', 'busy', 'closed', 'unknown']),
    listedDeliveryFeeMinor: minor, averageDeliveryMinutes: z.number().int().nonnegative(),
    minimumOrderMinor: minor, currency: z.literal('CNY'),
  })).max(20),
});
export const waimaiArrivalInput = z.union([
  waimaiPoint.extend({ shopId }),
  serviceLocation.extend({ shopId }),
]);
export const waimaiArrival = z.strictObject({
  provider: z.literal('MeituanWaimai'), shopId, observedAt: time, evidence: waimaiShops.shape.evidence,
  dates: z.array(z.strictObject({
    dateLabel: label, open: z.boolean(),
    times: z.array(z.strictObject({ label, at: time.nullable(), immediate: z.boolean() })).max(150),
  })).max(14),
});

export const deliveryFunctions: OntologyDocument['functionTypes'] = [
  { apiName: 'listMeituanPaotuiAddresses', source: 'MeituanPaotui', parameters: json(z.strictObject({})),
    returns: json(paotuiAddresses), dependencies: {},
    description: 'Find saved sender and recipient address IDs in this owner’s Meituan Paotui account. Returns address labels only. Ask the user to identify any ambiguous endpoints.' },
  { apiName: 'quoteMeituanPaotui', source: 'MeituanPaotui', parameters: json(paotuiInput),
    returns: json(paotuiQuote), dependencies: {},
    description: 'Get the current Meituan Paotui fee and estimated delivery time for a parcel between two selected saved addresses in the same city. Complete this read directly using the result Function.' },
  { apiName: 'findMeituanWaimaiShops', source: 'MeituanWaimai', parameters: json(waimaiShopsInput),
    returns: json(waimaiShops), dependencies: { functions: ['resolveTaskLocation'] },
    description: 'Read nearby Meituan Enterprise Waimai merchants with listed delivery fees and average delivery minutes. Pass the actual GCJ-02 point or a task location reference when available. For the current delivery location omit coordinates, or pass location source specified or planned with the exact address.' },
  { apiName: 'readMeituanWaimaiArrival', source: 'MeituanWaimai', parameters: json(waimaiArrivalInput),
    returns: json(waimaiArrival), dependencies: { functions: ['resolveTaskLocation'] },
    description: 'Read estimated delivery times for the selected Meituan Waimai shop. Reuse locationRequestId from the shop search, or pass the same explicit GCJ-02 point.' },
];
