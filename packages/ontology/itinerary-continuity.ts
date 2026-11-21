import { z } from 'zod';
import { objectRefSchema as ref, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const itineraryType = 'ItineraryContinuity';
export const itineraryCheckAction = 'CheckItineraryContinuity';
export const itineraryInput = z.strictObject({ continuity: ref });
const evidence = z.enum(['pa_reported', 'synthetic']);
const place = z.strictObject({ type: z.literal('Place'), id: ref.shape.id });
const observationTime = { observedAt: time, validUntil: time };
export const flightItineraryObservation = z.strictObject({
  ...observationTime, state: z.enum(['expected', 'cancelled']), arrival: time.nullable(), pickup: place,
});
export const hotelItineraryObservation = z.strictObject({
  ...observationTime, state: z.enum(['available', 'cancelled']), latestArrival: time.nullable(), destination: place,
});
export const startItineraryInput = z.strictObject({
  plan: ref, flight: ref, transfer: ref, hotel: ref, pickup: place, destination: place,
  flightWatch: ref.optional(), hotelBooking: ref.optional(), rideOrder: ref.optional(),
  airportExitMinutes: z.number().int().min(0).max(360),
  latestHotelArrival: time, deadline: time, checkEveryMinutes: z.number().int().min(1).max(1440),
});
export const reportItineraryInput = itineraryInput.extend({
  evidence, flight: flightItineraryObservation.optional(), hotel: hotelItineraryObservation.optional(),
}).refine(input => input.flight || input.hotel, 'Provide at least one itinerary observation');
export const itineraryFlightReport = flightItineraryObservation.extend({ evidence });
export const itineraryHotelReport = hotelItineraryObservation.extend({ evidence });
export const bindItinerarySourceInput = itineraryInput.extend({ source: ref, revision: z.number().int().positive() });
export const itineraryAutomation = z.strictObject({
  ruleId: z.uuid(), ruleRevision: z.number().int().positive(), workflowId: z.uuid(),
});
export const itineraryRevisionInput = itineraryInput.extend({ revision: z.number().int().positive() });
export const applyItineraryProposalInput = itineraryRevisionInput.extend({
  assessmentDigest: z.string().regex(/^[a-f0-9]{64}$/), confirmNoActiveRide: z.literal(true),
});
export const itineraryProposalCriterion = 'itineraryTransferProposalIsCurrent';
export const itineraryPlanEdit = z.strictObject({
  assessmentDigest: z.string(), transfer: ref, revision: z.number().int().positive(), appliedAt: time,
  pickup: place, destination: place,
});
export const itineraryRouteInput = itineraryInput.extend({ travel: ref });
export const itinerarySources = z.strictObject({
  flightWatch: ref.optional(), flightBooking: ref.optional(), hotelBooking: ref.optional(), rideOrder: ref.optional(), routeEstimate: ref.optional(),
  originalHotelCheckIn: z.iso.date().optional(),
});
export const acknowledgeItineraryInput = itineraryInput.extend({
  assessmentDigest: z.string().regex(/^[a-f0-9]{64}$/), note: z.string().trim().min(1).max(1000), evidence,
});
export const itineraryAssessment = z.strictObject({
  digest: z.string(), pickupAt: time.nullable(), arrivalAt: time.nullable(),
  pickup: place, destination: place, latestHotelArrival: time.nullable(), orderLinked: z.boolean(),
  flightEvidence: z.enum(['planned', 'pa_reported', 'synthetic', 'provider']),
  hotelEvidence: z.enum(['planned', 'pa_reported', 'synthetic', 'provider']),
  issues: z.array(z.string()), rideOrderState: z.enum(['unrecorded', 'original_active', 'original_cancelled', 'unknown']),
  transferDisposition: z.enum(['keep', 'propose', 'review_original_order', 'verify_route', 'waiting']),
  hotelDisposition: z.enum(['keep', 'confirm_late_arrival', 'verify_booking', 'waiting']),
});
export const itineraryManualHandoff = z.strictObject({
  assessmentDigest: z.string(), note: z.string(), evidence, recordedAt: time,
});
const fields = {
  id: z.string(), name: z.string(), state: z.enum(['watching', 'attention', 'expired', 'stopped']),
  airportExitMinutes: startItineraryInput.shape.airportExitMinutes,
  latestHotelArrival: time, deadline: time, checkEveryMinutes: startItineraryInput.shape.checkEveryMinutes,
  sources: itinerarySources, scheduleId: z.string(), nextCheckAt: time.nullable(), checkedAt: time.nullable(),
  flightObservation: itineraryFlightReport.optional(),
  hotelObservation: itineraryHotelReport.optional(),
  assessment: itineraryAssessment.optional(), handoff: itineraryManualHandoff.optional(),
  automation: itineraryAutomation.optional(), planEdit: itineraryPlanEdit.optional(),
};
const targets = [
  ['ItineraryContinuityPlan', 'plan', 'SchedulePlan', 'itineraryContinuity'],
  ['ItineraryContinuityFlight', 'flight', 'ScheduledActivity', 'flightContinuity'],
  ['ItineraryContinuityTransfer', 'transfer', 'ScheduledActivity', 'transferContinuity'],
  ['ItineraryContinuityHotel', 'hotel', 'ScheduledActivity', 'hotelContinuity'],
  ['ItineraryContinuityPickup', 'pickup', 'Place', 'pickupContinuity'],
  ['ItineraryContinuityDestination', 'destination', 'Place', 'destinationContinuity'],
  ['ItineraryContinuityFlightWatch', 'flightWatch', 'FlightWatch', 'itineraryContinuity'],
  ['ItineraryContinuityHotelBooking', 'hotelBooking', 'FliggyHotelBooking', 'itineraryContinuity'],
  ['ItineraryContinuityRideOrder', 'rideOrder', 'DidiRideOrder', 'itineraryContinuity'],
  ['ItineraryContinuityRoute', 'routeEstimate', 'DidiDrivingEstimate', 'itineraryContinuity'],
] as const;
const operations = [
  ['StartItineraryContinuity', startItineraryInput, 'Follow an original plan with linked flight, hotel and transfer activities.', {
    plan: 'SchedulePlan', flight: 'ScheduledActivity', transfer: 'ScheduledActivity', hotel: 'ScheduledActivity',
    pickup: 'Place', destination: 'Place',
  }],
  [itineraryCheckAction, itineraryInput, 'Reassess the original itinerary and its next deadline using current evidence.'],
  ['ReportItineraryObservations', reportItineraryInput, 'Record PA evidence on an existing flight or hotel activity.'],
  ['EnableItineraryAutomation', itineraryRevisionInput, 'Authorize field-change monitoring on an existing itinerary.'],
  ['ApplyItineraryTransferProposal', applyItineraryProposalInput, 'Approve and update the original internal transfer activity without placing an order.'],
  ['BindItinerarySource', bindItinerarySourceInput, 'Bind original service evidence to the existing itinerary activity.'],
  ['SetItineraryTransferRoute', itineraryRouteInput, 'Bind a fresh route estimate to the exact current pickup and destination.'],
  ['AcknowledgeItineraryHandoff', acknowledgeItineraryInput, 'Record a manual handoff against the exact current assessment.'],
  ['StopItineraryContinuity', itineraryInput, 'Stop future checks on the same itinerary.'],
] as const;
export const itineraryDefinition: Pick<OntologyDocument, 'objectTypes' | 'linkTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: [{
    apiName: itineraryType, displayName: '行程连续跟进', primaryKey: 'id', titleProperty: 'name', interfaces: {},
    description: 'Dependencies, evidence and the current disposition of one inbound transfer on its original schedule.',
    properties: Object.fromEntries(Object.entries(fields).map(([name, schema]) =>
      [name, { description: name, required: !schema.isOptional(), schema: json(schema) }])),
  }],
  linkTypes: [...targets.map<OntologyDocument['linkTypes'][number]>(([apiName, name, type, reverse]) => ({
    apiName, description: 'Itinerary continuity ' + name,
    from: { type: itineraryType, name, cardinality: 'one' },
    to: { type, name: reverse, cardinality: 'many' },
  })), {
    apiName: 'ItineraryContinuityFlightBooking', description: 'Original flight order linked to the same itinerary.',
    from: { type: itineraryType, name: 'flightBooking', cardinality: 'one' as const },
    to: { type: 'FliggyFlightBooking', name: 'itineraryContinuity', cardinality: 'many' as const },
  }],
  functionTypes: [...operations.map(([action, input, description]) => ({
    apiName: action[0]!.toLowerCase() + action.slice(1), description,
    parameters: json(input), returns: json(ref), edits: true,
    dependencies: {
      objectTypes: [itineraryType, ...new Set(targets.map(([, , type]) => type)), 'ScheduleResource', 'CalendarAvailability'],
      linkTypes: ['DrivingOrigin', 'DrivingDestination', 'ActivityPlan', 'ActivityDependency', 'PlanResource', 'PlanAvailability', 'ResourceAvailability', 'ActivityResource',
        ...targets.map(([name]) => name)],
    },
  })), {
    apiName: itineraryProposalCriterion, description: 'Check whether the reviewed transfer proposal is still current.',
    parameters: json(applyItineraryProposalInput), returns: json(z.boolean()), dependencies: { objectTypes: [itineraryType] },
  }],
  actionTypes: operations.map(([apiName, input, description, parameters]) => ({
    apiName, description, parameters: json(input), function: apiName[0]!.toLowerCase() + apiName.slice(1),
    objectParameters: (parameters ?? { continuity: itineraryType }) as Record<string, string>,
    submissionCriteria: apiName === 'ApplyItineraryTransferProposal' ? [{
      function: itineraryProposalCriterion,
      arguments: { continuity: { parameter: 'continuity' }, revision: { parameter: 'revision' },
        assessmentDigest: { parameter: 'assessmentDigest' }, confirmNoActiveRide: { parameter: 'confirmNoActiveRide' } },
      message: 'Approve the latest evaluated itinerary revision',
    }] : [],
  })),
};
