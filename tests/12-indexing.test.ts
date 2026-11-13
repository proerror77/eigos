import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Access, memberGrants, setGrants, type Permission } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { Indexing, initializeIndexing } from '../packages/runtime/indexing.js';
import { EditHistory, initializeEditHistory, setConflictPolicy } from '../packages/runtime/edit-history.js';
import { Materializations, initializeMaterializations } from '../packages/runtime/materializations.js';
import { upgradePublicationStorage } from '../packages/runtime/upgrade.js';

async function indexedFixture() {
  const f=await fixture();
  await initializeEditHistory(f.db);await initializeIndexing(f.db);await initializeMaterializations(f.db);
  const grants=[...memberGrants(f.model),{resource:'Eigos/datasource/DidiPlaces',permission:'ingest_source' as Permission}];
  await setGrants(f.db,principal.owner,grants);
  return {...f,access:await Access.load(f.db,principal),grants,indexing:new Indexing(f.db,f.metadata)};
}
const origin=new Date(Date.now()-60000).toISOString();
const later=new Date(Date.now()+60000).toISOString();
function sourceRow(id:string,name:string,observedAt=origin) {
  return {id,name,city:'上海',address:'上海',coordinates:{lat:31.2,lng:121.5},coordinateSystem:'GCJ-02',sourceBinding:'synthetic',observedAt};
}
const transaction=(offset:number,rows:Record<string,unknown>[],observedAt=origin)=>({source:'DidiPlaces',stream:'synthetic-stream',offset,mode:'stream',observedAt,rows});

test('upgrade preserves source observation ordering before the first refresh or deletion',async()=>{
  const f=await indexedFixture();try{
    const newer=new Date(Date.parse(origin)+10000).toISOString();
    for(const id of ['legacy-update','legacy-delete','legacy-edited']){
      await f.db.query(`INSERT INTO ${f.db.schema}.objects(projection,owner,type,id,properties) VALUES($1,$2,'Place',$3,$4)`,[f.model.projection,principal.owner,id,sourceRow(id,'Newer stored data',newer)]);
    }
    await upgradePublicationStorage(f.db);
    const graph=new Objects(f.db,f.model,f.access);
    await graph.edit({type:'Place',id:'legacy-edited'},1,{name:'User correction'});
    await f.indexing.submit(f.access,f.model,{...transaction(1,[sourceRow('legacy-update','Stale data'),sourceRow('legacy-edited','Stale data')]),deleted:['legacy-delete']});
    await f.indexing.runOne();
    assert.equal((await graph.read({type:'Place',id:'legacy-update'})).properties.name,'Newer stored data');
    assert.equal((await graph.read({type:'Place',id:'legacy-delete'})).properties.observedAt,newer);
    assert.equal((await graph.read({type:'Place',id:'legacy-edited'})).properties.name,'User correction');
    assert.equal((await graph.read({type:'Place',id:'legacy-edited'})).properties.observedAt,newer);
    await f.indexing.submit(f.access,f.model,{...transaction(2,[sourceRow('legacy-update','Fresh data',later)],later),deleted:['legacy-delete']});
    await f.indexing.runOne();
    assert.equal((await graph.read({type:'Place',id:'legacy-update'})).properties.name,'Fresh data');
    await assert.rejects(graph.read({type:'Place',id:'legacy-delete'}),/unavailable/);
  }finally{await f.close();}
});

test('exact source replay preserves its original publication after a mapping change',async()=>{
  const f=await indexedFixture();try{
    const input=transaction(1,[sourceRow('a','Original mapping')]);
    const original=await f.indexing.submit(f.access,f.model,input);await f.indexing.runOne();
    const document=structuredClone(f.model.document);
    document.dataSources.find(source=>source.apiName==='DidiPlaces')!.properties.name='displayName';
    const next=await f.metadata.publish(document,f.capabilities,f.publisher),access=await Access.load(f.db,principal);
    const replay=await f.indexing.submit(access,next,input);
    assert.equal(replay.id,original.id);assert.equal(replay.state,'applied');
    assert.equal((await f.indexing.inspect(access,next,replay.id)).release,f.model.release);
    await assert.rejects(f.indexing.submit(access,next,transaction(1,[{...sourceRow('a','Original mapping'),displayName:'Changed payload'}])),/another transaction/);
    const second=await f.indexing.submit(access,next,transaction(2,[{...sourceRow('b','Unused old field'),displayName:'New mapping'}]));
    assert.equal((await f.indexing.inspect(access,next,second.id)).release,next.release);
    await f.indexing.runOne();
    assert.equal((await new Objects(f.db,next,access).read({type:'Place',id:'b'})).properties.name,'New mapping');
  }finally{await f.close();}
});

test('index transactions enforce source grants, ordered offsets and exact retries',async()=>{
  const f=await indexedFixture();try{
    const input=transaction(1,[sourceRow('a','original')]);
    const second=await f.indexing.submit(f.access,f.model,transaction(2,[sourceRow('b','second')]));
    assert.equal(await f.indexing.runOne(),false);
    const first=await f.indexing.submit(f.access,f.model,input);
    assert.equal((await f.indexing.submit(f.access,f.model,input)).id,first.id);
    await assert.rejects(f.indexing.submit(f.access,f.model,transaction(1,[sourceRow('a','different')])),/another transaction/);
    assert.equal(await f.indexing.runOne(),true);assert.equal(await f.indexing.runOne(),true);assert.equal(await f.indexing.runOne(),false);
    assert.equal((await f.indexing.inspect(f.access,f.model,second.id)).applied_offset,'2');
    const graph=new Objects(f.db,f.model,f.access);assert.equal((await graph.query({type:'Place'})).items.length,2);
    await setGrants(f.db,principal.owner,memberGrants(f.model));
    await assert.rejects(f.indexing.submit(await Access.load(f.db,principal),f.model,transaction(3,[])),/Permission/);
  }finally{await f.close();}
});

test('failed indexing rolls back its objects and offset and resumes after permissions are restored',async()=>{
  const f=await indexedFixture();try{
    const job=await f.indexing.submit(f.access,f.model,transaction(1,[sourceRow('a','original')]));
    await setGrants(f.db,principal.owner,memberGrants(f.model));
    assert.equal(await f.indexing.runOne(),true);
    assert.equal((await f.db.query(`SELECT state FROM ${f.db.schema}.index_transactions WHERE id=$1`,[job.id])).rows[0]!.state,'failed');
    assert.equal((await new Objects(f.db,f.model,await Access.load(f.db,principal)).query({type:'Place'})).items.length,0);
    await setGrants(f.db,principal.owner,f.grants);const restored=await Access.load(f.db,principal);
    await f.indexing.retry(restored,f.model,job.id);assert.equal(await f.indexing.runOne(),true);
    const state=await f.indexing.inspect(restored,f.model,job.id);assert.equal(state.state,'applied');assert.equal(state.attempts,2);
  }finally{await f.close();}
});

test('an invalid later row rolls back earlier changes and concurrent workers apply an offset once',async()=>{
  const f=await indexedFixture();try{
    await f.indexing.submit(f.access,f.model,transaction(1,[sourceRow('b','Original')]));
    await Promise.all([f.indexing.runOne(),new Indexing(f.db,f.metadata).runOne()]);
    const second=await f.indexing.submit(f.access,f.model,transaction(2,[sourceRow('a','Must roll back'),sourceRow('b','Conflicting same timestamp')]));
    await f.indexing.runOne();
    const state=await f.indexing.inspect(f.access,f.model,second.id);
    assert.equal(state.state,'failed');assert.equal(state.applied_offset,'1');
    const graph=new Objects(f.db,f.model,f.access);
    await assert.rejects(graph.read({type:'Place',id:'a'}),/unavailable/);
    assert.equal((await graph.read({type:'Place',id:'b'})).revision,1);
    assert.equal((await graph.read({type:'Place',id:'b'})).properties.name,'Original');
  }finally{await f.close();}
});

test('canceling a pending or failed source transaction advances its offset without applying data',async()=>{
  const f=await indexedFixture();try{
    const first=await f.indexing.submit(f.access,f.model,transaction(1,[sourceRow('discarded','Discarded')]));
    const second=await f.indexing.submit(f.access,f.model,transaction(2,[sourceRow('kept','Kept')]));
    await f.indexing.cancel(f.access,f.model,first.id);await f.indexing.cancel(f.access,f.model,first.id);
    assert.equal(await f.indexing.runOne(),true);assert.equal(await f.indexing.runOne(),true);
    const graph=new Objects(f.db,f.model,f.access);
    await assert.rejects(graph.read({type:'Place',id:'discarded'}),/unavailable/);
    assert.equal((await graph.read({type:'Place',id:'kept'})).properties.name,'Kept');
    await assert.rejects(f.indexing.cancel(f.access,f.model,second.id),/Applied/);
    const third=await f.indexing.submit(f.access,f.model,transaction(3,[sourceRow('kept','Conflicting')]));
    await f.indexing.runOne();assert.equal((await f.indexing.inspect(f.access,f.model,third.id)).state,'failed');
    await f.indexing.cancel(f.access,f.model,third.id);await f.indexing.runOne();
    assert.equal((await f.indexing.inspect(f.access,f.model,third.id)).applied_offset,'3');
    const other=await Access.load(f.db,{owner:'another-producer',scopes:principal.scopes});
    await assert.rejects(f.indexing.cancel(other,f.model,first.id),/unavailable/);
    // The additive initializer also upgrades the first deployed constraint safely.
    await f.db.query(`ALTER TABLE ${f.db.schema}.index_transactions DROP CONSTRAINT index_transactions_state_check`);
    await initializeIndexing(f.db);
    assert.equal((await f.indexing.inspect(f.access,f.model,first.id)).state,'canceled');
  }finally{await f.close();}
});

test('source updates preserve edited fields, latest policy can replace them, and user deletion survives source refresh',async()=>{
  const f=await indexedFixture();try{
    const graph=new Objects(f.db,f.model,f.access),ref={type:'Place',id:'a'};
    await f.indexing.submit(f.access,f.model,transaction(1,[sourceRow('a','original')]));await f.indexing.runOne();
    let current=await graph.read(ref);await graph.edit(ref,current.revision,{name:'User name'});
    await f.indexing.submit(f.access,f.model,transaction(2,[sourceRow('a','Source update',later)],later));await f.indexing.runOne();
    assert.equal((await graph.read(ref)).properties.name,'User name');
    await setConflictPolicy(f.db,f.publisher,f.model,'Place','latest_value');
    await f.indexing.submit(f.access,f.model,transaction(3,[sourceRow('a','Source update',later)],later));await f.indexing.runOne();
    assert.equal((await graph.read(ref)).properties.name,'Source update');
    current=await graph.read(ref);await graph.remove(ref,current.revision);
    await f.indexing.submit(f.access,f.model,transaction(4,[sourceRow('a','Source update',later)],later));await f.indexing.runOne();
    await assert.rejects(graph.read(ref),/unavailable/);
    await graph.create(ref,sourceRow('a','Explicit recreation',later));
    assert.equal((await graph.read(ref)).properties.name,'Explicit recreation');
  }finally{await f.close();}
});

test('source deletion removes its object without creating a permanent user tombstone',async()=>{
  const f=await indexedFixture();try{
    const graph=new Objects(f.db,f.model,f.access),ref={type:'Place',id:'a'};
    await f.indexing.submit(f.access,f.model,transaction(1,[sourceRow('a','original')]));await f.indexing.runOne();
    await f.indexing.submit(f.access,f.model,{...transaction(2,[],later),deleted:['a']});await f.indexing.runOne();
    await assert.rejects(graph.read(ref),/unavailable/);
    const newest=new Date(Date.parse(later)+1000).toISOString();
    await f.indexing.submit(f.access,f.model,transaction(3,[sourceRow('a','reappeared',newest)],newest));await f.indexing.runOne();
    assert.equal((await graph.read(ref)).properties.name,'reappeared');
  }finally{await f.close();}
});

test('explicitly setting the existing value still establishes a user override',async()=>{
  const f=await indexedFixture();try{
    const graph=new Objects(f.db,f.model,f.access),ref={type:'Place',id:'unchanged-edit'};
    await f.indexing.submit(f.access,f.model,transaction(1,[sourceRow(ref.id,'Confirmed name')]));await f.indexing.runOne();
    const before=await graph.read(ref);
    await graph.edit(ref,before.revision,{name:'Confirmed name'});
    await f.indexing.submit(f.access,f.model,transaction(2,[sourceRow(ref.id,'New source name',later)],later));await f.indexing.runOne();
    assert.equal((await graph.read(ref)).properties.name,'Confirmed name');
    assert.equal((await new EditHistory(f.db).read(graph,ref)).items.filter(row=>row.operation==='edit').length,1);
  }finally{await f.close();}
});

test('materializations preserve captured values and links while history and exports recheck current property access',async()=>{
  const f=await indexedFixture();try{
    const graph=new Objects(f.db,f.model,f.access),ref={type:'Route',id:'route'},request={type:'RideRequest',id:'request'};
    await graph.create(ref,{id:ref.id,name:'Before'});
    await graph.create(request,{id:request.id,name:'Request',status:'requested',requestedAt:new Date().toISOString()});
    await graph.link({type:'RequestRoute',from:request,to:ref});
    const materializations=new Materializations(f.db),snapshot=await materializations.capture(f.access,f.model,{requestId:'snapshot',name:'Snapshot',types:['Route','RideRequest']});
    await graph.edit(ref,1,{name:'After'});
    const stored=await materializations.read(f.access,f.model,snapshot.id);
    assert.equal(stored.items.find(o=>o.ref.type==='Route')!.properties.name,'Before');
    assert.equal((await materializations.links(f.access,f.model,snapshot.id)).items.length,1);
    const history=await new EditHistory(f.db).read(graph,ref);
    assert.equal(history.items.at(-1)!.before!.name,'Before');assert.equal(history.items.at(-1)!.after!.name,'After');
    await f.db.query(`INSERT INTO ${f.db.schema}.property_security VALUES('Eigos','Route','name')`);
    const access=await Access.load(f.db,principal);
    assert.equal((await materializations.read(access,f.model,snapshot.id)).items.find(o=>o.ref.type==='Route')!.properties.name,null);
    assert.equal((await new EditHistory(f.db).read(new Objects(f.db,f.model,access),ref)).items.at(-1)!.before!.name,null);
  }finally{await f.close();}
});

test('materialization rechecks historical row policy even when the live row is visible',async()=>{
  const f=await indexedFixture();try{
    const graph=new Objects(f.db,f.model,f.access),ref={type:'Route',id:'classified'};
    await graph.create(ref,{id:ref.id,name:'Previous classification'});
    const materializations=new Materializations(f.db),snapshot=await materializations.capture(f.access,f.model,{requestId:'classification',name:'Classification',types:['Route']});
    await graph.edit(ref,1,{name:'Public'});
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies(ontology,type,policy) VALUES('Eigos','Route',$1)`,[{read:{all:[{op:'equals',property:'name',value:'Public'}],any:[]},properties:{}}]);
    const access=await Access.load(f.db,principal);
    assert.equal((await new Objects(f.db,f.model,access).read(ref)).properties.name,'Public');
    assert.equal((await materializations.read(access,f.model,snapshot.id)).items.length,0);
  }finally{await f.close();}
});

test('independent source objects retain their own markings within one ordered transaction',async()=>{
  const f=await indexedFixture();try{
    const body=structuredClone(f.model.document);
    body.objectTypes.find(t=>t.apiName==='Place')!.properties.marks={description:'Source security markings',schema:{type:'array',items:{type:'string'}},required:true};
    body.dataSources.find(s=>s.apiName==='DidiPlaces')!.properties.marks='marks';
    const model=await f.metadata.publish(body,f.capabilities,f.publisher);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','Place',$1)`,[{properties:{},markingsProperty:'marks'}]);
    await f.db.query(`INSERT INTO ${f.db.schema}.security_memberships VALUES($1,'marking','A'),($1,'marking','B')`,[principal.owner]);
    const access=await Access.load(f.db,principal);
    const submitted=await f.indexing.submit(access,model,transaction(1,[{...sourceRow('a','A'),marks:['A']},{...sourceRow('b','B'),marks:['B']}]));
    await f.indexing.runOne();
    assert.equal((await f.indexing.inspect(access,model,submitted.id)).state,'applied');
    const rows=(await new Objects(f.db,model,access).query({type:'Place'})).items;
    assert.deepEqual(rows.map(row=>row.properties.marks),[['A'],['B']]);
  }finally{await f.close();}
});
