import { PILOT, confirmSchema, datasetSchema, type PilotState } from '../capabilities/pilot/contracts.js';
import type { Delegation } from './delegation.js';
import { z } from 'zod';
import type { RunEvidence } from '../capabilities/executor.js';
import { LIFE_INTAKE, type LifeRequest } from '../capabilities/life-intake.js';

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
const legacySubmitSchema = z.object({
  service: z.enum(['brief.prepare', 'agent.execute', 'meituan.paotui.read', 'meituan.paotui.order', 'eigos.delegate']).default('brief.prepare'),
  goal: z.string().trim().min(1).max(10_000),
  deliverable: z.string().trim().min(1).max(4_000).optional(),
  requestId: requestIdSchema,
}).strict();
export const submitSchema = z.union([z.object({
  service: z.literal(LIFE_INTAKE), goal: z.string().min(1).max(10000).refine(value => !!value.trim()),
  domain: z.string().trim().min(1).max(80).optional(), requestId: requestIdSchema,
}).strict(), legacySubmitSchema, z.object({ service: z.literal(PILOT), goal: z.string().trim().min(1).max(10000), datasetId: datasetSchema, requestId: requestIdSchema }).strict(),
  z.object({ service: z.literal(PILOT), goal: z.string().trim().min(1).max(10000), fileName: z.string().min(1).max(200).regex(/^[^/\\\x00-\x1f]+\.csv$/i), requestId: requestIdSchema }).strict()]);
const legacyReplySchema = z.object({
  taskId: taskIdSchema,
  answer: z.string().trim().min(1).max(4_000),
  requestId: requestIdSchema,
}).strict();
export const replySchema = z.union([legacyReplySchema, confirmSchema]);
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
  service: 'brief.prepare' | 'agent.execute' | 'meituan.paotui.read' | 'meituan.paotui.order' | typeof PILOT | 'eigos.delegate' | typeof LIFE_INTAKE;
  intake?: LifeRequest;
  delegation?: Delegation;
  executionMode?: 'worker' | 'capability' | 'intake';
  pilot?: PilotState;
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

export { SERVICES } from './services.js';
