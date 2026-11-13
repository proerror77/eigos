import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Objects } from '../packages/runtime/objects.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { Access } from '../packages/runtime/access.js';
import { calendarAnswer } from './planning-fixture.js';

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

test('a proposed single-valued Link shadows a competing live Link while inspection and merge still detect the conflict', async () => {
  const f = await fixture();
  try {
    const live = new Objects(f.db, f.model, f.access), scenarios = new Scenarios(f.db);
    const request = { type: 'RideRequest', id: 'conflicting-request' };
    const unrelated = { type: 'RideRequest', id: 'unrelated-request' };
    const candidate = { type: 'Route', id: 'proposed-route' };
    const current = { type: 'Route', id: 'live-route' };
    for (const route of [candidate, current]) await live.create(route, { id: route.id, name: route.id });
    for (const ref of [request, unrelated]) {
      await live.create(ref, { id: ref.id, name: ref.id, status: 'requested', requestedAt: new Date().toISOString() });
    }
    const scenario = await scenarios.create(f.access, f.model, { requestId: 'link-conflict', name: 'Alternate route' });
    const view = await scenarios.view(f.access, f.model, scenario.id);
    const proposed = new Objects(f.db, view, f.access);
    const proposedLink = { type: 'RequestRoute', from: request, to: candidate };
    const liveLink = { ...proposedLink, to: current };
    await proposed.link(proposedLink);
    await live.link(liveLink);
    await live.link({ ...liveLink, from: unrelated });

    assert.deepEqual((await proposed.follow(request, 'route')).map(item => item.ref), [candidate]);
    const page = await proposed.query({ type: 'Route', from: { object: request, link: 'route' }, limit: 1 });
    assert.deepEqual(page.items.map(item => item.ref), [candidate]);
    assert.equal(page.cursor, undefined);
    assert.deepEqual((await proposed.follow(current, 'requests')).map(item => item.ref), [unrelated]);
    assert.deepEqual((await live.follow(request, 'route')).map(item => item.ref), [current]);

    const diff = await scenarios.inspect(f.access, f.model, scenario.id);
    assert.deepEqual(diff.links, [{ ...proposedLink, removed: false, conflict: true }]);
    const merge = (revision: number) => f.db.transaction(client =>
      scenarios.mergeInto(new Objects(f.db, f.model, f.access, client), scenario.id, revision, {
        objects: [], links: ['RequestRoute'],
      }),
    );
    await assert.rejects(merge(diff.revision), /cardinality/);
    assert.deepEqual((await live.follow(request, 'route')).map(item => item.ref), [current]);

    await proposed.unlink(liveLink);
    const resolved = await scenarios.inspect(f.access, f.model, scenario.id);
    assert(resolved.links.every(link => !link.conflict));
    await merge(resolved.revision);
    assert.deepEqual((await live.follow(request, 'route')).map(item => item.ref), [candidate]);
    assert.deepEqual((await live.follow(current, 'requests')).map(item => item.ref), [unrelated]);
  } finally { await f.close(); }
});

test('a proposed Link also shadows a competitor when only the reverse direction is single-valued', async () => {
  const f = await fixture();
  try {
    const model = f.model;
    const live = new Objects(f.db, model, f.access), scenarios = new Scenarios(f.db);
    const availability = { type: 'CalendarAvailability', id: 'shared-availability' };
    const candidate = { type: 'ScheduleResource', id: 'proposed-resource' };
    const current = { type: 'ScheduleResource', id: 'live-resource' };
    const { status: _status, ...calendar } = calendarAnswer();
    await live.create(availability, { id: availability.id, name: availability.id, ...calendar });
    for (const ref of [candidate, current]) {
      await live.create(ref, { id: ref.id, name: ref.id });
    }
    const scenario = await scenarios.create(f.access, model, { requestId: 'reverse-conflict', name: 'Alternate request' });
    const view = new Objects(f.db, await scenarios.view(f.access, model, scenario.id), f.access);
    await view.link({ type: 'ResourceAvailability', from: candidate, to: availability });
    await live.link({ type: 'ResourceAvailability', from: current, to: availability });

    assert.deepEqual((await view.follow(availability, 'resource')).map(item => item.ref), [candidate]);
    assert.deepEqual((await view.follow(current, 'availability')).map(item => item.ref), []);
    assert.deepEqual((await live.follow(availability, 'resource')).map(item => item.ref), [current]);
    assert.equal((await scenarios.inspect(f.access, model, scenario.id)).links[0]?.conflict, true);
  } finally { await f.close(); }
});

test('an unchanged Scenario Link leaves a later live reassignment visible', async () => {
  const f = await fixture();
  try {
    const live = new Objects(f.db, f.model, f.access), scenarios = new Scenarios(f.db);
    const request = { type: 'RideRequest', id: 'unchanged-request' };
    const original = { type: 'Route', id: 'original-route' };
    const replacement = { type: 'Route', id: 'replacement-route' };
    for (const ref of [original, replacement]) await live.create(ref, { id: ref.id, name: ref.id });
    await live.create(request, { id: request.id, name: request.id, status: 'requested', requestedAt: new Date().toISOString() });
    const edge = { type: 'RequestRoute', from: request, to: original };
    await live.link(edge);
    const scenario = await scenarios.create(f.access, f.model, { requestId: 'unchanged-link', name: 'Unchanged route' });
    const view = new Objects(f.db, await scenarios.view(f.access, f.model, scenario.id), f.access);
    await view.link(edge);
    await live.unlink(edge);
    await live.link({ ...edge, to: replacement });

    assert.deepEqual((await view.follow(request, 'route')).map(item => item.ref), [replacement]);
    assert.deepEqual((await scenarios.inspect(f.access, f.model, scenario.id)).links, []);
  } finally { await f.close(); }
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

test('a deleted and recreated live object cannot masquerade as the scenario baseline',async()=>{
 const f=await fixture();try{
  const live=new Objects(f.db,f.model,f.access),s=new Scenarios(f.db);await live.create(ref,{id:ref.id,name:'original'});
  const a=await s.create(f.access,f.model,{requestId:'recreated',name:'recreated'}),view=await s.view(f.access,f.model,a.id);
  await new Objects(f.db,view,f.access).edit(ref,1,{name:'stale proposal'});
  await live.remove(ref,1);await live.create(ref,{id:ref.id,name:'replacement'});
  assert.equal((await live.read(ref)).revision,1);
  const diff=await s.inspect(f.access,f.model,a.id);assert.equal(diff.objects[0]!.conflict,true);
  await assert.rejects(f.db.transaction(c=>s.mergeInto(new Objects(f.db,f.model,f.access,c),a.id,diff.revision,{objects:['Route'],links:[]})),/conflicts/);
  assert.equal((await live.read(ref)).properties.name,'replacement');
 }finally{await f.close();}
});
