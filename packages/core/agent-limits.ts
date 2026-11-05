import type {AgentProgram} from './agent-program.js';
import {DomainError} from './domain.js';

export const AGENT_LIMITS={modelTurns:32,plans:8,actions:16} as const;
/** Shared host bounds; program metadata cannot raise them without validation. */
export function agentLimits(program?:Pick<AgentProgram,'limits'>){
  const limits=program?.limits??AGENT_LIMITS;
  if(!Number.isInteger(limits.modelTurns)||limits.modelTurns<1||limits.modelTurns>80||!Number.isInteger(limits.plans)||limits.plans<1||limits.plans>24||!Number.isInteger(limits.actions)||limits.actions<1||limits.actions>64)
    throw new DomainError('CONFLICT','Agent execution limits are outside the bounded host policy');
  return limits;
}
