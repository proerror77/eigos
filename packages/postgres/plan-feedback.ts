import {DomainError,type Job} from '../core/domain.js';
import {digest} from '../core/delegation.js';
import {MIN_REASONING_TURNS,remainingModelTurns,pauseExecutionBudget} from '../core/execution-budget.js';
import {scheduleTaskRecovery} from '../core/task-recovery.js';
import type {ActionIntent} from '../ontology/actions.js';

const messages={
  task_scope:'Read the task scope before selecting actions',
  dependencies:'Step IDs must be unique and dependencies must precede their consumers',
  component_scope:'Read this component scope before selecting its actions',
  arguments:'Action arguments do not match the registered schema; remove unrecognized fields and use its exact parameter types',
  references:'Read referenced ontology objects before selecting an action',
  local_frontier:'Local handoff actions require their own frontier',
} as const;
/** Created only by explicit checks after original model-decision validation,
 * before any new intent is committed. The enclosing plan transaction rolls
 * back before the coordinator records this bounded, non-private feedback. */
export class PostgresPlanValidationFeedback extends DomainError {
  constructor(readonly kind:keyof typeof messages,readonly modelRunId:string,readonly requestRevision:number,readonly decisionDigest:string){
    super('CONFLICT',messages[kind]);
  }
}

/** No generic DomainError/SecurityError enters this path. In particular it
 * cannot authorize another attempt after an uncertain dispatch. */
export function recordPostgresPlanFeedback(job:Job,intents:readonly ActionIntent[],error:PostgresPlanValidationFeedback):void{
  const d=job.delegation,state=d?.agent;
  if(job.state!=='working'||!d||!state||state.pendingPlanId||d.request.revision!==error.requestRevision||state.requestRevision!==error.requestRevision
    ||state.plans.some(plan=>plan.modelRunId===error.modelRunId)
    ||!job.runs?.some(run=>run.id===error.modelRunId&&run.purpose==='planning'&&run.decisionDigest===error.decisionDigest)
    ||intents.some(intent=>!['effect_confirmed','rejected','canceled_before_dispatch'].includes(intent.state)))
    throw new DomainError('CONFLICT','Plan feedback no longer belongs to a safe original planning boundary');
  const at=new Date().toISOString(),message=messages[error.kind];
  state.feedback.push({at,kind:'validation',message,inputDigest:error.decisionDigest});
  d.phase='planning';d.nextAt=0;job.updatedAt=at;
  d.events.push({at,event:'agent_plan_validation_feedback',evidence:digest({kind:error.kind,modelRunId:error.modelRunId,decisionDigest:error.decisionDigest})});
  if(state.feedback.filter(value=>value.kind==='validation'&&value.message===message).length>=3)
    scheduleTaskRecovery(job,'validation_stalled','自动规划持续未通过校验，原任务与已确认结果已保留。',{automatic:false});
  else if(remainingModelTurns(job)<MIN_REASONING_TURNS)pauseExecutionBudget(job,'modelTurns','window');
}
