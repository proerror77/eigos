import { z } from 'zod';
import { adcode, gcjPoint, mapAddress } from './maps.js';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

const label = z.string().trim().min(1).max(250);
const metric = z.number().int().nonnegative();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const endpoint = z.union([
  z.strictObject({ point: gcjPoint, name: label.optional(), cityCode: adcode.optional() }),
  z.strictObject({ place: objectRefSchema, cityCode: adcode.optional() }),
]);
export const amapRouteInput = z.strictObject({
  origin: endpoint, destination: endpoint, mode: z.enum(['walking', 'driving', 'bicycling', 'transit']),
});
export const amapDistanceInput = z.strictObject({
  origins: z.array(endpoint).min(1).max(10), destination: endpoint,
  mode: z.enum(['straight', 'driving', 'walking']),
});
export const amapTrafficInput = z.strictObject({
  southwest: gcjPoint, northeast: gcjPoint, level: z.number().int().min(1).max(6).default(5),
});
export const amapGeocodeInput = mapAddress;
export const amapPointType = 'AmapQueryPoint';
export const amapRouteOptionType = 'AmapRouteOption';
export const amapDistanceLegType = 'AmapDistanceLeg';
export const amapAreaType = 'AmapTrafficArea';

const display = { id: hash, name: label };
export const amapPointRecord = z.strictObject({
  ...display, point: gcjPoint, cityCode: adcode.optional(), address: label.optional(),
  evidence: z.enum(['caller_provided', 'amap_geocode']),
});
export const amapRouteOptionRecord = z.strictObject({
  ...display, rank: metric, distanceMeters: metric, durationSeconds: metric,
  lines: z.array(label).max(20).optional(),
});
export const amapDistanceLegRecord = z.strictObject({
  ...display, originIndex: metric, distanceMeters: metric, durationSeconds: metric.nullable(),
});
export const amapTrafficAreaRecord = z.strictObject({ ...display, southwest: gcjPoint, northeast: gcjPoint });
const actionResult = {
  ...display, provider: z.literal('Amap'), observedAt: time, inputDigest: hash, resultDigest: hash,
};
export const amapRouteRecord = z.strictObject({ ...actionResult, mode: amapRouteInput.shape.mode });
export const amapDistanceRecord = z.strictObject({ ...actionResult, mode: amapDistanceInput.shape.mode });
export const amapTrafficRecord = z.strictObject({
  ...actionResult, status: z.enum(['unknown', 'clear', 'slow', 'congested']),
  description: z.string().max(2000).nullable(), roadCount: metric,
});
export const amapGeocodeRecord = z.strictObject({ ...actionResult });
export const amapObservationRef = z.strictObject({ observation: objectRefSchema });
const pointResult = amapPointRecord.extend({ ref: objectRefSchema });
export const amapObservationResult = z.discriminatedUnion('kind', [
  amapObservationRef.extend({ kind: z.literal('route'), data: amapRouteRecord, origin: pointResult,
    destination: pointResult, options: z.array(amapRouteOptionRecord).max(5) }),
  amapObservationRef.extend({ kind: z.literal('distance'), data: amapDistanceRecord, destination: pointResult,
    legs: z.array(amapDistanceLegRecord.extend({ origin: pointResult })).max(10) }),
  amapObservationRef.extend({ kind: z.literal('traffic'), data: amapTrafficRecord, area: amapTrafficAreaRecord }),
  amapObservationRef.extend({ kind: z.literal('geocode'), data: amapGeocodeRecord, candidates: z.array(pointResult).max(20) }),
]);

export const amapObservations = {
  route: { type: 'AmapRouteObservation', iface: 'MapRoutePlanning', action: 'PlanAmapRoute', alias: 'plan',
    fn: 'planAmapRoute', input: amapRouteInput, record: amapRouteRecord, description: 'Plan walking, driving, cycling or transit between exact points and link the supplier alternatives.' },
  distance: { type: 'AmapDistanceObservation', iface: 'MapDistanceMeasurement', action: 'MeasureAmapDistances', alias: 'measure',
    fn: 'measureAmapDistances', input: amapDistanceInput, record: amapDistanceRecord, description: 'Measure how far several known points are from the same destination.' },
  traffic: { type: 'AmapTrafficObservation', iface: 'MapTrafficInspection', action: 'InspectAmapTraffic', alias: 'inspect',
    fn: 'inspectAmapTraffic', input: amapTrafficInput, record: amapTrafficRecord, description: 'Read a bounded rectangle’s traffic condition from Amap.' },
  geocode: { type: 'AmapGeocodeObservation', iface: 'MapAddressResolution', action: 'ResolveAmapAddress', alias: 'geocode',
    fn: 'resolveAmapAddress', input: amapGeocodeInput, record: amapGeocodeRecord, description: 'Find and link candidate points for an address without choosing a candidate on the caller’s behalf.' },
} as const;

const families = Object.values(amapObservations);
export const amapObservationLinks = {
  routeOrigin: 'AmapRouteOrigin', routeDestination: 'AmapRouteDestination', routeOptions: 'AmapRouteOptions',
  distanceDestination: 'AmapDistanceDestination', distanceLegs: 'AmapDistanceLegs', legOrigin: 'AmapDistanceLegOrigin',
  trafficArea: 'AmapTrafficSurveyArea', geocodeCandidates: 'AmapGeocodeCandidates',
} as const;
const { route, distance, traffic, geocode } = amapObservations;
const link = (apiName: string, from: string, name: string, target: string, reverse: string, cardinality: 'one' | 'many' = 'one') => ({
  apiName, description: `The ${name} of this Amap observation.`,
  from: { type: from, name, cardinality }, to: { type: target, name: reverse, cardinality: 'many' as const },
});
const links = [
  link(amapObservationLinks.routeOrigin, route.type, 'origin', amapPointType, 'routeOrigins'),
  link(amapObservationLinks.routeDestination, route.type, 'destination', amapPointType, 'routeDestinations'),
  link(amapObservationLinks.routeOptions, route.type, 'options', amapRouteOptionType, 'routeObservations', 'many'),
  link(amapObservationLinks.distanceDestination, distance.type, 'destination', amapPointType, 'distanceDestinations'),
  link(amapObservationLinks.distanceLegs, distance.type, 'legs', amapDistanceLegType, 'distanceObservations', 'many'),
  link(amapObservationLinks.legOrigin, amapDistanceLegType, 'origin', amapPointType, 'distanceOrigins'),
  link(amapObservationLinks.trafficArea, traffic.type, 'area', amapAreaType, 'trafficObservations'),
  link(amapObservationLinks.geocodeCandidates, geocode.type, 'candidates', amapPointType, 'geocodes', 'many'),
];
const properties = (shape: z.ZodRawShape) => Object.fromEntries(Object.entries(shape).map(([key, value]) =>
  [key, { description: key, schema: json(value as z.ZodType), required: !(value as z.ZodType).isOptional() }]));
const object = (apiName: string, displayName: string, schema: z.ZodObject, description = displayName) => ({
  apiName, displayName, description, primaryKey: 'id', titleProperty: 'name', properties: properties(schema.shape), interfaces: {},
});
const objectTypes = [
  object(amapPointType, '高德地点坐标', amapPointRecord),
  object(amapRouteOptionType, '高德路线方案', amapRouteOptionRecord),
  object(amapDistanceLegType, '高德距离测量结果', amapDistanceLegRecord),
  object(amapAreaType, '高德路况查询区域', amapTrafficAreaRecord),
  ...families.map(item => ({
    ...object(item.type, item.action, item.record, item.description),
    interfaces: { [item.iface]: { properties: { name: 'name' },
      links: Object.fromEntries(links.filter(link => link.from.type === item.type).map(link => [link.from.name, link.from.name])),
      actions: { [item.alias]: { action: item.action, parameters: Object.fromEntries(Object.keys(item.input.shape).map(key => [key, key])) } },
    } },
  })),
];
const dependencies = { objectTypes: objectTypes.map(type => type.apiName), linkTypes: links.map(link => link.apiName) };
export const amapObservationDefinition: Pick<OntologyDocument, 'objectTypes' | 'interfaceTypes' | 'linkTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes,
  interfaceTypes: families.map(item => ({
    apiName: item.iface, description: item.description, properties: properties({ name: label }), optionalProperties: [],
    links: Object.fromEntries(links.filter(link => link.from.type === item.type).map(link =>
      [link.from.name, { target: link.to.type, cardinality: link.from.cardinality, required: true }])),
    actions: { [item.alias]: { parameters: json(item.input), objectParameters: {}, required: true } },
  })),
  linkTypes: links,
  actionTypes: families.map(item => ({ apiName: item.action, function: item.fn, description: item.description,
    parameters: json(item.input), objectParameters: {}, submissionCriteria: [] })),
  functionTypes: [
    ...families.map(item => ({ apiName: item.fn, source: 'Amap', description: item.description, dependencies,
      parameters: json(item.input), returns: json(objectRefSchema), edits: true })),
    { apiName: 'readAmapObservation', description: 'Read the original Amap observation and its linked points and results.',
      parameters: json(amapObservationRef), returns: json(amapObservationResult), dependencies },
  ],
};
export const amapObservationAccountResources = new Set([
  'Eigos/source/Amap',
  ...amapObservationDefinition.objectTypes.map(type => 'Eigos/object/' + type.apiName),
  ...amapObservationDefinition.functionTypes.map(type => 'Eigos/function/' + type.apiName),
  ...amapObservationDefinition.actionTypes.map(type => 'Eigos/action/' + type.apiName),
]);
