import { createHash } from 'node:crypto';
import { z } from 'zod';

export const DELEGATE = 'eigos.delegate' as const;
export const ROUTING_VERSION = 'eigos-capability-routing-v1';
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const assessmentSchema = z.object({
  decision: z.enum(['ask_user', 'select_capability', 'unsupported']),
  capabilityId: z.string().max(200),
  message: z.string().trim().min(1).max(4000),
  // JSON text keeps the model envelope independent of each registered input schema.
  inputJson: z.string().max(16000),
}).strict();
export type Assessment = z.infer<typeof assessmentSchema>;
export interface DelegationPlan {
  id: string;
  digest: string;
  capabilityId?: string;
  capabilityVersion?: string;
  providerId?: string;
  input?: unknown;
  details?: Record<string, unknown>;
  // Historical plans remain readable; only their owning adapter interprets old fields.
  [legacyField: string]: unknown;
}
export interface Delegation {
  routingVersion?: string;
  capabilityId?: string;
  capabilityVersion?: string;
  providerId?: string;
  ontologyVersion: string;
  phase: 'assessing' | 'clarifying' | 'awaiting_authorization' | 'executing' | 'accepted' | 'rejected' | 'failed' | 'canceled';
  assessment?: { decision: string; reason: string; provider: string; checkedAt: string };
  plan?: DelegationPlan;
  acceptance?: { accepted: boolean; reason: string; at: string };
  events: { at: string; event: string; evidence?: string }[];
}
export function validPlanDigest(plan: DelegationPlan): boolean {
  const { digest: expected, ...body } = plan;
  return digest(body) === expected;
}
