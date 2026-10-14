import { z } from 'zod';

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

export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.includes(scope)) throw new DomainError('FORBIDDEN', `Required scope: ${scope}`);
}

// Never accept ownership from tool arguments, message metadata, or a tenant header.
export function ownerKey(p: Principal): string {
  return JSON.stringify([p.issuer, p.tenant, p.subject]);
}

export const requestIdSchema = z.string().trim().min(1).max(128);
export const taskIdSchema = z.uuid();
export const submitSchema = z.object({
  service: z.literal('brief.prepare').default('brief.prepare'),
  goal: z.string().trim().min(1).max(10_000),
  deliverable: z.string().trim().min(1).max(4_000).optional(),
  requestId: requestIdSchema,
}).strict();
export const replySchema = z.object({
  taskId: taskIdSchema,
  answer: z.string().trim().min(1).max(4_000),
  requestId: requestIdSchema,
}).strict();
export type SubmitInput = z.infer<typeof submitSchema>;
export type ReplyInput = z.infer<typeof replySchema>;

export type JobState = 'input-required' | 'completed' | 'canceled';
export interface JobMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  at: string;
}
export interface Job {
  id: string;
  contextId: string;
  service: 'brief.prepare';
  goal: string;
  deliverable?: string;
  state: JobState;
  question?: string;
  artifact?: { id: string; name: string; data: { goal: string; deliverable: string; execution: 'not_started' } };
  messages: JobMessage[];
  createdAt: string;
  updatedAt: string;
}

export const SERVICES = [{
  id: 'brief.prepare',
  name: 'Prepare a task brief',
  description: 'Collect a goal and the required deliverable, then produce a structured task brief. This reference service does not execute the underlying business goal or make purchases.',
  requiredInputs: ['goal', 'deliverable'],
}];
