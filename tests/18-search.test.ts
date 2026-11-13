import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Objects } from '../packages/runtime/objects.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { ObjectSets } from '../packages/runtime/object-sets.js';
import { initializeSemantic, SemanticSearch } from '../packages/runtime/semantic.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import type { VersionedFunction } from '../packages/runtime/functions.js';
import type { DerivedExpression } from '../packages/ontology/schema.js';
import type { Predicate } from '../packages/runtime/query-filter.js';
import { objectPolicySchema } from '../packages/runtime/security.js';

const planFields=(id:string,duration:number)=>({id,name:'Planning '+id,start:'2026-11-20T01:00:00Z',end:'2026-11-20T03:00:00Z',timeZone:'Asia/Shanghai',durationMinutes:duration});
test('composed predicates, numeric ordering and nested paths paginate without leaking hidden values',async()=>{
  const f=await fixture();try{
    const graph=new Objects(f.db,f.model,f.access);
    await f.db.transaction(async client=>{
      const write=new Objects(f.db,f.model,f.access,client);
      for(let i=1;i<=105;i++)await write.create({type:'SchedulePlan',id:String(i)},planFields(String(i),i));
    });
    const filter:Predicate={op:'all',predicates:[{op:'gte',property:'durationMinutes',value:100},{op:'not',predicate:{op:'eq',property:'durationMinutes',value:103}}]};
    const first=await graph.query({type:'SchedulePlan',filter,orderBy:[{property:'durationMinutes',direction:'desc'}],limit:2});
    assert.deepEqual(first.items.map(item=>item.properties.durationMinutes),[105,104]);assert(first.cursor);
    const second=await graph.query({type:'SchedulePlan',filter,orderBy:[{property:'durationMinutes',direction:'desc'}],limit:2,cursor:first.cursor});
    assert.deepEqual(second.items.map(item=>item.properties.durationMinutes),[102,101]);
    await graph.create({type:'Place',id:'nested'},{id:'nested',name:'Central Railway Station',city:'Shanghai',address:'Main Street',coordinates:{lat:31,lng:121},coordinateSystem:'GCJ02',sourceBinding:'fixture',observedAt:new Date().toISOString()});
    assert.equal((await graph.query({type:'Location',filter:{op:'gt',property:'coordinates.lat',value:30}})).items.length,1);
    assert.equal((await graph.query({type:'Place',filter:{op:'text',property:'name',value:'CENTRAL railway'}})).items.length,1);
    assert.equal((await graph.query({type:'Place',filter:{op:'regex',property:'name',value:'^Central .* Station$'}})).items.length,1);
    await f.db.query(`INSERT INTO ${f.db.schema}.property_security VALUES('Eigos','Place','name')`);
    const hidden=new Objects(f.db,f.model,await Access.load(f.db,principal));
    for(const op of ['eq','contains','text','regex'] as const)assert.equal((await hidden.query({type:'Place',filter:{op,property:'name',value:'Central Railway Station'}})).items.length,0);
    assert.equal((await hidden.query({type:'Place',filter:{op:'eq',property:'name',value:null}})).items.length,1);
  }finally{await f.close();}
});

test('linked and arithmetic properties compute from authorized current data and Scenario views',async()=>{
  const f=await fixture();try{
    const document=structuredClone(f.model.document),resource=document.objectTypes.find(type=>type.apiName==='ScheduleResource')!,activity=document.objectTypes.find(type=>type.apiName==='ScheduledActivity')!;
    activity.properties.minutes={description:'Duration',schema:{type:'number'},required:true};
    const define=(name:string,derived:DerivedExpression)=>{resource.properties[name]={description:name,schema:{type:'number'},required:false,derived};};
    define('activityCount',{op:'linked',path:[{link:'activities'}],aggregate:'count'});
    define('totalMinutes',{op:'linked',path:[{link:'activities'}],aggregate:'sum',property:'minutes'});
    define('minimumMinutes',{op:'linked',path:[{link:'activities'}],aggregate:'min',property:'minutes'});
    define('maximumMinutes',{op:'linked',path:[{link:'activities'}],aggregate:'max',property:'minutes'});
    define('averageMinutes',{op:'linked',path:[{link:'activities'}],aggregate:'avg',property:'minutes'});
    define('doubleMinutes',{op:'multiply',left:{op:'property',property:'totalMinutes'},right:{op:'literal',value:2}});
    const model=await f.metadata.publish(document,f.capabilities,f.publisher),access=await Access.load(f.db,principal),graph=new Objects(f.db,model,access);
    const resourceRef={type:'ScheduleResource',id:'calendar'};await graph.create(resourceRef,{id:resourceRef.id,name:'Calendar'});
    for(const [id,minutes] of [['a',30],['b',60]] as const){
      const ref={type:'ScheduledActivity',id};await graph.create(ref,{id,name:id,start:'2026-11-20T01:00:00Z',end:'2026-11-20T02:00:00Z',minutes});
      await graph.link({type:'ActivityResource',from:ref,to:resourceRef});
    }
    const value=await graph.read(resourceRef);assert.equal(value.properties.activityCount,2);assert.equal(value.properties.totalMinutes,90);assert.equal(value.properties.doubleMinutes,180);assert.equal(value.properties.minimumMinutes,30);assert.equal(value.properties.maximumMinutes,60);assert.equal(value.properties.averageMinutes,45);
    assert.equal((await graph.query({type:'ScheduleResource',filter:{op:'gt',property:'doubleMinutes',value:100},orderBy:[{property:'totalMinutes',direction:'desc'}]})).items.length,1);
    const aggregate=await new ObjectSets(f.db).aggregate(access,model,{set:{op:'query',query:{type:'ScheduleResource'}},metrics:{total:{op:'sum',property:'totalMinutes'}}});
    assert.equal(aggregate.items[0]!.metrics.total,90);
    const scene=await new Scenarios(f.db).create(access,model,{requestId:'derived',name:'Alternative'}),view=await new Scenarios(f.db).view(access,model,scene.id);
    await new Objects(f.db,view,access).edit({type:'ScheduledActivity',id:'a'},1,{minutes:45});
    assert.equal((await new Objects(f.db,view,access).read(resourceRef)).properties.totalMinutes,105);
    assert.equal((await graph.read(resourceRef)).properties.totalMinutes,90);
    await assert.rejects(graph.edit(resourceRef,1,{totalMinutes:500}),/read-only/);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','ScheduledActivity',$1)`,[objectPolicySchema.parse({read:{all:[{op:'equals',property:'id',value:'a'}]}})]);
    const protectedGraph=new Objects(f.db,model,await Access.load(f.db,principal));
    assert.equal((await protectedGraph.read(resourceRef)).properties.activityCount,1);
    assert.equal((await protectedGraph.read(resourceRef)).properties.totalMinutes,30);
  }finally{await f.close();}
});

test('semantic search invokes the published embedding Function and filters permissions and stale vectors before topK',async()=>{
  const f=await fixture();try{
    await initializeSemantic(f.db);
    const calls:string[]=[];
    const embedding:VersionedFunction={definition:{apiName:'EmbedText',description:'Explicit synthetic embedding fixture',version:'fixture-v1',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},returns:{type:'array',items:{type:'number'},minItems:2,maxItems:2}},implementationId:'synthetic-semantic-fixture-v1',handler:async input=>{const text=String(input.text);calls.push(text);return /train|rail/.test(text)?[1,0]:[0,1];}};
    const capabilities=createCapabilities(f.db,f.source,{functions:[embedding]}),document=structuredClone(f.model.document);document.functionTypes.push(embedding.definition);
    const model=await f.metadata.publish(document,capabilities,f.publisher);await setGrants(f.db,principal.owner,memberGrants(model));
    const access=await Access.load(f.db,principal),graph=new Objects(f.db,model,access),semantic=new SemanticSearch(f.db,capabilities.functions);
    await semantic.configure(f.publisher,model,{name:'Routes',type:'Route',property:'name',embeddingFunction:'EmbedText',dimensions:2});
    await graph.create({type:'Route',id:'secret'},{id:'secret',name:'train station'});await graph.create({type:'Route',id:'public'},{id:'public',name:'road trip'});
    await semantic.index(access,model,{name:'Routes',objects:[{type:'Route',id:'secret'},{type:'Route',id:'public'}]});
    const first=await semantic.search(access,model,{name:'Routes',text:'rail',limit:1});assert.equal(first.items[0]!.object.ref.id,'secret');
    assert.deepEqual(calls,['train station','road trip','rail']);assert.equal(first.modelVersion,'fixture-v1');
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','Route',$1)`,[objectPolicySchema.parse({properties:{name:{all:[{op:'equals',property:'id',value:'public'}]}}})]);
    const reader=await Access.load(f.db,principal),filtered=await semantic.search(reader,model,{name:'Routes',text:'rail',limit:1});assert.equal(filtered.items[0]!.object.ref.id,'public');
    await new Objects(f.db,model,reader).edit({type:'Route',id:'public'},1,{name:'rail terminal'});
    assert.equal((await semantic.search(await Access.load(f.db,principal),model,{name:'Routes',text:'rail'})).items.length,0);
    await semantic.index(await Access.load(f.db,principal),model,{name:'Routes',objects:[{type:'Route',id:'public'}]});
    assert.equal((await semantic.search(await Access.load(f.db,principal),model,{name:'Routes',text:'rail'})).items[0]!.score,1);
    await new Objects(f.db,model,await Access.load(f.db,principal)).remove({type:'Route',id:'public'},2);
    assert.equal((await semantic.search(await Access.load(f.db,principal),model,{name:'Routes',text:'rail'})).items.length,0);
    await assert.rejects(semantic.configure(f.publisher,model,{name:'Routes',type:'Route',property:'name',embeddingFunction:'EmbedText',dimensions:3}),/immutable/);
  }finally{await f.close();}
});


test('regular expressions have a deadline and cannot block unrelated event loop work',async()=>{
  const f=await fixture();try{
    const graph=new Objects(f.db,f.model,f.access);
    await graph.create({type:'Route',id:'regex'},{id:'regex',name:'a'.repeat(4000)+'!'});
    let heartbeats=0;const timer=setInterval(()=>heartbeats++,20);
    try{await assert.rejects(graph.query({type:'Route',filter:{op:'regex',property:'name',value:'(a+)+$'}}),/deadline/);}
    finally{clearInterval(timer);}
    assert(heartbeats>5);
    await assert.rejects(graph.query({type:'Route',filter:{op:'regex',property:'name',value:'['}}),/Invalid regular/);
  }finally{await f.close();}
});

test('Struct paths use the declared fields for queries and set aggregation, including empty results', async () => {
  const f = await fixture();
  try {
    const graph = new Objects(f.db, f.model, f.access);
    await graph.create({ type: 'Place', id: 'struct-query' }, { id: 'struct-query', name: 'Station', city: 'Shanghai',
      address: 'Main Street', coordinates: { lat: 31, lng: 121 }, coordinateSystem: 'GCJ02', sourceBinding: 'fixture',
      observedAt: new Date().toISOString() });
    const invalid = 'coordinates.latt';
    for (const query of [
      { where: { [invalid]: null } },
      { filter: { op: 'eq', property: invalid, value: null } },
      { select: [invalid] },
      { orderBy: [{ property: invalid }] },
    ]) await assert.rejects(graph.query({ type: 'Location', ...query }), /Unknown property Location.coordinates.latt/);
    await assert.rejects(graph.query({ type: 'Place', where: { city: 'nowhere' }, select: [invalid] }), /Unknown property/);
    const places = await graph.query({ type: 'Location', select: ['coordinates.lat'] });
    assert.deepEqual(places.items[0]!.properties, { 'coordinates.lat': 31 });

    const sets = new ObjectSets(f.db);
    const set = { op: 'query', query: { type: 'Location', where: { city: 'nowhere' } } };
    await assert.rejects(sets.aggregate(f.access, f.model, { set, metrics: { n: { op: 'count', property: invalid } } }), /Unknown property/);
    await assert.rejects(sets.aggregate(f.access, f.model, { set, groupBy: [invalid], metrics: { n: { op: 'count' } } }), /Unknown property/);
    const result = await sets.aggregate(f.access, f.model, { set: { op: 'query', query: { type: 'Location' } },
      view: 'Location', groupBy: ['coordinates.lng'], metrics: { latitude: { op: 'sum', property: 'coordinates.lat' } } });
    assert.deepEqual(result.items, [{ group: { 'coordinates.lng': 121 }, metrics: { latitude: 31 } }]);
  } finally { await f.close(); }
});
