import type {DatabaseSync} from 'node:sqlite';
import type {ObjectRef} from '../ontology/model.js';
import {SecurityError} from './store.js';

import {taskContextFields} from './task-context-contract.js';
export {taskContextFields} from './task-context-contract.js';

const edges=new Set(['RequestSpecificationInstruction','RequestSpecificationConstraint','SpecificationFact','SpecificationCondition','ExecutionContextBinding','ExecutionPlanContext','ExecutionStepPlan','ExecutionInputStep','ExecutionAttemptStep','ExecutionResultAttempt','ExecutionResultStep','ExecutionStepAction','ExecutionStepBinding','ExecutionBindingAction','ExecutionStepDependency']);
const key=(ref:ObjectRef)=>JSON.stringify([ref.type,ref.id]);
/** Recompute membership from the current request's exact specification/context.
 * No source-backed business object enters through this task metadata path. */
export function taskContextMembers(db:DatabaseSync,owner:string,taskId:string,revision:number):Map<string,ObjectRef> {
 // A card's first writer is provenance, not current discovery membership.
 // Even cards originally written by this task need its current exact link.
 const types=Object.keys(taskContextFields), rows=db.prepare(`SELECT type,id,body FROM ontology_objects WHERE owner=? AND type IN (${types.map(()=>'?').join(',')}) AND (type<>'RegisteredCapability' AND json_extract(body,'$.source.kind')='task' AND json_extract(body,'$.source.id')=? OR type='RegisteredCapability' AND EXISTS(SELECT 1 FROM ontology_links l WHERE l.owner=ontology_objects.owner AND l.type='CapabilityRequest' AND l.from_type=ontology_objects.type AND l.from_id=ontology_objects.id AND l.to_type='ServiceRequest' AND l.to_id=?)) LIMIT 2001`).all(owner,...types,taskId,taskId);
 if(rows.length>2000)throw new SecurityError('INSUFFICIENT_ACCESS');
 const candidates=new Map<string,{ref:ObjectRef;properties:Record<string,unknown>}>();
 for(const row of rows) {
  const ref={type:String(row.type),id:String(row.id)},body=JSON.parse(String(row.body)),p=body.properties;
  if(body.source?.kind!=='task' || ref.type!=='RegisteredCapability' && body.source.id!==taskId || p.requestRevision!==undefined && p.requestRevision!==revision)continue;
  if(ref.type==='RegisteredCapability' && ref.id!==`capability:${p.definitionDigest}`)continue;
  candidates.set(key(ref),{ref,properties:p});
 }
 const selected=new Map<string,ObjectRef>();
 for(const {ref,properties} of candidates.values())if(['RequestSpecification','ExecutionContext'].includes(ref.type) && properties.requestRevision===revision || ref.type==='RegisteredCapability')selected.set(key(ref),ref);
 const links=db.prepare(`SELECT type,from_type,from_id,to_type,to_id FROM ontology_links WHERE owner=? AND type IN (${[...edges].map(()=>'?').join(',')}) AND (EXISTS(SELECT 1 FROM ontology_objects o WHERE o.owner=ontology_links.owner AND o.type=ontology_links.from_type AND o.id=ontology_links.from_id AND json_extract(o.body,'$.source.id')=?) OR EXISTS(SELECT 1 FROM ontology_objects o WHERE o.owner=ontology_links.owner AND o.type=ontology_links.to_type AND o.id=ontology_links.to_id AND json_extract(o.body,'$.source.id')=?)) LIMIT 4001`).all(owner,...edges,taskId,taskId);
 if(links.length>4000)throw new SecurityError('INSUFFICIENT_ACCESS');
 // Bounded graph closure over reviewed metadata edge kinds. Source result/scope
 // edges are deliberately absent; those require their own provider grants.
 for(let round=0;round<12;round++) {
  let changed=false;
  for(const row of links){const a={type:String(row.from_type),id:String(row.from_id)},b={type:String(row.to_type),id:String(row.to_id)};
   if(!candidates.has(key(a)) || !candidates.has(key(b)))continue;
   if(selected.has(key(a)) && !selected.has(key(b))){selected.set(key(b),b);changed=true;}
   if(selected.has(key(b)) && !selected.has(key(a))){selected.set(key(a),a);changed=true;}
  }
  if(!changed)return selected;
 }
 throw new SecurityError('INSUFFICIENT_ACCESS');
}
