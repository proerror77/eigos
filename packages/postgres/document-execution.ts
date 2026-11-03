import type {Client} from 'pg';
import {digest} from '../core/delegation.js';
import {DomainError,type Job} from '../core/domain.js';
import type {WorkClaim} from '../core/store.js';
import {executionBudgetStatus,remainingModelTurns} from '../core/execution-budget.js';
import {canRecoverReadOnly} from '../core/task-recovery.js';
import {resolveTaskRecovery} from '../core/task-recovery.js';
import {withModelUsage,type ModelUsageEvidence} from '../core/model-usage-context.js';
import {withModelDispatchGuard} from '../core/model-dispatch-context.js';
import {sealComposedOutputsProgram} from '../core/composed-actions.js';
import {DocumentAgentProgram} from '../capabilities/document-agent.js';
import {prepareDocumentInvocationProgram,buildDocumentResult,projectDocumentProgram,documentOutputPorts,type DocumentInvocation,type DocumentActionProgramContext} from '../capabilities/document-program.js';
import type {Executor} from '../capabilities/executor.js';
import type {AgentActionResult} from '../core/agent-program.js';
import type {ActionIntent,ActionResult,ExecutionAttempt} from '../ontology/actions.js';
import type {ObjectRef} from '../ontology/model.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {runGraphProgramAsync,type ProjectionMetadata} from '../ontology/graph-program.js';
import {SecurityError} from '../security/errors.js';
import type {PostgresDatabase} from './database.js';
import type {PostgresWorkerStore} from './worker-store.js';
import {postgresWorkReference,type PostgresWorkReference} from './work-claim.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {PostgresTaskStorage} from './task-storage.js';
import {withPostgresSourceProjection,type PostgresSourceProjectionOptions} from './source-projection.js';
import {createPostgresActionAuthorization,type PostgresActionAuthorizationOptions,type PostgresActionSemanticContext} from './action-authorization.js';
import {PostgresActionJournal} from './action-journal.js';
import {createPostgresDocumentPolicy,postgresDocumentContextProgram} from './document-policy.js';

interface Options {
  database:Pick<PostgresDatabase,'run'|'inspectClaim'>;
  store:Pick<PostgresWorkerStore,'readRequest'|'recordActionRun'|'beginModelUsage'|'finishModelUsage'>;
  executor:Executor&{readonly securityChannelId:string};
  modelChannel:string;policyDigest:string;sourceBindingId?:string;builder?:StagedKernelBuilder;maxTaskMs?:number;
}
interface Prepared {invocation:DocumentInvocation;attempt:ExecutionAttempt;input:Record<string,unknown>}
export type PostgresDocumentExecutionResult={intentId:string;attemptId:string;observationId:string}&({applied:true;object:ObjectRef}|{applied:false});
function fail(message:string):never{throw new DomainError('CONFLICT',message);}
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
function freezeData<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freezeData);Object.freeze(value);}return value;}
/** These are the actual prompt-bearing values of the bounded document call.
 * Preparation timestamps may change during a current preflight; original IDs,
 * source snapshots, fixed deadlines and all model-visible content may not. */
const invocationDigest=(value:DocumentInvocation)=>{
  const {createdAt:_created,updatedAt:_updated,messages,...job}=value.job;
  return digest({...value,job:{...job,messages:messages.map(({at:_at,...message})=>message)}});
};

/** Executes one already-persisted document action. It never chooses a plan,
 * creates a task, retries a dispatched operation or declares the whole goal
 * complete. All source projection and acceptance retain the original claim. */
export class PostgresDocumentExecution {
  private readonly database:Options['database'];private readonly store:Options['store'];private readonly executor:Options['executor'];
  private readonly modelChannel:string;private readonly policyDigest:string;private readonly sourceBindingId:string|undefined;private readonly builder:StagedKernelBuilder|undefined;
  private readonly maxTaskMs:number;private readonly program=new DocumentAgentProgram();
  constructor(options:Options){
    if(!/^[a-f0-9]{64}$/.test(options.policyDigest)||!options.modelChannel||options.modelChannel!==options.executor.securityChannelId
      ||options.sourceBindingId!==undefined&&(!options.sourceBindingId||options.sourceBindingId.length>200))throw new Error('Explicit registered document execution authority is required');
    this.maxTaskMs=options.maxTaskMs??86400000;if(!Number.isSafeInteger(this.maxTaskMs)||this.maxTaskMs<1||this.maxTaskMs>86400000)throw new Error('Invalid fixed document task deadline');
    this.database=options.database;this.store=options.store;this.executor=options.executor;this.modelChannel=options.modelChannel;this.policyDigest=options.policyDigest;this.sourceBindingId=options.sourceBindingId;this.builder=options.builder;
  }
  private source():PostgresSourceProjectionOptions{return {policyDigest:this.policyDigest,modelChannel:this.modelChannel,programRef:{...this.program.ref},configurationDigest:this.program.configurationDigest,sourceBindingId:this.sourceBindingId,action:'ComposeDocument',builder:this.builder,inspectClaim:claim=>this.database.inspectClaim(claim,this.policyDigest)};}
  private journal(client:Client,observation?:PostgresActionAuthorizationOptions['observation']){
    const options:PostgresActionAuthorizationOptions={policyDigest:this.policyDigest,modelChannel:this.modelChannel,inspectClaim:claim=>this.database.inspectClaim(claim,this.policyDigest),programs:[createPostgresDocumentPolicy()],builder:this.builder,maxTaskMs:this.maxTaskMs,...(observation?{observation}:{} )};
    return new PostgresActionJournal(client,{...options,authorize:createPostgresActionAuthorization(client,options)});
  }
  private select(job:Job,intent:ActionIntent){
    const state=job.delegation?.agent,plans=state?.plans.filter(value=>value.digest===intent.planDigest),plan=plans?.[0],step=plan?.steps[0];
    if(job.state!=='working'||!state||plans?.length!==1||!plan||!step||state.pendingPlanId!==plan.id||plan.steps.length!==1
      ||intent.jobId!==job.id||step.intentId!==intent.id||step.id!==intent.stepId||step.action!=='ComposeDocument'||step.effect!=='local')fail('Document execution requires its original single pending local step');
    if(step.inputRefs.length||step.acceptedInputs?.length)fail('Document accepted-input mapping requires the current PostgreSQL materialization proof');
    const input=structuredClone(intent.dispatchInput??step.input);if(!same(input,step.input))fail('The original document input changed');return {plan,step,input};
  }
  private async context(client:Client,claim:PostgresWorkReference,job:Job,intent:ActionIntent,graph:ProjectionMetadata,operation:PostgresActionSemanticContext['operation'],attempt?:ExecutionAttempt){
    const {plan,step,input}=this.select(job,intent),store=new PostgresTaskStorage(client,this.builder),intents=await store.intents(claim.owner,job.id);
    const current=intents.findIndex(value=>value.id===intent.id);if(current<0)fail('Original document intent is missing');intents[current]=intent;
    const admission=await postgresWorkerAdmission(client,claim.owner,job.id,this.policyDigest),validUntil=Math.min(admission.validUntil,Date.parse(canRecoverReadOnly(job,intents)&&!job.delegation?.agent?.paPayment?executionBudgetStatus(job).window.startedAt:job.createdAt)+this.maxTaskMs);
    return {model:graph.model,graph,owner:claim.owner,intents,validUntil,job,plan,step,intent,input,operation,...(attempt?{attempt}:{})} satisfies PostgresActionSemanticContext;
  }
  private async prepare(client:Client,claim:PostgresWorkReference,intentId:string,attempt?:ExecutionAttempt):Promise<Prepared>{
    const journal=this.journal(client),intent=await journal.intent(claim.owner,intentId),job=await new PostgresTaskStorage(client,this.builder).get(claim.owner,claim.job.id),selected=this.select(job,intent);
    if(remainingModelTurns(job)<this.program.modelCallsPerAction)fail('The original task has no remaining document model budget');
    if(intent.state!==(attempt?'dispatching':'ready'))fail('Started document action must retain its original result; automatic replay is prohibited');
    const original=attempt??await journal.startAttempt(claim,intentId,'dispatch',digest(selected.input));
    if(attempt)await journal.assertDispatchAllowed(claim,intentId,attempt.id);
    return withPostgresSourceProjection(client,claim,this.source(),async graph=>{
      const semantic=await this.context(client,claim,job,intent,graph,attempt?'dispatch_check':'dispatch',original);
      const ctx=await runGraphProgramAsync(graph,postgresDocumentContextProgram(semantic,this.program));
      const action:DocumentActionProgramContext={...ctx,planId:selected.plan.id,intentId,attemptId:original.id,modelRunId:selected.plan.modelRunId,operationKey:intent.businessOperationKey};
      return {invocation:await runGraphProgramAsync(graph,prepareDocumentInvocationProgram(this.program,action,'ComposeDocument',selected.input,true)),attempt:original,input:selected.input};
    });
  }
  async execute(supplied:WorkClaim,intentId:string,signal:AbortSignal):Promise<PostgresDocumentExecutionResult>{
    if(!intentId||intentId.length>200)throw new Error('Original document intent is required');signal.throwIfAborted();
    const claim=structuredClone(supplied),reference=postgresWorkReference(claim),prepared=freezeData(await this.database.run(client=>this.prepare(client,reference,intentId)));
    let response:AgentActionResult|undefined,receipt:{id:string}|undefined;
    const audit=()=>this.database.run(client=>this.journal(client).recordObservation(claim.owner,intentId,prepared.attempt.id,response?
      {kind:'confirmed',eventId:prepared.attempt.id,sourceVersion:prepared.attempt.ordinal,output:{source:response.value},evidenceRefs:response.evidenceRefs}:
      {kind:'unknown',eventId:prepared.attempt.id,sourceVersion:prepared.attempt.ordinal,evidenceRefs:[],message:'Document invocation ended without an accepted model response'}));
    try{
      let reserved:{id:string;runtime:string;startedAt:string;finishAttempted:boolean;finished?:{evidence:ModelUsageEvidence|undefined;outcome:string}}|undefined,dispatches=0;
      const raw=await withModelUsage({begin:async(id,runtime,startedAt)=>{
        if(reserved)fail('A document action cannot start multiple model invocations');
        await this.store.beginModelUsage(claim,id,runtime,startedAt);reserved={id,runtime,startedAt,finishAttempted:false};
      },finish:async(id,evidence,outcome)=>{
        if(!reserved||reserved.id!==id||reserved.finishAttempted)fail('Document model usage differs from its original reservation');reserved.finishAttempted=true;
        await this.store.finishModelUsage(claim,id,evidence,outcome);reserved.finished={evidence:structuredClone(evidence),outcome};
      }},()=>withModelDispatchGuard({channelId:this.modelChannel,authorize:async()=>{
        if(!reserved||reserved.finishAttempted||++dispatches!==1)fail('Document model dispatch requires its original acknowledged usage reservation');signal.throwIfAborted();
        const current=await this.database.run(client=>this.prepare(client,reference,intentId,prepared.attempt));
        if(invocationDigest(current.invocation)!==invocationDigest(prepared.invocation))fail('Document input or source evidence changed before model dispatch');
        if(prepared.invocation.evidenceValidUntil!==undefined&&prepared.invocation.evidenceValidUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');signal.throwIfAborted();
      }},async()=>{
        try{return await this.executor.run(prepared.invocation.job,signal);}
        finally{if(reserved&&!reserved.finishAttempted){reserved.finishAttempted=true;await this.store.finishModelUsage(claim,reserved.id,undefined,signal.aborted?'interrupted':'failed');}}
      }));
      if(!reserved||reserved.id!==raw.evidence.id||reserved.runtime!==raw.evidence.runtime||reserved.startedAt!==raw.evidence.startedAt||dispatches!==1
        ||reserved.finished?.outcome!=='completed'||reserved.finished.evidence?.completedAt!==raw.evidence.completedAt)fail('Document executor returned without its original acknowledged model boundaries');
      response=buildDocumentResult(prepared.invocation,raw);
      if(response.runEvidence?.purpose!=='document')fail('Actual document model receipt is required');
      const recorded=await this.store.recordActionRun(claim,{...response.runEvidence,purpose:'document'});
      receipt=await audit();if(!recorded)throw new SecurityError('ACCESS_REVOKED');signal.throwIfAborted();
      const actualResponse=response,observationId=receipt.id;let object:ObjectRef|undefined;
      const accepted=await this.database.run(client=>this.journal(client,{attemptId:prepared.attempt.id,response:actualResponse}).commitObservation(intentId,observationId,true,{claim:reference,apply:async(job,intent)=>{
        signal.throwIfAborted();await withPostgresSourceProjection(client,reference,this.source(),async graph=>{
          const semantic=await this.context(client,reference,job,intent,graph,'accept',prepared.attempt),ctx=await runGraphProgramAsync(graph,postgresDocumentContextProgram(semantic,this.program));
          const action:DocumentActionProgramContext={...ctx,planId:semantic.plan.id,intentId,attemptId:prepared.attempt.id,modelRunId:semantic.plan.modelRunId,operationKey:intent.businessOperationKey};
          object=await runGraphProgramAsync(graph,projectDocumentProgram(this.program,action,'ComposeDocument',prepared.input,actualResponse));
          const ports=job.delegation!.agent!.composition?await runGraphProgramAsync(graph,sealComposedOutputsProgram(action,semantic.step,prepared.input,actualResponse,object,intent,graph.model.action('ComposeDocument'),()=>documentOutputPorts(actualResponse,object!))):undefined;
          intent.acceptedOutput={object,...(ports?{ports}:{})};
          if(!job.delegation!.agent!.observations.some(value=>same(value,object)))job.delegation!.agent!.observations.push(object);
          resolveTaskRecovery(job,'source','ComposeDocument');job.updatedAt=new Date().toISOString();job.delegation!.nextAt=0;
          job.delegation!.events.push({at:job.updatedAt,event:'agent_observation_projected',evidence:digest(object)});signal.throwIfAborted();
        });
      }}));
      return accepted.applied?{intentId,attemptId:prepared.attempt.id,observationId,applied:true,object:object??fail('Committed document projection is missing')}:{intentId,attemptId:prepared.attempt.id,observationId,applied:false};
    }catch(error){
      if(!receipt)try{receipt=await audit();}catch(auditError){throw new AggregateError([error,auditError],'Document execution failed; original observation audit could not be acknowledged',{cause:error});}
      throw error;
    }
  }
}
