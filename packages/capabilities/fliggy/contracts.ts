import { z } from 'zod';

const text = z.string().trim().min(1).max(300), optionalText = z.string().max(2000).nullable().optional();
const hour = z.number().int().min(0).max(23);
const hotelCriteria = {
  destName: text, checkInDate: z.iso.date(), checkOutDate: z.iso.date(),
  keyWords: text.optional(), poiName: text.optional(),
  sort: z.enum(['distance_asc','rate_desc','price_asc','price_desc','no_rank']).optional(),
  hotelBedTypes: text.optional(), maxPrice: z.number().int().positive().max(1e7).optional(),
};
export const fliggyInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('flight'), criteria: z.strictObject({
    origin: text, destination: text, depDate: z.iso.date(), backDate: z.iso.date().optional(),
    journeyType: z.union([z.literal(1),z.literal(2)]).optional(), seatClassName: text.optional(),
    transportNo: text.optional(), transferCity: text.optional(), depHourStart: hour.optional(), depHourEnd: hour.optional(),
    arrHourStart: hour.optional(), arrHourEnd: hour.optional(), totalDurationHour: z.number().positive().max(200).optional(),
    maxPrice: z.number().int().positive().max(1e7).optional(), sortType: z.number().int().min(1).max(8).optional(),
  }) }),
  z.strictObject({ kind: z.literal('hotel'), criteria: z.strictObject({ ...hotelCriteria, hotelTypes: text.optional(), hotelStars: text.optional() }) }),
  z.strictObject({ kind: z.literal('marriottHotel'), criteria: z.strictObject(hotelCriteria) }),
  z.strictObject({ kind: z.literal('marriottPackage'), criteria: z.strictObject({ keyword: text.optional(), hotelName: text.optional(), provinceOrCity: text.optional(), sortType: z.enum(['price_asc','price_desc']).optional() }) }),
]);
export type FliggyInput = z.infer<typeof fliggyInputSchema>;
export const fliggyActions = {
  flight: { action: 'SearchFliggyFlights', tool: 'search_flight', command: 'search-flight' },
  hotel: { action: 'SearchFliggyHotels', tool: 'search_hotels', command: 'search-hotel' },
  marriottHotel: { action: 'SearchFliggyMarriottHotels', tool: 'search_marriott_hotels', command: 'search-marriott-hotel' },
  marriottPackage: { action: 'SearchFliggyMarriottPackages', tool: 'search_marriott_packages', command: 'search-marriott-package' },
} as const;
export function validateFliggyInput(value: FliggyInput, now = Date.now()) {
  if (value.kind === 'marriottPackage') {
    if (!value.criteria.keyword && !value.criteria.hotelName && !value.criteria.provinceOrCity) throw new Error('A package query requires an explicit keyword, hotel name or place');
    return;
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  if (value.kind === 'flight') {
    const c = value.criteria;
    if (c.depDate < today || c.origin === c.destination || c.backDate && c.backDate < c.depDate
      || c.depHourStart !== undefined && c.depHourEnd !== undefined && c.depHourEnd < c.depHourStart
      || c.arrHourStart !== undefined && c.arrHourEnd !== undefined && c.arrHourEnd < c.arrHourStart) throw new Error('INVALID_FLIGHT_CRITERIA');
  } else if (value.criteria.checkInDate < today || value.criteria.checkOutDate <= value.criteria.checkInDate) throw new Error('INVALID_STAY_DATES');
}
export const fliggyArguments = (input: FliggyInput) => ({ ...input.criteria, ...(['flight','hotel'].includes(input.kind) ? { limit: 10 } : {}) });
const display = z.string().max(2000).nullable().optional();
const sourceNumber = z.union([z.string().max(100), z.number().finite()]).nullable().optional();
const url = z.string().max(6000).refine(value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && ['feizhu.com','fliggy.com','taobao.com','tmall.com','alicdn.com'].some(host => u.hostname === host || u.hostname.endsWith('.'+host)); } catch { return false; }
});
const segment = z.object({
  depCityCode: optionalText, depCityName: optionalText, depStationCode: text, depStationName: optionalText, depTerm: optionalText,
  depDateTime: text, arrCityCode: optionalText, arrCityName: optionalText, arrStationCode: text, arrStationName: optionalText,
  arrTerm: optionalText, arrDateTime: text, duration: optionalText, marketingTransportName: optionalText,
  marketingTransportNo: text, seatClassName: optionalText, quantity: sourceNumber,
});
export const fliggyFlightSchema = z.object({
  journeys: z.array(z.object({ journeyType: text, segments: z.array(segment).min(1).max(10), totalDuration: optionalText, transferDuration: optionalText })).min(1).max(4),
  ticketPrice: optionalText, adultPrice: optionalText, jumpUrl: url, totalDuration: optionalText,
  tags: z.array(z.string().max(500)).max(30).nullable().optional(),
});
export const fliggyHotelSchema = z.object({
  sourceId: text, name: text, address: optionalText, brandName: optionalText, price: display,
  detailUrl: url, mainPic: url.nullable().optional(), star: optionalText, nearbyPoi: optionalText, interestsPoi: optionalText,
  score: sourceNumber, scoreDesc: optionalText, rate: sourceNumber, commissionMoneyYuan: sourceNumber,
});
export const fliggyPackageSchema = z.object({
  itemId: optionalText, title: text, price: display, detailUrl: url, picUrl: url.nullable().optional(),
  sellPoint: display, benefit: display, hotelName: optionalText, cityName: optionalText, brandName: optionalText,
  rate: sourceNumber, commissionMoneyYuan: sourceNumber,
});
export const fliggyItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('flight'), offer: fliggyFlightSchema }),
  z.strictObject({ kind: z.literal('hotel'), offer: fliggyHotelSchema }),
  z.strictObject({ kind: z.literal('marriottHotel'), offer: fliggyHotelSchema }),
  z.strictObject({ kind: z.literal('marriottPackage'), offer: fliggyPackageSchema }),
]);
export const fliggyResultSchema = z.strictObject({
  items: z.array(fliggyItemSchema).max(10), resultState: z.enum(['results','empty']), systemMessage: z.string().max(4000).optional(),
  accessLevel: z.enum(['trial','unspecified']), completeness: z.literal('partial'),
});
export type FliggyResult = z.infer<typeof fliggyResultSchema>;
export function parseFliggyResponse(input: FliggyInput, raw: unknown): FliggyResult {
  const response = z.object({ status: z.literal(0), message: z.string().max(300), data: z.object({ itemList: z.array(z.unknown()).max(100) }).nullable(), systemMessage: z.string().max(4000).optional() }).parse(raw);
  if (response.data === null && response.message !== 'empty' || response.message === 'empty' && response.data?.itemList.length) throw new Error('INVALID_SOURCE_EMPTY_RESULT');
  const items = (response.data?.itemList ?? []).slice(0,10).map(item => {
    if (input.kind === 'flight') {
      const offer = fliggyFlightSchema.parse(item);
      // Dates are source-local strings, not inferred time zones or confirmed inventory.
      const dates = offer.journeys.map(j => j.segments[0]!.depDateTime.slice(0,10));
      if (dates[0] !== input.criteria.depDate || input.criteria.backDate && dates[1] !== input.criteria.backDate) throw new Error('SOURCE_FLIGHT_DATES_CHANGED');
      return { kind: input.kind, offer };
    }
    if (input.kind === 'marriottPackage') {
      const p = z.object({ title: optionalText, name: optionalText, sellPoint: display, sellingPoint: display }).passthrough().parse(item);
      return { kind: input.kind, offer: fliggyPackageSchema.parse({ ...p, title: p.title ?? p.name, sellPoint: p.sellPoint ?? p.sellingPoint }) };
    }
    const p = z.object({ shId: optionalText, shid: optionalText }).passthrough().parse(item);
    if (p.shId && p.shid && p.shId !== p.shid) throw new Error('SOURCE_HOTEL_ID_CHANGED');
    return { kind: input.kind, offer: fliggyHotelSchema.parse({ ...p, sourceId: p.shId ?? p.shid }) };
  });
  return fliggyResultSchema.parse({ items, resultState: items.length ? 'results' : 'empty',
    ...(response.systemMessage ? { systemMessage: response.systemMessage } : {}),
    accessLevel: response.systemMessage?.includes('体验模式') ? 'trial' : 'unspecified', completeness: 'partial' });
}
