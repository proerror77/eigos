import type {DatabaseSync} from 'node:sqlite';
import {digest} from '../core/delegation.js';
import {businessTransaction} from '../core/transaction.js';
import {DefinitionStore,currentKernelImplementation,rideSourcesKernelImplementation} from '../ontology/definition-store.js';
import {createSemanticRetrievalKernelDefinition} from '../ontology/seed-definition.js';
import {compileOntologyDocument} from '../ontology/model-compiler.js';
import type {OntologyReleaseRef} from '../ontology/definition-contracts.js';
import {persistentConsentPolicyContracts} from './policy-store.js';
import {upgradeReviewedPolicy} from './reviewed-policy-upgrade.js';
/** Explicit local operator entry. Definition activation and policy CAS are one
 * business transaction. Existing task pins and grants remain unchanged. */
export function upgradeRideSources(db:DatabaseSync,expected:{release:OntologyReleaseRef;generation:number;digest:string;revision:number},apply=false,now=Date.now()){
 return businessTransaction(db,()=>{
  const definitions=new DefinitionStore(db,()=>now),namespace=definitions.namespace();
  if(digest(namespace.active)!==digest(expected.release)||namespace.generation!==expected.generation)throw new Error('Ride upgrade active release or generation changed');
  const active=definitions.resolve(namespace.active),after=rideSourcesKernelImplementation();
  const semantic=createSemanticRetrievalKernelDefinition(),v29=compileOntologyDocument(semantic.document,semantic.registry),prior=active.model.ref.version==='28'?currentKernelImplementation():v29;
  if(digest(active.model.ref)!==digest(prior.ref)||!['28','29'].includes(active.model.ref.version))throw new Error('Ride upgrade requires exact reviewed v28/v29 predecessor');
  const old=persistentConsentPolicyContracts(prior),next=persistentConsentPolicyContracts(after),persistent=expected.digest===old.after;
  const contracts={before:persistent?old.after:old.before,after:persistent?next.after:next.before};
  const preview=upgradeReviewedPolicy(db,prior,after,contracts,expected,false,now);
  if(!apply)return {...preview,releaseBefore:namespace.active,generationBefore:namespace.generation,targetModel:after.ref};
  const activated=definitions.installRideSources(expected.release,expected.generation),policy=upgradeReviewedPolicy(db,prior,after,contracts,expected,true,now);
  return {...policy,releaseBefore:namespace.active,generationBefore:namespace.generation,releaseAfter:activated.active,generationAfter:activated.generation,targetModel:after.ref};
 });
}
/** Startup only recognizes an already atomically installed reviewed release and
 * exact policy. It never activates, migrates, creates a grant or rewrites data. */
export function installedRideSourcesModel(db:DatabaseSync){
 const present=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 if(!present('security_policy_definitions')||!present('ontology_namespaces')||!present('ontology_definition_releases'))return undefined;
 const model=rideSourcesKernelImplementation(),contracts=persistentConsentPolicyContracts(model),stored=db.prepare('SELECT digest FROM security_policy_definitions WHERE slot=1').get()?.digest;
 if(stored!==contracts.before&&stored!==contracts.after)return undefined;
 const release=new DefinitionStore(db,Date.now,{readOnly:true}).active();if(digest(release.model.ref)!==digest(model.ref))throw new Error('Ride policy and active ontology differ; explicit recovery is required');return model;
}
