import type { PlanningReadReceipt } from './planning-contract.js';
import type { ServiceRequest } from './execution.js';
import type { ActionDiscoveryQuery, ActionDiscoveryPage } from '../core/action-bindings.js';
import type { OntologyObjectStore } from './object-store.js';
import { withIntegrity } from '../security/context.js';
import type {SemanticRetrievalStorage} from './semantic-retrieval-port.js';
import type {SemanticCandidatesCall} from './semantic-retrieval.js';
import type {Computation} from './object-functions.js';
import type {ReadBudget} from './object-store.js';

type PlanningOperationName='revision'|'evaluate'|'virtualMembership'|'pipelineChanges';
type OperationName='read'|'readPrivate'|'query'|'related'|'ingest'|'containsLinks'|'relationshipDigest'|'evidencePropertiesDigest'|'tombstone';
type ManagedOperationName='managedObject'|'previewManaged'|'applyManaged';
export type ProjectionMetadata=Pick<OntologyObjectStore,'model'|'now'|'releaseRef'> & {
  /** Truthy for an authority-bound graph. Policy execution stays in storage. */
  readonly security?:unknown;
};
export interface ManagedDispatchInvocation {requestId:string;planId:string;intentId:string;attemptId:string}
interface ProjectedRelationshipStorage {
  /** Trusted source projection only; absent on model/caller graphs. */
  projectedRelationshipDigest?:(...args:Parameters<OntologyObjectStore['projectedRelationshipDigest']>)=>string|Promise<string>;
}
interface ManagedDispatchStorage {
  /** Host authority only. The SQL driver binds the original claim and awaits
   * its journal fence; neither model arguments nor a preview supply this port. */
  managedDispatchCheck?:(owner:string,invocation:ManagedDispatchInvocation)=>void|Promise<void>;
}
export type SyncGraphStorage=Pick<OntologyObjectStore,OperationName> & Partial<Pick<OntologyObjectStore,PlanningOperationName|ManagedOperationName>> & ManagedDispatchStorage & ProjectedRelationshipStorage & {withGraphFunction?<T>(owner:string,id:string,action:(scope:SyncGraphStorage)=>T):T};
export type PlanningGraphStorage={ [K in PlanningOperationName]?:(...args:Parameters<OntologyObjectStore[K]>)=>ReturnType<OntologyObjectStore[K]>|Promise<ReturnType<OntologyObjectStore[K]>> } & {
  call?:(tool:string,input:unknown,options?:{origin:'worker_context';maxOutputBytes:number})=>unknown;
  recordRead?:(receipt:PlanningReadReceipt)=>void|Promise<void>;
  discoverActions?:(owner:string,request:ServiceRequest,query:ActionDiscoveryQuery)=>ActionDiscoveryPage|Promise<ActionDiscoveryPage>;
};
type CoreGraphStorage={
  [K in OperationName]:(...args:Parameters<OntologyObjectStore[K]>)=>ReturnType<OntologyObjectStore[K]>|Promise<ReturnType<OntologyObjectStore[K]>>;
} & { planning?:PlanningGraphStorage } & {
  /** Only a trusted proof program can enter this internal validation scope. */
  withGraphIntegrity?<T>(action:()=>Promise<T>):Promise<T>;
} & {
  [K in ManagedOperationName]?:(...args:Parameters<OntologyObjectStore[K]>)=>ReturnType<OntologyObjectStore[K]>|Promise<ReturnType<OntologyObjectStore[K]>>;
} & ManagedDispatchStorage & ProjectedRelationshipStorage & SemanticRetrievalStorage;
export type GraphStorage=CoreGraphStorage & {withGraphFunction?<T>(owner:string,id:string,action:(scope:GraphStorage)=>Promise<T>):Promise<T>};
type StorageOperation={ [K in OperationName|PlanningOperationName|ManagedOperationName]:{method:K;args:Parameters<OntologyObjectStore[K]>} }[OperationName|PlanningOperationName|ManagedOperationName]
  |{method:'planningCall';tool:string;input:unknown;options?:{origin:'worker_context';maxOutputBytes:number}}
  |{method:'planningRead';receipt:PlanningReadReceipt}
  |{method:'discoverActions';owner:string;request:ServiceRequest;query:ActionDiscoveryQuery}
  |{method:'managedDispatchCheck';owner:string;invocation:ManagedDispatchInvocation}
  |{method:'semanticCandidates';owner:string;input:SemanticCandidatesCall;budget:ReadBudget}
  |{method:'projectedRelationshipDigest';args:Parameters<OntologyObjectStore['projectedRelationshipDigest']>};
type Operation=StorageOperation|{method:'integrity';program:GraphProgram<unknown>}|{method:'registeredFunction';owner:string;id:string;program:GraphProgram<unknown>};
export type GraphProgram<T>=Generator<Operation,T,unknown>;

// The casts are confined to the typed storage boundary. Each operation's
// arguments and result are fixed by the existing graph contract.
export function* graphRead(...args:Parameters<OntologyObjectStore['read']>):GraphProgram<ReturnType<OntologyObjectStore['read']>> {
  return (yield {method:'read',args}) as ReturnType<OntologyObjectStore['read']>;
}
export function* graphReadPrivate(...args:Parameters<OntologyObjectStore['readPrivate']>):GraphProgram<ReturnType<OntologyObjectStore['readPrivate']>> {
  return (yield {method:'readPrivate',args}) as ReturnType<OntologyObjectStore['readPrivate']>;
}
export function* graphQuery(...args:Parameters<OntologyObjectStore['query']>):GraphProgram<ReturnType<OntologyObjectStore['query']>> {
  return (yield {method:'query',args}) as ReturnType<OntologyObjectStore['query']>;
}
export function* graphRelated(...args:Parameters<OntologyObjectStore['related']>):GraphProgram<ReturnType<OntologyObjectStore['related']>> {
  return (yield {method:'related',args}) as ReturnType<OntologyObjectStore['related']>;
}
export function* graphIngest(...args:Parameters<OntologyObjectStore['ingest']>):GraphProgram<void> {yield {method:'ingest',args};}
export function* graphContainsLinks(...args:Parameters<OntologyObjectStore['containsLinks']>):GraphProgram<ReturnType<OntologyObjectStore['containsLinks']>> {
  return (yield {method:'containsLinks',args}) as ReturnType<OntologyObjectStore['containsLinks']>;
}
export function* graphRelationshipDigest(...args:Parameters<OntologyObjectStore['relationshipDigest']>):GraphProgram<ReturnType<OntologyObjectStore['relationshipDigest']>> {
  return (yield {method:'relationshipDigest',args}) as ReturnType<OntologyObjectStore['relationshipDigest']>;
}
export function* graphProjectedRelationshipDigest(...args:Parameters<OntologyObjectStore['projectedRelationshipDigest']>):GraphProgram<string>{return (yield {method:'projectedRelationshipDigest',args}) as string;}
export function* graphEvidencePropertiesDigest(...args:Parameters<OntologyObjectStore['evidencePropertiesDigest']>):GraphProgram<string> {
  return (yield {method:'evidencePropertiesDigest',args}) as string;
}
export function* graphIntegrity<T>(program:GraphProgram<T>):GraphProgram<T> {
  return (yield {method:'integrity',program}) as T;
}
export function* graphWithFunction<T>(owner:string,id:string,program:GraphProgram<T>):GraphProgram<T>{return (yield {method:'registeredFunction',owner,id,program}) as T;}
export function* graphSome<T>(values:readonly T[],predicate:(value:T,index:number,values:readonly T[])=>GraphProgram<unknown>):GraphProgram<boolean> {
  const length=values.length;
  for(let index=0;index<length;index++)if(index in values && (yield* predicate(values[index]!,index,values)))return true;
  return false;
}
export function* graphSomeOptional<T>(values:readonly T[]|null|undefined,predicate:(value:T,index:number,values:readonly T[])=>GraphProgram<unknown>):GraphProgram<boolean|undefined> {
  if(values===null||values===undefined)return undefined;
  return yield* graphSome(values,predicate);
}
export function* graphEvery<T>(values:readonly T[],predicate:(value:T,index:number,values:readonly T[])=>GraphProgram<unknown>):GraphProgram<boolean> {
  const length=values.length;
  for(let index=0;index<length;index++)if(index in values && !(yield* predicate(values[index]!,index,values)))return false;
  return true;
}
export function* graphMap<T,R>(values:readonly T[],project:(value:T,index:number,values:readonly T[])=>GraphProgram<R>):GraphProgram<R[]> {
  const length=values.length,result=new Array<R>(length);
  for(let index=0;index<length;index++)if(index in values)result[index]=yield* project(values[index]!,index,values);
  return result;
}
export function* graphTombstone(...args:Parameters<OntologyObjectStore['tombstone']>):GraphProgram<ReturnType<OntologyObjectStore['tombstone']>> {
  return (yield {method:'tombstone',args}) as ReturnType<OntologyObjectStore['tombstone']>;
}
export function* graphManagedObject(...args:Parameters<OntologyObjectStore['managedObject']>):GraphProgram<ReturnType<OntologyObjectStore['managedObject']>> {
  return (yield {method:'managedObject',args}) as ReturnType<OntologyObjectStore['managedObject']>;
}
export function* graphPreviewManaged(...args:Parameters<OntologyObjectStore['previewManaged']>):GraphProgram<void>{yield {method:'previewManaged',args};}
export function* graphApplyManaged(...args:Parameters<OntologyObjectStore['applyManaged']>):GraphProgram<void>{yield {method:'applyManaged',args};}
export function* graphManagedDispatchCheck(owner:string,invocation:ManagedDispatchInvocation):GraphProgram<void>{yield {method:'managedDispatchCheck',owner,invocation};}
export function* graphRevision(...args:Parameters<OntologyObjectStore['revision']>):GraphProgram<ReturnType<OntologyObjectStore['revision']>> {
  return (yield {method:'revision',args}) as ReturnType<OntologyObjectStore['revision']>;
}
export function* graphEvaluate(...args:Parameters<OntologyObjectStore['evaluate']>):GraphProgram<ReturnType<OntologyObjectStore['evaluate']>> {
  return (yield {method:'evaluate',args}) as ReturnType<OntologyObjectStore['evaluate']>;
}
export function* graphSemanticCandidates(owner:string,input:SemanticCandidatesCall,budget:ReadBudget):GraphProgram<Computation>{
  return (yield {method:'semanticCandidates',owner,input,budget}) as Computation;
}
export function* graphVirtualMembership(...args:Parameters<OntologyObjectStore['virtualMembership']>):GraphProgram<ReturnType<OntologyObjectStore['virtualMembership']>> {
  return (yield {method:'virtualMembership',args}) as ReturnType<OntologyObjectStore['virtualMembership']>;
}
export function* graphPipelineChanges(...args:Parameters<OntologyObjectStore['pipelineChanges']>):GraphProgram<ReturnType<OntologyObjectStore['pipelineChanges']>> {
  return (yield {method:'pipelineChanges',args}) as ReturnType<OntologyObjectStore['pipelineChanges']>;
}
export function* graphPlanningCall(tool:string,input:unknown,options?:{origin:'worker_context';maxOutputBytes:number}):GraphProgram<unknown> {
  return yield {method:'planningCall',tool,input,options};
}
export function* graphRecordPlanningRead(receipt:PlanningReadReceipt):GraphProgram<void> {yield {method:'planningRead',receipt};}
export function* graphDiscoverActions(owner:string,request:ServiceRequest,query:ActionDiscoveryQuery):GraphProgram<ActionDiscoveryPage> {
  return (yield {method:'discoverActions',owner,request,query}) as ActionDiscoveryPage;
}
function perform(graph:CoreGraphStorage,operation:StorageOperation,planning:PlanningGraphStorage|undefined):unknown {
  switch(operation.method) {
    case 'semanticCandidates':return graph.semanticCandidates?graph.semanticCandidates(operation.owner,operation.input,operation.budget):{status:'unknown',reason:'semantic_retrieval_not_installed',evidenceRefs:[],evidenceLevels:[]};
    case 'planningCall':if(!planning?.call)throw new Error('Planning read dispatch is unavailable');return planning.call(operation.tool,operation.input,operation.options);
    case 'planningRead':if(!planning?.recordRead)throw new Error('Planning receipt persistence is unavailable');return planning.recordRead(operation.receipt);
    case 'discoverActions':if(!planning?.discoverActions)throw new Error('Action discovery is unavailable');return planning.discoverActions(operation.owner,operation.request,operation.query);
    case 'managedDispatchCheck':if(!graph.managedDispatchCheck)throw new Error('Managed dispatch authority is unavailable');return graph.managedDispatchCheck(operation.owner,operation.invocation);
    case 'revision':if(!planning?.revision)throw new Error('Graph does not support revision');return planning.revision(...operation.args);
    case 'evaluate':if(!planning?.evaluate)throw new Error('Graph does not support evaluate');return planning.evaluate(...operation.args);
    case 'virtualMembership':if(!planning?.virtualMembership)throw new Error('Graph does not support virtualMembership');return planning.virtualMembership(...operation.args);
    case 'pipelineChanges':if(!planning?.pipelineChanges)throw new Error('Graph does not support pipelineChanges');return planning.pipelineChanges(...operation.args);
    case 'read':return graph.read(...operation.args);
    case 'readPrivate':return graph.readPrivate(...operation.args);
    case 'query':return graph.query(...operation.args);
    case 'related':return graph.related(...operation.args);
    case 'ingest':return graph.ingest(...operation.args);
    case 'containsLinks':return graph.containsLinks(...operation.args);
    case 'relationshipDigest':return graph.relationshipDigest(...operation.args);
    case 'projectedRelationshipDigest':if(!graph.projectedRelationshipDigest)throw new Error('Trusted projected relationship evidence is unavailable');return graph.projectedRelationshipDigest(...operation.args);
    case 'evidencePropertiesDigest':return graph.evidencePropertiesDigest(...operation.args);
    case 'tombstone':return graph.tombstone(...operation.args);
    case 'managedObject':if(!graph.managedObject)throw new Error('Managed object access is unavailable');return graph.managedObject(...operation.args);
    case 'previewManaged':if(!graph.previewManaged)throw new Error('Managed preview is unavailable');return graph.previewManaged(...operation.args);
    case 'applyManaged':if(!graph.applyManaged)throw new Error('Managed writes are unavailable');return graph.applyManaged(...operation.args);
  }
}

/** Run the existing synchronous graph API without changing its transaction
 * boundaries. A promise cannot silently pass through synchronous projection. */
export function runGraphProgram<T>(graph:SyncGraphStorage,program:GraphProgram<T>,planning:PlanningGraphStorage=graph):T {
  let step=program.next();
  while(!step.done) {
    let value:unknown;
    try {
      const operation=step.value;
      if(operation.method==='registeredFunction'){if(!graph.withGraphFunction)throw new Error('Registered read-function scope is unavailable');value=graph.withGraphFunction(operation.owner,operation.id,scope=>runGraphProgram(scope,operation.program,planning));}
      else value=operation.method==='integrity'?withIntegrity(()=>runGraphProgram(graph,operation.program,planning)):perform(graph,operation,planning);
      if(value && (typeof value==='object'||typeof value==='function') && 'then' in value && typeof value.then==='function')throw new Error('Synchronous graph program received asynchronous storage');
    } catch(error) {step=program.throw(error);continue;}
    step=program.next(value);
  }
  return step.value;
}

/** Execute the same projection program against asynchronous storage. Every
 * operation runs once, in order; storage errors enter the original catch blocks.
 * These programs contain no model calls or external business dispatch. */
export async function runGraphProgramAsync<T>(graph:GraphStorage,program:GraphProgram<T>):Promise<T> {
  let step=program.next();
  while(!step.done) {
    let value:unknown;
    try {
      const operation=step.value;
      if(operation.method==='registeredFunction'){if(!graph.withGraphFunction)throw new Error('Registered read-function scope is unavailable');value=await graph.withGraphFunction(operation.owner,operation.id,scope=>runGraphProgramAsync(scope,operation.program));}
      else if(operation.method==='integrity') {
        const action=()=>runGraphProgramAsync(graph,operation.program);
        value=await(graph.withGraphIntegrity?graph.withGraphIntegrity(action):withIntegrity(action));
      }else value=await perform(graph,operation,graph.planning);
    }
    catch(error) {step=program.throw(error);continue;}
    step=program.next(value);
  }
  return step.value;
}
