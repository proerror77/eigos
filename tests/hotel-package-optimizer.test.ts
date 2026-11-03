import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticPackageStudy, type StudyFixture } from '../packages/ontology/hotel-package-optimization/synthetic.js';
import { optimizeSyntheticHotelPackages } from '../packages/ontology/hotel-package-optimization/search.js';
import { verifySyntheticHotelPackagePlan } from '../packages/ontology/hotel-package-optimization/verify.js';
import { packageDemoFixture } from '../packages/ontology/hotel-package-optimization/demo.js';
import { day } from '../packages/ontology/hotel-package-optimization/graph.js';

const start='2030-01-10',end='2030-01-11';
const stay=(nights=1)=>({kind:'stay' as const,rooms:1,nights,conditionsKnown:true});
const benefit=(code:string,quantity=2,repeat:'per_night'|'per_stay'|'per_package'='per_package',offset=0)=>({kind:'benefit' as const,quantity,repeat,dayOffset:offset,optional:false,conditionsKnown:true,entitlement:code});
function solve(fixture:StudyFixture,check:(result:ReturnType<typeof optimizeSyntheticHotelPackages>,study:ReturnType<typeof createSyntheticPackageStudy>)=>void,bounds={}){
  const study=createSyntheticPackageStudy(fixture);
  try{const result=optimizeSyntheticHotelPackages(study.graph,study.owner,study.request,bounds);if(result.plans.length)assert.deepEqual(verifySyntheticHotelPackagePlan(study.graph,study.owner,result).reasons,[]);check(result,study);}finally{study.close();}
}
function sales(ids:string[],quantity=1):StudyFixture['pools']{return ids.map(id=>({id:'sale-'+id,kind:'sale',capacity:quantity,skus:[id]}));}
const roomPool=(id:string,date:string,capacity=1)=>({id,kind:'room' as const,date,capacity});

test('demand, not the advertised extra value, decides bundle versus separate purchases',()=>{
  solve(packageDemoFixture(true),r=>{assert.equal(r.status,'optimal');assert.equal(r.plans[0]!.totalMinor,'69900');assert.equal(r.plans[1]!.totalMinor,'77900');assert.equal(r.plans[0]!.purchases.length,1);});
  solve(packageDemoFixture(false),r=>{assert.equal(r.plans[0]!.totalMinor,'65900');assert.equal(r.plans[1]!.totalMinor,'69900');assert(r.plans[0]!.purchases.every(p=>!p.sku.id.endsWith(':bundle')));});
});
test('a dearer room creates a cheaper valid add-on path; redemption precedes add-on purchase',()=>{
  const fixture:StudyFixture={environment:'synthetic',id:'greedy-trap',entitlements:[{code:'dinner'}],skus:[
    {id:'cheap-room',components:[stay()]},{id:'qualifying-room',components:[stay()]},
    {id:'meal',category:'benefit',components:[benefit('dinner')]},
    {id:'addon',category:'benefit',components:[benefit('dinner')],prerequisites:[{sku:'qualifying-room',scope:'same_room',anchor:'covers_date',phase:'redemption'}]},
  ],pools:[roomPool('room-capacity',start),...sales(['cheap-room','qualifying-room','meal','addon'])],
    quotes:[['cheap-room','50000'],['qualifying-room','60000'],['meal','20000'],['addon','2000']].map(([sku,price])=>({id:sku+'-quote',sku:sku!,anchorDate:start,amountMinor:price!,resources:[{pool:'sale-'+sku},...(['cheap-room','qualifying-room'].includes(sku!)?[{pool:'room-capacity'}]:[])]})),
    request:{checkIn:start,checkOut:end,benefits:[{code:'dinner',date:start,roomIndex:0,quantity:2}]}};
  solve(fixture,r=>{const best=r.plans[0]!;assert.equal(best.totalMinor,'62000');assert(best.purchases.some(p=>p.sku.id.endsWith(':qualifying-room')));
    const room=best.path.findIndex(p=>p.kind==='redemption_simulation'&&p.sku.id.endsWith(':qualifying-room')),addon=best.path.findIndex(p=>p.kind==='purchase_simulation'&&p.sku.id.endsWith(':addon'));assert(room>=0&&addon>room);});
});
test('activation fee is included once across two discounted nights',()=>{
  const fixture:StudyFixture={environment:'synthetic',id:'activation',skus:[
    {id:'membership',category:'activation',components:[]},
    {id:'member-room',maxUnits:2,components:[stay()],prerequisites:[{sku:'membership',basis:'per_plan',phase:'redemption'}]},
    {id:'normal-room',maxUnits:2,components:[stay()]},
  ],pools:[roomPool('night-1',start),roomPool('night-2',day(start,1)),...sales(['membership']),...sales(['member-room','normal-room'],2)],
    quotes:[{id:'activation-price',sku:'membership',anchorDate:start,amountMinor:'3000',resources:[{pool:'sale-membership'}]},
      ...['member-room','normal-room'].flatMap(sku=>[0,1].map(n=>({id:sku+n,sku,anchorDate:day(start,n),amountMinor:sku==='member-room'?'40000':'45000',resources:[{pool:'sale-'+sku},{pool:'night-'+(n+1)}]})))],
    request:{checkIn:start,checkOut:day(start,2)}};
  solve(fixture,r=>{assert.equal(r.plans[0]!.totalMinor,'83000');assert.equal(r.plans[0]!.purchases.filter(p=>p.sku.id.endsWith(':membership')).length,1);assert.equal(r.plans[0]!.purchases.length,3);});
});
test('one customer coupon cannot discount two rooms; shared inventory is enforced across SKUs',()=>{
  const fixture:StudyFixture={environment:'synthetic',id:'one-coupon',skus:[{id:'room',maxUnits:2,components:[stay()]}],
    pools:[roomPool('rooms',start,2),...sales(['room'],2),{id:'coupon',kind:'promotion',capacity:1,skus:['room']}],
    quotes:[{id:'discount',sku:'room',anchorDate:start,amountMinor:'50000',discount:{state:'confirmed',amountMinor:'10000',limited:true},resources:[{pool:'sale-room'},{pool:'rooms'},{pool:'coupon'}]},
      {id:'full',sku:'room',anchorDate:start,amountMinor:'50000',resources:[{pool:'sale-room'},{pool:'rooms'}]}],
    request:{checkIn:start,checkOut:end,rooms:[{adults:2,childrenAges:[]},{adults:2,childrenAges:[]}]}};
  solve(fixture,r=>{assert.equal(r.plans[0]!.totalMinor,'90000');assert.equal(r.plans[0]!.resourceUsage.find(p=>p.pool.id.endsWith(':coupon'))!.quantity,1);});
  const shared:StudyFixture={environment:'synthetic',id:'shared-room',skus:[{id:'a',components:[stay()]},{id:'b',components:[stay()]}],
    pools:[roomPool('shared',start,1),...sales(['a','b'])],quotes:['a','b'].map((sku,n)=>({id:sku+'-q',sku,anchorDate:start,amountMinor:String(40000+n*10000),resources:[{pool:'shared'},{pool:'sale-'+sku}]})),request:fixture.request};
  solve(shared,r=>{assert.equal(r.status,'no_solution');assert.equal(r.plans.length,0);});
});
test('split and consecutive stay constraints change the cheapest composition',()=>{
  const base:StudyFixture={environment:'synthetic',id:'split',skus:[{id:'single',maxUnits:2,components:[stay()]},{id:'continuous',components:[stay(2)]}],
    pools:[roomPool('n1',start),roomPool('n2',day(start,1)),...sales(['single'],2),...sales(['continuous'])],
    quotes:[...['n1','n2'].map((pool,n)=>({id:'single'+n,sku:'single',anchorDate:day(start,n),amountMinor:'30000',resources:[{pool},{pool:'sale-single'}]})),{id:'continuous-price',sku:'continuous',anchorDate:start,amountMinor:'70000',resources:[{pool:'n1'},{pool:'n2'},{pool:'sale-continuous'}]}],request:{checkIn:start,checkOut:day(start,2),allowSplitStay:true}};
  solve(base,r=>assert.equal(r.plans[0]!.totalMinor,'60000'));
  solve({...base,id:'continuous-required',request:{...base.request,allowSplitStay:false}},r=>assert.equal(r.plans[0]!.totalMinor,'70000'));
});
test('per-stay breakfast is not repeated per night and included benefits are not counted twice',()=>{
  const fixture:StudyFixture={environment:'synthetic',id:'breakfast-repeat',entitlements:[{code:'breakfast'}],skus:[
    {id:'stay-breakfast',category:'bundle',components:[stay(2),benefit('breakfast',2,'per_stay',1)]},
    {id:'night-breakfast',category:'bundle',components:[stay(2),benefit('breakfast',2,'per_night',1)]},
    {id:'extra-breakfast',category:'benefit',components:[benefit('breakfast',2,'per_package',1)]},
  ],pools:[roomPool('n1',start),roomPool('n2',day(start,1)),...sales(['stay-breakfast','night-breakfast','extra-breakfast'])],
    quotes:[...['stay-breakfast','night-breakfast'].map(sku=>({id:sku+'-price',sku,anchorDate:start,amountMinor:sku==='stay-breakfast'?'50000':'55000',resources:[{pool:'n1'},{pool:'n2'},{pool:'sale-'+sku}]})),{id:'extra',sku:'extra-breakfast',anchorDate:day(start,1),amountMinor:'6000',resources:[{pool:'sale-extra-breakfast'}]}],
    request:{checkIn:start,checkOut:day(start,2),benefits:[{code:'breakfast',date:day(start,1),roomIndex:0,quantity:2},{code:'breakfast',date:day(start,2),roomIndex:0,quantity:2}]}};
  solve(fixture,r=>{assert.equal(r.plans[0]!.totalMinor,'55000');assert.equal(r.plans[1]!.totalMinor,'56000');assert.equal(r.plans[0]!.purchases.length,1);});
});
test('unused optional rights do not consume restaurant stock or become a cash rebate',()=>{
  const fixture:StudyFixture={environment:'synthetic',id:'optional-meal',entitlements:[{code:'dinner',inventoryRequired:true}],skus:[{id:'bundle',category:'bundle',components:[stay(),{...benefit('dinner'),id:'meal',optional:true}]}],
    pools:[roomPool('room',start),...sales(['bundle']),{id:'dinner-pool',kind:'benefit',capacity:0,date:start,entitlement:'dinner'}],quotes:[{id:'bundle-price',sku:'bundle',anchorDate:start,amountMinor:'50000',resources:[{pool:'room'},{pool:'sale-bundle'},{pool:'dinner-pool',quantity:2,component:'meal'}]}],request:{checkIn:start,checkOut:end}};
  solve(fixture,r=>{assert.equal(r.status,'optimal');assert.equal(r.plans[0]!.totalMinor,'50000');assert(!r.plans[0]!.resourceUsage.some(u=>u.pool.id.endsWith(':dinner-pool')));});
});
test('fees and immediate discounts are exact integers; platform commission does not lower user cost',()=>{
  const base=packageDemoFixture(false);base.id='commission';base.skus.find(s=>s.id==='bundle')!.platformCommissionMinor='50000';
  base.quotes.find(q=>q.sku==='bundle')!.fees=[{code:'mandatory',amountMinor:'10000'}];
  solve(base,r=>assert.equal(r.plans[0]!.totalMinor,'65900'));
  const huge=packageDemoFixture(false);huge.id='bigint';huge.skus=huge.skus.filter(s=>s.id==='bundle');huge.quotes=huge.quotes.filter(q=>q.sku==='bundle');huge.quotes[0]!.amountMinor='900719925474099301';huge.quotes[0]!.fees=[{code:'fee',amountMinor:'11'}];huge.pools=huge.pools.filter(p=>p.id==='rooms'||p.skus?.includes('bundle'));
  solve(huge,r=>assert.equal(r.plans[0]!.totalMinor,'900719925474099312'));
});

test('a qualifying voucher with no requested benefit can unlock a cheaper path, only if allowed',()=>{
  const f:StudyFixture={environment:'synthetic',id:'qualification-voucher',entitlements:[{code:'unused-dinner'}],skus:[
    {id:'voucher',category:'benefit',components:[{...benefit('unused-dinner'),optional:true}]},
    {id:'qualified-room',components:[stay()],prerequisites:[{sku:'voucher',phase:'purchase'}]},
    {id:'plain-room',components:[stay()]},
  ],pools:[roomPool('room',start),...sales(['voucher','qualified-room','plain-room'])],quotes:[
    {id:'voucher-price',sku:'voucher',anchorDate:start,amountMinor:'10000',resources:[{pool:'sale-voucher'}]},
    {id:'qualified-price',sku:'qualified-room',anchorDate:start,amountMinor:'39900',resources:[{pool:'sale-qualified-room'},{pool:'room'}]},
    {id:'plain-price',sku:'plain-room',anchorDate:start,amountMinor:'59900',resources:[{pool:'sale-plain-room'},{pool:'room'}]},
  ],request:{checkIn:start,checkOut:end,allowQualificationPurchases:true}};
  solve(f,r=>{assert.equal(r.plans[0]!.totalMinor,'49900');const voucher=r.plans[0]!.purchases.find(p=>p.sku.id.endsWith(':voucher'))!;assert.equal(voucher.components.length,0);assert(!r.plans[0]!.path.some(p=>p.kind==='redemption_simulation'&&p.sku.id.endsWith(':voucher')));});
  solve({...f,id:'qualification-not-allowed',request:{...f.request,allowQualificationPurchases:false}},r=>assert.equal(r.plans[0]!.totalMinor,'59900'));
});
test('two included units of the same entitlement share one correctly measured stock pool',()=>{
  const f:StudyFixture={environment:'synthetic',id:'two-entitlements',entitlements:[{code:'dinner',inventoryRequired:true}],skus:[{id:'bundle',category:'bundle',components:[stay(),{...benefit('dinner',1),id:'meal-a'},{...benefit('dinner',1),id:'meal-b'}]}],pools:[roomPool('room',start),...sales(['bundle']),{id:'meals',kind:'benefit',date:start,capacity:2,entitlement:'dinner'}],quotes:[{id:'price',sku:'bundle',anchorDate:start,amountMinor:'50000',resources:[{pool:'room'},{pool:'sale-bundle'},{pool:'meals',quantity:1,component:'meal-a'},{pool:'meals',quantity:1,component:'meal-b'}]}],request:{checkIn:start,checkOut:end,benefits:[{code:'dinner',date:start,roomIndex:0,quantity:2}]}};
  solve(f,r=>{assert.equal(r.status,'optimal');assert.equal(r.plans[0]!.resourceUsage.find(r=>r.pool.id.endsWith(':meals'))!.quantity,2);});
});

test('per-unit prerequisite counts cannot be replaced by one reusable activation',()=>{
  const f:StudyFixture={environment:'synthetic',id:'per-unit',skus:[{id:'license',category:'activation',maxUnits:2,components:[]},{id:'room',maxUnits:2,components:[stay()],prerequisites:[{sku:'license',basis:'per_unit',phase:'redemption'}]}],
    pools:[roomPool('rooms',start,2),...sales(['license','room'],2)],quotes:[{id:'license-price',sku:'license',anchorDate:start,amountMinor:'3000',resources:[{pool:'sale-license'}]},{id:'room-price',sku:'room',anchorDate:start,amountMinor:'50000',resources:[{pool:'sale-room'},{pool:'rooms'}]}],request:{checkIn:start,checkOut:end,rooms:[{adults:2,childrenAges:[]},{adults:2,childrenAges:[]}]}};
  solve(f,r=>{assert.equal(r.plans[0]!.totalMinor,'106000');assert.equal(r.plans[0]!.purchases.filter(p=>p.sku.id.endsWith(':license')).length,2);});
});
