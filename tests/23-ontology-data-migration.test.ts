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

test('independent copied objects retain their own markings without inheriting unrelated batch markings',async()=>{
  const f=await setup();try{
    const sourceBody=structuredClone(f.source.document),targetBody=structuredClone(f.target.document);
    for(const body of [sourceBody,targetBody])for(const type of body.objectTypes)type.properties.marks={description:'Security markings',schema:{type:'array',items:{type:'string'}},required:false};
    const source=await f.metadata.publish(sourceBody,bindings,f.publisher),target=await f.metadata.publish(targetBody,bindings,f.publisher);
    for(const [ontology,type] of [['Eigos','Item'],['Eigos','Group'],['Consumer','ImportedItem'],['Consumer','ImportedGroup']])await f.db.query(`INSERT INTO ${f.db.schema}.object_policies(ontology,type,policy) VALUES($1,$2,$3)`,[ontology,type,{properties:{},markingsProperty:'marks'}]);
    for(const name of ['alpha','beta'])await f.db.query(`INSERT INTO ${f.db.schema}.security_memberships(subject,kind,name) VALUES($1,'marking',$2)`,[principal.owner,name]);
    for(const [type,id,mark] of [['Item','a','alpha'],['Group','g','beta']] as const)await new Objects(f.db,source,await Access.load(f.db,principal)).edit({type,id},1,{marks:[mark]});
    await f.migrations.copy(await Access.load(f.db,principal),f.input);
    const graph=new Objects(f.db,target,await Access.load(f.db,principal));
    assert.deepEqual((await graph.read({type:'ImportedItem',id:'a'})).properties.marks,['alpha']);
    assert.deepEqual((await graph.read({type:'ImportedGroup',id:'g'})).properties.marks,['beta']);
  }finally{await f.close();}
});

test('distinct source links cannot silently collapse into one target relation',async()=>{
  const f=await setup();try{
    const body=structuredClone(f.source.document);
    body.linkTypes.push({...body.linkTypes[0]!,apiName:'OtherMembership',from:{type:'Item',name:'otherGroup',cardinality:'one'},to:{type:'Group',name:'otherItems',cardinality:'many'}});
    const source=await f.metadata.publish(body,bindings,f.publisher);
    await new Objects(f.db,source,await Access.load(f.db,principal)).link({type:'OtherMembership',from:{type:'Item',id:'a'},to:{type:'Group',id:'g'}});
    await assert.rejects(f.migrations.copy(await Access.load(f.db,principal),{...f.input,links:{Membership:'ImportedMembership',OtherMembership:'ImportedMembership'}}),/relationships map to one/);
    assert.equal((await f.destination.query({type:'ImportedItem'})).items.length,0);
  }finally{await f.close();}
});

async function geometrySetup(){
  const f=await fixture();await initializeOntologyDataMigrations(f.db);
  await f.db.query(`CREATE TABLE IF NOT EXISTS ${f.db.schema}.geometry_blobs(ontology text NOT NULL,owner text NOT NULL,digest text NOT NULL,format text NOT NULL,bytes bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(ontology,owner,digest))`);
  await setGrants(f.db,'deployment',[{resource:'Eigos',permission:'manage_definition'},{resource:'Consumer',permission:'manage_definition'}]);await f.publisher.refresh();
  const geometry={...type('GeometryAsset'),properties:{id:property(),name:property(),format:property(),contentHash:property(),byteLength:{description:'File size',schema:{type:'integer',minimum:1},required:true},units:property()}};
  const sourceBody={id:'Eigos',version:'geometry-source',objectTypes:[geometry,{...geometry,apiName:'GeometryAlias'}],interfaceTypes:[],linkTypes:[],functionTypes:[],actionTypes:[],dataSources:[]};
  const source=await f.metadata.publish(sourceBody,bindings,f.publisher),target=await f.metadata.publish({...sourceBody,id:'Consumer',objectTypes:[geometry]},bindings,f.publisher);
  await setGrants(f.db,principal.owner,[...memberGrants(source),...memberGrants(target)]);
  await f.db.query(`INSERT INTO ${f.db.schema}.resource_grants VALUES($1,'Consumer/object/GeometryAsset','migrate_objects')`,[principal.owner]);
  const bytes=Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  const {createHash}=await import('node:crypto');const hash=createHash('sha256').update(bytes).digest('hex');
  const properties={id:hash,name:'Visible geometry',format:'obj',contentHash:hash,byteLength:bytes.length,units:'metres'};
  const access=await Access.load(f.db,principal),graph=new Objects(f.db,source,access);
  await graph.create({type:'GeometryAsset',id:hash},properties);
  await f.db.query(`INSERT INTO ${f.db.schema}.geometry_blobs VALUES('Eigos',$1,$2,'obj',$3,now())`,[principal.owner,hash,bytes]);
  return {...f,source,target,bytes,hash,properties,access,graph,migrations:new OntologyDataMigrations(f.db,f.metadata),input:{sourceOntology:'Eigos',targetOntology:'Consumer',requestId:'geometry-copy',types:{GeometryAsset:'GeometryAsset'},links:{}}};
}

test('geometry migration copies verified content and its object into the target namespace atomically',async()=>{
  const f=await geometrySetup();try{
    const receipt=await f.migrations.copy(f.access,f.input);
    const object=await new Objects(f.db,f.target,f.access).read({type:'GeometryAsset',id:f.hash});
    const blob=(await f.db.query(`SELECT bytes,format FROM ${f.db.schema}.geometry_blobs WHERE ontology='Consumer' AND owner=$1 AND digest=$2`,[principal.owner,object.properties.contentHash])).rows[0]!;
    assert(blob.bytes.equals(f.bytes));assert.equal(blob.format,'obj');assert.equal(receipt.objects,1);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.geometry_blobs WHERE digest=$1`,[f.hash])).rows[0]!.count,2);
    assert.deepEqual(await f.migrations.copy(f.access,f.input),receipt);
  }finally{await f.close();}
});

test('geometry migration rejects inconsistent source content and target content collisions',async()=>{
  const f=await geometrySetup();try{
    await f.db.query(`UPDATE ${f.db.schema}.geometry_blobs SET bytes=$1 WHERE ontology='Eigos'`,[Buffer.from('corrupted bytes')]);
    await assert.rejects(f.migrations.copy(f.access,f.input),/Source geometry content differs/);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.objects WHERE projection=$1`,[f.target.projection])).rows[0]!.count,0);
    await f.db.query(`UPDATE ${f.db.schema}.geometry_blobs SET bytes=$1 WHERE ontology='Eigos'`,[f.bytes]);
    await f.db.query(`INSERT INTO ${f.db.schema}.geometry_blobs VALUES('Consumer',$1,$2,'stl',$3,now())`,[principal.owner,f.hash,f.bytes]);
    await assert.rejects(f.migrations.copy(f.access,f.input),/Target geometry content identity/);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.ontology_data_migrations`)).rows[0]!.count,0);
    assert.equal((await f.db.query(`SELECT format FROM ${f.db.schema}.geometry_blobs WHERE ontology='Consumer'`)).rows[0]!.format,'stl');
    await f.db.query(`UPDATE ${f.db.schema}.geometry_blobs SET format='obj' WHERE ontology='Consumer'`);
    assert.equal((await f.migrations.copy(f.access,f.input)).objects,1);
  }finally{await f.close();}
});

test('a hash-only unrelated object cannot copy an unreadable source geometry blob',async()=>{
  const f=await geometrySetup();try{
    await f.graph.create({type:'GeometryAlias',id:f.hash},f.properties);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies(ontology,type,policy) VALUES('Eigos','GeometryAsset',$1)`,[{read:{all:[{op:'equals',property:'name',value:'Allowed geometry'}],any:[]},properties:{}}]);
    await assert.rejects(f.migrations.copy(await Access.load(f.db,principal),f.input),/policy denied/);
    await assert.rejects(f.migrations.copy(await Access.load(f.db,principal),{...f.input,types:{GeometryAlias:'GeometryAsset'}}),/GeometryAsset types at both/);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.geometry_blobs WHERE ontology='Consumer'`)).rows[0]!.count,0);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.objects WHERE projection=$1`,[f.target.projection])).rows[0]!.count,0);
  }finally{await f.close();}
});

test('a target object policy failure rolls back media content written earlier in the copy transaction',async()=>{
  const f=await geometrySetup();try{
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies(ontology,type,policy) VALUES('Consumer','GeometryAsset',$1)`,[{read:{all:[{op:'equals',property:'name',value:'Allowed geometry'}],any:[]},properties:{}}]);
    await assert.rejects(f.migrations.copy(await Access.load(f.db,principal),f.input),/policy denied/);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.geometry_blobs WHERE ontology='Consumer'`)).rows[0]!.count,0);
    assert.equal((await f.db.query(`SELECT count(*)::int count FROM ${f.db.schema}.ontology_data_migrations`)).rows[0]!.count,0);
  }finally{await f.close();}
});
