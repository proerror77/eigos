import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {DomainError} from '../core/domain.js';
import {componentContext,componentScopeDigestProgram} from '../core/composed-actions.js';
import {RideEstimateProgram,validateRideProgram,rideWire,type RideProgramContext} from '../capabilities/rides/program.js';
import {checkedRideSnapshot} from '../ontology/ride-sources.js';
import {rideSourceRequestSchema,checkedRideReply,assertRideRequestBinding} from '../agent-transport/ride-contracts.js';
import {assertSourceDispatchInput} from '../agent-transport/source-protocol.js';
import {accessContextSchema} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import {readOntologyRequestProgram} from '../ontology/execution-projection.js';
import type {GraphProgram} from '../ontology/graph-program.js';
import type {PostgresActionProgramPolicy,PostgresActionSemanticContext} from './action-authorization.js';
import {postgresBusinessSchema,postgresConstrainReadDeadline} from './runtime-transaction.js';
import type {RideBinding} from '../capabilities/rides/contracts.js';
import type {PostgresWorkReference} from './work-claim.js';
import type {AgentActionResult} from '../core/agent-program.js';
import type {ActionResult,ExecutionAttempt} from '../ontology/actions.js';
const same=(a:unknown,b:unknown)=>digest(a)===digest(b),fail=(message:string):never=>{throw new DomainError('CONFLICT',message);};
export interface PostgresRideConfiguration {program:RideEstimateProgram;peerId:string;binding:RideBinding;authority:{id:string;gatewayOrigin:string};assertCurrent?:()=>void}
export function* postgresRideContextProgram(context:PostgresActionSemanticContext,program:RideEstimateProgram):GraphProgram<RideProgramContext>{
 const {job,plan,step,intent}=context,d=job.delegation??fail('Missing ride delegation'),state=d.agent??fail('Missing ride state');
 if(context.validUntil<=context.graph.now()||!d.ontologyRelease||!context.graph.releaseRef||!same(context.model.ref,context.graph.model.ref)||!same(d.ontologyRelease,context.graph.releaseRef)||intent.owner!==context.owner||intent.jobId!==job.id||d.request.id!==job.id||state.requestRevision!==d.request.revision||plan.requestId!==job.id||plan.requestRevision!==d.request.revision||!state.plans.some(p=>same(p,plan))||!plan.steps.some(s=>same(s,step)))fail('Ride task, plan or revision differs');
 if(!program.actionIds.includes(step.action)||step.effect!=='read'||step.additionalEffects?.length||plan.initialSelection||plan.callerDecision||!plan.modelRunId||!plan.modelDecision)fail('Ride requires original model-selected read decision');
 const request=yield* readOntologyRequestProgram(context.graph,context.owner,job.id);if(request.id!==job.id||request.revision!==d.request.revision)fail('Ride typed revision differs');
 const root:RideProgramContext={graph:context.graph,owner:context.owner,request,state:structuredClone(state),intents:structuredClone([...context.intents]),modelRuns:structuredClone(job.runs??[])};
 if(!state.composition){if(!same(state.programRef,program.ref)||state.programDigest!==program.configurationDigest||!same(plan.programRef,program.ref)||plan.programDigest!==program.configurationDigest||!same(plan.scope,state.scope)||step.contextId||step.contextDigest||step.contextScope||(yield* componentScopeDigestProgram(root,state.scope))!==plan.scopeDigest)fail('Ride direct scope changed');return root;}
 if(!step.binding||!step.contextId||!step.contextDigest||!step.contextScope||!step.scopeDigest||step.bindingDigest!==step.binding.digest||step.action!==step.binding.actionId||!same(step.binding.programRef,program.ref)||step.binding.configurationDigest!==program.configurationDigest)fail('Ride component binding differs');
 const component=state.composition.contexts.find(c=>c.id===step.contextId)??fail('Ride component missing');if(component.digest!==step.contextDigest||!same(component.scope,step.contextScope)||(yield* componentScopeDigestProgram(root,component.scope))!==step.scopeDigest)fail('Ride component scope changed');return componentContext(root,component,program);
}
export function rideActionContext(context:PostgresActionSemanticContext,ctx:RideProgramContext,attempt:ExecutionAttempt){return {...ctx,planId:context.plan.id,intentId:context.intent.id,attemptId:attempt.id,modelRunId:context.plan.modelRunId};}
export async function verifyPostgresRideReceipt(client:Client,claim:PostgresWorkReference,context:PostgresActionSemanticContext,attempt:ExecutionAttempt,response:AgentActionResult,result:ActionResult,options:PostgresRideConfiguration){
 options.assertCurrent?.();const s=checkedRideSnapshot(response.value),q=`"${postgresBusinessSchema(client)}"`;
 if(result.kind!=='confirmed'||!same(result.output?.source,response.value)||!same(result.evidenceRefs,response.evidenceRefs)||!same(s.wire,rideWire(options.program,rideActionContext(context,{graph:context.graph,owner:context.owner,request:context.job.delegation!.request,state:context.job.delegation!.agent!},attempt),context.step.action,context.input)))fail('Ride accepted response differs from original dispatch');
 const rows=await client.query(`SELECT peer_id,connection_id,state,policy_revision,retry_key,CASE WHEN octet_length(actor)<=65536 THEN actor END AS actor,CASE WHEN octet_length(request)<=1048576 THEN request END AS request,CASE WHEN octet_length(result)<=8388608 THEN result END AS result FROM ${q}.security_relay_reads WHERE id=$1 LIMIT 2`,[s.sourceCallId]),row=rows.rows[0];
 if(rows.rowCount!==1||typeof row.actor!=='string'||typeof row.request!=='string'||typeof row.result!=='string'||row.state!=='completed'||row.peer_id!==options.peerId||!z.uuid().safeParse(row.connection_id).success)throw new SecurityError('SOURCE_NOT_AUTHORIZED');
 const actor=accessContextSchema.parse(JSON.parse(row.actor)),request=rideSourceRequestSchema.parse(JSON.parse(row.request)),actual=checkedRideReply(request,JSON.parse(row.result));assertRideRequestBinding(request,options.binding,options.program.evidenceKind);assertSourceDispatchInput(request,context.input);
 if(actor.actorKind!=='worker'||actor.ownerKey!==claim.owner||actor.taskId!==context.job.id||actor.requestRevision!==context.plan.requestRevision||actor.claimRef!==digest(attempt.claimToken)||actor.authEpoch!==claim.securityEpoch||actor.authorityRef.id!==claim.securityAuthorityId||Number(row.policy_revision)!==claim.securityPolicyRevision||request.callId!==s.sourceCallId||request.authorityId!==options.authority.id||request.gatewayOrigin!==options.authority.gatewayOrigin||!same(request.context,s.wire)||!actual.result||!same(actual.result,s.result))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
 const {protocol:_p,kind:_k,callId:_id,expiresAt:_expires,...retry}=request;if(row.retry_key!==digest([row.peer_id,retry]))throw new SecurityError('POLICY_CHANGED');postgresConstrainReadDeadline(client,Date.parse(s.result.receipt.startedAt)+300000);
}
export function createPostgresRidePolicy(options:PostgresRideConfiguration):PostgresActionProgramPolicy{return {program:options.program,assertConfigured:async()=>{options.assertCurrent?.();},verifySourceReceipt:(...args)=>verifyPostgresRideReceipt(...args,options),validate:function*(context){const ctx=yield* postgresRideContextProgram(context,options.program);yield* validateRideProgram(options.program,ctx,context.step.action,context.input);return {privateDigest:digest({}),validUntil:context.validUntil};},verifyObservation:function*(context,attempt,response){
 if(attempt.kind!=='dispatch'||attempt.intentId!==context.intent.id||attempt.planDigest!==context.plan.digest||attempt.requestRevision!==(context.job.revision??0)||attempt.inputDigest!==digest(context.input)||context.attempt&&!same(context.attempt,attempt))fail('Ride attempt changed');const ctx=yield* postgresRideContextProgram(context,options.program);yield* validateRideProgram(options.program,ctx,context.step.action,context.input);const s=checkedRideSnapshot(response.value);
 if(!same(s.wire,rideWire(options.program,rideActionContext(context,ctx,attempt),context.step.action,context.input))||s.result.receipt.connectionDigest!==digest(options.binding)||s.result.receipt.evidenceKind!==options.program.evidenceKind||!same(response.evidenceRefs,[s.id])||Date.parse(s.result.receipt.startedAt)+300000<=context.graph.now())fail('Ride result changed or expired');
 }};}
