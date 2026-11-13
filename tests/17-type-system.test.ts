import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest } from '../packages/core/identity.js';
import { Ontology } from '../packages/ontology/model.js';
import { propertyDisplay } from '../packages/ontology/type-system.js';
import { fixture, principal } from './fixture.js';
import { Functions } from '../packages/runtime/functions.js';
import { Actions } from '../packages/runtime/actions.js';
import { Objects } from '../packages/runtime/objects.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { OntologyPackages } from '../packages/runtime/ontology-packages.js';

const property = (schema:Record<string,unknown>,required=false) => ({description:'Test property',schema,required});
const basic = () => ({id:'Eigos',version:'types',objectTypes:[{apiName:'Item',displayName:'Item',description:'Test item',primaryKey:'id',titleProperty:'name',properties:{id:property({type:'string'},true),name:property({type:'string'},true)},interfaces:{}}],interfaceTypes:[],linkTypes:[],functionTypes:[],actionTypes:[],dataSources:[]});
const noBindings = {describe:()=>({functions:{},sources:{}})};

test('old publication identity remains raw while reusable contracts compile separately',()=>{
  const legacy=new Ontology(basic());
  assert.equal(legacy.digest,digest(basic()));
  const input={...basic(),valueTypes:[{apiName:'Label',version:'1',description:'Nonempty uppercase label',schema:{type:'string',minLength:2,pattern:'^[A-Z]+$'}}],sharedProperties:[{apiName:'DisplayLabel',description:'Shared label',valueType:{name:'Label',version:'1'}}]};
  input.objectTypes[0]!.properties.name={sharedProperty:'DisplayLabel',required:true} as never;
  const model=new Ontology(input),ref={type:'Item',id:'one'};
  assert.equal(model.document.objectTypes[0]!.properties.name!.sharedProperty,'DisplayLabel');
  assert.equal(model.object('Item').properties.name!.schema.type,'string');
  assert.equal(model.object('Item').properties.name!.description,'Shared label');
  assert.equal(model.digest,digest(model.document));
  assert.notEqual(digest(model.resolvedDocument),model.digest);
  assert.deepEqual(model.parseObject(ref,{id:'one',name:'GOOD'}),{id:'one',name:'GOOD'});
  assert.throws(()=>model.parseObject(ref,{id:'one',name:'bad'}));
  assert.throws(()=>new Ontology({...input,valueTypes:[]}),/Unknown pinned Value Type/);
});

test('Shared Property and Value Type cycles and incompatible base types fail publication',()=>{
  const shared={...basic(),sharedProperties:[{apiName:'A',sharedProperty:'B'},{apiName:'B',sharedProperty:'A'}]};
  assert.throws(()=>new Ontology(shared),/cycle/);
  const values={...basic(),valueTypes:[{apiName:'A',version:'1',description:'Cycle',schema:{valueType:{name:'A',version:'1'}}}]};
  assert.throws(()=>new Ontology(values),/cycle/);
  const conflict={...basic(),valueTypes:[{apiName:'Label',version:'1',description:'String',schema:{type:'string'}}]};
  conflict.objectTypes[0]!.properties.name={...property({type:'number'},true),valueType:{name:'Label',version:'1'}} as never;
  assert.throws(()=>new Ontology(conflict),/incompatible base/);
});

test('named Struct fields, reducers, main fields and formatting are validated and executed',()=>{
  const input={...basic(),structTypes:[{apiName:'Price',description:'A price observation',fields:{amount:{type:'number'},currency:{type:'string'}},required:['amount','currency'],mainField:'amount'}]};
  Object.assign(input.objectTypes[0]!.properties,{prices:{description:'Prices',struct:{type:'Price',array:true,reducer:{op:'min',field:'amount'}},format:{kind:'currency',currency:'USD',locale:'en-US'}}});
  const model=new Ontology(input),ref={type:'Item',id:'one'};
  const object=model.parseObject(ref,{id:'one',name:'Item',prices:[{amount:12,currency:'USD'},{amount:7,currency:'USD'}]});
  assert.equal(propertyDisplay(model.object('Item').properties.prices!,object.prices),'$7.00');
  assert.throws(()=>model.parseObject(ref,{id:'one',name:'Item',prices:[{amount:'bad',currency:'USD'}]}));
  const invalid=structuredClone(input);(invalid.objectTypes[0]!.properties as any).prices.struct.reducer.field='missing';
  assert.throws(()=>new Ontology(invalid),/comparison field/);
});

test('Interface multiple inheritance supports diamonds and rejects cycles and conflicting members',()=>{
  const shape=(apiName:string,parents:string[]=[])=>({apiName,description:apiName,extends:parents,properties:{},optionalProperties:[],links:{},actions:{}});
  const input={...basic(),interfaceTypes:[{...shape('Named'),properties:{label:property({type:'string'})}},shape('Left',['Named']),shape('Right',['Named']),shape('Leaf',['Left','Right'])]};
  input.objectTypes[0]!.interfaces={Leaf:{properties:{label:'name'},links:{},actions:{}}} as never;
  const model=new Ontology(input);
  assert(model.implements('Item','Named'));assert(model.implements('Item','Left'));
  assert.deepEqual(model.concreteTypes('Named'),['Item']);
  assert.equal(model.propertyName('Item','Leaf','label'),'name');
  const conflict=structuredClone(input);conflict.interfaceTypes[2]!.properties={label:property({type:'number'})} as never;
  assert.throws(()=>new Ontology(conflict),/Conflicting/);
  const cycle=structuredClone(input);cycle.interfaceTypes[0]!.extends=['Leaf'];
  assert.throws(()=>new Ontology(cycle),/cycle/);
});

test('Interface Action parameters reject narrower constraints and extra required inputs',()=>{
  const input={...basic(),interfaceTypes:[{apiName:'Creatable',description:'Create named items',properties:{},optionalProperties:[],links:{},actions:{create:{required:true,objectParameters:{},parameters:{type:'object',properties:{label:{type:'string',minLength:1}},required:['label'],additionalProperties:false}}}}],actionTypes:[{apiName:'CreateItem',description:'Create an item',parameters:{type:'object',properties:{label:{type:'string',minLength:1}},required:['label'],additionalProperties:false},objectParameters:{},submissionCriteria:[],rules:[{op:'createObject',object:{type:'Item',id:{parameter:'label'}},properties:{id:{parameter:'label'},name:{parameter:'label'}}}],result:{type:'Item',id:{parameter:'label'}}}]};
  input.objectTypes[0]!.interfaces={Creatable:{properties:{},links:{},actions:{create:{action:'CreateItem',parameters:{label:'label'}}}}} as never;
  new Ontology(input);
  const narrower=structuredClone(input);narrower.actionTypes[0]!.parameters.properties.label.minLength=5;
  assert.throws(()=>new Ontology(narrower),/parameter constraints/);
  const extra=structuredClone(input);Object.assign(extra.actionTypes[0]!.parameters.properties,{secret:{type:'string'}});extra.actionTypes[0]!.parameters.required.push('secret');
  assert.throws(()=>new Ontology(extra),/unmapped/);
});

test('derived properties are read-only and cannot be primary keys or required stored fields',()=>{
  const input=basic();Object.assign(input.objectTypes[0]!.properties,{total:{...property({type:'number'}),derived:{op:'literal',value:3}}});
  const model=new Ontology(input);assert.deepEqual(model.parseObject({type:'Item',id:'one'},{id:'one',name:'Item'}),{id:'one',name:'Item'});
  assert.throws(()=>model.parseObject({type:'Item',id:'one'},{id:'one',name:'Item',total:3}));
  (input.objectTypes[0]!.properties as any).total.required=true;assert.throws(()=>new Ontology(input),/Derived properties/);
});

test('pinned shared imports resolve namespaced dependencies and reject tampering and collisions',()=>{
  const source=new Ontology(basic());
  const target={...basic(),id:'Consumer',objectTypes:[],imports:[{ontology:'Eigos',version:'types',digest:source.digest,namespace:'Shared',document:source.document}]};
  const model=new Ontology(target);assert(model.objects.has('SharedItem'));assert.equal(model.document.objectTypes.length,0);
  assert.equal(model.resourceDocument.objectTypes[0]!.apiName,'SharedItem');
  const tampered=structuredClone(target);tampered.imports[0]!.document.objectTypes[0]!.description='changed';
  assert.throws(()=>new Ontology(tampered),/digest differs/);
  const duplicate=structuredClone(target);duplicate.imports.push(duplicate.imports[0]!);assert.throws(()=>new Ontology(duplicate),/namespace/);
});

test('Value Types apply through Action parameters and source object ingestion',async()=>{
  const f=await fixture();try{
    const body={...basic(),valueTypes:[{apiName:'Label',version:'1',description:'Uppercase labels',schema:{type:'string',pattern:'^[A-Z]+$'}}],actionTypes:[{apiName:'CreateItem',description:'Create item',parameters:{type:'object',properties:{label:{valueType:{name:'Label',version:'1'}}},required:['label'],additionalProperties:false},objectParameters:{},submissionCriteria:[],rules:[{op:'createObject',object:{type:'Item',id:{parameter:'label'}},properties:{id:{parameter:'label'},name:{parameter:'label'}}}],result:{type:'Item',id:{parameter:'label'}}}]};
    body.objectTypes[0]!.properties.name={...property({},true),valueType:{name:'Label',version:'1'}} as never;
    const model=await f.metadata.publish(body,noBindings,f.publisher);
    await setGrants(f.db,principal.owner,memberGrants(model));await f.access.refresh();
    const actions=new Actions(f.db,new Functions(new Map(),[]));
    await assert.rejects(actions.apply(f.access,model,'CreateItem',{label:'bad'},'bad'));
    await actions.apply(f.access,model,'CreateItem',{label:'GOOD'},'good');
    const graph=new Objects(f.db,model,f.access);
    await assert.rejects(graph.ingestBatch([{ref:{type:'Item',id:'source'},properties:{id:'source',name:'bad'}}]));
    assert.equal((await graph.read({type:'Item',id:'GOOD'})).properties.name,'GOOD');
  }finally{await f.close();}
});

test('package export requires every dependency grant and import produces a reviewable pinned branch',async()=>{
  const f=await fixture();try{
    const body={...basic(),sharedProperties:[{apiName:'Label',description:'Shared name',schema:{type:'string'}}]};
    body.objectTypes[0]!.properties.name={sharedProperty:'Label',required:true} as never;
    const model=await f.metadata.publish(body,noBindings,f.publisher);
    const packages=new OntologyPackages(f.db,f.metadata,noBindings);
    await setGrants(f.db,'limited',[{resource:'Eigos/object/Item',permission:'view_definition'}]);
    const limited=await Access.load(f.db,{owner:'limited',scopes:[]});
    await assert.rejects(packages.export(limited,{ontology:'Eigos',resources:[{kind:'object',name:'Item'}]}),/Permission/);
    const packet=await packages.export(f.publisher,{ontology:'Eigos',resources:[{kind:'object',name:'Item'}]});
    assert.equal(packet.document.sharedProperties?.length,1);
    const branch=await packages.import(f.publisher,{targetOntology:'Eigos',namespace:'Imported',package:packet,branchName:'Import reusable item'});
    assert.equal(branch.state,'draft');assert.equal((await f.metadata.active()).release,model.release);
    assert(new Ontology(branch.body).objects.has('ImportedItem'));
    const corrupt=structuredClone(packet);corrupt.document.objectTypes[0]!.description='tampered';
    await assert.rejects(packages.import(f.publisher,{targetOntology:'Eigos',namespace:'Bad',package:corrupt,branchName:'Bad'}),/digest differs/);
  }finally{await f.close();}
});

test('definition migration requires explicit names for dependency closure and validates collisions',async()=>{
  const f=await fixture();try{
    await f.metadata.publish(basic(),noBindings,f.publisher);
    await setGrants(f.db,'deployment',[{resource:'Eigos',permission:'manage_definition'},{resource:'Consumer',permission:'manage_definition'}]);await f.publisher.refresh();
    await f.metadata.publish({...basic(),id:'Consumer',objectTypes:[]},noBindings,f.publisher);
    const packages=new OntologyPackages(f.db,f.metadata,noBindings);
    await assert.rejects(packages.migrate(f.publisher,{ontology:'Eigos',targetOntology:'Consumer',resources:[{kind:'object',name:'Item'}],mapping:{},branchName:'Missing mapping'}),/explicit target/);
    const branch=await packages.migrate(f.publisher,{ontology:'Eigos',targetOntology:'Consumer',resources:[{kind:'object',name:'Item'}],mapping:{object:{Item:'CustomerItem'}},branchName:'Migrate definition'});
    assert(new Ontology(branch.body).objects.has('CustomerItem'));
    assert.equal((await f.metadata.active('Consumer')).document.objectTypes.length,0);
  }finally{await f.close();}
});

test('metadata supports namespaced type classes and validates unused Struct declarations',()=>{
  const input=basic();Object.assign(input.objectTypes[0]!.properties.name,{typeClasses:[{kind:'vulcan',name:'cad_media_reference'}],renderHints:{prominent:true},status:'active'});
  const model=new Ontology(input);assert.equal(model.object('Item').properties.name!.typeClasses?.[0]!.name,'cad_media_reference');
  assert.throws(()=>new Ontology({...basic(),structTypes:[{apiName:'Empty',description:'Invalid empty structure',fields:{}}]}),/Struct requires fields/);
});
