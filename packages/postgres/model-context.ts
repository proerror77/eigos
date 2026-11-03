import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import type {Job,Principal} from '../core/domain.js';
import type {AgentProgram} from '../core/agent-program.js';
import {executionBudgetStatus,remainingModelTurns} from '../core/execution-budget.js';
import {agentLimits} from '../core/agent-limits.js';
import {componentContext} from '../core/composed-actions.js';
import {assertGoalContract} from '../core/goal-contract.js';
import type {GoalReviewContext} from '../ontology/goal-coverage.js';
import type {AgentPlanningContext} from '../coordinator/coordinator.js';
import type {AgentExecutionState} from '../ontology/agent-actions.js';
import {objectRefSchema} from '../ontology/model.js';
import {readOntologyRequestProgram,readExecutionContextProgram} from '../ontology/execution-projection.js';
import {runGraphProgramAsync} from '../ontology/graph-program.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {assertDocumentContextProgram} from '../capabilities/document-program.js';
import {SecurityError} from '../security/errors.js';
import {combineEnvelopes} from '../security/envelope.js';
import {submissionDigest} from '../security/submission-digest.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {postgresWorkReference,type PostgresWorkReference} from './work-claim.js';
import {PostgresTaskStorage} from './task-storage.js';
import {postgresTaskReadHistory} from './task-lineage.js';
import {withPostgresWorkerEvidenceAuthorization,type PostgresTaskReadAuthorization} from './task-output.js';
import {postgresTaskResourcePermissionValidUntil,type PostgresTaskReadAdmission} from './task-read-access.js';
import {withPostgresPlanningReadGraph} from './planning-read-graph.js';
import {assertPostgresPlanningDiscoveryContext,type PostgresPlanningDiscoveryContext} from './native-planning-session.js';

export type PostgresModelProgramMetadata=Pick<AgentProgram,'ref'|'configurationDigest'|'capability'|'permitted'|'actionIds'|'guidance'|'completionSchema'|'limits'|'preparePlanningContext'|'planningObservationTypes'>;
export interface PostgresModelContextOptions {
  policyDigest:string;modelChannel:string;builder?:StagedKernelBuilder;componentPrograms?:readonly PostgresModelProgramMetadata[];
  inspectClaim:(claim:PostgresWorkReference)=>Promise<{validUntil:number}|undefined>;
}
export interface PostgresModelContextResult<T>{context:T;executionBudget:ReturnType<typeof executionBudgetStatus>;maxTurns:number}
type Scope={client:Client;claim:PostgresWorkReference;authorization:PostgresTaskReadAuthorization;admission:PostgresTaskReadAdmission;principal:Principal;policyDigest:string;modelChannel:string;assertActive:()=>void};
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
const integer=z.number().int().nonnegative().safe(),counts=z.strictObject({modelTurns:integer,plans:integer,actions:integer});
const intentState=z.enum(['ready','dispatching','awaiting_remote','effect_unknown','effect_confirmed','rejected','canceled_before_dispatch','canceled_after_dispatch','needs_review']);
function budget(job:Job,program:PostgresModelProgramMetadata){
  const status=executionBudgetStatus(job),window=status.window;
  const safe={version:z.literal('1').parse(status.version),profile:z.enum(['standard','extended']).parse(status.profile),
    limits:{window:counts.parse(status.limits.window),task:counts.parse(status.limits.task)},used:counts.parse(status.used),windowUsed:counts.parse(status.windowUsed),
    window:{sequence:z.number().int().positive().safe().parse(window.sequence),reason:z.enum(['initial','input','source','automatic','recovery']).parse(window.reason),
      requestRevision:z.number().int().positive().safe().max(job.delegation!.request.revision).parse(window.requestRevision),startedAt:z.iso.datetime({offset:true}).parse(window.startedAt),baseline:counts.parse(window.baseline),
      ...(window.progressBaseline===undefined?{}:{progressBaseline:integer.parse(window.progressBaseline)})},
    ...(status.paused?{paused:z.strictObject({resource:z.enum(['modelTurns','plans','actions','time','reasoning']),scope:z.enum(['window','task']),at:z.iso.datetime({offset:true})}).parse(status.paused)}:{})};
  return {executionBudget:safe,maxTurns:integer.parse(Math.min(remainingModelTurns(job),program.limits?Math.max(0,agentLimits(program).modelTurns-(job.runs?.length??0)):Infinity))};
}
function metadata(program:PostgresModelProgramMetadata,owner:string){
  if(!program||typeof program.capability!=='function'||typeof program.permitted!=='function'||!program.permitted(owner)||!/^[a-f0-9]{64}$/.test(program.configurationDigest))throw new SecurityError('AUTHORIZATION_REQUIRED');
  const capability=structuredClone(program.capability());
  if(!same(capability.ref,program.ref)||!(['eigos.goal','document.compose'].includes(program.ref.id))||program.ref.version!==(program.ref.id==='eigos.goal'?'1':'2'))throw new SecurityError('AUTHORITY_UNAVAILABLE','PostgreSQL model context for this registered adapter is not installed');
  return capability;
}

/** A real checked scope owns every value used in the prompt. Private Job data
 * is used only to verify the current projection and compute bounded counters;
 * it is never spread into the DTO. Model calls happen after this scope commits. */
async function context<T extends 'goal'|'agent'>(kind:T,scope:Scope,program:PostgresModelProgramMetadata,options:Pick<PostgresModelContextOptions,'builder'|'componentPrograms'>):Promise<PostgresModelContextResult<T extends 'goal'?GoalReviewContext:AgentPlanningContext>>{
  scope.assertActive();const {client,claim,authorization:auth,admission,principal,policyDigest,modelChannel}=scope,token=postgresBusinessToken(client);
  if(admission.actor.actorKind!=='worker'||admission.actor.taskId!==claim.job.id||admission.grant.taskId!==claim.job.id||admission.actor.ownerKey!==claim.owner)throw new SecurityError('AUTHORIZATION_REQUIRED');
  const original=metadata(program,claim.owner),programStamp=digest({ref:program.ref,configuration:program.configurationDigest,capability:original,actions:program.actionIds}),store=new PostgresTaskStorage(client,options.builder),job=await store.get(claim.owner,claim.job.id),d=job.delegation,state=d?.agent;
  if(!d||!state||state.requestRevision!==d.request.revision||!same(state.programRef,program.ref)||state.programDigest!==program.configurationDigest)throw new SecurityError('POLICY_CHANGED');
  z.enum(['1','2']).parse(state.version);objectRefSchema.parse(state.scope);
  if(state.components)throw new SecurityError('AUTHORITY_UNAVAILABLE','PostgreSQL legacy component model context is not installed');
  if(program.ref.id==='document.compose'&&state.composition)throw new SecurityError('POLICY_CHANGED');
  const bounds=budget(job,program);
  const result=await withPostgresPlanningReadGraph(client,principal,job.id,policyDigest,auth,admission,async graph=>{
    const request=await runGraphProgramAsync(graph,readOntologyRequestProgram(graph,claim.owner,job.id));
    if(request.revision!==d.request.revision||submissionDigest(request)!==submissionDigest(d.request))throw new SecurityError('POLICY_CHANGED');
    const root={type:'ServiceRequest',id:job.id},checked=await auth.readObject(root,['originalGoal',...(request.requirements.length||request.conditions?.length?['conditions']:[])]);
    for(const input of admission.grant.inputs)await auth.readObject(input.object,input.fields);
    const native=program.ref.id==='eigos.goal';let input:Record<string,unknown>;
    const ownerContext={graph,owner:claim.owner,request,state,intents:await store.intents(claim.owner,job.id),modelRuns:job.runs};
    if(native){
      if(state.scope.type!=='ServiceRequest'||state.scope.id!==job.id||!state.composition||!same((original.ontology as {goal?:unknown})?.goal,state.composition.goal))throw new SecurityError('POLICY_CHANGED');
      assertGoalContract(state.composition.goal,request,graph.releaseRef);await graph.read(claim.owner,root);input={};
      for(const component of state.composition.contexts.filter(value=>!state.composition!.retiredContexts?.some(old=>old.id===value.id))){
        const found=options.componentPrograms?.filter(value=>same(value.ref,component.programRef)&&value.configurationDigest===component.programDigest)??[];
        if(found.length!==1)throw new SecurityError('AUTHORITY_UNAVAILABLE','PostgreSQL active component model context has no registered adapter');
        metadata(found[0]!,claim.owner);
        if(found[0]!.ref.id!=='document.compose')throw new SecurityError('AUTHORITY_UNAVAILABLE','PostgreSQL active component model context is not installed');
        const scoped=componentContext(ownerContext,component,found[0]!);await runGraphProgramAsync(graph,assertDocumentContextProgram(found[0]!,scoped));
      }
    }else{
      await runGraphProgramAsync(graph,assertDocumentContextProgram(program,ownerContext));
      const object=await graph.read(claim.owner,state.scope),value=object.properties.authorizedInput??object.properties.input;
      if(!value||typeof value!=='object'||Array.isArray(value))throw new SecurityError('INSUFFICIENT_ACCESS');input=structuredClone(value as Record<string,unknown>);
    }
    let dto:GoalReviewContext|AgentPlanningContext;
    if(kind==='goal'){
      if(!same(input,state.input))throw new SecurityError('INSUFFICIENT_ACCESS');dto={request,capability:original,input};
    }else{
      const execution=await runGraphProgramAsync(graph,readExecutionContextProgram(graph,claim.owner,job.id,request.revision));
      if(!execution||!same(execution.programRef,state.programRef)||execution.programDigest!==state.programDigest||!same(execution.scope,state.scope)||execution.pendingPlanId!==state.pendingPlanId
        ||state.pendingPlanId&&!execution.plans.some(plan=>plan.planId===state.pendingPlanId))throw new SecurityError('POLICY_CHANGED');
      if(native&&state.composition!.contexts.length&&!execution.composition)throw new SecurityError('INSUFFICIENT_ACCESS');
      const observations=[];for(const ref of state.observations){objectRefSchema.parse(ref);if(await auth.bindingMetadata(ref))observations.push(structuredClone(ref));}
      const actionIds:string[]=[];for(const id of state.managedActionIds??program.actionIds){if(!program.actionIds.includes(id))throw new SecurityError('POLICY_CHANGED');const until=await postgresTaskResourcePermissionValidUntil(client,principal,job.id,policyDigest,'actionType',id,'action.execute',options.builder);if(until>Date.now()){postgresConstrainReadDeadline(client,until);actionIds.push(id);}}
      const navigation=[];if(native)for(const item of execution.composition?.components??[]){const raw=state.composition!.contexts.find(value=>value.id===item.id);if(!raw||!same(raw.programRef,item.programRef)||raw.programDigest!==item.configurationDigest||raw.digest!==item.digest||!same(raw.scope,item.scope))throw new SecurityError('POLICY_CHANGED');if(await auth.bindingMetadata(item.scope))navigation.push({id:item.id,programRef:structuredClone(item.programRef),scope:structuredClone(item.scope),retired:!!item.retired});}
      const safeState:AgentExecutionState={version:state.version,programRef:structuredClone(state.programRef),programDigest:state.programDigest,scope:structuredClone(state.scope),input,requestRevision:request.revision,plans:[],feedback:[],observations,
        ...(state.pendingPlanId?{pendingPlanId:state.pendingPlanId}:{}),...(state.managedActionIds?{managedActionIds:actionIds}:{}),informationRequests:[]};
      dto={request,capability:original,state:safeState,actionIds,guidance:program.guidance,completionSchema:structuredClone(program.completionSchema),limits:agentLimits(program),
        ...(program.preparePlanningContext?{prepareContext:true}:{}),...(program.planningObservationTypes?{planningObservationTypes:[...program.planningObservationTypes]}:{}),
        ...(native?{preparedContextNavigation:navigation}:{}),actionOutcomes:ownerContext.intents.map(intent=>({stepId:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).parse(intent.stepId),intentId:'',state:intentState.parse(intent.state)}))};
    }
    const current=graph.evidence(),submitted=combineEnvelopes([checked.envelope,{...checked.envelope,classification:'sensitive',requiredMarkings:['member_private','personal_data']}]);
    submitted.submission={taskId:request.id,requestRevision:request.revision,contentDigest:submissionDigest(request)};
    const history=await postgresTaskReadHistory(client,claim.owner,job.id,request.revision),approved=await auth.authorizeEvidence(combineEnvelopes([...history,submitted,...(current?[current]:[])]));
    scope.assertActive();if(postgresBusinessToken(client)!==token||programStamp!==digest({ref:program.ref,configuration:program.configurationDigest,capability:metadata(program,claim.owner),actions:program.actionIds}))throw new SecurityError('POLICY_CHANGED');
    await client.query(`INSERT INTO "${postgresBusinessSchema(client)}".security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT(grant_id,digest) DO NOTHING`,[admission.grant.id,digest(approved),JSON.stringify(approved)]);
    return dto;
  },options.builder);
  scope.assertActive();return {context:structuredClone(result),...bounds} as PostgresModelContextResult<T extends 'goal'?GoalReviewContext:AgentPlanningContext>;
}
function standalone<T extends 'goal'|'agent'>(kind:T,client:Client,input:PostgresWorkReference,program:PostgresModelProgramMetadata,options:PostgresModelContextOptions){
  const claim=postgresWorkReference(input),token=postgresBusinessToken(client);if(!/^[a-f0-9]{64}$/.test(options.policyDigest)||!options.modelChannel||typeof options.inspectClaim!=='function')throw new Error('Explicit PostgreSQL model context authority is required');
  return withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,(authorization,admission,principal)=>context(kind,{client,claim,authorization,admission,principal,policyDigest:options.policyDigest,modelChannel:options.modelChannel,assertActive:()=>{if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');}},program,options),options.builder,options.modelChannel,options.inspectClaim);
}
export const postgresGoalReviewContext=(client:Client,claim:PostgresWorkReference,program:PostgresModelProgramMetadata,options:PostgresModelContextOptions)=>standalone('goal',client,claim,program,options);
export const postgresAgentPlanningContext=(client:Client,claim:PostgresWorkReference,program:PostgresModelProgramMetadata,options:PostgresModelContextOptions)=>standalone('agent',client,claim,program,options);
export function postgresGoalReviewContextFromDiscoveryContext(scope:PostgresPlanningDiscoveryContext,program:PostgresModelProgramMetadata,options:Pick<PostgresModelContextOptions,'builder'|'componentPrograms'>={}){assertPostgresPlanningDiscoveryContext(scope);return context('goal',scope,program,options);}
export function postgresAgentPlanningContextFromDiscoveryContext(scope:PostgresPlanningDiscoveryContext,program:PostgresModelProgramMetadata,options:Pick<PostgresModelContextOptions,'builder'|'componentPrograms'>={}){assertPostgresPlanningDiscoveryContext(scope);return context('agent',scope,program,options);}
