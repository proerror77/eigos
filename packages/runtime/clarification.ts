import { z } from 'zod';
import { actionResultReadSchema } from '../ontology/invocation.js';
import { objectRefSchema } from '../ontology/schema.js';
import type { Requirement } from './access.js';

export const placeSelectionSchema = z.strictObject({ origin: objectRefSchema, destination: objectRefSchema });
export const placeAddressSchema = z.strictObject({
  address: z.string().trim().min(5).max(300),
  name: z.string().trim().min(1).max(200).optional(),
});
export const placeAmendmentSchema = placeAddressSchema.extend({
  side: z.enum(['origin', 'destination']),
  keep: objectRefSchema.optional(),
});
export const placeAmendmentsSchema = z.strictObject({
  origin: placeAddressSchema.optional(),
  destination: placeAddressSchema.optional(),
});
export const placeChoicesSchema = z.object({
  origin: z.array(z.object({ ref: objectRefSchema })),
  destination: z.array(z.object({ ref: objectRefSchema })),
});
export const placeContinuationSchema = z.strictObject({
  requestId: z.string().min(1),
  action: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  read: actionResultReadSchema,
  receipts: placeSelectionSchema,
});
export type PlaceSelection = z.infer<typeof placeSelectionSchema>;
export type PlaceContinuation = z.infer<typeof placeContinuationSchema>;

export class Clarification extends Error {
  constructor(
    message: string, readonly choices?: unknown, readonly permissions: Requirement[] = [],
    readonly continuation?: PlaceContinuation,
  ) { super(message); }
}

/** Raised by an edit Function before staging a write when its live source has multiple possible locations. */
export class PlaceConfirmationRequired extends Clarification {
  constructor(message: string, choices: unknown, readonly receipts: PlaceSelection) { super(message, choices); }
}
