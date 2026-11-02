import {DomainError,type Job,type ResumeInput} from './domain.js';
import {BACKEND_VERSION,type Ref} from '../ontology/execution.js';
import type {ActionIntent} from '../ontology/actions.js';
import {canRecoverReadOnly} from './task-recovery.js';
import {continueExecutionBudget,remainingModelTurns,MIN_REASONING_TURNS} from './execution-budget.js';
import {restoreOriginalDeliverableInstruction} from './request-instructions.js';

/** Resume reuses existing authority; the caller checks the original PA and
 * current task grant, then persists this transition and its receipt together. */
export function assertTechnicalResumeState(job:Job,args:ResumeInput,contextId?:string):void{
  const d=job.delegation;
  if(d?.observationContract)throw new DomainError('CONFLICT','Observation contracts remain inactive until a reviewed observer is installed');
  if(contextId&&contextId!==job.contextId)throw new DomainError('INVALID_INPUT','Context does not match task');
  if(d?.backendVersion!==BACKEND_VERSION||job.state!=='paused'||job.revision!==args.expectedRevision)throw new DomainError('CONFLICT','Read the current technical pause before resuming this original task');
}

export function assertTechnicalResume(job:Job,args:ResumeInput,intents:Pick<ActionIntent,'effect'>[],contextId?:string,foundation=false):Ref|undefined{
  assertTechnicalResumeState(job,args,contextId);const d=job.delegation!;
  if(!canRecoverReadOnly(job,intents))throw new DomainError('FORBIDDEN','Unknown business effects require their original reconciliation path');
  if(!foundation)return;
  const previous=d.groundingDecisions?.at(-1)?.decision;
  const selected=d.agent?.programRef??d.suspendedAgent?.programRef??d.request.capabilityRef
    ??(previous?.kind==='resolve'&&previous.requestRevision===d.request.revision?previous.capabilityRef:undefined);
  return selected&&selected.id!=='eigos.goal'?selected:undefined;
}

export function applyTechnicalResume(job:Job,args:ResumeInput,intentCount:number):Job{
  const d=job.delegation!;job.updatedAt=new Date().toISOString();job.revision=(job.revision??0)+1;
  continueExecutionBudget(job,'recovery',args.executionBudget);
  if(remainingModelTurns(job)<MIN_REASONING_TURNS)throw new DomainError('CONFLICT','Task safety budget requires a policy change; confirmed facts must not be resubmitted');
  const restored=restoreOriginalDeliverableInstruction(job,intentCount>0);
  if(restored)d.events.push({at:job.updatedAt,event:'original_submission_instruction_restored',evidence:restored});
  if(d.recovery){d.recovery.state='scheduled';d.recovery.retryAt=job.updatedAt;d.recovery.nextAction='wait_for_retry';}
  job.state='working';d.phase='recovering';d.nextAt=0;delete job.question;delete job.error;
  d.events.push({at:job.updatedAt,event:'technical_resume_requested'});return job;
}
