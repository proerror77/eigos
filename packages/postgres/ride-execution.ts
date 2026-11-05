import type {Client} from 'pg';
import {digest} from '../core/delegation.js';
import {DomainError,type Job} from '../core/domain.js';
import type {WorkClaim} from '../core/store.js';
import {executionBudgetStatus} from '../core/execution-budget.js';
import {canRecoverReadOnly,resolveTaskRecovery} from '../core/task-recovery.js';
import {sealComposedOutputsProgram} from '../core/composed-actions.js';
import {validateRideProgram,rideWire,buildRideResult,projectRideProgram,rideOutputPorts,type RideProgramContext} from '../capabilities/rides/program.js';
import {rideSourceActionSchema,checkedRideSnapshot} from '../ontology/ride-sources.js';
import type {RideContext} from '../capabilities/rides/contracts.js';
import type {AgentActionResult} from '../core/agent-program.js';
import type {ActionIntent,ExecutionAttempt} from '../ontology/actions.js';
import type {ObjectRef} from '../ontology/model.js';
import {runGraphProgramAsync,type ProjectionMetadata} from '../ontology/graph-program.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {SecurityError} from '../security/errors.js';
import type {PostgresDatabase} from './database.js';
import {PostgresReadProgramRegistry,type PostgresReadRegistration} from './didi-registry.js';
import {postgresRideContextProgram,rideActionContext} from './ride-policy.js';
import {PostgresActionJournal} from './action-journal.js';
import {createPostgresActionAuthorization,type PostgresActionSemanticContext} from './action-authorization.js';
import {PostgresProjectionGraph} from './projection-graph.js';
import {PostgresTaskStorage} from './task-storage.js';
import {withPostgresSourceProjection,type PostgresSourceProjectionOptions} from './source-projection.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {postgresWorkReference,type PostgresWorkReference} from './work-claim.js';

interface Options {database:Pick<PostgresDatabase,'run'|'inspectClaim'>;registry:PostgresReadProgramRegistry;policyDigest:string;modelChannel:string;builder?:StagedKernelBuilder;maxTaskMs?:number}
interface Prepared {entry:PostgresReadRegistration;attempt:ExecutionAttempt;input:Record<string,unknown>;action:string;wire:RideContext;invocation:Omit<RideProgramContext,'graph'> & {planId:string;intentId:string;attemptId:string;modelRunId?:string};requestDigest:string;releaseDigest:string}
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
function fail(message:string):never{throw new DomainError('CONFLICT',message);}

/** One original read intent, actual source Agent transport, durable receipt
 * and same-transaction independent domain projection. It chooses no recipe,
 * starts no model, creates no task and never retries an uncertain dispatch. */
export class PostgresRideExecution {
  private readonly maximum:number;
  constructor(private readonly options:Options){
    if(!(options.registry instanceof PostgresReadProgramRegistry)||options.registry.policyDigest!==options.policyDigest||!options.modelChannel)throw new Error('Actual configured ride estimate registry and model read channel are required');
    this.maximum=options.maxTaskMs??86400000;if(!Number.isSafeInteger(this.maximum)||this.maximum<1||this.maximum>86400000)throw new Error('Invalid fixed ride estimate task deadline');
  }
  private source(entry:PostgresReadRegistration,action:string):PostgresSourceProjectionOptions{return {policyDigest:this.options.policyDigest,modelChannel:this.options.modelChannel,builder:this.options.builder,programRef:entry.program.ref,configurationDigest:entry.program.configurationDigest,sourceBindingId:entry.sourceBindingId,action,inspectClaim:claim=>this.options.database.inspectClaim(claim,this.options.policyDigest)};}
  private journal(client:Client,observation?:{attemptId:string;response:AgentActionResult}){
    const options={policyDigest:this.options.policyDigest,modelChannel:this.options.modelChannel,builder:this.options.builder,maxTaskMs:this.maximum,programs:this.options.registry.policies(),inspectClaim:(claim:PostgresWorkReference)=>this.options.database.inspectClaim(claim,this.options.policyDigest),...(observation?{observation}:{})};
    return new PostgresActionJournal(client,{...options,authorize:createPostgresActionAuthorization(client,options)});
  }
  private select(job:Job,intent:ActionIntent){
    const state=job.delegation?.agent,plans=state?.plans.filter(plan=>plan.digest===intent.planDigest),plan=plans?.[0],steps=plan?.steps.filter(step=>step.intentId===intent.id),step=steps?.[0];
    if(job.state!=='working'||!state||plans?.length!==1||!plan||steps?.length!==1||!step||state.pendingPlanId!==plan.id||intent.jobId!==job.id||step.id!==intent.stepId||step.effect!=='read'||!['EstimateUberRide','EstimateGrabRide'].includes(step.action)||step.inputRefs.length||step.acceptedInputs?.length)fail('ride estimate requires its exact original pending readonly action');
    const entry=this.options.registry.require(step.binding?.programRef??plan.programRef,step.binding?.configurationDigest??plan.programDigest);if(entry.kind!=='ride'||!entry.ride)throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    const input=structuredClone(intent.dispatchInput??step.input);if(!same(input,step.input))fail('ride estimate original input cannot be rematerialized or replaced');return {plan,step,input,entry};
  }
  private async context(client:Client,claim:PostgresWorkReference,job:Job,intent:ActionIntent,graph:ProjectionMetadata,operation:PostgresActionSemanticContext['operation'],attempt:ExecutionAttempt){
    const selected=this.select(job,intent),intents=await new PostgresTaskStorage(client,this.options.builder).intents(claim.owner,job.id),index=intents.findIndex(value=>value.id===intent.id);if(index<0)fail('Original ride estimate intent is missing');intents[index]=intent;
    const admission=await postgresWorkerAdmission(client,claim.owner,job.id,this.options.policyDigest),validUntil=Math.min(admission.validUntil,Date.parse(canRecoverReadOnly(job,intents)?executionBudgetStatus(job).window.startedAt:job.createdAt)+this.maximum);
    return {model:graph.model,graph,owner:claim.owner,intents,validUntil,job,plan:selected.plan,step:selected.step,intent,input:selected.input,operation,attempt} satisfies PostgresActionSemanticContext;
  }
  private async prepare(client:Client,claim:PostgresWorkReference,intentId:string):Promise<Prepared>{
    const store=new PostgresTaskStorage(client,this.options.builder),journal=this.journal(client);let intent=await journal.intent(claim.owner,intentId);
    const job=await store.get(claim.owner,claim.job.id),selected=this.select(job,intent);await this.options.registry.assertConfigured(client,selected.entry,claim,job);
    if(intent.state!=='ready')fail('A dispatched ride estimate read retains its original outcome; automatic replay is prohibited');
    if(!intent.dispatchInput){intent.dispatchInput=structuredClone(selected.input);await store.saveIntent(claim.owner,intent);}
    const attempt=await journal.startAttempt(claim,intentId,'dispatch',digest(selected.input));intent=await journal.intent(claim.owner,intentId);
    return withPostgresSourceProjection(client,claim,this.source(selected.entry,selected.step.action),async graph=>{
      const semantic=await this.context(client,claim,job,intent,graph,'dispatch',attempt),program=selected.entry.ride!.program,ctx=await runGraphProgramAsync(graph,postgresRideContextProgram(semantic,program));
      await runGraphProgramAsync(graph,validateRideProgram(program,ctx,selected.step.action,selected.input));const action=rideActionContext(semantic,ctx,attempt);
      const invocation:Omit<RideProgramContext,'graph'> & {planId:string;intentId:string;attemptId:string;modelRunId?:string}={owner:claim.owner,request:structuredClone(action.request),state:structuredClone(action.state),planId:action.planId,intentId:action.intentId,attemptId:action.attemptId,modelRunId:action.modelRunId};
      return {entry:selected.entry,attempt,input:selected.input,action:selected.step.action,wire:rideWire(program,invocation,selected.step.action,selected.input),invocation,requestDigest:digest(job.delegation!.request),releaseDigest:digest(job.delegation!.ontologyRelease)};
    });
  }
  private async assertCurrent(client:Client,claim:PostgresWorkReference,intentId:string,prepared:Prepared){
    const journal=this.journal(client);
    // This remains the full current authorization: claim fences, roles, source,
    // Pipeline, immutable plan/attempt, original planning receipts and current
    // typed ride estimate semantics (which already resolve the exact MCP dependencies).
    await journal.assertDispatchAllowed(claim,intentId,prepared.attempt.id);
    const store=new PostgresTaskStorage(client,this.options.builder),job=await store.get(claim.owner,claim.job.id),intent=await journal.intent(claim.owner,intentId),selected=this.select(job,intent);
    const attempt=(await journal.attempts(claim.owner,intentId)).find(value=>value.id===prepared.attempt.id);
    const wire:RideContext={requestId:job.id,requestRevision:job.delegation!.request.revision,planId:selected.plan.id,intentId:intent.id,attemptId:prepared.attempt.id,modelRunId:selected.plan.modelRunId??fail('Original ride estimate model decision is missing'),programId:selected.entry.program.ref.id,programDigest:selected.entry.program.configurationDigest,action:selected.step.action,actionInputDigest:digest(selected.input)};
    if(intent.state!=='dispatching'||!intent.dispatchInput||!attempt||!same(attempt,prepared.attempt)||selected.entry!==prepared.entry||selected.plan.digest!==prepared.attempt.planDigest
      ||prepared.attempt.intentId!==intentId||prepared.attempt.inputDigest!==digest(selected.input)||!same(selected.input,prepared.input)||!same(wire,prepared.wire)
      ||digest(job.delegation!.request)!==prepared.requestDigest||digest(job.delegation!.ontologyRelease)!==prepared.releaseDigest)fail('ride estimate original invocation changed before source dispatch or return');
    await this.options.registry.assertConfigured(client,selected.entry,claim,job);
    // Reuse only the derived wire value. The trusted interpreter is pure over
    // the pinned definition/input/scope and source snapshots just revalidated
    // by the journal; opening another source graph would repeat those checks.
  }
  async execute(input:WorkClaim,intentId:string,signal:AbortSignal){
    signal.throwIfAborted();const claim=structuredClone(input),reference=postgresWorkReference(claim),prepared=await this.options.database.run(client=>this.prepare(client,reference,intentId)),program=prepared.entry.ride!.program;
    const fixed=digest({input:prepared.input,action:prepared.action,wire:prepared.wire});let response:AgentActionResult|undefined,receipt:{id:string}|undefined;
    const audit=()=>this.options.database.run(client=>this.journal(client).recordObservation(claim.owner,intentId,prepared.attempt.id,response?{kind:'confirmed',eventId:prepared.attempt.id,sourceVersion:prepared.attempt.ordinal,output:{source:response.value},evidenceRefs:response.evidenceRefs}:{kind:'unknown',eventId:prepared.attempt.id,sourceVersion:prepared.attempt.ordinal,evidenceRefs:[],message:'Original ride estimate source read ended without a verified source response'}));
    const current=async()=>{signal.throwIfAborted();await this.options.database.run(client=>this.assertCurrent(client,reference,intentId,prepared));if(digest({input:prepared.input,action:prepared.action,wire:prepared.wire})!==fixed)fail('ride estimate original invocation changed before source dispatch or return');signal.throwIfAborted();};
    try{
      const raw=await this.options.registry.withClaim(reference,()=>program.options.connector!.read(prepared.wire,rideSourceActionSchema.parse(prepared.input).query,signal,current));
      response=buildRideResult(prepared.invocation.state.scope,prepared.wire,prepared.input,raw);receipt=await audit();await current();
      const actual=response,observationId=receipt.id;let object:ObjectRef|undefined;
      const accepted=await this.options.database.run(async client=>{
        const journal=this.journal(client,{attemptId:prepared.attempt.id,response:actual});
        return journal.commitObservation(intentId,observationId,true,{claim:reference,apply:async(job,intent)=>{
          signal.throwIfAborted();await this.options.registry.assertConfigured(client,prepared.entry,reference,job);
          // commitObservation has independently compared the persisted Relay
          // source response in the same transaction before this mapper runs.
          await withPostgresSourceProjection(client,reference,this.source(prepared.entry,prepared.action),async graph=>{
            const semantic=await this.context(client,reference,job,intent,graph,'accept',prepared.attempt),ctx=await runGraphProgramAsync(graph,postgresRideContextProgram(semantic,program)),action=rideActionContext(semantic,ctx,prepared.attempt);
            object=await runGraphProgramAsync(graph,projectRideProgram(program,action,prepared.action,prepared.input,actual));
            const ports=job.delegation!.agent!.composition?await runGraphProgramAsync(graph,sealComposedOutputsProgram(action,semantic.step,prepared.input,actual,object,intent,graph.model.action(prepared.action),()=>rideOutputPorts(actual,object!))):undefined;
            intent.acceptedOutput={object,...(ports?{ports}:{})};if(!job.delegation!.agent!.observations.some(value=>same(value,object)))job.delegation!.agent!.observations.push(object);
            resolveTaskRecovery(job,'source',prepared.action);job.updatedAt=new Date().toISOString();job.delegation!.nextAt=0;job.delegation!.events.push({at:job.updatedAt,event:'agent_observation_projected',evidence:digest(object)});
          });
          await this.options.registry.assertConfigured(client,prepared.entry,reference,job);signal.throwIfAborted();
        }});
      });
      return {intentId,attemptId:prepared.attempt.id,observationId,applied:accepted.applied,...(accepted.applied?{object:object??fail('Committed ride estimate source projection is missing')}:{})};
    }catch(error){if(!receipt)try{receipt=await audit();}catch(auditError){throw new AggregateError([error,auditError],'Original ride estimate source read failed; durable audit could not be acknowledged',{cause:error});}throw error;}
  }
}
