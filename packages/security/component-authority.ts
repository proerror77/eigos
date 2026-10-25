import {digest} from '../core/delegation.js';
import type {AgentExecutionState} from '../ontology/agent-actions.js';
import {compositionInputSchema} from '../ontology/composition.js';
import {SecurityError} from './store.js';

/** The parent grants orchestration only. Every routed provider action also
 * needs the separately selected component's exact source configuration. */
export function actionSources(state:AgentExecutionState,action:string,input:Record<string,unknown>) {
  const parent={programRef:state.programRef,programDigest:state.programDigest};
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
