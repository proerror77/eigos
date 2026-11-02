import { digest } from '../../core/delegation.js';
import type { ObjectRef } from '../model.js';
import type { OntologyObjectStore } from '../object-store.js';
import { boundsSchema, type Bounds, type OptimizationResult, type Plan, type Prerequisite, type Realization } from './contracts.js';
import { day, refKey, readStudy, sameRef, type Study } from './graph.js';
import { generateRealizations } from './realizations.js';

export interface DependencyNeed { sku:ObjectRef; quantity:number; roomIndex?:number; anchor:Prerequisite['anchor']; date?:string;phase:Prerequisite['phase'] }
export function matchesDependency(candidate:Realization,need:DependencyNeed,study:Study):boolean{
  if(!sameRef(candidate.sku,need.sku) || need.roomIndex!==undefined && candidate.roomIndex!==need.roomIndex)return false;
  if(need.phase==='redemption'&&!candidate.components.length&&study.skus.get(refKey(candidate.sku))!.data.category!=='activation')return false;
  if(need.anchor==='same_date')return candidate.anchorDate===need.date;
  if(need.anchor==='covers_date')return candidate.coverage.some((quantity,index)=>quantity>0&&study.demands[index]!.kind==='room'&&study.demands[index]!.date===need.date);
  return true;
}
/** Prerequisites describe required possession/activation, not consumption.
 * Consumable coupon and inventory limits are separate shared pools. */
export function dependencyNeeds(purchases:Realization[],study:Study):DependencyNeed[]{
  const grouped=new Map<string,DependencyNeed>();
  for(const purchase of purchases)for(const dependency of study.skus.get(refKey(purchase.sku))!.prerequisites){
    const date=dependency.anchor==='any'?undefined:day(purchase.anchorDate,dependency.dayOffset);
    const need:DependencyNeed={sku:dependency.sku,quantity:dependency.quantity,...(dependency.scope==='same_room'?{roomIndex:purchase.roomIndex}:{}),anchor:dependency.anchor,...(date?{date}:{}),phase:dependency.phase};
    const key=digest({dependentSku:purchase.sku,sku:need.sku,room:need.roomIndex,anchor:need.anchor,date,phase:need.phase});
    const prior=grouped.get(key);
    if(!prior)grouped.set(key,need);else if(dependency.basis==='per_unit')prior.quantity+=dependency.quantity;
  }
  return [...grouped.values()];
}
function planFrom(purchases:Realization[],study:Study):Plan{
  const ordered=[...purchases].sort((a,b)=>a.id.localeCompare(b.id)),count=new Map<string,number>();
  const ids=ordered.map(item=>{const n=count.get(item.id)??0;count.set(item.id,n+1);return `${item.id.slice(0,20)}-${n}`;});
  const steps:Plan['path']=[];
  for(let i=0;i<ordered.length;i++){
    const purchase=ordered[i]!,buy='buy-'+ids[i],redeem='redeem-'+ids[i],dependencies:string[]=[];
    for(const requirement of dependencyNeeds(ordered.filter(p=>sameRef(p.sku,purchase.sku)),study)){
      // A requirement can apply to only one room/date group of this SKU.
      if(requirement.roomIndex!==undefined&&requirement.roomIndex!==purchase.roomIndex)continue;
      const rules=study.skus.get(refKey(purchase.sku))!.prerequisites;
      if(requirement.date && !rules.some(rule=>sameRef(rule.sku,requirement.sku)&&day(purchase.anchorDate,rule.dayOffset)===requirement.date))continue;
      const eligible=ordered.map((p,index)=>({p,index})).filter(({p})=>matchesDependency(p,requirement,study)).slice(0,requirement.quantity);
      for(const candidate of eligible)dependencies.push((requirement.phase==='purchase'?'buy-':'redeem-')+ids[candidate.index]);
    }
    steps.push({id:buy,kind:'purchase_simulation',sku:purchase.sku,quote:purchase.quote,roomIndex:purchase.roomIndex,dependsOn:[...new Set(dependencies)].sort()});
    if(purchase.components.length||study.skus.get(refKey(purchase.sku))!.data.category==='activation')steps.push({id:redeem,kind:'redemption_simulation',sku:purchase.sku,quote:purchase.quote,roomIndex:purchase.roomIndex,date:purchase.anchorDate,dependsOn:[buy]});
  }
  const path:Plan['path']=[],remaining=new Map(steps.map(s=>[s.id,s])),done=new Set<string>();
  while(remaining.size){
    const next=[...remaining.values()].filter(s=>s.dependsOn.every(id=>done.has(id))).sort((a,b)=>a.id.localeCompare(b.id))[0];
    if(!next)throw new Error('Package path contains a dependency cycle');
    path.push(next);remaining.delete(next.id);done.add(next.id);
  }
  const usage:Record<string,number>={};for(const p of ordered)for(const [key,quantity]of Object.entries(p.resources))usage[key]=(usage[key]??0)+quantity;
  return{id:digest(ordered.map(p=>p.id)),totalMinor:ordered.reduce((n,p)=>n+BigInt(p.totalMinor),0n).toString(),currency:study.request.currency,purchases:ordered,path,
    covered:study.demands.map((d,index)=>({demand:d.key,required:d.quantity,supplied:ordered.reduce((n,p)=>n+p.coverage[index]!,0)})),
    resourceUsage:Object.entries(usage).sort(([a],[b])=>a.localeCompare(b)).map(([key,quantity])=>({pool:study.pools.get(key)!.ref,quantity,capacity:study.pools.get(key)!.data.capacity!}))};
}
const planCompare=(a:Plan,b:Plan)=>BigInt(a.totalMinor)<BigInt(b.totalMinor)?-1:BigInt(a.totalMinor)>BigInt(b.totalMinor)?1:a.purchases.length-b.purchases.length||a.id.localeCompare(b.id);
export function optimizeSyntheticHotelPackages(graph:OntologyObjectStore,owner:string,request:ObjectRef,rawBounds:Partial<Bounds>={}):OptimizationResult{
  const bounds=boundsSchema.parse(rawBounds),study=readStudy(graph,owner,request),generated=generateRealizations(study,bounds.maxRealizations);
  const candidates=generated.items,bySku=new Map<string,Realization[]>();
  for(const candidate of candidates){const key=refKey(candidate.sku);bySku.set(key,[...(bySku.get(key)??[]),candidate]);}
  const plans:Plan[]=[],planIds=new Set<string>(),visitedStates=new Set<string>();let nodes=0,complete=generated.complete;
  function visit(selected:Realization[],coverage:number[],usage:Record<string,number>,counts:Record<string,number>,roomTypes:Record<number,string>,cost:bigint){
    if(nodes>=bounds.maxNodes){complete=false;return;}nodes++;
    if(study.request.maxTotalMinor!==null&&cost>BigInt(study.request.maxTotalMinor))return;
    if(plans.length>=bounds.maxPlans&&cost>BigInt(plans[plans.length-1]!.totalMinor))return;
    const signature=selected.map(p=>p.id).sort().join(':');if(visitedStates.has(signature))return;visitedStates.add(signature);
    const need=dependencyNeeds(selected,study).find(n=>selected.filter(p=>matchesDependency(p,n,study)).length<n.quantity);
    const pivot=coverage.findIndex((quantity,index)=>quantity<study.demands[index]!.quantity);
    if(!need&&pivot<0){
      const plan=planFrom(selected,study);if(!planIds.has(plan.id)){planIds.add(plan.id);plans.push(plan);plans.sort(planCompare);if(plans.length>bounds.maxPlans)plans.pop();}return;
    }
    if(selected.length>=study.request.maxPurchases)return;
    const choices=(need?(bySku.get(refKey(need.sku))??[]).filter(p=>matchesDependency(p,need,study)):candidates.filter(p=>p.coverage[pivot]!>0));
    for(const choice of choices){
      const skuKey=refKey(choice.sku);if((counts[skuKey]??0)>=study.skus.get(skuKey)!.data.maxUnits!)continue;
      if(choice.coverage.some((quantity,index)=>quantity>0&&study.demands[index]!.kind==='room'&&coverage[index]!+quantity>1))continue;
      if(!study.request.allowRoomTypeChange&&choice.roomType&&roomTypes[choice.roomIndex]&&roomTypes[choice.roomIndex]!==refKey(choice.roomType))continue;
      if(Object.entries(choice.resources).some(([key,quantity])=>(usage[key]??0)+quantity>study.pools.get(key)!.data.capacity!))continue;
      const nextUsage={...usage};for(const [key,quantity]of Object.entries(choice.resources))nextUsage[key]=(nextUsage[key]??0)+quantity;
      visit([...selected,choice],coverage.map((n,i)=>Math.min(study.demands[i]!.quantity,n+choice.coverage[i]!)),nextUsage,{...counts,[skuKey]:(counts[skuKey]??0)+1},
        choice.roomType?{...roomTypes,[choice.roomIndex]:refKey(choice.roomType)}:roomTypes,cost+BigInt(choice.totalMinor));
    }
  }
  visit([],study.demands.map(()=>0),{},{},{},0n);
  if(study.reader.snapshot()!==study.inputDigest)throw new Error('Synthetic input snapshot changed');
  const unknown=new Set(generated.diagnostics.filter(d=>d.state==='unknown').map(d=>refKey(d.object))).size;
  const proven=complete&&study.catalogComplete&&unknown===0;
  return{evidenceLevel:'synthetic',bookable:false,executed:false,modelDigest:study.modelDigest,inputDigest:study.inputDigest,request,
    status:plans.length?(proven?'optimal':'best_known'):(proven?'no_solution':'inconclusive'),plans,
    search:{complete,visitedNodes:nodes,generatedRealizations:candidates.length,scope:'supplied_synthetic_catalog',catalogComplete:study.catalogComplete,unknownCandidates:unknown},diagnostics:generated.diagnostics};
}
