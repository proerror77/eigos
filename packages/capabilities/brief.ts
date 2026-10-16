import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RegisteredCapability, Preparation } from '../core/capabilities.js';
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
export class BriefCapability implements RegisteredCapability {
  readonly definition = {
    id: 'brief.prepare', version: '1', providerId: 'local-brief-builder', ontologyVersion: 'eigos-brief-v1',
    service: SERVICE_CATALOG['brief.prepare']!,
    inputSchema: z.toJSONSchema(inputSchema),
    ontology: {
      objects: ['Goal', 'DeliverableSpecification', 'TaskBrief'], relations: ['TaskBrief describes Goal and DeliverableSpecification'],
      actions: ['prepare_brief', 'verify_brief'],
      suitableWhen: 'The user requests a task brief, requirements or acceptance specification itself. Extract goal and the requested deliverable/criteria from their words. Ask only when those are missing.',
      notSuitableWhen: 'The user asks to actually perform the underlying purchase, audit, research, repair or other business work. Do not replace execution with a brief.',
      acceptance: 'JSON preserves the supplied goal and deliverable exactly and explicitly declares execution=not_started.',
      authorization: 'No external action, quote or payment. An explicit request for the brief is sufficient.',
    },
  };
  available(): boolean { return true; }
  prepare(_job: Job, value: unknown): Preparation {
    const result = inputSchema.safeParse(value);
    if (!result.success) return { kind: 'needs_input', question: '请说明任务目标，以及任务说明需要记录的交付物和验收条件。这里只生成任务说明，不执行其中的业务。' };
    return { kind: 'ready', input: result.data, details: { actions: ['prepare_brief', 'verify_brief'], execution: 'not_started' } };
  }
  start(job: Job, prepared: Extract<Preparation, { kind: 'ready' }>): void {
    const input = inputSchema.parse(prepared.input);
    const artifact: NonNullable<Job['artifact']> = { id: randomUUID(), name: 'task-brief.json', data: { ...input, execution: 'not_started' } };
    // Verify against the prepared input rather than accepting a model's completion claim.
    const accepted = verifyBrief(artifact, input);
    if (!accepted) throw new Error('Brief acceptance failed');
    job.artifact = artifact; job.state = 'completed'; delete job.question;
    job.delegation!.phase = 'accepted';
    job.delegation!.acceptance = { accepted, reason: 'Goal and deliverable preserved; underlying business execution explicitly not started.', at: job.updatedAt };
    job.delegation!.events.push({ at: job.updatedAt, event: 'brief_verified', evidence: artifact.id });
  }
}
