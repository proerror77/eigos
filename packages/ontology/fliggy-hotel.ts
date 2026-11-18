import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const fliggyHotelTradeSource = 'FliggyHotelDistribution';
export const fliggyHotelBookingType = 'FliggyHotelBooking';
const id = z.string().regex(/^[1-9]\d{0,29}$/);
const amount = z.number().int().nonnegative().safe();
export const hotelRateInput = z.strictObject({
  standardHotelId: id, checkIn: z.iso.date(), checkOut: z.iso.date(),
});
export const hotelRate = z.strictObject({
  itemId: id, ratePlanId: id, hotelName: z.string(), roomName: z.string(),
  displayAmountMinor: amount, currency: z.literal('CNY'), cancellationDescription: z.string().optional(),
});
export const hotelSelection = hotelRateInput.extend({
  itemId: id, ratePlanId: id,
  arrivalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  checkOutTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  rooms: z.number().int().min(1).max(8),
  adultsPerRoom: z.number().int().min(1).max(4),
  profileId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
});
export const fliggyHotelBookingInput = z.strictObject({ selection: hotelSelection, bookingKey: z.uuid() });
export const fliggyHotelBookingRef = z.strictObject({ booking: objectRefSchema });
export const fliggyHotelBookingApproval = fliggyHotelBookingRef.extend({
  approvedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  amountMinor: amount,
});

const publicFacts = {
  id: z.string(), name: z.string(), selection: hotelSelection,
  outOrderId: z.string(), merchantOrderId: id.nullable(),
  merchantHotelId: id, totalRoomPrice: amount, amountMinor: amount, currency: z.literal('CNY'),
  cancellation: z.object({
    cancel_policy_type: z.number().int(),
    policy_info: z.array(z.object({ hour: z.number().optional(), value: z.number().optional() })).optional(),
  }),
  approvalDigest: z.string(), expiresAt: time, observedAt: time,
  state: z.enum(['previewed', 'awaiting_payment', 'pending_confirmation', 'confirmed', 'completed',
    'refund_pending', 'refund_rejected', 'closed', 'cancelled', 'unknown']),
  evidence: z.enum(['synthetic', 'provider']),
  independentRead: z.boolean(),
};
export const fliggyHotelPublic = z.object(publicFacts);
const storedFacts = { ...publicFacts, authority: z.string(), profileDigest: z.string() };
export const fliggyHotelBooking = z.object(storedFacts);

export const hotelBookingActions = [
  ['PrepareFliggyHotelBooking', 'prepareFliggyHotelBooking', fliggyHotelBookingInput,
    'Validate an exact Fliggy distribution hotel rate and record the payable total and cancellation terms.'],
  ['CreateFliggyHotelBooking', 'createFliggyHotelBooking', fliggyHotelBookingApproval,
    'Create the reviewed booking with one stable distributor order number, after explicit PA approval.'],
  ['RefreshFliggyHotelBooking', 'refreshFliggyHotelBooking', fliggyHotelBookingRef,
    'Independently read or reconcile the original order by distributor order number.'],
  ['ConfirmFliggyHotelPayment', 'confirmFliggyHotelPayment', fliggyHotelBookingApproval,
    'Notify Fliggy of independently recorded buyer payment for the original hotel order.'],
  ['CancelFliggyHotelBooking', 'cancelFliggyHotelBooking', fliggyHotelBookingApproval,
    'Cancel the original hotel order if its reviewed policy allows free cancellation.'],
] as const;
export const fliggyHotelDefinition: Pick<OntologyDocument, 'objectTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: [{
    apiName: fliggyHotelBookingType, displayName: 'Fliggy hotel booking',
    description: 'An exact distribution rate, purchaser approval and independently read original order state.',
    primaryKey: 'id', titleProperty: 'name', interfaces: {},
    properties: {
      ...Object.fromEntries(Object.entries(storedFacts).map(([name, schema]) =>
        [name, { description: name, required: true, schema: json(schema) }])),
      cancellationObservation: { description: 'Outcome of bounded original-order cancellation checks, independent of refund settlement.',
        required: false, schema: { type: 'string', enum: ['watching', 'finished', 'source_unavailable', 'timed_out'] } },
    },
  }],
  functionTypes: [
    ...hotelBookingActions.map(([, apiName, input, description]) => ({
      apiName, description, parameters: json(input), returns: json(objectRefSchema), edits: true,
      source: fliggyHotelTradeSource, dependencies: { objectTypes: [fliggyHotelBookingType] },
    })),
    { apiName: 'readFliggyHotelRates', description: 'Read distribution hotel rooms, item IDs and rate-plan IDs for one exact standard hotel ID and stay.',
      parameters: json(hotelRateInput), returns: json(z.object({ rates: z.array(hotelRate).max(20), complete: z.literal(false) })),
      source: fliggyHotelTradeSource, dependencies: {} },
    { apiName: 'readFliggyHotelBooking', description: 'Read the hotel preview or original order without exposing guest details.',
      parameters: json(fliggyHotelBookingRef), returns: json(fliggyHotelPublic),
      source: fliggyHotelTradeSource, dependencies: { objectTypes: [fliggyHotelBookingType] } },
  ],
  actionTypes: hotelBookingActions.map(([apiName, fn, input, description]) => ({
    apiName, description, parameters: json(input), function: fn,
    objectParameters: ('booking' in input.shape ? { booking: fliggyHotelBookingType } : {}) as Record<string, string>,
    ...(apiName === 'RefreshFliggyHotelBooking' ? { typeClasses: [{kind:'observation',name:'readback'}] } : {}),
    submissionCriteria: [],
  })),
};
