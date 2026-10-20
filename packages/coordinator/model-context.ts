import type { AgentPlanningContext } from './coordinator.js';

/** Model-facing view only. Full decisions, read receipts and signatures remain
 * in the durable ledger and are independently revalidated before dispatch. */
export function agentModelContext(context: AgentPlanningContext) {
  const { state, capability, ...rest } = context;
  const { inputSchema: _inputSchema, actions: _actions, ...capabilitySummary } = capability;
  return {
    ...rest, capability: capabilitySummary,
    state: {
      version: state.version, programRef: state.programRef, programDigest: state.programDigest,
      scope: state.scope, input: state.input, requestRevision: state.requestRevision,
      pendingPlanId: state.pendingPlanId, observations: state.observations,
      plans: state.plans.map(plan => ({
        id: plan.id, sequence: plan.sequence,
        steps: plan.steps.map(step => ({ id: step.id, action: step.action, effect: step.effect, argumentsJson: step.argumentsJson, dependsOn: step.dependsOn, inputRefs: step.inputRefs })),
      })),
      feedback: state.feedback,
      informationRequests: state.informationRequests?.map(item => ({ at: item.at, message: item.decision.message, informationRequest: item.decision.informationRequest })),
    },
  };
}
