import { z } from 'zod';
import { Conflict } from '../../core/identity.js';
import { type locationSelection, type locationUse } from '../../ontology/location.js';
import {
  adcode, gcjPoint, geocodeResult, mapAddress, mapPlaceResult, mapPoint, mapRouteInput, mapRouteResult,
  mapSearch, nearbySearch, placeDetailInput, placeDetailResult, reverseGeocodeResult, weatherInput, weatherResult,
} from '../../ontology/maps.js';
import { Clarification } from '../../runtime/clarification.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { locationForService } from '../location.js';
import { type AmapClient, type AmapResolver } from './client.js';

const source = z.object({ status: z.literal('1').optional() }).passthrough();
const text = z.string().trim().min(1).max(250);
const fetchTime = () => ({ provider: 'Amap' as const, fetchedAt: new Date().toISOString() });
const asText = (value: unknown) => {
  const result = text.safeParse(value);
  return result.success ? result.data : undefined;
};
const normalizedName = (name: string) => name.normalize('NFKC').replace(/[\s\p{P}]/gu, '').toLowerCase();
const areaName = (name: string) => normalizedName(name).replace(/[市区县省]$/, '');
const preciseLevels = new Set(['道路交叉路口', '兴趣点', '门牌号', '单元号', '公交地铁站点', '门址', '住宅区', '大厦', '建筑物']);
const administrativeArea = (value: Record<string, unknown>) => {
  const code = adcode.safeParse(value.adcode);
  return {
    province: asText(value.province ?? value.provice), city: asText(value.city ?? value.cityname),
    district: asText(value.district ?? value.adname), adcode: code.success ? code.data : undefined,
  };
};
const decimal = z.union([z.number(), z.string().regex(/^-?\d+(?:\.\d+)?$/).transform(Number)]);
const providerPoint = z.string().regex(/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/);
function parsePoint(value: unknown) {
  const [longitude, latitude] = providerPoint.parse(value).split(',').map(Number);
  return gcjPoint.parse({ latitude, longitude, coordinateSystem: 'gcj02' });
}
const pointText = ({ longitude, latitude }: Pick<z.infer<typeof gcjPoint>, 'latitude' | 'longitude'>) =>
  `${Number(longitude.toFixed(6))},${Number(latitude.toFixed(6))}`;
function reportTime(value: unknown) {
  if (value === undefined) return;
  const result = z.iso.datetime({ offset: true }).safeParse(value);
  if (result.success) return result.data;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value))
    throw new Error('Invalid Amap weather publication time');
  return z.iso.datetime({ offset: true }).parse(value.replace(' ', 'T') + '+08:00');
}

function handler(run: FunctionHandler): FunctionHandler {
  return async (input, context) => {
    try { return await run(input, context); }
    catch (error) {
      if (error instanceof z.ZodError) throw new Conflict('高德返回的数据格式不受支持。');
      throw error;
    }
  };
}

type Point = z.infer<typeof mapPoint>;
type Address = z.infer<typeof mapAddress>;
type Selection = z.infer<typeof locationSelection>;
type PositionInput = Point | { locationRequestId: string } | { location?: Selection };
const geocodeRow = z.record(z.string(), z.unknown());

export async function toAmapPoint(client: AmapClient, point: Point, signal: AbortSignal) {
  if (point.coordinateSystem === 'gcj02') return gcjPoint.parse(point);
  const response = await client.web('/v3/assistant/coordinate/convert', {
    coordsys: 'gps', locations: pointText(point),
  }, signal);
  return parsePoint(response.locations);
}

async function geocodeRows(client: AmapClient, input: Address, signal: AbortSignal) {
  const payload = source.parse(await client.mcp('maps_geo', {
    address: input.address, ...(input.city ? { city: input.city } : {}),
  }, signal));
  return z.array(geocodeRow).max(20).parse(payload.results ?? payload.return ?? payload.geocodes);
}

function geocodeCandidate(record: z.infer<typeof geocodeRow>) {
  return {
    ...administrativeArea(record), level: asText(record.level), address: asText(record.formatted_address),
    point: parsePoint(record.location),
  };
}

async function uniquePlace(client: AmapClient, input: Address, signal: AbortSignal, needsPoint: boolean) {
  const rows = await geocodeRows(client, input, signal);
  const query = normalizedName(input.address);
  const exact = rows.filter(row => {
    const full = asText(row.formatted_address), street = asText(row.street), number = asText(row.number);
    return (full && normalizedName(full) === query) ||
      (street && number && query.endsWith(normalizedName(street + number)));
  });
  const [first, ...other] = (exact.length ? exact : rows).map(geocodeCandidate);
  const precise = first?.level && normalizedName(first.level);
  const actualCity = first?.city ?? first?.province;
  const wrongCity = input.city && /\p{Script=Han}/u.test(input.city) && actualCity && areaName(actualCity) !== areaName(input.city);
  if (!first || other.length || wrongCity || (needsPoint && (!precise || !preciseLevels.has(precise))))
    throw new Clarification('高德未能唯一匹配所需精度的地点，请补充城市或完整地址。');
  return first;
}

async function pointFor(client: AmapClient, input: PositionInput, context: FunctionContext, use: z.infer<typeof locationUse>) {
  if ('latitude' in input) return toAmapPoint(client, input, context.signal);
  if ('location' in input && input.location && input.location.source !== 'current') {
    return (await uniquePlace(client, { address: input.location.place }, context.signal, true)).point;
  }
  const located = await locationForService(context, input, use, 'gcj02',
    (point, signal) => toAmapPoint(client, point, signal));
  const { position } = located;
  return gcjPoint.parse({ latitude: position.latitude, longitude: position.longitude, coordinateSystem: position.coordinateSystem });
}

function mapPlace(record: unknown) {
  const item = z.record(z.string(), z.unknown()).parse(record);
  return {
    id: item.id, name: item.name, address: asText(item.address), ...administrativeArea(item),
    ...(asText(item.location) ? { point: parsePoint(item.location) } : {}),
  };
}

async function districtAt(client: AmapClient, point: z.infer<typeof gcjPoint>, signal: AbortSignal) {
  const result = await client.web('/v3/geocode/regeo', { location: pointText(point), extensions: 'base' }, signal);
  return z.object({ regeocode: z.object({ addressComponent: z.object({ adcode }) }) }).parse(result).regeocode.addressComponent.adcode;
}

async function weather(client: AmapClient, input: z.infer<typeof weatherInput>, ctx: FunctionContext) {
  const signal = ctx.signal;
  const explicit = 'city' in input ? input.city : undefined;
  let district: string | undefined = 'adcode' in input ? input.adcode : undefined;
  if (explicit && input.mode === 'current') {
    district = (await uniquePlace(client, { address: explicit }, signal, false)).adcode;
    if (!district) throw new Clarification('高德未确认该地区，请提供更完整的城市或区县名。');
  }
  if (!explicit && !district) {
    if ('location' in input && input.location && input.location.source !== 'current') {
      const place = await uniquePlace(client, { address: input.location.place }, signal, false);
      district = place.adcode ?? await districtAt(client, place.point, signal);
    } else {
      district = await districtAt(client, await pointFor(client, input as PositionInput, ctx, 'weather'), signal);
    }
  }
  if (input.mode === 'current') {
    const payload = await client.web('/v3/weather/weatherInfo', { city: district!, extensions: 'base' }, signal);
    const [report] = z.array(z.record(z.string(), z.unknown())).length(1).parse(payload.lives);
    const area = administrativeArea(report!);
    if (area.adcode !== district) throw new Conflict('高德返回了其他地区的天气。');
    const reportedAt = reportTime(report!.reporttime);
    if (!reportedAt) throw new Conflict('高德实况天气未提供发布时间。');
    const ageMs = Date.now() - Date.parse(reportedAt);
    if (ageMs < -300000 || ageMs > 7200000) throw new Conflict('高德实况天气已过期或发布时间异常。');
    return weatherResult.parse({ ...fetchTime(), ...area, kind: 'current', reportedAt,
      condition: report!.weather, temperatureC: decimal.parse(report!.temperature),
      windDirection: asText(report!.winddirection), windForce: asText(report!.windpower),
      humidityPct: asText(report!.humidity) || typeof report!.humidity === 'number' ? decimal.parse(report!.humidity) : undefined,
    });
  }
  const payload = source.parse(await client.mcp('maps_weather', { city: district ?? explicit! }, signal));
  let location = payload, values = z.array(z.record(z.string(), z.unknown())).min(1).max(4).parse(payload.forecasts);
  // The official Node MCP returns city + casts. The HTTP service can also return a forecast envelope.
  if (values.length === 1 && Object.hasOwn(values[0]!, 'casts')) {
    location = source.parse(values[0]);
    values = z.array(z.record(z.string(), z.unknown())).min(1).max(4).parse(location.casts);
  }
  const area = administrativeArea(location);
  if (district && area.adcode && area.adcode !== district)
    throw new Conflict('高德返回了其他地区的预报。');
  if (district && !area.adcode && !area.city) throw new Conflict('高德预报缺少可识别地区。');
  if (explicit && !district && (!area.city || areaName(explicit) !== areaName(area.city)))
    throw new Clarification('高德预报未确认该城市，请提供完整城市名或区县编码。');
  const days = values.map(day => ({
    date: day.date, daytime: day.dayweather, nighttime: day.nightweather,
    daytimeTemperatureC: decimal.parse(day.daytemp), nighttimeTemperatureC: decimal.parse(day.nighttemp),
  }));
  if (new Set(days.map(day => day.date)).size !== days.length) throw new Conflict('高德预报包含重复日期。');
  return weatherResult.parse({ ...fetchTime(), ...area, kind: 'forecast',
    reportedAt: reportTime(location.reporttime), days });
}

export function amapFunctions(resolve: AmapResolver): ReadonlyMap<string, FunctionHandler> {
  const handlers = new Map<string, FunctionHandler>([
    ['geocodeAddress', async (raw, ctx) => {
      const items = await geocodeRows(await resolve(ctx), mapAddress.parse(raw), ctx.signal);
      return geocodeResult.parse({ ...fetchTime(), candidates: items.map(geocodeCandidate) });
    }],
    ['reverseGeocode', async (raw, ctx) => {
      const client = await resolve(ctx);
      const point = await toAmapPoint(client, mapPoint.parse(raw), ctx.signal);
      const result = source.parse(await client.mcp('maps_regeocode', { location: pointText(point) }, ctx.signal));
      const regeo = result.regeocode ? source.parse(result.regeocode) : result;
      const region = regeo.addressComponent ? source.parse(regeo.addressComponent) : regeo;
      const area = administrativeArea(region);
      if (!area.city && !area.district && !area.province && !area.adcode) throw new Conflict('高德未返回该坐标的行政区。');
      return reverseGeocodeResult.parse({ ...fetchTime(), ...area, address: asText(regeo.formatted_address) });
    }],
    ['searchMapPlaces', async (raw, ctx) => {
      const client = await resolve(ctx), { query: keywords, city } = mapSearch.parse(raw);
      const result = source.parse(await client.mcp('maps_text_search', { keywords, ...(city ? { city } : {}) }, ctx.signal));
      const places = z.array(z.unknown()).max(100).parse(result.pois).slice(0, 20).map(mapPlace);
      return mapPlaceResult.parse({ ...fetchTime(), places });
    }],
    ['readMapPlace', async (raw, ctx) => {
      const client = await resolve(ctx), args = placeDetailInput.parse(raw);
      const result = source.parse(await client.mcp('maps_search_detail', args, ctx.signal));
      const place = mapPlace(result.poi ?? result);
      if (place.id !== args.id) throw new Conflict('高德返回了不同的地点。');
      return placeDetailResult.parse({ ...fetchTime(), place });
    }],
    ['searchNearbyPlaces', async (raw, ctx) => {
      const client = await resolve(ctx), input = nearbySearch.parse(raw);
      const point = await pointFor(client, input, ctx, 'nearby_search');
      const result = source.parse(await client.mcp('maps_around_search', {
        keywords: input.query, radius: String(input.radiusMeters ?? 1000), location: pointText(point),
      }, ctx.signal));
      const places = z.array(z.unknown()).max(100).parse(result.pois).slice(0, 20).map(mapPlace);
      return mapPlaceResult.parse({ ...fetchTime(), places });
    }],
    ['estimateMapRoute', async (raw, ctx) => {
      const client = await resolve(ctx), input = mapRouteInput.parse(raw);
      const end = (value: Address | PositionInput) => 'address' in value
        ? uniquePlace(client, value, ctx.signal, true).then(item => item.point)
        : pointFor(client, value, ctx, 'map_route');
      // Resolve a missing origin with the PA before doing an external destination read.
      const origin = await end(input.origin ?? {});
      const destination = await end(input.destination);
      const result = source.parse(await client.mcp(input.mode === 'walking' ? 'maps_direction_walking' : 'maps_direction_driving', {
        origin: pointText(origin), destination: pointText(destination),
      }, ctx.signal));
      const { paths } = z.object({ paths: z.array(z.object({ distance: decimal, duration: decimal })).min(1).max(50) }).parse(result.route ?? result);
      return mapRouteResult.parse({ ...fetchTime(), mode: input.mode, routes: paths.slice(0, 5).map(path => ({
        distanceMeters: Math.round(path.distance), durationSeconds: Math.round(path.duration),
      })) });
    }],
    ['readWeather', async (raw, ctx) => weather(await resolve(ctx), weatherInput.parse(raw), ctx)],
  ]);
  return new Map([...handlers].map(([name, run]) => [name, handler(run)]));
}
