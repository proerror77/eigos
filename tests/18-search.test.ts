import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Objects } from '../packages/runtime/objects.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { ObjectSets } from '../packages/runtime/object-sets.js';
import { enablePgvector, pgvectorNamespace } from '../packages/runtime/semantic-pgvector.js';
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
    const first=await semantic.search(access,model,{name:'Routes',text:'rail',limit:1});assert.equal(first.items[0]!.object.ref.id,'secret');assert.equal(first.backend,'jsonb');
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

test('registers immutable PDF or SOP editions and queries their content through object and field permissions', async () => {
  const f = await fixture();
  try {
    const graph = new Objects(f.db, f.model, f.access);
    const plan = { type: 'SchedulePlan', id: 'document-plan' };
    await graph.create(plan, planFields(plan.id, 30));
    const input = {
      plan, documentKey: 'safety-sop', edition: '1', name: 'Safety SOP', mediaType: 'application/pdf',
      sourceRef: 'records/runbook-1.pdf', contentSha256: 'a'.repeat(64), extractedText: 'Inspect the exit before opening.',
    };
    const act = (data: typeof input, key: string) =>
      f.capabilities.actions.apply(f.access, f.model, 'RegisterSchedulePlanDocument', data, key);
    const first = await act(input, 'attach-doc-v1');
    assert.deepEqual(await act(input, 'attach-doc-retry'), first);
    await assert.rejects(act({ ...input, extractedText: 'An unversioned change' }, 'reuse-doc-v1'), /different data/);
    const second = await act({ ...input, edition: '2', extractedText: 'Use the east exit and check the alarm.' }, 'attach-doc-v2');
    assert.notEqual(first.id, second.id);
    assert.equal((await graph.read(first)).properties.extractedText, input.extractedText);

    const query = { type: 'OperationalDocumentVersion', from: { object: plan, link: 'documents' },
      filter: { op: 'contains', property: 'extractedText', value: 'check the alarm' } as const };
    assert.deepEqual((await graph.query(query)).items.map(item => item.ref), [second]);
    const other = { owner: 'outside-docs', scopes: principal.scopes };
    await setGrants(f.db, other.owner, memberGrants(f.model));
    const outside = new Objects(f.db, f.model, await Access.load(f.db, other));
    await assert.rejects(outside.read(first), /unavailable/);
    assert.deepEqual((await outside.query({ type: 'OperationalDocumentVersion' })).items, []);

    await f.db.query(`INSERT INTO ${f.db.schema}.property_security VALUES ('Eigos', 'OperationalDocumentVersion', 'extractedText')`);
    const protectedGraph = new Objects(f.db, f.model, await Access.load(f.db, principal));
    assert.equal((await protectedGraph.read(second)).properties.extractedText, null);
    assert.deepEqual((await protectedGraph.query(query)).items, []);
  } finally { await f.close(); }
});

test('document chunks preserve Unicode offsets and version citations while inheriting the parent text grant', async () => {
  const f = await fixture();
  try {
    const embedding: VersionedFunction = {
      definition: { apiName: 'EmbedPassage', description: 'Local synthetic embedding', version: 'test',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        returns: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
      implementationId: 'synthetic-embed-passage', handler: async input => String(input.text).includes('alarm') ? [1, 0] : [0, 1],
    };
    const capabilities = createCapabilities(f.db, f.source, { functions: [embedding] }), definition = structuredClone(f.model.document);
    definition.functionTypes.push(embedding.definition);
    const model = await f.metadata.publish(definition, capabilities, f.publisher);
    await setGrants(f.db, principal.owner, memberGrants(model));
    const access = await Access.load(f.db, principal), graph = new Objects(f.db, model, access);
    const plan = { type: 'SchedulePlan', id: 'paged-document-plan' };
    await graph.create(plan, planFields(plan.id, 30));
    const prefix = '𠮷' + 'x'.repeat(1499), suffix = 'check alarm';
    const text = prefix + suffix, locations = [{ page: 2, paragraph: 4, startOffset: 1500, endOffset: 1511 }];
    const input = { plan, name: 'Page-aware SOP', documentKey: 'page-sop', edition: '2', mediaType: 'application/pdf',
      sourceRef: 'records/pages.pdf', contentSha256: 'c'.repeat(64), extractedText: text, locationRanges: locations };
    const version = await capabilities.actions.apply(access, model, 'RegisterSchedulePlanDocument', input, 'paged-document');
    assert.deepEqual(await capabilities.actions.apply(access, model, 'RegisterSchedulePlanDocument', input, 'repeat-doc'), version);
    await assert.rejects(capabilities.actions.apply(access, model, 'RegisterSchedulePlanDocument',
      { ...input, edition: '3', locationRanges: [{ startOffset: 0, endOffset: 999999 }] }, 'invalid-page'), /inside the extracted text/);
    const chunks = (await graph.follow(version, 'chunks')).sort((a, b) => Number(a.properties.index) - Number(b.properties.index));
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.properties.text, prefix);
    assert.equal(chunks[0]!.properties.page, undefined);
    assert.deepEqual([chunks[1]!.properties.text, chunks[1]!.properties.startOffset, chunks[1]!.properties.endOffset, chunks[1]!.properties.page],
      [suffix, 1500, 1511, 2]);
    const semantic = new SemanticSearch(f.db, capabilities.functions);
    await semantic.configure(f.publisher, model, { name: 'Passages', type: 'OperationalDocumentChunk', property: 'text', embeddingFunction: 'EmbedPassage', dimensions: 2 });
    await semantic.index(access, model, { name: 'Passages', objects: chunks.map(item => item.ref) });
    const result = await semantic.search(access, model, { name: 'Passages', text: 'alarm', limit: 1,
      from: { object: plan, link: 'documents' } });
    assert.deepEqual(result.items[0]!.citation, { version, chunk: chunks[1]!.ref,
      index: 1, startOffset: 1500, endOffset: 1511, page: 2, paragraph: 4 });

    await f.db.query(`INSERT INTO ${f.db.schema}.property_security VALUES ('Eigos','OperationalDocumentVersion','extractedText')`);
    const restricted = await Access.load(f.db, principal), hidden = new Objects(f.db, model, restricted);
    await assert.rejects(hidden.read(chunks[1]!.ref), /unavailable/);
    assert.deepEqual(await hidden.follow(version, 'chunks'), []);
    assert.deepEqual((await hidden.query({ type: 'OperationalDocumentChunk', filter: { op: 'contains', property: 'text', value: 'alarm' } })).items, []);
    assert.deepEqual((await semantic.search(restricted, model, { name: 'Passages', text: 'alarm' })).items, []);
  } finally { await f.close(); }
});

const vectorTest = { skip: process.env.EIGOS_TEST_PGVECTOR !== 'true' };

async function vectorFixture() {
  const f = await fixture();
  try {
    const embedding: VersionedFunction = {
      definition: { apiName: 'EmbedExactTest', description: 'Synthetic semantic model', version: '1',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        returns: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
      implementationId: 'pgvector-test-fixture',
      handler: input => String(input.text).includes('north') ? [1, 0] : [0, 1],
    };
    const capabilities = createCapabilities(f.db, f.source, { functions: [embedding] }), definition = structuredClone(f.model.document);
    definition.functionTypes.push(embedding.definition);
    const model = await f.metadata.publish(definition, capabilities, f.publisher);
    await setGrants(f.db, principal.owner, memberGrants(model));
    const access = await Access.load(f.db, principal);
    return { ...f, capabilities, model, access, graph: new Objects(f.db, model, access),
      semantic: new SemanticSearch(f.db, capabilities.functions), embeddingFunction: embedding.definition.apiName };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test('pgvector opt-in is atomic and ranks only fresh, same-owner vectors in the selected view', vectorTest, async () => {
  const f = await vectorFixture();
  try {
    const { db, model, semantic, graph, embeddingFunction } = f, name = 'RouteVectors';
    await semantic.configure(f.publisher, model, { name, type: 'Route', property: 'name', embeddingFunction, dimensions: 2 });
    const first = { type: 'Route', id: 'north-one' }, second = { type: 'Route', id: 'north-two' };
    await graph.create(first, { id: first.id, name: 'north avenue' });
    await graph.create(second, { id: second.id, name: 'north path' });
    await semantic.index(f.access, model, { name, objects: [first, second] });
    const search = { name, text: 'north' };
    const baseline = await semantic.search(f.access, model, search);
    assert.equal(baseline.backend, 'jsonb');

    // An invalid legacy vector must fail the whole conversion and leave JSONB data in place.
    const invalid = `UPDATE ${db.schema}.semantic_vectors SET vector='[0,0]' WHERE id=$1`;
    await db.query(invalid, [first.id]);
    await assert.rejects(enablePgvector(db), /check constraint/);
    assert.equal(await pgvectorNamespace(db, db.pool), undefined);
    assert.equal((await db.query(`SELECT vector FROM ${db.schema}.semantic_vectors WHERE id=$1`, [first.id])).rows[0]!.vector[0], 0);
    await semantic.index(f.access, model, { name, objects: [first] });

    // A pre-installed extension may live outside the application schema and search path.
    await db.query(`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA ${db.schema}`);
    const enabled = await enablePgvector(db);
    assert.equal(enabled.backend, 'pgvector');
    assert.deepEqual(await enablePgvector(db), enabled);

    // Same type, ID, text digest, revision and embedding binding, different owner.
    const other = { owner: 'other-vector-owner', scopes: principal.scopes };
    await setGrants(db, other.owner, memberGrants(model));
    const otherAccess = await Access.load(db, other);
    await new Objects(db, model, otherAccess).create(first, { id: first.id, name: 'north avenue' });
    await semantic.index(otherAccess, model, { name, objects: [first] });
    const current = await semantic.search(f.access, model, search);
    assert.equal(current.backend, 'pgvector');
    assert.deepEqual(current.items, baseline.items);
    assert.equal((await semantic.status(f.access, model, name)).currentAuthorizedObjects, 2);
    assert.equal((await semantic.status(otherAccess, model, name)).currentAuthorizedObjects, 1);

    const scenarios = new Scenarios(db);
    const scene = await scenarios.create(f.access, model, { requestId: 'vectors-draft', name: 'Draft' });
    const proposed = await scenarios.view(f.access, model, scene.id);
    await new Objects(db, proposed, f.access).edit(first, 1, { name: 'south draft' });
    const draft = await semantic.search(f.access, proposed, search);
    assert.deepEqual(draft.items.map(item => item.object.ref), [second]);
    assert.equal((await semantic.status(f.access, proposed, name)).currentAuthorizedObjects, 1);
    assert.equal((await semantic.search(f.access, model, search)).items.length, 2);

    await graph.edit(first, 1, { name: 'south avenue' });
    assert.deepEqual((await semantic.search(f.access, model, search)).items.map(item => item.object.ref), [second]);
    await semantic.index(f.access, model, { name, objects: [first] });
    assert.deepEqual((await semantic.search(f.access, model, search)).items.map(item => [item.object.ref.id, item.score]),
      [[second.id, 1], [first.id, 0]]);

    // A different binding or source text may not score even if the object identity still matches.
    await db.query(`UPDATE ${db.schema}.semantic_vectors SET binding='retired' WHERE owner=$1 AND id=$2`, [principal.owner, second.id]);
    assert.equal((await semantic.status(f.access, model, name)).currentAuthorizedObjects, 1);
    await db.query(`UPDATE ${db.schema}.objects SET properties=jsonb_set(properties,'{name}','"new text"')
      WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [model.projection, principal.owner, first.type, first.id]);
    assert.deepEqual((await semantic.search(f.access, model, search)).items, []);
  } finally { await f.close(); }
});

test('pgvector applies document parent and model permissions before ranking and preserves exact Object references', vectorTest, async () => {
  const f = await vectorFixture();
  try {
    const { db, model, graph, semantic, embeddingFunction } = f, name = 'DocumentVectors';
    const plan = { type: 'SchedulePlan', id: 'sop-plan-vector' };
    const otherPlan = { type: 'SchedulePlan', id: 'unrelated-plan-vector' };
    await graph.create(plan, planFields(plan.id, 30));
    await graph.create(otherPlan, planFields(otherPlan.id, 30));
    async function register(key: string, text: string, subject = plan) {
      const version = await f.capabilities.actions.apply(f.access, model, 'RegisterSchedulePlanDocument', {
        plan: subject, name: key, documentKey: key, edition: '1', mediaType: 'application/pdf',
        sourceRef: 'records/sop', contentSha256: 'd'.repeat(64), extractedText: text,
        locationRanges: [{ startOffset: 0, endOffset: text.length, page: 4 }],
      }, key);
      const [chunk] = await graph.follow(version, 'chunks');
      return { version, chunk: chunk!.ref };
    }
    const restricted = await register('restricted-sop', 'north delivery terms');
    const ordinary = await register('ordinary-sop', 'south delivery route');
    const unrelated = await register('unrelated-sop', 'north unrelated route', otherPlan);
    const linked = await graph.follow(plan, 'documents');
    assert.equal(linked.length, 2);
    assert(linked.some(item => item.ref.id === ordinary.version.id));
    assert.deepEqual((await graph.follow(ordinary.chunk, 'version'))[0]!.ref, ordinary.version);
    await semantic.configure(f.publisher, model, { name, type: 'OperationalDocumentChunk', property: 'text', embeddingFunction, dimensions: 2 });
    await semantic.index(f.access, model, { name, objects: [restricted.chunk, ordinary.chunk, unrelated.chunk] });
    await enablePgvector(db);

    // Change the parent policy without touching chunk revisions or vectors.
    await db.query(`UPDATE ${db.schema}.objects SET properties=jsonb_set(properties,'{classification}',$5::jsonb)
      WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [
      model.projection, principal.owner, restricted.version.type, restricted.version.id,
      { sensitivity: 'CONFIDENTIAL', compartments: ['SUPPLIER_RATE'] },
    ]);
    const search = { name, text: 'north', limit: 1 }, from = { object: plan, link: 'documents' };
    const read = async (clearance: Parameters<Access['measureEgress']>[1], scoped = true) => {
      const reader = await Access.load(db, principal);
      return (await reader.measureEgress(() => semantic.search(reader, model, scoped ? { ...search, from } : search), clearance)).result;
    };
    assert.deepEqual((await read({ sensitivity: 'CONFIDENTIAL', compartments: [] }, false)).items[0]!.object.ref, unrelated.chunk);
    const missingCompartment = await read({ sensitivity: 'CONFIDENTIAL', compartments: [] });
    assert.equal(missingCompartment.backend, 'pgvector');
    assert.deepEqual(missingCompartment.items[0]!.citation, {
      version: ordinary.version, chunk: ordinary.chunk, index: 0, startOffset: 0, endOffset: 20, page: 4,
    });
    const approved = await read({ sensitivity: 'CONFIDENTIAL', compartments: ['SUPPLIER_RATE'] });
    assert.deepEqual(approved.items[0]!.object.ref, restricted.chunk);
    assert.equal(approved.items[0]!.score, 1);

    await db.query(`INSERT INTO ${db.schema}.property_security VALUES('Eigos','OperationalDocumentVersion','extractedText')`);
    assert.deepEqual((await read({ sensitivity: 'RESTRICTED', compartments: ['SUPPLIER_RATE'] })).items, []);
    assert.equal((await semantic.status(await Access.load(db, principal), model, name)).currentAuthorizedObjects, 0);
  } finally { await f.close(); }
});

async function publicationSearchFixture() {
  const f=await fixture();
  try {
    const embedding:VersionedFunction={definition:{apiName:'PublicationEmbedding',description:'Synthetic publication embedding',version:'1',
      parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
      returns:{type:'array',items:{type:'number'},minItems:2,maxItems:2}},
      implementationId:'synthetic-publication-embedding-v1',handler:async()=>[1,0]};
    const capabilities=createCapabilities(f.db,f.source,{functions:[embedding]});
    const document=structuredClone(f.model.document);document.functionTypes.push(embedding.definition);
    const model=await f.metadata.publish(document,capabilities,f.publisher);
    await setGrants(f.db,principal.owner,memberGrants(model));
    const access=await Access.load(f.db,principal),graph=new Objects(f.db,model,access);
    const semantic=new SemanticSearch(f.db,capabilities.functions),ref={type:'Route',id:'publication-route'};
    await graph.create(ref,{id:ref.id,name:'Original searchable route'});
    await semantic.configure(f.publisher,model,{name:'Routes',type:'Route',property:'name',embeddingFunction:embedding.definition.apiName,dimensions:2});
    await semantic.index(access,model,{name:'Routes',objects:[ref]});
    if(process.env.EIGOS_TEST_PGVECTOR==='true')await enablePgvector(f.db);
    return {...f,model,document,capabilities,embedding,access,graph,semantic,ref};
  }catch(error){await f.close();throw error;}
}

test('unchanged publications retain semantic indexes and vectors without sharing owners or bypassing current permissions',async()=>{
  const f=await publicationSearchFixture();try{
    await setGrants(f.db,'semantic-peer',memberGrants(f.model));
    const peer=await Access.load(f.db,{...principal,owner:'semantic-peer'});
    await new Objects(f.db,f.model,peer).create(f.ref,{id:f.ref.id,name:'Private peer route'});
    await f.semantic.index(peer,f.model,{name:'Routes',objects:[f.ref]});
    const next=await f.metadata.publish(f.document,f.capabilities,f.publisher);
    assert.equal(next.digest,f.model.digest);assert.notEqual(next.release,f.model.release);
    assert.equal(await f.metadata.fingerprint(next.projection),await f.metadata.fingerprint(f.model.projection));
    const search=await f.semantic.search(f.access,next,{name:'Routes',text:'route'});
    assert.equal(search.items.length,1);assert.equal(search.items[0]!.object.properties.name,'Original searchable route');
    assert.equal(search.backend,process.env.EIGOS_TEST_PGVECTOR==='true'?'pgvector':'jsonb');
    assert.equal((await f.semantic.search(peer,next,{name:'Routes',text:'route'})).items[0]!.object.properties.name,'Private peer route');
    await f.db.query(`INSERT INTO ${f.db.schema}.property_security VALUES('Eigos','Route','name')`);
    assert.equal((await f.semantic.search(await Access.load(f.db,principal),next,{name:'Routes',text:'route'})).items.length,0);
  }finally{await f.close();}
});

test('semantic configuration and vector changes invalidate prepared publications and catch-up carries the latest index state',async()=>{
  const f=await publicationSearchFixture();try{
    const candidate=await f.metadata.prepare(f.document,f.capabilities,f.publisher);
    await f.semantic.configure(f.publisher,f.model,{name:'Second',type:'Route',property:'name',embeddingFunction:f.embedding.definition.apiName,dimensions:2});
    await assert.rejects(f.metadata.activate(candidate.release,f.capabilities,f.publisher),/Source data changed/);
    await f.metadata.catchUp(candidate.release,f.capabilities,f.publisher);
    await f.semantic.index(f.access,f.model,{name:'Second',objects:[f.ref]});
    await assert.rejects(f.metadata.activate(candidate.release,f.capabilities,f.publisher),/Source data changed/);
    await f.metadata.catchUp(candidate.release,f.capabilities,f.publisher);
    await f.metadata.activate(candidate.release,f.capabilities,f.publisher);
    assert.equal((await f.semantic.search(f.access,candidate,{name:'Second',text:'route'})).items.length,1);
    const tampered=await f.metadata.prepare(f.document,f.capabilities,f.publisher);
    await f.db.query(`UPDATE ${f.db.schema}.semantic_vectors SET vector='[0,1]'::jsonb WHERE release=$1`,[tampered.release]);
    await assert.rejects(f.metadata.activate(tampered.release,f.capabilities,f.publisher),/Prepared projection changed/);
  }finally{await f.close();}
});

test('semantic publication rejects incompatible models and never reuses vectors for transformed text',async()=>{
  const f=await publicationSearchFixture();try{
    const incompatible=structuredClone(f.document);
    const v2={...f.embedding,definition:{...f.embedding.definition,version:'2'},implementationId:'synthetic-publication-embedding-v2'};
    incompatible.functionTypes=incompatible.functionTypes.map(fn=>fn.apiName===v2.definition.apiName?v2.definition:fn);
    const capabilities=createCapabilities(f.db,f.source,{functions:[f.embedding,v2]});
    await assert.rejects(f.metadata.prepare(incompatible,capabilities,f.publisher),/Semantic index Routes requires/);
    assert.equal((await f.metadata.active()).release,f.model.release);
    const changed=await f.metadata.publish(f.document,f.capabilities,f.publisher,(ref,properties)=>
      ref.type==='Route'?{...properties,name:'Changed searchable text'}:properties);
    assert.equal((await f.semantic.status(f.access,changed,'Routes')).currentAuthorizedObjects,0);
    assert.equal((await f.semantic.search(f.access,changed,{name:'Routes',text:'route'})).items.length,0);
    await f.semantic.index(f.access,changed,{name:'Routes',objects:[f.ref]});
    assert.equal((await f.semantic.search(f.access,changed,{name:'Routes',text:'route'})).items[0]!.object.properties.name,'Changed searchable text');
  }finally{await f.close();}
});
