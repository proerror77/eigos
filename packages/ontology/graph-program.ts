import type { OntologyObjectStore } from './object-store.js';
import { withIntegrity } from '../security/context.js';

type OperationName='read'|'readPrivate'|'query'|'related'|'ingest'|'containsLinks'|'relationshipDigest'|'evidencePropertiesDigest'|'tombstone';
export type ProjectionMetadata=Pick<OntologyObjectStore,'model'|'now'|'releaseRef'> & {
  /** Truthy for an authority-bound graph. Policy execution stays in storage. */
  readonly security?:unknown;
};
export type SyncGraphStorage=Pick<OntologyObjectStore,OperationName>;
export type GraphStorage={
  [K in OperationName]:(...args:Parameters<OntologyObjectStore[K]>)=>ReturnType<OntologyObjectStore[K]>|Promise<ReturnType<OntologyObjectStore[K]>>;
} & {
  /** Only a trusted proof program can enter this internal validation scope. */
  withGraphIntegrity?<T>(action:()=>Promise<T>):Promise<T>;
};
type StorageOperation={ [K in OperationName]:{method:K;args:Parameters<OntologyObjectStore[K]>} }[OperationName];
type Operation=StorageOperation|{method:'integrity';program:GraphProgram<unknown>};
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
export function* graphEvidencePropertiesDigest(...args:Parameters<OntologyObjectStore['evidencePropertiesDigest']>):GraphProgram<string> {
  return (yield {method:'evidencePropertiesDigest',args}) as string;
}
export function* graphIntegrity<T>(program:GraphProgram<T>):GraphProgram<T> {
  return (yield {method:'integrity',program}) as T;
}
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
function perform(graph:GraphStorage,operation:StorageOperation):unknown {
  switch(operation.method) {
    case 'read':return graph.read(...operation.args);
    case 'readPrivate':return graph.readPrivate(...operation.args);
    case 'query':return graph.query(...operation.args);
    case 'related':return graph.related(...operation.args);
    case 'ingest':return graph.ingest(...operation.args);
    case 'containsLinks':return graph.containsLinks(...operation.args);
    case 'relationshipDigest':return graph.relationshipDigest(...operation.args);
    case 'evidencePropertiesDigest':return graph.evidencePropertiesDigest(...operation.args);
    case 'tombstone':return graph.tombstone(...operation.args);
  }
}

/** Run the existing synchronous graph API without changing its transaction
 * boundaries. A promise cannot silently pass through synchronous projection. */
export function runGraphProgram<T>(graph:SyncGraphStorage,program:GraphProgram<T>):T {
  let step=program.next();
  while(!step.done) {
    let value:unknown;
    try {
      const operation=step.value;
      value=operation.method==='integrity'?withIntegrity(()=>runGraphProgram(graph,operation.program)):perform(graph,operation);
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
      if(operation.method==='integrity') {
        const action=()=>runGraphProgramAsync(graph,operation.program);
        value=await(graph.withGraphIntegrity?graph.withGraphIntegrity(action):withIntegrity(action));
      }else value=await perform(graph,operation);
    }
    catch(error) {step=program.throw(error);continue;}
    step=program.next(value);
  }
  return step.value;
}
