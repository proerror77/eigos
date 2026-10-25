import type { Delegation } from './delegation.js';
import { z } from 'zod';
import type { RunEvidence } from '../capabilities/executor.js';
import { requirementsSchema, monitoringSchema } from '../ontology/execution.js';

export const SCOPES = ['services:read', 'tasks:read', 'tasks:write'] as const;
export type Scope = (typeof SCOPES)[number];
export interface Principal {
  issuer: string;
  subject: string;
  tenant: string;
  clientId: string;
  scopes: string[];
}

export class DomainError extends Error {
  constructor(public code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'INVALID_INPUT', message: string) {
    super(message);
  }
}
export class ReplanRequired extends DomainError {
  constructor(message: string) { super('CONFLICT', message); }
}

export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.includes(scope)) throw new DomainError('FORBIDDEN', `Required scope: ${scope}`);
}

// Never accept ownership from tool arguments, message metadata, or a tenant header.
export function ownerKey(p: Principal): string {
  return JSON.stringify([p.issuer, p.tenant, p.subject]);
}

export const requestIdSchema = z.string().trim().min(1).max(128);
export const taskIdSchema = z.uuid();
export const observationReportSchema = z.strictObject({ action: z.literal('report_source_change'), taskId: taskIdSchema, watchId: z.string().regex(/^[a-f0-9]{64}$/),
  eventId: z.string().min(1).max(500), note: z.string().min(1).max(2000), requestId: requestIdSchema });
export const observationRevokeSchema = z.strictObject({ action: z.literal('revoke_observation'), taskId: taskIdSchema, watchId: z.string().regex(/^[a-f0-9]{64}$/), requestId: requestIdSchema });
export const observationResumeSchema = z.strictObject({ action: z.literal('resume_observation'), taskId: taskIdSchema, watchId: z.string().regex(/^[a-f0-9]{64}$/), requestId: requestIdSchema });
export const remediationSchema = z.object({ originalTaskId: taskIdSchema, action: z.enum(['cancel', 'refund']), reason: z.string().trim().min(1).max(1000), requestId: requestIdSchema }).strict();
const afterSalesSubmitSchema = remediationSchema.extend({ service: z.literal('eigos.aftersales') });
export const submitSchema = z.union([z.object({
  service: z.literal('eigos.delegate').default('eigos.delegate'), goal: z.string().trim().min(1).max(10000),
  deliverable: z.string().trim().min(1).max(4000).optional(), requirements: requirementsSchema.optional(), requestId: requestIdSchema,
  executionEnvironment: z.enum(['live', 'sandbox']).optional(),
  monitoring: monitoringSchema.optional(),
}).strict(), afterSalesSubmitSchema]);
const answerReplySchema = z.object({
  taskId: taskIdSchema,
  answer: z.string().trim().min(1).max(4_000),
  requestId: requestIdSchema,
  requirements: requirementsSchema.optional(),
}).strict();
export const replySchema = answerReplySchema;
export const ontologySubmitSchema = submitSchema;
export type SubmitInput = z.infer<typeof submitSchema>;
export type ReplyInput = z.infer<typeof replySchema>;

export type JobState = 'submitted' | 'auth-required' | 'rejected' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed';
export interface JobMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  at: string;
}
export interface Job {
  id: string;
  contextId: string;
  // Historical records retain their original service name, but only delegate can execute.
  service: string;
  delegation?: Delegation;
  afterSales?: Omit<import('../ontology/actions.js').AfterSalesCase, 'owner'>[];
  executionMode?: 'worker';
  goal: string;
  deliverable?: string;
  state: JobState;
  question?: string;
  artifact?: { id: string; name: string; data: { goal: string; deliverable: string; execution: 'not_started' | 'completed'; markdown?: string; result?: object } };
  runs?: RunEvidence[];
  revision?: number;
  error?: string;
  messages: JobMessage[];
  createdAt: string;
  updatedAt: string;
}
