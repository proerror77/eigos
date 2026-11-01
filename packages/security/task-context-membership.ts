import type { ObjectRef } from '../ontology/model.js';
import { SecurityError } from './errors.js';

/** Reviewed task-metadata edges. Business source relationships are excluded. */
export const TASK_CONTEXT_EDGES=Object.freeze(['RequestSpecificationInstruction','RequestSpecificationConstraint','RequestConstraintPredecessor','SpecificationFact','SpecificationCondition','ExecutionContextBinding','ExecutionPlanContext','ExecutionStepPlan','ExecutionInputStep','ExecutionAttemptStep','ExecutionResultAttempt','ExecutionResultStep','ExecutionStepAction','ExecutionStepBinding','ExecutionBindingAction','ExecutionStepDependency'] as const);
const key=(ref:ObjectRef)=>JSON.stringify([ref.type,ref.id]);
type CandidateRow=Record<string,unknown>;
type LinkRow=Record<string,unknown>;

/** Pure closure shared by database adapters. Both must first select the same
 * owned candidate rows and reviewed links, and reject malformed inputs. */
export function collectTaskContextMembers(rows:readonly CandidateRow[],links:readonly LinkRow[],taskId:string,revision:number):Map<string,ObjectRef> {
 if(rows.length>2000 || links.length>4000)throw new SecurityError('INSUFFICIENT_ACCESS');
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
