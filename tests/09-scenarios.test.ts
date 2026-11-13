import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Objects } from '../packages/runtime/objects.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { Access } from '../packages/runtime/access.js';

const ref={type:'Route',id:'shared-route'};
test('scenario edits are isolated, queryable through Interfaces, and keep seeing untouched live updates',async()=>{
  const f=await fixture();
  try {
    const live=new Objects(f.db,f.model,f.access),scenarios=new Scenarios(f.db);
    await live.create(ref,{id:ref.id,name:'original'});
    const a=await scenarios.create(f.access,f.model,{requestId:'a',name:'Alternative A'}),b=await scenarios.create(f.access,f.model,{requestId:'b',name:'Alternative B'});
    const av=await scenarios.view(f.access,f.model,a.id),bv=await scenarios.view(f.access,f.model,b.id);
    const ag=new Objects(f.db,av,f.access),bg=new Objects(f.db,bv,f.access);
    await ag.edit(ref,1,{name:'proposal'});
    assert.equal((await live.read(ref)).properties.name,'original');assert.equal((await bg.read(ref)).properties.name,'original');
    assert.equal((await ag.query({type:'RideEstimatable',where:{name:'proposal'}})).items.length,1);
    await live.create({type:'Route',id:'arrived-later'},{id:'arrived-later',name:'live update'});
    assert.equal((await ag.read({type:'Route',id:'arrived-later'})).properties.name,'live update');
    const diff=await scenarios.inspect(f.access,f.model,a.id);assert.equal(diff.objects[0]!.conflict,false);
    assert.equal(diff.objects[0]!.before!.name,'original');assert.equal(diff.objects[0]!.after!.name,'proposal');
    const other=await Access.load(f.db,{owner:'other',scopes:principal.scopes});
    await assert.rejects(scenarios.view(other,f.model,a.id),/unavailable/);
  }finally{await f.close();}
});

test('scenario merge rejects changed live revisions and rolls back all changes atomically',async()=>{
 const f=await fixture();try{
  const s=new Scenarios(f.db),live=new Objects(f.db,f.model,f.access);await live.create(ref,{id:ref.id,name:'base'});
  const a=await s.create(f.access,f.model,{requestId:'conflict',name:'conflict'}),view=await s.view(f.access,f.model,a.id),g=new Objects(f.db,view,f.access);
  await g.edit(ref,1,{name:'draft'});await g.create({type:'Route',id:'new-route'},{id:'new-route',name:'new'});
  const before=await s.inspect(f.access,f.model,a.id);await live.edit(ref,1,{name:'concurrent'});
  assert.equal((await s.inspect(f.access,f.model,a.id)).objects.find(o=>o.ref.id===ref.id)!.conflict,true);
  await assert.rejects(f.db.transaction(c=>s.mergeInto(new Objects(f.db,f.model,f.access,c),a.id,Number(before.revision),{objects:['Route'],links:[]})),/conflicts/);
  await assert.rejects(live.read({type:'Route',id:'new-route'}));assert.equal((await live.read(ref)).properties.name,'concurrent');
  assert.equal((await s.inspect(f.access,f.model,a.id)).state,'open');
 }finally{await f.close();}
});

test('scenario relationship changes support reassignment and deletion without changing live Links',async()=>{
 const f=await fixture();try{
  const s=new Scenarios(f.db),live=new Objects(f.db,f.model,f.access);await live.create(ref,{id:ref.id,name:'route'});
  const request={type:'RideRequest',id:'request'};await live.create(request,{id:'request',name:'request',status:'requested',requestedAt:new Date().toISOString()});
  await live.link({type:'RequestRoute',from:request,to:ref});
  const a=await s.create(f.access,f.model,{requestId:'links',name:'links'}),view=await s.view(f.access,f.model,a.id),g=new Objects(f.db,view,f.access);
  const replacement={type:'Route',id:'replacement'};await g.create(replacement,{id:'replacement',name:'replacement'});
  await assert.rejects(g.link({type:'RequestRoute',from:request,to:replacement}),/cardinality/);
  await g.unlink({type:'RequestRoute',from:request,to:ref});await g.link({type:'RequestRoute',from:request,to:replacement});
  assert.equal((await g.follow(request,'route'))[0]!.ref.id,'replacement');assert.equal((await live.follow(request,'route'))[0]!.ref.id,ref.id);
  assert.equal((await g.query({type:'Route',from:{object:request,link:'route'}})).items[0]!.ref.id,'replacement');
  const d=await s.inspect(f.access,f.model,a.id);
  await f.db.transaction(c=>s.mergeInto(new Objects(f.db,f.model,f.access,c),a.id,Number(d.revision),{objects:['Route'],links:['RequestRoute']}));
  assert.equal((await live.follow(request,'route'))[0]!.ref.id,'replacement');await assert.rejects(g.read(ref),/closed/);
 }finally{await f.close();}
});

test('expired/discarded scenarios and external source Functions cannot write',async()=>{
 const f=await fixture();try{
  const s=new Scenarios(f.db),a=await s.create(f.access,f.model,{requestId:'expired',name:'expired'}),view=await s.view(f.access,f.model,a.id);
  await assert.rejects(f.capabilities.actions.apply(f.access,view,'EstimateRide',{city:'上海',origin:'a',destination:'b'},'no-source'),/external sources/);assert.equal(f.provider.calls.length,0);
  await f.db.query(`UPDATE ${f.db.schema}.scenarios SET expires_at=now()-interval '1 second' WHERE id=$1`,[a.id]);
  await assert.rejects(s.view(f.access,f.model,a.id),/expired/);
  const b=await s.create(f.access,f.model,{requestId:'discard',name:'discard'});await s.discard(f.access,f.model,b.id,1);await assert.rejects(s.view(f.access,f.model,b.id),/closed/);
 }finally{await f.close();}
});

test('deleting an object cannot silently delete relationships added after the proposal',async()=>{
 const f=await fixture();try{
  const live=new Objects(f.db,f.model,f.access),s=new Scenarios(f.db);await live.create(ref,{id:ref.id,name:'route'});
  const a=await s.create(f.access,f.model,{requestId:'delete',name:'delete'}),view=await s.view(f.access,f.model,a.id);
  await new Objects(f.db,view,f.access).remove(ref,1);const d=await s.inspect(f.access,f.model,a.id);
  const request={type:'RideRequest',id:'new-inquiry'};await live.create(request,{id:request.id,name:'inquiry',status:'requested',requestedAt:new Date().toISOString()});await live.link({type:'RequestRoute',from:request,to:ref});
  await assert.rejects(f.db.transaction(c=>s.mergeInto(new Objects(f.db,f.model,f.access,c),a.id,d.revision,{objects:['Route'],links:['RequestRoute']})),/relationships/);
  assert.equal((await live.follow(request,'route')).length,1);
 }finally{await f.close();}
});
