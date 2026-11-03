import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {DomainError} from '../core/domain.js';
import {componentContext,componentScopeDigestProgram} from '../core/composed-actions.js';
import type {DidiBinding} from '../capabilities/didi/contracts.js';
import type {DidiAgentProgram,DidiProgramContext,DidiActionProgramContext} from '../capabilities/didi/program.js';
import {validateDidiCallPlanningProgram,verifyDidiResultProgram,didiCallContext,resolveDidiCallProgram} from '../capabilities/didi/program.js';
import {checkedRideEstimate} from '../ontology/ride-estimate-projection.js';
import {readOntologyRequestProgram} from '../ontology/execution-projection.js';
import {objectRefSchema} from '../ontology/model.js';
import type {AgentActionResult} from '../core/agent-program.js';
import type {ActionResult,ExecutionAttempt} from '../ontology/actions.js';
import type {GraphProgram} from '../ontology/graph-program.js';
import {sourceReadRequestSchema,sourceReadResponseSchema} from '../agent-transport/service-contracts.js';
import {accessContextSchema} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresConstrainReadDeadline} from './runtime-transaction.js';
import type {PostgresActionProgramPolicy,PostgresActionSemanticContext} from './action-authorization.js';
import type {PostgresWorkReference} from './work-claim.js';
import {PostgresDidiAccount} from './didi-account.js';

export type PostgresDidiTransport={kind:'relay'|'relay-fixture';peerId:string;authorityId:string;gatewayOrigin:string;binding:Pick<DidiBinding,'bindingId'|'keySha256'|'environment'>}|{kind:'synthetic-fixture'};
export interface PostgresDidiPolicyOptions{program:DidiAgentProgram;account:PostgresDidiAccount;transport:PostgresDidiTransport;policyDigest:string}
const same=(a:unknown,b:unknown)=>a===undefined?b===undefined:b!==undefined&&digest(a)===digest(b);
const fail=(message:string):never=>{throw new DomainError('CONFLICT',message);};

export function* postgresDidiContextProgram(context:PostgresActionSemanticContext,program:DidiAgentProgram):GraphProgram<DidiProgramContext>{
  const {job,plan,step,intent}=context,d=job.delegation??fail('Original DiDi delegation is missing'),state=d.agent??fail('Original DiDi Agent state is missing');
  if(context.validUntil<=context.graph.now()||!d.ontologyRelease||!context.graph.releaseRef||!same(context.model.ref,context.graph.model.ref)||!same(d.ontologyRelease,context.graph.releaseRef)
    ||intent.owner!==context.owner||intent.jobId!==job.id||d.request.id!==job.id||state.requestRevision!==d.request.revision||plan.requestId!==job.id||plan.requestRevision!==d.request.revision
    ||!state.plans.some(value=>value.id===plan.id&&same(value,plan))||!plan.steps.some(value=>value.id===step.id&&value.intentId===intent.id&&same(value,step)))fail('DiDi semantics differ from the original task, version, plan or intent');
  if(!program.actionIds.includes(step.action)||!['SearchDidiPlaces','EstimateDidiRide'].includes(step.action)||step.effect!=='read'||step.additionalEffects?.length||plan.initialSelection||plan.callerDecision||!plan.modelRunId||!plan.modelDecision)fail('DiDi execution requires its original model-selected readonly action');
  const request=yield* readOntologyRequestProgram(context.graph,context.owner,job.id);if(request.id!==job.id||request.revision!==d.request.revision)fail('DiDi typed request revision changed');
  const root:DidiProgramContext={graph:context.graph,owner:context.owner,request,state:structuredClone(state),intents:structuredClone([...context.intents]),modelRuns:structuredClone(job.runs??[])};
  if(!state.composition){
    if(!same(state.programRef,program.ref)||state.programDigest!==program.configurationDigest||!same(plan.programRef,program.ref)||plan.programDigest!==program.configurationDigest||!same(plan.scope,state.scope)||step.contextId||step.contextDigest||step.contextScope)fail('DiDi direct scope changed');
    if((yield* componentScopeDigestProgram(root,state.scope))!==plan.scopeDigest)fail('DiDi scope changed after the original decision');return root;
  }
  if(!step.binding||!step.contextId||!step.contextDigest||!step.contextScope||!step.scopeDigest||step.bindingDigest!==step.binding.digest||step.action!==step.binding.actionId||!same(step.binding.programRef,program.ref)||step.binding.configurationDigest!==program.configurationDigest)fail('DiDi component has no exact original pin');
  const component=state.composition.contexts.find(value=>value.id===step.contextId)??fail('DiDi component is not part of this task');
  if(component.digest!==step.contextDigest||!same(component.scope,step.contextScope)||(yield* componentScopeDigestProgram(root,component.scope))!==step.scopeDigest)fail('DiDi component scope changed');return componentContext(root,component,program);
}
export function didiActionContext(context:PostgresActionSemanticContext,ctx:DidiProgramContext,attempt:ExecutionAttempt):DidiActionProgramContext{return {...ctx,planId:context.plan.id,intentId:context.intent.id,attemptId:attempt.id,modelRunId:context.plan.modelRunId,operationKey:context.intent.businessOperationKey,inputPlanning:context.plan.ontologyPlanning};}

/** Actual accepted source-node transport record, never a Worker-reported
 * snapshot used as its own provider proof. Historical receipt verification
 * binds its original dispatch token; the caller separately enforces current
 * claim/account/source/Pipeline and domain acceptance. */
export async function verifyPostgresDidiSourceReceipt(client:Client,claim:PostgresWorkReference,context:PostgresActionSemanticContext,attempt:ExecutionAttempt,response:AgentActionResult,result:ActionResult,transport:PostgresDidiTransport){
  const snapshot=checkedRideEstimate(response.value);if(result.kind!=='confirmed'||!same(result.output?.source,response.value)||!same(result.evidenceRefs,response.evidenceRefs)||snapshot.attemptId!==attempt.id||snapshot.intentId!==context.intent.id||snapshot.planId!==context.plan.id||snapshot.modelRunId!==context.plan.modelRunId)fail('DiDi confirmation differs from the original accepted source result');
  postgresConstrainReadDeadline(client,Date.parse(snapshot.expiresAt));
  if(transport.kind==='synthetic-fixture'){if(snapshot.evidenceKind!=='fixture')fail('Synthetic transport cannot certify a live provider result');return;}
  if(snapshot.evidenceKind!==(transport.kind==='relay-fixture'?'fixture':'live_readonly')||snapshot.receipt.environment!=='production')fail('Production Relay source requires its original live readonly receipt');
  const token=postgresBusinessToken(client),q=`"${postgresBusinessSchema(client)}"`,rows=await client.query(`SELECT id,retry_key,peer_id,connection_id,state,policy_revision,
      CASE WHEN octet_length(actor)<=65536 THEN actor END AS actor,CASE WHEN octet_length(request)<=1048576 THEN request END AS request,CASE WHEN octet_length(result)<=8388608 THEN result END AS result
    FROM ${q}.security_relay_reads WHERE state='completed' AND ${q}.eigos_try_jsonb(request)#>>'{context,intentId}'=$1 AND ${q}.eigos_try_jsonb(request)#>>'{context,attemptId}'=$2 LIMIT 2`,[context.intent.id,attempt.id]);
  const row=rows.rows[0];if(rows.rowCount!==1||typeof row?.actor!=='string'||typeof row.request!=='string'||typeof row.result!=='string')throw new SecurityError('SOURCE_NOT_AUTHORIZED');
  const actor=accessContextSchema.parse(JSON.parse(row.actor)),request=sourceReadRequestSchema.parse(JSON.parse(row.request)),actual=sourceReadResponseSchema.parse(JSON.parse(row.result));
  if(actor.actorKind!=='worker'||actor.ownerKey!==claim.owner||actor.taskId!==context.job.id||actor.requestRevision!==context.plan.requestRevision||actor.claimRef!==digest(attempt.claimToken)||actor.authEpoch!==claim.securityEpoch||actor.authorityRef.id!==claim.securityAuthorityId||Number(row.policy_revision)!==claim.securityPolicyRevision
    ||row.id!==request.callId||row.peer_id!==transport.peerId||!z.uuid().safeParse(row.connection_id).success||request.authorityId!==transport.authorityId||request.gatewayOrigin!==transport.gatewayOrigin||actual.authorityId!==transport.authorityId||actual.callId!==request.callId||actual.requestDigest!==digest(request)||!actual.result||actual.error
    ||request.context.requestId!==context.job.id||request.context.requestRevision!==context.plan.requestRevision||request.context.planId!==context.plan.id||request.context.intentId!==context.intent.id||request.context.attemptId!==attempt.id||request.context.modelRunId!==context.plan.modelRunId||request.context.action!==context.step.action||request.context.actionInputDigest!==digest(context.input)
    ||request.context.programId!==(context.step.binding?.programRef??context.plan.programRef).id||request.context.programDigest!==(context.step.binding?.configurationDigest??context.plan.programDigest)||request.tool!==snapshot.receipt.tool||digest(request.input)!==snapshot.receipt.inputDigest||request.source.bindingId!==transport.binding.bindingId||request.source.keySha256!==transport.binding.keySha256||request.source.environment!==transport.binding.environment||request.source.bindingId!==snapshot.receipt.bindingId||request.source.environment!==snapshot.receipt.environment||!same(actual.result.data,snapshot.data)||!same(actual.result.receipt,snapshot.receipt))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
  const {protocol:_p,kind:_k,callId:_id,expiresAt:_expires,...retry}=request;if(row.retry_key!==digest([row.peer_id,retry]))throw new SecurityError('POLICY_CHANGED');
  if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');
}

export function createPostgresDidiPolicy(options:PostgresDidiPolicyOptions):PostgresActionProgramPolicy{
  const {program,account,transport}=options;
  return {program,assertConfigured:(client,claim,job)=>account.assert(client,claim,job,options.policyDigest),verifySourceReceipt:(client,claim,context,attempt,response,result)=>verifyPostgresDidiSourceReceipt(client,claim,context,attempt,response,result,transport),
    validate:function*(context){
      const ctx=yield* postgresDidiContextProgram(context,program),checked=yield* validateDidiCallPlanningProgram(program,ctx,context.step.action,context.input,context.plan.ontologyPlanning);
      let validUntil=context.validUntil;for(const {snapshot} of checked.dependencies)validUntil=Math.min(validUntil,Date.parse(snapshot.expiresAt));
      if(validUntil<=context.graph.now())fail('DiDi dependency expired');return {privateDigest:digest({}),validUntil};
    },
    verifyObservation:function*(context,attempt,response){
      if(attempt.kind!=='dispatch'||attempt.intentId!==context.intent.id||attempt.planDigest!==context.plan.digest||attempt.requestRevision!==(context.job.revision??0)||attempt.inputDigest!==digest(context.input)||context.attempt&&!same(context.attempt,attempt))fail('DiDi result differs from its original dispatch attempt');
      const ctx=yield* postgresDidiContextProgram(context,program),action=didiActionContext(context,ctx,attempt);yield* verifyDidiResultProgram(program,action,context.step.action,context.input,response);
    },
  };
}
