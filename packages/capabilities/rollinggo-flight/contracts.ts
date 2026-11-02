import { z } from 'zod';

const code = z.string().regex(/^[A-Z]{3}$/);
const text = z.string().min(1).max(200);
const common = { kind: z.literal('flights'), fromCity: code, toCity: code,
  fromDate: z.iso.date(), adultNumber: z.number().int().min(1).max(9),
  childNumber: z.number().int().min(0).max(8),
  cabinGrade: z.enum(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']) };
export const flightInputSchema = z.union([
  z.strictObject({ kind: z.literal('airports'), keyword: text }),
  z.strictObject({ ...common, tripType: z.literal('ONE_WAY') }),
  z.strictObject({ ...common, tripType: z.literal('ROUND_TRIP'), retDate: z.iso.date() }),
]);
export type FlightInput = z.infer<typeof flightInputSchema>;
export function validateFlightDates(input: FlightInput, now = Date.now()) {
  if (input.kind === 'airports') return;
  // The domestic endpoint searches local departure dates; never substitute UTC dates.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  if (input.fromDate < today || input.fromCity === input.toCity || input.adultNumber + input.childNumber > 9
    || input.tripType === 'ROUND_TRIP' && input.retDate < input.fromDate) throw new Error('INVALID_FLIGHT_CRITERIA');
}
export function flightAction(input: FlightInput) {
  return input.kind === 'airports' ? 'SearchRollingGoAirports' : input.tripType === 'ONE_WAY' ? 'SearchRollingGoOneWayFlights' : 'SearchRollingGoRoundTripFlights';
}
export function flightArguments(input: FlightInput) { const { kind: _, ...args } = input; return args; }
export const airportSchema = z.object({ airportCode: code, airportName: text, cityCode: code,
  cityName: text, countryCode: z.string().regex(/^[A-Z]{2}$/), countryName: text.optional() });
// Keep source local timestamps as strings. No timezone, connection feasibility,
// baggage allowance, seat availability or issuance is inferred from a search.
export const flightSegmentSchema = z.object({ flightNumber: text, depAirport: code, arrAirport: code,
  depTime: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?$/),
  arrTime: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?$/),
  carrierCode: text.optional(), airlineName: text.optional() });
const amount = z.union([z.number().finite().nonnegative().max(1e12), z.string().regex(/^(0|[1-9]\d{0,12})(\.\d{1,6})?$/)]);
export const flightOptionSchema = z.object({ fromSegments: z.array(flightSegmentSchema).min(1).max(8),
  retSegments: z.array(flightSegmentSchema).min(1).max(8).optional(),
  totalAdultPrice: amount.optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), validatingCarrier: text.optional() });
export const flightDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('airports'), airports: z.array(airportSchema).max(100) }),
  z.strictObject({ kind: z.literal('flights'), flights: z.array(flightOptionSchema).max(100) }),
]);
export type FlightData = z.infer<typeof flightDataSchema>;
export function parseFlightResponse(input: FlightInput, raw: unknown): FlightData {
  // This documented legacy envelope is deliberately strict about the list and
  // success flag. Errors, missing fields and changed schemas cannot become [] success.
  if (input.kind === 'airports') {
    const v = z.object({ success: z.literal(true), airPortInformationList: z.array(airportSchema).max(100) }).parse(raw);
    if (new Set(v.airPortInformationList.map(a => a.airportCode)).size !== v.airPortInformationList.length) throw new Error('DUPLICATE_AIRPORT');
    return { kind: 'airports', airports: v.airPortInformationList };
  }
  const v = z.object({ success: z.literal(true), flightInformationList: z.array(flightOptionSchema).max(100) }).parse(raw);
  for (const option of v.flightInformationList) {
    if (option.fromSegments[0]!.depTime.slice(0, 10) !== input.fromDate
      || input.tripType === 'ROUND_TRIP' && (!option.retSegments || option.retSegments[0]!.depTime.slice(0, 10) !== input.retDate)
      || input.tripType === 'ONE_WAY' && option.retSegments) throw new Error('FLIGHT_DATES_CHANGED');
  }
  return { kind: 'flights', flights: v.flightInformationList };
}
