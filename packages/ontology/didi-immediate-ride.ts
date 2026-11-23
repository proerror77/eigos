import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { classificationSchema } from './classification.js';
import { json, time } from './service-contracts.js';

export const immediateRideType = 'DidiImmediateRide';
export const immediateRideInterface = 'ImmediateRideBooking';
export const bookImmediateRideAction = 'BookDidiImmediateRide';
export const immediateRideApprovalCapability = 'ride.confirm_immediate_order';
export const immediateOrderLink = 'ImmediateDidiOrder';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const amount = z.string().regex(/^(0|[1-9]\d{0,17})$/);
export const immediateFare = z.strictObject({
  category: z.string().min(1).max(500),
  vehicle: z.string().min(1).max(500),
  amountMinor: amount,
  currency: z.literal('CNY'),
});
export const immediateRideConfirmation = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('cancel'), quoteDigest: digest }),
  z.strictObject({
    decision: z.literal('confirm'), quoteDigest: digest, category: immediateFare.shape.category,
    amountMinor: amount, currency: immediateFare.shape.currency, acceptVariableFinalFare: z.literal(true),
  }),
]);
const location = z.strictObject({
  name: z.string().min(1).max(500), address: z.string().min(1).max(1500), city: z.string().min(1).max(500),
});
export const immediateRideTerms = z.strictObject({
  pickup: location, destination: location, expiresAt: time, fares: z.array(immediateFare).min(1).max(50),
});
export const immediateRideRef = z.strictObject({ ride: objectRefSchema });
const rideState = z.enum(['ordered', 'submitted', 'unknown', 'declined', 'quote_expired', 'price_changed', 'quote_unavailable']);
const order = z.strictObject({
  ref: objectRefSchema, orderId: z.string().min(1).max(500), status: z.string(), independentRead: z.boolean(),
  evidence: z.enum(['live', 'provider_mock', 'synthetic']),
});
export const immediateRideRecord = z.strictObject({
  id: digest, name: z.string(), sourceTaskId: z.uuid(), state: rideState,
  pickup: location.nullable(), destination: location.nullable(), selectedFare: immediateFare.nullable(),
  updatedEstimateMinor: amount.nullable(), sourceAuthority: digest.nullable(),
  locationClassification: classificationSchema.optional(),
});
export const immediateRideResult = immediateRideRecord.omit({ sourceAuthority: true, locationClassification: true }).extend({ order: order.nullable() });

export function didiImmediateRideDefinition(parameters: Record<string, unknown>) {
  const properties = Object.fromEntries(Object.entries(immediateRideRecord.shape).map(([name, shape]) =>
    [name, { description: name, required: !shape.isOptional(), schema: json(shape) }]));
  const scope = { objectTypes: [immediateRideType, 'DidiRideOrder'], linkTypes: [immediateOrderLink] };
  const functionName = 'bookDidiImmediateRide';
  const description = 'Resolve pickup and destination, then book a DiDi ride now only after the authenticated PA confirms an exact available vehicle and fare estimate on this task.';
  return {
    objectTypes: [{
      apiName: immediateRideType, displayName: '滴滴即时叫车', description, primaryKey: 'id', titleProperty: 'name', classificationProperty: 'locationClassification', properties,
      interfaces: { [immediateRideInterface]: { properties: { state: 'state' }, links: {}, actions: {
        book: { action: bookImmediateRideAction, parameters: Object.fromEntries(
          Object.keys(parameters.properties as Record<string, unknown>).map(name => [name, name])),
        },
      } } },
    }],
    interfaceTypes: [{
      apiName: immediateRideInterface, description, properties: { state: properties.state! }, optionalProperties: [],
      links: {}, actions: { book: { parameters, objectParameters: {}, required: true } },
    }],
    linkTypes: [{
      apiName: immediateOrderLink, description: 'Original DiDi order acknowledged for an immediate booking.',
      from: { type: immediateRideType, name: 'order', cardinality: 'one' },
      to: { type: 'DidiRideOrder', name: 'immediateRides', cardinality: 'one' },
    }],
    functionTypes: [{
      apiName: functionName, description, source: 'Didi', edits: true, parameters, returns: json(objectRefSchema),
      dependencies: { ...scope, objectTypes: [...scope.objectTypes, 'Place', 'SourceReceipt'], dataSources: ['DidiPlaces', 'DidiEstimates'],
        functions: ['resolveRideLocations', 'resolveRidePickup', 'searchPlaces', 'estimateLocations'] },
    }, {
      apiName: 'readDidiImmediateRide', description: 'Read the immediate ride booking outcome and original order evidence.',
      parameters: json(immediateRideRef), returns: json(immediateRideResult), dependencies: scope,
    }],
    actionTypes: [{ apiName: bookImmediateRideAction, description, parameters,
      objectParameters: {}, submissionCriteria: [], function: functionName }],
  } satisfies Pick<OntologyDocument,'objectTypes'|'interfaceTypes'|'linkTypes'|'functionTypes'|'actionTypes'>;
}
