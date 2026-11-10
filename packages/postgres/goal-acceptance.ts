import {randomUUID} from 'node:crypto';
import {assertDidiShortPathComponent,assertDidiShortPathDecision,didiShortPathGoal,isDidiShortPathDecision,recordDidiReadTiming} from './didi-short-path.js';
import type {Client} from 'pg';
import {digest} from '../core/delegation.js';
import {DomainError} from '../core/domain.js';
import {assertGoalCoverage,assertReadContractResult} from '../ontology/goal-coverage.js';
import {resolveTaskRecovery} from '../core/task-recovery.js';
import {assessGoalProgram} from '../coordinator/goal-assessment-program.js';
import {validatePlanningSnapshotProgram,type PlanningMetadata} from '../coordinator/planning-program.js';
import {runGraphProgramAsync} from '../ontology/graph-program.js';
import {readOntologyRequestProgram} from '../ontology/execution-projection.js';
import type {AgentDecision} from '../ontology/agent-actions.js';
import type {PlanningSnapshot} from '../ontology/planning-contract.js';
import {objectRefSchema} from '../ontology/model.js';
import {goalCompletionSchema} from '../ontology/goal-completion-contract.js';
import {authorizedDefinitionCatalogue,describeDefinitionCatalogue} from '../security/definition-view.js';
import {SecurityError} from '../security/errors.js';
import {submissionDigest} from '../security/submission-digest.js';
import {postgresBusinessSchema,postgresBusinessAuthorityDigest,postgresRequireLeaseAtCommit,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {postgresClaimSnapshotMatches,postgresWorkReference,type PostgresWorkReference} from './work-claim.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {PostgresTaskStorage} from './task-storage.js';
import {postgresPrepareWorkerSeal,postgresRecordWorkerOutputs} from './worker-output.js';
import {postgresRecordClaimRelease} from './claim-release.js';
import {withPostgresWorkerEvidenceAuthorization} from './task-output.js';
import {withPostgresPlanningReadGraph,postgresPlanningAccessDigest} from './planning-read-graph.js';
import {withPostgresTaskDefinitionAccess} from './ontology-metadata.js';
import {assertPostgresPlanningDecisionEvidence,postgresGoalProgram} from './goal-contexts.js';
import {resolvePostgresDocumentBinding,postgresReadRegistry,type PostgresDocumentBindingOptions} from './document-bindings.js';

function fail(message:string):never{throw new DomainError('CONFLICT',message);}
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);

/** Current, original-task whole-goal acceptance. No model/provider runs here.
 * Registered component semantics and the normal protected planning reader own
 * every value read. Unported producer/citation semantics fail closed. */
export async function acceptPostgresGoal(client:Client,input:PostgresWorkReference,supplied:AgentDecision,modelRunId:string,suppliedReads:PlanningSnapshot,options:PostgresDocumentBindingOptions):Promise<{accepted:boolean}>{
  const claim=postgresWorkReference(input),decision=structuredClone(supplied),reads=structuredClone(suppliedReads),q=`"${postgresBusinessSchema(client)}"`;
  if(claim.recovery||decision.kind!=='complete'||decision.steps.length||!decision.completionJson||decision.contexts?.length||decision.plannedCompletion||decision.plannedGoalCompletion)fail('Goal acceptance requires only the original model completion selection');
  const name=`goal_accept_${randomUUID().replaceAll('-','')}`;await client.query(`SAVEPOINT ${name}`);
  try{
    if(!await options.inspectClaim(claim)||!await postgresClaimSnapshotMatches(client,claim,options.policyDigest))throw new SecurityError('ACCESS_REVOKED');
    const store=new PostgresTaskStorage(client,options.builder),job=await store.get(claim.owner,claim.job.id),program=postgresGoalProgram(job),d=job.delegation!,state=d.agent!;
    if(job.state!=='working'||state.pendingPlanId||decision.requestRevision!==d.request.revision)fail('The original goal still has an execution frontier or a stale completion');
    const didi=isDidiShortPathDecision(modelRunId);
    if(didi)assertDidiShortPathDecision(job,decision,modelRunId,reads);
    else assertPostgresPlanningDecisionEvidence(job,decision,modelRunId,reads);
    const coverage=didi?undefined:assertGoalCoverage(job,program.capability());
    const proposal=goalCompletionSchema.parse(JSON.parse(decision.completionJson)),selected=new Set(proposal.components.map(value=>value.contextId));
    const resolved=new Map<string,Awaited<ReturnType<typeof resolvePostgresDocumentBinding>>>();
    for(const component of state.composition!.contexts.filter(value=>selected.has(value.id))){
      if(state.composition!.retiredContexts?.some(value=>value.id===component.id))continue;
      resolved.set(component.id,await resolvePostgresDocumentBinding(client,claim,d.request,component.initializedBy.binding,options));
    }
    if(didi){
      const registration=[...resolved.values()][0];
      if(resolved.size!==1||registration?.registration.kind!=='didi'||!same(didiShortPathGoal(job,registration.program.capability()),state.composition!.goal))fail('DiDi short path completion differs from its fixed quote goal');
    }
    const intents=await store.intents(claim.owner,job.id);
    const evaluated=await withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,(auth,admission,principal)=>
      withPostgresPlanningReadGraph(client,principal,job.id,options.policyDigest,auth,admission,graph=>withPostgresTaskDefinitionAccess(client,principal,job.id,options.policyDigest,async(access,model)=>{
        const metadata:PlanningMetadata={model:graph.model,now:graph.now,releaseRef:graph.releaseRef,security:true,authorization:{accessDigest:()=>postgresPlanningAccessDigest(admission),
          definitions:()=>authorizedDefinitionCatalogue(access,model),describe:value=>describeDefinitionCatalogue(access,value,model),
          binding:ref=>(reads.deliveredObjects??reads.objects).some(value=>same(value.ref,ref)),requireResource:(kind,id)=>{if(!access.resourceAllowed(kind,id))throw new SecurityError('AUTHORIZATION_REQUIRED');},receipt:()=>({accessDigest:postgresPlanningAccessDigest(admission),securityEnvelope:graph.evidence()})}};
        const request=await runGraphProgramAsync(graph,readOntologyRequestProgram(metadata,claim.owner,job.id));
        if(submissionDigest(request)!==submissionDigest(d.request))throw new SecurityError('POLICY_CHANGED');
        await runGraphProgramAsync(graph,validatePlanningSnapshotProgram(metadata,claim.owner,request,reads,true));
        const context={graph:metadata,owner:claim.owner,request,state:structuredClone(state),intents:structuredClone(intents),modelRuns:structuredClone(job.runs??[])};
        const result=await runGraphProgramAsync(graph,assessGoalProgram(context,proposal,reads,{
          resolveProgram:function*(_ctx,component){
            const current=resolved.get(component.id);if(!current||!same(current.binding.pin,component.initializedBy.binding))fail('This component has no current registered PostgreSQL verifier');
            return {ref:current.program.ref,configurationDigest:current.program.configurationDigest,capability:()=>current.program.capability(),
              assertContextProgram:ctx=>current.registration.assertContext(ctx),completeProgram:(ctx,value,snapshot)=>current.registration.complete(ctx,value,snapshot)};
          },
          ...(didi?{verifyHostSetup:(component:Parameters<typeof assertDidiShortPathComponent>[1])=>assertDidiShortPathComponent(job,component)}:{}),
          assertAcceptedOutputCurrentProgram:function*(){fail('PostgreSQL consumed-producer and citation completion semantics are not installed');},
        }));
        const influence=await graph.authorize();
        if(influence)await client.query(`INSERT INTO ${q}.security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT(grant_id,digest) DO NOTHING`,[admission.grant.id,digest(influence),JSON.stringify(influence)]);
        postgresConstrainReadDeadline(client,admission.validUntil);return result;
      },options.builder),options.builder),options.builder,options.modelChannel,options.inspectClaim);
    const registry=postgresReadRegistry(options);for(const resolvedProgram of resolved.values())await registry.assertConfigured(client,resolvedProgram.registration,claim,job);
    const seal=await postgresPrepareWorkerSeal(client,claim,options.policyDigest,options.builder,options.inspectClaim);
    if(!seal)throw new SecurityError('OUTPUT_NOT_ALLOWED');
    state.composition!.assessment=evaluated.assessment;job.artifact=evaluated.delivery.artifact;job.updatedAt=new Date().toISOString();d.nextAt=0;
    if(evaluated.assessment.accepted){
      if(didi){
        const step=state.plans[1]?.steps[0],intent=intents.find(value=>value.id===step?.intentId&&value.state==='effect_confirmed');
        const object=objectRefSchema.safeParse(intent?.acceptedOutput?.object),component=evaluated.assessment.components[0]?.delivery?.artifact;
        const answer=component?.data.result as {didiAnswer?:{observation:unknown;requestedItems?:unknown[]}}|undefined;
        if(!object.success||object.data.type!=='RideEstimateObservation'||!component||!answer?.didiAnswer
          ||!same(answer.didiAnswer.observation,object.data)||!answer.didiAnswer.requestedItems?.length)fail('The original DiDi estimate did not return a verifiable quote');
        job.artifact.data.result={...job.artifact.data.result,securityEvidenceRefs:[object.data]};
        job.artifact.data.deliverable=component.data.deliverable;
      }
      if(coverage)assertReadContractResult(coverage,evaluated.delivery);job.state='completed';d.phase='accepted';resolveTaskRecovery(job,'decision');
      if(!didi)state.completion={modelRunId,modelDecision:decision,proposal,ontologyPlanning:reads};
      d.conditionChecks=evaluated.assessment.conditions;
      d.acceptance={accepted:true,reason:'The selected result passed every current component, fixed goal, hard requirement and result-condition verifier',at:job.updatedAt,checks:evaluated.assessment.requirements,evidenceRefs:evaluated.delivery.evidenceRefs};
      d.outcome={requestId:job.id,requestRevision:d.request.revision,status:'satisfied',assessedAt:job.updatedAt,reason:d.acceptance.reason,evidenceRefs:evaluated.delivery.evidenceRefs,evidenceLevel:evaluated.delivery.evidenceLevel??'unverified',
        criterionResults:[...evaluated.assessment.requirements.map(check=>({requirementId:check.requirementId,status:check.result==='pass'?'satisfied' as const:check.result==='fail'?'unsatisfied' as const:'unknown' as const,evidenceRefs:check.evidenceRefs})),
          ...evaluated.assessment.conditions.map(check=>({requirementId:check.conditionId,status:check.result==='pass'?'satisfied' as const:check.result==='fail'?'unsatisfied' as const:'unknown' as const,evidenceRefs:check.evidenceRefs.map(ref=>JSON.stringify(ref))})),
          {requirementId:'goal_coverage',status:'satisfied',evidenceRefs:[coverage?.digest??state.composition!.goal.digest]},{requirementId:'independent_verifier',status:'satisfied',evidenceRefs:evaluated.delivery.evidenceRefs}]};
      d.events.push({at:job.updatedAt,event:'agent_completion_verified',evidence:modelRunId});job.messages.push({id:randomUUID(),role:'agent',text:job.artifact.data.deliverable,at:job.updatedAt});
    }else{
      d.phase='planning';state.feedback.push({at:job.updatedAt,kind:'completion',message:'The fixed whole goal remains incomplete; preserve verified components and read the missing criteria',inputDigest:digest(proposal)});
      d.events.push({at:job.updatedAt,event:'agent_completion_feedback',evidence:digest(proposal)});
    }
    if(didi)recordDidiReadTiming(job,'complete',options.didiReadTiming);
    await store.save(claim.owner,job);await postgresRecordWorkerOutputs(client,claim.owner,job,seal);
    const header=await client.query(`SELECT 1 FROM ${q}.work_claims c JOIN ${q}.runtime_work_claims r ON r.job_id=c.job_id AND r.token=c.token WHERE c.job_id=$1 AND c.token=$2 AND c.revision=$3 AND r.authority_digest=$4`,[job.id,claim.token,claim.job.revision??0,postgresBusinessAuthorityDigest(client)]);
    const current=await postgresWorkerAdmission(client,claim.owner,job.id,options.policyDigest);
    if(header.rowCount!==1||current.authority.id!==claim.securityAuthorityId||current.authority.authEpoch!==claim.securityEpoch||current.policyRevision!==claim.securityPolicyRevision||!await options.inspectClaim(claim))throw new SecurityError('ACCESS_REVOKED');
    postgresRequireLeaseAtCommit(client,digest(claim),()=>options.inspectClaim(claim));
    if(evaluated.assessment.accepted){await postgresRecordClaimRelease(client,claim.owner,job.id,claim.token);await client.query(`DELETE FROM ${q}.runtime_work_claims WHERE job_id=$1 AND token=$2`,[job.id,claim.token]);}
    await client.query(`RELEASE SAVEPOINT ${name}`);return {accepted:evaluated.assessment.accepted};
  }catch(error){await client.query(`ROLLBACK TO SAVEPOINT ${name}`);await client.query(`RELEASE SAVEPOINT ${name}`);throw error;}
}
