import {digest} from '../core/delegation.js';
import {DomainError} from '../core/domain.js';
import type {OntologyDocument} from './definition-contracts.js';
import type {TrustedDefinitionRegistry} from './model-compiler.js';
import {semanticCandidatesDefinition} from './semantic-retrieval.js';
import type {OntologyModel} from './model.js';

/** Forward software release only; no stored namespace or task is activated. */
export function extendSemanticRetrievalKernel(original:OntologyDocument,registry:TrustedDefinitionRegistry):OntologyDocument{
  if(original.version!=='27'||original.functions.some(fn=>fn.id===semanticCandidatesDefinition.id))throw new DomainError('CONFLICT','Semantic retrieval requires its exact v27 predecessor');
  const document=structuredClone(original);document.version='28';
  document.functions.push({...semanticCandidatesDefinition,handlerRef:registry.registerFunction(semanticCandidatesDefinition)});
  return document;
}
export function isSemanticRetrievalSuccessor(prior:OntologyModel,next:OntologyModel):boolean{
  if(prior.ref.id!==next.ref.id||prior.ref.version!=='27'||next.ref.version!=='28')return false;
  const a=prior.definitionSnapshot(),b=next.definitionSnapshot();
  return a.objects.length===b.objects.length&&a.objects.every(type=>next.hasType(type.id)&&prior.fingerprint(type.id)===next.fingerprint(type.id))
    &&a.interfaces.length===b.interfaces.length&&a.interfaces.every(type=>next.isInterface(type.id)&&digest(prior.describeType(type.id))===digest(next.describeType(type.id)))
    &&digest(a.links)===digest(b.links)&&digest(a.actions)===digest(b.actions)
    &&b.functions.length===a.functions.length+1&&a.functions.every(fn=>b.functions.some(candidate=>digest(fn)===digest(candidate)))
    &&digest(b.functions.find(fn=>fn.id===semanticCandidatesDefinition.id))===digest(semanticCandidatesDefinition);
}
/** The additive function does not change data classification, consent schemas
 * or resource defaults. Recompute its exact predecessor model hash; a changed
 * object/action/function produces a different contract, never a wildcard. */
export function semanticFieldPolicyRef(model:OntologyModel){
  if(model.ref.version!=='28'||digest(model.definitionSnapshot().functions.find(fn=>fn.id===semanticCandidatesDefinition.id))!==digest(semanticCandidatesDefinition))return model.ref;
  const definition=model.definitionSnapshot();
  return {id:model.ref.id,version:'27',digest:digest({objects:definition.objects.map(type=>model.describeType(type.id)),interfaces:definition.interfaces.map(type=>model.describeType(type.id)),
    links:definition.links,actions:definition.actions,functions:definition.functions.filter(fn=>fn.id!==semanticCandidatesDefinition.id)})};
}
