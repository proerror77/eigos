import { z } from 'zod';
import { objectRefSchema, nameSchema } from './model.js';
import { moneySchema, type Ref } from './execution.js';
import type { OntologyReleaseRef } from './definition-contracts.js';

const instant = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1).max(500);
const names = (max: number) => z.array(nameSchema).max(max).refine(values => new Set(values).size === values.length, 'Duplicate selection');
export const observationStrategySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('poll'), intervalMs: z.number().int().min(1000).max(3600000) }),
  z.strictObject({ mode: z.literal('push'), maximumSilenceMs: z.number().int().min(1000).max(3600000) }),
]);
/** Explicit PA delegation, never a model-selected extension of a completed task.
 * Target/account declarations are expectations until a trusted adapter binds
 * and independently reads them. Registering this contract cannot dispatch. */
export const prepareObservationSchema = z.strictObject({
  action: z.literal('prepare_observation_contract'), originalTaskId: z.uuid(), expectedRevision: z.number().int().positive(),
  requestId: z.string().trim().min(1).max(128), goal: z.string().trim().min(1).max(4000),
  source: z.strictObject({ serviceId: text, mappingId: text, expectedSourceAccount: text, expectedNativeId: text }),
  target: z.strictObject({ object: objectRefSchema, revision: z.number().int().positive(), fields: names(40).min(1), relations: names(20).default([]) }),
  read: z.strictObject({ action: nameSchema, input: z.record(z.string(), z.unknown()) }),
  startsAt: instant, until: instant, maxStalenessMs: z.number().int().min(1000).max(86400000),
  strategy: observationStrategySchema,
  terminal: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('horizon_only') }),
    z.strictObject({ kind: z.literal('source_evidence'), field: nameSchema, equals: z.union([z.string().max(2000), z.number().finite(), z.boolean()]), proof: z.literal('independent_read') }),
  ]),
  perReadBudget: z.strictObject({ timeoutMs: z.number().int().min(1000).max(120000), maxCost: moneySchema }),
  lifetimeBudget: z.strictObject({ maxReads: z.number().int().min(1).max(1000), maxModelTurns: z.number().int().min(0).max(128),
    maxActiveMs: z.number().int().min(1000).max(3600000), maxCost: moneySchema }),
}).superRefine((value, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (Date.parse(value.until) <= Date.parse(value.startsAt) || Date.parse(value.until) - Date.parse(value.startsAt) > 86400000) error('An observation window is positive and at most 24 hours');
  const interval = value.strategy.mode === 'poll' ? value.strategy.intervalMs : value.strategy.maximumSilenceMs;
  if (interval > value.maxStalenessMs) error('The observation strategy exceeds the permitted freshness gap');
  if (value.perReadBudget.timeoutMs > value.lifetimeBudget.maxActiveMs) error('A read cannot exceed the lifetime active budget');
  if (value.perReadBudget.maxCost.currency !== value.lifetimeBudget.maxCost.currency || (/^\d+$/.test(value.perReadBudget.maxCost.minor) && /^\d+$/.test(value.lifetimeBudget.maxCost.minor) && BigInt(value.perReadBudget.maxCost.minor) > BigInt(value.lifetimeBudget.maxCost.minor))) error('Per-read cost must fit the explicit lifetime currency and ceiling');
  if (value.terminal.kind === 'source_evidence' && !value.target.fields.includes(value.terminal.field)) error('Terminal evidence must name a selected source field');
});
export type PrepareObservation = z.infer<typeof prepareObservationSchema>;
export interface ObservationPins {
  release: OntologyReleaseRef; intakeDigest: string; sourceRevision: string; sourceDigest: string;
  programRef: Ref; configurationDigest: string; actionDigest: string; inputDigest: string;
  installationId: string; memberId: string; parentGrant: { id: string; revision: number };
  sourceBindingId: string; authEpoch: number; policyVersion: string; policyRevision: number; expiresAt: string;
}
export interface ObservationUsage { reads: number; modelTurns: number; activeMs: number; costMinor: string }
export interface ObservationContract {
  version: '1'; id: string; owner: string; revision: number; revocationRevision: number;
  status: 'configured' | 'revoked'; createdAt: string; revokedAt?: string;
  declaration: PrepareObservation; pins: ObservationPins; digest: string; usage: ObservationUsage;
}
/** Only lifecycle/limit metadata crosses the task response boundary. Private
 * account IDs, native IDs, input values, target values and proofs stay internal. */
export interface ObservationContractView {
  id: string; revision: number; revocationRevision: number; status: 'configured' | 'revoked' | 'expired';
  monitoring: false; targetIdentity: 'unverified'; activation: 'observer_not_installed';
  sourcePermission: 'current' | 'unavailable'; startsAt: string; until: string; nextDueAt: string | null;
  maxStalenessMs: number; strategy: PrepareObservation['strategy'];
  perReadBudget: PrepareObservation['perReadBudget']; lifetimeBudget: PrepareObservation['lifetimeBudget']; usage: ObservationUsage;
}
