import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const petRideType = 'PetRideHandoff';
export const petRideSource = 'DidiPetRideSandbox';
const text = z.string().trim().min(1).max(240);
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const environment = z.literal('synthetic');
const vehicle = z.enum(['pet_premier', 'pet_express']);
export const petRideTerms = z.strictObject({
  environment,
  city: text,
  pickup: text,
  destination: text,
  pets: z.array(z.strictObject({
    species: text,
    weightKg: z.number().positive().max(150),
    carrier: z.boolean(),
  })).min(1).max(4),
  vehicle,
});

export const petRideRef = z.strictObject({ handoff: objectRefSchema });
export const petRidePA = {
  quote: 'pet_ride.synthetic.quote',
  approve: 'pet_ride.synthetic.approve',
  submit: 'pet_ride.synthetic.submit',
  lookup: 'pet_ride.synthetic.lookup',
} as const;

const identity = { evidence: environment, reference: checksum };
export const petRideQuote = z.strictObject({
  ...identity,
  status: z.literal('available'),
  termsDigest: checksum,
  vehicle,
  estimateMinor: z.string().regex(/^(0|[1-9][0-9]{0,9})$/),
  currency: z.literal('CNY'),
  observedAt: time,
  expiresAt: time,
});
export const petRideQuoteReply = z.discriminatedUnion('status', [
  petRideQuote,
  z.strictObject({ ...identity, status: z.literal('unavailable'), termsDigest: checksum }),
]);
export const petRideApproval = z.strictObject({
  ...identity, quoteDigest: checksum, decision: z.enum(['approve', 'decline']),
});
export const petRideSubmitReply = z.strictObject({
  ...identity, quoteDigest: checksum, status: z.enum(['submitted', 'unknown']), orderId: text.optional(),
});
export const petRideReceipt = z.strictObject({
  ...identity,
  quoteDigest: checksum,
  orderId: text,
  orderState: z.enum(['matching', 'driver_assigned', 'driver_arrived', 'in_trip', 'completed', 'canceled']),
  observedAt: time,
  verifiedBy: z.literal('original-order-lookup'),
});
export const petRideLookupReply = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('found'), receipt: petRideReceipt }),
  z.strictObject({ ...identity, status: z.literal('unresolved'), quoteDigest: checksum }),
]);
export const petRideData = z.strictObject({
  id: checksum,
  name: text,
  sourceTaskId: z.uuid(),
  terms: petRideTerms,
  state: z.enum(['prepared', 'unavailable', 'declined', 'expired', 'unknown', 'recorded']),
  quote: petRideQuote.nullable(),
  submittedOrderId: text.nullable(),
  receipt: petRideReceipt.nullable(),
});

const properties = Object.fromEntries(Object.entries(petRideData.shape).map(([field, schema]) =>
  [field, { description: field, schema: json(schema), required: true }]));
export const petRideDefinition: Pick<OntologyDocument, 'objectTypes' | 'interfaceTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: [{
    apiName: petRideType,
    displayName: '携宠出行测试',
    description: 'A synthetic PA ride handoff with exact terms and independently read original order evidence.',
    primaryKey: 'id',
    titleProperty: 'name',
    interfaces: { PetRide: { properties: { state: 'state' }, links: {},
      actions: { recordReceipt: { action: 'RecordPetRideReceipt', parameters: { handoff: 'handoff' } } } } },
    properties,
  }],
  interfaceTypes: [{
    apiName: 'PetRide',
    description: 'A pet ride tested through the original PA, with an independently observed order outcome.',
    properties: { state: properties.state! },
    optionalProperties: [],
    links: {},
    actions: { recordReceipt: { parameters: json(petRideRef), objectParameters: { handoff: 'PetRide' }, required: true } },
  }],
  actionTypes: [
    { apiName: 'PreparePetRideHandoff', description: 'Record exact pet and route terms on the original PA task for an explicitly requested synthetic trial.',
      parameters: json(petRideTerms), objectParameters: {}, function: 'preparePetRideHandoff', submissionCriteria: [] },
    { apiName: 'RecordPetRideReceipt', description: 'In a synthetic trial obtain the PA quote, wait for approval, submit once and read back the original test order. When state is unknown, only reconcile the original order.',
      parameters: json(petRideRef), objectParameters: { handoff: petRideType }, function: 'recordPetRideReceipt', submissionCriteria: [] },
  ],
  functionTypes: [
    { apiName: 'preparePetRideHandoff', description: 'Prepare one synthetic handoff on the original PA task.',
      parameters: json(petRideTerms), returns: json(objectRefSchema), edits: true, source: petRideSource,
      dependencies: { objectTypes: [petRideType] } },
    { apiName: 'recordPetRideReceipt', description: 'Record the original PA test order after exact quote approval and independent readback.',
      parameters: json(petRideRef), returns: json(objectRefSchema), edits: true, source: petRideSource,
      dependencies: { objectTypes: [petRideType] } },
    { apiName: 'readPetRideHandoff', description: 'Read the synthetic handoff, quote, and original order evidence.',
      parameters: json(petRideRef), returns: json(petRideData), dependencies: { objectTypes: [petRideType] } },
  ],
};
