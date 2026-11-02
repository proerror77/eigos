import { z } from 'zod';
import type { Principal } from '../core/domain.js';
import type { ObjectView } from './object-store.js';
import type { PipelineIntake, PipelineMapping, PipelineObservation } from './pipeline/contracts.js';
import type { PrepareObservation } from './observation-contract.js';
import type { Ref } from './execution.js';

/** Installed, reviewed code only. No public endpoint can register an adapter.
 * bind is synchronous metadata validation; read receives no graph, model,
 * business dispatcher, task mutation or credential from the caller. */
export interface ObservationAdapter {
  readonly ref: Ref;
  readonly maximumCost: { minor: string; currency: string };
  readonly evidenceScope?: string;
  bind(context: { owner: string; declaration: PrepareObservation; object: ObjectView; mapping: PipelineMapping; source: PipelineIntake['source'] }): ObservationTarget;
  read(context: { owner: string; target: ObservationTarget; input: Record<string, unknown>; operationId: string; startedAt: string; assertAuthorized(): void }, signal: AbortSignal): Promise<PipelineObservation>;
}
export interface ObservationTarget { sourceAccount: string; nativeId: string; orderingScope: string; ordering: 'provider_version' | 'independent_read' }
export const observationControlSchema = z.strictObject({ action: z.literal('activate_observation_contract'), taskId: z.uuid(), expectedRevision: z.number().int().positive(), requestId: z.string().trim().min(1).max(128) });
export const observationHintSchema = z.strictObject({ action: z.literal('report_observation_change'), taskId: z.uuid(), requestId: z.string().trim().min(1).max(128), eventId: z.string().min(1).max(200), contentDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export interface ObservationRuntimeState {
  id: string; taskId: string; owner: string; generation: number; state: 'active' | 'paused' | 'ended' | 'revoked';
  principal: Principal; adapter: Ref; target: ObservationTarget; bindingDigest: string; activatedAt: string;
  nextAt: number; health: 'pending' | 'fresh' | 'stale' | 'unavailable' | 'conflicted'; reason?: string;
  hintSequence: number; consumedHints: number; lastObservedAt?: string; validUntil?: string; targetVerified: boolean;
  failedReads?: number;
}
export interface ObservationReadTicket {
  id: string; owner: string; taskId: string; runtimeId: string; generation: number; contractRevision: number;
  leaseDigest: string; sourceRevision: number; hintSequence: number; startedAt: string; reservedMs: number; costMinor: string;
}
