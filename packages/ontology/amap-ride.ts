import { z } from 'zod';
import { privateLocation } from './personal-places.js';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const amapRide = {
  source: 'AmapRide', object: 'AmapRidePlan', interface: 'AmapRideInquiry',
  action: 'EstimateAmapRide', prepare: 'prepareAmapRideEstimate', read: 'readAmapRideEstimate',
} as const;

const placeName = z.string().trim().min(1).max(250);
const cityName = placeName.regex(/^.+(?:市|自治州|地区|盟|县)$/u, 'Use a full Chinese administrative name');
const vehicle = z.enum(['经济', '优享', '商务', '豪华', '专车', '特惠', '出租车', '无人车', '顺风车', '拼车']);
export const amapRideInput = z.strictObject({
  origin: placeName, originCity: cityName, destination: placeName, destinationCity: cityName,
  vehicleTypes: z.array(vehicle).max(10).optional(),
});
export const amapRidePlanRef = z.strictObject({ plan: objectRefSchema });

const location = z.strictObject({ name: placeName, address: z.string().max(600).optional() });
const minor = z.number().int().nonnegative();
export const amapRidePlanData = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('quoted'), pickup: location, dropoff: location, currency: z.literal('CNY'),
    offers: z.array(z.strictObject({ vehicle: placeName, minMinor: minor, maxMinor: minor })).min(1).max(50) }),
  z.strictObject({ status: z.literal('place_required'), side: z.enum(['origin', 'destination']),
    candidates: z.array(location.required()).min(1).max(30) }),
  z.strictObject({ status: z.literal('no_quote'), message: z.string().min(1).max(2000) }),
]);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const amapRidePlanRecord = z.strictObject({
  id: hash, name: placeName, provider: z.literal('Amap'), observedAt: time,
  input: amapRideInput, inputDigest: hash, resultDigest: hash,
  evidence: z.enum(['live_readonly', 'provider_mock']), result: amapRidePlanData,
});
const response = amapRidePlanRef.extend({ observation: amapRidePlanRecord });
const properties = Object.fromEntries(Object.entries(amapRidePlanRecord.shape).map(([key, schema]) =>
  [key, { description: key, schema: json(schema), required: true }]));
const parameters = json(amapRideInput);
const dependencies = { objectTypes: [amapRide.object] };
const description = 'Get current fare ranges for named endpoints from Amap Ride. Return place choices if the pickup or destination is ambiguous. No order or payment.';

export const amapRideDefinition = {
  objectTypes: [{
    apiName: amapRide.object, displayName: '高德打车估价', description, primaryKey: 'id', titleProperty: 'name',
    classification: privateLocation, properties, interfaces: {
      [amapRide.interface]: { properties: { name: 'name' }, links: {}, actions: {
        estimate: { action: amapRide.action, parameters: Object.fromEntries(Object.keys(amapRideInput.shape).map(key => [key, key])) },
      } },
    },
  }],
  interfaceTypes: [{
    apiName: amapRide.interface, description, properties: { name: properties.name! }, optionalProperties: [], links: {},
    actions: { estimate: { parameters, objectParameters: {}, required: true } },
  }],
  functionTypes: [{
    apiName: amapRide.prepare, description, source: amapRide.source, parameters,
    returns: json(objectRefSchema), edits: true, dependencies,
  }, {
    apiName: amapRide.read, description: 'Read the same Amap fare observation, including the source time and any location choices.',
    parameters: json(amapRidePlanRef), returns: json(response), dependencies,
  }],
  actionTypes: [{ apiName: amapRide.action, description, parameters, objectParameters: {}, submissionCriteria: [], function: amapRide.prepare }],
} satisfies Pick<OntologyDocument, 'objectTypes' | 'interfaceTypes' | 'functionTypes' | 'actionTypes'>;

export const amapRideAccountResources = new Set([
  'Eigos/source/' + amapRide.source, 'Eigos/object/' + amapRide.object,
  'Eigos/action/' + amapRide.action, 'Eigos/function/' + amapRide.prepare, 'Eigos/function/' + amapRide.read,
]);
