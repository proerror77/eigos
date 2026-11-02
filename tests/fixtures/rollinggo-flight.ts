import type { FlightInput, FlightData } from '../../packages/capabilities/rollinggo-flight/contracts.js';
export const flightInput = { kind: 'flights', fromCity: 'SHA', toCity: 'BJS', fromDate: '2099-01-01',
  tripType: 'ONE_WAY', adultNumber: 1, childNumber: 0, cabinGrade: 'ECONOMY' } satisfies FlightInput;
export const flightData: FlightData = { kind: 'flights', flights: [{ fromSegments: [{ flightNumber: 'ZZ101', depAirport: 'PVG', arrAirport: 'PEK',
  depTime: '2099-01-01T08:00:00', arrTime: '2099-01-01T10:00:00', carrierCode: 'ZZ' }], totalAdultPrice: 500, currency: 'CNY' }] };
export const airportData: FlightData = { kind: 'airports', airports: [{ airportCode: 'HGH', airportName: 'Synthetic airport', cityCode: 'HGH', cityName: 'Synthetic city', countryCode: 'CN' }] };
