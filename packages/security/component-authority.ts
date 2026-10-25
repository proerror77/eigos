import {digest} from '../core/delegation.js';
import type {AgentExecutionState, AgentActionPlan} from '../ontology/agent-actions.js';
import {compositionInputSchema} from '../ontology/composition.js';
import {SecurityError} from './store.js';

/** The parent grants orchestration only. Every routed provider action also
 * needs the separately selected component's exact source configuration. */
export function actionSources(state:AgentExecutionState,action:string,input:Record<string,unknown>,step?:AgentActionPlan['steps'][number]) {
  const parent={programRef:state.programRef,programDigest:state.programDigest};
  if(state.programRef.id==='eigos.goal') {
    if(state.programRef.version!=='1' || !state.composition || !step?.binding || !step.contextId) throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    const component=state.composition.contexts.find(c=>c.id===step.contextId),pin=step.binding,{digest:pinDigest,...pinBody}=pin;
    if(!component || state.composition.retiredContexts?.some(c=>c.id===component.id) || component.digest!==step.contextDigest || digest(component.scope)!==digest(step.contextScope)
      || component.requestRevision!==state.requestRevision || pin.requestRevision!==state.requestRevision || pin.actionId!==action || digest(pinBody)!==pinDigest
      || digest(component.programRef)!==digest(pin.programRef) || component.programDigest!==pin.configurationDigest) throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    // eigos.goal is a task-local verifier, not a configured source connector.
    // Its controller/task grant is checked by requireDispatch; actual providers
    // still need their separately selected source and operation authorization.
    return [{programRef:component.programRef,programDigest:component.programDigest}];
  }
  if(!['services.compose.live','services.compose.sandbox'].includes(state.programRef.id))return [parent];
  if(state.programRef.version!=='1')throw new SecurityError('SOURCE_NOT_AUTHORIZED');
  if(['ActivateServiceComponent','CompleteServiceComponent'].includes(action)) {
    if(digest(input.scope)!==digest(state.scope))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    return [parent];
  }
  const definition=compositionInputSchema.parse(state.input);
  const components=Object.entries(state.components??{}).filter(([,component])=>component.scope && digest(component.scope)===digest(input.scope));
  if(components.length!==1)throw new SecurityError('SOURCE_NOT_AUTHORIZED');
  const [id,component]=components[0]!,node=definition.components.find(n=>n.id===id);
  if(!node || component.result || digest(node.capabilityRef)!==digest(component.programRef))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
  return [parent,{programRef:component.programRef,programDigest:component.programDigest}];
}
