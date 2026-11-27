import { z } from 'zod';
import { actionResultReadSchema } from '../ontology/invocation.js';
import { pickupCoordinateEvidence, placeDetailInput } from '../ontology/maps.js';
import { objectRefSchema } from '../ontology/schema.js';
import type { Requirement } from './access.js';

export const placeSelectionSchema = z.strictObject({ origin: objectRefSchema, destination: objectRefSchema });
const placeClueFields = {
  address: z.string().trim().min(5).max(300).optional(),
  landmark: z.string().trim().min(3).max(200).optional(),
  name: z.string().trim().min(1).max(200).optional(),
};
const hasPlaceClue = (input: {address?: string; landmark?: string}) => Boolean(input.address || input.landmark);
export const placeClueSchema = z.strictObject(placeClueFields).refine(hasPlaceClue, 'Provide an address or landmark');
export const placeAmendmentSchema = z.strictObject({
  ...placeClueFields,
  side: z.enum(['origin', 'destination']),
  keep: objectRefSchema.optional(),
}).refine(hasPlaceClue, 'Provide an address or landmark');
export const unresolvedMapPlace = '高德未能唯一匹配所需精度的地点，请补充城市或完整地址。';
export const amapPlaceAmendmentSchema = z.strictObject({
  source: z.literal('Amap'),
  side: z.enum(['origin', 'destination']),
  placeId: placeDetailInput.shape.id,
  requestId: z.uuid(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
  restoreCanceled: z.literal(true).optional(),
});
export const taskPlaceAmendmentSchema = z.union([amapPlaceAmendmentSchema, placeAmendmentSchema]);
const mapPlaceCorrectionSchema = z.strictObject({
  requestId: z.uuid(),
  fingerprint: z.string(),
  placeId: placeDetailInput.shape.id,
  name: z.string(),
  city: z.string().optional(),
});
export const mapPlaceCorrectionsSchema = z.strictObject({
  origin: mapPlaceCorrectionSchema.optional(),
  destination: mapPlaceCorrectionSchema.optional(),
});
export const placeAmendmentsSchema = z.strictObject({
  origin: placeClueSchema.optional(),
  destination: placeClueSchema.optional(),
});
export const cityInputSchema = z.string().trim().min(2).max(100);
export const rideEndpointSchema = z.string().trim().min(1).max(500);
export const taskInputAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('city'), city: cityInputSchema }),
  z.strictObject({ kind: z.literal('origin'), place: rideEndpointSchema }),
  z.strictObject({ kind: z.literal('destination'), place: rideEndpointSchema }),
  z.strictObject({ kind: z.literal('retry-source') }),
]);
export const placeChoicesSchema = z.object({
  origin: z.array(z.object({ ref: objectRefSchema })),
  destination: z.array(z.object({ ref: objectRefSchema })),
});
export const actionInputPurpose = z.enum(['input', 'observation', 'authorization', 'execution-result']);
export type ActionInputPurpose = z.infer<typeof actionInputPurpose>;
export const actionWaitSchema = z.strictObject({
  id: z.uuid(), capability: z.string().min(1).max(200), purpose: actionInputPurpose,
});
export const actionContinuationSchema = z.strictObject({
  requestId: z.string().min(1),
  action: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  read: actionResultReadSchema.optional(),
  pending: actionWaitSchema.optional(),
  // Legacy place clients still use these compatibility fields.
  waitingFor: z.enum(['city', 'origin', 'destination', 'pa-request', 'retry-source']).optional(),
  receipts: placeSelectionSchema.optional(),
  pickup: pickupCoordinateEvidence.optional(),
}).refine(input => !input.waitingFor ? Boolean(input.pending || input.receipts) :
  input.waitingFor === 'retry-source' || !input.receipts);
export type PlaceSelection = z.infer<typeof placeSelectionSchema>;
export type ActionContinuation = z.infer<typeof actionContinuationSchema>;
export type LegacyActionWait = Pick<ActionContinuation, 'waitingFor' | 'receipts' | 'pickup'>;

export class Clarification extends Error {
  constructor(
    message: string, readonly choices?: unknown, readonly permissions: Requirement[] = [],
    readonly continuation?: ActionContinuation,
  ) { super(message); }
}

export class ActionInputRequired extends Clarification {
  constructor(message: string, choices: unknown, permissions: Requirement[],
    readonly wait: LegacyActionWait & { pending?: z.infer<typeof actionWaitSchema> }) { super(message, choices, permissions); }
}

/** Raised by an edit Function before staging a write when the sources do not establish a confirmed endpoint. */
export class PlaceConfirmationRequired extends ActionInputRequired {
  constructor(message: string, choices: unknown, receipts: PlaceSelection,
    pickup?: z.infer<typeof pickupCoordinateEvidence>) { super(message, choices, [], { receipts, pickup }); }
}

/** The selected Action lacks a city, so no supplier lookup has been authorized yet. */
export class CityConfirmationRequired extends ActionInputRequired {
  constructor() { super('请提供这段行程所在的城市。', { kind: 'city' }, [], { waitingFor: 'city' }); }
}

export class RideEndpointRequired extends ActionInputRequired {
  constructor(readonly side: 'origin' | 'destination', message: string) {
    super(message, { kind: side }, [], { waitingFor: side });
  }
}

export class PARequestRequired extends Clarification {}
export class ActionPARequestRequired extends ActionInputRequired {
  constructor(message: string, choices: unknown, permissions: Requirement[], purpose?: ActionInputPurpose) {
    const request = z.object({ requestId: z.uuid(), capability: z.string(), purpose: actionInputPurpose.optional() }).parse(choices);
    super(message, choices, permissions, { waitingFor: 'pa-request',
      pending: { id: request.requestId, capability: request.capability, purpose: purpose ?? request.purpose ?? 'observation' } });
  }
}

export class SourceRetryRequired extends ActionInputRequired {
  constructor(stage: 'places' | 'estimate', readonly receipts?: PlaceSelection) {
    super('滴滴查询失败，可以重试原任务。', { kind: 'retry-source', source: 'DiDi', stage }, [], { waitingFor: 'retry-source', receipts });
  }
}
