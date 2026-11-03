import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {digest,actionOperationKey} from '../core/delegation.js';
import {DomainError} from '../core/domain.js';
import type {AgentProgram} from '../core/agent-program.js';
import {agentLimits} from '../core/agent-limits.js';
import {agentOperation} from '../core/agent-authorization.js';
import {executionBudgetExceeded} from '../core/execution-budget.js';
import {resolveTaskRecovery} from '../core/task-recovery.js';
import type {RunEvidence} from '../capabilities/executor.js';
import {agentDecisionSchema,type AgentDecision,type AgentActionPlan} from '../ontology/agent-actions.js';
import type {ActionIntent} from '../ontology/actions.js';
import {objectRefSchema,type ObjectRef} from '../ontology/model.js';
import type {PlanningSnapshot} from '../ontology/planning-contract.js';
import {stepBindingRef,stepInputDigest,discoveredBinding,componentContext,componentScopeDigestProgram} from '../core/composed-actions.js';
import {assertGoalCoverage} from '../ontology/goal-coverage.js';
import {assertGoalEffects} from '../core/goal-contract.js';
import {readOntologyRequestProgram} from '../ontology/execution-projection.js';
import {runGraphProgramAsync} from '../ontology/graph-program.js';
import {compositionCompiler,evaluateCompositionChecks} from '../ontology/composition-contract.js';
import {resolvePostgresDocumentBinding,postgresReadRegistry} from './document-bindings.js';
import {assertPostgresPlanningDecisionEvidence,postgresGoalProgram} from './goal-contexts.js';
import {SecurityError} from '../security/errors.js';
import {postgresBusinessToken,postgresBusinessSchema,postgresConstrainReadDeadline,postgresRequireLeaseAtCommit} from './runtime-transaction.js';
import {postgresClaimSnapshotMatches,postgresWorkReference,type PostgresWorkReference} from './work-claim.js';
import type {PostgresReadProgramRegistry,PostgresReadRegistration} from './didi-registry.js';
import {PostgresTaskStorage} from './task-storage.js';
import {PostgresActionJournal} from './action-journal.js';
import {createPostgresActionAuthorization,type PostgresActionAuthorizationOptions,type PostgresActionProgramPolicy} from './action-authorization.js';
import {withPostgresWorkerEvidenceAuthorization} from './task-output.js';
import {withPostgresPlanningReadGraph} from './planning-read-graph.js';

type Registration=PostgresActionProgramPolicy&{program:PostgresActionProgramPolicy['program']&Pick<AgentProgram,'limits'|'privateInput'|'simulatedApproval'>};
export interface PostgresAgentPlanOptions extends Omit<PostgresActionAuthorizationOptions,'programs'|'observation'>{programs:readonly Registration[];registry?:PostgresReadProgramRegistry}
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
function fail(message:string):never{throw new DomainError('CONFLICT',message);}

/** Install one actual, already-recorded Agent decision. It performs storage
 * work only, uses the original task/claim, and validates every new intent with
 * the real registered action policy before the savepoint can be released.
 * First version intentionally rejects unported orchestration and private input
 * semantics rather than treating them as a valid executable frontier. */
export async function installPostgresAgentPlan(client:Client,input:PostgresWorkReference,suppliedDecision:AgentDecision,modelRunId:RunEvidence['id'],suppliedReads:PlanningSnapshot,options:PostgresAgentPlanOptions):Promise<AgentActionPlan>{
  const token=postgresBusinessToken(client),claim=postgresWorkReference(input),decision=agentDecisionSchema.parse(structuredClone(suppliedDecision)),reads=structuredClone(suppliedReads);
  const q=`"${postgresBusinessSchema(client)}"`,name=`agent_plan_${randomUUID().replaceAll('-','')}`;
  const query=async(sql:string,values:unknown[]=[])=>{if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');const result=await client.query(sql,values);if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');return result;};
  const fence=async()=>{if(!await postgresClaimSnapshotMatches(client,claim,options.policyDigest)||!await options.inspectClaim(claim))throw new SecurityError('ACCESS_REVOKED');postgresRequireLeaseAtCommit(client,digest(claim),()=>options.inspectClaim(claim));};
  if(decision.kind!=='execute'||!decision.steps.length||decision.completionJson)fail('A new Agent plan requires an explicit execute decision without a completion claim');
  if(decision.contexts?.length||decision.plannedCompletion||decision.plannedGoalCompletion||decision.componentId||decision.clarificationContextId||decision.informationRequest)
    fail('PostgreSQL component, completion and clarification planning are not installed on this plan path');
  if(claim.recovery)fail('Terminal recovery cannot install a new Agent plan');
  if(typeof modelRunId!=='string'||!modelRunId||modelRunId.length>200)fail('An original durable planning model run is required');
  if(Buffer.byteLength(JSON.stringify({decision,reads}))>8388608)fail('Agent planning evidence exceeds its bounded runtime record');
  await query(`SAVEPOINT ${name}`);
  try{
    await fence();const store=new PostgresTaskStorage(client,options.builder),job=await store.get(claim.owner,claim.job.id),d=job.delegation,state=d?.agent;
    if(job.state!=='working'||!d||!state||state.requestRevision!==d.request.revision||decision.requestRevision!==d.request.revision)fail('Agent decision belongs to a stale task or request revision');
    if(state.components||state.initialSelectionPending||d.callerAction)fail('PostgreSQL composition, initial selection and caller planning require their installed semantic ports');
    if(state.pendingPlanId)fail('The original pending frontier must be executed or reconciled before another plan');
    const registrations=options.programs.filter(value=>same(value.program.ref,state.programRef)&&value.program.configurationDigest===state.programDigest),registration=registrations[0];
    if(!state.composition&&(registrations.length!==1||!registration))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    const program:Registration['program']=state.composition?postgresGoalProgram(job):registration!.program,capability=program.capability();
    if(program.privateInput||program.simulatedApproval)fail('PostgreSQL private input and simulation planning are not installed on this plan path');
    if(!state.composition&&!registration!.validate)throw new SecurityError('AUTHORITY_UNAVAILABLE','PostgreSQL actual Agent planning semantics are not installed');
    if(!state.composition)assertGoalCoverage(job,capability);
    const evidence=assertPostgresPlanningDecisionEvidence(job,decision,modelRunId,reads);
    const histories=[state,...(d.agentHistory??[])],plans=histories.flatMap(value=>value.plans),limits=agentLimits(program);
    if(plans.some(plan=>plan.modelRunId===evidence.id))fail('This original model decision already installed its frontier');
    if(executionBudgetExceeded(job,'modelTurns')||program.limits&&(job.runs?.length??0)>limits.modelTurns)fail('Agent model budget is exhausted without a new authorized execution window');
    for(const [resource,additional] of [['plans',1],['actions',decision.steps.length]] as const)if(executionBudgetExceeded(job,resource,additional))fail(`Agent ${resource} budget is exhausted without a new authorized execution window`);
    if(program.limits&&(plans.length>=limits.plans||plans.reduce((total,plan)=>total+plan.steps.length,0)+decision.steps.length>limits.actions))fail('Agent program plan/action limits are exhausted');
    const intents=await store.intents(claim.owner,job.id);
    if(intents.some(intent=>!['read','local','object_write'].includes(intent.effect)&&['dispatching','awaiting_remote','effect_unknown','needs_review'].includes(intent.state)))fail('An unconfirmed original business effect blocks new planning');
    const delivered=reads.deliveredObjects??reads.objects,preceding=new Set<string>(),planId=randomUUID();
    if(!delivered.some(value=>same(value.ref,state.scope)))fail('Read the task scope before selecting actions');
    const data=await withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,(auth,admission,principal)=>
      withPostgresPlanningReadGraph(client,principal,job.id,options.policyDigest,auth,admission,async graph=>{
        const scope=await graph.read(claim.owner,state.scope);postgresConstrainReadDeadline(client,admission.validUntil);
        const request=state.composition?await runGraphProgramAsync(graph,readOntologyRequestProgram(graph,claim.owner,job.id)):d.request;
        return {scopeDigest:state.composition?digest(request):digest(scope.properties),model:graph.model,request};
      },options.builder),options.builder,options.modelChannel,options.inspectClaim);
    const steps:AgentActionPlan['steps']=[];
    for(const selected of decision.steps){
      if(preceding.has(selected.id)||new Set(selected.dependsOn).size!==selected.dependsOn.length||selected.dependsOn.some(id=>!preceding.has(id)))fail('Step IDs must be unique and dependencies must precede their consumers');
      if(selected.inputRefs.length||selected.acceptedInputs?.length)fail('PostgreSQL accepted/derived input planning is not installed on this plan path');
      if(!state.composition&&(selected.bindingDigest||selected.contextId||selected.contributesTo?.length))fail('PostgreSQL composition planning is not installed on this direct plan path');
      let readRegistration:PostgresReadRegistration|undefined,selectedProgram:Registration['program']=program,pinned:Pick<AgentActionPlan['steps'][number],'binding'|'contextDigest'|'contextScope'|'scopeDigest'>={};
      if(state.composition){
        if(!selected.bindingDigest||!selected.contextId||!selected.contributesTo?.length||selected.contributesTo.some(id=>!state.composition!.goal.criteria.some(criterion=>criterion.id===id)))fail('Each composed action must select an exact binding, context and contribution to the fixed goal');
        const pin=discoveredBinding(reads,selected.bindingDigest),resolved=await resolvePostgresDocumentBinding(client,claim,data.request,pin,options),component=state.composition.contexts.find(value=>value.id===selected.contextId)??fail('Prepare this original component before selecting its action');
        const registrations=options.programs.filter(value=>same(value.program.ref,pin.programRef)&&value.program.configurationDigest===pin.configurationDigest);
        if(registrations.length!==1||!registrations[0]?.validate||registrations[0].program.privateInput||registrations[0].program.simulatedApproval)throw new SecurityError('AUTHORITY_UNAVAILABLE','The selected composed action has no installed PostgreSQL semantic policy');
        if(pin.actionId!==selected.action)fail('Composed action differs from its actually discovered binding');selectedProgram=registrations[0].program;readRegistration=resolved.registration;await postgresReadRegistry(options).assertConfigured(client,resolved.registration,claim,job);
        const context={graph:{model:data.model,now:Date.now,releaseRef:d.ontologyRelease,security:true},owner:claim.owner,request:data.request,state,intents,modelRuns:job.runs};
        const scoped=componentContext(context,component,resolved.program);
        if(component.managedActionIds&&!component.managedActionIds.includes(selected.action))fail('Action is outside its explicitly selected managed context');
        if(!delivered.some(value=>same(value.ref,component.scope)))fail('Read this component scope before selecting its actions');
        const scopeDigest=await withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,(auth,admission,principal)=>withPostgresPlanningReadGraph(client,principal,job.id,options.policyDigest,auth,admission,graph=>runGraphProgramAsync(graph,componentScopeDigestProgram(scoped,component.scope)),options.builder),options.builder,options.modelChannel,options.inspectClaim);
        pinned={binding:pin,contextDigest:component.digest,contextScope:component.scope,scopeDigest};
      }
      const definition=data.model.action(selected.action),operation=agentOperation(definition);
      if(!selectedProgram.actionIds.includes(selected.action)||!state.composition&&state.managedActionIds&&!state.managedActionIds.includes(selected.action))fail('This Agent binding does not permit the selected action');
      if(state.composition)assertGoalEffects(state.composition.goal,[operation.effect,...('additionalEffects'in operation?operation.additionalEffects??[]:[])]);
      if(!['read','local'].includes(operation.effect)||'additionalEffects'in operation&&operation.additionalEffects?.length)fail('PostgreSQL business-effect planning requires its installed exact authority port');
      const parsed:unknown=JSON.parse(selected.argumentsJson);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail('Action arguments must be an object');
      const actionInput=parsed as Record<string,unknown>;selectedProgram.schema(selected.action).parse(actionInput);
      if(state.composition){
        if(!readRegistration)throw new SecurityError('AUTHORITY_UNAVAILABLE','The selected composed program has no actual PostgreSQL registration');
        if(readRegistration.kind==='document'&&(Array.isArray(actionInput.citations)&&actionInput.citations.length||Array.isArray(actionInput.additionalCitations)&&actionInput.additionalCitations.length))fail('Composed document citations require their installed current producer semantics');
        if(!definition.composition)fail('Missing action composition contract');evaluateCompositionChecks(definition.composition,'before',actionInput,{},compositionCompiler(data.model));
      }
      const refs=new Map<string,ObjectRef>();let nodes=0;
      const inspect=(value:unknown)=>{if(++nodes>5000)fail('Agent input exceeds its bounded reference traversal');if(!value||typeof value!=='object')return;const ref=objectRefSchema.safeParse(value);if(ref.success)refs.set(digest(ref.data),ref.data);else for(const child of Object.values(value))inspect(child);};inspect(actionInput);
      if([...refs.values()].some(ref=>!delivered.some(value=>same(value.ref,ref))))fail('Read referenced ontology objects before selecting an action');
      const operationKey=actionOperationKey(claim.owner,d.request.id,`${planId}:${selected.id}`);
      if((await query(`SELECT 1 FROM ${q}.action_intents WHERE owner=$1 AND business_key=$2 LIMIT 1`,[claim.owner,operationKey])).rowCount)fail('This business operation already has an original intent');
      steps.push({...selected,...pinned,input:actionInput,definitionDigest:digest(definition),intentId:randomUUID(),effect:operation.effect,operationKey});preceding.add(selected.id);
    }
    if(steps.some(step=>step.effect==='local')&&steps.length!==1)fail('Local handoff actions require their own frontier');
    const body:Omit<AgentActionPlan,'digest'>={id:planId,version:state.composition?'3':'2',sequence:plans.length+1,requestId:job.id,requestRevision:d.request.revision,
      programRef:state.programRef,programDigest:state.programDigest,scope:state.scope,scopeDigest:data.scopeDigest,modelRunId:evidence.id,modelDecision:decision,
      reasoning:decision.message,createdAt:new Date().toISOString(),steps,ontologyPlanning:reads};
    const plan={...body,digest:digest(body)};
    state.plans.push(plan);state.pendingPlanId=plan.id;d.phase='executing';resolveTaskRecovery(job,'decision');job.updatedAt=plan.createdAt;
    d.events.push({at:plan.createdAt,event:'agent_action_plan_validated',evidence:plan.digest});
    await store.save(claim.owner,job);
    const journal=new PostgresActionJournal(client,{...options,authorize:createPostgresActionAuthorization(client,options)});
    for(const step of steps){
      const intent:ActionIntent={id:step.intentId,owner:claim.owner,jobId:job.id,stepId:step.id,businessOperationKey:step.operationKey,planDigest:plan.digest,
        bindingRef:stepBindingRef(plan,step),inputDigest:stepInputDigest(step),privateDigest:digest({}),privateData:{},effect:step.effect,state:'ready',nextAt:0,createdAt:plan.createdAt};
      if(await journal.createIntent(claim,intent)!==intent.id)fail('A fresh plan cannot substitute another original intent');
    }
    await fence();await query(`RELEASE SAVEPOINT ${name}`);return structuredClone(plan);
  }catch(error){await query(`ROLLBACK TO SAVEPOINT ${name}`);await query(`RELEASE SAVEPOINT ${name}`);throw error;}
}
