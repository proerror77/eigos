import { DatabaseSync } from 'node:sqlite';
import { OntologyObjectStore, type ObjectWrite, type LinkWrite } from '../object-store.js';
import type { ObjectRef } from '../model.js';
import { createPackageStudyModel, PACKAGE_STUDY_ONTOLOGY } from './model.js';
import { componentSchema, quoteSchema, skuSchema, inventorySchema, prerequisiteSchema, type Request, type Component, type Quote, type Inventory, type Prerequisite } from './contracts.js';

export interface StudyFixture {
  environment:'synthetic'; id:string; now?:string; completeness?:'complete'|'partial';
  roomTypes?:{id:string;adults?:number;children?:number;capacity?:number}[];
  entitlements?:{code:string;unit?:'person_use'|'ride';inventoryRequired?:boolean}[];
  skus:{id:string;productId?:string;version?:string;category?:'room'|'bundle'|'benefit'|'activation';maxUnits?:number|null;
    saleState?:'available'|'unavailable'|'unknown';eligibility?:'eligible'|'ineligible'|'unknown';termsKnown?:boolean;platformCommissionMinor?:string|null;
    components:(Component&{id?:string;roomTypes?:string[];entitlement?:string})[];
    prerequisites?:{sku:string;quantity?:number;basis?:Prerequisite['basis'];scope?:Prerequisite['scope'];anchor?:Prerequisite['anchor'];dayOffset?:number;phase?:Prerequisite['phase']}[];
  }[];
  pools:{id:string;kind:Inventory['kind'];capacity:number|null;state?:Inventory['state'];date?:string|null;unit?:Inventory['unit'];expiresAt?:string;roomTypes?:string[];skus?:string[];entitlement?:string}[];
  quotes:{id:string;sku:string;anchorDate:string;amountMinor:string|null;roomType?:string;skuVersion?:string;variantRevision?:number;
    currency?:string;priceKind?:Quote['priceKind'];feesKnown?:boolean;fees?:Quote['fees'];discount?:Quote['discount'];guest?:Quote['guest'];availability?:Quote['availability'];cancellation?:Quote['cancellation'];expiresAt?:string;
    resources:{pool:string;quantity?:number;component?:string}[];
  }[];
  request:Pick<Request,'checkIn'|'checkOut'>&Partial<Omit<Request,'checkIn'|'checkOut'>> & {roomTypes?:string[]};
}
/** Explicit test-data factory. Its defaults intentionally construct known
 * synthetic assumptions; it is not an adapter for supplier search results. */
export function createSyntheticPackageStudy(fixture:StudyFixture){
  if(fixture.environment!=='synthetic')throw new Error('Only explicit synthetic fixtures are accepted');
  const db=new DatabaseSync(':memory:'),model=createPackageStudyModel(),now=Date.parse(fixture.now??'2030-01-01T00:00:00Z');let clock=now;
  const graph=new OntologyObjectStore(db,model,()=>clock,undefined,{ontologyId:PACKAGE_STUDY_ONTOLOGY,skipLegacyMigration:true});
  const owner='synthetic-package-study-owner',source={kind:'synthetic' as const,id:fixture.id,observedAt:new Date(now).toISOString()},expiresAt=new Date(now+3600000).toISOString();
  const objects:ObjectWrite[]=[],links:LinkWrite[]=[],refs=new Map<string,ObjectRef>();
  const ref=(type:string,id:string):ObjectRef=>({type,id:`${fixture.id}:${id}`});
  const add=(type:string,id:string,data:Record<string,unknown>,label=id)=>{
    const object=ref(type,id),definition=model.object(type),properties:Record<string,unknown>={[definition.primaryKey]:object.id,[definition.titleKey]:'Synthetic '+label,...data};
    if(definition.properties.displayTitle)properties.displayTitle='Synthetic '+label;
    objects.push({ref:object,properties});refs.set(type+':'+id,object);return object;
  };
  const edge=(type:string,from:ObjectRef,to:ObjectRef)=>links.push({type,from,to});
  const catalog=add('HotelPackageStudy','catalog',{data:{datasetId:fixture.id,evidenceLevel:'synthetic',completeness:fixture.completeness??'complete'}});
  const hotel=add('HotelProperty','hotel',{sourceId:'hotel',hotelName:'Synthetic hotel',address:'Synthetic address',timeZone:'Asia/Shanghai'});
  const roomDefs=fixture.roomTypes??[{id:'king',adults:2,children:0,capacity:2}];
  for(const room of roomDefs){const object=add('RoomType',room.id,{sourceId:room.id,roomTypeName:room.id,hotelId:hotel.id,maximumAdults:room.adults??2,maximumChildren:room.children??0,guestCapacity:room.capacity??2,bedDescription:'Synthetic bed'});edge('RoomTypeHotel',object,hotel);}
  const get=(type:string,id:string)=>{const value=refs.get(type+':'+id);if(!value)throw new Error(`Missing synthetic ${type} reference`);return value;};
  for(const e of fixture.entitlements??[]){const object=add('PackageEntitlement',e.code,{data:{code:e.code,unit:e.unit??'person_use',inventoryRequired:e.inventoryRequired??false}});edge('PackageStudyEntitlements',catalog,object);}
  const products=new Map<string,ObjectRef>();
  for(const sku of fixture.skus){
    const productId=sku.productId??sku.id;
    if(!products.has(productId)){const product=add('PackageProduct','product-'+productId,{data:{sourceProductId:productId}});products.set(productId,product);edge('PackageStudyProducts',catalog,product);}
    const variant=add('ProductVariant','variant-'+sku.id,{sourceProductRef:{namespace:'synthetic:hotel-packages',id:sku.id},specification:[{name:'native_sku',value:sku.id}],specificationRevision:sku.version??'1'},sku.id);
    edge('PackageVariantProduct',variant,products.get(productId)!);
    const specification=add('PackageSkuSpecification',sku.id,{data:skuSchema.parse({version:sku.version??'1',category:sku.category??'room',maxUnits:sku.maxUnits===undefined?1:sku.maxUnits,saleState:sku.saleState??'available',eligibility:sku.eligibility??'eligible',termsKnown:sku.termsKnown??true,platformCommissionMinor:sku.platformCommissionMinor??null})});
    edge('PackageStudySkus',catalog,specification);edge('PackageSkuVariant',specification,variant);
    for(let n=0;n<sku.components.length;n++){
      const component=sku.components[n]!,{id:sourceId,roomTypes,entitlement,...spec}=component;
      const componentId=sourceId??`${sku.id}-component-${n}`,object=add('PackageComponent',componentId,{data:componentSchema.parse(spec)});
      edge('PackageSkuComponents',specification,object);
      for(const room of roomTypes??(spec.kind==='stay'?[roomDefs[0]!.id]:[]))edge('PackageComponentRoomTypes',object,get('RoomType',room));
      if(entitlement)edge('PackageComponentEntitlement',object,get('PackageEntitlement',entitlement));
    }
  }
  for(const sku of fixture.skus)for(const [n,dependency]of (sku.prerequisites??[]).entries()){
    const object=add('PackagePrerequisite',`${sku.id}-dependency-${n}`,{data:prerequisiteSchema.parse({quantity:dependency.quantity??1,basis:dependency.basis??'per_plan',scope:dependency.scope??'study',anchor:dependency.anchor??'any',dayOffset:dependency.dayOffset??0,phase:dependency.phase??'purchase'})});
    edge('PackageSkuPrerequisites',get('PackageSkuSpecification',sku.id),object);edge('PackagePrerequisiteSku',object,get('PackageSkuSpecification',dependency.sku));
  }
  for(const pool of fixture.pools){
    const unit=pool.unit??({room:'room_night',sale:'package',promotion:'coupon_use',benefit:'person_use'} as const)[pool.kind];
    const object=add('PackageInventoryPool',pool.id,{data:inventorySchema.parse({kind:pool.kind,unit,state:pool.state??'known',capacity:pool.capacity,date:pool.date??null,expiresAt:pool.expiresAt??expiresAt})});edge('PackageStudyPools',catalog,object);
    for(const sku of pool.skus??[])edge('PackagePoolSkus',object,get('PackageSkuSpecification',sku));
    for(const room of pool.roomTypes??(pool.kind==='room'?[roomDefs[0]!.id]:[]))edge('PackagePoolRoomTypes',object,get('RoomType',room));
    if(pool.entitlement)edge('PackagePoolEntitlement',object,get('PackageEntitlement',pool.entitlement));
  }
  for(const quote of fixture.quotes){
    const sku=fixture.skus.find(s=>s.id===quote.sku)!;
    const object=add('PackageDatedQuote',quote.id,{data:quoteSchema.parse({skuVersion:quote.skuVersion??sku.version??'1',variantRevision:quote.variantRevision??1,anchorDate:quote.anchorDate,currency:quote.currency??fixture.request.currency??'CNY',priceKind:quote.priceKind??'exact',amountMinor:quote.amountMinor,feesKnown:quote.feesKnown??true,fees:quote.fees??[],discount:quote.discount??{state:'none',amountMinor:'0',limited:false},guest:quote.guest===undefined?{adults:2,childrenAges:[]}:quote.guest,availability:quote.availability??'available',cancellation:quote.cancellation??{state:'known',freeUntil:null},expiresAt:quote.expiresAt??expiresAt})});
    edge('PackageStudyQuotes',catalog,object);edge('PackageQuoteSku',object,get('PackageSkuSpecification',quote.sku));
    const hasStay=sku.components.some(c=>c.kind==='stay');
    if(quote.roomType||hasStay)edge('PackageQuoteRoomType',object,get('RoomType',quote.roomType??roomDefs[0]!.id));
    for(const [n,use]of quote.resources.entries()){
      const resource=add('PackageResourceUse',`${quote.id}-use-${n}`,{data:{quantity:use.quantity??1,condition:use.component?'with_component':'always'}});
      edge('PackageQuoteUses',object,resource);edge('PackageUsePool',resource,get('PackageInventoryPool',use.pool));
      if(use.component)edge('PackageUseComponent',resource,get('PackageComponent',use.component));
    }
  }
  const {roomTypes:acceptedRooms,...requestData}=fixture.request;
  const request=add('HotelPackageRequest','request',{data:{currency:'CNY',rooms:[{adults:2,childrenAges:[]}],benefits:[],allowSplitStay:true,allowRoomTypeChange:false,allowQualificationPurchases:true,cancellationAt:null,maxTotalMinor:null,maxPurchases:12,...requestData}});
  edge('PackageRequestStudy',request,catalog);edge('PackageRequestHotel',request,hotel);
  for(const room of acceptedRooms??roomDefs.map(r=>r.id))edge('PackageRequestRoomTypes',request,get('RoomType',room));
  if(objects.length>200||links.length>500){db.close();throw new Error('Synthetic fixture exceeds one bounded ontology import');}
  try{graph.ingest(owner,{objects,links},source);}catch(error){db.close();throw error;}
  return{graph,owner,request,catalog,refs,source,now,advance:(ms:number)=>{clock+=ms;},close:()=>db.close()};
}
