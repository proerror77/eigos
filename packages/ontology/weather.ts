import { z } from 'zod';
import { weatherResult } from './maps.js';
import { json, time } from './service-contracts.js';
import type { OntologyDocument } from './schema.js';

const label = z.string().trim().min(1).max(120);
const temperatureC = z.number().min(-120).max(80);
const mode = z.enum(['current', 'forecast']);
export const namedWeatherInput = z.strictObject({
  city: label, province: label.optional(), mode: mode.optional(),
});
const qweather = {
  provider: z.literal('QWeather'), city: label, province: label.optional(),
  fetchedAt: time, attributions: z.array(z.string().min(1).max(500)).min(1).max(20),
};
export const qweatherResult = z.discriminatedUnion('kind', [
  z.strictObject({
    ...qweather, kind: z.literal('current'), validAt: time, condition: label, temperatureC,
    humidityPct: z.number().min(0).max(100).optional(),
  }),
  z.strictObject({
    ...qweather, kind: z.literal('forecast'),
    days: z.array(z.strictObject({
      date: z.iso.date(), daytime: label, nighttime: label,
      maxTemperatureC: temperatureC, minTemperatureC: temperatureC,
    })).min(1).max(4),
  }),
]);

const outcome = <T extends 'Amap' | 'QWeather', S extends z.ZodType>(provider: T, weather: S) => z.union([
  z.strictObject({ provider: z.literal(provider), status: z.literal('available'), weather }),
  z.strictObject({
    provider: z.literal(provider),
    status: z.enum(['authorization_required', 'unavailable', 'location_unconfirmed']),
  }),
]);
export const comparedWeatherResult = z.strictObject({
  city: label, province: label.optional(), mode,
  locationAgreement: z.enum(['same', 'different', 'unconfirmed']),
  sources: z.tuple([outcome('Amap', weatherResult), outcome('QWeather', qweatherResult)]),
});

export const weatherFunctions: OntologyDocument['functionTypes'] = [
  { apiName: 'readComparedWeather', parameters: json(namedWeatherInput), returns: json(comparedWeatherResult),
    dependencies: {},
    description: 'Default weather query for a named city or district in China. Read Amap and QWeather concurrently. Return each source with its time, conditions, and outcome; preserve disagreement and partial availability.' },
  { apiName: 'readQWeather', source: 'QWeather', parameters: json(namedWeatherInput), returns: json(qweatherResult),
    dependencies: {},
    description: 'Read current weather or a forecast from QWeather for a named city or district in China. Prefer readComparedWeather for ordinary weather requests.' },
];
