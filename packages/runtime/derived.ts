import { Conflict, digest } from '../core/identity.js';
import { validator } from '../ontology/model.js';
import type { DerivedExpression, ObjectData, ObjectRef } from '../ontology/schema.js';
import type { Objects } from './objects.js';
import { nestedValue, propertyPathSchema } from './query-filter.js';

/** One evaluation shares authorized reads and detects cycles across linked and local properties. */
export class DerivedProperties {
  private readonly objects = new Map<string,ObjectData>();
  private readonly values = new Map<string,unknown>();
  private operations = 0;
  constructor(private readonly graph:Objects) {}
  private consume() { if(++this.operations>50000)throw new Conflict('Derived property evaluation exceeds its work limit'); }
  async enrich(object:ObjectData):Promise<ObjectData> {
    this.objects.set(digest(object.ref),object);
    const properties={...object.properties};
    for(const [name,definition] of Object.entries(this.graph.model.object(object.ref.type).properties)) {
      if(definition.derived)properties[name]=await this.field(object.ref,name,new Set());
    }
    return {...object,properties};
  }
  private async base(ref:ObjectRef) {
    const key=digest(ref);
    if(!this.objects.has(key)){this.consume();this.objects.set(key,await this.graph.readStored(ref));}
    return this.objects.get(key)!;
  }
  private async field(ref:ObjectRef,path:string,stack:Set<string>):Promise<unknown> {
    propertyPathSchema.parse(path);
    const [name,...nested]=path.split('.'),definition=this.graph.model.object(ref.type).properties[name!];
    if(!definition)throw new Conflict('Derived expression references an unknown property');
    const object=await this.base(ref);
    if(!definition.derived)return nestedValue(object.properties,path);
    const key=digest([ref,name]);
    if(stack.has(key)||stack.size>=16)throw new Conflict('Derived property dependency cycle or depth limit');
    if(!this.values.has(key)) {
      this.consume();
      const allowed=await this.graph.propertyVisible(ref,name!);
      const value=allowed?await this.calculate(ref,definition.derived,new Set([...stack,key]),0):null;
      this.values.set(key,value===null?null:validator(definition.schema).parse(value));
    }
    const value=this.values.get(key);
    return nested.length?nestedValue({value},'value.'+nested.join('.')):value;
  }
  private async calculate(ref:ObjectRef,expression:DerivedExpression,stack:Set<string>,depth:number):Promise<unknown> {
    this.consume();
    if(depth>16)throw new Conflict('Derived arithmetic exceeds its depth limit');
    if(expression.op==='literal')return expression.value;
    if(expression.op==='property')return this.field(ref,expression.property,stack);
    if(expression.op==='linked') {
      let current=new Map([[digest(ref),await this.base(ref)]]);
      for(const step of expression.path) {
        const next=new Map<string,ObjectData>();
        for(const source of current.values()) {
          const nav=this.graph.model.navigation(source.ref.type,step.link,step.as);
          let cursor:string|undefined;
          do {
            this.consume();
            const page=await this.graph.queryStored({type:nav.target,from:{object:source.ref,link:step.link,as:step.as},limit:100,cursor});
            for(const object of page.items){next.set(digest(object.ref),object);this.objects.set(digest(object.ref),object);}
            if(next.size>10000)throw new Conflict('Derived relationship exceeds 10000 objects');
            cursor=page.cursor;
          }while(cursor);
        }
        current=next;
      }
      if(expression.aggregate==='count')return current.size;
      if(!expression.property)throw new Conflict('Linked value aggregation requires a property');
      const values=await Promise.all([...current.values()].map(object=>this.field(object.ref,expression.property!,stack)));
      if(expression.aggregate==='select') {
        if(values.length>1)throw new Conflict('Derived select requires at most one linked object');
        return values[0]??null;
      }
      const present=values.filter(value=>value!==null);
      if(!present.length)return null;
      if(present.some(value=>typeof value!=='number'||!Number.isFinite(value)))throw new Conflict('Derived aggregation requires finite numeric values');
      const numbers=present as number[];
      if(expression.aggregate==='min')return Math.min(...numbers);
      if(expression.aggregate==='max')return Math.max(...numbers);
      const total=numbers.reduce((sum,value)=>sum+value,0);
      const result=expression.aggregate==='avg'?total/numbers.length:total;
      if(!Number.isFinite(result))throw new Conflict('Derived aggregation overflow');
      return result;
    }
    const [left,right]=await Promise.all([this.calculate(ref,expression.left,stack,depth+1),this.calculate(ref,expression.right,stack,depth+1)]);
    if(left===null||right===null)return null;
    if(typeof left!=='number'||typeof right!=='number')throw new Conflict('Derived arithmetic requires numbers');
    if(expression.op==='divide'&&right===0)return null;
    const value=expression.op==='add'?left+right:expression.op==='subtract'?left-right:expression.op==='multiply'?left*right:left/right;
    if(!Number.isFinite(value))throw new Conflict('Derived arithmetic overflow');
    return value;
  }
}
