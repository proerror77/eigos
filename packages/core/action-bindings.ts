import { z } from 'zod';
import type { ActionDefinition } from '../ontology/model.js';
import type { OntologyReleaseRef } from '../ontology/definition-contracts.js';
import type { Ref } from '../ontology/execution.js';
import type { EffectClass } from '../ontology/actions.js';

/** A task-specific pin, selected by the model and re-resolved before every dispatch. */
export interface ActionBindingPin {
  ref: Ref; programRef: Ref; actionId: string; actionVersion: string;
  definitionDigest: string; compositionDigest?: string; configurationDigest: string;
  providerBinding?: Ref; ontologyRelease: OntologyReleaseRef;
  providerSnapshot?: import('../ontology/execution.js').ProviderBinding;
  providerDefinitionDigest?: string;
  ownerDigest: string; requestId: string; requestRevision: number; digest: string;
}
export type BindingReadiness = 'ready' | 'contract_missing' | 'contract_mismatch' | 'source_authorization_required' | 'disabled' | 'pipeline_unverified' | 'conditions_unmet';
export interface DiscoveredActionBinding {
  pin: ActionBindingPin; readiness: BindingReadiness; reason: string;
  environment: 'local' | 'live' | 'sandbox'; inputSchema: object;
  completionSchema: object; guidance: string;
  capability?: Pick<import('../ontology/execution.js').ServiceCapability, 'name' | 'description' | 'predicates' | 'outcomePredicates' | 'requirementRoles' | 'locationSemantics' | 'effectConstraints'>;
  goalOutcomes?: import('../ontology/execution.js').ServiceCapability['goalOutcomes'];
  sourceAuthorization?: { provider: string; state: string; nextAction: string };
  pipeline?: import('../ontology/pipeline/contracts.js').PipelineStatus;
}
export interface ActionDiscoveryEntry {
  action: ActionDefinition; bindings: DiscoveredActionBinding[];
  status: 'available' | 'definition_only' | 'binding_unavailable' | 'not_ready';
}
export const actionDiscoverySchema = z.strictObject({
  actionId: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/).optional(),
  programRef: z.strictObject({ id: z.string().min(1).max(200), version: z.string().min(1).max(200) }).optional(),
  inputType: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/).optional(),
  outputType: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/).optional(),
  effects: z.array(z.enum(['local', 'read', 'object_write', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund', 'external_draft'])).max(10).optional(),
  search: z.string().max(100).optional(), limit: z.number().int().min(1).max(10).default(5), cursor: z.string().max(1000).optional(),
  serviceConditions: z.strictObject({ region: z.string().min(1).max(100).optional(), paymentModes: z.array(z.enum(['not_required', 'pa_owned', 'external_app'])).min(1).max(3).optional(), operatorAvailable: z.boolean().optional() }).optional(),
});
export type ActionDiscoveryQuery = z.input<typeof actionDiscoverySchema>;
export interface ActionDiscoveryPage {
  ontologyRelease: OntologyReleaseRef; requestId: string; requestRevision: number;
  items: ActionDiscoveryEntry[]; page: { limit: number; hasMore: boolean; cursor?: string };
  /** Readiness describes a configured implementation. No read result grants an effect. */
  authorization: 'per_action_required'; allowedEffects: EffectClass[]; snapshotDigest: string;
}
