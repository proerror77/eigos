import { z } from 'zod';

export const BACKEND_VERSION = 'ontology-execution-v24';
export const refSchema = z.object({ id: z.string().min(1).max(200), version: z.string().min(1).max(80) }).strict();
export type Ref = z.infer<typeof refSchema>;
const integer = z.string().regex(/^(0|[1-9]\d{0,17})$/);
export const moneySchema = z.object({ minor: integer, currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
const base = { id: z.string().min(1).max(100), strength: z.enum(['hard', 'preference']) };
export const quantityRoles = ['item_quantity', 'passenger_count', 'room_count', 'guest_count', 'traveler_count', 'patient_count', 'participant_count', 'result_count'] as const;
export const amountRoles = ['service_total', 'deposit'] as const;
export const deadlineRoles = ['completion', 'pickup', 'arrival', 'registration'] as const;
export const locationRoles = ['origin', 'destination', 'pickup', 'return', 'venue'] as const;
export interface RequirementRoleDefinition { kind: 'quantity' | 'budget' | 'deadline' | 'location'; role: string; description: string }
export const requirementSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('quantity'), role: z.enum(quantityRoles).optional(), expected: z.object({ amount: integer, unit: z.string().min(1).max(80) }).strict() }).strict(),
  z.object({ ...base, kind: z.literal('budget'), role: z.enum(amountRoles).optional(), expected: moneySchema }).strict(),
  z.object({ ...base, kind: z.literal('deadline'), role: z.enum(deadlineRoles).optional(), expected: z.object({ at: z.iso.datetime({ offset: true }), timezone: z.string().min(1).max(100), original: z.string().min(1).max(500) }).strict() }).strict(),
  z.object({ ...base, kind: z.literal('location'), role: z.enum(locationRoles).optional(), expected: z.object({ ref: z.string().min(1).max(500) }).strict() }).strict(),
  z.object({ ...base, kind: z.literal('condition'), expected: z.object({ predicate: z.string().min(1).max(200) }).strict() }).strict(),
]);
export const requirementsSchema = z.array(requirementSchema).max(40).refine(items => new Set(items.map(i => i.id)).size === items.length, 'Requirement IDs must be unique');
export type RequirementInput = z.infer<typeof requirementSchema>;
export type Requirement = RequirementInput & { provenance: { source: 'pa'; interpretation: 'structured' | 'quoted_text'; messageId: string; receivedAt: string; quote?: string } };
export interface ConfirmedInput {
  field: string; status: 'confirmed' | 'ambiguous' | 'cleared'; value?: unknown; quote: string; revision: number;
  source: { messageId: string; messageIndex: number; receivedAt: string };
  personalBasis?: import('./personal-context.js').PersonalBasis;
}
export interface ConfirmedInputs { version: '1'; revision: number; messageDigest: string; fields: Record<string, ConfirmedInput>; history: ConfirmedInput[] }
export interface ServiceRequest {
  personalContext?: import('./personal-context.js').SelectedPersonalContext;
  capabilityRef?: Ref;
  id: string;
  revision: number;
  originalGoal: string;
  requestedDeliverable?: string;
  requirements: Requirement[];
  successCriteria?: Requirement[];
  supersededRequirements?: Requirement[];
  confirmedInputs?: Record<string, ConfirmedInputs>;
  conditions?: import('./business-model.js').BusinessCondition[];
  supersededConditions?: import('./business-model.js').BusinessCondition[];
  messages: { id: string; text: string; receivedAt: string }[];
  outcome?: 'refund' | 'cancel';
  businessScopeId?: string;
  executionEnvironment?: 'live' | 'sandbox';
}
export interface ActionType { ref: Ref; effect: import('./actions.js').EffectClass; additionalEffects?: import('./actions.js').EffectClass[] }
export interface ServiceCapability {
  scopeReviewMode?: 'registered_fixed_input';
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
  completion?: 'artifact' | 'delivery' | 'order' | 'refund' | 'domain';
  outcomePredicates?: string[];
  /** Independently verifiable outcome and business phase, never an execution recipe. */
  goalOutcomes?: { predicate: string; phase: import('../core/goal-contract.js').GoalCriterion['phase']; description: string }[];
  effectConstraints?: { predicate: string; allowedEffects: import('./actions.js').EffectClass[] }[];
  requirementRoles?: RequirementRoleDefinition[];
  environment?: 'local' | 'live' | 'sandbox';
  locationSemantics?: 'search_area' | 'destination';
  constraintEvaluation?: 'staged';
}
export interface ProviderBinding {
  ref: Ref;
  capabilityRef: Ref;
  providerId: string;
  channelId: string;
  merchantId?: string;
  adapterId: string;
  configurationDigest?: string;
  protocol: 'local' | 'http' | 'mcp' | 'a2a' | 'browser';
  enabled: boolean;
  verification: { level: 'local_test' | 'read_only_probe' | 'simulated' | 'live_fulfillment'; evidenceRefs: string[] };
  recovery: { idempotency: 'none' | 'provider_key' | 'provider_reference'; lookup: boolean };
  discovery?: { sourceId: string; requestId: string; requestRevision: number; observedAt: string; evidenceRefs: string[] };
}
// Facts come from registered adapters, never a model's plan or authorization claim.
export interface CandidateFacts {
  quantity?: { amount: string; unit: string };
  quantities?: Partial<Record<typeof quantityRoles[number], { amount: string; unit: string }>>;
  totalPrice?: z.infer<typeof moneySchema>;
  amounts?: Partial<Record<typeof amountRoles[number], z.infer<typeof moneySchema>>>;
  deliveryBy?: string;
  deadlines?: Partial<Record<typeof deadlineRoles[number], string>>;
  locationRef?: string;
  locations?: Partial<Record<typeof locationRoles[number], string>>;
  conditions?: string[];
  searchArea?: { city: string; keyword: string };
}
export interface RequirementCheck { requirementId: string; result: 'pass' | 'fail' | 'unknown'; reason: string; evidenceRefs: string[] }
export interface Quote {
  id: string; digest: string; amount: z.infer<typeof moneySchema>; expiresAt: string; environment: 'local_simulation';
  requestDigest: string; bindingRef: Ref; bindingDigest: string; inputDigest: string; detailsDigest: string;
}
export interface ResolvedCandidate {
  id: string; binding: ProviderBinding; status: 'ready' | 'needs_input' | 'unavailable'; question?: string;
  input?: Record<string, unknown>; details?: Record<string, unknown>; facts: CandidateFacts;
  evidenceRefs: string[]; requirementChecks: RequirementCheck[]; observedAt: string; expiresAt: string; quote?: Quote;
  offer?: import('./supply.js').ProductOfferSnapshot;
  ontologySubject?: import('./model.js').ObjectRef;
  recipe?: import('./actions.js').PreparedStep[];
}
export interface ResolutionScope { capabilityRef: Ref; searchedBindingRefs: Ref[]; observedAt: string; realSupply: boolean; coverage?: import('./supply.js').DiscoveryCoverage[] }
export interface PlanStep {
  id: string; operationId: string; actionTypeRef: Ref; bindingRef: Ref; capabilityRef: Ref;
  operationScope?: string;
  effect: import('./actions.js').EffectClass;
  additionalEffects?: import('./actions.js').EffectClass[];
  input: Record<string, unknown>; inputRefs: import('./actions.js').InputReference[]; dependsOn: string[];
  cost?: { minor: string; currency: string; payeeId: string; purpose?: typeof amountRoles[number] };
}
/** Business context for a new fixed plan. This is never a provider argument or
 * an accepted-output reference; dispatch input materialization ignores it. */
export interface FixedCandidateBinding {
  version: '1'; requestId: string; requestRevision: number;
  candidateId: string; candidateDigest: string;
  subject: import('./planning-contract.js').ObjectSnapshot;
}
export const FIXED_CANDIDATE_CONTEXT_PARAMETER = '@selected_candidate';
export interface ExecutionPlan {
  id: string;
  version: '7';
  ontologyPlanning: import('./planning-contract.js').PlanningSnapshot;
  requestId: string;
  requestRevision: number;
  requestDigest: string;
  capabilityRef: Ref;
  ontologyRef: Ref;
  candidateId: string;
  candidateBinding?: FixedCandidateBinding;
  bindingRef: Ref;
  bindingSnapshots: import('./supply.js').DiscoveredBinding[];
  definitionDigests: { ref: Ref; digest: string }[];
  bindingDigests: { ref: Ref; digest: string }[];
  completionTarget: 'artifact' | 'delivery' | 'order' | 'refund' | 'domain';
  verifierRef: Ref;
  steps: PlanStep[];
  details: Record<string, unknown>;
  requirementChecks: RequirementCheck[];
  expiresAt: string;
  quote?: Quote;
  digest: string;
}
