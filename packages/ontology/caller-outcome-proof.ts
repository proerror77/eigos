import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError, type Job } from '../core/domain.js';
import { objectRefSchema, type ObjectRef } from './model.js';
import { refSchema } from './execution.js';
import { ontologyReleaseRefSchema } from './definition-contracts.js';
import { templatePlanning } from './planning-contract.js';
import { assertAgentPlanProjection, executionPlanRef } from './execution-projection.js';
import { outcomeAssessmentRef } from './outcome-assessment-values.js';
import type { ObjectView, OntologyObjectStore, ReadBudget } from './object-store.js';

const text = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/);
const typed = <T extends string>(type:T) => objectRefSchema.extend({type:z.literal(type)});
const execution = z.strictObject({plan:typed('ExecutionPlan'),step:typed('ExecutionStep'),attempt:typed('ExecutionAttempt'),result:typed('ExecutionResult'),authorization:typed('Authorization')});
const proofBody = z.strictObject({
  version:z.literal('caller-managed-coverage-v1'),coverageKind:z.literal('caller_contract'),
  requestId:text,requestRevision:z.number().int().positive(),ownerDigest:sha,callerRequestId:text,
  ontologyRelease:ontologyReleaseRefSchema,programRef:refSchema,programDigest:sha,
  assessmentId:sha,outcomeDigest:sha,envelopeDigest:sha,completionDigest:sha,artifactDigest:sha,
  planId:text,planDigest:sha,stepId:text,intentId:text,action:z.string().min(1).max(80),definitionDigest:sha,
  inputDigest:sha,stepInputDigest:sha,objectWriteDigest:sha,authorizationContractDigest:sha,
  verifiedAt:z.iso.datetime({offset:true}).max(64),execution,
});
export const callerOutcomeProofSchema = proofBody.extend({digest:sha});
export type CallerOutcomeProof = z.infer<typeof callerOutcomeProofSchema>;
type Basis = Omit<z.infer<typeof proofBody>, 'execution' | 'authorizationContractDigest'>;
const same = (a:unknown,b:unknown) => a === undefined || b === undefined ? a === b : digest(a) === digest(b);
const fail = (message:string):never => {throw new DomainError('CONFLICT',message);};
const exactlyOne = (graph:OntologyObjectStore,owner:string,ref:ObjectRef,link:string,budget:ReadBudget) => {
  const rows=graph.related(owner,ref,link,budget);return rows?.length===1?rows[0]:undefined;
};
const currentRequest = (graph:OntologyObjectStore,owner:string,ref:ObjectRef,id:string,budget:ReadBudget) => exactlyOne(graph,owner,ref,'request',budget)?.ref.id===id;
const time = (value:unknown) => typeof value==='string'?Date.parse(value):NaN;

/** Reads historical verified dispatch evidence, not current permission. Revoked
 * or expired grants can still prove a dispatch made before their recorded end. */
function verifiedExecution(graph:OntologyObjectStore,owner:string,basis:Basis,budget:ReadBudget,pinned?:z.infer<typeof execution>, authorizationDigest?:string) {
  const planRef=executionPlanRef({id:basis.planId,requestId:basis.requestId,digest:basis.planDigest}),plan=graph.read(owner,planRef,budget);
  if(plan.properties.planId!==basis.planId || plan.properties.planDigest!==basis.planDigest || plan.properties.requestRevision!==basis.requestRevision
    || plan.properties.kind!=='agent' || plan.properties.modelRunId!==undefined || plan.properties.state!=='observed' || !currentRequest(graph,owner,plan.ref,basis.requestId,budget)) return;
  const context=exactlyOne(graph,owner,plan.ref,'context',budget);
  if(!context || !currentRequest(graph,owner,context.ref,basis.requestId,budget) || context.properties.requestRevision!==basis.requestRevision
    || !same(context.properties.programRef,basis.programRef) || context.properties.programDigest!==basis.programDigest) return;
  const steps=graph.related(owner,plan.ref,'steps',budget);
  if(steps?.length!==1)return;
  const step=steps[0]!,sp=step.properties;
  if(sp.stepId!==basis.stepId || sp.intentId!==basis.intentId || sp.planDigest!==basis.planDigest || sp.actionId!==basis.action
    || sp.definitionDigest!==basis.definitionDigest || sp.inputDigest!==basis.stepInputDigest || sp.effect!=='object_write' || sp.state!=='effect_confirmed'
    || !currentRequest(graph,owner,step.ref,basis.requestId,budget))return;
  const action=exactlyOne(graph,owner,step.ref,'actionType',budget),definition=graph.model.action(basis.action);
  if(definition.implementation?.kind!=='declarative' || !same(definition.effects,['object_write']) || digest(definition)!==basis.definitionDigest
    || action?.properties.definitionDigest!==basis.definitionDigest || action.properties.actionId!==basis.action || action.properties.effect!=='object_write')return;
  const results=(graph.related(owner,step.ref,'results',budget)??[]).filter(result=>result.properties.kind==='confirmed' && result.properties.applied===true
    && result.properties.verification==='verified' && result.properties.output && same(result.properties.output,sp.acceptedOutput)
    && time(result.properties.receivedAt)<=time(basis.verifiedAt));
  for(const result of results.sort((a,b)=>String(b.properties.receivedAt).localeCompare(String(a.properties.receivedAt)) || a.ref.id.localeCompare(b.ref.id))) {
    const attempt=exactlyOne(graph,owner,result.ref,'attempt',budget);
    if(!attempt || !same(exactlyOne(graph,owner,result.ref,'step',budget)?.ref,step.ref) || !same(exactlyOne(graph,owner,attempt.ref,'step',budget)?.ref,step.ref)
      || attempt.properties.intentId!==basis.intentId || attempt.properties.planDigest!==basis.planDigest || attempt.properties.requestRevision!==basis.requestRevision
      || attempt.properties.inputDigest!==basis.inputDigest || attempt.properties.kind!=='dispatch' || attempt.properties.state!=='observed'
      || !Number.isFinite(time(attempt.properties.startedAt)) || time(result.properties.receivedAt)<time(attempt.properties.startedAt))continue;
    const authorization=exactlyOne(graph,owner,attempt.ref,'authorization',budget);
    if(!authorization || authorization.properties.kind!=='plan_grant' || authorization.properties.environment!=='managed'
      || authorization.properties.planDigest!==basis.planDigest || !same(authorization.properties.allowedEffects,['object_write'])
      || !Array.isArray(authorization.properties.allowedActions) || !authorization.properties.allowedActions.includes(basis.action)
      || digest(authorization.properties.objectWriteScope)!==basis.objectWriteDigest
      || !currentRequest(graph,owner,authorization.ref,basis.requestId,budget)
      || !same(exactlyOne(graph,owner,authorization.ref,'executionPlan',budget)?.ref,plan.ref)
      || exactlyOne(graph,owner,authorization.ref,'approver',budget)?.properties.ownerDigest!==basis.ownerDigest
      || !(time(authorization.properties.approvedAt)<=time(attempt.properties.startedAt) && time(attempt.properties.startedAt)<time(authorization.properties.expiresAt))
      || authorization.properties.revoked===true && !(time(authorization.properties.revokedAt)>time(attempt.properties.startedAt)))continue;
    const {revoked:_revoked,revokedAt:_revokedAt,effectiveStatus:_status,ledgerDigest:_mutableLedger,...contract}=authorization.properties;
    const authorizationContractDigest=digest({ref:authorization.ref,properties:contract});
    if(authorizationDigest && authorizationDigest!==authorizationContractDigest)continue;
    const refs={plan:plan.ref,step:step.ref,attempt:attempt.ref,result:result.ref,authorization:authorization.ref};
    if(!pinned || same(refs,pinned))return {refs,authorizationContractDigest};
  }
  return;
}

/** Only the trusted completed caller ledger can create this proof. No model
 * response, criterion label or user claim can stand in for the typed contract. */
export function createCallerOutcomeProof(graph:OntologyObjectStore,owner:string,job:Job):CallerOutcomeProof|undefined {
  const d=job.delegation,state=d?.agent,caller=d?.callerAction,completion=state?.callerCompletion;
  if(!caller && !completion || job.state!=='completed' || !d?.acceptance?.accepted || d.outcome?.status!=='satisfied')return;
  if(!caller || !completion || !state || d.goalCoverage || state.completion || !job.artifact || caller.ownerDigest!==digest(owner)
    || d.request.id!==job.id || d.outcome.requestId!==job.id || d.outcome.requestRevision!==d.request.revision || state.requestRevision!==d.request.revision
    || !same(caller.ontologyRelease,graph.releaseRef) || !same(caller.ontologyRelease,d.ontologyRelease) || !same(caller.programRef,state.programRef)
    || caller.inputDigest!==digest(caller.input) || !d.request.messages.some(message=>message.id===caller.requestId)
    || completion.requestId!==caller.requestId || !same(completion.ontologyPlanning,templatePlanning(d.request,graph.model.ref,completion.ontologyPlanning.accessDigest)))return fail('Caller outcome has no exact authenticated contract and independent readback');
  const plans=state.plans.filter(plan=>plan.digest===completion.planDigest);
  if(plans.length!==1)return fail('Caller completion has no unique sealed plan');
  const plan=plans[0]!,{digest:planDigest,...planBody}=plan,selected=plan.callerDecision,step=plan.steps[0];
  if(planDigest!==digest(planBody) || !selected || selected.requestId!==caller.requestId || selected.envelopeDigest!==digest(caller)
    || plan.modelRunId!==undefined || plan.modelDecision!==undefined || plan.requestId!==job.id || plan.requestRevision!==d.request.revision
    || !same(plan.programRef,caller.programRef) || plan.programDigest!==state.programDigest || !same(plan.ontologyPlanning,completion.ontologyPlanning)
    || plan.steps.length!==1 || !step || step.action!==caller.action || step.effect!=='object_write' || step.additionalEffects?.length
    || step.inputRefs.length || step.dependsOn.length || step.acceptedInputs?.length || step.cost || step.externalDraft || !step.objectWrite
    || digest(step.input)!==caller.inputDigest || !same(completion.intentIds,[step.intentId]) || !same(d.acceptance.evidenceRefs,[step.intentId])
    || selected.decision.kind!=='execute' || selected.decision.steps.length!==1 || selected.decision.steps[0]!.action!==caller.action
    || digest(JSON.parse(selected.decision.steps[0]!.argumentsJson))!==caller.inputDigest)return fail('Caller outcome differs from its original sealed managed plan');
  assertAgentPlanProjection(graph,owner,plan);
  const basis:Basis={version:'caller-managed-coverage-v1',coverageKind:'caller_contract',requestId:job.id,requestRevision:d.request.revision,ownerDigest:digest(owner),callerRequestId:caller.requestId,
    ontologyRelease:caller.ontologyRelease,programRef:state.programRef,programDigest:state.programDigest,assessmentId:outcomeAssessmentRef(job,d.outcome).id,
    outcomeDigest:digest(d.outcome),envelopeDigest:digest(caller),completionDigest:digest(completion),artifactDigest:digest(job.artifact),
    planId:plan.id,planDigest:plan.digest,stepId:step.id,intentId:step.intentId,action:step.action,definitionDigest:step.definitionDigest,inputDigest:caller.inputDigest,
    stepInputDigest:digest({input:step.input,inputRefs:step.inputRefs}),objectWriteDigest:digest(step.objectWrite),verifiedAt:d.outcome.assessedAt};
  const refs=verifiedExecution(graph,owner,basis,{remaining:1000});
  if(!refs)return fail('Caller outcome lacks its verified applied execution and original authorization');
  const body=proofBody.parse({...basis,execution:refs.refs,authorizationContractDigest:refs.authorizationContractDigest});return {...body,digest:digest(body)};
}

export function validateCallerOutcomeProof(graph:OntologyObjectStore,owner:string,request:ObjectView,assessment:ObjectView,budget:ReadBudget):ObjectRef[]|undefined {
  try {
    const proof=callerOutcomeProofSchema.parse(assessment.properties.callerProof),{digest:expected,...body}=proof;
    if(expected!==digest(body) || proof.ownerDigest!==digest(owner) || proof.requestId!==request.ref.id || proof.requestRevision!==request.properties.revision
      || proof.assessmentId!==assessment.ref.id || proof.outcomeDigest!==assessment.properties.basisDigest || proof.verifiedAt!==assessment.properties.assessedAt
      || !same(proof.ontologyRelease,graph.releaseRef) || assessment.properties.judgment!=='satisfied' || assessment.properties.taskState!=='completed')return;
    const plan=exactlyOne(graph,owner,assessment.ref,'callerPlan',budget);
    if(!plan || !same(plan.ref,proof.execution.plan))return;
    const artifact=exactlyOne(graph,owner,assessment.ref,'acceptedArtifact',budget);
    if(!artifact || artifact.properties.contentDigest!==proof.artifactDigest || !currentRequest(graph,owner,artifact.ref,proof.requestId,budget))return;
    const verified=verifiedExecution(graph,owner,proof,budget,proof.execution,proof.authorizationContractDigest);return verified?Object.values(verified.refs):undefined;
  }catch{return;}
}
