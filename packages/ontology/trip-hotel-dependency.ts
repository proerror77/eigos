import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const hotelBookingType = 'FliggyHotelBooking';
export const hotelCancellationLog = 'FliggyHotelBookingStateLog';
export const hotelDependencyLink = 'TripHotelBooking';
export const tripHotelReviewType = 'TripHotelDependencyReview';
export const tripHotelCurrent = 'tripHotelDependencyIsCurrent';

export const bindTripHotelInput = z.strictObject({
  trip: objectRefSchema, plan: objectRefSchema, booking: objectRefSchema, revision: z.number().int().positive(),
});
export const reviewTripHotelInput = z.strictObject({
  trip: objectRefSchema, booking: objectRefSchema, transition: objectRefSchema,
});
export const replanTripHotelInput = z.strictObject({
  trip: objectRefSchema, dependencyReview: objectRefSchema, travel: objectRefSchema, revision: z.number().int().positive(),
});

const reviewProperties = {
  id: z.string(), name: z.string(), reviewedAt: time, transition: objectRefSchema,
  orderState: z.enum(['not_submitted', 'original_order', 'dispatch_unresolved']),
  readback: z.enum(['not_needed', 'verified', 'unavailable', 'original_identity_required']),
  requiresAuthorization: z.boolean(), suspendedScheduleId: z.string().optional(),
  authorizationState: z.enum(['not_required', 'awaiting_authorization', 'awaiting_original_order', 'authorized', 'superseded']),
  plannedTripRevision: z.number().int().positive().optional(),
  authorizationRequestId: z.string().optional(),
};

export const tripHotelDependencyDefinition: Pick<OntologyDocument, 'objectTypes' | 'linkTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: [{
    apiName: tripHotelReviewType, displayName: '接送依赖复核',
    description: 'Disposition of an existing trip after a confirmed change to its hotel booking.',
    primaryKey: 'id', titleProperty: 'name', interfaces: {},
    properties: Object.fromEntries(Object.entries(reviewProperties).map(([name, schema]) =>
      [name, { description: name, required: !schema.isOptional(), schema: json(schema) }])),
  }],
  linkTypes: [
    {
      apiName: hotelDependencyLink, description: 'The original booking on which this trip depends.',
      from: { type: 'EventTrip', name: 'hotelBooking', cardinality: 'one' },
      to: { type: hotelBookingType, name: 'dependentTrips', cardinality: 'many' },
    },
    {
      apiName: 'TripHotelReviewPlan', description: 'Original plan on which the review was recorded.',
      from: { type: tripHotelReviewType, name: 'plan', cardinality: 'one' },
      to: { type: 'SchedulePlan', name: 'hotelDependencyReviews', cardinality: 'many' },
    },
    {
      apiName: 'TripHotelReviewTrip', description: 'The affected trip.',
      from: { type: tripHotelReviewType, name: 'trip', cardinality: 'one' },
      to: { type: 'EventTrip', name: 'hotelDependencyReviews', cardinality: 'many' },
    },
    {
      apiName: 'TripHotelReviewBooking', description: 'The original booking whose committed transition triggered the review.',
      from: { type: tripHotelReviewType, name: 'booking', cardinality: 'one' },
      to: { type: hotelBookingType, name: 'tripDependencyReviews', cardinality: 'many' },
    },
    {
      apiName: 'TripHotelReviewOrder', description: 'The original ride order, when identified.',
      from: { type: tripHotelReviewType, name: 'order', cardinality: 'one' },
      to: { type: 'DidiRideOrder', name: 'hotelDependencyReviews', cardinality: 'many' },
    },
  ],
  functionTypes: [{
    apiName: tripHotelCurrent, description: 'Check the current booking that an original trip depends on.',
    parameters: json(z.strictObject({ trip: objectRefSchema })), returns: json(z.boolean()),
    dependencies: { objectTypes: ['EventTrip', hotelBookingType], linkTypes: [hotelDependencyLink] },
  }, {
    apiName: 'bindTripHotelBooking', description: 'Declare the approved booking dependency of one original plan and trip.',
    parameters: json(bindTripHotelInput), returns: json(objectRefSchema), edits: true,
    dependencies: { objectTypes: ['EventTrip', 'SchedulePlan', hotelBookingType], linkTypes: ['TripPlan', hotelDependencyLink] },
  }, {
    apiName: 'replanTripHotelDependency', description: 'Revalidate travel timing on the original affected trip before renewed approval.',
    parameters: json(replanTripHotelInput), returns: json(objectRefSchema), edits: true,
    dependencies: {
      objectTypes: ['EventTrip', 'SchedulePlan', tripHotelReviewType],
      interfaceTypes: ['DrivingEstimate'],
      linkTypes: [hotelDependencyLink, 'TripPlan', 'TripTravel', 'TripEvent', 'TripActivities', 'TripHotelReviewTrip'],
    },
  }, {
    apiName: 'reviewTripHotelDependency', source: 'Didi', description: 'Recheck original ride execution and hold a stale pending dispatch.',
    parameters: json(reviewTripHotelInput), returns: json(objectRefSchema), edits: true,
    dependencies: {
      objectTypes: [tripHotelReviewType, 'EventTrip', 'SchedulePlan', 'DidiRideOrder', hotelBookingType, hotelCancellationLog],
      linkTypes: [hotelDependencyLink, 'TripPlan', 'TripOrder', 'TripHotelReviewPlan', 'TripHotelReviewTrip',
        'TripHotelReviewBooking', 'TripHotelReviewOrder'],
    },
  }],
  actionTypes: [{
    apiName: 'BindTripHotelBooking', description: 'Bind the original hotel booking that the trip depends on.',
    parameters: json(bindTripHotelInput),
    objectParameters: { trip: 'EventTrip', plan: 'SchedulePlan', booking: hotelBookingType },
    submissionCriteria: [], function: 'bindTripHotelBooking',
  }, {
    apiName: 'ReplanTripHotelDependency', description: 'Update the original trip using a fresh route and the current schedule constraints.',
    parameters: json(replanTripHotelInput),
    objectParameters: { trip: 'EventTrip', travel: 'DrivingEstimate', dependencyReview: tripHotelReviewType },
    submissionCriteria: [{
      function: tripHotelCurrent, arguments: { trip: { parameter: 'trip' } },
      message: 'Bind a currently confirmed hotel booking before replanning',
    }], function: 'replanTripHotelDependency',
  }, {
    apiName: 'ReviewTripHotelDependency', description: 'Record the impact of a confirmed hotel cancellation on this trip.',
    parameters: json(reviewTripHotelInput),
    objectParameters: { trip: 'EventTrip', booking: hotelBookingType, transition: hotelCancellationLog },
    submissionCriteria: [], function: 'reviewTripHotelDependency', typeClasses: [{ kind: 'observation', name: 'readback' }],
  }],
};
