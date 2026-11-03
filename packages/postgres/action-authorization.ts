import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {canRecoverReadOnly} from '../core/task-recovery.js';
import {executionBudgetStatus} from '../core/execution-budget.js';
import type {Job} from '../core/domain.js';
import type {AgentProgram,AgentActionAuthority,AgentActionResult} from '../core/agent-program.js';
import {agentOperation,hasSimulationApproval,matchesAgentGrant} from '../core/agent-authorization.js';
import {stepBindingRef,stepInputDigest} from '../core/composed-actions.js';
import {assertGoalContract,assertGoalEffects} from '../core/goal-contract.js';
import {assertGoalCoverage} from '../ontology/goal-coverage.js';
import type {AgentActionPlan} from '../ontology/agent-actions.js';
import type {ActionIntent,ActionResult,ExecutionAttempt,PlanGrant} from '../ontology/actions.js';
import {moneySchema} from '../ontology/execution.js';
import {compositionCompiler} from '../ontology/composition-contract.js';
import type {JsonSchema} from '../ontology/definition-contracts.js';
import {assertAgentPlanProjectionProgram,readExecutionContextProgram,executionStepRef} from '../ontology/execution-projection.js';
import {objectRefSchema,type OntologyModel} from '../ontology/model.js';
import {runGraphProgramAsync,type GraphProgram} from '../ontology/graph-program.js';
import {validatePlanningSnapshotProgram,type PlanningMetadata} from '../coordinator/planning-program.js';
import {authorizedDefinitionCatalogue,describeDefinitionCatalogue} from '../security/definition-view.js';
import {actionSources} from '../security/component-authority.js';
import {storedSourceSchema,type StoredSource} from '../security/source-policy.js';
import {combineEnvelopes,type SecurityEnvelope} from '../security/envelope.js';
import {SecurityError} from '../security/errors.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {assertFreshPostgresActionIntent,type PostgresActionJournalOptions} from './action-journal.js';
import {PostgresTaskStorage} from './task-storage.js';
import {PostgresProjectionGraph} from './projection-graph.js';
import {withPostgresWorkerEvidenceAuthorization} from './task-output.js';
import {withPostgresPlanningReadGraph,postgresPlanningAccessDigest} from './planning-read-graph.js';
import {withPostgresTaskDefinitionAccess} from './ontology-metadata.js';
import {postgresTaskReadOntology,postgresTaskResourcePermissionValidUntil} from './task-read-access.js';
import {postgresTaskReadHistory} from './task-lineage.js';

type Check=Parameters<PostgresActionJournalOptions['authorize']>[0];
type ProgramMetadata=Pick<AgentProgram,'ref'|'configurationDigest'|'actionIds'|'capability'|'schema'|'callerManagedActions'|'liveFreeReservation'>;
export interface PostgresActionSemanticContext {
  readonly model:OntologyModel;
  readonly graph:import('../ontology/graph-program.js').ProjectionMetadata;
  readonly owner:string;
  readonly intents:readonly ActionIntent[];
  /** Fixed current admission and task deadline. Semantic evidence may narrow it. */
  readonly validUntil:number;
  readonly job:Job;
  readonly plan:AgentActionPlan;
  readonly step:AgentActionPlan['steps'][number];
  readonly intent:ActionIntent;
  readonly input:Record<string,unknown>;
  readonly operation:Check['operation'];
  readonly attempt?:ExecutionAttempt;
}
export interface PostgresActionProgramPolicy {
  readonly program:ProgramMetadata;
  /** The real program's read-only semantic/Pipeline checks, current private
   * input and dynamic authority calculation, ported to shared GraphPrograms.
   * No synchronous OntologyObjectStore or permissive default is substituted. */
  validate?:(context:PostgresActionSemanticContext)=>GraphProgram<{privateDigest:string;validUntil:number;
    /** Required for derived/accepted inputs: digest of the input recomputed
     * from current accepted ports and authorized function evidence. A saved
     * inputResolution digest alone is not this proof. */
    materializedInputDigest?:string;
    authority?:AgentActionAuthority;simulatedApproval?:{amount:{minor:string;currency:string};expiresAt:string}}>;
  /** Reproduce the original authenticated grounding decision's scope binding,
   * delivered definition receipts, timing and combined read budget. */
  verifyInitialSelection?:(context:PostgresActionSemanticContext)=>GraphProgram<void>;
  /** Validate the original trusted provider response against its registered
   * result contract. This does not replace the atomic mapper in the journal. */
  verifyObservation?:(context:PostgresActionSemanticContext,attempt:ExecutionAttempt,response:AgentActionResult,result:ActionResult)=>GraphProgram<void>;
}
export interface PostgresActionAuthorizationOptions {
  policyDigest:string;
  modelChannel:string;
  inspectClaim:PostgresActionJournalOptions['inspectClaim'];
  programs:readonly PostgresActionProgramPolicy[];
  builder?:StagedKernelBuilder;
  allowSandbox?:boolean;
  allowExternalDrafts?:boolean;
  maxTaskMs?:number;
  /** Server-owned response from the actual bound invocation/readback. Never
   * accept this proof from MCP/A2A request JSON or reconstruct it from a ledger
   * result after a crash. A missing proof keeps the receipt audit-only. */
  observation?:{attemptId:string;response:AgentActionResult};
}
function deny(reason:ConstructorParameters<typeof SecurityError>[0]='AUTHORIZATION_REQUIRED',message?:string):never{throw new SecurityError(reason,message);}
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
const refKey=(ref:{type:string;id:string})=>JSON.stringify([ref.type,ref.id]);

/** Normalize exactly as the existing Agent runtime does, retaining the source
 * event while binding every re-read to its actual original attempt. */
function normalizedResponse(response:AgentActionResult,attempt:ExecutionAttempt):ActionResult{
  const source=response.observation;
  if(!source)return {kind:response.pending?'pending':'confirmed',...(response.pending?{retryAfterMs:response.pending.retryAfterMs}:{}),eventId:attempt.id,sourceVersion:attempt.ordinal,output:{source:response.value},evidenceRefs:response.evidenceRefs};
  if(!['pending','confirmed','rejected','unknown','not_found'].includes(source.kind)||!source.eventId||!Number.isSafeInteger(source.sourceVersion)||source.sourceVersion<0||!same(source.evidenceRefs,response.evidenceRefs))deny('SOURCE_NOT_AUTHORIZED');
  return {...source,eventId:`agent-source:${digest({eventId:source.eventId,attemptId:attempt.id})}`,output:{...source.output,source:response.value}};
}

/** Real PostgreSQL role/source/plan/permit/evidence admission for the action
 * journal. Missing semantic or provider-verification ports fail closed with
 * AUTHORITY_UNAVAILABLE; none is interpreted as an allowed business action. */
export function createPostgresActionAuthorization(client:Client,options:PostgresActionAuthorizationOptions):PostgresActionJournalOptions['authorize']{
  const schema=postgresBusinessSchema(client),token=postgresBusinessToken(client),q=`"${schema}"`;
  if(!/^[a-f0-9]{64}$/.test(options.policyDigest)||!options.modelChannel||typeof options.inspectClaim!=='function'||options.programs.length>200)throw new Error('Explicit PostgreSQL action authority configuration is required');
  const maximum=options.maxTaskMs??86400000;if(!Number.isSafeInteger(maximum)||maximum<1||maximum>86400000)throw new Error('Invalid fixed action deadline');
  const programs=[...options.programs],proof=options.observation&&structuredClone(options.observation);
  if(new Set(programs.map(item=>digest([item.program.ref,item.program.configurationDigest]))).size!==programs.length)throw new Error('Ambiguous PostgreSQL action program registration');
  return async supplied=>{
    if(postgresBusinessToken(client)!==token)deny();
    const check=structuredClone(supplied),fresh=['create','dispatch','dispatch_check','budget'].includes(check.operation),launch=check.operation==='dispatch'||check.operation==='dispatch_check',store=new PostgresTaskStorage(client,options.builder);
    if(check.operation==='create')assertFreshPostgresActionIntent(check.intent);
    if(check.claim.owner!==check.intent.owner||check.claim.job.id!==check.intent.jobId)deny();
    const job=await store.get(check.claim.owner,check.claim.job.id);
    if(!same(job,check.job))deny('POLICY_CHANGED');
    const state=job.delegation?.agent,request=job.delegation?.request;
    if(!state||!request||!job.delegation?.ontologyRelease)deny('AUTHORITY_UNAVAILABLE','PostgreSQL fixed-adapter action authority has no installed semantic port');
    const plans=state.plans.filter(plan=>plan.digest===check.intent.planDigest),plan=plans[0],steps=plan?.steps.filter(step=>step.intentId===check.intent.id),step=steps?.[0];
    if(plans.length!==1||!plan||steps?.length!==1||!step||!same(plan.programRef,state.programRef)||plan.programDigest!==state.programDigest||plan.requestId!==job.id||plan.requestRevision!==request.revision||state.requestRevision!==request.revision)deny();
    const {digest:planDigest,...planBody}=plan;
    if(digest(planBody)!==planDigest||check.intent.stepId!==step.id||check.intent.businessOperationKey!==step.operationKey||check.intent.inputDigest!==stepInputDigest(step)
      ||!same(check.intent.bindingRef,stepBindingRef(plan,step))||check.intent.effect!==step.effect||!same(check.intent.additionalEffects??[],step.additionalEffects??[])
      ||check.intent.privateDigest!==digest(check.intent.privateData)||check.intent.privateDigest!==(step.privateDigest??digest({})))deny('POLICY_CHANGED');
    if(fresh&&state.pendingPlanId!==plan.id)deny('AUTHORIZATION_REQUIRED','Only the current fixed execution frontier can start an action');
    if(fresh&&(plan.steps.some(value=>value.effect==='local')&&plan.steps.length!==1||plan.steps.filter(value=>value.effect!=='read').length>1))deny('POLICY_CHANGED','The original frontier requires a separate local or business operation');
    if(check.operation==='create'&&check.intent.createdAt!==plan.createdAt)deny('POLICY_CHANGED');
    if(check.operation==='dispatch'&&check.intent.state!=='ready'||check.operation==='dispatch_check'&&check.intent.state!=='dispatching'||!fresh&&check.intent.state==='canceled_before_dispatch')deny('ACCESS_REVOKED');
    const registered=programs.filter(item=>same(item.program.ref,step.binding?.programRef??state.programRef)&&item.program.configurationDigest===(step.binding?.configurationDigest??state.programDigest));
    if(registered.length!==1)deny('SOURCE_NOT_AUTHORIZED');const registration=registered[0]!,program=registration.program,capability=program.capability();
    // Pure origin checks need only this metadata marker, never a SecurityStore.
    if(plan.callerDecision){
      if(!program.callerManagedActions)deny();
      const envelope=job.delegation.callerAction;
      if(!envelope||plan.modelRunId||plan.modelDecision||plan.ontologyPlanning.mode!=='trusted_template'||plan.callerDecision.envelopeDigest!==digest(envelope)||plan.callerDecision.requestId!==envelope.requestId
        ||envelope.ownerDigest!==digest(check.claim.owner)||!same(envelope.ontologyRelease,job.delegation.ontologyRelease)||!same(envelope.programRef,plan.programRef)||envelope.inputDigest!==digest(envelope.input)
        ||!request.messages.some(message=>message.id===envelope.requestId)||plan.steps.length!==1||step.effect!=='object_write'||step.action!==envelope.action||digest(step.input)!==envelope.inputDigest)deny('POLICY_CHANGED');
    }else{
      if(!plan.modelRunId||!plan.modelDecision||job.delegation.callerAction||!['model_queries','worker_context','worker_context_with_queries'].includes(plan.ontologyPlanning.mode))deny('POLICY_CHANGED');
      if(plan.initialSelection){
        const original=job.delegation.groundingDecisions?.find(item=>item.modelRunId===plan.initialSelection!.modelRunId),run=job.runs?.find(item=>item.id===plan.modelRunId);
        if(plan.sequence!==1||plan.initialSelection.modelRunId!==plan.modelRunId||!original||run?.purpose!=='grounding'||run.decisionDigest!==digest(original.decision))deny('POLICY_CHANGED');
        if(!registration.verifyInitialSelection)deny('AUTHORITY_UNAVAILABLE','PostgreSQL original grounding/initial-selection verifier is not installed');
      }else if(!job.runs?.some(run=>run.id===plan.modelRunId&&run.decisionDigest===digest(plan.modelDecision)))deny('POLICY_CHANGED');
      if(!state.composition)assertGoalCoverage(job,capability);
    }
    const decision=plan.modelDecision??plan.callerDecision?.decision;
    if(!decision||decision.kind!=='execute'||decision.requestRevision!==request.revision||plan.steps.length!==decision.steps.length||plan.steps.some((value,index)=>{
      const {confirmation:_confirmation,simulatedApproval:_simulation,privateDigest:_private,definitionDigest:_definition,input,intentId:_intent,effect:_effect,additionalEffects:_effects,cost:_cost,budgetImpact:_budget,objectWrite:_write,externalDraft:_draft,operationScope:_scope,operationKey:_key,binding:_binding,contextDigest:_context,contextScope:_contextScope,scopeDigest:_scopeDigest,acceptedInputSources:_sources,...selected}=value;
      return !same(selected,decision.steps[index])||!same(input,JSON.parse(value.argumentsJson));
    }))deny('POLICY_CHANGED');
    if(state.composition){assertGoalContract(state.composition.goal,request,job.delegation.ontologyRelease);assertGoalEffects(state.composition.goal,[step.effect,...(step.additionalEffects??[])]);}
    if(check.operation!=='create'){
      const rows=await client.query(`SELECT state,CASE WHEN octet_length(body)<=8388608 THEN body END AS body,CASE WHEN octet_length(private_data)<=8388608 THEN private_data END AS private_data FROM ${q}.action_intents WHERE owner=$1 AND job_id=$2 AND id=$3 LIMIT 2`,[check.claim.owner,job.id,check.intent.id]);
      if(rows.rowCount!==1||typeof rows.rows[0].body!=='string'||typeof rows.rows[0].private_data!=='string'||!same({...JSON.parse(rows.rows[0].body),state:rows.rows[0].state,privateData:JSON.parse(rows.rows[0].private_data)},check.intent))deny('POLICY_CHANGED');
    }
    const input=check.intent.dispatchInput??step.input;
    if(check.attempt){
      const attempt=check.attempt;
      if(attempt.intentId!==check.intent.id||attempt.claimToken!==check.claim.token||attempt.requestRevision!==(job.revision??0)||attempt.planDigest!==plan.digest)deny('ACCESS_REVOKED');
      if(launch&&(attempt.kind!=='dispatch'||attempt.requestKey!==check.intent.businessOperationKey||attempt.inputDigest!==digest(input)))deny('POLICY_CHANGED');
      if(check.operation==='accept'||check.operation==='dispatch_check'){
        const rows=await client.query(`SELECT CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.action_attempts WHERE owner=$1 AND intent_id=$2 AND id=$3 LIMIT 2`,[check.claim.owner,check.intent.id,attempt.id]);
        if(rows.rowCount!==1||typeof rows.rows[0].body!=='string'||!same(JSON.parse(rows.rows[0].body),attempt))deny('ACCESS_REVOKED');
      }
    }else if(['dispatch','dispatch_check','observe','reconcile','resume','accept'].includes(check.operation))deny();
    if(step.inputRefs.length||step.acceptedInputs?.length){
      const resolved=state.inputResolutions?.find(value=>value.planId===plan.id&&value.stepId===step.id&&value.intentId===check.intent.id&&value.inputDigest===digest(input));
      if(!check.intent.dispatchInput||!resolved)deny('AUTHORITY_UNAVAILABLE','Exact PostgreSQL accepted-input derivation proof is required');
    }
    return withPostgresWorkerEvidenceAuthorization(client,check.claim,options.policyDigest,async(auth,admission,principal)=>{
      if(admission.actor.actorKind!=='worker'||admission.actor.taskId!==job.id||admission.grant.taskId!==job.id||admission.grant.requestRevision!==request.revision||!admission.grant.operations.includes('task.process')
        ||![program.ref.id,capability.ref.id].some(id=>admission.parent.capabilityIds.includes(id)))deny();
      const currentIntents=await store.intents(check.claim.owner,job.id),readOnly=canRecoverReadOnly(job,[...currentIntents,check.intent])&&!state.paPayment;
      if(launch)for(const dependency of step.dependsOn){
        const predecessor=plan.steps.find(value=>value.id===dependency),intent=predecessor&&currentIntents.find(value=>value.id===predecessor.intentId);
        if(!intent||intent.planDigest!==plan.digest||intent.state!=='effect_confirmed')deny('AUTHORIZATION_REQUIRED','An original predecessor has no confirmed outcome');
      }
      let validUntil=Math.min(admission.validUntil,Date.parse(readOnly?executionBudgetStatus(job).window.startedAt:job.createdAt)+maximum);
      const deadline=(until:number)=>{if(!Number.isSafeInteger(until)||until<=Date.now())deny('ACCESS_REVOKED');validUntil=Math.min(validUntil,until);postgresConstrainReadDeadline(client,validUntil);};
      deadline(validUntil);
      for(const permission of ['resource.view','action.execute'] as const)deadline(await postgresTaskResourcePermissionValidUntil(client,principal,job.id,options.policyDigest,'actionType',step.action,permission,options.builder));
      const sourceRows=await client.query(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' LIMIT 257`,[check.claim.owner,admission.actor.installationId]);
      if(sourceRows.rows.length>256||sourceRows.rows.some(row=>typeof row.body!=='string'))deny('SOURCE_NOT_AUTHORIZED');
      const sources:StoredSource[]=sourceRows.rows.map(row=>{const source=storedSourceSchema.parse(JSON.parse(row.body));if(source.bindingId!==row.binding_id||source.programId!==row.program_id||source.installationId!==admission.actor.installationId)deny('SOURCE_NOT_AUTHORIZED');return source;});
      for(const needed of actionSources(state,step.action,step.input,step)){
        const choices=sources.filter(source=>source.programId===needed.programRef.id&&source.programDigest===needed.programDigest&&source.operations.includes(step.action)
          &&source.parentGrant.id===admission.parent.id&&source.parentGrant.revision===admission.parent.revision&&Date.parse(source.expiresAt)>Date.now()
          &&admission.parent.sourceBindingIds.includes(source.bindingId)&&admission.parent.capabilityIds.includes(source.programId)
          &&admission.grant.outputs.some(output=>output.programId===source.programId&&output.programDigest===source.programDigest&&output.sourceBindingId===source.bindingId&&source.outputTypes.includes(output.type)
            &&output.fields.every(field=>admission.parent.resources.some(resource=>resource.type===output.type&&resource.fields.includes(field)))));
        if(choices.length!==1)deny('SOURCE_NOT_AUTHORIZED');deadline(Date.parse(choices[0]!.expiresAt));
      }
      const ontology=await postgresTaskReadOntology(client,principal,job.id,options.policyDigest,options.builder);
      const definition=ontology.model.action(step.action),operation=agentOperation(definition),bindings=capability.actions.filter(binding=>binding.ref.id===step.action);
      const registeredSchema=definition.implementation?.kind==='declarative'?z.toJSONSchema(compositionCompiler(ontology.model).schema(operation.inputSchema as JsonSchema)):operation.inputSchema;
      if(!program.actionIds.includes(step.action)||bindings.length!==1||bindings[0]!.ref.version!==operation.version||bindings[0]!.effect!==operation.effect||step.effect!==operation.effect
        ||!same(bindings[0]!.additionalEffects??[],'additionalEffects'in operation?operation.additionalEffects??[]:[])||!same(step.additionalEffects??[],'additionalEffects'in operation?operation.additionalEffects??[]:[])
        ||step.definitionDigest!==digest(definition)||!same(registeredSchema,z.toJSONSchema(program.schema(step.action))))deny('POLICY_CHANGED');
      if(step.binding){const {digest:pinDigest,...pinBody}=step.binding;
        if(digest(pinBody)!==pinDigest||step.bindingDigest!==pinDigest||step.binding.ownerDigest!==digest(check.claim.owner)||step.binding.requestId!==job.id||step.binding.requestRevision!==request.revision
          ||step.binding.actionId!==step.action||step.binding.actionVersion!==operation.version||step.binding.definitionDigest!==digest(definition)||step.binding.compositionDigest!==digest(definition.composition)
          ||!same(step.binding.ontologyRelease,job.delegation!.ontologyRelease))deny('POLICY_CHANGED');}
      program.schema(step.action).parse(input);
      // Fixed internal integrity programs can inspect the sealed executable
      // projection. This privileged graph never reaches a model or a program
      // semantic port, and its read-only mode rejects all mutations.
      const integrity=await PostgresProjectionGraph.create(client,check.claim.owner,job.delegation!.ontologyRelease!,options.builder,{readOnly:true});
      await integrity.run(metadata=>assertAgentPlanProjectionProgram(metadata,check.claim.owner,plan));
      if(check.operation!=='create'&&(await integrity.read(check.claim.owner,executionStepRef(plan,step.id))).properties.state!==check.intent.state)deny('POLICY_CHANGED','Ontology invocation state differs from its original durable intent');
      const execution=await integrity.run(metadata=>readExecutionContextProgram(metadata,check.claim.owner,job.id,request.revision));
      if(!execution?.plans.some(value=>value.planId===plan.id&&value.planDigest===plan.digest)||fresh&&execution.pendingPlanId!==plan.id)deny('POLICY_CHANGED');
      const refs=new Map<string,{type:string;id:string}>();let nodes=0;
      const inspect=(value:unknown)=>{if(++nodes>5000)deny('INSUFFICIENT_ACCESS');if(!value||typeof value!=='object')return;const parsed=objectRefSchema.safeParse(value);if(parsed.success)refs.set(refKey(parsed.data),parsed.data);else for(const item of Object.values(value))inspect(item);};inspect(input);
      const inputEvidence:SecurityEnvelope[]=[];
      for(const ref of refs.values()){const type=ontology.model.object(ref.type);inputEvidence.push((await auth.readObject(ref,[...new Set([type.primaryKey,type.titleKey])])).envelope);}
      const history=await postgresTaskReadHistory(client,check.claim.owner,job.id,request.revision);
      if(history.length)await auth.authorizeEvidence(combineEnvelopes(history));
      for(const receipt of plan.ontologyPlanning.reads){
        if(!job.delegation!.ontologyReads?.some(current=>current.id===receipt.id&&same(current,receipt)))deny('POLICY_CHANGED');
        if(receipt.securityEnvelope)await auth.authorizeEvidence(receipt.securityEnvelope);
      }
      if(fresh&&plan.ontologyPlanning.accessDigest!==postgresPlanningAccessDigest(admission))deny('POLICY_CHANGED');
      return withPostgresPlanningReadGraph(client,principal,job.id,options.policyDigest,auth,admission,graph=>withPostgresTaskDefinitionAccess(client,principal,job.id,options.policyDigest,async(access,selected)=>{
        const meta:PlanningMetadata={model:graph.model,now:graph.now,releaseRef:graph.releaseRef,security:true,authorization:{accessDigest:()=>postgresPlanningAccessDigest(admission),
          definitions:()=>authorizedDefinitionCatalogue(access,selected),describe:value=>describeDefinitionCatalogue(access,value,selected),binding:ref=>refs.has(refKey(ref)),
          requireResource:(kind,id)=>{if(!access.resourceAllowed(kind,id))deny();},receipt:()=>({accessDigest:postgresPlanningAccessDigest(admission),securityEnvelope:graph.evidence()})}};
        if(fresh)await runGraphProgramAsync(graph,validatePlanningSnapshotProgram(meta,check.claim.owner,request,plan.ontologyPlanning,true));
        if(!registration.validate)deny('AUTHORITY_UNAVAILABLE','PostgreSQL program validate/privateInput/authority/Pipeline semantic proof is not installed');
        const context:PostgresActionSemanticContext={model:graph.model,graph:{model:graph.model,now:graph.now,releaseRef:graph.releaseRef,security:true},owner:check.claim.owner,intents:structuredClone(currentIntents),validUntil,
          job:structuredClone(job),plan:structuredClone(plan),step:structuredClone(step),intent:structuredClone(check.intent),input:structuredClone(input),operation:check.operation,...(check.attempt?{attempt:structuredClone(check.attempt)}:{})};
        if(plan.initialSelection)await runGraphProgramAsync(graph,registration.verifyInitialSelection!(context));
        const semantic=await runGraphProgramAsync(graph,registration.validate(context));deadline(semantic.validUntil);
        if(semantic.privateDigest!==check.intent.privateDigest)deny('POLICY_CHANGED');
        if((step.inputRefs.length||step.acceptedInputs?.length)&&semantic.materializedInputDigest!==digest(input))deny('AUTHORITY_UNAVAILABLE','PostgreSQL current accepted-input derivation semantic proof is not installed');
        if(fresh&&['read','local'].includes(step.effect)){
          if(semantic.authority||!same(semantic.simulatedApproval??null,step.simulatedApproval??null))deny('POLICY_CHANGED');
          if(step.simulatedApproval){const quote=plan.quote;
            deadline(Date.parse(step.simulatedApproval.expiresAt));
            if(!quote||step.effect!=='local'||plan.steps.length!==1||!hasSimulationApproval(job,plan)||!same(quote.amount,step.simulatedApproval.amount)||quote.expiresAt!==step.simulatedApproval.expiresAt
              ||quote.requestDigest!==digest(request)||quote.inputDigest!==stepInputDigest(step)||!same(quote.bindingRef,stepBindingRef(plan,step))||quote.bindingDigest!==(step.binding?.digest??program.configurationDigest)
              ||quote.detailsDigest!==digest({privateDigest:step.privateDigest,terms:step.simulatedApproval}))deny('POLICY_CHANGED');
            const {digest:expected,...body}=quote;if(digest(body)!==expected)deny('POLICY_CHANGED');
          }
        }
        if(fresh&&!['read','local'].includes(step.effect)){
          if(!semantic.authority||!same(semantic.authority.operationScope,step.operationScope)||!same(semantic.authority.cost,step.cost)||!same(semantic.authority.budgetImpact??null,step.budgetImpact??null)
            ||!same(semantic.authority.objectWrite??null,step.objectWrite??null)||!same(semantic.authority.externalDraft??null,step.externalDraft??null)
            ||!same(('confirmation'in semantic.authority?semantic.authority.confirmation:undefined)??null,step.confirmation??null))deny('POLICY_CHANGED');
          const executing=check.operation!=='create';
          if(step.effect==='external_draft'){if(executing&&!options.allowExternalDrafts||request.executionEnvironment==='sandbox'||capability.environment!=='live'||step.additionalEffects?.length)deny();}
          else if(step.effect==='object_write'){if(!program.callerManagedActions||step.additionalEffects?.length||step.cost)deny();}
          else{const free=program.liveFreeReservation===true&&capability.environment==='live'&&request.executionEnvironment!=='sandbox'&&'environment'in operation&&operation.environment==='live_free'&&step.effect==='reserve'&&!step.additionalEffects?.length&&step.cost?.minor==='0';
            if(!free&&(executing&&!options.allowSandbox||request.executionEnvironment!=='sandbox'||capability.environment!=='sandbox'||!('environment'in operation)||operation.environment!=='sandbox'))deny();
            if((plan.environment??'sandbox')!==(free?'live_free':'sandbox'))deny();}
          if(executing){
          const rows=await client.query(`SELECT id,CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.plan_grants WHERE owner=$1 AND job_id=$2 LIMIT 257`,[check.claim.owner,job.id]);
          if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))deny();
          const grants=rows.rows.map(row=>{const grant=JSON.parse(row.body) as PlanGrant;if(grant.id!==row.id||grant.owner!==check.claim.owner||grant.jobId!==job.id)deny();return grant;});
          const permit=grants.find(grant=>(check.grant?grant.id===check.grant.id&&same(grant,check.grant):true)&&(!check.attempt?.authorizationId||grant.id===check.attempt.authorizationId)&&matchesAgentGrant(grant,plan,step));
          if(!permit||check.attempt?.authorizationId!==undefined&&check.attempt.authorizationId!==permit.id
            ||launch&&check.attempt?.authorizationId!==permit.id)deny('AUTHORIZATION_REQUIRED','Exact durable plan permit is required');deadline(Date.parse(permit.expiresAt));
          if(launch&&!['object_write','external_draft','refund'].includes(step.effect)){
            if(!step.cost)deny();moneySchema.parse({minor:step.cost.minor,currency:step.cost.currency});
            const held=await client.query(`SELECT grant_id,minor,currency,state,economic_key,role,CASE WHEN octet_length(additional_impacts)<=65536 THEN additional_impacts END AS additional_impacts
              FROM ${q}.budget_reservations WHERE owner=$1 AND intent_id=$2 LIMIT 2`,[check.claim.owner,check.intent.id]);
            const row=held.rows[0],role=step.budgetImpact?.role??'service_total',amount=step.budgetImpact?.amount??step.cost;
            const keyFor=(role:string,key:string)=>digest({owner:check.claim.owner,requestId:job.id,program:step.binding!.programRef,configuration:step.binding!.configurationDigest,role,key});
            if(state.composition&&!step.binding)deny('POLICY_CHANGED');
            const economicKey=state.composition?keyFor(role,step.budgetImpact?.key??check.intent.businessOperationKey):null;
            const additional=state.composition?(step.budgetImpact?.additional??[]).map(value=>({key:keyFor(value.role,value.key),...moneySchema.parse(value.amount),role:value.role})):[];
            if(held.rowCount!==1||!row||row.grant_id!==permit.id||row.minor!==amount.minor||row.currency!==amount.currency||row.state!=='held'||row.economic_key!==economicKey
              ||row.role!==(state.composition?role:null)||!same(JSON.parse(row.additional_impacts??'[]'),additional))deny('AUTHORIZATION_REQUIRED','Exact held original budget is required');
          }
          }
        }
        if(check.operation==='accept'){
          if(!check.result||!check.attempt)deny();
          if(check.result.kind==='unknown'){
            if(check.verified||check.result.eventId!==check.attempt.id||check.result.sourceVersion!==check.attempt.ordinal||check.result.output||check.result.remoteRef||check.result.business||check.result.delivery||check.result.evidenceRefs.length)deny('SOURCE_NOT_AUTHORIZED');
          }else{
            if(!check.verified||!proof||proof.attemptId!==check.attempt.id||!same(normalizedResponse(proof.response,check.attempt),check.result))deny('SOURCE_NOT_AUTHORIZED');
            if(!registration.verifyObservation)deny('AUTHORITY_UNAVAILABLE','PostgreSQL trusted provider-result semantic verifier is not installed');
            await runGraphProgramAsync(graph,registration.verifyObservation(context,check.attempt,structuredClone(proof.response),check.result));
          }
        }
        const influenced=graph.evidence();if(influenced)inputEvidence.push(influenced);
        if(inputEvidence.length){const evidence=await auth.authorizeEvidence(combineEnvelopes(inputEvidence));
          await client.query(`INSERT INTO ${q}.security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT(grant_id,digest) DO NOTHING`,[admission.grant.id,digest(evidence),JSON.stringify(evidence)]);}
        if(postgresBusinessToken(client)!==token)deny();deadline(validUntil);return {validUntil};
      },options.builder),options.builder);
    },options.builder,options.modelChannel,options.inspectClaim);
  };
}
