import {digest} from '../core/delegation.js';
import {DomainError} from '../core/domain.js';
import {componentContext,componentScopeDigestProgram} from '../core/composed-actions.js';
import {DocumentAgentProgram} from '../capabilities/document-agent.js';
import {validateDocumentProgram,verifyDocumentResultProgram,documentCitationsProgram,type DocumentProgramContext,type DocumentActionProgramContext} from '../capabilities/document-program.js';
import {documentActionSchema} from '../ontology/document-action.js';
import {readOntologyRequestProgram} from '../ontology/execution-projection.js';
import type {GraphProgram} from '../ontology/graph-program.js';
import type {PostgresActionProgramPolicy,PostgresActionSemanticContext} from './action-authorization.js';

const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
const fail=(message:string):never=>{throw new DomainError('CONFLICT',message);};

function deadline(context:PostgresActionSemanticContext,until=context.validUntil){
  const fixed=Math.min(context.validUntil,until);
  if(!Number.isSafeInteger(fixed)||fixed<=context.graph.now())fail('The original document admission or source evidence expired');
  return fixed;
}

/** The shared domain program receives only graph metadata and original durable
 * task values. Every read is yielded to the caller's checked PostgreSQL driver;
 * no synchronous object store or privileged raw request is substituted. */
export function* postgresDocumentContextProgram(context:PostgresActionSemanticContext,program:Pick<DocumentAgentProgram,'ref'|'configurationDigest'>):GraphProgram<DocumentProgramContext>{
  const {job,plan,step,intent}=context,d=job.delegation??fail('Document task has no delegation'),state=d.agent??fail('Document task has no Agent state');
  deadline(context);
  if(!d.ontologyRelease||!context.graph.releaseRef||intent.owner!==context.owner||intent.jobId!==job.id||d.request.id!==job.id
    ||state.requestRevision!==d.request.revision||plan.requestId!==job.id||plan.requestRevision!==d.request.revision
    ||!same(context.model.ref,context.graph.model.ref)||!same(d.ontologyRelease,context.graph.releaseRef)
    ||!state.plans.some(value=>value.id===plan.id&&same(value,plan))
    ||!plan.steps.some(value=>value.id===step.id&&value.intentId===intent.id&&same(value,step)))fail('Document policy differs from the original task, plan or invocation');
  if(step.action!=='ComposeDocument'||step.effect!=='local'||step.additionalEffects?.length||plan.initialSelection||plan.callerDecision
    ||!plan.modelRunId||!plan.modelDecision)fail('Document execution requires its original local Agent decision');
  const request=yield* readOntologyRequestProgram(context.graph,context.owner,job.id);
  if(request.id!==job.id||request.revision!==d.request.revision)fail('Document request differs from the current typed Ontology revision');
  const root:DocumentProgramContext={graph:context.graph,owner:context.owner,request,state:structuredClone(state),intents:structuredClone([...context.intents]),modelRuns:structuredClone(job.runs??[])};
  if(!state.composition){
    if(!same(state.programRef,program.ref)||state.programDigest!==program.configurationDigest||!same(plan.programRef,program.ref)
      ||plan.programDigest!==program.configurationDigest||!same(plan.scope,state.scope)||step.contextId||step.contextDigest||step.contextScope)fail('Document direct program or scope binding changed');
    if((yield* componentScopeDigestProgram(root,state.scope))!==plan.scopeDigest)fail('Document scope changed after its original plan');
    return root;
  }
  if(!step.binding||!step.contextId||!step.contextDigest||!step.contextScope||!step.scopeDigest||step.bindingDigest!==step.binding.digest
    ||step.action!==step.binding.actionId||!same(step.binding.programRef,program.ref)||step.binding.configurationDigest!==program.configurationDigest)fail('Document component has no exact action and scope pin');
  const component=state.composition.contexts.find(value=>value.id===step.contextId)??fail('Document component is not a member of this task');
  if(component.digest!==step.contextDigest||!same(component.scope,step.contextScope)
    ||(yield* componentScopeDigestProgram(root,component.scope))!==step.scopeDigest)fail('Document component scope changed after its original plan');
  if(component.managedActionIds&&!component.managedActionIds.includes(step.action))fail('Document action is outside its selected component');
  return componentContext(root,component,program);
}

/** Actual document semantic and model-response policy for the PostgreSQL action
 * journal. The executor is deliberately absent. A model result becomes an
 * accepted observation only after its unchanged run evidence is durable. */
export function createPostgresDocumentPolicy():PostgresActionProgramPolicy{
  const program=new DocumentAgentProgram();
  return {program,
    validate:function*(context){
      const ctx=yield* postgresDocumentContextProgram(context,program),sources=yield* validateDocumentProgram(program,ctx,context.step.action,context.input);
      if(context.step.inputRefs.length||context.step.acceptedInputs?.length)fail('Document accepted-input mapping requires the current PostgreSQL materialization proof');
      return {privateDigest:digest({}),validUntil:deadline(context,sources.evidenceValidUntil??context.validUntil)};
    },
    verifyObservation:function*(context,attempt,response){
      if(attempt.kind!=='dispatch'||!Number.isFinite(Date.parse(attempt.startedAt))||context.attempt&&!same(context.attempt,attempt)||attempt.intentId!==context.intent.id||attempt.planDigest!==context.plan.digest
        ||attempt.requestRevision!==(context.job.revision??0)||attempt.inputDigest!==digest(context.input))fail('Document response differs from its original dispatch attempt');
      const run=response.runEvidence??fail('Document response has no original durable document model receipt'),persisted=context.job.runs?.filter(value=>value.id===run.id);
      if(run.purpose!=='document'||persisted?.length!==1||!same(persisted[0],run)
        ||!Number.isFinite(Date.parse(run.startedAt))||!Number.isFinite(Date.parse(run.completedAt))
        ||Date.parse(run.startedAt)<Date.parse(attempt.startedAt)||Date.parse(run.completedAt)<Date.parse(run.startedAt)
        ||Date.parse(run.completedAt)>context.graph.now())fail('Document response has no original durable document model receipt');
      const ctx=yield* postgresDocumentContextProgram(context,program);
      const invocation:DocumentActionProgramContext={...ctx,planId:context.plan.id,intentId:context.intent.id,attemptId:attempt.id,modelRunId:context.plan.modelRunId,operationKey:context.intent.businessOperationKey};
      const result=yield* verifyDocumentResultProgram(program,invocation,context.step.action,context.input,response);
      if(result.id!==digest({intent:context.intent.id,modelRun:run.id})||result.createdAt!==run.completedAt)fail('Document creation time differs from its original model receipt');
      const sources=yield* documentCitationsProgram(invocation,documentActionSchema.parse(context.input));
      deadline(context,sources.evidenceValidUntil??context.validUntil);
    },
  };
}
