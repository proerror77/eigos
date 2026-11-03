import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import type { ObjectRef } from '../model.js';
import type { OntologyObjectStore, ObjectView } from '../object-store.js';
import { PACKAGE_STUDY_ONTOLOGY, PACKAGE_STUDY_FUNCTION, createPackageStudyModel } from './model.js';
import { isPublishedPackageStudyModel } from './pipeline-model.js';
import type { PipelineFactStore } from '../pipeline/facts.js';
import { requestSchema, skuSchema, componentSchema, quoteSchema, inventorySchema, entitlementSchema, resourceSchema, prerequisiteSchema,
  type Request, type Sku, type Component, type Quote, type Inventory, type Entitlement, type Demand, type Prerequisite } from './contracts.js';

export const refKey = (ref: ObjectRef) => JSON.stringify([ref.type,ref.id]);
export const sameRef = (a: ObjectRef,b: ObjectRef) => refKey(a)===refKey(b);
export const day = (date: string, offset: number) => new Date(Date.parse(date+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
export const nightsBetween = (a: string,b: string) => (Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000;
const fail = (message: string): never => {throw new DomainError('INVALID_INPUT',message);};
export interface ComponentNode { ref: ObjectRef; data: Component; roomTypes: ObjectRef[]; entitlement?: ObjectRef; ratePlan?: ObjectRef; rateRoomType?:ObjectRef }
export interface SkuNode { ref: ObjectRef; data: Sku; variant: ObjectView; components: ComponentNode[]; prerequisites: Prerequisite[] }
export interface PoolNode { ref: ObjectRef; data: Inventory; roomTypes: ObjectRef[]; skus: ObjectRef[]; entitlement?: ObjectRef }
export interface QuoteNode { ref: ObjectRef; data: Quote; sku: ObjectRef; roomType?: ObjectRef; resources: {pool:ObjectRef;quantity:number;component?:ObjectRef}[] }
export interface Study {
  requestRef:ObjectRef;request:Request;catalog:ObjectRef;catalogComplete:boolean;hotel:ObjectView;roomTypes:Map<string,ObjectView>;
  skus:Map<string,SkuNode>;pools:Map<string,PoolNode>;quotes:QuoteNode[];entitlements:Map<string,{ref:ObjectRef;data:Entitlement}>;
  demands:Demand[];inputDigest:string;modelDigest:string;now:number;reader:StudyReader;
}
export interface PipelineStudyContext {
  facts: PipelineFactStore;
  intakeDigest: string;
  sourceId: string;
  assertCurrent: () => void;
}
/** Uses ordinary owned reads, without integrity bypasses or production writes. */
export class StudyReader {
  private objects=new Map<string,ObjectView>();
  private links=new Map<string,{from:ObjectRef;name:string;to:ObjectRef[]}>();
  private budget={remaining:50000};
  readonly revision:number;
  datasetId:string|undefined;
  constructor(readonly graph:OntologyObjectStore,readonly owner:string,readonly pipeline?:PipelineStudyContext){
    const direct=graph.model.ref.digest===createPackageStudyModel().ref.digest&&graph.model.functionIds().includes(PACKAGE_STUDY_FUNCTION);
    if(graph.ontologyId!==PACKAGE_STUDY_ONTOLOGY || !(pipeline&&graph.releaseRef?isPublishedPackageStudyModel(graph.model):direct)) fail('Only the registered synthetic package-study ontology is accepted');
    pipeline?.assertCurrent();
    this.revision=graph.revision(owner);
  }
  read(ref:ObjectRef):ObjectView{
    const key=refKey(ref),cached=this.objects.get(key);if(cached)return cached;
    return this.remember(this.graph.read(this.owner,ref,this.budget));
  }
  private remember(value:ObjectView):ObjectView{
    if(value.tombstone)fail('Tombstoned package facts are unavailable');
    if(value.source.kind!=='synthetic' || Date.parse(value.source.observedAt)>this.graph.now()) fail('Package test optimization requires current synthetic provenance');
    this.checkSource(value);
    const key=refKey(value.ref),previous=this.objects.get(key);
    if(previous&&previous.revision!==value.revision)throw new DomainError('CONFLICT','Synthetic package facts changed during the read');
    this.objects.set(key,value);return value;
  }
  private checkSource(value:ObjectView){
    if(this.pipeline){
      const fact=this.pipeline.facts.current(this.owner,this.graph.ontologyId,value.ref);
      if(!fact)return fail('Synthetic pipeline fact is missing from this published study');
      if(fact.health!=='fresh'||fact.evidenceLevel!=='synthetic'||fact.intakeDigest!==this.pipeline.intakeDigest
        ||fact.sourceId!==this.pipeline.sourceId||digest(fact.release)!==digest(this.graph.releaseRef)
        ||digest(fact.properties)!==digest(value.properties)||this.datasetId&&this.datasetId!==fact.sourceId) fail('Synthetic pipeline fact is stale, conflicted or outside this published study');
      if(fact.relationshipDigest){
        const links=(fact.relationshipTypes??[]).flatMap(type=>{
          const targets=this.graph.related(this.owner,value.ref,this.graph.model.link(type).from.name,this.budget);
          if(!targets)throw new DomainError('CONFLICT','Pipeline relationship read is incomplete');
          return targets.map(target=>({type,from:value.ref,to:target.ref}));
        }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
        if(digest(links)!==fact.relationshipDigest)fail('Synthetic pipeline relationships differ from the mapped observation');
      }
    }else if(this.datasetId&&value.source.id!==this.datasetId)fail('A package object belongs to a different synthetic dataset');
  }
  related(ref:ObjectRef,name:string,max=200):ObjectView[]{
    const key=refKey(ref)+':'+name;
    this.read(ref);
    const cached=this.links.get(key);
    if(cached){
      if(cached.to.length>max)throw new DomainError('CONFLICT','Package relationship read exceeds its bound');
      return cached.to.map(to=>this.objects.get(refKey(to))!);
    }
    const values=this.graph.related(this.owner,ref,name,this.budget);
    if(!values || values.length>max) throw new DomainError('CONFLICT','Package relationship read is incomplete or exceeds its bound');
    // related() already returns owned, projected ObjectViews. Validate their
    // provenance here instead of fetching every target again (N+1).
    const result=values.map(v=>this.remember(v)).sort((a,b)=>refKey(a.ref).localeCompare(refKey(b.ref)));
    this.links.set(key,{from:ref,name,to:result.map(v=>v.ref)});return result;
  }
  one(ref:ObjectRef,name:string,required=true):ObjectView|undefined{
    const values=this.related(ref,name,1);
    if(values.length!==1){if(required)fail('A required package relationship is missing');return;}
    return values[0];
  }
  snapshot():string{
    if(this.graph.revision(this.owner)!==this.revision) throw new DomainError('CONFLICT','Synthetic package facts changed during the read');
    this.pipeline?.assertCurrent();
    for(const view of this.objects.values())this.checkSource(view);
    return digest({model:this.graph.model.ref,owner:digest(this.owner),dataset:this.datasetId,
      objects:[...this.objects.values()].sort((a,b)=>refKey(a.ref).localeCompare(refKey(b.ref))).map(v=>({ref:v.ref,revision:v.revision,properties:v.properties,source:v.source})),
      links:[...this.links.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,value])=>value),
      ...(this.pipeline?{pipeline:{release:this.graph.releaseRef,intakeDigest:this.pipeline.intakeDigest,
        facts:[...this.objects.values()].sort((a,b)=>refKey(a.ref).localeCompare(refKey(b.ref))).map(v=>this.pipeline!.facts.current(this.owner,this.graph.ontologyId,v.ref))}}:{})});
  }
}
const data = <T>(view:ObjectView,schema:z.ZodType<T>):T => schema.parse(view.properties.data);
export function readStudy(graph:OntologyObjectStore,owner:string,requestRef:ObjectRef,pipeline?:PipelineStudyContext):Study{
  if(requestRef.type!=='HotelPackageRequest')fail('Expected a synthetic package optimization request');
  const reader=new StudyReader(graph,owner,pipeline),requestView=reader.read(requestRef),request=data(requestView,requestSchema);
  const catalogView=reader.one(requestRef,'study')!,catalogData=z.strictObject({datasetId:z.string(),evidenceLevel:z.literal('synthetic'),completeness:z.enum(['complete','partial'])}).parse(catalogView.properties.data);
  reader.datasetId=catalogData.datasetId;
  if(pipeline?reader.datasetId!==pipeline.sourceId:requestView.source.id!==reader.datasetId || catalogView.source.id!==reader.datasetId)fail('Request and catalog have different dataset identities');
  const hotel=reader.one(requestRef,'hotel')!,roomTypes=new Map(reader.related(requestRef,'roomTypes',8).map(v=>[refKey(v.ref),v]));
  const nights=nightsBetween(request.checkIn,request.checkOut);
  if(nights<1 || nights>7 || !roomTypes.size)fail('Synthetic package studies support one hotel, one to seven nights and explicit room choices');
  for(const room of roomTypes.values()){
    const parent=reader.one(room.ref,'hotel');if(!parent || !sameRef(parent.ref,hotel.ref))fail('An accepted room type does not belong to the requested hotel');
  }
  const entitlements=new Map<string,{ref:ObjectRef;data:Entitlement}>();
  const entitlementRefs=new Map<string,{ref:ObjectRef;data:Entitlement}>();
  for(const view of reader.related(catalogView.ref,'entitlements',20)){
    const value={ref:view.ref,data:data(view,entitlementSchema)};
    if(entitlements.has(value.data.code))fail('Entitlement codes must be unique in a study');
    entitlements.set(value.data.code,value);entitlementRefs.set(refKey(view.ref),value);
  }
  const skuViews=reader.related(catalogView.ref,'skus',30),skus=new Map<string,SkuNode>();
  const products=new Set(reader.related(catalogView.ref,'products',30).map(v=>refKey(v.ref)));
  const variantIds=new Set<string>();
  for(const view of skuViews){
    const value=data(view,skuSchema),variant=reader.one(view.ref,'variant')!;
    if(variantIds.has(refKey(variant.ref)))fail('A study cannot contain two active specifications for one SKU');
    variantIds.add(refKey(variant.ref));
    if(variant.properties.specificationRevision!==value.version)fail('SKU and canonical variant specification versions differ');
    const product=reader.one(variant.ref,'packageProduct')!;
    if(!products.has(refKey(product.ref)))fail('SKU product is outside this catalog');
    const components=reader.related(view.ref,'components',10).map(c=>{
      const spec=data(c,componentSchema),rooms=reader.related(c.ref,'roomTypes',8).map(r=>r.ref);
      const entitlement=reader.one(c.ref,'entitlement',false)?.ref,ratePlan=reader.one(c.ref,'ratePlan',false)?.ref;
      if(spec.kind==='stay' && entitlement || spec.kind==='benefit' && (rooms.length || ratePlan))fail('Package component mixes lodging and non-lodging identities');
      if(entitlement && !entitlementRefs.has(refKey(entitlement)))fail('Package entitlement is outside this catalog');
      for(const room of rooms){
        const parent=reader.one(room,'hotel')!;if(!sameRef(parent.ref,hotel.ref))fail('A SKU component is attached to a different hotel');
      }
      let rateRoomType:ObjectRef|undefined;
      if(ratePlan){
        const rateHotel=reader.one(ratePlan,'hotel')!,rateRoom=reader.one(ratePlan,'roomType')!;
        if(!sameRef(rateHotel.ref,hotel.ref) || !rooms.some(r=>sameRef(r,rateRoom.ref)))fail('Package rate plan and room mappings disagree');
        rateRoomType=rateRoom.ref;
      }
      return{ref:c.ref,data:spec,roomTypes:rooms,...(entitlement?{entitlement}:{}),...(ratePlan?{ratePlan}:{}),...(rateRoomType?{rateRoomType}:{})};
    });
    if(value.category==='activation' && components.length || value.category!=='activation' && !components.length && value.termsKnown)fail('Activation and fulfillment SKU components are inconsistent');
    const prerequisites=reader.related(view.ref,'prerequisites',10).map(p=>({...data(p,prerequisiteSchema),sku:reader.one(p.ref,'sku')!.ref}));
    const dependencyKeys=prerequisites.map(p=>digest({sku:p.sku,scope:p.scope,anchor:p.anchor,dayOffset:p.dayOffset,phase:p.phase}));
    if(new Set(dependencyKeys).size!==dependencyKeys.length)fail('Duplicate prerequisite predicates must be resolved explicitly');
    skus.set(refKey(view.ref),{ref:view.ref,data:value,variant,components,prerequisites});
  }
  for(const sku of skus.values())for(const p of sku.prerequisites)if(!skus.has(refKey(p.sku)))fail('A prerequisite SKU is outside the study');
  const visited=new Set<string>(),active=new Set<string>();
  function visit(key:string){if(active.has(key))fail('Package prerequisite graph contains a cycle');if(visited.has(key))return;active.add(key);for(const p of skus.get(key)!.prerequisites)visit(refKey(p.sku));active.delete(key);visited.add(key);}
  for(const key of skus.keys())visit(key);
  const pools=new Map<string,PoolNode>();
  for(const view of reader.related(catalogView.ref,'pools',100)){
    const value=data(view,inventorySchema),rooms=reader.related(view.ref,'roomTypes',8).map(v=>v.ref),allowed=reader.related(view.ref,'skus',30).map(v=>v.ref);
    const entitlement=reader.one(view.ref,'entitlement',false)?.ref;
    if(allowed.some(v=>!skus.has(refKey(v))) || entitlement && !entitlementRefs.has(refKey(entitlement)))fail('Inventory references an object outside the catalog');
    if(value.kind==='room' && value.unit!=='room_night' || value.kind==='sale' && value.unit!=='package' || value.kind==='promotion' && value.unit!=='coupon_use')fail('Inventory quantity has an incompatible unit');
    pools.set(refKey(view.ref),{ref:view.ref,data:value,roomTypes:rooms,skus:allowed,...(entitlement?{entitlement}:{})});
  }
  const quotes:QuoteNode[]=[];
  for(const view of reader.related(catalogView.ref,'quotes',100)){
    const value=data(view,quoteSchema),sku=reader.one(view.ref,'sku')!.ref,roomType=reader.one(view.ref,'roomType',false)?.ref;
    const specification=skus.get(refKey(sku));if(!specification)fail('Quote SKU is outside the catalog');
    const resources=reader.related(view.ref,'resourceUses',50).map(u=>{
      const use=data(u,resourceSchema),pool=reader.one(u.ref,'pool')!.ref,component=reader.one(u.ref,'component',false)?.ref;
      if(!pools.has(refKey(pool)))fail('Quote inventory is outside the catalog');
      if(use.condition==='with_component' && !component || use.condition==='always' && component
        || component && !specification!.components.some(c=>sameRef(c.ref,component)))fail('Conditional inventory use has no matching SKU component');
      return{pool,quantity:use.quantity,...(component?{component}:{})};
    });
    quotes.push({ref:view.ref,data:value,sku,...(roomType?{roomType}:{}),resources});
  }
  const demands:Demand[]=[];
  for(let roomIndex=0;roomIndex<request.rooms.length;roomIndex++)for(let n=0;n<nights;n++){
    const date=day(request.checkIn,n);demands.push({key:`room:${roomIndex}:${date}`,kind:'room',roomIndex,date,unit:'room_night',quantity:1});
  }
  const benefitKeys=new Set<string>();
  for(const item of request.benefits){
    if(item.roomIndex>=request.rooms.length || item.date<request.checkIn || item.date>request.checkOut)fail('Benefit requirement is outside the requested stay');
    const definition=entitlements.get(item.code);if(!definition)fail('Requested benefit has no ontology definition');
    const key=`benefit:${item.roomIndex}:${item.date}:${item.code}`;if(benefitKeys.has(key))fail('Duplicate benefit requirements must be combined explicitly');benefitKeys.add(key);
    demands.push({key,kind:'benefit',...item,unit:definition!.data.unit});
  }
  return{requestRef,request,catalog:catalogView.ref,catalogComplete:catalogData.completeness==='complete',hotel,roomTypes,skus,pools,quotes,entitlements,demands,inputDigest:reader.snapshot(),modelDigest:graph.model.ref.digest,now:graph.now(),reader};
}
