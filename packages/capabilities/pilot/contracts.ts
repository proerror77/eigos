import { z } from 'zod';
export const PILOT = 'data.quality.audit.simulated' as const;
export const datasetSchema = z.enum(['clean-v1', 'duplicate-and-missing-v1', 'invalid-values-v1']);
export type DatasetId = z.infer<typeof datasetSchema>;
export const confirmSchema = z.object({
  taskId: z.uuid(), requestId: z.string().trim().min(1).max(128),
  action: z.literal('confirm_simulated_payment'), quoteId: z.uuid(), quoteDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export interface Finding { rule: string; column: string; rows: number[] }
export const reportSchema = z.object({
  schemaVersion: z.literal(1), environment: z.literal('simulated'), orderId: z.uuid(),
  inputSha256: z.string(), rulesVersion: z.literal('csv-quality-v1'), rowCount: z.number().int().nonnegative(),
  findings: z.array(z.object({ rule: z.string(), column: z.string(), rows: z.array(z.number().int().positive()) }).strict()),
  generatedAt: z.iso.datetime(),
}).strict();
export type Report = z.infer<typeof reportSchema>;
export interface Quote { planDigest?: string; ontologyVersion?: string; id: string; taskId: string; supplierId: 'local-supplier'; sku: 'csv-quality-v1' | 'csv-quality-file-v1'; inputSha256: string; rulesVersion: 'csv-quality-v1' | 'csv-quality-file-v1'; amountMinor: 100; currency: 'CNY'; expiresAt: string }
export type Fault = 'none' | 'bad-once' | 'bad-always' | 'no-delivery' | 'payment-unknown' | 'declined' | 'refund-stuck';
export interface PilotState {
  environment: 'simulated'; datasetId?: DatasetId; input?: { source: 'local-file'; fileName: string; sha256: string; byteLength: number; rowCount: number }; orderId: string; quote: Quote; quoteDigest: string;
  approval?: { quoteDigest: string; at: string; simulationOnly: true };
  payment: 'not_started' | 'pending' | 'unknown' | 'paid' | 'declined' | 'closed';
  acceptance: 'not_started' | 'awaiting' | 'received' | 'accepted' | 'rejected' | 'insufficient_evidence';
  remediation: 'none' | 'redelivery_pending' | 'refund_pending' | 'refunded' | 'needs_review';
  step: 'payment' | 'delivery' | 'refund' | 'done'; nextAt: number; deadline: number;
  deliveryAttempt: number; fetchAttempts: number; cancelRequested: boolean;
  trace: { at: string; event: string }[];
  checks: { at: string; accepted: boolean; reason: string; sha256?: string }[];
  files?: { json: string; markdown: string; jsonSha256: string; markdownSha256: string };
}
