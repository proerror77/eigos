import {digest} from '../core/delegation.js';
import type {ObjectRef} from '../ontology/model.js';
import {POLICY_VERSION,SECURITY_CONTRACT} from './contracts.js';
import {combineEnvelopes,type Channel,type SecurityEnvelope} from './envelope.js';
import {projectionInputs,projectionMarkings,responseOnlyProjection} from './projections.js';

export type ObjectRestriction={field:string;classification:SecurityEnvelope['classification'];requiredMarkings:SecurityEnvelope['requiredMarkings'];channels:Channel[]};
export function objectEnvelopeDependencies(ref:ObjectRef,fields:readonly string[],policy:(field:string)=>string):string[] {
  return fields.filter(field=>(ref.type!=='ServiceRequest'||!['progress','projectionState','currentAssessment','requestedOutcome'].includes(field))&&policy(field)!=='derived_from_inputs').sort();
}
export function objectEnvelope(input:{owner:string;ref:ObjectRef;revision:number;fields:string[];channels:Channel[];
  policy:(field:string)=>string;values:Record<string,unknown>;labels:readonly ObjectRestriction[]}):SecurityEnvelope {
  const {owner,ref,revision,fields,channels,policy,values,labels}=input,policies=fields.map(policy);
  const dependencies=objectEnvelopeDependencies(ref,fields,policy);
  const base:SecurityEnvelope={version:SECURITY_CONTRACT,ownerKey:owner,policyVersion:POLICY_VERSION,
    classification:policies.includes('internal_only')?'internal':policies.includes('task_sensitive')?'sensitive':'private',
    requiredMarkings:[...new Set([...(policies.includes('task_sensitive')?['member_private','personal_data'] as const:['member_private'] as const),...fields.flatMap(field=>projectionMarkings(ref.type,field))])],
    channels:channels.filter(channel=>!fields.some(field=>responseOnlyProjection(ref.type,field))||channel!=='registered_model'),
    lineage:[{object:ref,revision,fields:dependencies,contentDigest:digest(Object.fromEntries(dependencies.map(field=>[field,values[field]])))}],lineageComplete:true};
  const relevant=new Set([...fields,...fields.flatMap(field=>projectionInputs(ref.type,field))]);
  return combineEnvelopes([base,...labels.filter(label=>label.field==='*'||relevant.has(label.field)).map(({field:_field,...label})=>({...base,...label}))]);
}
