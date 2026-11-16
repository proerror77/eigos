import { z } from 'zod';
import { Conflict } from '../core/identity.js';
import { classificationSchema } from '../ontology/classification.js';
import { cityInputSchema, mapPlaceCorrectionsSchema, placeAmendmentsSchema, placeContinuationSchema, placeSelectionSchema, rideEndpointSchema } from './clarification.js';

// Existing public request fields and persisted input remain readable across runtime releases.
export const routeInputSchema = z.strictObject({ city: z.string().min(1).max(100), origin: z.string().min(1).max(500), destination: z.string().min(1).max(500), serviceClass: z.string().min(1).max(100).optional() });
export type RouteInput = z.infer<typeof routeInputSchema>;
export const submitSchema = z.strictObject({ requestId: z.string().min(1).max(128), message: z.string().min(1).max(4000), route: routeInputSchema.optional(),
  classification: classificationSchema.optional(),
  learnHotelWorkflow: z.literal(true).optional(), replayHotelWorkflow: z.strictObject({ workflowId: z.uuid(), checkIn: z.iso.date() }).optional(),
  conversationId: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u).optional(),
});
export const storedInputSchema = submitSchema.extend({
  places: placeSelectionSchema.partial().optional(),
  placeAmendments: placeAmendmentsSchema.optional(),
  mapPlaceCorrections: mapPlaceCorrectionsSchema.optional(),
  rideCity: cityInputSchema.optional(),
  rideOrigin: rideEndpointSchema.optional(),
  rideDestination: rideEndpointSchema.optional(),
  placeContinuation: placeContinuationSchema.optional(),
});

export function parseSubmission(raw: unknown) {
  const input = submitSchema.parse(raw);
  if (input.learnHotelWorkflow && input.replayHotelWorkflow) throw new Conflict('Choose learning or replay for this task');
  return input;
}

// Pick the public submission options, ignoring the envelope and any fields from later continuations.
export const taskOptions = z.object(submitSchema.omit({ requestId: true, message: true, conversationId: true }).shape);
