import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Governance, initializeGovernance } from '../packages/runtime/governance.js';
import { Effects, initializeEffects } from '../packages/runtime/effects.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { Actions } from '../packages/runtime/actions.js';
import { Functions } from '../packages/runtime/functions.js';
import { Objects } from '../packages/runtime/objects.js';
import { PublishedOntology } from '../packages/runtime/metadata.js';
import type { OntologyDocument } from '../packages/ontology/schema.js';

const reviewInput = (value: {id:string;revision:number;release:string|null}) => ({id:value.id,revision:value.revision,release:value.release});
const revisionInput = (value: {id:string;revision:number}) => ({id:value.id,revision:value.revision});

async function setup() {
  const f = await fixture();
  await initializeGovernance(f.db); await initializeEffects(f.db);
  return { ...f, governance: new Governance(f.db,f.metadata,f.capabilities) };
}
test('review binds the candidate data and catch-up preserves projection while invalidating approval', async () => {
  const f=await setup();
  try {
    const graph=new Objects(f.db,f.model,f.access), ref={type:'Route',id:'catch-up'};
    await graph.create(ref,{id:ref.id,name:'before'});
    const doc=structuredClone(f.model.document);doc.version='reviewed-version';
    const branch=await f.governance.create(f.publisher,{ontology:'Eigos',name:'Candidate',body:doc});
    const submitted=await f.governance.prepare(f.publisher,{id:branch.id,revision:branch.revision});
    const candidate=await f.metadata.get(submitted.release);
    const approved=await f.governance.review(f.publisher,reviewInput(submitted));
    await graph.edit(ref,1,{name:'after'});
    await assert.rejects(f.governance.merge(f.publisher,reviewInput(approved)),/Source data changed/);
    const caughtUp=await f.governance.catchUp(f.publisher,revisionInput(approved));
    assert.equal(caughtUp.projection,candidate.projection);
    assert.equal(caughtUp.objectsUpdated,1);
    assert.equal((await new Objects(f.db,candidate,f.access).read(ref)).properties.name,'after');
    await assert.rejects(f.governance.merge(f.publisher,reviewInput(approved)),/exact approved/);
    const reviewed=await f.governance.review(f.publisher,reviewInput(caughtUp));
    await f.governance.merge(f.publisher,reviewInput(reviewed));
    assert.equal((await f.metadata.active()).release,candidate.release);
    assert.equal((await f.governance.read(f.publisher,branch.id)).state,'merged');
  } finally { await f.close(); }
});
test('project editors are limited to assigned resources and cannot approve or activate',async()=>{
  const f=await setup();try{
    await f.governance.project(f.publisher,{ontology:'Eigos',id:'Travel',name:'Travel'});
    await f.governance.assign(f.publisher,{ontology:'Eigos',project:'Travel',resources:['Eigos/object/Route']});
    await setGrants(f.db,'editor',[{resource:'Eigos',permission:'view_definition'},{resource:'Eigos/project/Travel',permission:'edit_definition'}]);
    const editor=await Access.load(f.db,{owner:'editor',scopes:[]});
    const doc=structuredClone(f.model.document);doc.objectTypes.find(t=>t.apiName==='Route')!.description='Reviewed travel route';
    const branch=await f.governance.create(editor,{ontology:'Eigos',project:'Travel',name:'Travel edit',body:doc});
    const submitted=await f.governance.prepare(editor,{id:branch.id,revision:branch.revision});
    await assert.rejects(f.governance.review(editor,reviewInput(submitted)),/Permission/);
    await assert.rejects(f.metadata.activate(submitted.release,f.capabilities,editor),/Permission/);
    const invalid=structuredClone(doc);invalid.objectTypes.find(t=>t.apiName==='Place')!.description='Outside project';
    await assert.rejects(f.governance.update(editor,{id:branch.id,revision:submitted.revision,body:invalid}),/exceed/);
    await assert.rejects(new Objects(f.db,f.model,editor).read({type:'Route',id:'any'}),/Permission/);
  }finally{await f.close();}
});
test('branch rebase combines disjoint changes and detects edits to the same resource',async()=>{
  const f=await setup();try{
    const draft=structuredClone(f.model.document);draft.objectTypes.find(t=>t.apiName==='Route')!.description='Draft route';
    const branch=await f.governance.create(f.publisher,{ontology:'Eigos',name:'Rebase',body:draft});
    const live=structuredClone(f.model.document);live.objectTypes.find(t=>t.apiName==='Place')!.description='New place';
    await f.metadata.publish(live,f.capabilities,f.publisher);
    await assert.rejects(f.governance.prepare(f.publisher,{id:branch.id,revision:1}),/rebase/);
    const result=await f.governance.rebase(f.publisher,{id:branch.id,revision:1});
    const rebased=await f.governance.read(f.publisher,result.id);
    assert.equal(rebased.body.objectTypes.find(t=>t.apiName==='Route')!.description,'Draft route');
    assert.equal(rebased.body.objectTypes.find(t=>t.apiName==='Place')!.description,'New place');
    live.objectTypes.find(t=>t.apiName==='Route')!.description='Conflicting route';
    await f.metadata.publish(live,f.capabilities,f.publisher);
    await assert.rejects(f.governance.rebase(f.publisher,{id:branch.id,revision:result.revision}),/rebase conflict/);
  }finally{await f.close();}
});
test('registered Function versions remain selectable and bind to immutable implementation identities',async()=>{
  const f=await fixture();try{
    const definition={apiName:'Rate',description:'Versioned calculation',parameters:{type:'object',properties:{},additionalProperties:false},returns:{type:'number'},version:'1'};
    const versions=[{definition,implementationId:'rate-build-1',handler:()=>1},{definition:{...definition,version:'2'},implementationId:'rate-build-2',handler:()=>2}];
    const functions=new Functions(new Map(),[],versions);
    const body={id:'Eigos',version:'rate',objectTypes:[],interfaceTypes:[],linkTypes:[],actionTypes:[],dataSources:[],functionTypes:[definition]};
    const bindings={describe:(model:Parameters<Functions['bindings']>[0])=>({functions:functions.bindings(model),sources:{}})};
    const one=await f.metadata.publish(body,bindings,f.publisher);
    await setGrants(f.db,principal.owner,memberGrants(one));await f.access.refresh();
    const two=await f.metadata.publish({...body,functionTypes:[{...definition,version:'2'}]},bindings,f.publisher);
    const read=(model:PublishedOntology)=>functions.invoke(model,'Rate',{}, {principal,objects:new Objects(f.db,model,f.access),signal:AbortSignal.timeout(5000)});
    assert.equal(await read(one),1);assert.equal(await read(two),2);
    const historical=new PublishedOntology(one.document,one.release,one.projection,'previous-runtime',one.bindings);
    assert.equal(await read(historical),1);
    const incompatible=new Functions(new Map(),[],[{...versions[0]!,implementationId:'changed-build'}]);
    await assert.rejects(incompatible.invoke(one,'Rate',{}, {principal,objects:new Objects(f.db,one,f.access),signal:AbortSignal.timeout(5000)}),/implementation/);
  }finally{await f.close();}
});
test('Action effects commit atomically, dispatch once on retry, and recheck authorization',async()=>{
  const f=await setup();try{
    const body=structuredClone(f.model.document);
    const action:OntologyDocument['actionTypes'][number]={apiName:'CreateRouteWithEffect',description:'Create route and queue a named notification',parameters:{type:'object',properties:{id:{type:'string'},name:{type:'string'}},required:['id','name'],additionalProperties:false},objectParameters:{},submissionCriteria:[],rules:[{op:'createObject',object:{type:'Route',id:{parameter:'id'}},properties:{id:{parameter:'id'},name:{parameter:'name'}}}],result:{type:'Route',id:{parameter:'id'}},effects:[{name:'Created',handler:'Record',payload:{id:{parameter:'id'}}}]};
    body.actionTypes.push(action);
    const delivered=new Set<string>(), calls:string[]=[];
    const handlers=new Map<string,import('../packages/runtime/effects.js').EffectHandler>([['Record',async(_payload,context)=>{calls.push(context.idempotencyKey);delivered.add(context.idempotencyKey);}]]);
    await assert.rejects(f.metadata.prepare(body,f.capabilities,f.publisher),/handler is unavailable/);
    const capabilities=createCapabilities(f.db,f.source,{effects:handlers});
    const model=await f.metadata.publish(body,capabilities,f.publisher);
    await setGrants(f.db,principal.owner,memberGrants(model));await f.access.refresh();
    const effects=new Effects(f.db,handlers);
    const actions=new Actions(f.db,f.capabilities.functions,effects);
    let guards=0;
    await assert.rejects(actions.apply(f.access,model,action.apiName,{id:'rollback',name:'Rollback'},'rollback',async()=>{if(++guards===2)throw Error('cancel');}));
    assert.equal((await effects.status(f.access,'rollback')).length,0);
    const input={id:'created',name:'Created'};
    await actions.apply(f.access,model,action.apiName,input,'created');await actions.apply(f.access,model,action.apiName,input,'created');
    assert.equal(calls.length,0);assert.equal((await effects.status(f.access,'created')).length,1);
    await effects.runOne();assert.equal(delivered.size,1);assert.equal(await effects.runOne(),false);
    await actions.apply(f.access,model,action.apiName,{id:'revoked',name:'Revoked'},'revoked');
    await setGrants(f.db,principal.owner,memberGrants(model).filter(g=>g.resource!=='Eigos/action/'+action.apiName));
    await effects.runOne();assert.equal(calls.length,1);
    assert.equal((await f.db.query(`SELECT state FROM ${f.db.schema}.action_effects WHERE request_id='revoked'`)).rows[0]!.state,'failed');
  }finally{await f.close();}
});
test('failed deliveries retain a stable idempotency key across explicit retries',async()=>{
  const f=await setup();try{
    const keys:string[]=[];
    const effects=new Effects(f.db,new Map([['Flaky',async(_payload,context)=>{keys.push(context.idempotencyKey);if(keys.length===1)throw Error('connection closed');}]]));
    await f.db.transaction(client=>effects.enqueue(client,f.access,f.model,'EstimateRide','flaky',[{name:'Notice',handler:'Flaky',payload:{}}]));
    await effects.runOne();
    const failed=(await effects.status(f.access,'flaky'))[0]!;assert.equal(failed.state,'failed');
    await effects.retry(f.access,failed.id);await effects.runOne();
    assert.deepEqual(keys,[failed.id,failed.id]);assert.equal((await effects.status(f.access,'flaky'))[0]!.state,'completed');
  }finally{await f.close();}
});
test('direct candidate catch-up cannot retain an approval of older data and handles delete/recreate',async()=>{
  const f=await setup();try{
    const graph=new Objects(f.db,f.model,f.access),ref={type:'Route',id:'recreated'},deleted={type:'Route',id:'deleted'};
    await graph.create(ref,{id:ref.id,name:'Old'});await graph.create(deleted,{id:deleted.id,name:'Delete me'});
    const branch=await f.governance.create(f.publisher,{ontology:'Eigos',name:'Candidate'});
    const prepared=await f.governance.prepare(f.publisher,revisionInput(branch));
    const approved=await f.governance.review(f.publisher,reviewInput(prepared));
    await graph.remove(ref,1);await graph.create(ref,{id:ref.id,name:'New'});await graph.remove(deleted,1);
    await f.metadata.catchUp(prepared.release,f.capabilities,f.publisher);
    const candidate=await f.metadata.get(prepared.release),view=new Objects(f.db,candidate,f.access);
    assert.equal((await view.read(ref)).properties.name,'New');await assert.rejects(view.read(deleted),/unavailable/);
    await assert.rejects(f.governance.merge(f.publisher,reviewInput(approved)),/exact approved/);
  }finally{await f.close();}
});

test('publication fingerprints include source state hidden by a user edit',async()=>{
  const f=await setup();try{
    const graph=new Objects(f.db,f.model,f.access),ref={type:'Route',id:'hidden-source'};
    await graph.ingestBatch([{ref,properties:{id:ref.id,name:'source'}}],'Feed','2026-01-01T00:00:00Z');
    await graph.edit(ref,1,{name:'manual'});
    const candidate=await f.metadata.prepare(f.model.document,f.capabilities,f.publisher);
    await graph.ingestBatch([{ref,properties:{id:ref.id,name:'updated source'}}],'Feed','2026-02-01T00:00:00Z');
    assert.equal((await graph.read(ref)).properties.name,'manual');
    await assert.rejects(f.metadata.activate(candidate.release,f.capabilities,f.publisher),/Source data changed/);
    await f.metadata.catchUp(candidate.release,f.capabilities,f.publisher);
    await f.metadata.activate(candidate.release,f.capabilities,f.publisher);
    const stored=(await f.db.query(`SELECT properties FROM ${f.db.schema}.source_values WHERE projection=$1 AND type='Route' AND id=$2 AND source='Feed'`,[candidate.projection,ref.id])).rows[0]!;
    assert.equal(stored.properties.name,'updated source');
  }finally{await f.close();}
});

test('candidate catch-up can incorporate changed edit policies without corrupting projection integrity',async()=>{
  const f=await setup();try{
    const {setConflictPolicy}=await import('../packages/runtime/edit-history.js');
    const candidate=await f.metadata.prepare(f.model.document,f.capabilities,f.publisher);
    await setConflictPolicy(f.db,f.publisher,f.model,'Route','latest_value');
    await assert.rejects(f.metadata.activate(candidate.release,f.capabilities,f.publisher),/Source data changed/);
    await f.metadata.catchUp(candidate.release,f.capabilities,f.publisher);
    await f.metadata.activate(candidate.release,f.capabilities,f.publisher);
    assert.equal((await f.metadata.active()).release,candidate.release);
  }finally{await f.close();}
});

test('transformed candidates preserve user edits through catch-up and subsequent source updates', async () => {
  const f = await setup();
  try {
    const graph = new Objects(f.db, f.model, f.access), ref = { type: 'Route', id: 'transformed-edit' };
    await graph.create(ref, { id: ref.id, name: 'original' });
    const transform = (_ref: unknown, properties: Record<string, unknown>) => ({ ...properties, name: String(properties.name).toUpperCase() });
    const candidate = await f.metadata.prepare(f.model.document, f.capabilities, f.publisher, transform);
    const view = new Objects(f.db, candidate, f.access);
    assert.equal((await view.read(ref)).properties.name, 'ORIGINAL');
    await graph.edit(ref, 1, { name: 'changed' });
    await f.metadata.catchUp(candidate.release, f.capabilities, f.publisher);
    assert.equal((await view.read(ref)).properties.name, 'CHANGED');
    await f.metadata.activate(candidate.release, f.capabilities, f.publisher);
    await view.ingestBatch([{ ref, properties: { id: ref.id, name: 'new-source' } }], 'Feed', new Date().toISOString());
    assert.equal((await view.read(ref)).properties.name, 'CHANGED');
    const overrides = (await f.db.query(`SELECT overrides FROM ${f.db.schema}.object_edits WHERE projection=$1 AND id=$2`, [candidate.projection, ref.id])).rows[0]!.overrides;
    assert.equal(overrides.name.value, 'CHANGED');
  } finally { await f.close(); }
});

test('migration converts source and partial user-edit layers while retaining edit timestamps', async () => {
  const f = await setup();
  try {
    const graph = new Objects(f.db, f.model, f.access), ref = { type: 'Route', id: 'partial-edit' };
    await graph.ingestBatch([{ ref, properties: { id: ref.id, name: 'source' } }], 'Feed', '2026-01-01T00:00:00Z');
    await graph.edit(ref, 1, { name: 'manual' });
    const before = (await f.db.query(`SELECT overrides FROM ${f.db.schema}.object_edits WHERE projection=$1 AND id=$2`, [f.model.projection, ref.id])).rows[0]!.overrides;
    const candidate = await f.metadata.prepare(f.model.document, f.capabilities, f.publisher, (_ref, properties) => ({ ...properties, name: String(properties.name).toUpperCase() }));
    const values = (await f.db.query(`SELECT properties FROM ${f.db.schema}.source_values WHERE projection=$1 AND id=$2`, [candidate.projection, ref.id])).rows[0]!.properties;
    const after = (await f.db.query(`SELECT overrides FROM ${f.db.schema}.object_edits WHERE projection=$1 AND id=$2`, [candidate.projection, ref.id])).rows[0]!.overrides;
    assert.equal(values.name, 'SOURCE'); assert.equal(after.name.value, 'MANUAL'); assert.equal(after.name.at, before.name.at);
    await f.metadata.activate(candidate.release, f.capabilities, f.publisher);
    const current = new Objects(f.db, candidate, f.access);
    await current.ingestBatch([{ ref, properties: { id: ref.id, name: 'provider' } }], 'Feed', '2026-02-01T00:00:00Z');
    assert.equal((await current.read(ref)).properties.name, 'MANUAL');
  } finally { await f.close(); }
});

test('a transformed candidate cannot catch up in a process without the original transformation', async () => {
  const f = await setup();
  try {
    const graph = new Objects(f.db, f.model, f.access), ref = { type: 'Route', id: 'transform-identity' };
    await graph.create(ref, { id: ref.id, name: 'original' });
    const candidate = await f.metadata.prepare(f.model.document, f.capabilities, f.publisher, (_ref, properties) => ({ ...properties, name: 'migrated' }));
    const { Metadata } = await import('../packages/runtime/metadata.js');
    const restarted = new Metadata(f.db);
    await assert.rejects(restarted.catchUp(candidate.release, f.capabilities, f.publisher), /transformation is unavailable/);
    assert.equal((await new Objects(f.db, candidate, f.access).read(ref)).properties.name, 'migrated');
    // Activation does not execute migration code. It verifies the already materialized, reviewed state.
    await restarted.activate(candidate.release, f.capabilities, f.publisher);
    assert.equal((await restarted.active()).release, candidate.release);
  } finally { await f.close(); }
});
