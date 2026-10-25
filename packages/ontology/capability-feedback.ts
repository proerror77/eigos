import { z } from 'zod';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const counts = <T extends readonly [string, ...string[]]>(names: T) => z.partialRecord(z.enum(names), count);
/** Only bounded aggregate labels are exported. Free-form goal-kind keys and
 * individual task/receipt identities remain in the private feedback ledger. */
export const capabilityVerificationHistorySchema = z.strictObject({
  scope: z.literal('Task outcomes for this owner and exact binding version; unresolved tasks remain in the denominator'),
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sampleCount: count,
  outcomeCounts: counts(['satisfied', 'unsatisfied', 'unknown', 'needs_human']),
  taskStateCounts: counts(['submitted', 'working', 'paused', 'input-required', 'auth-required', 'completed', 'canceled', 'failed', 'rejected']),
  evidenceLevelCounts: counts(['unverified', 'synthetic', 'provider_test', 'user_asserted', 'live_readonly', 'live_operation', 'live_fulfillment', 'local_test', 'read_only_probe', 'simulated']),
  firstObservedAt: z.iso.datetime({ offset: true }).max(64).nullable(),
  lastObservedAt: z.iso.datetime({ offset: true }).max(64).nullable(),
  includesUnknownAndCanceled: z.literal(true),
  availabilityProof: z.literal(false),
  automaticPromotion: z.literal(false),
}).superRefine((value, context) => {
  for (const field of ['outcomeCounts', 'taskStateCounts', 'evidenceLevelCounts'] as const) {
    if (Object.values(value[field]).reduce<number>((sum, n) => sum + (n ?? 0), 0) !== value.sampleCount) context.addIssue({ code: 'custom', path: [field], message: 'Aggregate counts must retain every sample' });
  }
  if (value.sampleCount === 0 ? value.firstObservedAt !== null || value.lastObservedAt !== null
    : value.firstObservedAt === null || value.lastObservedAt === null || Date.parse(value.firstObservedAt) > Date.parse(value.lastObservedAt)) {
    context.addIssue({ code: 'custom', message: 'Observation range must match the aggregate sample set' });
  }
});
export type CapabilityVerificationHistory = z.infer<typeof capabilityVerificationHistorySchema>;

export function sanitizeCapabilityVerificationHistory(raw: unknown): CapabilityVerificationHistory {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return capabilityVerificationHistorySchema.parse(raw);
  const { goalKindCounts: _privateGoalKinds, ...aggregate } = raw as Record<string, unknown>;
  return capabilityVerificationHistorySchema.parse(aggregate);
}
