import { z } from 'zod';
import { objectRefSchema as ref, type OntologyDocument } from './schema.js';
import { itineraryAssessment, itineraryAutomation, itineraryManualHandoff, itineraryPlanEdit } from './itinerary-continuity.js';
import { json, time } from './service-contracts.js';

export const calendarJourneyPlanLink = 'CalendarJourneyPlan';
export const attachCalendarJourneyInput = z.strictObject({
  plan: ref, journey: ref, revision: z.number().int().positive(),
});
export const scheduleJourneyInput = z.strictObject({ plan: ref });
const linkedObject = z.object({ ref, revision: z.number().int().positive(), properties: z.record(z.string(), z.unknown()) });
const namedRef = z.object({ ref, name: z.string().optional() });
const overview = z.object({
  plan: namedRef.extend({ revision: z.number().int().positive() }),
  activities: z.array(linkedObject),
  calendarAvailability: z.array(z.object({
    ref, evidence: z.string().optional(), complete: z.boolean().optional(),
    observedAt: time.optional(), expiresAt: time.optional(),
  })),
  calendarJourneys: z.array(namedRef.extend({ state: z.string().optional(), nextCheckAt: time.nullable().optional() })),
  flightWatches: z.array(namedRef.extend({ state: z.string().optional() })),
  trips: z.array(z.object({ ref, state: z.string().optional() })),
  originalOrders: z.array(namedRef.extend({ state: z.string().nullable(), evidence: z.string().nullable(),
    independentRead: z.boolean().nullable(), canceled: z.boolean() })),
  followups: z.array(z.object({
    ref, revision: z.number().int().positive(), state: z.string().optional(), nextCheckAt: time.nullable().optional(),
    automation: itineraryAutomation.nullable(), assessment: itineraryAssessment.nullable(),
    planEdit: itineraryPlanEdit.nullable(), handoff: itineraryManualHandoff.nullable(),
    history: z.array(linkedObject),
  })),
  hotelReviews: z.array(linkedObject),
  restricted: z.array(z.string()),
});
export const scheduleJourneyDefinition: Pick<OntologyDocument, 'linkTypes' | 'actionTypes' | 'functionTypes'> = {
  linkTypes: [{
    apiName: calendarJourneyPlanLink, description: 'The original plan followed by this calendar journey.',
    from: { type: 'CalendarJourney', name: 'plan', cardinality: 'one' },
    to: { type: 'SchedulePlan', name: 'calendarJourneys', cardinality: 'many' },
  }],
  functionTypes: [{
    apiName: 'attachCalendarJourneyToPlan', description: 'Attach an owned calendar journey to its original plan.',
    parameters: json(attachCalendarJourneyInput), returns: json(ref), edits: true,
    dependencies: { objectTypes: ['SchedulePlan', 'CalendarJourney'], linkTypes: [calendarJourneyPlanLink] },
  }, {
    apiName: 'readScheduleJourney', description: 'Read the linked activities, calendar evidence, original orders and itinerary follow-up from one plan.',
    parameters: json(scheduleJourneyInput), returns: json(overview),
    dependencies: {
      objectTypes: ['SchedulePlan', 'CalendarJourney', 'ScheduledActivity', 'EventTrip', 'ItineraryContinuity',
        'FliggyHotelBooking', 'FliggyFlightBooking', 'DidiRideOrder', 'EventRegistration', 'FlightWatch',
        'TripHotelDependencyReview', 'ItineraryContinuityStateLog', 'CalendarAvailability'],
      linkTypes: [calendarJourneyPlanLink, 'PlanAvailability', 'ActivityPlan', 'TripPlan', 'TripOrder', 'TripRegistration', 'TripHotelBooking',
        'ItineraryContinuityPlan', 'ItineraryContinuityRideOrder', 'ItineraryContinuityHotelBooking', 'ItineraryContinuityFlightBooking',
        'ItineraryContinuityFlightWatch', 'FliggyFlightBookingWatch', 'TripHotelReviewPlan', 'ItineraryContinuityStateLogProcess'],
    },
  }],
  actionTypes: [{
    apiName: 'AttachCalendarJourneyToPlan', description: 'Attach the authorized calendar monitor to the selected original plan.',
    parameters: json(attachCalendarJourneyInput), objectParameters: { plan: 'SchedulePlan', journey: 'CalendarJourney' },
    submissionCriteria: [], function: 'attachCalendarJourneyToPlan',
  }],
};
