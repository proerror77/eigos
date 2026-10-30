import { z } from 'zod';
import { assertDefinitionJson, ontologyReleaseRefSchema, resourceIdSchema } from '../definition-contracts.js';
import { nameSchema } from '../model.js';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(500);
const instant = z.iso.datetime({ offset: true });
const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value));
const path = z.array(field).min(1).max(8);
const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
export const pipelineRefSchema = z.strictObject({ id: resourceIdSchema, version: text });
export const pipelineFieldSchema = z.strictObject({
  from: path, to: path, optional: z.boolean().default(false),
  values: z.record(z.string().max(200), scalar).refine(values => Object.keys(values).length <= 100).optional(),
  unknownValue: scalar.optional(),
}).refine(value => value.unknownValue === undefined || value.values !== undefined, 'An unknown mapping needs a value table');
export const pipelineMappingSchema = z.strictObject({
  id: resourceIdSchema, objectType: nameSchema, nativeId: path,
  fields: z.array(pipelineFieldSchema).min(1).max(50),
  // Targets resolve within this intake's source/account/owner namespace.
  // Raw payloads cannot select an arbitrary object ID or another source.
  links: z.array(z.strictObject({ linkType: nameSchema, targetMapping: resourceIdSchema, nativeId: path,
    many: z.boolean().optional(), optional: z.boolean().optional() })).max(20).optional(),
  maxAgeMs: z.number().int().min(1000).max(30 * 86400000),
}).superRefine((mapping, context) => {
  const targets = mapping.fields.map(value => value.to.join('.'));
  if (new Set(mapping.links?.map(link => link.linkType)).size !== (mapping.links?.length ?? 0)) context.addIssue({ code: 'custom', message: 'Each relationship mapping must have one authoritative source field' });
  if (targets.some((target, index) => targets.some((other, j) => j !== index && (target === other || target.startsWith(other + '.'))))) {
    context.addIssue({ code: 'custom', message: 'Mapping targets must be unique and cannot overlap' });
  }
});
export type PipelineMapping = z.infer<typeof pipelineMappingSchema>;

/** An intake is a claim, not executable code, an authorization, or a receipt. */
export const pipelineIntakeSchema = z.strictObject({
  format: z.literal('eigos.ontology.pipeline.v1'), serviceId: resourceIdSchema,
  source: z.strictObject({ id: resourceIdSchema, revision: text, digest: sha, observedAt: instant,
    reference: z.string().min(1).max(1000).refine(value => {
      try { const url = new URL(value); return ['https:', 'urn:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
    }, 'Use a credential-free HTTPS or URN material reference'),
  }),
  programRef: pipelineRefSchema, configurationDigest: sha,
  environment: z.enum(['local', 'sandbox', 'live']),
  vocabulary: z.array(z.strictObject({ term: text, aliases: z.array(text).max(20), objectType: nameSchema })).max(30),
  actions: z.array(z.strictObject({
    actionId: nameSchema, definitionDigest: sha, readbackActionId: nameSchema.optional(),
    requiredEvidence: z.enum(['definition_only', 'synthetic', 'local_test', 'live_readonly', 'live_operation', 'live_fulfillment']),
  })).min(1).max(20),
  mappings: z.array(pipelineMappingSchema).max(20),
  conditions: z.strictObject({
    regions: z.array(text).max(30), payment: z.enum(['not_required', 'pa_owned', 'external_app', 'unknown']),
    operatorRequired: z.boolean(),
  }),
  fixtures: z.array(z.strictObject({ mappingId: resourceIdSchema, input: z.record(z.string(), z.unknown()), expected: z.record(z.string(), z.unknown()) })).max(30),
}).superRefine((value, context) => {
  for (const [label, ids] of [['action', value.actions.map(action => action.actionId)], ['mapping', value.mappings.map(mapping => mapping.id)]] as const) {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: `Duplicate ${label} identity` });
  }
  if (value.actions.some(action => action.readbackActionId && !value.actions.some(other => other.actionId === action.readbackActionId))) context.addIssue({ code: 'custom', message: 'Readback must reference an action in the same intake' });
  if (value.fixtures.some(fixture => !value.mappings.some(mapping => mapping.id === fixture.mappingId))) context.addIssue({ code: 'custom', message: 'Fixture refers to an unknown mapping' });
  if (value.mappings.some(mapping => mapping.links?.some(link => !value.mappings.some(target => target.id === link.targetMapping)))) context.addIssue({ code: 'custom', message: 'Relationship target must name a mapping in the same intake' });
  if (value.environment !== 'live' && value.actions.some(action => action.requiredEvidence.startsWith('live_'))) context.addIssue({ code: 'custom', message: 'Non-live intakes cannot require live evidence' });
  if (value.environment === 'live' && value.actions.some(action => action.requiredEvidence === 'synthetic')) context.addIssue({ code: 'custom', message: 'Synthetic evidence cannot admit live execution' });
  if (value.environment !== 'local' && value.actions.some(action => action.requiredEvidence === 'local_test')) context.addIssue({ code: 'custom', message: 'Local evidence only applies to a local program' });
});
export type PipelineIntake = z.infer<typeof pipelineIntakeSchema>;
export function parsePipelineIntake(value: unknown): PipelineIntake {
  assertDefinitionJson(value);
  if (Buffer.byteLength(JSON.stringify(value)) > 40000) throw new DomainError('INVALID_INPUT', 'A service intake is limited to 40 KB');
  return pipelineIntakeSchema.parse(value);
}
/** Fixture changes do not change source semantics, but do require another validation. */
export const pipelineMappingDigest = (intake: PipelineIntake) => digest({ source: intake.source, programRef: intake.programRef,
  configurationDigest: intake.configurationDigest, actions: intake.actions, mappings: intake.mappings, environment: intake.environment, conditions: intake.conditions, vocabulary: intake.vocabulary });

export interface PipelineVerification {
  id: string; intakeDigest: string; mappingDigest: string; contractDigest: string;
  kind: 'mapping_test' | 'task_evidence'; level: string; actionIds: string[];
  evidenceRefs: string[]; taskId?: string; verifiedAt: string; expiresAt: string;
  actionEvidence?: Record<string, { level: string; evidenceRefs: string[]; observedAt: string }>;
  availabilityProof: false; authorizationProof: false;
}
/** The final readback can have a different evidence level from the write. A
 * whole-task label must never promote every action to its strongest evidence. */
export function verificationCoversAction(action: PipelineIntake['actions'][number], actions: PipelineIntake['actions'], verification: PipelineVerification): boolean {
  const readback = action.readbackActionId ? actions.find(value => value.actionId === action.readbackActionId) : undefined;
  return verification.kind === 'task_evidence' && verification.actionEvidence?.[action.actionId]?.level === action.requiredEvidence
    && (!action.readbackActionId || !!readback && verification.actionEvidence?.[readback.actionId]?.level === readback.requiredEvidence);
}
export interface PipelineStatus {
  status: 'unmanaged' | 'definition_only' | 'validation_only' | 'verified' | 'verification_required' | 'expired' | 'revoked' | 'source_changed' | 'contract_changed';
  serviceId?: string; intakeDigest?: string; mappingDigest?: string; verificationIds: string[];
  reason: string; authorization: 'per_action_required'; availabilityProof: false;
  conditions?: PipelineIntake['conditions'];
  terms?: string[];
}
export function assertPipelineReady(status: PipelineStatus): void {
  if (!['unmanaged', 'verified', 'validation_only'].includes(status.status)) throw new DomainError('CONFLICT', `Service intake ${status.status}: ${status.reason}`);
}
export const pipelineValidationRequestSchema = z.strictObject({
  ontologyId: resourceIdSchema.default('eigos.business'), release: ontologyReleaseRefSchema, serviceId: resourceIdSchema,
  goal: z.string().trim().min(1).max(10000), requestId: z.string().trim().min(1).max(128), expiresAt: instant,
});
export interface PipelineValidationScope {
  ownerDigest: string; requestRevision: number; release: z.infer<typeof ontologyReleaseRefSchema>;
  serviceId: string; intakeDigest: string; mappingDigest: string; expiresAt: string;
}
export const pipelineObservationSchema = z.strictObject({
  eventId: text, sourceAccount: resourceIdSchema, sourceRevision: text, sourceDigest: sha,
  providerVersion: z.number().int().nonnegative().optional(), occurredAt: instant.optional(), observedAt: instant, receivedAt: instant,
  independentRead: z.boolean().default(false),
  expiresAt: instant.optional(), evidenceRefs: z.array(text).min(1).max(20),
  evidenceLevel: z.enum(['synthetic', 'live_readonly', 'live_operation', 'live_fulfillment']),
  payload: z.record(z.string(), z.unknown()),
});
export type PipelineObservation = z.input<typeof pipelineObservationSchema>;
export const pipelineReleaseQuery = z.strictObject({ release: ontologyReleaseRefSchema, serviceId: resourceIdSchema });
