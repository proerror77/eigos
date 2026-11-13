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

test('function-backed Action packages include executable code resource dependencies recursively',async()=>{
  const f=await fixture();try{
    const parameters={type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false};
    const reference={type:'object',properties:{type:{type:'string'},id:{type:'string'}},required:['type','id'],additionalProperties:false};
    const input={...basic(),functionTypes:[
      {apiName:'normalizeName',description:'Normalize a label',parameters,returns:{type:'string'},dependencies:{}},
      {apiName:'observeItems',description:'Declared source reader',parameters:{type:'object',properties:{},additionalProperties:false},returns:{type:'boolean'},dependencies:{}},
      {apiName:'createItem',description:'Create through the declared object and source mapping',parameters,returns:reference,edits:true,dependencies:{objectTypes:['Item'],functions:['normalizeName'],dataSources:['ItemFeed']}},
    ],dataSources:[{apiName:'ItemFeed',objectType:'Item',function:'observeItems',properties:{id:'id',name:'name'}}],actionTypes:[{apiName:'CreateItem',description:'Create a named item',parameters,objectParameters:{},submissionCriteria:[],function:'createItem'}]};
    const model=new Ontology(input);
    let functions:Functions;
    functions=new Functions(new Map<string,import('../packages/runtime/functions.js').FunctionHandler>([
      ['normalizeName',(input)=>String(input.name).toUpperCase()],
      ['observeItems',()=>true],
      ['createItem',async(input,context)=>{
        const mapping=context.objects.model.sources.get('ItemFeed');assert(mapping);
        const normalized=await functions.invoke(context.objects.model,'normalizeName',input,context);
        const ref={type:mapping.objectType,id:'created'};
        return context.edit!(ref,objects=>objects.create(ref,{id:ref.id,name:normalized}));
      }],
    ]),model.resolvedDocument.functionTypes);
    const bindings={describe:(ontology:Ontology)=>({functions:functions.bindings(ontology),sources:Object.fromEntries([...ontology.sources.keys()].map(name=>[name,name]))})};
    await f.metadata.publish(model.document,bindings,f.publisher);
    const packages=new OntologyPackages(f.db,f.metadata,bindings);
    const packet=await packages.export(f.publisher,{ontology:'Eigos',resources:[{kind:'action',name:'CreateItem'}]});
    assert.deepEqual(packet.document.objectTypes.map(type=>type.apiName),['Item']);
    assert.deepEqual(packet.document.dataSources.map(source=>source.apiName),['ItemFeed']);
    assert.equal(packet.document.functionTypes.length,3);
    const publication=await f.metadata.publish(packet.document,bindings,f.publisher);
    await setGrants(f.db,principal.owner,memberGrants(publication));
    const access=await Access.load(f.db,principal);
    const ref=await new Actions(f.db,functions).apply(access,publication,'CreateItem',{name:'usable package'},'packaged-create');
    assert.equal((await new Objects(f.db,publication,access).read(ref)).properties.name,'USABLE PACKAGE');
    const imported=await packages.import(f.publisher,{targetOntology:'Eigos',namespace:'Copy',package:packet,branchName:'Import executable declarations'});
    const compiled=new Ontology(imported.body);
    assert.deepEqual(compiled.functions.get('CopycreateItem')!.dependencies,{objectTypes:['CopyItem'],functions:['CopynormalizeName'],dataSources:['CopyItemFeed']});
  }finally{await f.close();}
});

test('legacy Functions remain loadable but package export requires an explicit dependency declaration',async()=>{
  const f=await fixture();try{
    const input={...basic(),functionTypes:[{apiName:'Pure',description:'Legacy calculation',parameters:{type:'object',properties:{},additionalProperties:false},returns:{type:'number'}}]};
    const model=new Ontology(input),functions=new Functions(new Map([['Pure',()=>1]]),model.document.functionTypes);
    const bindings={describe:(ontology:Ontology)=>({functions:functions.bindings(ontology),sources:{}})};
    await f.metadata.publish(model.document,bindings,f.publisher);
    const packages=new OntologyPackages(f.db,f.metadata,bindings);
    await assert.rejects(packages.export(f.publisher,{ontology:'Eigos',resources:[{kind:'function',name:'Pure'}]}),/declared resource dependencies/);
    const invalid={...input,functionTypes:[{...input.functionTypes[0]!,dependencies:{objectTypes:['Missing']}}]};
    assert.throws(()=>new Ontology(invalid),/Unknown Function dependency/);
  }finally{await f.close();}
});

test('package export honors version-qualified Value Type definition grants',async()=>{
  const f=await fixture();try{
    const document={...basic(),valueTypes:[{apiName:'Label',version:'1',description:'A label',schema:{type:'string'}}]};
    await f.metadata.publish(document,noBindings,f.publisher);
    const packages=new OntologyPackages(f.db,f.metadata,noBindings);
    await setGrants(f.db,'value-reader',[{resource:'Eigos/valueType/Label@1',permission:'view_definition'}]);
    const access=await Access.load(f.db,{owner:'value-reader',scopes:[]});
    const packet=await packages.export(access,{ontology:'Eigos',resources:[{kind:'valueType',name:'Label',version:'1'}]});
    assert.equal(packet.document.valueTypes?.[0]!.apiName,'Label');
    assert.equal(packet.document.objectTypes.length,0);
  }finally{await f.close();}
});

test('schema inclusion keeps composition siblings and oneOf exclusivity',async()=>{
  const {schemaSubset}=await import('../packages/ontology/schema-compatibility.js');
  assert.equal(schemaSubset({type:'string'},{type:'string',minLength:5,anyOf:[{type:'string'},{type:'number'}]}),false);
  assert.equal(schemaSubset({type:'string',minLength:5},{type:'string',minLength:5,anyOf:[{type:'string'},{type:'number'}]}),true);
  assert.equal(schemaSubset({type:'string'},{oneOf:[{type:'string'},{type:'string'}]}),false);
  assert.equal(schemaSubset({type:'string'},{oneOf:[{type:'string'},{type:'number'}]}),true);
  assert.equal(schemaSubset({anyOf:[{type:'string'},{type:'number'}]},{oneOf:[{type:'string'},{type:'number'}]}),true);
  assert.equal(schemaSubset({type:'number'},{anyOf:[false,{type:'string'}]}),false);
  const actual={type:'string',minLength:1,maxLength:500,allOf:[{type:'string'},{type:'string',minLength:1,maxLength:500,$schema:'https://json-schema.org/draft/2020-12/schema'}]};
  const accepted={type:'string',allOf:[{type:'string'},{type:'string',$schema:'https://json-schema.org/draft/2020-12/schema'}]};
  assert.equal(schemaSubset(actual,accepted),true);
  assert.equal(schemaSubset(actual,{...accepted,minLength:600}),false);
  assert.equal(schemaSubset({type:'object',additionalProperties:true},{type:'object',properties:{age:{type:'number'}},additionalProperties:true}),false);
  assert.equal(schemaSubset({type:'object',additionalProperties:false,patternProperties:{'.*':{type:'string'}}},{type:'object',properties:{age:{type:'number'}},additionalProperties:true}),false);
});

test('Shared Property allOf contracts preserve constrained fields while rejecting narrower Interface Actions',()=>{
  const input={...basic(),sharedProperties:[{apiName:'BusinessName',description:'Reusable name',schema:{type:'string'}}],interfaceTypes:[{
    apiName:'Named',description:'Named entity',properties:{label:{...property({type:'string',$schema:'https://json-schema.org/draft/2020-12/schema'}),sharedProperty:'BusinessName'}},optionalProperties:[],links:{},actions:{},
  }]};
  input.objectTypes[0]!.properties.name={...property({type:'string',minLength:1,maxLength:500,$schema:'https://json-schema.org/draft/2020-12/schema'},true),sharedProperty:'BusinessName'} as never;
  input.objectTypes[0]!.interfaces={Named:{properties:{label:'name'},links:{},actions:{}}} as never;
  const model=new Ontology(input);
  assert.equal(model.propertyName('Item','Named','label'),'name');
  assert.equal(model.parseObject({type:'Item',id:'one'},{id:'one',name:'Valid'}).name,'Valid');
  assert.throws(()=>model.parseObject({type:'Item',id:'one'},{id:'one',name:''}));
  const action={...basic(),interfaceTypes:[{apiName:'Creatable',description:'Create named items',properties:{},optionalProperties:[],links:{},actions:{create:{required:true,objectParameters:{},parameters:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false}}}}],actionTypes:[{apiName:'CreateItem',description:'Create an item',parameters:{type:'object',properties:{label:{type:'string',minLength:5,anyOf:[{type:'string'},{type:'number'}]}},required:['label'],additionalProperties:false},objectParameters:{},submissionCriteria:[],rules:[{op:'createObject',object:{type:'Item',id:{parameter:'label'}},properties:{id:{parameter:'label'},name:{parameter:'label'}}}],result:{type:'Item',id:{parameter:'label'}}}]};
  action.objectTypes[0]!.interfaces={Creatable:{properties:{},links:{},actions:{create:{action:'CreateItem',parameters:{label:'label'}}}}} as never;
  assert.throws(()=>new Ontology(action),/parameter constraints/);
});

test('packages include shared derived links and target types using each concrete object context',async()=>{
  const f=await fixture();try{
    const input=basic();
    input.objectTypes.push({...structuredClone(input.objectTypes[0]!),apiName:'Child',displayName:'Child',description:'Linked child'});
    Object.assign(input.objectTypes[0]!.properties,{childCount:{sharedProperty:'ChildCount'}});
    const body={...input,sharedProperties:[{apiName:'ChildCount',description:'Visible linked children',schema:{type:'integer',minimum:0},derived:{op:'linked',path:[{link:'children'}],aggregate:'count'}}],linkTypes:[{apiName:'ItemChildren',description:'Item children',from:{type:'Item',name:'children',cardinality:'many'},to:{type:'Child',name:'parent',cardinality:'one'}}]};
    const model=await f.metadata.publish(body,noBindings,f.publisher),packages=new OntologyPackages(f.db,f.metadata,noBindings);
    const packet=await packages.export(f.publisher,{ontology:'Eigos',resources:[{kind:'object',name:'Item'}]});
    assert.deepEqual(new Set(packet.document.objectTypes.map(type=>type.apiName)),new Set(['Item','Child']));
    assert.deepEqual(packet.document.linkTypes.map(link=>link.apiName),['ItemChildren']);
    assert.equal(packet.document.sharedProperties?.[0]!.apiName,'ChildCount');
    await setGrants(f.db,'limited-derived',[{resource:'Eigos/object/Item',permission:'view_definition'},{resource:'Eigos/sharedProperty/ChildCount',permission:'view_definition'}]);
    await assert.rejects(packages.export(await Access.load(f.db,{owner:'limited-derived',scopes:[]}),{ontology:'Eigos',resources:[{kind:'object',name:'Item'}]}),/Permission/);
    const publication=await f.metadata.publish(packet.document,noBindings,f.publisher);
    await setGrants(f.db,principal.owner,memberGrants(publication));
    const graph=new Objects(f.db,publication,await Access.load(f.db,principal)),parent={type:'Item',id:'parent'},child={type:'Child',id:'child'};
    await graph.create(parent,{id:'parent',name:'Parent'});await graph.create(child,{id:'child',name:'Child'});
    await graph.link({type:'ItemChildren',from:parent,to:child});
    assert.equal((await graph.read(parent)).properties.childCount,1);
    assert.notEqual(publication.release,model.release);
  }finally{await f.close();}
});
