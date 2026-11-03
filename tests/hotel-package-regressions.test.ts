import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../packages/core/delegation.js';
import { createSyntheticPackageStudy, type StudyFixture } from '../packages/ontology/hotel-package-optimization/synthetic.js';
import { optimizeSyntheticHotelPackages as optimize } from '../packages/ontology/hotel-package-optimization/search.js';
import { verifySyntheticHotelPackagePlan as verify } from '../packages/ontology/hotel-package-optimization/verify.js';
import { packageDemoFixture } from '../packages/ontology/hotel-package-optimization/demo.js';
import { StudyReader } from '../packages/ontology/hotel-package-optimization/graph.js';
// Independent count-vector oracle: enumerate dated voucher holdings without
// invoking the solver's prerequisite grouping or matching implementation.
test('overlapping possession predicates match exhaustive dated holdings across quantities, bases and rule order',()=>{
  for(const basis of ['per_plan','per_unit'] as const)for(const anchor of ['same_date','any'] as const)for(let first=1;first<=3;first++)for(let second=1;second<=3;second++)for(const reverse of [false,true]){
    const f=structuredClone(overlap);f.id=`overlap-${basis}-${anchor}-${first}-${second}-${reverse}`;
    f.skus[0]!.prerequisites=[{sku:'voucher',quantity:first,anchor,dayOffset:0,basis},{sku:'voucher',quantity:second,anchor,dayOffset:1,basis}];
    if(reverse)f.skus[0]!.prerequisites!.reverse();f.skus[1]!.maxUnits=10;f.pools.find(p=>p.id==='vsale')!.capacity=10;
    let expected:number|undefined;
    for(let a=0;a<=6;a++)for(let b=0;b<=6;b++)for(let c=0;c<=6;c++){
      const count=a+b+c;if(count>10)continue;
      const valid=anchor==='any'?count>=Math.max(first,second)*(basis==='per_unit'?2:1):a>=first&&b>=Math.max(first,second)&&c>=second;
      if(valid&&(expected===undefined||count<expected))expected=count;
    }
    const s=createSyntheticPackageStudy(f);try{const r=optimize(s.graph,s.owner,s.request,{maxPlans:1});assert.equal(r.status,'optimal');assert.equal(r.plans[0]!.totalMinor,String(20000+expected!*1000));assert.equal(verify(s.graph,s.owner,r).accepted,true);}finally{s.close();}
  }
});
test('the hand-counted overlap is 25000 and the old underpriced plan is rejected',()=>{
  const s=createSyntheticPackageStudy(overlap);try{const r=optimize(s.graph,s.owner,s.request,{maxPlans:1});assert.equal(r.plans[0]!.totalMinor,'25000');assert.equal(verify(s.graph,s.owner,r).accepted,true);const old=structuredClone(r);old.plans[0]!.totalMinor='24000';assert.equal(verify(s.graph,s.owner,old).accepted,false);}finally{s.close();}
});
test('a search stopping after its first feasible plan keeps best_known rather than claiming optimal',()=>{
  const s=createSyntheticPackageStudy(packageDemoFixture(true));try{
    const limited=optimize(s.graph,s.owner,s.request,{maxNodes:4,maxPlans:1});
    assert.equal(limited.search.complete,false);assert.equal(limited.status,'best_known');assert.equal(verify(s.graph,s.owner,limited).accepted,true);
    const complete=optimize(s.graph,s.owner,s.request,{maxPlans:1});assert.equal(complete.status,'optimal');assert.equal(complete.plans[0]!.totalMinor,'69900');
  }finally{s.close();}
});
test('reader reuses complete relationship results only within its instance and retains bounds, revision and provenance checks',()=>{
  const s=createSyntheticPackageStudy(packageDemoFixture(true));try{
    const reader=new StudyReader(s.graph,s.owner);let calls=0;const related=s.graph.related;
    s.graph.related=function(...args){calls++;return related.apply(this,args);};
    const first=reader.related(s.catalog,'skus',30);assert.equal(first.length,4);reader.related(s.catalog,'skus',30);assert.equal(calls,1);
    assert.throws(()=>reader.related(s.catalog,'skus',1),/bound/);
    const next=new StudyReader(s.graph,s.owner);next.related(s.catalog,'skus',30);assert.equal(calls,2);
    const q=s.refs.get('PackageDatedQuote:bundle-price')!,old=s.graph.read(s.owner,q);
    s.graph.ingest(s.owner,{objects:[{ref:q,expectedRevision:old.revision,properties:{...old.properties,data:{...(old.properties.data as Record<string,unknown>),amountMinor:'90000'}}}]},s.source);
    assert.throws(()=>reader.snapshot(),/changed/);
    assert.equal(optimize(s.graph,s.owner,s.request,{maxPlans:1}).plans[0]!.totalMinor,'77900');
    s.advance(3600001);assert.equal(optimize(s.graph,s.owner,s.request,{maxPlans:1}).plans.length,0);
    assert.throws(()=>optimize(s.graph,'another-owner',s.request),/not found/);
  }finally{s.close();}
});
test('reusing historical relationship views cannot admit tombstoned or foreign-source facts',()=>{
  for(const mode of ['tombstone','foreign-source'] as const){
    const s=createSyntheticPackageStudy(packageDemoFixture(true));try{
      const related=s.graph.related;
      s.graph.related=function(...args){const views=related.apply(this,args);if(args[2]==='skus'&&views.length){if(mode==='tombstone')views[0]!.tombstone={revision:2,deletedAt:'2030-01-01T00:00:00Z'};else views[0]!.source.id='another-dataset';}return views;};
      assert.throws(()=>optimize(s.graph,s.owner,s.request),mode==='tombstone'?/Tombstoned/:/different synthetic dataset/);
    }finally{s.close();}
  }
});
const overlap:StudyFixture={
  "environment": "synthetic",
  "id": "overlap-minimal",
  "entitlements": [
    {
      "code": "breakfast"
    }
  ],
  "skus": [
    {
      "id": "room",
      "maxUnits": 2,
      "components": [
        {
          "kind": "stay",
          "rooms": 1,
          "nights": 1,
          "conditionsKnown": true
        }
      ],
      "prerequisites": [
        {
          "sku": "voucher",
          "quantity": 2,
          "anchor": "same_date",
          "dayOffset": 0
        },
        {
          "sku": "voucher",
          "quantity": 1,
          "anchor": "same_date",
          "dayOffset": 1
        }
      ]
    },
    {
      "id": "voucher",
      "category": "benefit",
      "maxUnits": 5,
      "components": [
        {
          "kind": "benefit",
          "quantity": 1,
          "repeat": "per_package",
          "dayOffset": 0,
          "optional": false,
          "conditionsKnown": true,
          "entitlement": "breakfast"
        }
      ]
    }
  ],
  "pools": [
    {
      "id": "roomsale",
      "kind": "sale",
      "capacity": 2,
      "skus": [
        "room"
      ]
    },
    {
      "id": "vsale",
      "kind": "sale",
      "capacity": 5,
      "skus": [
        "voucher"
      ]
    },
    {
      "id": "r0",
      "kind": "room",
      "capacity": 1,
      "date": "2030-01-10"
    },
    {
      "id": "r1",
      "kind": "room",
      "capacity": 1,
      "date": "2030-01-11"
    }
  ],
  "quotes": [
    {
      "id": "room0",
      "sku": "room",
      "anchorDate": "2030-01-10",
      "amountMinor": "10000",
      "resources": [
        {
          "pool": "roomsale"
        },
        {
          "pool": "r0"
        }
      ]
    },
    {
      "id": "room1",
      "sku": "room",
      "anchorDate": "2030-01-11",
      "amountMinor": "10000",
      "resources": [
        {
          "pool": "roomsale"
        },
        {
          "pool": "r1"
        }
      ]
    },
    {
      "id": "voucher0",
      "sku": "voucher",
      "anchorDate": "2030-01-10",
      "amountMinor": "1000",
      "resources": [
        {
          "pool": "vsale"
        }
      ]
    },
    {
      "id": "voucher1",
      "sku": "voucher",
      "anchorDate": "2030-01-11",
      "amountMinor": "1000",
      "resources": [
        {
          "pool": "vsale"
        }
      ]
    },
    {
      "id": "voucher2",
      "sku": "voucher",
      "anchorDate": "2030-01-12",
      "amountMinor": "1000",
      "resources": [
        {
          "pool": "vsale"
        }
      ]
    }
  ],
  "request": {
    "checkIn": "2030-01-10",
    "checkOut": "2030-01-12"
  }
};

test('independent replay rejects a supplied plan accounting for only one of two mandatory stays',()=>{
  const f=packageDemoFixture(true);f.id='replay-two-stays';const s=createSyntheticPackageStudy(f);
  try{
    const r=optimize(s.graph,s.owner,s.request,{maxPlans:1});
    const extra={type:'PackageComponent',id:f.id+':extra-stay'},sku=s.refs.get('PackageSkuSpecification:bundle')!,room=s.refs.get('RoomType:king')!;
    s.graph.ingest(s.owner,{objects:[{ref:extra,properties:{id:extra.id,displayTitle:'Synthetic second mandatory stay',data:{kind:'stay',rooms:1,nights:1,conditionsKnown:true}}}],links:[{type:'PackageSkuComponents',from:sku,to:extra},{type:'PackageComponentRoomTypes',from:extra,to:room}]},s.source);
    const fresh=optimize(s.graph,s.owner,s.request,{maxPlans:1}),forged=structuredClone(r);forged.inputDigest=fresh.inputDigest;forged.status='best_known';forged.search=fresh.search;
    const p=forged.plans[0]!.purchases.find(p=>p.sku.id===sku.id)!;p.components.push(extra);p.components.sort((a,b)=>JSON.stringify([a.type,a.id]).localeCompare(JSON.stringify([b.type,b.id])));
    const old=p.id;p.id=digest({quote:p.quote,roomIndex:p.roomIndex,components:p.components});forged.plans[0]!.purchases.sort((a,b)=>a.id.localeCompare(b.id));forged.plans[0]!.id=digest(forged.plans[0]!.purchases.map(p=>p.id));
    for(const step of forged.plans[0]!.path){step.id=step.id.replace(old.slice(0,20),p.id.slice(0,20));step.dependsOn=step.dependsOn.map(x=>x.replace(old.slice(0,20),p.id.slice(0,20)));}
    const v=verify(s.graph,s.owner,forged);assert.equal(v.accepted,false);assert(v.reasons.includes('multi_room_unit_not_supported'));assert.equal(fresh.plans[0]!.totalMinor,'77900');
  }finally{s.close();}
});
