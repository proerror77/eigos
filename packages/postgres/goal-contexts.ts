import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {digest} from '../core/delegation.js';
import {DomainError,type Job} from '../core/domain.js';
import {discoveredBinding} from '../core/composed-actions.js';
import {assertGoalContract} from '../core/goal-contract.js';
import {executionBudgetExceeded,executionBudgetStatus} from '../core/execution-budget.js';
import {canRecoverReadOnly,resolveTaskRecovery} from '../core/task-recovery.js';
import {GoalProgram} from '../coordinator/goal-program.js';
import {validatePlanningSnapshotProgram,type PlanningMetadata} from '../coordinator/planning-program.js';
import type {RunEvidence} from '../capabilities/executor.js';
import {agentDecisionSchema,type AgentDecision,type AgentComponentContext} from '../ontology/agent-actions.js';
import type {PlanningSnapshot} from '../ontology/planning-contract.js';
import {runGraphProgramAsync} from '../ontology/graph-program.js';
import {authorizedDefinitionCatalogue,describeDefinitionCatalogue} from '../security/definition-view.js';
import {SecurityError} from '../security/errors.js';
import {postgresBusinessToken,postgresBusinessSchema,postgresConstrainReadDeadline,postgresRequireLeaseAtCommit} from './runtime-transaction.js';
import {postgresClaimSnapshotMatches,postgresWorkReference,type PostgresWorkReference} from './work-claim.js';
import {PostgresTaskStorage} from './task-storage.js';
import {withPostgresWorkerRequestAuthorization} from './task-output.js';
import {withPostgresOntologyReleaseSnapshot} from './ontology-release.js';
import {withPostgresPlanningReadGraph,postgresPlanningAccessDigest} from './planning-read-graph.js';
import {withPostgresTaskDefinitionAccess} from './ontology-metadata.js';
import {withPostgresSourceProjection} from './source-projection.js';
import {resolvePostgresDocumentBinding,postgresReadRegistry} from './document-bindings.js';
import type {PostgresAgentPlanOptions} from './agent-plan.js';

const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
function fail(message:string):never{throw new DomainError('CONFLICT',message);}
export interface PostgresGoalContextOptions extends PostgresAgentPlanOptions{sourceBindingId?:string}

/** The actual persisted planning response and acknowledged native receipts,
 * shared by context setup and plan installation. It grants no execution. */
export function assertPostgresPlanningDecisionEvidence(job:Job,decision:AgentDecision,modelRunId:string,reads:PlanningSnapshot):RunEvidence{
  const d=job.delegation??fail('Original task delegation is missing'),recorded=job.runs?.filter(run=>run.id===modelRunId),evidence=recorded?.[0];
  if(recorded?.length!==1||!evidence)fail('Agent decision has no unique original durable planning model receipt');
  const started=Date.parse(evidence.startedAt),completed=Date.parse(evidence.completedAt);
  if(evidence.purpose!=='planning'||evidence.decisionDigest!==digest(decision)||!Number.isFinite(started)||!Number.isFinite(completed)||started<Date.parse(job.createdAt)||completed<started||completed>Date.now())fail('Agent decision differs from its original durable planning model receipt');
  if(reads.mode==='trusted_template'||!reads.reads.length||new Set(reads.reads.map(read=>read.id)).size!==reads.reads.length
    ||reads.reads.some(read=>!d.ontologyReads?.some(current=>current.id===read.id&&same(current,read))||!Number.isFinite(Date.parse(read.at))||Date.parse(read.at)>completed||read.origin!=='worker_context'&&Date.parse(read.at)<started))fail('Agent planning reads differ from the original model interval and durable receipt ledger');
  if(evidence.ontologyContext&&(!same(evidence.ontologyContext.model,reads.model)||evidence.ontologyContext.requestRevision!==d.request.revision||!evidence.ontologyContext.receiptIds.every(id=>reads.reads.some(read=>read.id===id))))fail('Agent model preparation differs from its actual planning reads');
  if(evidence.ontologyMcp){const native=evidence.ontologyMcp;
    if(native.taskId!==job.id||native.transport!=='streamable-http'||!native.decisionSubmitted||!native.sessionId||reads.reads.filter(read=>read.origin!=='worker_context').some(read=>!native.calls.some(call=>call.receiptId===read.id&&call.tool===read.tool&&call.status===read.status&&call.inputDigest===read.inputDigest&&call.outputDigest===read.outputDigest)))fail('Agent decision differs from its original native MCP read receipts');
  }
  return evidence;
}
export function postgresGoalProgram(job:Job){
  const d=job.delegation??fail('Original goal delegation is missing'),state=d.agent??fail('Original goal state is missing'),goal=state.composition?.goal??fail('This original task has no fixed goal composition');
  assertGoalContract(goal,d.request,d.ontologyRelease);const program=new GoalProgram(goal);
  if(state.version!=='2'||!same(state.programRef,program.ref)||state.programDigest!==program.configurationDigest||!same(state.scope,{type:'ServiceRequest',id:job.id})||Object.keys(state.input).length||state.requestRevision!==d.request.revision)fail('The original goal program or scope changed');
  return program;
}

/** Pure document component setup from an actual native prepare_contexts
 * decision. Source reads/writes are checked and all changes share a savepoint;
 * no task, grant, provider call or model invocation is created here. */
export async function preparePostgresGoalContexts(client:Client,input:PostgresWorkReference,supplied:AgentDecision,modelRunId:string,suppliedReads:PlanningSnapshot,options:PostgresGoalContextOptions):Promise<AgentComponentContext[]>{
  const token=postgresBusinessToken(client),claim=postgresWorkReference(input),decision=agentDecisionSchema.parse(structuredClone(supplied)),reads=structuredClone(suppliedReads),q=`"${postgresBusinessSchema(client)}"`,name=`goal_context_${randomUUID().replaceAll('-','')}`;
  const query=async(sql:string,values:unknown[]=[])=>{if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');const result=await client.query(sql,values);if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');return result;};
  const fence=async()=>{if(!await postgresClaimSnapshotMatches(client,claim,options.policyDigest)||!await options.inspectClaim(claim))throw new SecurityError('ACCESS_REVOKED');postgresRequireLeaseAtCommit(client,digest(claim),()=>options.inspectClaim(claim));};
  if(claim.recovery||decision.kind!=='prepare'||decision.steps.length||decision.completionJson||!decision.contexts?.length||decision.plannedCompletion||decision.plannedGoalCompletion||decision.componentId||decision.clarificationContextId||decision.informationRequest)fail('Context preparation requires only an explicit original prepare_contexts decision');
  if(!modelRunId||modelRunId.length>200||Buffer.byteLength(JSON.stringify({decision,reads}))>8388608)fail('Original component planning evidence exceeds its bounded record');
  await query(`SAVEPOINT ${name}`);
  try{
    await fence();const store=new PostgresTaskStorage(client,options.builder),job=await store.get(claim.owner,claim.job.id),d=job.delegation??fail('Original delegation is missing'),state=d.agent??fail('Original goal state is missing');postgresGoalProgram(job);
    if(job.state!=='working'||decision.requestRevision!==d.request.revision||state.pendingPlanId||state.components||state.initialSelectionPending||d.callerAction)fail('The original goal has a pending frontier or a stale context decision');
    assertPostgresPlanningDecisionEvidence(job,decision,modelRunId,reads);if(executionBudgetExceeded(job,'modelTurns'))fail('The original goal model budget is exhausted');
    const intents=await store.intents(claim.owner,job.id);if(intents.some(intent=>!['read','local','object_write'].includes(intent.effect)&&['dispatching','awaiting_remote','effect_unknown','needs_review'].includes(intent.state)))fail('An unconfirmed original business effect blocks new component preparation');
    const maximum=options.maxTaskMs??86400000;if(!Number.isSafeInteger(maximum)||maximum<1||maximum>86400000)throw new Error('Invalid fixed goal deadline');
    const until=Date.parse(canRecoverReadOnly(job,intents)&&!state.paPayment?executionBudgetStatus(job).window.startedAt:job.createdAt)+maximum;postgresConstrainReadDeadline(client,until);
    if(state.composition!.contexts.length+decision.contexts.length>16)fail('Task component context limit reached');
    const ids=new Set([...state.composition!.contexts.map(value=>value.id),...(state.composition!.retiredContexts??[]).map(value=>value.id)]),contexts:AgentComponentContext[]=[],registry=postgresReadRegistry(options),goalDigest=state.composition!.goal.digest,requestDigest=digest(d.request);
    await withPostgresOntologyReleaseSnapshot(client,()=>withPostgresWorkerRequestAuthorization(client,claim,options.policyDigest,(auth,admission,principal)=>withPostgresPlanningReadGraph(client,principal,job.id,options.policyDigest,auth,admission,graph=>withPostgresTaskDefinitionAccess(client,principal,job.id,options.policyDigest,async(access,selected)=>{
      const meta:PlanningMetadata={model:graph.model,now:graph.now,releaseRef:graph.releaseRef,security:true,authorization:{accessDigest:()=>postgresPlanningAccessDigest(admission),definitions:()=>authorizedDefinitionCatalogue(access,selected),describe:value=>describeDefinitionCatalogue(access,value,selected),binding:ref=>(reads.deliveredObjects??reads.objects).some(value=>same(value.ref,ref)),requireResource:(kind,id)=>{if(!access.resourceAllowed(kind,id))throw new SecurityError('AUTHORIZATION_REQUIRED');},receipt:()=>({accessDigest:postgresPlanningAccessDigest(admission),securityEnvelope:graph.evidence()})}};
      await runGraphProgramAsync(graph,validatePlanningSnapshotProgram(meta,claim.owner,d.request,reads,true));
    },options.builder),options.builder),options.builder,options.modelChannel,options.inspectClaim));
    for(const selected of decision.contexts){
      if(ids.has(selected.id))fail('A component context cannot be replaced or initialized twice');ids.add(selected.id);
      const pin=discoveredBinding(reads,selected.bindingDigest),registered=options.programs.filter(value=>same(value.program.ref,pin.programRef)&&value.program.configurationDigest===pin.configurationDigest);
      if(registered.length!==1||!registered[0]?.validate)throw new SecurityError('AUTHORITY_UNAVAILABLE','The selected component has no installed PostgreSQL initialization semantics');
      if(registered[0].program.privateInput||registered[0].program.simulatedApproval)fail('Private or simulation component initialization is not installed');
      const resolved=await resolvePostgresDocumentBinding(client,claim,d.request,pin,options),parsed:unknown=JSON.parse(selected.inputJson);await registry.assertConfigured(client,resolved.registration,claim,job);
      await withPostgresSourceProjection(client,claim,{...options,programRef:resolved.program.ref,configurationDigest:resolved.program.configurationDigest,sourceBindingId:resolved.registration.sourceBindingId??(resolved.registration.kind==='document'?options.sourceBindingId:undefined)},async graph=>{
        const protectedScopes=await Promise.all([...state.composition!.contexts,...contexts].map(async component=>({ref:component.scope,digest:digest((await graph.read(claim.owner,component.scope)).properties)})));
        const initialized=await runGraphProgramAsync(graph,resolved.registration.initialize(graph,claim.owner,graph.request,parsed,{id:selected.id,scopeKey:digest({request:job.id,revision:d.request.revision,program:resolved.program.ref,context:selected.id})}));
        await graph.read(claim.owner,initialized.scope);
        for(const old of protectedScopes)if(digest((await graph.read(claim.owner,old.ref)).properties)!==old.digest)fail('Pure component preparation cannot rewrite an existing context');
        const body:Omit<AgentComponentContext,'digest'>={id:selected.id,programRef:resolved.program.ref,programDigest:resolved.program.configurationDigest,requestRevision:d.request.revision,...initialized,initializedBy:{modelRunId,binding:pin,decision:structuredClone(decision),ontologyPlanning:structuredClone(reads)}};
        contexts.push({...body,digest:digest(body)});
      });
    }
    for(const component of contexts)await registry.assertConfigured(client,registry.require(component.programRef,component.programDigest),claim,job);
    if(digest(d.request)!==requestDigest||state.composition!.goal.digest!==goalDigest)fail('Component preparation cannot revise the original request or fixed goal');
    state.composition!.contexts.push(...contexts);d.phase='planning';d.nextAt=0;resolveTaskRecovery(job,'decision');job.updatedAt=new Date().toISOString();d.events.push({at:job.updatedAt,event:'agent_contexts_prepared',evidence:digest(contexts.map(value=>value.digest))});
    await store.save(claim.owner,job);await fence();await query(`RELEASE SAVEPOINT ${name}`);return structuredClone(contexts);
  }catch(error){await query(`ROLLBACK TO SAVEPOINT ${name}`);await query(`RELEASE SAVEPOINT ${name}`);throw error;}
}
