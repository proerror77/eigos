import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Job } from './domain.js';

export const executionBudgetProfileSchema = z.enum(['standard', 'extended']);
export type ExecutionBudgetProfile = z.infer<typeof executionBudgetProfileSchema>;
export const MIN_REASONING_TURNS = 2;
export class ReasoningBudgetExhausted extends Error {
  constructor() { super('Ontology reasoning turn limit reached without a final decision'); }
}
type Counts = { modelTurns: number; plans: number; actions: number };
export interface ExecutionBudget {
  version: '1';
  profile: ExecutionBudgetProfile;
  window: { sequence: number; reason: 'initial' | 'input' | 'source' | 'automatic' | 'recovery'; requestRevision: number; startedAt: string; baseline: Counts; progressBaseline?: number };
  paused?: { resource: keyof Counts | 'time' | 'reasoning'; scope: 'window' | 'task'; at: string };
}
const profiles = {
  standard: { window: { modelTurns: 32, plans: 8, actions: 16 }, task: { modelTurns: 128, plans: 32, actions: 64 }, groundingTurns: 12 },
  extended: { window: { modelTurns: 64, plans: 16, actions: 32 }, task: { modelTurns: 256, plans: 64, actions: 128 }, groundingTurns: 32 },
} as const;
const progressCount = (job: Job) => job.delegation!.events.filter(e => ['agent_scope_initialized', 'agent_scope_resumed', 'agent_observation_projected', 'ontology_plan_validated'].includes(e.event)).length;
export function executionCounts(job: Job): Counts {
  const states = [...(job.delegation?.agentHistory ?? []), ...(job.delegation?.agent ? [job.delegation.agent] : [])];
  const plans = [...new Map(states.flatMap(state => state.plans).map(plan => [plan.id, plan])).values()];
  return { modelTurns: job.runs?.length ?? 0, plans: plans.length, actions: plans.reduce((n, plan) => n + plan.steps.length, 0) };
}
export function initialExecutionBudget(at: string, profile: ExecutionBudgetProfile = 'standard'): ExecutionBudget {
  return { version: '1', profile, window: { sequence: 1, reason: 'initial', requestRevision: 1, startedAt: at, baseline: { modelTurns: 0, plans: 0, actions: 0 } } };
}
export function executionBudgetStatus(job: Job) {
  const budget = job.delegation?.executionBudget ?? initialExecutionBudget(job.createdAt);
  const profile = profiles[budget.profile], used = executionCounts(job);
  const agent = !!(job.delegation?.agent || job.delegation?.suspendedAgent || job.delegation?.agentHistory?.length);
  const limits = { window: { ...profile.window, modelTurns: agent ? profile.window.modelTurns : profile.groundingTurns }, task: profile.task };
  const windowUsed = Object.fromEntries(Object.entries(used).map(([key, n]) => [key, n - budget.window.baseline[key as keyof Counts]])) as Counts;
  return { version: budget.version, profile: budget.profile, limits, used, windowUsed, window: budget.window, paused: budget.paused };
}
export function remainingModelTurns(job: Job): number {
  const s = executionBudgetStatus(job);
  return Math.max(0, Math.min(s.limits.window.modelTurns - s.windowUsed.modelTurns, s.limits.task.modelTurns - s.used.modelTurns));
}
/** Accepted input, verified recovery or new progress can start a bounded window.
 * Actual runs, plans and attempts remain in their original ledgers. */
export function continueExecutionBudget(job: Job, reason: 'input' | 'source' | 'automatic' | 'recovery', profile?: ExecutionBudgetProfile) {
  const d = job.delegation!, old = d.executionBudget ?? initialExecutionBudget(job.createdAt);
  const chosen = old.profile === 'extended' || profile === 'extended' ? 'extended' : 'standard';
  d.executionBudget = { version: '1', profile: chosen, window: { sequence: old.window.sequence + 1, reason, requestRevision: d.request.revision,
    startedAt: job.updatedAt, baseline: executionCounts(job), progressBaseline: progressCount(job) } };
  d.events.push({ at: job.updatedAt, event: 'execution_window_resumed', evidence: `${reason}:${d.executionBudget.window.sequence}:${chosen}` });
}
export function executionBudgetExceeded(job: Job, resource: keyof Counts, additional = 0): 'window' | 'task' | undefined {
  const s = executionBudgetStatus(job);
  if (s.used[resource] + additional > s.limits.task[resource]) return 'task';
  if (s.windowUsed[resource] + additional > s.limits.window[resource]) return 'window';
}
export function pauseExecutionBudget(job: Job, resource: keyof Counts | 'time' | 'reasoning', scope: 'window' | 'task') {
  const d = job.delegation!, at = new Date().toISOString();
  d.executionBudget ??= initialExecutionBudget(job.createdAt);
  const status = executionBudgetStatus(job);
  const progress = progressCount(job) > (status.window.progressBaseline ?? 0);
  if (scope === 'window' && resource !== 'reasoning' && progress && status.limits.task.modelTurns - status.used.modelTurns >= MIN_REASONING_TURNS
    && status.used.plans < status.limits.task.plans && status.used.actions < status.limits.task.actions) {
    job.updatedAt = at; continueExecutionBudget(job, 'automatic');
    job.state = 'working'; d.phase = d.agent ? 'planning' : d.plan ? 'executing' : 'grounding'; d.nextAt = 0;
    delete job.question; delete job.error;
    return;
  }
  d.executionBudget.paused = { resource, scope, at };
  job.state = 'paused'; d.phase = 'paused'; d.nextAt = 0; job.updatedAt = at; delete job.question;
  const message = scope === 'task'
    ? d.executionBudget.profile === 'extended'
      ? '任务已到防失控累计上限，保留原任务与确认信息，等待调整执行策略；会员用量没有上限。'
      : '任务已到防失控累计上限，可为原任务扩展执行策略后继续，无需补充业务信息。'
    : resource === 'reasoning'
      ? '本次推理未形成有效决策，保留原任务，等待运行恢复。'
      : '本段执行未取得足够新进展，保留原任务，等待运行恢复；无需重复确认业务信息。';
  d.events.push({ at, event: 'execution_budget_paused', evidence: `${scope}:${resource}` });
  job.messages.push({ id: randomUUID(), role: 'agent', text: message, at });
}
