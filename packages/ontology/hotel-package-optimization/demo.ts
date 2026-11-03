import { pathToFileURL } from 'node:url';
import { createSyntheticPackageStudy, type StudyFixture } from './synthetic.js';
import { optimizeSyntheticHotelPackages } from './search.js';
import { verifySyntheticHotelPackagePlan } from './verify.js';

export function packageDemoFixture(needsDinner=true):StudyFixture{
  const date='2030-01-10';
  return{environment:'synthetic',id:needsDinner?'demo-with-dinner':'demo-no-dinner',entitlements:[{code:'breakfast'},{code:'dinner'}],
    skus:[
      {id:'room',components:[{kind:'stay',rooms:1,nights:1,conditionsKnown:true}]},
      {id:'breakfast',category:'benefit',components:[{kind:'benefit',quantity:2,repeat:'per_package',dayOffset:1,optional:false,conditionsKnown:true,entitlement:'breakfast'}]},
      {id:'dinner',category:'benefit',components:[{kind:'benefit',quantity:2,repeat:'per_package',dayOffset:0,optional:false,conditionsKnown:true,entitlement:'dinner'}]},
      {id:'bundle',category:'bundle',components:[{kind:'stay',rooms:1,nights:1,conditionsKnown:true},{kind:'benefit',quantity:2,repeat:'per_night',dayOffset:1,optional:false,conditionsKnown:true,entitlement:'breakfast'},{kind:'benefit',quantity:2,repeat:'per_stay',dayOffset:0,optional:false,conditionsKnown:true,entitlement:'dinner'}]},
    ],pools:[{id:'rooms',kind:'room',capacity:1,date},...['room','breakfast','dinner','bundle'].map(sku=>({id:'sale-'+sku,kind:'sale' as const,capacity:1,skus:[sku]}))],
    quotes:[{id:'room-price',sku:'room',anchorDate:date,amountMinor:'59900',resources:[{pool:'sale-room'},{pool:'rooms'}]},
      {id:'breakfast-price',sku:'breakfast',anchorDate:date,amountMinor:'6000',resources:[{pool:'sale-breakfast'}]},
      {id:'dinner-price',sku:'dinner',anchorDate:date,amountMinor:'12000',resources:[{pool:'sale-dinner'}]},
      {id:'bundle-price',sku:'bundle',anchorDate:date,amountMinor:'69900',resources:[{pool:'sale-bundle'},{pool:'rooms'}]}],
    request:{checkIn:date,checkOut:'2030-01-11',benefits:[{code:'breakfast',date:'2030-01-11',roomIndex:0,quantity:2},...(needsDinner?[{code:'dinner',date,roomIndex:0,quantity:2}]:[])]}};
}
export function runPackageDemo(){
  return [true,false].map(needsDinner=>{
    const study=createSyntheticPackageStudy(packageDemoFixture(needsDinner));
    try{
      const result=optimizeSyntheticHotelPackages(study.graph,study.owner,study.request);
      const verification=verifySyntheticHotelPackagePlan(study.graph,study.owner,result);
      return{scenario:needsDinner?'room + breakfast + dinner':'room + breakfast only',synthetic:true,status:result.status,bestTotalMinor:result.plans[0]?.totalMinor,currency:'CNY',bestSkus:result.plans[0]?.purchases.map(p=>p.sku.id),alternatives:result.plans.map(p=>({totalMinor:p.totalMinor,skus:p.purchases.map(x=>x.sku.id)})),path:result.plans[0]?.path,verification,search:result.search};
    }finally{study.close();}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(runPackageDemo(),null,2));
