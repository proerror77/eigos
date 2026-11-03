import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticPackageStudy, type StudyFixture } from '../packages/ontology/hotel-package-optimization/synthetic.js';
import { optimizeSyntheticHotelPackages } from '../packages/ontology/hotel-package-optimization/search.js';
import { verifySyntheticHotelPackagePlan } from '../packages/ontology/hotel-package-optimization/verify.js';
import { packageDemoFixture } from '../packages/ontology/hotel-package-optimization/demo.js';
import type { OptimizationResult } from '../packages/ontology/hotel-package-optimization/contracts.js';

const start='2030-01-10';
function run(fixture:StudyFixture,check:(result:OptimizationResult,study:ReturnType<typeof createSyntheticPackageStudy>)=>void,bounds={}){
  const study=createSyntheticPackageStudy(fixture);try{check(optimizeSyntheticHotelPackages(study.graph,study.owner,study.request,bounds),study);}finally{study.close();}
}
test('unknown prices, composition and inventory are not zero-cost or available candidates',()=>{
  for(const field of ['price','nights','inventory','fees'] as const){
    const f=packageDemoFixture(true);f.id='unknown-'+field;
    if(field==='price'){f.quotes.find(q=>q.sku==='bundle')!.priceKind='from';f.quotes.find(q=>q.sku==='bundle')!.amountMinor='100';}
    if(field==='nights'){const c=f.skus.find(s=>s.id==='bundle')!.components.find(c=>c.kind==='stay')!;if(c.kind==='stay')c.nights=null;}
    if(field==='inventory'){f.pools.find(p=>p.id==='sale-bundle')!.state='unknown';f.pools.find(p=>p.id==='sale-bundle')!.capacity=null;}
    if(field==='fees')f.quotes.find(q=>q.sku==='bundle')!.feesKnown=false;
    run(f,r=>{assert.equal(r.status,'best_known');assert.equal(r.plans[0]!.totalMinor,'77900');assert(r.search.unknownCandidates>0);});
  }
  const all=packageDemoFixture(true);all.id='all-unknown';for(const q of all.quotes){q.priceKind='unknown';q.amountMinor=null;}
  run(all,r=>{assert.equal(r.status,'inconclusive');assert.equal(r.plans.length,0);});
});
test('partial catalog or work bounds never produce an unsupported optimum claim',()=>{
  const f=packageDemoFixture(true);f.id='partial';f.completeness='partial';run(f,r=>assert.equal(r.status,'best_known'));
  run(packageDemoFixture(true),r=>{assert.equal(r.status,'inconclusive');assert.equal(r.search.complete,false);assert.equal(r.search.visitedNodes,1);},{maxNodes:1});
  run(packageDemoFixture(true),r=>{assert.notEqual(r.status,'optimal');assert.equal(r.search.complete,false);},{maxRealizations:1});
  run(packageDemoFixture(true),(full)=>run(packageDemoFixture(true),bounded=>{assert.equal(bounded.status,'optimal');assert.equal(bounded.search.complete,true);},{maxNodes:full.search.visitedNodes}));
});
test('wrong parties, cancellation, fees, currency and budget eliminate invalid paths',()=>{
  const guest=packageDemoFixture(true);guest.id='wrong-party';guest.quotes.find(q=>q.sku==='bundle')!.guest={adults:1,childrenAges:[]};run(guest,r=>assert.equal(r.plans[0]!.totalMinor,'77900'));
  const cancel=packageDemoFixture(true);cancel.id='cancellation';cancel.request.cancellationAt='2030-01-09T00:00:00Z';for(const q of cancel.quotes)q.cancellation={state:'known',freeUntil:q.sku==='bundle'?null:'2030-01-09T01:00:00Z'};run(cancel,r=>assert.equal(r.plans[0]!.totalMinor,'77900'));
  const currency=packageDemoFixture(true);currency.id='currency';currency.quotes.find(q=>q.sku==='bundle')!.currency='USD';run(currency,r=>assert.equal(r.plans[0]!.totalMinor,'77900'));
  const budget=packageDemoFixture(true);budget.id='budget';budget.request.maxTotalMinor='69000';run(budget,r=>assert.equal(r.status,'no_solution'));
});
test('capacity and permitted room-type continuity are applied to each stay path',()=>{
  const f:StudyFixture={environment:'synthetic',id:'room-change',roomTypes:[{id:'king'},{id:'twin'}],skus:[{id:'room',maxUnits:2,components:[{kind:'stay',rooms:1,nights:1,conditionsKnown:true,roomTypes:['king','twin']}]}],
    pools:[...['king','twin'].flatMap(type=>[0,1].map(n=>({id:type+n,kind:'room' as const,capacity:1,date:n?'2030-01-11':start,roomTypes:[type]}))),{id:'sale',kind:'sale',capacity:2,skus:['room']}],
    quotes:['king','twin'].flatMap(type=>[0,1].map(n=>({id:type+'-price-'+n,sku:'room',roomType:type,anchorDate:n?'2030-01-11':start,amountMinor:(type==='king'&&n===0||type==='twin'&&n===1)?'30000':'60000',resources:[{pool:type+n},{pool:'sale'}]}))),request:{checkIn:start,checkOut:'2030-01-12',allowRoomTypeChange:false}};
  run(f,r=>assert.equal(r.plans[0]!.totalMinor,'90000'));
  run({...f,id:'room-change-allowed',request:{...f.request,allowRoomTypeChange:true}},r=>assert.equal(r.plans[0]!.totalMinor,'60000'));
  const capacity=packageDemoFixture(true);capacity.id='capacity';capacity.request.rooms=[{adults:3,childrenAges:[]}];for(const q of capacity.quotes)q.guest={adults:3,childrenAges:[]};run(capacity,r=>assert.equal(r.status,'no_solution'));
});
test('independent replay rejects altered costs, coverage, inventory and simulated execution flags',()=>{
  run(packageDemoFixture(true),(result,study)=>{
    assert.equal(verifySyntheticHotelPackagePlan(study.graph,study.owner,result).accepted,true);
    const changes=[(r:OptimizationResult)=>{r.plans[0]!.totalMinor='1';},(r:OptimizationResult)=>{r.plans[0]!.purchases[0]!.coverage[0]=0;},(r:OptimizationResult)=>{r.plans[0]!.purchases[0]!.resources={};},(r:OptimizationResult)=>{(r as unknown as {executed:boolean}).executed=true;}];
    const revision=study.graph.revision(study.owner);
    for(const change of changes){const tampered=structuredClone(result);change(tampered);assert.equal(verifySyntheticHotelPackagePlan(study.graph,study.owner,tampered).accepted,false);}
    assert.equal(study.graph.revision(study.owner),revision,'Replay is read-only');
  });
});
test('snapshot bindings expire after source changes or freshness deadlines',()=>{
  run(packageDemoFixture(true),(result,study)=>{
    const quote=study.graph.read(study.owner,result.plans[0]!.purchases[0]!.quote),data=quote.properties.data as Record<string,unknown>;
    study.graph.ingest(study.owner,{objects:[{ref:quote.ref,expectedRevision:quote.revision,properties:{...quote.properties,data:{...data,amountMinor:'90000'}}}]},study.source);
    const proof=verifySyntheticHotelPackagePlan(study.graph,study.owner,result);assert.equal(proof.accepted,false);assert(proof.reasons.includes('input_snapshot_changed'));
  });
  run(packageDemoFixture(true),(result,study)=>{study.advance(3600001);assert.equal(verifySyntheticHotelPackagePlan(study.graph,study.owner,result).accepted,false);});
});
test('dependency activation/redemption ordering is replayed rather than trusted from the solver',()=>{
  const f:StudyFixture={environment:'synthetic',id:'prerequisite-path',skus:[{id:'member',category:'activation',components:[]},{id:'room',components:[{kind:'stay',rooms:1,nights:1,conditionsKnown:true}],prerequisites:[{sku:'member',phase:'redemption'}]}],
    pools:[{id:'sale-member',kind:'sale',capacity:1,skus:['member']},{id:'sale-room',kind:'sale',capacity:1,skus:['room']},{id:'room-night',kind:'room',capacity:1,date:start}],quotes:[{id:'member-price',sku:'member',anchorDate:start,amountMinor:'3000',resources:[{pool:'sale-member'}]},{id:'room-price',sku:'room',anchorDate:start,amountMinor:'40000',resources:[{pool:'sale-room'},{pool:'room-night'}]}],request:{checkIn:start,checkOut:'2030-01-11'}};
  run(f,(result,study)=>{
    assert.equal(result.plans[0]!.totalMinor,'43000');assert.equal(verifySyntheticHotelPackagePlan(study.graph,study.owner,result).accepted,true);
    const tampered=structuredClone(result);tampered.plans[0]!.path.find(p=>p.kind==='purchase_simulation'&&p.sku.id.endsWith(':room'))!.dependsOn=[];
    assert(verifySyntheticHotelPackagePlan(study.graph,study.owner,tampered).reasons.includes('prerequisite_path_missing'));
  });
  const cycle=structuredClone(f);cycle.id='cycle';cycle.skus[0]!.prerequisites=[{sku:'room'}];const study=createSyntheticPackageStudy(cycle);try{assert.throws(()=>optimizeSyntheticHotelPackages(study.graph,study.owner,study.request),/cycle/);}finally{study.close();}
});
test('synthetic scope, explicit native SKU identity and ownership cannot be replaced by live data or titles',()=>{
  run(packageDemoFixture(true),(_r,study)=>{
    assert.throws(()=>optimizeSyntheticHotelPackages(study.graph,'another-owner',study.request),/not found/);
    const catalog=study.graph.read(study.owner,study.catalog);study.graph.ingest(study.owner,{objects:[{ref:catalog.ref,expectedRevision:catalog.revision,properties:catalog.properties}]},{...study.source,kind:'provider'});
    assert.throws(()=>optimizeSyntheticHotelPackages(study.graph,study.owner,study.request),/synthetic provenance/);
  });
  const mapping=packageDemoFixture(true);mapping.id='missing-room-map';for(const sku of mapping.skus)for(const component of sku.components)if(component.kind==='stay')component.roomTypes=[];
  run(mapping,r=>{assert.equal(r.status,'inconclusive');assert.equal(r.plans.length,0);});
});

test('optimization reuses room and native SKU identities and never writes a supplier SKU or execution',()=>{
  const f=packageDemoFixture(true);f.id='stable-identities';for(const sku of f.skus)sku.productId='one-product';
  const study=createSyntheticPackageStudy(f);
  try{
    const before=study.graph.revision(study.owner),variants=study.graph.query(study.owner,{type:'ProductVariant'}).items.map(v=>[v.ref,v.revision]);
    const result=optimizeSyntheticHotelPackages(study.graph,study.owner,study.request);
    assert.equal(result.evidenceLevel,'synthetic');assert.equal(result.bookable,false);assert.equal(result.executed,false);
    assert.equal(study.graph.query(study.owner,{type:'PackageProduct'}).items.length,1);
    assert.equal(study.graph.query(study.owner,{type:'RoomType'}).items.length,1);
    assert.deepEqual(study.graph.query(study.owner,{type:'ProductVariant'}).items.map(v=>[v.ref,v.revision]),variants);
    assert.equal(study.graph.revision(study.owner),before);
  }finally{study.close();}
});

test('an unquoted relevant SKU is unknown, not a zero-cost item or a proof of absence',()=>{
  const fixture=packageDemoFixture(true);fixture.id='unquoted-sku';fixture.quotes=fixture.quotes.filter(q=>q.sku!=='bundle');
  run(fixture,r=>{assert.equal(r.status,'best_known');assert.equal(r.plans[0]!.totalMinor,'77900');assert(r.diagnostics.some(d=>d.reason==='dated_quote_missing'));});
});

test('a linked rate plan restricts a multi-room-type component to its actual room type',()=>{
  const fixture:StudyFixture={environment:'synthetic',id:'rate-plan-room',roomTypes:[{id:'king'},{id:'twin'}],
    skus:[{id:'room',components:[{kind:'stay',rooms:1,nights:1,conditionsKnown:true,roomTypes:['king','twin']}]}],
    pools:[{id:'sale',kind:'sale',capacity:1,skus:['room']},...['king','twin'].map(type=>({id:type,kind:'room' as const,capacity:1,date:start,roomTypes:[type]}))],
    quotes:['king','twin'].map(type=>({id:type,sku:'room',roomType:type,anchorDate:start,amountMinor:type==='king'?'50000':'10000',resources:[{pool:'sale'},{pool:type}]})),
    request:{checkIn:start,checkOut:'2030-01-11'}};
  const study=createSyntheticPackageStudy(fixture);
  try{
    const hotel=study.refs.get('HotelProperty:hotel')!,king=study.refs.get('RoomType:king')!,component=study.refs.get('PackageComponent:room-component-0')!;
    const rate={type:'HotelRatePlan',id:fixture.id+':king-rate'};
    study.graph.ingest(study.owner,{objects:[{ref:rate,properties:{objectId:rate.id,displayTitle:'Synthetic king rate',sourceId:'king-rate',sourceRevision:'1',hotelId:hotel.id,roomTypeId:king.id}}],
      links:[{type:'HotelRatePlanHotel',from:rate,to:hotel},{type:'HotelRatePlanRoomType',from:rate,to:king},{type:'PackageComponentRatePlan',from:component,to:rate}]},study.source);
    const result=optimizeSyntheticHotelPackages(study.graph,study.owner,study.request);
    assert.equal(result.plans[0]!.totalMinor,'50000');
    assert.equal(result.status,'best_known');
    assert(result.diagnostics.some(d=>d.reason==='rate_plan_room_mismatch'));
    assert.equal(verifySyntheticHotelPackagePlan(study.graph,study.owner,result).accepted,true);
  }finally{study.close();}
});
