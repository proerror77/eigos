import {PostgresRideExecution} from './ride-execution.js';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {z} from 'zod';
import {digest,groundingSchema,type Grounding} from '../core/delegation.js';
import {DomainError,ConnectionAuthorizationRequired,type Job} from '../core/domain.js';
import type {WorkClaim} from '../core/store.js';
import {executionBudgetStatus,remainingModelTurns,MIN_REASONING_TURNS,pauseExecutionBudget} from '../core/execution-budget.js';
import {canRecoverReadOnly,resolveTaskRecovery,scheduleTaskRecovery,resumeScheduledRecovery} from '../core/task-recovery.js';
import {withModelUsage,type ModelUsageEvidence} from '../core/model-usage-context.js';
import {withModelDispatchGuard} from '../core/model-dispatch-context.js';
import {GoalProgram,goalState} from '../coordinator/goal-program.js';
import {groundRequirements} from '../coordinator/requirements.js';
import {groundConditions} from '../coordinator/conditions.js';
import type {Reasoner,PlanningAccess} from '../coordinator/coordinator.js';
import type {Executor,RunEvidence} from '../capabilities/executor.js';
import {BACKEND_VERSION} from '../ontology/execution.js';
import {agentDecisionSchema} from '../ontology/agent-actions.js';
import {createGoalContract} from '../core/goal-contract.js';
import {createGoalCoverage,assertGoalCoverage} from '../ontology/goal-coverage.js';
import {SecurityError} from '../security/errors.js';
import type {PostgresDatabase} from './database.js';
import {PostgresWorkerStore} from './worker-store.js';
import {PostgresTaskStorage} from './task-storage.js';
import {postgresWorkReference,postgresClaimSnapshotMatches} from './work-claim.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {postgresBusinessSchema,postgresBusinessAuthorityDigest,postgresRequireLeaseAtCommit} from './runtime-transaction.js';
import {postgresPrepareWorkerSeal,postgresRecordWorkerOutputs} from './worker-output.js';
import {postgresRecordClaimRelease} from './claim-release.js';
import {PostgresNativePlanningSession} from './native-planning-session.js';
import {discoverPostgresDocumentActions,discoverPostgresDocumentBindings,type PostgresDocumentBindingOptions} from './document-bindings.js';
import {PostgresReadProgramRegistry} from './didi-registry.js';
import {PostgresDidiExecution} from './didi-execution.js';
import {PostgresDocumentExecution} from './document-execution.js';
import {installPostgresAgentPlan} from './agent-plan.js';
import {preparePostgresGoalContexts,postgresGoalProgram} from './goal-contexts.js';
import {postgresGoalReviewContext,postgresAgentPlanningContext} from './model-context.js';
import {acceptPostgresGoal} from './goal-acceptance.js';
import {PostgresCallerActionExecution} from './caller-action.js';

/** Host registry contract: the implementation must await model-usage begin and
 * finish and invoke the actual dispatch guard before sending any prompt. A
 * legacy synchronous recorder implementation is not a PostgreSQL model port. */
export interface PostgresModelDispatchContract {readonly postgresModelDispatch:'acknowledged-v1'}
export type PostgresReasoner=Reasoner&PostgresModelDispatchContract;
export type PostgresExecutor=Executor&{readonly securityChannelId:string}&PostgresModelDispatchContract;
export interface PostgresCoordinatorOptions extends Omit<PostgresDocumentBindingOptions,'inspectClaim'> {
  database:Pick<PostgresDatabase,'run'|'inspectClaim'>;
  store:PostgresWorkerStore;
  reasoner:PostgresReasoner;
  executor:PostgresExecutor;
  maxTaskMs?:number;
}
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
function fail(message:string):never{throw new DomainError('CONFLICT',message);}
/** Counts are host bookkeeping. Never spread stored budget/recovery records
 * into a prompt: imported records may carry fields outside this DTO. */
function budgetView(job:Job):ReturnType<typeof executionBudgetStatus>{
  const status=executionBudgetStatus(job),window=status.window,integer=z.number().int().nonnegative().safe(),counts=z.strictObject({modelTurns:integer,plans:integer,actions:integer});
  counts.parse(status.limits.window);counts.parse(status.limits.task);
  return {version:z.literal('1').parse(status.version),profile:z.enum(['standard','extended']).parse(status.profile),limits:{window:{...status.limits.window},task:{...status.limits.task}},used:counts.parse(status.used),windowUsed:counts.parse(status.windowUsed),
    window:{sequence:z.number().int().positive().safe().parse(window.sequence),reason:z.enum(['initial','input','source','automatic','recovery']).parse(window.reason),requestRevision:z.number().int().positive().safe().parse(window.requestRevision),startedAt:z.iso.datetime({offset:true}).parse(window.startedAt),baseline:counts.parse(window.baseline),...(window.progressBaseline===undefined?{}:{progressBaseline:integer.parse(window.progressBaseline)})},
    paused:status.paused?z.strictObject({resource:z.enum(['modelTurns','plans','actions','time','reasoning']),scope:z.enum(['window','task']),at:z.iso.datetime({offset:true})}).parse(status.paused):undefined};
}

/** Actual PostgreSQL business loop. One claim advances one durable phase, then
 * the outer Worker releases it. Models/providers run only between committed
 * storage calls. This candidate supports registered document composition;
 * unavailable adapters retain the same original task and fail explicitly. */
export class PostgresCoordinator {
  private readonly runtime:PostgresReadProgramRegistry;
  private readonly didi:PostgresDidiExecution;private readonly rides:PostgresRideExecution;
  private readonly options:PostgresDocumentBindingOptions;
  private readonly execution:PostgresDocumentExecution;
  private readonly maximum:number;
  constructor(private readonly configured:PostgresCoordinatorOptions){
    if(configured.reasoner.postgresModelDispatch!=='acknowledged-v1'||configured.executor.postgresModelDispatch!=='acknowledged-v1')throw new Error('PostgreSQL model ports require acknowledged usage and a current pre-dispatch guard');
    if(configured.reasoner.securityChannelId!==configured.modelChannel||configured.executor.securityChannelId!==configured.modelChannel)throw new Error('The existing registered model channel must match both configured model ports');
    this.runtime=configured.registry??new PostgresReadProgramRegistry(configured.policyDigest,{documentSourceBindingId:configured.sourceBindingId});
    if(!(this.runtime instanceof PostgresReadProgramRegistry)||this.runtime.policyDigest!==configured.policyDigest)throw new Error('Actual current PostgreSQL program registry is required');
    this.options={semantic:configured.semantic,registry:this.runtime,policyDigest:configured.policyDigest,modelChannel:configured.modelChannel,builder:configured.builder,sourceBindingId:configured.sourceBindingId,inspectClaim:claim=>configured.database.inspectClaim(claim,configured.policyDigest)};
    this.maximum=configured.maxTaskMs??86400000;if(!Number.isSafeInteger(this.maximum)||this.maximum<1||this.maximum>86400000)throw new Error('Invalid original task execution deadline');
    this.execution=new PostgresDocumentExecution({...configured,modelChannel:configured.modelChannel,policyDigest:configured.policyDigest});
    this.rides=new PostgresRideExecution({...configured,registry:this.runtime,modelChannel:configured.modelChannel,policyDigest:configured.policyDigest});
    this.didi=new PostgresDidiExecution({...configured,registry:this.runtime,modelChannel:configured.modelChannel,policyDigest:configured.policyDigest});
  }
  private load(claim:WorkClaim){return this.configured.database.run(client=>new PostgresTaskStorage(client,this.options.builder).get(claim.owner,claim.job.id));}
  /** Host task transition, with the same original claim and output fences as
   * the store's checked mutation path. No raw state is sent to a model. */
  private transition(claim:WorkClaim,change:(job:Job,client:Client)=>Promise<void>|void,mode:{operationalOnly?:boolean;release?:boolean}={}):Promise<boolean>{
    const reference=postgresWorkReference(claim);
    return this.configured.database.run(async client=>{
      if(!await this.options.inspectClaim(reference)||!await postgresClaimSnapshotMatches(client,reference,this.options.policyDigest))return false;
      const admission=await postgresWorkerAdmission(client,claim.owner,claim.job.id,this.options.policyDigest),store=new PostgresTaskStorage(client,this.options.builder),job=await store.get(claim.owner,claim.job.id);
      const immutable=digest({id:job.id,owner:claim.owner,contextId:job.contextId,goal:job.goal,revision:job.revision,requestRevision:job.delegation?.request.revision,release:job.delegation?.ontologyRelease});
      const content=(value:Job)=>{const {state:_state,updatedAt:_updated,question:_question,error:_error,delegation,...body}=value;const {phase:_phase,nextAt:_next,events:_events,recovery:_recovery,recoveryHistory:_history,...authority}=delegation!;return digest({...body,delegation:authority});};
      const original=mode.operationalOnly?content(job):undefined,question=job.question,error=job.error;
      await change(job,client);
      if(immutable!==digest({id:job.id,owner:claim.owner,contextId:job.contextId,goal:job.goal,revision:job.revision,requestRevision:job.delegation?.request.revision,release:job.delegation?.ontologyRelease}))fail('Coordinator cannot replace the original owner task or request revision');
      if(mode.operationalOnly&&(content(job)!==original||job.question!==undefined&&job.question!==question||job.error!==undefined&&job.error!==error))fail('Operational recovery cannot alter or publish task content');
      const seal=mode.operationalOnly?undefined:await postgresPrepareWorkerSeal(client,reference,this.options.policyDigest,this.options.builder,this.options.inspectClaim);
      await store.save(claim.owner,job);if(seal)await postgresRecordWorkerOutputs(client,claim.owner,job,seal);
      const q=`"${postgresBusinessSchema(client)}"`,headers=await client.query(`SELECT 1 FROM ${q}.work_claims c JOIN ${q}.runtime_work_claims r ON r.job_id=c.job_id AND r.token=c.token WHERE c.job_id=$1 AND c.token=$2 AND c.revision=$3 AND r.authority_digest=$4`,[job.id,claim.token,claim.job.revision??0,postgresBusinessAuthorityDigest(client)]);
      const current=await postgresWorkerAdmission(client,claim.owner,job.id,this.options.policyDigest);
      if(headers.rowCount!==1||!same(admission,current)||!await this.options.inspectClaim(reference))throw new SecurityError('ACCESS_REVOKED');
      postgresRequireLeaseAtCommit(client,digest(reference),()=>this.options.inspectClaim(reference));
      if(mode.release){await postgresRecordClaimRelease(client,claim.owner,job.id,claim.token);await client.query(`DELETE FROM ${q}.runtime_work_claims WHERE job_id=$1 AND token=$2`,[job.id,claim.token]);}
      return true;
    });
  }
  private async available(claim:WorkClaim,signal:AbortSignal){
    signal.throwIfAborted();
    const {request,ready}=await this.configured.store.withAuthorizedRequest(claim,this.options.modelChannel,async(request,client)=>{
      let ready=false;for(const entry of this.runtime.entries)for(const actionId of entry.program.actionIds){const page=await discoverPostgresDocumentBindings(client,claim,request,{actionId,programRef:entry.program.ref},this.options);if(page.items.some(item=>item.bindings.some(binding=>binding.readiness==='ready')))ready=true;}return {request,ready};
    });
    if(!ready)throw new SecurityError('SOURCE_NOT_AUTHORIZED','The requested task has no current registered PostgreSQL readonly binding');
    signal.throwIfAborted();return request;
  }
  private async access(claim:WorkClaim,job:Job,purpose:'grounding'|'agent',signal:AbortSignal,bootstrapComplete=true){
    const state=job.delegation?.agent,refs=[...(state?[state.scope,...state.observations]:[]),...(state?.composition?.contexts??[]).filter(component=>!state?.composition?.retiredContexts?.some(retired=>retired.id===component.id)).map(component=>component.scope)];
    const session=await PostgresNativePlanningSession.create(this.configured.store,claim,this.options.policyDigest,this.options.modelChannel,{builder:this.options.builder,signal,boundRefs:refs,readScope:'request',priorReads:job.delegation?.ontologyReads,actionCatalog:this.runtime.catalog,
      taskContext:{purpose,refs,capabilityDirectory:{bootstrapComplete,discoveryTool:'discover_actions'}},
      discoverActions:(graph,owner,request,input,context)=>discoverPostgresDocumentActions(graph,owner,request,input,context,this.options)});
    claim.modelContextKey=session.modelSessionKey();
    const record=async(evidence:RunEvidence)=>{if(!await this.configured.store.recordRun(claim,evidence,purpose==='grounding'?'request_interpreted':'agent_decision'))throw new SecurityError('ACCESS_REVOKED');};
    const access:PlanningAccess={session,maxTurns:remainingModelTurns(job),executionBudget:budgetView(job),bootstrapComplete,initialPrograms:[],record};
    return {session,access,record};
  }
  private async model<T extends {evidence:RunEvidence}>(claim:WorkClaim,signal:AbortSignal,event:string,preflight:()=>Promise<void>,run:()=>Promise<T>):Promise<T>{
    let active:{id:string;runtime:string;startedAt:string;dispatched:boolean;finishAttempted?:boolean;outcome?:'completed'|'failed'|'interrupted';finished?:ModelUsageEvidence}|undefined,attempts=0;
    const maximum=remainingModelTurns(await this.load(claim));
    const result=await withModelUsage({begin:async(id,runtime,at)=>{
      if(active&&active.outcome===undefined)fail('A model invocation is already in progress');
      if(++attempts>maximum||remainingModelTurns(await this.load(claim))<1)fail('The original task has no remaining reasoning budget');
      await this.configured.store.beginModelUsage(claim,id,runtime,at);active={id,runtime,startedAt:at,dispatched:false};
    },finish:async(id,evidence,outcome)=>{
      if(!active||active.id!==id||active.finishAttempted)fail('Model usage differs from its original invocation');active.finishAttempted=true;
      await this.configured.store.finishModelUsage(claim,id,evidence,outcome);active.outcome=outcome;if(evidence)active.finished=structuredClone(evidence);
    }},()=>withModelDispatchGuard({channelId:this.options.modelChannel,authorize:async()=>{
      if(!active||active.finishAttempted||active.dispatched)fail('Model dispatch requires its original acknowledged usage reservation');
      await preflight();signal.throwIfAborted();active.dispatched=true;
    }},run));
    if(!active||!active.dispatched||active.outcome!=='completed'||active.id!==result.evidence.id||active.runtime!==result.evidence.runtime||active.startedAt!==result.evidence.startedAt||active.finished?.completedAt!==result.evidence.completedAt)fail('Model returned without its acknowledged original usage and dispatch boundaries');
    signal.throwIfAborted();
    if(!await this.configured.store.recordRun(claim,result.evidence,event))throw new SecurityError('ACCESS_REVOKED');
    return result;
  }
  async run(claim:WorkClaim,signal:AbortSignal):Promise<void>{
    try{
    signal.throwIfAborted();const job=await this.load(claim),d=job.delegation;
    if(!d||d.backendVersion!==BACKEND_VERSION||claim.recovery||d.plan||d.suspendedAgent)throw new SecurityError('AUTHORITY_UNAVAILABLE','This PostgreSQL candidate has no installed legacy or terminal-effect recovery adapter');
    if(d.callerAction){await new PostgresCallerActionExecution({database:this.configured.database,policyDigest:this.options.policyDigest,builder:this.options.builder,maxTaskMs:this.maximum}).run(claim,signal);return;}
    const intents=await this.configured.database.run(client=>new PostgresTaskStorage(client,this.options.builder).intents(claim.owner,job.id));
    if(Date.now()>Date.parse(canRecoverReadOnly(job,intents)?executionBudgetStatus(job).window.startedAt:job.createdAt)+this.maximum){await this.transition(claim,current=>pauseExecutionBudget(current,'time','window'));return;}
    if(remainingModelTurns(job)<MIN_REASONING_TURNS&&!d.agent?.pendingPlanId){await this.transition(claim,current=>pauseExecutionBudget(current,'modelTurns','window'));return;}
    if(d.recovery?.state==='scheduled'){await this.transition(claim,current=>resumeScheduledRecovery(current));}
    if(!d.agent){await this.ground(claim,job,signal);return;}
    const program=postgresGoalProgram(job);
    if(!d.goalCoverage||d.goalCoverage.requestDigest!==digest(d.request)){await this.cover(claim,program,signal);return;}
    assertGoalCoverage(job,program.capability());
    if(d.agent.pendingPlanId){
      const plan=d.agent.plans.find(value=>value.id===d.agent!.pendingPlanId);if(!plan)fail('The original pending plan is missing');
      for(const step of plan.steps){
        const intent=intents.find(value=>value.id===step.intentId);if(!intent)fail('The original plan intent is missing');
        if(intent.state==='effect_confirmed')continue;
        if(intent.state!=='ready')throw new SecurityError('AUTHORITY_UNAVAILABLE','An original dispatched operation must be reconciled; automatic replay is prohibited');
        const entry=this.runtime.require(step.binding?.programRef??plan.programRef,step.binding?.configurationDigest??plan.programDigest);
        if(entry.kind==='document'&&step.action==='ComposeDocument'&&step.effect==='local')await this.execution.execute(claim,intent.id,signal);
        else if(entry.kind==='ride'&&step.effect==='read')await this.rides.execute(claim,intent.id,signal);
        else if(entry.kind==='didi'&&step.effect==='read')await this.didi.execute(claim,intent.id,signal);
        else throw new SecurityError('AUTHORITY_UNAVAILABLE','The selected program has no installed PostgreSQL execution adapter');
      }
      await this.transition(claim,current=>{delete current.delegation!.agent!.pendingPlanId;current.delegation!.phase='planning';current.delegation!.nextAt=0;});return;
    }
    await this.act(claim,job,program,signal);
    }finally{if(claim.modelContextKey)await this.configured.reasoner.closeTask?.(claim.modelContextKey);}
  }
  private async ground(claim:WorkClaim,job:Job,signal:AbortSignal){
    const page=await this.configured.store.catalogue(claim,this.runtime.entries.map(entry=>({program:entry.program,capability:entry.program.capability()})),this.options.modelChannel);
    if(!page.items.length)throw new SecurityError('AUTHORITY_UNAVAILABLE','The requested service is not covered by the currently installed PostgreSQL runtime');
    const request=await this.available(claim,signal),{session,access}=await this.access(claim,job,'grounding',signal,!page.hasMore);
    try{
      const response=await this.model(claim,signal,'request_interpreted',async()=>{await this.available(claim,signal);await session.authorizeModel(this.options.modelChannel);},()=>this.configured.reasoner.ground(request,page.items,signal,access));
      const decision=groundingSchema.parse(response.decision),reads=await session.finish();
      if(response.evidence.decisionDigest!==digest(decision)||decision.requestRevision!==request.revision)fail('Grounding differs from the original recorded model decision');
      if(decision.kind==='unsupported'||decision.kind==='clarify'){
        await this.transition(claim,current=>{current.state=decision.kind==='clarify'?'input-required':'rejected';current.updatedAt=new Date().toISOString();current.delegation!.phase=decision.kind==='clarify'?'clarifying':'rejected';if(decision.kind==='clarify')current.question=decision.message;else current.error=decision.message;});return;
      }
      if(decision.kind!=='compose')throw new SecurityError('AUTHORITY_UNAVAILABLE','This native PostgreSQL path requires the actual composed-goal decision; resolve and initial-selection adapters are not installed');
      const capabilities=this.runtime.entries.map(entry=>entry.program.capability());
      const fixed=groundConditions(groundRequirements(request,decision.requirementsJson,capabilities.flatMap(value=>value.outcomePredicates??[]),capabilities.flatMap(value=>value.requirementRoles??[]),capabilities.flatMap(value=>value.predicates.map(predicate=>predicate.id))),decision.conditionsJson,session.retrievedRefs());
      const normalized={...fixed,successCriteria:fixed.successCriteria??[],conditions:fixed.conditions??[],confirmedInputs:fixed.confirmedInputs??{}};
      await this.transition(claim,current=>{
        if(current.delegation!.agent||current.delegation!.request.revision!==decision.requestRevision)fail('The original grounding phase changed');
        const goal=createGoalContract(normalized,current.delegation!.ontologyRelease!,JSON.parse(decision.criteriaJson),capabilities);
        current.delegation!.request=normalized;current.delegation!.agent=goalState(normalized,goal);current.delegation!.phase='planning';current.delegation!.nextAt=0;
        current.delegation!.groundingDecisions=[...(current.delegation!.groundingDecisions??[]),{modelRunId:response.evidence.id,decision:structuredClone(decision)}];
        current.updatedAt=new Date().toISOString();resolveTaskRecovery(current,'decision');current.delegation!.events.push({at:current.updatedAt,event:'agent_goal_fixed',evidence:goal.digest});
      });
      void reads; // The native session validated its actual durable receipts.
    }finally{session.close();}
  }
  private async cover(claim:WorkClaim,program:GoalProgram,signal:AbortSignal){
    if(!this.configured.reasoner.reviewGoal)fail('The configured runtime has no independent whole-goal reviewer');
    const context=await this.configured.database.run(client=>postgresGoalReviewContext(client,claim,program,{...this.options,componentPrograms:this.runtime.entries.map(entry=>entry.program)}));
    const response=await this.model(claim,signal,'goal_coverage_reviewed',async()=>{
      const fresh=await this.configured.database.run(client=>postgresGoalReviewContext(client,claim,program,{...this.options,componentPrograms:this.runtime.entries.map(entry=>entry.program)}));if(!same(fresh.context,context.context))throw new SecurityError('POLICY_CHANGED');
    },()=>this.configured.reasoner.reviewGoal!(context.context,signal));
    const proof=createGoalCoverage(context.context,response.decision,response.evidence);
    await this.transition(claim,async(current,client)=>{
      const fresh=await postgresGoalReviewContext(client,claim,postgresGoalProgram(current),{...this.options,componentPrograms:this.runtime.entries.map(entry=>entry.program)});if(!same(fresh.context,context.context))throw new SecurityError('POLICY_CHANGED');
      if(current.delegation!.goalCoverage)current.delegation!.goalCoverageHistory=[...(current.delegation!.goalCoverageHistory??[]),current.delegation!.goalCoverage];current.delegation!.goalCoverage=proof;
      current.updatedAt=new Date().toISOString();current.delegation!.events.push({at:current.updatedAt,event:'goal_coverage_recorded',evidence:proof.digest});
      if(proof.review.verdict!=='covered'){current.state=proof.review.verdict==='clarify'?'input-required':'rejected';current.delegation!.phase=proof.review.verdict==='clarify'?'clarifying':'rejected';if(proof.review.verdict==='clarify')current.question=proof.review.message;else current.error=proof.review.message;}
    });
  }
  private async act(claim:WorkClaim,job:Job,program:GoalProgram,signal:AbortSignal){
    if(!this.configured.reasoner.act)fail('The configured model has no Agent decision port');
    const dto=await this.configured.database.run(client=>postgresAgentPlanningContext(client,claim,program,{...this.options,componentPrograms:this.runtime.entries.map(entry=>entry.program)})),{session,access}=await this.access(claim,job,'agent',signal);
    access.executionBudget=dto.executionBudget;access.maxTurns=Math.min(access.maxTurns,dto.maxTurns);
    try{
      const response=await this.model(claim,signal,'agent_decision',async()=>{
        await this.available(claim,signal);const fresh=await this.configured.database.run(client=>postgresAgentPlanningContext(client,claim,program,{...this.options,componentPrograms:this.runtime.entries.map(entry=>entry.program)}));if(!same(fresh.context,dto.context))throw new SecurityError('POLICY_CHANGED');await session.authorizeModel(this.options.modelChannel);
      },()=>this.configured.reasoner.act!(dto.context,signal,access));
      const decision=agentDecisionSchema.parse(response.decision),reads=await session.finish(),configured={...this.options,programs:this.runtime.policies(),maxTaskMs:this.maximum};
      signal.throwIfAborted();
      if(decision.kind==='prepare')await this.configured.database.run(client=>preparePostgresGoalContexts(client,claim,decision,response.evidence.id,reads,configured));
      else if(decision.kind==='execute')await this.configured.database.run(client=>installPostgresAgentPlan(client,claim,decision,response.evidence.id,reads,configured));
      else if(decision.kind==='complete')await this.configured.database.run(client=>acceptPostgresGoal(client,claim,decision,response.evidence.id,reads,this.options));
      else throw new SecurityError('AUTHORITY_UNAVAILABLE','The selected component has no installed PostgreSQL clarification/infeasibility semantic verifier');
    }finally{session.close();}
  }
  async onError(claim:WorkClaim,error:unknown,signal:AbortSignal){
    if(signal.aborted||!await this.configured.store.active(claim))return;
    const unavailable=error instanceof SecurityError||error instanceof ConnectionAuthorizationRequired;
    await this.transition(claim,job=>{
      scheduleTaskRecovery(job,unavailable?'source_authorization_required':'worker_interrupted',unavailable?'当前服务授权或执行适配尚未就绪，已保留原任务和原操作。':'执行在已确认的下一阶段之前中断，已保留原任务和原操作。',{automatic:false});
    },{operationalOnly:true,release:true});
  }
  async closeModelContexts(){await this.configured.reasoner.closeTask?.();}
}
