import { z } from 'zod';
import { submitSchema, versionedReplySchema } from '../core/domain.js';
import { agentIdSchema, relayOrigin } from '../relay/contracts.js';

export const TASK_RELAY_PROTOCOL = 'eigos.task-relay/1' as const;
const base = { protocol: z.literal(TASK_RELAY_PROTOCOL), authorityId: z.uuid(), requestId: z.uuid() };
export const taskRelayRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('task.submit'), input: submitSchema.refine(v => v.service === 'eigos.delegate') }),
  z.strictObject({ ...base, kind: z.literal('task.get'), taskId: z.uuid() }),
  z.strictObject({ ...base, kind: z.literal('task.reply'), input: versionedReplySchema }),
  z.strictObject({ ...base, kind: z.literal('task.cancel'), taskId: z.uuid() }),
]);
export type TaskRelayRequest = z.infer<typeof taskRelayRequestSchema>;
export const taskRelayMetadataSchema = z.strictObject({
  protocol: z.literal(TASK_RELAY_PROTOCOL), authorityId: z.uuid(),
  gatewayOrigin: z.url().refine(s => new URL(s).protocol === 'https:' && new URL(s).origin === s),
  relayUrl: z.string().transform(relayOrigin), gatewayAgentId: agentIdSchema,
  bindingPath: z.literal('/relay/bind'),
  enrollmentPath: z.literal('/relay/enrollment').optional(),
});
export const taskRelayResponseSchema = z.strictObject({
  ...base, kind: z.literal('task.response'),
  task: z.object({ view: z.literal('eigos.task.v2'), id: z.uuid(), authorityId: z.uuid(), state: z.string(), outputStatus: z.enum(['available', 'restricted', 'receipt_only']) }).passthrough().optional(),
  error: z.enum(['AUTHORIZATION_REQUIRED', 'ACCESS_REVOKED', 'AUTHORITY_UNAVAILABLE', 'REVOCATION_PENDING', 'POLICY_CHANGED', 'SOURCE_NOT_AUTHORIZED', 'OUTPUT_NOT_ALLOWED', 'INSUFFICIENT_ACCESS', 'INVALID_REQUEST', 'TASK_CONFLICT', 'RESULT_TOO_LARGE']).optional(),
}).refine(v => !!v.task !== !!v.error);
export type TaskRelayResponse = z.infer<typeof taskRelayResponseSchema>;
