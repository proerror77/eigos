import { digest } from '../core/delegation.js';
import type { ServiceRequest } from '../ontology/execution.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { AgentPlanningContext } from '../coordinator/coordinator.js';
import { authorizationScope } from './context.js';
import { SecurityError } from './store.js';
import { combineEnvelopes,requireChannel } from './envelope.js';
import type {ObjectRef} from '../ontology/model.js';
import type {GoalReviewContext} from '../ontology/goal-coverage.js';
import {compositionInputSchema} from '../ontology/composition.js';

// User-submitted text and structured constraints belong to the accepted task
// contract. Derived interpretations do not silently create new submitted data.
export function submissionDigest(request:ServiceRequest) {
  return digest({id:request.id,revision:request.revision,originalGoal:request.originalGoal,messages:request.messages,
    requirements:request.requirements.filter(r=>r.provenance.interpretation==='structured'),
    requestedDeliverable:request.requestedDeliverable,executionEnvironment:request.executionEnvironment});
}
export function accessDigest() {
  const scope=authorizationScope();
  return scope?digest({installation:scope.actor.installationId,epoch:scope.actor.authEpoch,grant:scope.grant&&{id:scope.grant.id,revision:scope.grant.revision},policyRevision:scope.policyRevision,operation:scope.operation}):undefined;
}
export function secureRequest(graph:OntologyObjectStore,owner:string,request:ServiceRequest):ServiceRequest {
  if (!graph.security) return structuredClone(request);
  const policy=graph.security,scope=policy.scope(owner),root={type:'ServiceRequest',id:request.id},binding=policy.requireObject(owner,root);
  if (scope.grant?.taskId!==request.id || scope.grant.requestRevision!==request.revision || !binding.fields.includes('originalGoal')
    || (request.requirements.length>0 || request.conditions?.length) && !binding.fields.includes('conditions')) throw new SecurityError('INSUFFICIENT_ACCESS');
  const object=graph.read(owner,root);
  if (object.properties.originalGoal!==request.originalGoal) throw new SecurityError('POLICY_CHANGED');
  const base=policy.envelope(owner,root,object.revision,['originalGoal'],object.properties,scope.grant.channels);
  const envelope=combineEnvelopes([base,{...base,classification:'sensitive',requiredMarkings:['member_private','personal_data']}]);
  envelope.submission={taskId:request.id,requestRevision:request.revision,contentDigest:submissionDigest(request)};
  policy.capture(scope,envelope);
  return structuredClone(request);
}
export function secureAgentContext(context:AgentPlanningContext,graph:OntologyObjectStore):AgentPlanningContext {
  if (!graph.security) return context;
  const scope=authorizationScope()!,policy=graph.security;
  const input=authorizedInput(graph,scope.actor.ownerKey,context.state.scope);
  const refs=context.state.observations.filter(ref=>!!policy.binding(scope,ref));
  const definitions=context.components?compositionInputSchema.parse(input):undefined;
  const components=context.components?.map(component=>{
    const node=definitions!.components.find(n=>n.id===component.id);
    if(!node || digest(node.capabilityRef)!==digest(component.state.programRef))throw new SecurityError('POLICY_CHANGED');
    const state=component.state,componentInput=state.scope?authorizedInput(graph,scope.actor.ownerKey,state.scope):undefined;
    const resultFields=state.result?graph.read(scope.actor.ownerKey,state.result.ref).properties:undefined;
    const result=state.result?{ref:state.result.ref,at:state.result.at,
      evidenceRefs:Array.isArray(resultFields?.evidenceRefs)?resultFields.evidenceRefs.filter((v):v is string=>typeof v==='string'):[],
      ...(typeof resultFields?.evidenceLevel==='string'?{evidenceLevel:resultFields.evidenceLevel}:{})}:undefined;
    return {...component,...node,state:{...state,input:componentInput,observations:state.observations.filter(ref=>!!policy.binding(scope,ref)),result},
      actionIds:component.actionIds.filter(id=>policy.resourceAllowed(scope,'actionType',id,'action.execute'))};
  });
  return {...context,request:secureRequest(graph,scope.actor.ownerKey,context.request),actionIds:context.actionIds.filter(id=>policy.resourceAllowed(scope,'actionType',id,'action.execute')),
    state:{...context.state,input:structuredClone(input as Record<string,unknown>),observations:refs,
      plans:[],feedback:[],informationRequests:[],paPayment:undefined,components:undefined,inputResolutions:undefined,initialSelectionPending:undefined,completion:undefined},components,
    actionOutcomes:context.actionOutcomes?.map(({stepId,state})=>({stepId,intentId:'',state})),
  };
}
function authorizedInput(graph:OntologyObjectStore,owner:string,ref:ObjectRef):Record<string,unknown> {
  const object=graph.read(owner,ref),input=object.properties.authorizedInput??object.properties.input;
  if(!input || typeof input!=='object' || Array.isArray(input))throw new SecurityError('INSUFFICIENT_ACCESS');
  return structuredClone(input as Record<string,unknown>);
}
export function secureGoalContext(context:GoalReviewContext,graph:OntologyObjectStore,scope?:ObjectRef):GoalReviewContext {
  if(!graph.security)return context;
  if(!scope)throw new SecurityError('INSUFFICIENT_ACCESS');
  const owner=authorizationScope()!.actor.ownerKey,input=authorizedInput(graph,owner,scope);
  if(digest(input)!==digest(context.input))throw new SecurityError('INSUFFICIENT_ACCESS');
  return {...context,input,request:secureRequest(graph,owner,context.request)};
}
export function assertModelChannel(graph:OntologyObjectStore,channel?:string) {
  if (!graph.security) return;
  const scope=authorizationScope();
  if (!scope || !channel) throw new SecurityError('OUTPUT_NOT_ALLOWED');
  scope.assertCurrent();
  const envelope=graph.security.outputEnvelope(scope.actor.ownerKey);
  requireChannel(graph.security.effectiveEnvelope(scope,envelope),'registered_model',graph.security.modelChannel(channel));
}
