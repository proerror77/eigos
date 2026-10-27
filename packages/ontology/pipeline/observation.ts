import { z } from 'zod';
import { objectRefSchema } from '../model.js';
import { ontologyReleaseRefSchema } from '../definition-contracts.js';
import type { Ref } from '../execution.js';

/** Supplied by the PA, never invented or extended by a model decision. */
export const observationBudgetSchema = z.strictObject({
  until: z.iso.datetime({ offset: true }),
  maxReads: z.number().int().min(1).max(1000),
  maxActiveMs: z.number().int().min(1000).max(3600000),
});
export type ObservationBudget = z.infer<typeof observationBudgetSchema>;
export const observationSelectionSchema = z.strictObject({
  step: objectRefSchema.extend({ type: z.literal('ExecutionStep') }),
  object: objectRefSchema,
  fields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/)).min(1).max(40),
  intervalMs: z.number().int().min(1000).max(3600000),
  replaceWatchId: z.uuid().optional(),
});
export type ObservationSelection = z.infer<typeof observationSelectionSchema>;
export const observationControlSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('report_observation_change'), taskId: z.uuid(), expectedRevision: z.number().int().positive(), watchId: z.uuid(), eventId: z.string().min(1).max(200), contentDigest: z.string().regex(/^[a-f0-9]{64}$/), requestId: z.string().min(1).max(128) }),
  z.strictObject({ action: z.literal('stop_observation'), taskId: z.uuid(), expectedRevision: z.number().int().positive(), watchId: z.uuid().optional(), requestId: z.string().min(1).max(128) }),
  z.strictObject({ action: z.literal('resume_observation'), taskId: z.uuid(), expectedRevision: z.number().int().positive(), watchId: z.uuid().optional(), requestId: z.string().min(1).max(128) }),
]);

/** Reviewed adapter identity, computed before the source read. */
export interface PipelineReadTarget { serviceId: string; mappingId: string; sourceAccount: string; nativeId: string }
export interface PipelineWatch {
  id: string; owner: string; taskId: string; requestRevision: number; revision: number;
  release: z.infer<typeof ontologyReleaseRefSchema>; intakeDigest: string;
  programRef: Ref; configurationDigest: string; action: string; planId: string; stepId: string; intentId: string;
  componentId?: string; modelRunId: string; selection: ObservationSelection; target: PipelineReadTarget;
  input: Record<string, unknown>; inputDigest: string;
  status: 'active' | 'ended' | 'paused' | 'stopped'; health: 'fresh' | 'stale' | 'pending' | 'unavailable' | 'conflicted';
  nextAt: number; createdAt: string; lastObservedAt?: string; validUntil?: string; failedReads: number;
  lastValuesDigest: string; reason?: string;
  pending?: { id: string; operationKey: string; call: number };
  hintSequence: number; consumedHintSequence: number; coverageGapAt?: string;
}
export interface ObservationRead {
  id: string; operationId: string; operationKey: string; watchId: string; watchRevision: number;
  owner: string; taskId: string; requestRevision: number; call: number;
  sourceRevision: number; startedAt: string; reservedMs: number; hintSequence: number;
}
export interface ObservationContractState {
  budget: ObservationBudget; requestRevision: number; reads: number; activeMs: number; createdAt: string;
  stoppedRevision?: number;
  sourceChangesDigest?: string; sourceChangesPending?: boolean;
}
export interface ObservationSummary {
  until: string; reads: number; maxReads: number; activeMs: number; maxActiveMs: number;
  stopped?: boolean;
  watches: { id: string; status: PipelineWatch['status']; health: PipelineWatch['health']; nextAt: string;
    object?: PipelineWatch['selection']['object']; fields?: string[]; componentId?: string;
    lastObservedAt?: string; validUntil?: string; coverageGapAt?: string; reason?: string }[];
  eligibleReads?: { step: z.infer<typeof objectRefSchema>; action: string; facts: { object: z.infer<typeof objectRefSchema>; fields: string[] }[] }[];
}
