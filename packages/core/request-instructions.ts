import type { Job } from './domain.js';
import type { ServiceRequest } from '../ontology/execution.js';

type Instruction = ServiceRequest['messages'][number];
export const submissionDeliverableInstructionId = (taskId: string) => `submission-deliverable:${taskId}`;

/** Both fields are authenticated original submission text. Keep them separate
 * so exact quotations retain their source and later replies remain newer. */
export function submissionInstructions(taskId: string, goal: Instruction, deliverable?: string): Instruction[] {
  return [goal, ...(deliverable ? [{ id: submissionDeliverableInstructionId(taskId), text: deliverable, receivedAt: goal.receivedAt }] : [])];
}

/** Repair only the provable original-field omission before any execution
 * context exists. This restores submitted text, never a new owner statement. */
export function restoreOriginalDeliverableInstruction(job: Job, hasIntents: boolean): string | undefined {
  const d = job.delegation, request = d?.request, original = request?.messages[0], submitted = job.messages[0];
  if (!d || !request || hasIntents || d.agent || d.suspendedAgent || d.plan || d.resolution
    || d.agentHistory?.length || d.planHistory?.length || d.intentId || d.intentIds?.length || d.actions?.length
    || d.businessFacts?.length || d.acceptance || job.artifact || request.supersededRequirements?.length || request.supersededConditions?.length
    || request.id !== job.id || request.revision !== 1 || request.messages.length !== 1 || job.messages.length !== 1
    || !original || !submitted || submitted.role !== 'user' || original.id !== submitted.id
    || original.text !== job.goal || request.originalGoal !== job.goal || submitted.text !== job.goal
    || original.receivedAt !== job.createdAt || submitted.at !== job.createdAt
    || !job.deliverable || job.deliverable !== request.requestedDeliverable
    || original.id === submissionDeliverableInstructionId(job.id)) return;
  const restored = submissionInstructions(job.id, original, job.deliverable)[1]!;
  request.messages.push(restored);
  return restored.id;
}
