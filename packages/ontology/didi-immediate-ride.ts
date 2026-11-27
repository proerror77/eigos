import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { classificationSchema } from './classification.js';
import { json, time } from './service-contracts.js';
import { didiOrderEvidence } from './travel.js';

export const immediateRideType = 'DidiImmediateRide';
export const immediateRideInterface = 'ImmediateRideBooking';
export const reconcileImmediateRideAction = 'ReconcileDidiImmediateRide';
export const reconcileImmediateRideFunction = 'reconcileDidiImmediateRide';
export const bookImmediateRideAction = 'BookDidiImmediateRide';
export const immediateRideApprovalCapability = 'ride.confirm_immediate_order';
export const immediateApprovalLink = 'ImmediateDidiApproval';
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
export const immediateRideState = z.enum(['ordered', 'submitted', 'unknown', 'declined', 'quote_expired', 'price_changed', 'quote_unavailable']);
const order = z.strictObject({
  ref: objectRefSchema, orderId: z.string().min(1).max(500), status: z.string(), independentRead: z.boolean(),
  evidence: didiOrderEvidence,
});
export const immediateRideApproval = z.strictObject({
  quoteDigest: digest, expiresAt: time, requestId: z.string().min(1),
});
export const immediateRideRecord = z.strictObject({
  id: digest, name: z.string(), sourceTaskId: z.uuid(), state: immediateRideState,
  pickup: location.nullable(), destination: location.nullable(), selectedFare: immediateFare.nullable(),
  updatedEstimateMinor: amount.nullable(), sourceAuthority: digest.nullable(),
  locationClassification: classificationSchema.optional(),
  approvedQuote: immediateRideApproval.optional(),
});
export const immediateRideResult = immediateRideRecord.omit({ sourceAuthority: true, locationClassification: true }).extend({ order: order.nullable() });

export function didiImmediateRideDefinition(parameters: Record<string, unknown>):
  Pick<OntologyDocument, 'objectTypes' | 'interfaceTypes' | 'linkTypes' | 'functionTypes' | 'actionTypes'> {
  const properties = Object.fromEntries(Object.entries(immediateRideRecord.shape).map(([name, shape]) =>
    [name, { description: name, required: !shape.isOptional(), schema: json(shape) }]));
  const scope = { objectTypes: [immediateRideType, 'DidiRideOrder'], linkTypes: [immediateOrderLink] };
  const functionName = 'bookDidiImmediateRide';
  const description = 'Resolve pickup and destination, then book a DiDi ride now only after the authenticated PA confirms an exact available vehicle and fare estimate on this task.';
  const reconcileDescription = 'Verify the original DiDi dispatch and update the existing ride from the original receipt and readback.';
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
    }, {
      apiName: reconcileImmediateRideFunction, description: reconcileDescription, source: 'Didi', edits: true,
      parameters: json(immediateRideRef), returns: json(objectRefSchema), dependencies: {
        ...scope, objectTypes: [...scope.objectTypes, 'Route', 'Place', 'PersonalPlaceVersion'],
        linkTypes: [...scope.linkTypes, 'ImmediateRideRoute', 'RouteOrigin', 'RouteDestination',
          'RouteOriginPersonalPlace', 'RouteDestinationPersonalPlace'],
      },
    }],
    actionTypes: [{ apiName: bookImmediateRideAction, description, parameters,
      objectParameters: {}, submissionCriteria: [], function: functionName }, {
      apiName: reconcileImmediateRideAction, description: reconcileDescription,
      parameters: json(immediateRideRef), objectParameters: { ride: immediateRideType }, submissionCriteria: [],
      typeClasses: [{ kind: 'observation', name: 'readback' }], function: reconcileImmediateRideFunction,
    }],
  };
}
