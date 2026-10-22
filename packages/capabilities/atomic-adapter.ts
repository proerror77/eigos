import type { AgentActionContext, AgentProgramContext } from '../core/agent-program.js';
import type { AdapterInvocationView } from '../core/catalog.js';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ActionContext } from '../ontology/actions.js';
import type { ProviderBinding, Ref } from '../ontology/execution.js';

/** Project only the chosen atomic operation. The root frontier, model choice,
 * dependency graph, intent and attempt retain their original identities. */
export function adapterInvocation(ctx: AgentProgramContext, intentId: string, binding: ProviderBinding, action: Ref, input: Record<string, unknown>, details: Record<string, unknown> = {}): AdapterInvocationView {
  const plan = ctx.state.plans.find(value => value.steps.some(step => step.intentId === intentId));
  const step = plan?.steps.find(value => value.intentId === intentId);
  if (!plan || !step?.binding || !step.binding.providerSnapshot || digest(step.binding.providerSnapshot) !== digest(binding)
    || digest(step.binding.programRef) !== digest(ctx.state.programRef) || step.binding.configurationDigest !== ctx.state.programDigest) throw new DomainError('CONFLICT', 'Atomic adapter invocation lacks its original exact provider binding');
  return { id: plan.id, capabilityRef: binding.capabilityRef, bindingRef: binding.ref, bindingSnapshots: [binding], details,
    sourcePlan: { id: plan.id, digest: plan.digest, stepId: step.id, intentId },
    steps: [{ id: step.id, operationId: action.id, actionTypeRef: action, capabilityRef: binding.capabilityRef, bindingRef: binding.ref,
      effect: step.effect, ...(step.additionalEffects ? { additionalEffects: step.additionalEffects } : {}), ...(step.cost ? { cost: step.cost } : {}),
      input, inputRefs: [], dependsOn: [], ...(step.operationScope ? { operationScope: step.operationScope } : {}) }] };
}

export function adapterActionContext(ctx: AgentActionContext, plan: AdapterInvocationView, input: Record<string, unknown>): ActionContext {
  const execution = ctx.execution;
  if (!execution || execution.intent.id !== ctx.intentId || execution.attempt.id !== ctx.attemptId
    || execution.attempt.intentId !== ctx.intentId || execution.intent.planDigest !== plan.sourcePlan.digest
    || execution.attempt.planDigest !== plan.sourcePlan.digest || plan.sourcePlan.intentId !== ctx.intentId) throw new DomainError('CONFLICT', 'Adapter context requires the actual original intent and attempt');
  return { owner: ctx.owner, requestId: ctx.request.id, requestRevision: ctx.request.revision, plan, step: plan.steps[0]!, goal: ctx.request.originalGoal,
    messages: ctx.request.messages.map(message => ({ id: message.id, role: 'user', text: message.text, at: message.receivedAt })), modelReceipts: ctx.modelRuns ? [...ctx.modelRuns] : undefined,
    intent: execution.intent, attempt: execution.attempt, invocationInputDigest: digest(input), input, assertDispatchAllowed: ctx.assertDispatchAllowed };
}
