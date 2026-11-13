import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { OntologyDataMigrations, initializeOntologyDataMigrations } from '../packages/runtime/ontology-migrations.js';

const property=(required=true)=>({description:'Property',schema:{type:'string'},required});
const type=(apiName:string)=>({apiName,displayName:apiName,description:apiName,primaryKey:'id',titleProperty:'name',properties:{id:property(),name:property()},interfaces:{}});
const bindings={describe:()=>({functions:{},sources:{}})};
async function setup(){
  const f=await fixture();await initializeOntologyDataMigrations(f.db);
  await setGrants(f.db,'deployment',[{resource:'Eigos',permission:'manage_definition'},{resource:'Consumer',permission:'manage_definition'}]);await f.publisher.refresh();
  const body={id:'Eigos',version:'copy-source',objectTypes:[type('Item'),type('Group')],interfaceTypes:[],linkTypes:[{apiName:'Membership',description:'Group membership',from:{type:'Item',name:'group',cardinality:'one'},to:{type:'Group',name:'items',cardinality:'many'}}],functionTypes:[],actionTypes:[],dataSources:[]};
  const source=await f.metadata.publish(body,bindings,f.publisher);
  const target=await f.metadata.publish({...body,id:'Consumer',objectTypes:[type('ImportedItem'),type('ImportedGroup')],linkTypes:[{...body.linkTypes[0]!,apiName:'ImportedMembership',from:{type:'ImportedItem',name:'group',cardinality:'one'},to:{type:'ImportedGroup',name:'items',cardinality:'many'}}]},bindings,f.publisher);
  await setGrants(f.db,principal.owner,[...memberGrants(source),...memberGrants(target)]);
  // Administrative fixture grant exercises the explicit permission introduced by the root integration.
  for(const name of ['ImportedItem','ImportedGroup'])await f.db.query(`INSERT INTO ${f.db.schema}.resource_grants(subject,resource,permission) VALUES($1,$2,'migrate_objects')`,[principal.owner,'Consumer/object/'+name]);
  const access=await Access.load(f.db,principal),original=new Objects(f.db,source,access),destination=new Objects(f.db,target,access);
  await original.create({type:'Item',id:'a'},{id:'a',name:'Original item'});await original.create({type:'Group',id:'g'},{id:'g',name:'Original group'});
  await original.link({type:'Membership',from:{type:'Item',id:'a'},to:{type:'Group',id:'g'}});
  const input={sourceOntology:'Eigos',targetOntology:'Consumer',requestId:'copy',types:{Item:'ImportedItem',Group:'ImportedGroup'},links:{Membership:'ImportedMembership'}};
  return {...f,source,target,access,original,destination,input,migrations:new OntologyDataMigrations(f.db,f.metadata)};
}
test('cross-Ontology data copies objects and links atomically and records pinned provenance',async()=>{
  const f=await setup();try{
    const receipt=await f.migrations.copy(f.access,f.input);
    assert.equal(receipt.objects,2);assert.equal(receipt.links,1);assert.equal(receipt.sourceRelease,f.source.release);
    assert.equal((await f.destination.read({type:'ImportedItem',id:'a'})).properties.name,'Original item');
    assert.equal((await f.destination.follow({type:'ImportedItem',id:'a'},'group'))[0]!.ref.type,'ImportedGroup');
    assert.equal((await f.original.read({type:'Item',id:'a'})).properties.name,'Original item');
    const objects=await f.migrations.read(f.access,{id:receipt.id,limit:1});assert.equal(objects.items.length,1);assert.equal(objects.cursor,1);
    const links=await f.migrations.read(f.access,{id:receipt.id,kind:'links'});assert.equal(links.items[0]!.source_link.type,'Membership');assert.equal(links.items[0]!.target_link.type,'ImportedMembership');
    assert.deepEqual(await f.migrations.copy(f.access,f.input),receipt);
    await assert.rejects(f.migrations.copy(f.access,{...f.input,links:{}}),/different input/);
  }finally{await f.close();}
});
test('copy collisions and incomplete selected link endpoints leave every target write rolled back',async()=>{
  const f=await setup();try{
    await assert.rejects(f.migrations.copy(f.access,{...f.input,objects:[{type:'Item',id:'a'}]}),/both endpoints/);
    assert.equal((await f.destination.query({type:'ImportedItem'})).items.length,0);
    await f.destination.create({type:'ImportedGroup',id:'g'},{id:'g',name:'Existing target'});
    await assert.rejects(f.migrations.copy(f.access,f.input),/identity already exists/);
    assert.equal((await f.destination.query({type:'ImportedItem'})).items.length,0);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.ontology_data_migrations`)).rows[0]!.count,0);
  }finally{await f.close();}
});
test('migration rejects hidden fields, absent explicit grants and cross-owner objects',async()=>{
  const f=await setup();try{
    await f.db.query(`INSERT INTO ${f.db.schema}.property_security(ontology,type,property) VALUES('Eigos','Item','name')`);
    await assert.rejects(f.migrations.copy(await Access.load(f.db,principal),f.input),/hidden source fields/);
    assert.equal((await f.destination.query({type:'ImportedItem'})).items.length,0);
    await f.db.query(`DELETE FROM ${f.db.schema}.property_security`);
    await f.db.query(`DELETE FROM ${f.db.schema}.resource_grants WHERE permission='migrate_objects'`);
    await assert.rejects(f.migrations.copy(await Access.load(f.db,principal),f.input),/Permission/);
    await setGrants(f.db,'other',[...memberGrants(f.source),...memberGrants(f.target)]);
    for(const name of ['ImportedItem','ImportedGroup'])await f.db.query(`INSERT INTO ${f.db.schema}.resource_grants VALUES('other',$1,'migrate_objects')`,['Consumer/object/'+name]);
    await assert.rejects(f.migrations.copy(await Access.load(f.db,{...principal,owner:'other'}),{...f.input,objects:[{type:'Item',id:'a'}],links:{}}),/unavailable/);
  }finally{await f.close();}
});
test('target schema validation prevents partial copies and current permissions guard receipt retries',async()=>{
  const f=await setup();try{
    const changed=structuredClone(f.target.document);changed.objectTypes[0]!.properties.name!.schema={type:'string',pattern:'^[A-Z]+$'};
    await f.metadata.publish(changed,bindings,f.publisher);
    await assert.rejects(f.migrations.copy(f.access,f.input));
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.ontology_data_migrations`)).rows[0]!.count,0);
    const valid=await f.metadata.publish(f.target.document,bindings,f.publisher);
    const receipt=await f.migrations.copy(await Access.load(f.db,principal),f.input);
    await f.db.query(`INSERT INTO ${f.db.schema}.property_security VALUES('Consumer','ImportedItem','name')`);
    await assert.rejects(f.migrations.read(await Access.load(f.db,principal),{id:receipt.id}),/hidden fields/);
    await assert.rejects(f.migrations.copy(await Access.load(f.db,principal),f.input),/hidden fields/);
    assert.equal(receipt.targetRelease,valid.release);
  }finally{await f.close();}
});

test('migration excludes derived values, maps primary keys and refuses lifecycle metadata objects',async()=>{
  const f=await setup();try{
    const sourceBody=structuredClone(f.source.document);
    Object.assign(sourceBody.objectTypes[0]!.properties,{calculated:{description:'Computed value',schema:{type:'number'},required:false,derived:{op:'literal',value:7}}});
    sourceBody.objectTypes.push(type('OntologyScenario'));
    await f.metadata.publish(sourceBody,bindings,f.publisher);
    const targetBody=structuredClone(f.target.document),targetType=targetBody.objectTypes[0]!;
    targetType.primaryKey='key';delete targetType.properties.id;targetType.properties.key=property();
    Object.assign(targetType.properties,{calculated:{description:'Computed value',schema:{type:'number'},required:false,derived:{op:'literal',value:7}}});
    const target=await f.metadata.publish(targetBody,bindings,f.publisher);
    const copied=await f.migrations.copy(f.access,{...f.input,types:{Item:'ImportedItem'},links:{},objects:[{type:'Item',id:'a'}]});
    assert.equal(copied.objects,1);
    const stored=(await f.db.query(`SELECT properties FROM ${f.db.schema}.objects WHERE projection=$1 AND type='ImportedItem'`,[target.projection])).rows[0]!.properties;
    assert.equal(stored.key,'a');assert.equal(Object.hasOwn(stored,'id'),false);assert.equal(Object.hasOwn(stored,'calculated'),false);
    await assert.rejects(f.migrations.copy(f.access,{...f.input,requestId:'lifecycle',types:{OntologyScenario:'ImportedItem'},links:{}}),/lifecycle objects/);
  }finally{await f.close();}
});
