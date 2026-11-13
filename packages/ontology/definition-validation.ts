import {digest} from '../core/delegation.js';
import type {DefinitionChange,DefinitionDraft,DefinitionEntry,DefinitionValidation,OntologyNamespace} from './definition-store.js';
import type {DefinitionKind,OntologyDocument,SerializableInterface,SerializableObjectType} from './definition-contracts.js';
import {validateBusinessDefinitionExtensions} from './model-compiler.js';
import type {OntologyModel} from './model.js';

const categories={object:'objects',interface:'interfaces',link:'links',action:'actions'} as const;
export const definitionEntries=(document:OntologyDocument):DefinitionEntry[]=>
  (Object.keys(categories) as DefinitionKind[]).flatMap(kind=>document[categories[kind]].map(definition=>({kind,definition})));
export const definitionNameCategory=(kind:DefinitionKind)=>kind==='object'||kind==='interface'?'type':kind;
export function definitionChanges(before:OntologyDocument,after:OntologyDocument):DefinitionChange[]{
  const prior=new Map(definitionEntries(before).map(entry=>[entry.definition.resourceId,entry])),next=new Map(definitionEntries(after).map(entry=>[entry.definition.resourceId,entry]));
  return [...new Set([...prior.keys(),...next.keys()])].flatMap(resourceId=>{
    const old=prior.get(resourceId),current=next.get(resourceId),item=current??old!;
    if(old&&current&&digest(old.definition)===digest(current.definition))return [];
    const fields=old&&current?[...new Set([...Object.keys(old.definition),...Object.keys(current.definition)])].filter(key=>digest((old.definition as unknown as Record<string,unknown>)[key]??null)!==digest((current.definition as unknown as Record<string,unknown>)[key]??null)):[];
    return [{kind:item.kind,resourceId,id:item.definition.id,change:!old?'added' as const:!current?'retired' as const:'modified' as const,fields}];
  });
}
export function additiveObjectDefinition(old:SerializableObjectType,next:SerializableObjectType):boolean{
  if(old.id!==next.id||old.resourceId!==next.resourceId||old.primaryKey!==next.primaryKey||old.titleKey!==next.titleKey||old.writePolicy!==next.writePolicy||digest(old.interfaces??[])!==digest(next.interfaces??[]))return false;
  if(Object.entries(old.properties).some(([key,value])=>!next.properties[key]||digest(value)!==digest(next.properties[key])))return false;
  return Object.entries(next.properties).filter(([key])=>!Object.hasOwn(old.properties,key)).every(([,value])=>!value.required&&!value.derived);
}
export function additiveInterfaceDefinition(old:SerializableInterface,next:SerializableInterface):boolean{
  if(digest(old.parents??[])!==digest(next.parents??[]))return false;
  if(Object.entries(old.properties).some(([name,value])=>!next.properties[name]||digest(value)!==digest(next.properties[name])||(old.optionalProperties??[]).includes(name)!==(next.optionalProperties??[]).includes(name)))return false;
  if(Object.keys(next.properties).some(name=>!Object.hasOwn(old.properties,name)&&!(next.optionalProperties??[]).includes(name)))return false;
  for(const key of ['links','actions'] as const){
    const identity=(item:{name?:string;id?:string;apiName?:string})=>item.name??item.apiName??item.id;
    if((old[key]??[]).some(item=>!(next[key]??[]).some(candidate=>identity(candidate)===identity(item)&&digest(candidate)===digest(item))))return false;
    if((next[key]??[]).some(item=>!(old[key]??[]).some(previous=>identity(previous)===identity(item))
      &&('required' in item?item.required:!item.optional)))return false;
  }return true;
}

/** Materialized inside the storage driver's own transaction. A missing map
 * entry is incomplete evidence, never an empty instance/link population. */
export interface DefinitionValidationSnapshot {
  document:OntologyDocument;model:OntologyModel;base:{document:OntologyDocument;model:OntologyModel};namespace:OntologyNamespace;
  pipelineIssues:DefinitionValidation['issues'];
  names:ReadonlyMap<string,{resource_id:unknown;kind:unknown}|undefined>;
  canonicalGeneratedLinks:ReadonlySet<string>;
  objects:ReadonlyMap<string,{items:Record<string,unknown>[];overflow:boolean}>;
  linkPresence:ReadonlyMap<string,boolean>;
  hasInflightTasks:boolean;
}
export function invalidDefinitionValidation(draft:DefinitionDraft,document:OntologyDocument,error:unknown,changes:DefinitionChange[]):DefinitionValidation{
  return {valid:false,draftId:draft.id,revision:draft.revision,documentDigest:digest(document),changes,
    issues:[...(draft.status==='open'?[]:[{code:'draft_closed',message:'Only an open draft can be validated for publication'}]),{code:'invalid_definition',message:error instanceof Error?error.message:'Definition validation failed'}],migrationRequired:false,unboundSourceFields:[],
    counts:{objects:document.objects.length,interfaces:document.interfaces.length,links:document.links.length,actions:document.actions.length}};
}

/** Shared storage-free publication policy. It receives complete bounded facts;
 * parsing, compilation, SQL authorization and transaction ownership stay with
 * the storage adapter. No result here publishes or activates a release. */
export function validateDefinitionSnapshot(draft:DefinitionDraft,snapshot:DefinitionValidationSnapshot):DefinitionValidation{
  const {document,model,base}=snapshot,changes=definitionChanges(base.document,document),issues:DefinitionValidation['issues']=[];
  if(draft.status!=='open')issues.push({code:'draft_closed',message:'Only an open draft can be validated for publication'});
  let migrationRequired=false,unboundSourceFields:DefinitionValidation['unboundSourceFields']=[];
  try{
    issues.push(...snapshot.pipelineIssues);
    if(document.actions.some(action=>action.implementation?.kind==='declarative')&&!model.properties('Authorization').environment?.schema.safeParse('managed').success)issues.push({code:'incompatible_kernel',message:'Declarative actions require a kernel supporting managed authorization; activate a compatible current kernel before publishing these actions'});
    unboundSourceFields=validateBusinessDefinitionExtensions(base.document,document).unboundSourceFields;
    for(const change of changes){
      const nameKey=JSON.stringify([definitionNameCategory(change.kind),change.id]);
      if(!snapshot.names.has(nameKey))throw new Error('Definition identity read is incomplete');
      const lock=snapshot.names.get(nameKey);
      if(lock&&(lock.resource_id!==change.resourceId||lock.kind!==change.kind))issues.push({code:'identity_conflict',message:`Published API identity ${change.id} cannot be reused`});
      else if(lock&&change.change==='added'){
        const restored=document.links.find(link=>link.resourceId===change.resourceId),canonical=change.kind==='link'&&change.resourceId.startsWith('generated:execution-link:')&&restored&&snapshot.canonicalGeneratedLinks.has(JSON.stringify([change.resourceId,digest(restored)]));
        if(!canonical)issues.push({code:'retired_identity',message:`Retired API identity ${change.id} cannot be reintroduced by editing; activate a compatible historical release instead`});
      }
      if(change.kind==='object'&&change.change!=='added'){
        const oldType=base.model.object(change.id),next=document.objects.find(value=>value.id===change.id),rows=snapshot.objects.get(change.id);
        if(!rows)throw new Error('Definition instance read is incomplete');
        if(!!next&&(next.primaryKey!==oldType.primaryKey||next.titleKey!==oldType.titleKey)||rows.overflow)migrationRequired=true;
        for(const row of rows.items){
          if(!next){migrationRequired=true;break;}
          const properties=JSON.parse(String(row.body)).properties;
          try{if(digest(model.parseProperties(change.id,properties))!==digest(properties))migrationRequired=true;}catch{migrationRequired=true;}
        }
        if(next&&!additiveObjectDefinition(base.document.objects.find(value=>value.id===change.id)!,next))migrationRequired=true;
      }
      if(change.kind==='link'&&change.change!=='added'){
        const next=document.links.find(value=>value.id===change.id),old=base.document.links.find(value=>value.id===change.id)!;
        if(next?digest({from:old.from,to:old.to,writePolicy:old.writePolicy})!==digest({from:next.from,to:next.to,writePolicy:next.writePolicy}):snapshot.linkPresence.get(change.id))migrationRequired=true;
        if(!next&&!snapshot.linkPresence.has(change.id))throw new Error('Definition relationship read is incomplete');
      }
      if(change.kind==='interface'&&change.change==='modified'&&!additiveInterfaceDefinition(base.document.interfaces.find(value=>value.id===change.id)!,document.interfaces.find(value=>value.id===change.id)!))migrationRequired=true;
      if(change.change==='retired'&&snapshot.hasInflightTasks)migrationRequired=true;
    }
    if(migrationRequired)issues.push({code:'migration_required',message:'This change narrows, retires or changes existing identity/data semantics; supply an explicit compatible migration before activation'});
    if(snapshot.namespace.generation!==draft.baseGeneration||digest(snapshot.namespace.active)!==digest(draft.base))issues.push({code:'base_changed',message:'Active ontology changed; create a fresh draft and resolve the diff'});
  }catch(error){issues.push({code:'invalid_definition',message:error instanceof Error?error.message:'Definition validation failed'});}
  return {valid:!issues.length&&draft.status==='open',draftId:draft.id,revision:draft.revision,documentDigest:digest(document),changes,issues,migrationRequired,unboundSourceFields,
    counts:{objects:document.objects.length,interfaces:document.interfaces.length,links:document.links.length,actions:document.actions.length}};
}
