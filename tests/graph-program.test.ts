import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {DomainError} from '../packages/core/domain.js';
import type {ObjectView} from '../packages/ontology/object-store.js';
import {graphRead,graphIngest,runGraphProgram,runGraphProgramAsync,type GraphProgram,type GraphStorage,type SyncGraphStorage} from '../packages/ontology/graph-program.js';

const owner='["synthetic","tenant","subject"]',ref={type:'Place',id:'synthetic'},at='2026-11-02T00:00:00Z';
const source={kind:'task' as const,id:'synthetic-task',observedAt:at};
function* upsert():GraphProgram<string> {
  let previous:ObjectView|undefined;
  try {previous=yield* graphRead(owner,ref);}
  catch(error){if(!(error instanceof DomainError) || error.code!=='NOT_FOUND')throw error;}
  yield* graphIngest(owner,{objects:[{ref,properties:{placeId:ref.id,name:'Synthetic place'},...(previous?{expectedRevision:previous.revision}:{})}]},source);
  return String((yield* graphRead(owner,ref)).properties.name);
}
function storage() {
  let row:ObjectView|undefined,writes=0;
  const calls:string[]=[];
  const unsupported=()=>{throw new Error('Unsupported fixture operation');};
  const graph:SyncGraphStorage={read:()=>{calls.push('read');if(!row)throw new DomainError('NOT_FOUND','Missing');return row;},
    ingest:(_owner,batch,provenance)=>{calls.push('write');writes++;row={ref,revision:(row?.revision??0)+1,createdAt:at,properties:batch.objects[0]!.properties,source:provenance};},
    readPrivate:unsupported,query:unsupported,related:unsupported,containsLinks:unsupported,relationshipDigest:unsupported,tombstone:unsupported};
  return {graph,calls,writes:()=>writes};
}

test('one projection program preserves synchronous behavior and awaits sequential asynchronous storage',async()=>{
  const sync=storage(),asyncStore=storage();
  const asynchronous:GraphStorage={...asyncStore.graph,
    read:async(...args)=>{await setImmediate();return asyncStore.graph.read(...args);},
    ingest:async(...args)=>{await setImmediate();asyncStore.graph.ingest(...args);}};
  assert.equal(runGraphProgram(sync.graph,upsert()),'Synthetic place');
  assert.equal(await runGraphProgramAsync(asynchronous,upsert()),'Synthetic place');
  assert.deepEqual(sync.calls,['read','write','read']);assert.deepEqual(asyncStore.calls,sync.calls);
  assert.equal(sync.writes(),1);assert.equal(asyncStore.writes(),1);
});

test('rejected asynchronous storage enters the program error handler without replaying a write',async()=>{
  const f=storage();let writes=0;
  const graph:GraphStorage={...f.graph,ingest:async()=>{writes++;throw new DomainError('CONFLICT','Version changed');}};
  function* program():GraphProgram<string> {
    try {yield* graphIngest(owner,{objects:[]},source);}
    catch(error){if(error instanceof DomainError && error.code==='CONFLICT')return 'version-conflict';throw error;}
    return 'unexpected';
  }
  assert.equal(await runGraphProgramAsync(graph,program()),'version-conflict');assert.equal(writes,1);
});

test('a synchronous projection cannot accidentally continue with a promise instead of graph data',()=>{
  const f=storage(),graph={...f.graph,read:async()=>undefined} as unknown as SyncGraphStorage;
  assert.throws(()=>runGraphProgram(graph,upsert()),/Synchronous graph program received asynchronous storage/);
  assert.equal(f.writes(),0);
});
