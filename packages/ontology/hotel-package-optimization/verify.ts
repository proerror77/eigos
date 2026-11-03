import { digest } from '../../core/delegation.js';
import type { ObjectRef } from '../model.js';
import type { OntologyObjectStore } from '../object-store.js';
import type { OptimizationResult, Plan, Realization } from './contracts.js';
import { day, nightsBetween, readStudy, refKey, sameRef, type Study } from './graph.js';

export interface PlanVerification { accepted:boolean; evidenceLevel:'synthetic'; bookable:false; optimalityReplayed:false; reasons:string[] }
/** Replays the supplied plan against current ontology facts, independently of
 * candidate generation and DFS. It verifies feasibility/cost/path, not that DFS
 * explored every alternative; small-catalog optimality has a separate oracle. */
export function verifySyntheticHotelPackagePlan(graph:OntologyObjectStore,owner:string,result:OptimizationResult):PlanVerification{
  const reasons:string[]=[],reject=(message:string)=>{if(!reasons.includes(message))reasons.push(message);};
  try{
    const study=readStudy(graph,owner,result.request);
    if(result.evidenceLevel!=='synthetic'||result.bookable!==false||result.executed!==false)reject('synthetic_boundary');
    if(result.modelDigest!==study.modelDigest||result.inputDigest!==study.inputDigest)reject('input_snapshot_changed');
    if(result.status==='optimal'&&(!result.search.complete||!result.search.catalogComplete||result.search.unknownCandidates))reject('unsupported_optimality_claim');
    if(['optimal','best_known'].includes(result.status)&&!result.plans.length)reject('missing_plan');
    if(!result.plans.length)reject('no_plan_to_replay');
    for(const plan of result.plans)replay(plan,study,reject);
  }catch{reject('invalid_or_unreadable_study');}
  return{accepted:reasons.length===0,evidenceLevel:'synthetic',bookable:false,optimalityReplayed:false,reasons};
}
function replay(plan:Plan,study:Study,reject:(message:string)=>void){
  if(plan.currency!==study.request.currency||plan.purchases.length>study.request.maxPurchases)reject('request_limits');
  const selected=[...plan.purchases].sort((a,b)=>a.id.localeCompare(b.id)),coverage=study.demands.map(()=>0),resources:Record<string,number>={},counts:Record<string,number>={},roomChoices:Record<number,string>={};
  const replayed:Realization[]=[];let total=0n;
  for(const purchase of selected){
    const quote=study.quotes.find(q=>sameRef(q.ref,purchase.quote)),sku=study.skus.get(refKey(purchase.sku));
    if(!quote||!sku||!sameRef(quote.sku,purchase.sku)||!sameRef(sku.variant.ref,purchase.variant)){reject('quote_sku_binding');continue;}
    const q=quote.data,s=sku.data,guest=study.request.rooms[purchase.roomIndex];
    counts[refKey(sku.ref)]=(counts[refKey(sku.ref)]??0)+1;
    if(s.saleState!=='available'||s.eligibility!=='eligible'||!s.termsKnown||s.maxUnits===null||counts[refKey(sku.ref)]!>s.maxUnits)reject('sku_not_eligible');
    if(q.skuVersion!==s.version||q.variantRevision!==sku.variant.revision||Date.parse(q.expiresAt)<=study.now||q.availability!=='available')reject('stale_or_unavailable_quote');
    if(q.currency!==study.request.currency||q.priceKind!=='exact'||q.amountMinor===null||!q.feesKnown||q.discount.state==='unknown'||q.discount.amountMinor===null)reject('price_not_exact');
    if(!guest||!q.guest||guest.adults!==q.guest.adults||digest([...guest.childrenAges].sort((a,b)=>a-b))!==digest([...q.guest.childrenAges].sort((a,b)=>a-b)))reject('party_mismatch');
    if(q.cancellation.state!=='known'||study.request.cancellationAt&&(!q.cancellation.freeUntil||Date.parse(q.cancellation.freeUntil)<Date.parse(study.request.cancellationAt)))reject('cancellation_constraint');
    if(q.anchorDate!==purchase.anchorDate)reject('anchor_date_changed');
    if(q.discount.state==='none'&&(q.discount.amountMinor!=='0'||q.discount.limited))reject('discount_terms');
    let fees=0n;for(const fee of q.fees)fees+=BigInt(fee.amountMinor);
    const base=BigInt(q.amountMinor??'0'),discount=BigInt(q.discount.amountMinor??'0'),price=base+fees-discount;
    if(price<0n||purchase.totalMinor!==price.toString()||purchase.breakdown.baseMinor!==base.toString()||purchase.breakdown.feesMinor!==fees.toString()||purchase.breakdown.customerDiscountMinor!==discount.toString())reject('price_tampering');
    total+=price;
    if(new Set(purchase.components.map(refKey)).size!==purchase.components.length)reject('duplicate_component');
    const enabled=sku.components.filter(c=>purchase.components.some(r=>sameRef(r,c.ref)));
    if(enabled.length!==purchase.components.length||sku.components.some(c=>(c.data.kind==='stay'||c.data.optional!==true)&&!enabled.includes(c)))reject('missing_or_foreign_component');
    if(enabled.some(c=>!c.data.conditionsKnown))reject('component_condition_unknown');
    if(enabled.filter(c=>c.data.kind==='stay').length>1)reject('multi_room_unit_not_supported');
    const stay=enabled.find(c=>c.data.kind==='stay'),vector=study.demands.map(()=>0);
    if(stay){
      if(stay.data.kind!=='stay'||stay.data.rooms!==1||stay.data.nights===null||!quote.roomType||!purchase.roomType||!sameRef(quote.roomType,purchase.roomType))reject('lodging_mapping');
      else{
        const room=study.roomTypes.get(refKey(quote.roomType));
        if(!room||!stay.roomTypes.some(r=>sameRef(r,quote.roomType!)))reject('room_type_not_accepted');
        if(stay.rateRoomType&&!sameRef(stay.rateRoomType,quote.roomType))reject('rate_plan_room_mismatch');
        if(q.anchorDate<study.request.checkIn||day(q.anchorDate,stay.data.nights)>study.request.checkOut)reject('stay_dates');
        if(!study.request.allowSplitStay&&(q.anchorDate!==study.request.checkIn||stay.data.nights!==nightsBetween(study.request.checkIn,study.request.checkOut)))reject('split_stay');
        if(room&&guest){const p=room.properties;if(typeof p.maximumAdults!=='number'||typeof p.guestCapacity!=='number'||guest.adults>p.maximumAdults||guest.adults+guest.childrenAges.length>p.guestCapacity||guest.childrenAges.length>0&&(typeof p.maximumChildren!=='number'||guest.childrenAges.length>p.maximumChildren))reject('room_capacity');}
        if(!study.request.allowRoomTypeChange&&roomChoices[purchase.roomIndex]&&roomChoices[purchase.roomIndex]!==refKey(quote.roomType))reject('room_change');
        roomChoices[purchase.roomIndex]=refKey(quote.roomType);
        for(let n=0;n<stay.data.nights;n++){
          const index=study.demands.findIndex(d=>d.kind==='room'&&d.roomIndex===purchase.roomIndex&&d.date===day(q.anchorDate,n));
          if(index<0)reject('extra_lodging');else vector[index]=vector[index]!+1;
        }
      }
    }else if(quote.roomType||purchase.roomType)reject('nonlodging_room_reference');
    if(s.category==='activation'&&q.anchorDate>study.request.checkIn)reject('late_activation');
    const supplies=new Map<string,{entitlement:ObjectRef;date:string;quantity:number;unit:string;inventoryRequired:boolean}>();
    for(const component of enabled)if(component.data.kind==='benefit'){
      const c=component.data,definition=[...study.entitlements.values()].find(e=>component.entitlement&&sameRef(e.ref,component.entitlement));
      if(!definition||c.quantity===null||c.dayOffset===null||c.repeat==='unknown'||c.optional===null||c.repeat==='per_night'&&!stay){reject('benefit_mapping_unknown');continue;}
      const nights=stay?.data.kind==='stay'?stay.data.nights??0:0,repeats=c.repeat==='per_night'?nights:1;
      for(let n=0;n<repeats;n++){
        const date=day(q.anchorDate,c.dayOffset+n),index=study.demands.findIndex(d=>d.kind==='benefit'&&d.roomIndex===purchase.roomIndex&&d.date===date&&d.code===definition.data.code);
        if(index>=0)vector[index]=vector[index]!+c.quantity;
        const key=refKey(definition.ref)+date,old=supplies.get(key);
        supplies.set(key,{entitlement:definition.ref,date,quantity:(old?.quantity??0)+c.quantity,unit:definition.data.unit,inventoryRequired:definition.data.inventoryRequired});
      }
    }
    if(digest(vector)!==digest(purchase.coverage))reject('coverage_tampering');
    if(!study.request.allowQualificationPurchases&&!vector.some(Boolean))reject('qualification_purchase_not_allowed');
    for(let i=0;i<vector.length;i++)coverage[i]=coverage[i]!+vector[i]!;
    const actual:Record<string,number>={};for(const use of quote.resources)if(!use.component||enabled.some(c=>sameRef(c.ref,use.component!)))actual[refKey(use.pool)]=(actual[refKey(use.pool)]??0)+use.quantity;
    if(digest(actual)!==digest(purchase.resources))reject('resource_tampering');
    const entries=Object.entries(actual).map(([key,quantity])=>({pool:study.pools.get(key)!,quantity}));
    for(const {pool,quantity}of entries){
      if(pool.data.state!=='known'||pool.data.capacity===null||Date.parse(pool.data.expiresAt)<=study.now)reject('inventory_unknown_or_expired');
      resources[refKey(pool.ref)]=(resources[refKey(pool.ref)]??0)+quantity;
      if(resources[refKey(pool.ref)]!>(pool.data.capacity??-1))reject('shared_inventory_exceeded');
      if(['sale','promotion'].includes(pool.data.kind)&&(!pool.skus.some(r=>sameRef(r,sku.ref))||quantity!==1))reject('sale_or_coupon_mapping');
      if(pool.data.kind==='room'&&(!quote.roomType||!pool.roomTypes.some(r=>sameRef(r,quote.roomType!))||!pool.data.date||pool.data.date<q.anchorDate||!stay||stay.data.kind!=='stay'||pool.data.date>=day(q.anchorDate,stay.data.nights??0)||quantity!==1))reject('room_inventory_mapping');
      if(pool.data.kind==='benefit'&&![...supplies.values()].some(v=>pool.entitlement&&sameRef(v.entitlement,pool.entitlement)&&v.date===pool.data.date&&v.unit===pool.data.unit&&v.quantity===quantity))reject('benefit_inventory_mapping');
      if(pool.data.kind==='promotion'&&!q.discount.limited)reject('unexpected_coupon_consumption');
    }
    if(!entries.some(e=>e.pool.data.kind==='sale'&&e.quantity===1))reject('sale_inventory_missing');
    if(q.discount.limited&&!entries.some(e=>e.pool.data.kind==='promotion'&&e.quantity===1))reject('coupon_inventory_missing');
    if(stay?.data.kind==='stay')for(let n=0;n<(stay.data.nights??0);n++)if(!entries.some(e=>e.pool.data.kind==='room'&&e.pool.data.date===day(q.anchorDate,n)&&e.quantity===1))reject('room_inventory_missing');
    for(const supply of supplies.values())if(supply.inventoryRequired&&!entries.some(e=>e.pool.data.kind==='benefit'&&e.pool.entitlement&&sameRef(e.pool.entitlement,supply.entitlement)&&e.pool.data.date===supply.date&&e.pool.data.unit===supply.unit&&e.quantity===supply.quantity))reject('benefit_inventory_missing');
    const components=[...purchase.components].sort((a,b)=>refKey(a).localeCompare(refKey(b)));
    if(purchase.id!==digest({quote:quote.ref,roomIndex:purchase.roomIndex,components}))reject('realization_identity');
    replayed.push({...purchase,coverage:vector,resources:actual,totalMinor:price.toString()});
  }
  if(plan.totalMinor!==total.toString()||study.request.maxTotalMinor!==null&&total>BigInt(study.request.maxTotalMinor))reject('plan_total_or_budget');
  if(plan.id!==digest(selected.map(p=>p.id)))reject('plan_identity');
  if(study.demands.some((d,i)=>coverage[i]!<d.quantity||d.kind==='room'&&coverage[i]!==1))reject('unsatisfied_or_duplicate_demand');
  const expectedCovered=study.demands.map((d,i)=>({demand:d.key,required:d.quantity,supplied:coverage[i]}));
  if(digest(expectedCovered)!==digest(plan.covered))reject('coverage_summary');
  const expectedUsage=Object.entries(resources).sort(([a],[b])=>a.localeCompare(b)).map(([key,quantity])=>({pool:study.pools.get(key)!.ref,quantity,capacity:study.pools.get(key)!.data.capacity!}));
  if(digest(expectedUsage)!==digest(plan.resourceUsage))reject('inventory_summary');
  replayPath(plan,replayed,study,reject);
}
function replayPath(plan:Plan,purchases:Realization[],study:Study,reject:(message:string)=>void){
  const ordinals=new Map<string,number>(),ids=purchases.map(p=>{const n=ordinals.get(p.id)??0;ordinals.set(p.id,n+1);return p.id.slice(0,20)+'-'+n;});
  const expected=new Map<string,{index:number;kind:'purchase_simulation'|'redemption_simulation'}>();
  ids.forEach((id,index)=>{expected.set('buy-'+id,{index,kind:'purchase_simulation'});if(purchases[index]!.components.length||study.skus.get(refKey(purchases[index]!.sku))!.data.category==='activation')expected.set('redeem-'+id,{index,kind:'redemption_simulation'});});
  const done=new Set<string>();if(plan.path.length!==expected.size)reject('path_length');
  for(const step of plan.path){
    const target=expected.get(step.id);if(!target||done.has(step.id)){reject('path_identity');continue;}
    const p=purchases[target.index]!;
    if(step.kind!==target.kind||!sameRef(step.sku,p.sku)||!sameRef(step.quote,p.quote)||step.roomIndex!==p.roomIndex||step.dependsOn.some(id=>!done.has(id)))reject('path_order_or_binding');
    if(step.kind==='redemption_simulation'&&(step.date!==p.anchorDate||!step.dependsOn.includes('buy-'+ids[target.index])))reject('redemption_before_purchase');
    if(step.kind==='purchase_simulation')for(const dependency of study.skus.get(refKey(p.sku))!.prerequisites){
      const date=day(p.anchorDate,dependency.dayOffset);
      const peers=purchases.filter(peer=>sameRef(peer.sku,p.sku)&&(dependency.scope!=='same_room'||peer.roomIndex===p.roomIndex)&&(dependency.anchor==='any'||day(peer.anchorDate,dependency.dayOffset)===date));
      const required=dependency.quantity*(dependency.basis==='per_unit'?peers.length:1);
      const eligible=purchases.map((candidate,index)=>({candidate,index})).filter(({candidate})=>sameRef(candidate.sku,dependency.sku)&&(dependency.phase!=='redemption'||candidate.components.length>0||study.skus.get(refKey(candidate.sku))!.data.category==='activation')&&(dependency.scope!=='same_room'||candidate.roomIndex===p.roomIndex)&&(dependency.anchor==='any'||dependency.anchor==='same_date'&&candidate.anchorDate===date||dependency.anchor==='covers_date'&&candidate.coverage.some((n,i)=>n>0&&study.demands[i]!.kind==='room'&&study.demands[i]!.date===date)));
      const before=eligible.filter(({index})=>step.dependsOn.includes((dependency.phase==='purchase'?'buy-':'redeem-')+ids[index]));
      if(before.length<required)reject('prerequisite_path_missing');
    }
    done.add(step.id);
  }
}
