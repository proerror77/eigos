import { z } from 'zod';
import { DIDI_TOOLS, didiDataSchema, didiReceiptSchema } from '../capabilities/didi/contracts.js';

export const SOURCE_RELAY_PROTOCOL = 'eigos.source-read/1' as const;
const sha = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().min(1).max(200);
export const sourceReadContextSchema = z.strictObject({
  requestId: z.uuid(), requestRevision: z.number().int().positive(), actionInputDigest: sha,
  planId: id, intentId: id, attemptId: id, modelRunId: id,
  programId: id, programDigest: sha, action: id,
});
export const sourceReadRequestSchema = z.strictObject({
  protocol: z.literal(SOURCE_RELAY_PROTOCOL), kind: z.literal('source.read'), callId: z.uuid(),
  authorityId: z.uuid(), gatewayOrigin: z.url().refine(v => new URL(v).protocol === 'https:' && new URL(v).origin === v),
  expiresAt: z.number().int().positive(), context: sourceReadContextSchema,
  source: z.strictObject({ bindingId: id, keySha256: sha, environment: z.literal('production') }),
  tool: z.enum(DIDI_TOOLS), input: z.record(z.string(), z.unknown()),
});
export type SourceReadRequest = z.infer<typeof sourceReadRequestSchema>;
export const sourceReadResponseSchema = z.strictObject({
  protocol: z.literal(SOURCE_RELAY_PROTOCOL), kind: z.literal('source.result'), callId: z.uuid(),
  authorityId: z.uuid(), requestDigest: sha,
  result: z.strictObject({ data: didiDataSchema, receipt: didiReceiptSchema }).optional(),
  error: z.enum(['AUTHORIZATION_REJECTED', 'SOURCE_UNAVAILABLE', 'READ_OUTCOME_UNKNOWN', 'RESULT_TOO_LARGE']).optional(),
}).refine(v => !!v.result !== !!v.error);
export type SourceReadResponse = z.infer<typeof sourceReadResponseSchema>;
