import type { Delivery } from '../core/catalog.js';
import { z } from 'zod';
import { refSchema } from './execution.js';
import { objectRefSchema, type ObjectRef, type ActionDefinition, type ObjectTypeDefinition, type LinkDefinition, type PropertyDefinition } from './model.js';
import { watchPolicySchema } from './situation.js';

export const COMPOSITION_REF = { id: 'services.compose', version: '1' } as const;
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/).refine(v => !['constructor', 'prototype', '__proto__'].includes(v));
const path = z.array(z.string().min(1).max(100).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v))).min(1).max(12);
export const compositionInputSchema = z.strictObject({
  components: z.array(z.strictObject({
    id: key, capabilityRef: refSchema, goal: z.string().min(1).max(2000), input: z.record(z.string(), z.unknown()),
    dependsOn: z.array(key).max(3),
    bindings: z.array(z.strictObject({ from: key, targetKey: key, path })).max(8),
    requirementIds: z.array(z.string().min(1).max(100)).max(40), conditionIds: z.array(z.string().min(1).max(100)).max(40),
    budgetShares: z.array(z.strictObject({ requirementId: z.string().min(1).max(100), minor: z.string().regex(/^(0|[1-9]\d{0,17})$/) })).max(8).optional(),
  })).min(2).max(4),
});
export type CompositionInput = z.infer<typeof compositionInputSchema>;
const scope = objectRefSchema.extend({ type: z.literal('ServiceComposition') });
export const compositionActionSchemas = {
  ActivateServiceComponent: z.strictObject({ scope, componentId: key }),
  CompleteServiceComponent: z.strictObject({ scope, componentId: key, completionJson: z.string().min(2).max(16000) }),
  RepairServiceComponent: z.strictObject({ scope, componentId: key, expectedGeneration: z.number().int().positive() }),
  StartObservationWatch: z.strictObject({ scope, componentId: key, observation: objectRefSchema,
    action: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/), argumentsJson: z.string().min(2).max(16000),
    policy: watchPolicySchema, refreshCompletion: z.boolean() }),
};
export const compositionCompletionSchema = z.strictObject({ rationale: z.string().min(1).max(2000) });
const property = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Owned, model-selected composition and independently verified component results' });
const common = { id: property('string', z.string().min(1).max(200), 'Stable owned identity'), displayTitle: property('string', z.string().min(1).max(500), 'Business label'), requestRevision: property('integer', z.number().int().positive(), 'Pinned root request revision') };
export const compositionObjects: ObjectTypeDefinition[] = [
  { id: 'ServiceComposition', version: '2', name: '跨服务任务图', aliases: ['ServiceComposition', '跨服务'], description: 'A bounded model-selected service graph; partial component success never completes the parent goal', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common, definition: property('struct', compositionInputSchema, 'Exact selected components, dependencies and input bindings'), configurationDigest: property('string', z.string(), 'Pinned configured program bindings') } },
  { id: 'ServiceComponent', version: '2', name: '服务组件', aliases: ['ServiceComponent'], description: 'One activated component generation with verified dependency provenance', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common, componentId: property('string', key, 'Selected graph node'), generation: property('integer', z.number().int().positive(), 'Explicit component generation'), scope: property('struct', objectRefSchema, 'Actual initialized program scope'), inputDigest: property('string', z.string(), 'Resolved input digest'), dependencies: property('array', z.array(objectRefSchema).max(3), 'Actual verified upstream result references') } },
  { id: 'ServiceComponentResult', version: '2', name: '组件验收结果', aliases: ['ServiceComponentResult'], description: 'One independently verified subgoal with explicit validity and historical generation', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common, componentId: property('string', key, 'Selected graph node'), generation: property('integer', z.number().int().positive(), 'Accepted component generation'), validity: property('string', z.enum(['valid', 'stale', 'superseded']), 'Current usability; history is retained'), validUntil: { ...property('timestamp', z.iso.datetime({ offset: true }), 'Earliest known evidence freshness boundary'), required: false }, artifactDigest: property('string', z.string(), 'Verified deliverable digest'), output: property('struct', z.record(z.string(), z.unknown()), 'Verified component output for explicit downstream bindings'), evidenceRefs: property('array', z.array(z.string()).max(100), 'Original source receipts'), evidenceLevel: property('string', z.string(), 'Actual source level, never promoted by composition') } },
];
export const compositionLinks: LinkDefinition[] = [
  { id: 'ComponentResultScope', description: 'Verified component generation and its retained acceptance history', from: { type: 'ServiceComponentResult', name: 'component', many: false, required: true }, to: { type: 'ServiceComponent', name: 'results', many: true } },
  { id: 'ComponentResultEvidence', description: 'Actual service receipts', from: { type: 'ServiceComponentResult', name: 'sourceReceipts', many: true }, to: { type: 'SourceReceipt', name: 'componentResults', many: true } },
  { id: 'CompositionRequest', description: 'Owned root task', from: { type: 'ServiceComposition', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'compositions', many: true } },
  ...['ServiceComponent', 'ServiceComponentResult'].map(type => ({ id: `${type}Composition`, description: 'Owned composition membership', from: { type, name: 'composition', many: false, required: true }, to: { type: 'ServiceComposition', name: type === 'ServiceComponent' ? 'components' : 'results', many: true } })),
];
const resultType = (id: string) => id === 'StartObservationWatch' ? 'ObservationWatch' : id === 'CompleteServiceComponent' ? 'ServiceComponentResult' : 'ServiceComponent';
export const compositionActions: ActionDefinition[] = Object.entries(compositionActionSchemas).map(([id, schema]) => ({
  id, description: id === 'StartObservationWatch' ? 'Select a bounded repeated read of this source under the PA monitoring contract; no business write authority' : id === 'RepairServiceComponent' ? 'Explicitly advance a stale component generation from current verified dependencies; preserve original operations' : id === 'ActivateServiceComponent' ? 'Activate an explicitly selected downstream component using only its verified dependency bindings; no provider call' : 'Independently verify one selected component from fresh source reads; does not finish the whole task',
  inputs: { scope: 'ServiceComposition' }, changes: [resultType(id)],
  submissionCriteria: ['same_owner', 'current_request_revision', 'pinned_composition', 'verified_dependencies', 'no_implicit_authority'],
  operation: { version: '1', effect: 'local', environment: 'sandbox', inputSchema: z.toJSONSchema(schema), resultType: resultType(id) },
}));

export interface ComponentState {
  programRef: { id: string; version: string }; programDigest: string; inputDigest?: string;
  scope?: ObjectRef; componentRef?: ObjectRef; input?: Record<string, unknown>; observations: ObjectRef[];
  generation: number;
  validity?: 'valid' | 'stale';
  staleReason?: string;
  dependencyDigests?: Record<string, string>;
  result?: { ref: ObjectRef; proposal: unknown; delivery: Delivery; at: string; validity: 'valid' | 'stale' | 'superseded'; validationPlanId?: string; validationReads?: import('./planning-contract.js').PlanningSnapshot };
  history?: { generation: number; scope: ObjectRef; componentRef: ObjectRef; input: Record<string, unknown>; inputDigest: string; result?: ComponentState['result']; observations: ObjectRef[] }[];
}
