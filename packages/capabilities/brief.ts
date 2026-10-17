import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionAdapter, Preparation, AdapterContext, Delivery } from '../core/catalog.js';
import type { ServiceCapability, ProviderBinding, ExecutionPlan } from '../ontology/execution.js';
import type { Job } from '../core/domain.js';
import { SERVICE_CATALOG } from '../core/services.js';

const inputSchema = z.object({ goal: z.string().trim().min(1).max(10000), deliverable: z.string().trim().min(1).max(4000) }).strict();
export function prepareBrief(job: Job): void {
  if (!job.deliverable) {
    job.question = 'What deliverable and acceptance criteria should this task brief record?';
    job.messages.push({ id: randomUUID(), role: 'agent', text: job.question, at: job.updatedAt }); return;
  }
  delete job.question;
  job.state = 'completed';
  job.artifact = { id: randomUUID(), name: 'task-brief.json', data: { goal: job.goal, deliverable: job.deliverable, execution: 'not_started' } };
  job.messages.push({ id: randomUUID(), role: 'agent', text: 'Task brief prepared. The underlying business goal has not been executed.', at: job.updatedAt });
}
export function verifyBrief(artifact: NonNullable<Job['artifact']>, input: { goal: string; deliverable: string }): boolean {
  return artifact.name === 'task-brief.json' && artifact.data.goal === input.goal &&
    artifact.data.deliverable === input.deliverable && artifact.data.execution === 'not_started';
}
export const BRIEF_CAPABILITY: ServiceCapability = {
    ref: { id: 'brief.prepare', version: '2' }, ontologyRef: { id: 'task-brief', version: '2' },
    name: 'Prepare a task brief', description: SERVICE_CATALOG['brief.prepare']!.description + ' Only choose this when a brief itself is the requested outcome. Required input: goal, deliverable.', tags: ['brief', 'requirements'],
    inputSchema: z.toJSONSchema(inputSchema), actions: [{ ref: { id: 'prepare_brief', version: '2' }, effect: 'local' }], verifierRef: { id: 'brief.exact', version: '2' },
    predicates: [{ id: 'brief.json', description: 'The brief is delivered as a JSON artifact' }, { id: 'execution.none', description: 'Only prepare the brief; do not perform the underlying business goal or external actions' }],
    ontology: {
      objects: ['Goal', 'DeliverableSpecification', 'TaskBrief'], relations: ['TaskBrief describes Goal and DeliverableSpecification'],
      suitableWhen: 'The user requests a task brief, requirements or acceptance specification itself. Extract goal and the requested deliverable/criteria from their words. Ask only when those are missing.',
      notSuitableWhen: 'The user asks to actually perform the underlying purchase, audit, research, repair or other business work. Do not replace execution with a brief.',
      acceptance: 'JSON preserves the supplied goal and deliverable exactly and explicitly declares execution=not_started.',
      authorization: 'No external action, quote or payment. An explicit request for the brief is sufficient.',
    },
};
export const BRIEF_BINDING: ProviderBinding = { ref: { id: 'local-brief', version: '2' }, capabilityRef: BRIEF_CAPABILITY.ref,
  providerId: 'local-brief-builder', channelId: 'local', adapterId: 'brief.local.v2', protocol: 'local', enabled: true,
  verification: { level: 'local_test', evidenceRefs: ['tests/ontology-backend.test.ts'] }, recovery: { idempotency: 'none', lookup: false } };
export class BriefAdapter implements ExecutionAdapter {
  readonly id = 'brief.local.v2';
  permitted(): boolean { return true; }
  async prepare(_ctx: AdapterContext, value: unknown): Promise<Preparation> {
    const result = inputSchema.safeParse(value);
    if (!result.success) return { kind: 'needs_input', question: '请说明任务目标，以及任务说明需要记录的交付物和验收条件。这里只生成任务说明，不执行其中的业务。' };
    return { kind: 'ready', input: result.data, details: { underlyingExecution: 'not_started' }, facts: { conditions: ['brief.json', 'execution.none'] }, evidenceRefs: ['local:brief-schema'], observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
  }
  async execute(_ctx: AdapterContext, plan: ExecutionPlan): Promise<Delivery> {
    const input = inputSchema.parse(plan.steps[0]!.input);
    const artifact: NonNullable<Job['artifact']> = { id: randomUUID(), name: 'task-brief.json', data: { ...input, execution: 'not_started' } };
    return { artifact, facts: { conditions: ['brief.json', 'execution.none'] }, evidenceRefs: [artifact.id] };
  }
  verify(_ctx: AdapterContext, plan: ExecutionPlan, _private: unknown, delivery: Delivery) {
    return { accepted: verifyBrief(delivery.artifact, inputSchema.parse(plan.steps[0]!.input)), reason: 'Exact goal and deliverable checked; underlying business execution is not started.' };
  }
}
