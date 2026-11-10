import {digest} from '../core/delegation.js';
import {DomainError,type Job} from '../core/domain.js';
import {didiEstimateDecisionSchema,didiEstimateRequestSchema,structuredDidiGoal} from '../core/didi-estimate-request.js';
import {createGoalContract} from '../core/goal-contract.js';
import {DIDI_PROGRAM_REF} from '../capabilities/didi/program.js';
import {agentDecisionSchema,type AgentActionPlan,type AgentComponentContext,type AgentDecision} from '../ontology/agent-actions.js';
import type {ServiceCapability} from '../ontology/execution.js';
import type {PlanningSnapshot} from '../ontology/planning-contract.js';

export const didiEstimateComponent='didi-estimate';
export const didiEstimateCriterion='didi-quote';
const prefix='didi-estimate:';
const same=(a:unknown,b:unknown)=>a===undefined||b===undefined?a===b:digest(a)===digest(b);
function fail():never{throw new DomainError('CONFLICT','DiDi estimate workflow differs from its original read-only request and evidence');}

export function didiShortPathRequest(job:Job){
  const d=job.delegation,workflow=d?.didiEstimate;
  if(!d||!workflow||!d.ontologyRelease||d.ontologyRelease.ontologyId!=='eigos.business'||workflow.revision!==d.request.revision
    ||d.request.originalGoal!==job.goal||!d.request.capabilityRef||!same(d.request.capabilityRef,DIDI_PROGRAM_REF)
    ||d.request.requestedDeliverable||d.request.requirements.length||d.request.successCriteria?.length||d.request.conditions?.length
    ||d.request.personalContext||d.callerAction||d.pipelineValidation)fail();
  return didiEstimateRequestSchema.parse(workflow.request);
}

export function didiShortPathInput(job:Job){
  const request=didiShortPathRequest(job),d=job.delegation!,workflow=d.didiEstimate!;
  if(request.mode==='structured'){
    if(workflow.modelStarted||workflow.interpretation||job.runs?.length||structuredDidiGoal(request)!==job.goal||d.request.messages.length!==1)fail();
    const {mode:_mode,...route}=request;
    return {mode:'estimate' as const,...route};
  }
  const selected=workflow.interpretation,run=job.runs?.[0];
  if(!workflow.modelStarted||!selected||job.runs?.length!==1||!run||run.id!==selected.runId
    ||run.purpose!=='grounding'||run.decisionDigest!==digest(selected.decision)||run.singleReadDecision?.version!=='1'
    ||run.singleReadDecision.modelRequests!==1||run.singleReadDecision.toolsAvailable!==false||run.nativeMcpCalls?.length)fail();
  const decision=didiEstimateDecisionSchema.parse(selected.decision);
  if(decision.kind!=='estimate')fail();
  return {mode:'estimate' as const,...decision.route};
}

export function didiShortPathGoal(job:Job,capability:ServiceCapability){
  didiShortPathInput(job);
  const d=job.delegation!;
  return createGoalContract(d.request,d.ontologyRelease!,d.request.messages.map((message,index)=>({
    id:index===0?didiEstimateCriterion:`${didiEstimateCriterion}-${index}`,predicate:'ride.estimate_observed',phase:'quote',
    description:'Current source-backed DiDi estimate',messageId:message.id,quote:message.text,requirementIds:[],
  })),[capability]);
}

export function didiShortPathDecisionId(job:Job){
  const route=didiShortPathInput(job),d=job.delegation!;
  return prefix+digest([d.request,d.ontologyRelease,route,d.didiEstimate!.interpretation??null]);
}
export function isDidiShortPathDecision(id:string){return id.startsWith(prefix);}

/** Host decisions are bounded to the pinned estimate workflow. They never
 * supply model evidence. Normal role, source, lease and read proof checks run
 * through the same PostgreSQL component, journal and acceptance gates. */
export function assertDidiShortPathDecision(job:Job,supplied:AgentDecision,id:string,reads:PlanningSnapshot){
  if(id!==didiShortPathDecisionId(job))fail();
  const route=didiShortPathInput(job),d=job.delegation!,state=d.agent,composition=state?.composition,decision=agentDecisionSchema.parse(supplied);
  if(!composition||decision.requestRevision!==d.request.revision||reads.requestRevision!==d.request.revision||reads.mode!=='worker_context'||!reads.reads.length
    ||new Set(reads.reads.map(receipt=>receipt.id)).size!==reads.reads.length||reads.reads.some(receipt=>receipt.status!=='ok'||receipt.origin!=='worker_context'
      ||!d.ontologyReads?.some(current=>current.id===receipt.id&&same(current,receipt))))fail();
  if(decision.kind==='prepare'){
    const selected=decision.contexts?.[0];
    if(decision.contexts?.length!==1||!selected||selected.id!==didiEstimateComponent||!same(JSON.parse(selected.inputJson),route))fail();
    return;
  }
  const component=composition.contexts.find(value=>value.id===didiEstimateComponent);
  if(!component||!same(component.programRef,DIDI_PROGRAM_REF)||!same(component.input,route))fail();
  if(decision.kind==='execute'){
    if(decision.steps.length<1||decision.steps.length>2||decision.steps.some(step=>{
      if(step.contextId!==component.id||step.inputRefs.length||step.dependsOn.length||step.acceptedInputs?.length
        ||!same(step.contributesTo,composition.goal.criteria.map(item=>item.id)))return true;
      const input=JSON.parse(step.argumentsJson);
      if(!same(input.scope,component.scope))return true;
      return step.action==='SearchDidiPlaces'
        ? !['origin','destination'].includes(step.id)||input.role!==step.id||input.keywords!==route[step.id as 'origin'|'destination']
        : step.action!=='EstimateDidiRide'||step.id!=='estimate'||decision.steps.length!==1;
    })||new Set(decision.steps.map(step=>step.id)).size!==decision.steps.length)fail();
    return;
  }
  if(decision.kind!=='complete'||!decision.completionJson)fail();
}

export function assertDidiShortPathComponent(job:Job,component:AgentComponentContext){
  const setup=component.initializedBy;
  if(component.id!==didiEstimateComponent||!same(component.programRef,DIDI_PROGRAM_REF)||!same(component.input,didiShortPathInput(job))
    ||!same(setup.binding.programRef,DIDI_PROGRAM_REF)||setup.binding.actionId!=='SearchDidiPlaces'
    ||setup.decision.kind!=='prepare'||setup.decision.contexts?.[0]?.bindingDigest!==setup.binding.digest)fail();
  assertDidiShortPathDecision(job,setup.decision,setup.modelRunId,setup.ontologyPlanning);
}

/** The original wire schema calls this modelRunId. A host decision uses an
 * explicitly namespaced digest, with no matching model run or usage entry. */
export function didiSourceDecisionId(plan:AgentActionPlan){return plan.didiDecision?.id??plan.modelRunId;}

/** Timing is bookkeeping only. It cannot supply a receipt or permission. */
export function recordDidiReadTiming(job:Job,phase:'prepare'|'execute'|'complete',timing:{durationMs:number;receipts:number}|undefined){
  if(timing)job.delegation!.events.push({at:new Date().toISOString(),event:'didi_ontology_read_timing',evidence:JSON.stringify({phase,...timing})});
}
