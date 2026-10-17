import { z } from 'zod';

export const BACKEND_VERSION = 'ontology-execution-v2' as const;
export const refSchema = z.object({ id: z.string().min(1).max(200), version: z.string().min(1).max(80) }).strict();
export type Ref = z.infer<typeof refSchema>;
const integer = z.string().regex(/^(0|[1-9]\d{0,17})$/);
export const moneySchema = z.object({ minor: integer, currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
const base = { id: z.string().min(1).max(100), strength: z.enum(['hard', 'preference']) };
export const requirementSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('quantity'), expected: z.object({ amount: integer, unit: z.string().min(1).max(80) }).strict() }).strict(),
  z.object({ ...base, kind: z.literal('budget'), expected: moneySchema }).strict(),
  z.object({ ...base, kind: z.literal('deadline'), expected: z.object({ at: z.iso.datetime({ offset: true }), timezone: z.string().min(1).max(100), original: z.string().min(1).max(500) }).strict() }).strict(),
  z.object({ ...base, kind: z.literal('location'), expected: z.object({ ref: z.string().min(1).max(500) }).strict() }).strict(),
  z.object({ ...base, kind: z.literal('condition'), expected: z.object({ predicate: z.string().min(1).max(200) }).strict() }).strict(),
]);
export const requirementsSchema = z.array(requirementSchema).max(40).refine(items => new Set(items.map(i => i.id)).size === items.length, 'Requirement IDs must be unique');
export type RequirementInput = z.infer<typeof requirementSchema>;
export type Requirement = RequirementInput & { provenance: { source: 'pa'; interpretation: 'structured' | 'quoted_text'; messageId: string; receivedAt: string; quote?: string } };
export interface ServiceRequest {
  id: string;
  revision: number;
  originalGoal: string;
  requestedDeliverable?: string;
  requirements: Requirement[];
  messages: { id: string; text: string; receivedAt: string }[];
}
export interface ActionType { ref: Ref; effect: 'local' | 'read' | 'order' | 'payment' | 'cancel' | 'refund' }
export interface ServiceCapability {
  ref: Ref;
  ontologyRef: Ref;
  name: string;
  description: string;
  tags: string[];
  inputSchema: object;
  ontology: object;
  actions: ActionType[];
  predicates: { id: string; description: string }[];
  verifierRef: Ref;
}
export interface ProviderBinding {
  ref: Ref;
  capabilityRef: Ref;
  providerId: string;
  channelId: string;
  merchantId?: string;
  adapterId: string;
  protocol: 'local' | 'http' | 'mcp' | 'a2a' | 'browser';
  enabled: boolean;
  verification: { level: 'local_test' | 'read_only_probe' | 'simulated' | 'live_fulfillment'; evidenceRefs: string[] };
  recovery: { idempotency: 'none' | 'provider_key' | 'provider_reference'; lookup: boolean };
}
// Facts come from registered adapters, never a model's plan or authorization claim.
export interface CandidateFacts {
  quantity?: { amount: string; unit: string };
  totalPrice?: z.infer<typeof moneySchema>;
  deliveryBy?: string;
  locationRef?: string;
  conditions?: string[];
}
export interface RequirementCheck { requirementId: string; result: 'pass' | 'fail' | 'unknown'; reason: string; evidenceRefs: string[] }
export interface Quote { id: string; digest: string; amount: z.infer<typeof moneySchema>; expiresAt: string; environment: 'local_simulation' }
export interface ResolvedCandidate {
  id: string; binding: ProviderBinding; status: 'ready' | 'needs_input' | 'unavailable'; question?: string;
  input?: Record<string, unknown>; details?: Record<string, unknown>; facts: CandidateFacts;
  evidenceRefs: string[]; requirementChecks: RequirementCheck[]; observedAt: string; expiresAt: string; quote?: Quote;
}
export interface ResolutionScope { capabilityRef: Ref; searchedBindingRefs: Ref[]; observedAt: string; realSupply: false }
export interface PlanStep { id: string; actionTypeRef: Ref; bindingRef: Ref; input: Record<string, unknown>; dependsOn: string[] }
export interface ExecutionPlan {
  id: string;
  version: '2';
  requestId: string;
  requestRevision: number;
  requestDigest: string;
  capabilityRef: Ref;
  ontologyRef: Ref;
  candidateId: string;
  bindingRef: Ref;
  verifierRef: Ref;
  steps: PlanStep[];
  details: Record<string, unknown>;
  requirementChecks: RequirementCheck[];
  expiresAt: string;
  quote?: Quote;
  digest: string;
}
