import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticPackageStudy, type StudyFixture } from '../packages/ontology/hotel-package-optimization/synthetic.js';
import { optimizeSyntheticHotelPackages } from '../packages/ontology/hotel-package-optimization/search.js';
import { verifySyntheticHotelPackagePlan } from '../packages/ontology/hotel-package-optimization/verify.js';

type Unit={id:string;rooms:string[];breakfast:string[];price:bigint;anchor:string};
const roomDates=['2030-01-10','2030-01-11'],breakfastDates=['2030-01-11','2030-01-12'];
/** Independent exhaustive subset oracle: no production candidate generator,
 * coverage, prerequisite or cost helper is used. */
function oracle(units:Unit[]):bigint|undefined{
  let best:bigint|undefined;
  for(let mask=0;mask<2**units.length;mask++){
    let total=0n;const rooms=new Map<string,number>(),breakfast=new Map<string,number>();
    for(let i=0;i<units.length;i++)if(mask&2**i){const u=units[i]!;total+=u.price;for(const d of u.rooms)rooms.set(d,(rooms.get(d)??0)+1);for(const d of u.breakfast)breakfast.set(d,(breakfast.get(d)??0)+2);}
    if(roomDates.some(d=>rooms.get(d)!==1)||breakfastDates.some(d=>(breakfast.get(d)??0)<2))continue;
    if(best===undefined||total<best)best=total;
  }
  return best;
}
function make(seed:number):{fixture:StudyFixture;units:Unit[]}{
  let state=seed;const next=()=>{state=(state*1664525+1013904223)>>>0;return BigInt(1000+state%70000);};
  const units:Unit[]=[
    {id:'single-a',rooms:[roomDates[0]!],breakfast:[],price:next(),anchor:roomDates[0]!},
    {id:'single-b',rooms:[roomDates[1]!],breakfast:[],price:next(),anchor:roomDates[1]!},
    {id:'two-nights',rooms:roomDates,breakfast:[],price:next(),anchor:roomDates[0]!},
    {id:'bundle',rooms:roomDates,breakfast:breakfastDates,price:next(),anchor:roomDates[0]!},
    {id:'breakfast-a',rooms:[],breakfast:[breakfastDates[0]!],price:next(),anchor:breakfastDates[0]!},
    {id:'breakfast-b',rooms:[],breakfast:[breakfastDates[1]!],price:next(),anchor:breakfastDates[1]!},
    {id:'single-breakfast-a',rooms:[roomDates[0]!],breakfast:[breakfastDates[0]!],price:next(),anchor:roomDates[0]!},
    {id:'single-breakfast-b',rooms:[roomDates[1]!],breakfast:[breakfastDates[1]!],price:next(),anchor:roomDates[1]!},
  ];
  const fixture:StudyFixture={environment:'synthetic',id:'oracle-'+seed,entitlements:[{code:'breakfast'}],
    skus:units.map(u=>({id:u.id,category:u.rooms.length?(u.breakfast.length?'bundle':'room'):'benefit',components:[
      ...(u.rooms.length?[{kind:'stay' as const,rooms:1,nights:u.rooms.length,conditionsKnown:true}]:[]),
      ...(u.breakfast.length?[{kind:'benefit' as const,quantity:2,repeat:u.breakfast.length===2?'per_night' as const:'per_package' as const,dayOffset:u.rooms.length?1:0,optional:false,conditionsKnown:true,entitlement:'breakfast'}]:[])]})),
    pools:[...units.map(u=>({id:'sale-'+u.id,kind:'sale' as const,capacity:1,skus:[u.id]})),...roomDates.map((date,n)=>({id:'night-'+n,kind:'room' as const,capacity:1,date}))],
    quotes:units.map(u=>({id:u.id+'-price',sku:u.id,anchorDate:u.anchor,amountMinor:u.price.toString(),resources:[{pool:'sale-'+u.id},...u.rooms.map(date=>({pool:'night-'+roomDates.indexOf(date)}))]})),
    request:{checkIn:roomDates[0]!,checkOut:'2030-01-12',benefits:breakfastDates.map(date=>({code:'breakfast',date,roomIndex:0,quantity:2}))}};
  return{fixture,units};
}
test('bounded ontology search matches independent exhaustive price/composition oracle across 30 catalogs',()=>{
  for(let seed=1;seed<=30;seed++){
    const {fixture,units}=make(seed),expected=oracle(units),study=createSyntheticPackageStudy(fixture);
    try{const result=optimizeSyntheticHotelPackages(study.graph,study.owner,study.request,{maxPlans:1});assert.equal(result.status,'optimal',`seed ${seed}`);assert.equal(result.plans[0]!.totalMinor,expected!.toString(),`seed ${seed}`);assert.equal(verifySyntheticHotelPackagePlan(study.graph,study.owner,result).accepted,true,`seed ${seed}`);}finally{study.close();}
  }
});
test('object/relationship insertion order does not change the optimal path or snapshot identity',()=>{
  const {fixture}=make(99),a=createSyntheticPackageStudy(fixture),b=createSyntheticPackageStudy({...fixture,skus:[...fixture.skus].reverse(),quotes:[...fixture.quotes].reverse(),pools:[...fixture.pools].reverse()});
  try{const x=optimizeSyntheticHotelPackages(a.graph,a.owner,a.request),y=optimizeSyntheticHotelPackages(b.graph,b.owner,b.request);assert.equal(x.inputDigest,y.inputDigest);assert.equal(x.plans[0]!.id,y.plans[0]!.id);assert.equal(x.plans[0]!.totalMinor,y.plans[0]!.totalMinor);}finally{a.close();b.close();}
});
