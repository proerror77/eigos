import { z } from 'zod';
import {
  coordinateSystem, coordinates, requestLocationForService, serviceLocation,
} from './location.js';
import type { OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

const label = z.string().trim().min(1).max(250);
export const adcode = z.string().regex(/^[0-9]{6}$/);
const poiId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const gcjPoint = z.strictObject({ ...coordinates, coordinateSystem: z.literal('gcj02') });
export const mapPoint = z.strictObject({ ...coordinates, coordinateSystem });
export const mapAddress = z.strictObject({ address: label, city: label.optional() });
const area = {
  province: label.optional(), city: label.optional(), district: label.optional(), adcode: adcode.optional(),
};
const source = { provider: z.literal('Amap'), fetchedAt: time };
export const geocodeResult = z.strictObject({
  ...source, candidates: z.array(z.strictObject({
    ...area, level: label.optional(), address: label.optional(), point: gcjPoint,
  })).max(20),
});
export const reverseGeocodeResult = z.strictObject({ ...source, ...area, address: label.optional() });

const place = z.strictObject({ id: poiId, name: label, address: label.optional(), ...area, point: gcjPoint.optional() });
export const mapPlaceResult = z.strictObject({ ...source, places: z.array(place).max(20) });
export const placeDetailInput = z.strictObject({ id: poiId });
export const placeDetailResult = z.strictObject({ ...source, place });

export const mapSearch = z.strictObject({ query: label, city: label.optional() });
const nearby = {
  query: label, radiusMeters: z.number().int().min(100).max(5000).optional(),
};
export const nearbySearch = z.union([
  mapPoint.extend(nearby),
  serviceLocation.extend(nearby),
  requestLocationForService.extend(nearby),
]);
const routeEnd = z.union([mapPoint, mapAddress]);
export const mapRouteInput = z.strictObject({
  mode: z.enum(['walking', 'driving']),
  origin: z.union([routeEnd, serviceLocation, requestLocationForService]).optional(),
  destination: routeEnd,
});
export const mapRouteResult = z.strictObject({
  ...source, mode: mapRouteInput.shape.mode,
  routes: z.array(z.strictObject({
    distanceMeters: z.number().int().nonnegative(), durationSeconds: z.number().int().nonnegative(),
  })).min(1).max(5),
});

const weatherOptions = { mode: z.enum(['current', 'forecast']).optional() };
export const weatherInput = z.union([
  z.strictObject({ city: label, ...weatherOptions }),
  z.strictObject({ adcode, ...weatherOptions }),
  mapPoint.extend(weatherOptions),
  serviceLocation.extend(weatherOptions),
  requestLocationForService.extend(weatherOptions),
]);
const temperature = z.number().min(-120).max(80);
export const weatherResult = z.discriminatedUnion('kind', [
  z.strictObject({
    ...source, ...area, kind: z.literal('current'), reportedAt: time,
    condition: label, temperatureC: temperature, windDirection: label.optional(),
    windForce: label.optional(), humidityPct: z.number().min(0).max(100).optional(),
  }),
  z.strictObject({
    ...source, ...area, kind: z.literal('forecast'), reportedAt: time.optional(),
    days: z.array(z.strictObject({
      date: z.iso.date(), daytime: label, nighttime: label,
      daytimeTemperatureC: temperature,
      nighttimeTemperatureC: temperature,
    })).min(1).max(4),
  }),
]);

const locationDependencies = { functions: ['resolveTaskLocation'] };
export const mapFunctions: OntologyDocument['functionTypes'] = [
  { apiName: 'geocodeAddress', parameters: json(mapAddress), returns: json(geocodeResult), dependencies: {},
    description: 'Find Amap coordinate candidates for a specified address or landmark and optional city. Retain ambiguity and use the appropriate spatial precision for the task.' },
  { apiName: 'reverseGeocode', parameters: json(mapPoint), returns: json(reverseGeocodeResult), dependencies: {},
    description: 'Read the Amap administrative area for supplied coordinates. Preserve the input coordinate system.' },
  { apiName: 'searchMapPlaces', parameters: json(mapSearch), returns: json(mapPlaceResult), dependencies: {},
    description: 'Search Amap for venues, landmarks or shops by keyword and optional city. Read place detail to obtain coordinates when the search only returns a place ID.' },
  { apiName: 'readMapPlace', parameters: json(placeDetailInput), returns: json(placeDetailResult), dependencies: {},
    description: 'Read details for a place ID returned by Amap search.' },
  { apiName: 'searchNearbyPlaces', parameters: json(nearbySearch), returns: json(mapPlaceResult), dependencies: locationDependencies,
    description: 'Find nearby Amap venues by keyword around an explicit point or a specified or planned place. Omitting the point asks the original PA for the current device location.' },
  { apiName: 'estimateMapRoute', parameters: json(mapRouteInput), returns: json(mapRouteResult), dependencies: locationDependencies,
    description: 'Estimate Amap walking or driving distance and travel time between named addresses or coordinates. Omit origin only for a route from the user’s current location.' },
  { apiName: 'readWeather', parameters: json(weatherInput), returns: json(weatherResult), dependencies: locationDependencies,
    description: 'Read live conditions (mode current) or the daily forecast (mode forecast, default) for a city, district code, explicit point or planned place. Omit location only for weather where the user is now. Forecasts cover today and the next three days when provided.' },
].map(definition => ({ ...definition, source: 'Amap' }));
