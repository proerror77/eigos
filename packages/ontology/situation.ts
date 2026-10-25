import { z } from 'zod';
import { objectRefSchema, type ObjectRef, type ObjectTypeDefinition, type LinkDefinition, type PropertyDefinition, type FunctionDefinition, type ActionDefinition } from './model.js';
import type { MonitoringContract } from './execution.js';
export { monitoringSchema, type MonitoringContract } from './execution.js';

const instant = z.iso.datetime({ offset: true });
const text = z.string().min(1).max(500);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceIdentitySchema = z.strictObject({ bindingId: text, bindingDigest: hash, accountRef: text, subjectId: text, mappingVersion: text });
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;
export const watchPolicySchema = z.strictObject({
  intervalMs: z.number().int().min(100).max(3_600_000),
  maxAgeMs: z.number().int().min(100).max(86_400_000),
});
export type WatchPolicy = z.infer<typeof watchPolicySchema>;
export const sourceSampleSchema = z.strictObject({
  source: sourceIdentitySchema, eventId: text, providerVersion: z.number().int().nonnegative().optional(),
  observedAt: instant, expiresAt: instant, occurredAt: instant.optional(), effectiveAt: instant.optional(),
  authoritativeRead: z.boolean(), data: z.record(z.string(), z.unknown()),
  evidenceRefs: z.array(text).min(1).max(40),
  evidenceLevel: z.enum(['synthetic', 'provider_test', 'user_asserted', 'pa_reported', 'live_readonly', 'live_operation', 'live_fulfillment']),
  object: objectRefSchema,
});
export type SourceSample = z.infer<typeof sourceSampleSchema>;
export interface WatchSelection {
  componentId?: string;
  generation: number;
  scope: ObjectRef;
  programRef: { id: string; version: string };
  programDigest: string;
  action: string;
  input: Record<string, unknown>;
  source: SourceIdentity;
  fields: string[];
  modelRunId: string;
  planId: string;
  /** Explicit model-selected rebinding of unchanged completion evidence. */
  refreshCompletion: boolean;
  completion?: { proposal: unknown; argument: string; evaluate: string };
}
export type WatchHealth = 'fresh' | 'stale' | 'unavailable' | 'operator_required' | 'pa_required' | 'conflicted';
export interface ObservationWatch {
  id: string; owner: string; jobId: string; requestRevision: number;
  contract: MonitoringContract; contractDigest: string; selection: WatchSelection; policy: WatchPolicy;
  revision: number; status: 'active' | 'paused' | 'ended' | 'revoked'; health: WatchHealth;
  createdAt: string; nextAt: number; queries: number; failedReads: number;
  lastObservedAt?: string; validUntil?: string; sample?: SourceSample; semanticRevision: number;
  lastNoticeSequence: number; reason?: string;
  pendingRead?: ObservationRead;
  superseded?: boolean;
}
export interface SourceNotice {
  id: string; owner: string; sourceKey: string; eventId: string; digest: string; receivedAt: string;
  sequence: number; kind: 'provider_hint' | 'user_asserted'; conflict: boolean;
  /** Private evidence reference only; never injected into the planning context. */
  payloadRef?: string;
}
export interface ObservationRead {
  id: string; owner: string; jobId: string; watchId: string; watchRevision: number;
  sourceRevision: number; noticeSequence: number; startedAt: string; claimToken: string;
}
export interface SituationChange {
  revision: number; at: string; watchId: string; componentId?: string;
  reason: 'changed' | 'stale' | 'unavailable' | 'conflicted' | 'restored' | 'revoked' | 'budget';
  fields: string[]; evidenceRefs: string[]; object?: ObjectRef;
}
export interface SituationSummary {
  currentAssessment?: ObjectRef;
  revision: number; status: 'observing' | 'needs_human' | 'ended'; until: string;
  effective: boolean;
  queries: number; maxQueries: number; activeMs: number;
  watches: { id: string; componentId?: string; status: ObservationWatch['status']; health: WatchHealth; overdue: boolean; pendingChange: boolean; lastObservedAt?: string; validUntil?: string; nextAt: string; reason?: string }[];
  changes: SituationChange[];
}

const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Owned persistent observation policy and verified source evidence' });
const common = { id: p('string', text, 'Stable owned identity'), displayTitle: p('string', text, 'Business label'), requestRevision: p('integer', z.number().int().positive(), 'Current requirement revision') };
export const situationObjects: ObjectTypeDefinition[] = [
  { id: 'ObservationWatch', version: '1', name: '持续观察', aliases: ['ObservationWatch', '守护'], description: 'A bounded observation contract; it never grants a business write', primaryKey: 'id', titleKey: 'displayTitle', properties: {
    ...common, until: p('timestamp', instant, 'Observation horizon'), status: p('string', z.enum(['active', 'paused', 'ended', 'revoked']), 'Lifecycle'),
    health: p('string', z.enum(['fresh', 'stale', 'unavailable', 'operator_required', 'pa_required', 'conflicted']), 'Current source freshness and reachability'),
    summary: p('struct', z.record(z.string(), z.unknown()), 'Safe observation progress without raw payloads'),
  } },
  { id: 'SituationAssessment', version: '1', name: '当前态势评估', aliases: ['SituationAssessment', '当前态势'], description: 'Current implications of observed facts; not historical task completion', primaryKey: 'id', titleKey: 'displayTitle', properties: {
    ...common, situationRevision: p('integer', z.number().int().nonnegative(), 'Owned source and validity revision'),
    judgment: p('string', z.enum(['satisfied', 'unsatisfied', 'unknown', 'needs_human']), 'Current goal assessment'),
    assessedAt: p('timestamp', instant, 'Assessment time'), validUntil: p('timestamp', instant, 'Earliest local freshness boundary'),
    reason: p('string', text, 'Evidence-bounded explanation'), evidenceRefs: p('array', z.array(text).max(100), 'Original evidence references'),
    components: p('array', z.array(z.record(z.string(), z.unknown())).max(4), 'Affected components and validity'),
  } },
];
export const situationLinks: LinkDefinition[] = [
  { id: 'WatchRequest', description: 'The exact owned ongoing delegation', from: { type: 'ObservationWatch', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'observationWatches', many: true } },
  { id: 'SituationRequest', description: 'Current and historical situation assessments', from: { type: 'SituationAssessment', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'situations', many: true } },
];
export const situationFunctions: FunctionDefinition[] = [{ id: 'situationStatus', version: '1', inputTypes: ['ServiceRequest', 'SituationAssessment'], description: 'Current assessment with explicit validity; expired evidence stays unknown' }];
export const taskWatchActionSchema = z.strictObject({ scope: objectRefSchema, observation: objectRefSchema,
  action: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/), argumentsJson: z.string().min(2).max(16000),
  policy: watchPolicySchema, refreshCompletion: z.boolean(), completionJson: z.string().min(2).max(16000) });
export const situationActions: ActionDefinition[] = [{ id: 'StartTaskObservationWatch', description: 'Select a bounded independent read and conditional completion evidence binding for a single-program ongoing task',
  inputs: {}, changes: ['ObservationWatch'], submissionCriteria: ['same_owner', 'current_request_revision', 'explicit_monitoring_contract', 'read_only_observation'],
  operation: { version: '1', effect: 'local', environment: 'sandbox', inputSchema: z.toJSONSchema(taskWatchActionSchema), resultType: 'ObservationWatch' } }];
