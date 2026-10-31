import type {DatabaseSync} from 'node:sqlite';
import type {ObjectRef} from '../ontology/model.js';
import {SecurityError} from './store.js';

import {taskContextFields} from './task-context-contract.js';
export {taskContextFields} from './task-context-contract.js';

// A corrected interpretation retains its prior input as evidence. Both ends
// still pass the same task ownership and current-or-earlier revision bounds.
const edges=new Set(['RequestSpecificationInstruction','RequestSpecificationConstraint','RequestConstraintPredecessor','SpecificationFact','SpecificationCondition','ExecutionContextBinding','ExecutionPlanContext','ExecutionStepPlan','ExecutionInputStep','ExecutionAttemptStep','ExecutionResultAttempt','ExecutionResultStep','ExecutionStepAction','ExecutionStepBinding','ExecutionBindingAction','ExecutionStepDependency']);
const key=(ref:ObjectRef)=>JSON.stringify([ref.type,ref.id]);
const sourceId="CASE WHEN json_valid(body) THEN json_extract(body,'$.source.id') END";
/** Recompute membership from the current request's exact specification/context.
 * No source-backed business object enters through this task metadata path. */
export function taskContextMembers(db:DatabaseSync,owner:string,taskId:string,revision:number):Map<string,ObjectRef> {
 // A card's first writer is provenance, not current discovery membership.
 // Even cards originally written by this task need its current exact link.
 const types=Object.keys(taskContextFields),metadata=types.filter(type=>type!=='RegisteredCapability');
 // The source index safely omits invalid JSON. Do not turn corrupted task
 // metadata or incident reviewed links into an apparently absent dependency.
 if(db.prepare(`SELECT 1 FROM ontology_objects o WHERE o.owner=? AND json_valid(o.body)=0
   AND (o.type IN (${metadata.map(()=>'?').join(',')}) OR o.type='RegisteredCapability' AND EXISTS(SELECT 1 FROM ontology_links l WHERE l.owner=o.owner AND l.type='CapabilityRequest' AND l.from_type=o.type AND l.from_id=o.id AND l.to_type='ServiceRequest' AND l.to_id=?)
   OR EXISTS(SELECT 1 FROM ontology_links l WHERE l.owner=o.owner AND l.type IN (${[...edges].map(()=>'?').join(',')})
   AND (l.from_type=o.type AND l.from_id=o.id OR l.to_type=o.type AND l.to_id=o.id))) LIMIT 1`).get(owner,...metadata,taskId,...edges))throw new SecurityError('POLICY_CHANGED');
 const rows=db.prepare(`SELECT type,id,body FROM ontology_objects WHERE owner=? AND type IN (${metadata.map(()=>'?').join(',')}) AND ${sourceId}=? AND json_extract(body,'$.source.kind')='task'
   UNION ALL SELECT o.type,o.id,o.body FROM ontology_links l CROSS JOIN ontology_objects o ON o.owner=l.owner AND o.type=l.from_type AND o.id=l.from_id
   WHERE l.owner=? AND l.type='CapabilityRequest' AND l.from_type='RegisteredCapability' AND l.to_type='ServiceRequest' AND l.to_id=?
   ORDER BY type,id LIMIT 2001`).all(owner,...metadata,taskId,owner,taskId);
 if(rows.length>2000)throw new SecurityError('INSUFFICIENT_ACCESS');
 const candidates=new Map<string,{ref:ObjectRef;properties:Record<string,unknown>}>();
 for(const row of rows) {
  const ref={type:String(row.type),id:String(row.id)},body=JSON.parse(String(row.body)),p=body.properties;
  if(body.source?.kind!=='task' || ref.type!=='RegisteredCapability' && body.source.id!==taskId || p.requestRevision!==undefined && p.requestRevision!==revision)continue;
  if(typeof p.introducedRevision==='number' && p.introducedRevision>revision)continue;
  if(ref.type==='RegisteredCapability' && ref.id!==`capability:${p.definitionDigest}`)continue;
  candidates.set(key(ref),{ref,properties:p});
 }
 const selected=new Map<string,ObjectRef>();
 for(const {ref,properties} of candidates.values())if(['RequestSpecification','ExecutionContext'].includes(ref.type) && properties.requestRevision===revision || ref.type==='RegisteredCapability')selected.set(key(ref),ref);
 // Drive both existing relationship indexes from this task's source refs,
 // rather than scanning every reviewed relationship in the owner's history.
 // UNION preserves the previous either-end rule without counting an edge twice.
 const links=db.prepare(`WITH task_objects AS MATERIALIZED (SELECT type,id FROM ontology_objects WHERE owner=? AND ${sourceId}=?)
   SELECT l.type,l.from_type,l.from_id,l.to_type,l.to_id FROM task_objects o CROSS JOIN ontology_links l ON l.owner=? AND l.from_type=o.type AND l.from_id=o.id WHERE l.type IN (${[...edges].map(()=>'?').join(',')})
   UNION SELECT l.type,l.from_type,l.from_id,l.to_type,l.to_id FROM task_objects o CROSS JOIN ontology_links l ON l.owner=? AND l.to_type=o.type AND l.to_id=o.id WHERE l.type IN (${[...edges].map(()=>'?').join(',')})
   ORDER BY 1,2,3,4,5 LIMIT 4001`).all(owner,taskId,owner,...edges,owner,...edges);
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
