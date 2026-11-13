import { z } from 'zod';
import { digest } from '../core/identity.js';
import type { OntologyDocument, propertySchema } from './schema.js';

type Property = z.infer<typeof propertySchema>;
type Schema = Record<string, unknown>;
type Interface = OntologyDocument['interfaceTypes'][number];
const indexed = <T extends {apiName:string}>(values: readonly T[]) => {
  const map=new Map(values.map(value=>[value.apiName,value]));
  if(map.size!==values.length)throw new Error('Duplicate reusable resource API name');
  return map;
};
const intersect = (base:Schema, local:Schema):Schema => {
  if(!Object.keys(local).length)return structuredClone(base);
  if(!Object.keys(base).length)return structuredClone(local);
  if(digest(base)===digest(local))return structuredClone(base);
  if(base.type&&local.type&&base.type!==local.type)throw new Error('Reusable type has an incompatible base type');
  return {...base,...local,allOf:[base,local]};
};

export function compileTypes(input: OntologyDocument): OntologyDocument {
  const document=structuredClone(input);
  const shared=indexed(document.sharedProperties??[]), structs=indexed(document.structTypes??[]);
  const values=new Map((document.valueTypes??[]).map(value=>[value.apiName+'@'+value.version,value]));
  if(values.size!==(document.valueTypes?.length??0))throw new Error('Duplicate Value Type version');
  const schema=(raw:Schema, visiting:string[]=[]):Schema=>{
    const output=structuredClone(raw);
    const reference=output.valueType as {name?:string;version?:string}|undefined;
    delete output.valueType;
    for(const name of ['properties','patternProperties','$defs','definitions','dependentSchemas']) {
      const entries=output[name];
      if(entries&&typeof entries==='object'&&!Array.isArray(entries))output[name]=Object.fromEntries(Object.entries(entries).map(([key,child])=>[key,schema(child as Schema,visiting)]));
    }
    for(const name of ['allOf','anyOf','oneOf','prefixItems'])if(Array.isArray(output[name]))output[name]=(output[name] as Schema[]).map(child=>schema(child,visiting));
    for(const name of ['items','additionalProperties','contains','not','if','then','else','propertyNames']) {
      const child=output[name];if(child&&typeof child==='object'&&!Array.isArray(child))output[name]=schema(child as Schema,visiting);
    }
    if(!reference)return output;
    const key=reference.name+'@'+reference.version, selected=values.get(key);
    if(!selected)throw new Error('Unknown pinned Value Type '+key);
    if(visiting.includes(key))throw new Error('Value Type reference cycle');
    return intersect(schema(selected.schema,[...visiting,key]),output);
  };
  const compileProperty=(raw:Property,visiting:string[]=[]):Property=>{
    let base:Property|undefined;
    if(raw.sharedProperty){
      if(visiting.includes(raw.sharedProperty))throw new Error('Shared Property reference cycle');
      const selected=shared.get(raw.sharedProperty);if(!selected)throw new Error('Unknown Shared Property '+raw.sharedProperty);
      base=compileProperty(selected,[...visiting,raw.sharedProperty]);
    }
    const value:Property={...base,...raw,description:raw.description==='Shared property'&&base?base.description:raw.description,schema:intersect(base?.schema??{},raw.schema)};
    if(value.valueType)value.schema=intersect(schema({valueType:value.valueType}),value.schema);
    if(value.struct){
      const selected=structs.get(value.struct.type);if(!selected)throw new Error('Unknown Struct Type '+value.struct.type);
      const properties=Object.fromEntries(Object.entries(selected.fields).map(([name,field])=>[name,schema(field)]));
      if(!Object.keys(properties).length)throw new Error('Struct requires fields');
      for(const field of Object.values(properties))if(!['string','number','integer','boolean'].includes(String(field.type)))throw new Error('Struct fields require scalar types');
      for(const name of selected.required??[])if(!properties[name])throw new Error('Unknown required Struct field');
      const main=value.struct.mainField??selected.mainField;
      if(main&&!properties[main])throw new Error('Unknown Struct main field');
      const reducer=value.struct.reducer;
      if(reducer&&(!value.struct.array||((reducer.op==='min'||reducer.op==='max')&&(!reducer.field||!properties[reducer.field]))))throw new Error('Struct reducer requires an array and a valid comparison field');
      value.struct={...value.struct,...(main?{mainField:main}:{})};
      const struct={type:'object',properties,required:selected.required??[],additionalProperties:false};
      value.schema=intersect(value.struct.array?{type:'array',items:struct}:struct,value.schema);
    }
    value.schema=schema(value.schema);
    if(!value.schema.type&&!value.schema.anyOf&&!value.schema.oneOf)throw new Error('Property requires a concrete value schema');
    if(value.derived&&value.required)throw new Error('Derived properties must be optional stored properties');
    if(value.format){
      const format=value.format;
      if(format.kind==='currency'&&!format.currency)throw new Error('Currency formatting requires a currency');
      if(format.kind==='date')new Intl.DateTimeFormat(format.locale);
      else if(format.kind!=='text')new Intl.NumberFormat(format.locale,{minimumFractionDigits:format.minimumFractionDigits,maximumFractionDigits:format.maximumFractionDigits,style:format.kind==='currency'?'currency':format.kind==='percent'?'percent':'decimal',currency:format.currency});
    }
    return value;
  };
  for(const value of values.values())schema(value.schema,[value.apiName+'@'+value.version]);
  for(const struct of structs.values())compileProperty({description:struct.description,schema:{},required:false,struct:{type:struct.apiName}});
  for(const sharedProperty of shared.values())compileProperty(sharedProperty,[sharedProperty.apiName]);
  for(const type of [...document.objectTypes,...document.interfaceTypes])type.properties=Object.fromEntries(Object.entries(type.properties).map(([name,property])=>[name,compileProperty(property)]));
  for(const fn of document.functionTypes){fn.parameters=schema(fn.parameters);fn.returns=schema(fn.returns);}
  for(const action of document.actionTypes)action.parameters=schema(action.parameters);
  for(const contract of document.interfaceTypes)for(const action of Object.values(contract.actions))action.parameters=schema(action.parameters);

  const interfaces=indexed(document.interfaceTypes), expanded=new Map<string,Interface>();
  const memberDigest=(value:unknown)=>digest(value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='description')):value);
  const expand=(name:string,visiting:string[]=[]):Interface=>{
    if(visiting.includes(name))throw new Error('Interface inheritance cycle');
    const ready=expanded.get(name);if(ready)return ready;
    const own=interfaces.get(name);if(!own)throw new Error('Unknown parent Interface '+name);
    const result:Interface={...own,properties:{},links:{},actions:{},optionalProperties:[]};
    const optional=new Map<string,boolean>();
    for(const current of [...(own.extends??[]).map(parent=>expand(parent,[...visiting,name])),own]){
      for(const field of ['properties','links','actions'] as const){
        for(const [alias,member] of Object.entries(current[field])){
          const old=result[field][alias];
          if(old&&memberDigest(old)!==memberDigest(member))throw new Error('Conflicting inherited Interface member '+name+'.'+alias);
          Object.assign(result[field],{[alias]:member});
        }
      }
      for(const alias of Object.keys(current.properties)){
        const isOptional=current.optionalProperties.includes(alias),previous=optional.get(alias);
        if(previous!==undefined&&previous!==isOptional)throw new Error('Conflicting inherited Interface optionality '+name+'.'+alias);
        optional.set(alias,isOptional);
      }
      for(const alias of current.optionalProperties)if(!current.properties[alias])throw new Error('Unknown optional Interface property');
    }
    result.optionalProperties=[...optional].filter(([,value])=>value).map(([name])=>name);
    expanded.set(name,result);return result;
  };
  document.interfaceTypes=document.interfaceTypes.map(type=>expand(type.apiName));
  for(const type of document.objectTypes){
    for(const [name,mapping] of Object.entries({...type.interfaces})){
      const visit=(interfaceName:string)=>{
        const contract=expanded.get(interfaceName);if(!contract)throw new Error('Unknown implemented Interface '+interfaceName);
        for(const parent of contract.extends??[]){
          const shape=expanded.get(parent)!;
          const inherited={properties:Object.fromEntries(Object.entries(mapping.properties).filter(([alias])=>shape.properties[alias])),links:Object.fromEntries(Object.entries(mapping.links).filter(([alias])=>shape.links[alias])),actions:Object.fromEntries(Object.entries(mapping.actions).filter(([alias])=>shape.actions[alias]))};
          if(type.interfaces[parent]&&digest(type.interfaces[parent])!==digest(inherited))throw new Error('Conflicting inherited Interface implementation');
          type.interfaces[parent]=inherited;visit(parent);
        }
      };
      visit(name);
    }
  }
  const groups=indexed(document.typeGroups??[]), objectNames=new Set(document.objectTypes.map(type=>type.apiName));
  for(const group of groups.values())if(group.objectTypes.some(name=>!objectNames.has(name)))throw new Error('Type Group contains unknown object type');
  for(const type of document.objectTypes)for(const name of type.groups??[])if(!groups.has(name))throw new Error('Unknown Type Group');
  return document;
}

export function propertyDisplay(property:Property,value:unknown):unknown {
  if(value===null||value===undefined)return value;
  const struct=property.struct;
  if(struct?.array&&Array.isArray(value)){
    const reducer=struct.reducer;
    if(reducer){
      const rows=(reducer.op==='min'||reducer.op==='max')?value.filter(row=>row?.[reducer.field!]!==undefined&&row?.[reducer.field!]!==null):[...value];
      if(reducer.op==='min'||reducer.op==='max')rows.sort((left,right)=>{
        const a=left?.[reducer.field!],b=right?.[reducer.field!];return a===b?0:a<b?-1:1;
      });
      value=reducer.op==='last'||reducer.op==='max'?rows.at(-1):rows[0];
    }
  }
  if(struct?.mainField&&value&&typeof value==='object'&&!Array.isArray(value))value=Reflect.get(value,struct.mainField);
  if(!property.format||value===null||value===undefined)return value;
  const format=property.format;
  if(format.kind==='date')return new Intl.DateTimeFormat(format.locale).format(new Date(String(value)));
  if(format.kind==='text')return String(value);
  return new Intl.NumberFormat(format.locale,{style:format.kind==='currency'?'currency':format.kind==='percent'?'percent':'decimal',currency:format.currency,minimumFractionDigits:format.minimumFractionDigits,maximumFractionDigits:format.maximumFractionDigits}).format(Number(value));
}
