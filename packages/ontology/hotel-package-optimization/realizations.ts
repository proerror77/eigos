import { digest } from '../../core/delegation.js';
import type { ObjectRef } from '../model.js';
import { day, nightsBetween, refKey, sameRef, type Study, type QuoteNode, type ComponentNode } from './graph.js';
import type { Diagnostic, Realization } from './contracts.js';

const guestsEqual = (a:{adults:number;childrenAges:number[]},b:{adults:number;childrenAges:number[]}) => a.adults===b.adults && JSON.stringify([...a.childrenAges].sort((x,y)=>x-y))===JSON.stringify([...b.childrenAges].sort((x,y)=>x-y));
export function generateRealizations(study:Study,limit:number):{items:Realization[];diagnostics:Diagnostic[];complete:boolean}{
  const items:Realization[]=[],diagnostics:Diagnostic[]=[],seen=new Set<string>();let complete=true;
  const prerequisites=new Set([...study.skus.values()].flatMap(s=>s.prerequisites.map(p=>refKey(p.sku))));
  const redemptionPrerequisites=new Set([...study.skus.values()].flatMap(s=>s.prerequisites.filter(p=>p.phase==='redemption').map(p=>refKey(p.sku))));
  const report=(object:ObjectRef,state:Diagnostic['state'],reason:string)=>{const key=refKey(object)+state+reason;if(!seen.has(key)){seen.add(key);diagnostics.push({object,state,reason});}};
  const relevant=new Set<string>();
  for(const [key,sku] of study.skus){
    if(sku.components.some(c=>c.data.kind==='stay'&&(!c.roomTypes.length||c.roomTypes.some(r=>study.roomTypes.has(refKey(r))))
      ||c.data.kind==='benefit'&&study.demands.some(d=>d.kind==='benefit'&&(!c.entitlement||study.entitlements.get(d.code!)?.ref.id===c.entitlement.id)))
      ||!sku.components.length&&sku.data.category!=='activation'&&!sku.data.termsKnown)relevant.add(key);
  }
  if(study.request.allowQualificationPurchases){let changed=true;while(changed){changed=false;for(const key of [...relevant])for(const p of study.skus.get(key)!.prerequisites)if(!relevant.has(refKey(p.sku))){relevant.add(refKey(p.sku));changed=true;}}}
  for(const key of relevant){const sku=study.skus.get(key)!;if(sku.data.saleState!=='unavailable'&&sku.data.maxUnits!==0&&!study.quotes.some(q=>sameRef(q.sku,sku.ref)))report(sku.ref,'unknown','dated_quote_missing');}
  for(const quote of study.quotes){
    const sku=study.skus.get(refKey(quote.sku))!,s=sku.data,q=quote.data;
    if(!relevant.has(refKey(sku.ref)))continue;
    const stay=sku.components.find(c=>c.data.kind==='stay'),optional=sku.components.filter(c=>c.data.kind==='benefit'&&c.data.optional&&(redemptionPrerequisites.has(refKey(sku.ref))||study.demands.some(d=>d.kind==='benefit'&&(!c.entitlement||study.entitlements.get(d.code!)?.ref.id===c.entitlement.id))));
    if(sku.components.filter(c=>c.data.kind==='stay').length>1){report(quote.ref,'unknown','multi_room_unit_not_supported');continue;}
    if(optional.length>4){report(quote.ref,'unknown','optional_component_bound');complete=false;continue;}
    let blocked:Diagnostic|undefined;
    const reject=(reason:string)=>blocked={object:quote.ref,state:'rejected',reason};
    const unknown=(reason:string)=>blocked={object:quote.ref,state:'unknown',reason};
    if(s.saleState==='unavailable'||s.maxUnits===0)reject('sku_unavailable');
    else if(s.saleState==='unknown'||s.maxUnits===null||s.eligibility==='unknown'||!s.termsKnown)unknown('sku_terms_or_eligibility_unknown');
    else if(s.eligibility==='ineligible')reject('sku_ineligible');
    else if(q.skuVersion!==s.version || q.variantRevision!==sku.variant.revision)unknown('quote_specification_stale');
    else if(Date.parse(q.expiresAt)<=study.now)unknown('quote_expired');
    else if(q.availability==='unavailable')reject('date_unavailable');
    else if(q.availability==='unknown')unknown('date_availability_unknown');
    else if(q.currency!==study.request.currency)reject('currency_mismatch');
    else if(q.priceKind!=='exact'||q.amountMinor===null||!q.feesKnown||q.discount.state==='unknown'||q.discount.amountMinor===null)unknown('total_price_unknown');
    else if(q.discount.state==='none'&&(q.discount.amountMinor!=='0'||q.discount.limited))unknown('contradictory_discount_terms');
    else if(q.cancellation.state==='unknown')unknown('cancellation_unknown');
    else if(study.request.cancellationAt && (!q.cancellation.freeUntil || Date.parse(q.cancellation.freeUntil)<Date.parse(study.request.cancellationAt)))reject('cancellation_constraint');
    else if(!q.guest)unknown('quoted_party_unknown');
    if(blocked){report(blocked.object,blocked.state,blocked.reason);continue;}
    const base=BigInt(q.amountMinor!),fees=q.fees.reduce((n,f)=>n+BigInt(f.amountMinor),0n),discount=BigInt(q.discount.amountMinor!);
    if(discount>base+fees){report(quote.ref,'unknown','discount_exceeds_total');continue;}
    const nights=stay?.data.kind==='stay'?(stay.data.nights??0):0;
    if(stay && (stay.data.kind!=='stay'||stay.data.rooms!==1||stay.data.nights===null||!stay.data.conditionsKnown || !stay.roomTypes.length || !quote.roomType)){report(quote.ref,'unknown','room_mapping_or_conditions_unknown');continue;}
    if(stay && (quote.data.anchorDate<study.request.checkIn || day(q.anchorDate,nights)>study.request.checkOut)){report(quote.ref,'rejected','stay_outside_request');continue;}
    if(!stay && quote.roomType){report(quote.ref,'unknown','nonlodging_quote_has_room');continue;}
    if(stay && !study.request.allowSplitStay && (q.anchorDate!==study.request.checkIn || nights!==nightsBetween(study.request.checkIn,study.request.checkOut))){report(quote.ref,'rejected','split_stay_not_allowed');continue;}
    if(stay && (!study.roomTypes.has(refKey(quote.roomType!)) || !stay.roomTypes.some(r=>sameRef(r,quote.roomType!)))){report(quote.ref,'rejected','room_type_not_accepted');continue;}
    if(stay?.rateRoomType&&quote.roomType&&!sameRef(stay.rateRoomType,quote.roomType)){report(quote.ref,'unknown','rate_plan_room_mismatch');continue;}
    if(s.category==='activation'&&q.anchorDate>study.request.checkIn){report(quote.ref,'rejected','activation_too_late');continue;}
    for(let roomIndex=0;roomIndex<study.request.rooms.length;roomIndex++){
      const guest=study.request.rooms[roomIndex]!;
      if(!guestsEqual(q.guest!,guest)){report(quote.ref,'rejected','quoted_party_mismatch');continue;}
      if(stay){
        const room=study.roomTypes.get(refKey(quote.roomType!))!.properties;
        if(typeof room.maximumAdults!=='number'||guest.childrenAges.length>0&&typeof room.maximumChildren!=='number'||typeof room.guestCapacity!=='number'){report(quote.ref,'unknown','room_capacity_unknown');continue;}
        if(guest.adults>room.maximumAdults||guest.childrenAges.length>0&&guest.childrenAges.length>Number(room.maximumChildren)||guest.adults+guest.childrenAges.length>room.guestCapacity){report(quote.ref,'rejected','room_capacity_exceeded');continue;}
      }
      for(let mask=0;mask<2**optional.length;mask++){
        const enabled=sku.components.filter(c=>c.data.kind!=='benefit'||c.data.optional!==true||optional.includes(c)&&!!(mask & 2**optional.indexOf(c)));
        const bad=enabled.find(c=>!c.data.conditionsKnown||c.data.kind==='benefit'&&(c.data.quantity===null||c.data.repeat==='unknown'||c.data.dayOffset===null||c.data.optional===null));
        if(bad){report(quote.ref,'unknown','component_conditions_unknown');continue;}
        const coverage=Array(study.demands.length).fill(0) as number[];
        const supplies:{component:ComponentNode;date:string;code:string;quantity:number;entitlement:ObjectRef}[]=[];
        let invalid=false;
        for(const component of enabled){
          if(component.data.kind==='stay'){
            for(let n=0;n<component.data.nights!;n++){
              const date=day(q.anchorDate,n),index=study.demands.findIndex(d=>d.kind==='room'&&d.roomIndex===roomIndex&&d.date===date);
              if(index<0){invalid=true;break;}coverage[index]=coverage[index]!+1;
            }
          }else{
            if(!component.entitlement){report(quote.ref,'unknown','entitlement_mapping_missing');invalid=true;break;}
            const def=[...study.entitlements.values()].find(e=>sameRef(e.ref,component.entitlement!))!;
            if(component.data.repeat==='per_night'&&!stay){report(quote.ref,'unknown','per_night_benefit_has_no_stay');invalid=true;break;}
            const repeats=component.data.repeat==='per_night'?nights:1;
            for(let n=0;n<repeats;n++){
              const date=day(q.anchorDate,component.data.dayOffset!+n),index=study.demands.findIndex(d=>d.kind==='benefit'&&d.roomIndex===roomIndex&&d.date===date&&d.code===def.data.code);
              if(index>=0)coverage[index]=coverage[index]!+component.data.quantity!;
              supplies.push({component,date,code:def.data.code,quantity:component.data.quantity!,entitlement:def.ref});
            }
          }
        }
        if(invalid)continue;
        const resources:Record<string,number>={};
        for(const use of quote.resources)if(!use.component||enabled.some(c=>sameRef(c.ref,use.component!)))resources[refKey(use.pool)]=(resources[refKey(use.pool)]??0)+use.quantity;
        const entries=Object.entries(resources).map(([key,quantity])=>({pool:study.pools.get(key)!,quantity}));
        for(const {pool,quantity} of entries){
          if(Date.parse(pool.data.expiresAt)<=study.now || pool.data.state==='unknown' || pool.data.capacity===null){report(quote.ref,'unknown','inventory_unknown_or_expired');invalid=true;break;}
          if(pool.data.state==='unavailable'||quantity>pool.data.capacity){report(quote.ref,'rejected','inventory_unavailable');invalid=true;break;}
          if(['sale','promotion'].includes(pool.data.kind)&&!pool.skus.some(r=>sameRef(r,sku.ref))){report(quote.ref,'unknown','inventory_sku_mapping_missing');invalid=true;break;}
          if(['sale','promotion','room'].includes(pool.data.kind)&&quantity!==1){report(quote.ref,'unknown','inventory_unit_mismatch');invalid=true;break;}
          if(pool.data.kind==='promotion'&&!q.discount.limited){report(quote.ref,'unknown','unexpected_coupon_consumption');invalid=true;break;}
          if(pool.data.kind==='room'&&(!quote.roomType||!pool.roomTypes.some(r=>sameRef(r,quote.roomType!))||!pool.data.date||pool.data.date<q.anchorDate||pool.data.date>=day(q.anchorDate,nights))){report(quote.ref,'unknown','room_inventory_mapping_mismatch');invalid=true;break;}
        }
        if(invalid)continue;
        if(!entries.some(e=>e.pool.data.kind==='sale'&&e.quantity===1)){report(quote.ref,'unknown','sale_inventory_missing');continue;}
        if(q.discount.limited&&!entries.some(e=>e.pool.data.kind==='promotion'&&e.quantity===1)){report(quote.ref,'unknown','limited_discount_pool_missing');continue;}
        for(let n=0;n<nights;n++)if(!entries.some(e=>e.pool.data.kind==='room'&&e.pool.data.date===day(q.anchorDate,n)&&e.quantity===1)){report(quote.ref,'unknown','room_inventory_missing');invalid=true;break;}
        const combinedSupplies=new Map<string,typeof supplies[number]>();
        for(const supply of supplies){const key=refKey(supply.entitlement)+supply.date;const prior=combinedSupplies.get(key);combinedSupplies.set(key,{...supply,quantity:(prior?.quantity??0)+supply.quantity});}
        for(const {pool,quantity} of entries)if(pool.data.kind==='benefit'&&![...combinedSupplies.values()].some(s=>pool.entitlement&&sameRef(s.entitlement,pool.entitlement)&&pool.data.date===s.date&&pool.data.unit===study.entitlements.get(s.code)!.data.unit&&quantity===s.quantity)){report(quote.ref,'unknown','benefit_inventory_mapping_mismatch');invalid=true;break;}
        for(const supply of combinedSupplies.values()){
          const def=study.entitlements.get(supply.code)!;
          if(def.data.inventoryRequired&&!entries.some(e=>e.pool.data.kind==='benefit'&&e.pool.data.date===supply.date&&e.pool.entitlement&&sameRef(e.pool.entitlement,supply.entitlement)&&e.pool.data.unit===def.data.unit&&e.quantity===supply.quantity)){
            report(quote.ref,'unknown','benefit_inventory_missing');invalid=true;break;
          }
        }
        if(invalid)continue;
        // Extra benefits have no cash credit. Non-covering activation SKUs are
        // retained only so explicitly required purchase paths can use them.
        if(!coverage.some(Boolean)&&(!prerequisites.has(refKey(sku.ref))||!study.request.allowQualificationPurchases))continue;
        if(items.length>=limit){complete=false;report(quote.ref,'unknown','realization_bound');continue;}
        const components=enabled.map(c=>c.ref).sort((a,b)=>refKey(a).localeCompare(refKey(b)));
        items.push({id:digest({quote:quote.ref,roomIndex,components}),sku:sku.ref,variant:sku.variant.ref,quote:quote.ref,roomIndex,...(quote.roomType?{roomType:quote.roomType}:{}),anchorDate:q.anchorDate,components,coverage,resources,totalMinor:(base+fees-discount).toString(),breakdown:{baseMinor:base.toString(),feesMinor:fees.toString(),customerDiscountMinor:discount.toString()}});
      }
    }
  }
  return{items:items.sort((a,b)=>a.id.localeCompare(b.id)),diagnostics:diagnostics.sort((a,b)=>(refKey(a.object)+a.reason).localeCompare(refKey(b.object)+b.reason)),complete};
}
