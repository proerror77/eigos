import type {Client} from 'pg';
import {digest} from '../core/delegation.js';
import {DomainError,type Job} from '../core/domain.js';
import type {WorkClaim} from '../core/store.js';
import {executionBudgetStatus} from '../core/execution-budget.js';
import {canRecoverReadOnly,resolveTaskRecovery} from '../core/task-recovery.js';
import {sealComposedOutputsProgram} from '../core/composed-actions.js';
import {validateDidiProgram,validateDidiPlanningProgram,resolveDidiCallProgram,didiCallContext,buildDidiReadResult,projectDidiProgram,didiOutputPorts,type DidiResolvedCall,type DidiReadInvocationContext} from '../capabilities/didi/program.js';
import type {DidiCallContext} from '../capabilities/didi/connector.js';
import type {AgentActionResult} from '../core/agent-program.js';
import type {ActionIntent,ExecutionAttempt} from '../ontology/actions.js';
import type {ObjectRef} from '../ontology/model.js';
import {checkedRideEstimate} from '../ontology/ride-estimate-projection.js';
import {runGraphProgramAsync,type ProjectionMetadata} from '../ontology/graph-program.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {SecurityError} from '../security/errors.js';
import type {PostgresDatabase} from './database.js';
import {PostgresReadProgramRegistry,type PostgresReadRegistration} from './didi-registry.js';
import {postgresDidiContextProgram,didiActionContext} from './didi-policy.js';
import {PostgresActionJournal} from './action-journal.js';
import {createPostgresActionAuthorization,type PostgresActionSemanticContext} from './action-authorization.js';
import {PostgresProjectionGraph} from './projection-graph.js';
import {PostgresTaskStorage} from './task-storage.js';
import {withPostgresSourceProjection,withPostgresDidiCanonicalSourceProjection,type PostgresSourceProjectionOptions} from './source-projection.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {postgresWorkReference,type PostgresWorkReference} from './work-claim.js';

interface Options {database:Pick<PostgresDatabase,'run'|'inspectClaim'>;registry:PostgresReadProgramRegistry;policyDigest:string;modelChannel:string;builder?:StagedKernelBuilder;maxTaskMs?:number}
interface Prepared {entry:PostgresReadRegistration;attempt:ExecutionAttempt;input:Record<string,unknown>;action:string;call:DidiResolvedCall;wire:DidiCallContext;invocation:DidiReadInvocationContext}
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
function fail(message:string):never{throw new DomainError('CONFLICT',message);}

/** One original read intent, actual source Agent transport, durable receipt
 * and same-transaction independent domain projection. It chooses no recipe,
 * starts no model, creates no task and never retries an uncertain dispatch. */
export class PostgresDidiExecution {
  private readonly maximum:number;
  constructor(private readonly options:Options){
    if(!(options.registry instanceof PostgresReadProgramRegistry)||options.registry.policyDigest!==options.policyDigest||!options.modelChannel)throw new Error('Actual configured DiDi registry and model read channel are required');
    this.maximum=options.maxTaskMs??86400000;if(!Number.isSafeInteger(this.maximum)||this.maximum<1||this.maximum>86400000)throw new Error('Invalid fixed DiDi task deadline');
  }
  private source(entry:PostgresReadRegistration,action:string):PostgresSourceProjectionOptions{return {policyDigest:this.options.policyDigest,modelChannel:this.options.modelChannel,builder:this.options.builder,programRef:entry.program.ref,configurationDigest:entry.program.configurationDigest,sourceBindingId:entry.sourceBindingId,action,inspectClaim:claim=>this.options.database.inspectClaim(claim,this.options.policyDigest)};}
  private journal(client:Client,observation?:{attemptId:string;response:AgentActionResult}){
    const options={policyDigest:this.options.policyDigest,modelChannel:this.options.modelChannel,builder:this.options.builder,maxTaskMs:this.maximum,programs:this.options.registry.policies(),inspectClaim:(claim:PostgresWorkReference)=>this.options.database.inspectClaim(claim,this.options.policyDigest),...(observation?{observation}:{})};
    return new PostgresActionJournal(client,{...options,authorize:createPostgresActionAuthorization(client,options)});
  }
  private select(job:Job,intent:ActionIntent){
    const state=job.delegation?.agent,plans=state?.plans.filter(plan=>plan.digest===intent.planDigest),plan=plans?.[0],steps=plan?.steps.filter(step=>step.intentId===intent.id),step=steps?.[0];
    if(job.state!=='working'||!state||plans?.length!==1||!plan||steps?.length!==1||!step||state.pendingPlanId!==plan.id||intent.jobId!==job.id||step.id!==intent.stepId||step.effect!=='read'||!['SearchDidiPlaces','EstimateDidiRide'].includes(step.action)||step.inputRefs.length||step.acceptedInputs?.length)fail('DiDi requires its exact original pending readonly action');
    const entry=this.options.registry.require(step.binding?.programRef??plan.programRef,step.binding?.configurationDigest??plan.programDigest);if(entry.kind!=='didi'||!entry.didi)throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    const input=structuredClone(intent.dispatchInput??step.input);if(!same(input,step.input))fail('DiDi original input cannot be rematerialized or replaced');return {plan,step,input,entry};
  }
  private async context(client:Client,claim:PostgresWorkReference,job:Job,intent:ActionIntent,graph:ProjectionMetadata,operation:PostgresActionSemanticContext['operation'],attempt:ExecutionAttempt){
    const selected=this.select(job,intent),intents=await new PostgresTaskStorage(client,this.options.builder).intents(claim.owner,job.id),index=intents.findIndex(value=>value.id===intent.id);if(index<0)fail('Original DiDi intent is missing');intents[index]=intent;
    const admission=await postgresWorkerAdmission(client,claim.owner,job.id,this.options.policyDigest),validUntil=Math.min(admission.validUntil,Date.parse(canRecoverReadOnly(job,intents)?executionBudgetStatus(job).window.startedAt:job.createdAt)+this.maximum);
    return {model:graph.model,graph,owner:claim.owner,intents,validUntil,job,plan:selected.plan,step:selected.step,intent,input:selected.input,operation,attempt} satisfies PostgresActionSemanticContext;
  }
  private async prepare(client:Client,claim:PostgresWorkReference,intentId:string,previous?:ExecutionAttempt):Promise<Prepared>{
    const store=new PostgresTaskStorage(client,this.options.builder),journal=this.journal(client);let intent=await journal.intent(claim.owner,intentId);
    const job=await store.get(claim.owner,claim.job.id),selected=this.select(job,intent);await this.options.registry.assertConfigured(client,selected.entry,claim,job);
    if(intent.state!==(previous?'dispatching':'ready'))fail('A dispatched DiDi read retains its original outcome; automatic replay is prohibited');
    if(!previous&&!intent.dispatchInput){intent.dispatchInput=structuredClone(selected.input);await store.saveIntent(claim.owner,intent);}
    const attempt=previous??await journal.startAttempt(claim,intentId,'dispatch',digest(selected.input));if(previous)await journal.assertDispatchAllowed(claim,intentId,attempt.id);intent=await journal.intent(claim.owner,intentId);
    return withPostgresSourceProjection(client,claim,this.source(selected.entry,selected.step.action),async graph=>{
      const semantic=await this.context(client,claim,job,intent,graph,previous?'dispatch_check':'dispatch',attempt),program=selected.entry.didi!.program,ctx=await runGraphProgramAsync(graph,postgresDidiContextProgram(semantic,program));
      await runGraphProgramAsync(graph,validateDidiProgram(program,ctx,selected.step.action,selected.input));await runGraphProgramAsync(graph,validateDidiPlanningProgram(program,ctx,selected.step.action,selected.input,selected.plan.ontologyPlanning));
      const call=await runGraphProgramAsync(graph,resolveDidiCallProgram(program,ctx,selected.step.action,selected.input)),action=didiActionContext(semantic,ctx,attempt);
      const invocation:DidiReadInvocationContext={request:structuredClone(action.request),state:structuredClone(action.state),planId:action.planId,intentId:action.intentId,attemptId:action.attemptId,modelRunId:action.modelRunId};
      return {entry:selected.entry,attempt,input:selected.input,action:selected.step.action,call,wire:didiCallContext(program,invocation,selected.step.action,selected.input),invocation};
    });
  }
  async execute(input:WorkClaim,intentId:string,signal:AbortSignal){
    signal.throwIfAborted();const claim=structuredClone(input),reference=postgresWorkReference(claim),prepared=await this.options.database.run(client=>this.prepare(client,reference,intentId)),program=prepared.entry.didi!.program;
    const fixed=digest({input:prepared.input,action:prepared.action,call:prepared.call,wire:prepared.wire});let response:AgentActionResult|undefined,receipt:{id:string}|undefined;
    const audit=()=>this.options.database.run(client=>this.journal(client).recordObservation(claim.owner,intentId,prepared.attempt.id,response?{kind:'confirmed',eventId:prepared.attempt.id,sourceVersion:prepared.attempt.ordinal,output:{source:response.value},evidenceRefs:response.evidenceRefs}:{kind:'unknown',eventId:prepared.attempt.id,sourceVersion:prepared.attempt.ordinal,evidenceRefs:[],message:'Original DiDi source read ended without a verified source response'}));
    const current=async()=>{signal.throwIfAborted();const fresh=await this.options.database.run(client=>this.prepare(client,reference,intentId,prepared.attempt));if(digest({input:fresh.input,action:fresh.action,call:fresh.call,wire:fresh.wire})!==fixed)fail('DiDi original invocation changed before source dispatch or return');signal.throwIfAborted();};
    try{
      const raw=await this.options.registry.withClaim(reference,()=>program.invokeRead(prepared.wire,prepared.call.tool,prepared.call.args,signal,current));
      response=buildDidiReadResult(program,prepared.invocation,prepared.action,prepared.input,prepared.call,raw);receipt=await audit();await current();
      const actual=response,observationId=receipt.id;let object:ObjectRef|undefined;
      const accepted=await this.options.database.run(async client=>{
        const journal=this.journal(client,{attemptId:prepared.attempt.id,response:actual});
        return journal.commitObservation(intentId,observationId,true,{claim:reference,apply:async(job,intent)=>{
          signal.throwIfAborted();await this.options.registry.assertConfigured(client,prepared.entry,reference,job);
          // Build metadata/context only. Canonical source reads are installed
          // after the original confirmed source row has been independently read.
          const metadata=await PostgresProjectionGraph.create(client,claim.owner,job.delegation!.ontologyRelease!,this.options.builder,{readOnly:true});
          const semantic=await this.context(client,reference,job,intent,metadata,'accept',prepared.attempt);
          await withPostgresDidiCanonicalSourceProjection(client,reference,this.source(prepared.entry,prepared.action),{journal,program,account:prepared.entry.didi!.account,transport:prepared.entry.didi!.transport,context:semantic,attempt:prepared.attempt,observationId,response:actual},async graph=>{
            const ctx=await runGraphProgramAsync(graph,postgresDidiContextProgram({...semantic,graph},program)),action=didiActionContext(semantic,ctx,prepared.attempt);
            object=await runGraphProgramAsync(graph,projectDidiProgram(program,action,prepared.action,prepared.input,actual));
            const snapshot=checkedRideEstimate(actual.value),ports=job.delegation!.agent!.composition?await runGraphProgramAsync(graph,sealComposedOutputsProgram(action,semantic.step,prepared.input,actual,object,intent,graph.model.action(prepared.action),()=>didiOutputPorts(snapshot,actual,object!))):undefined;
            intent.acceptedOutput={object,...(ports?{ports}:{})};if(!job.delegation!.agent!.observations.some(value=>same(value,object)))job.delegation!.agent!.observations.push(object);
            resolveTaskRecovery(job,'source',prepared.action);job.updatedAt=new Date().toISOString();job.delegation!.nextAt=0;job.delegation!.events.push({at:job.updatedAt,event:'agent_observation_projected',evidence:digest(object)});
          });
          await this.options.registry.assertConfigured(client,prepared.entry,reference,job);signal.throwIfAborted();
        }});
      });
      return {intentId,attemptId:prepared.attempt.id,observationId,applied:accepted.applied,...(accepted.applied?{object:object??fail('Committed DiDi source projection is missing')}:{})};
    }catch(error){if(!receipt)try{receipt=await audit();}catch(auditError){throw new AggregateError([error,auditError],'Original DiDi source read failed; durable audit could not be acknowledged',{cause:error});}throw error;}
  }
}
