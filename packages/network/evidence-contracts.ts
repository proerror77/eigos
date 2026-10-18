import { z } from 'zod';
import { domainNames } from '../ontology/service-domains.js';

const id = z.uuid(), revision = z.number().int().positive();
export const evidenceProjectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('result') }).strict(),
  z.object({ kind: z.literal('statement'), statement: z.enum(['result_received', 'service_received', 'problem_reported']) }).strict(),
]);
export type EvidenceProjection = z.infer<typeof evidenceProjectionSchema>;
export const evidenceSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), taskId: id }).strict(),
  z.object({ kind: z.literal('inquiry'), inquiryId: id }).strict(),
]);
export const evidenceBodySchema = z.object({
  serviceKind: z.enum(['delivery_quote', 'public_locations', 'document', 'audit', 'commerce', ...domainNames, 'other']),
  observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.literal('Asia/Shanghai'),
  resultKind: z.enum(['query_report', 'execution_assessment', 'local_artifact', 'participant_statement', 'unverified_result']),
  outcome: z.enum(['query_completed', 'accepted', 'partial', 'failed', 'pending', 'needs_human', 'canceled', 'insufficient_evidence', 'declared']),
  evidenceLevel: z.enum(['synthetic_validation', 'simulated_execution', 'live_query', 'live_execution', 'live_fulfillment', 'local_generation', 'participant_statement', 'insufficient_evidence']),
  safeSummary: z.string().min(1).max(500),
}).strict();
export type EvidenceBody = z.infer<typeof evidenceBodySchema>;
export const evidencePublicationSchema = z.object({ kind: z.literal('evidence_card'), cardId: id, cardRevision: revision, body: evidenceBodySchema }).strict();
export const evidenceDraftInputSchema = z.object({ kind: z.literal('evidence_card'), cardId: id, cardRevision: revision }).strict();
export interface EvidenceCard {
  id: string; owner: string; profileId: string; taskId: string; revision: number;
  projection: EvidenceProjection; sourceDigest: string; body: EvidenceBody; createdAt: string;
}
