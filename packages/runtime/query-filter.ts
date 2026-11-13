import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { canonical, Conflict } from '../core/identity.js';
import type { ObjectData } from '../ontology/schema.js';

export const propertyPathSchema = z.string().min(1).max(500).regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/);
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type Predicate =
  | { op:'all'; predicates:Predicate[] }
  | { op:'any'; predicates:Predicate[] }
  | { op:'not'; predicate:Predicate }
  | { op:'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'contains'|'text'|'regex'; property:string; value:string|number|boolean|null }
  | { op:'in'; property:string; values:(string|number|boolean|null)[] };
const recursivePredicate: z.ZodType<Predicate> = z.lazy(() => z.discriminatedUnion('op', [
  z.strictObject({op:z.enum(['all','any']),predicates:z.array(recursivePredicate).min(1).max(30)}),
  z.strictObject({op:z.literal('not'),predicate:recursivePredicate}),
  z.strictObject({op:z.enum(['eq','ne','contains']),property:propertyPathSchema,value:scalar}),
  z.strictObject({op:z.enum(['gt','gte','lt','lte']),property:propertyPathSchema,value:z.union([z.string(),z.number().finite()])}),
  z.strictObject({op:z.literal('text'),property:propertyPathSchema,value:z.string().min(1).max(32000)}),
  z.strictObject({op:z.literal('regex'),property:propertyPathSchema,value:z.string().max(256)}),
  z.strictObject({op:z.literal('in'),property:propertyPathSchema,values:z.array(scalar).max(100)}),
]));
export const predicateSchema = z.unknown().refine(input=>{
  const pending=[{input,depth:0}];let nodes=0;
  while(pending.length){
    const current=pending.pop()!;
    if(++nodes>10000||current.depth>40)return false;
    if(Array.isArray(current.input))pending.push(...current.input.map(input=>({input,depth:current.depth+1})));
    else if(current.input&&typeof current.input==='object')pending.push(...Object.values(current.input).map(input=>({input,depth:current.depth+1})));
  }
  return true;
},'Filter is too large or deeply nested').pipe(recursivePredicate);
export const orderSchema = z.array(z.strictObject({property:propertyPathSchema,direction:z.enum(['asc','desc']).default('asc')})).min(1).max(5);
export function predicateFields(predicate?: Predicate): string[] {
  if (!predicate) return [];
  const fields = new Set<string>(), pending = [{predicate,depth:0}];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 100 || current.depth > 12) throw new Conflict('Filter exceeds its expression limit');
    const value = current.predicate;
    if (value.op === 'all' || value.op === 'any') pending.push(...value.predicates.map(predicate => ({predicate,depth:current.depth+1})));
    else if (value.op === 'not') pending.push({predicate:value.predicate,depth:current.depth+1});
    else fields.add(value.property);
  }
  return [...fields];
}
export function nestedValue(properties: Record<string, unknown>, path: string): unknown {
  let value: unknown = properties;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value,key)) return null;
    value = Reflect.get(value,key);
  }
  return value ?? null;
}
const regexKey = (pattern:string,value:string) => canonical([pattern,value]);

/** User regexes execute in a worker with a deadline so pathological patterns cannot block the server. */
export async function regexMatches(predicate: Predicate | undefined, objects: ObjectData[]): Promise<Map<string,boolean>> {
  if (!predicate) return new Map();
  predicateFields(predicate);
  const predicates: Predicate[] = [predicate], expressions: {property:string;value:string}[] = [];
  while (predicates.length) {
    const item = predicates.pop()!;
    if (item.op === 'all' || item.op === 'any') predicates.push(...item.predicates);
    else if (item.op === 'not') predicates.push(item.predicate);
    else if (item.op === 'regex') {
      if (typeof item.value !== 'string' || item.value.length > 256) throw new Conflict('Regex patterns must be strings of at most 256 characters');
      try { new RegExp(item.value,'u'); } catch { throw new Conflict('Invalid regular expression'); }
      expressions.push({property:item.property,value:item.value});
    }
  }
  if (!expressions.length) return new Map();
  const cases = new Map<string,{pattern:string;text:string}>();
  for (const expression of expressions) for (const object of objects) {
    const value = nestedValue(object.properties,expression.property);
    if (typeof value !== 'string') continue;
    if (value.length > 65536) throw new Conflict('Regex input exceeds 65536 characters');
    cases.set(regexKey(expression.value,value),{pattern:expression.value,text:value});
    if (cases.size > 50000) throw new Conflict('Regex evaluation exceeds 50000 distinct comparisons');
  }
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');parentPort.on('message',items=>{try{const compiled=new Map();parentPort.postMessage({matches:items.map(({pattern,text})=>{let re=compiled.get(pattern);if(!re){re=new RegExp(pattern,'u');compiled.set(pattern,re);}return re.test(text);})});}catch(error){parentPort.postMessage({error:'Invalid regular expression'});}});`,{eval:true});
  try {
    const matches = await new Promise<boolean[]>((resolve,reject) => {
      const timer = setTimeout(() => reject(new Conflict('Regex evaluation exceeded its one-second deadline')),1000);
      worker.once('error',error => {clearTimeout(timer);reject(error);});
      worker.once('message',(message:{matches?:boolean[];error?:string})=>{clearTimeout(timer);if(message.error)reject(new Conflict(message.error));else resolve(message.matches!);});
      worker.postMessage([...cases.values()]);
    });
    return new Map([...cases.keys()].map((key,index)=>[key,matches[index]!]));
  } finally { await worker.terminate(); }
}
export function matchesPredicate(predicate:Predicate, properties:Record<string,unknown>, regex:Map<string,boolean>):boolean {
  if (predicate.op==='all') return predicate.predicates.every(item=>matchesPredicate(item,properties,regex));
  if (predicate.op==='any') return predicate.predicates.some(item=>matchesPredicate(item,properties,regex));
  if (predicate.op==='not') return !matchesPredicate(predicate.predicate,properties,regex);
  const value=nestedValue(properties,predicate.property);
  if(predicate.op==='in')return predicate.values.some(candidate=>canonical(value)===canonical(candidate));
  const expected=predicate.value;
  if(predicate.op==='eq')return canonical(value)===canonical(expected);
  if(predicate.op==='ne')return canonical(value)!==canonical(expected);
  if(predicate.op==='contains')return typeof value==='string'&&typeof expected==='string'?value.includes(expected):Array.isArray(value)&&value.some(item=>canonical(item)===canonical(expected));
  if(predicate.op==='text')return typeof value==='string'&&typeof expected==='string'&&expected.trim().length>0&&expected.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).every(term=>value.normalize('NFKC').toLowerCase().includes(term));
  if(predicate.op==='regex')return typeof value==='string'&&typeof expected==='string'&&regex.get(regexKey(expected,value))===true;
  if(value===null || expected===null || typeof value!==typeof expected || !['number','string'].includes(typeof value))return false;
  const compared=compareValues(value,expected);
  if(predicate.op==='gt')return compared>0;
  if(predicate.op==='gte')return compared>=0;
  if(predicate.op==='lt')return compared<0;
  return compared<=0;
}
export function compareValues(left:unknown,right:unknown):number {
  if(left===null||left===undefined)return right===null||right===undefined?0:1;
  if(right===null||right===undefined)return -1;
  if(typeof left!==typeof right||!['string','number','boolean'].includes(typeof left))throw new Conflict('Ordering requires comparable scalar properties');
  return left<right?-1:left>right?1:0;
}
