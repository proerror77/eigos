import {rideQuerySchema,rideHandoffSchema,type RideQuery} from './contracts.js';
export function uberHandoff(query:RideQuery,productId:string){
  const q=rideQuerySchema.parse(query),url=new URL('https://m.uber.com/looking');
  const location=(p:RideQuery['pickup'])=>JSON.stringify({latitude:p.latitude,longitude:p.longitude,addressLine1:p.address});
  url.searchParams.set('pickup',location(q.pickup));url.searchParams.set('drop[0]',location(q.dropoff));url.searchParams.set('product_id',productId);
  return handoff(url.href);
}
export function checkedGrabLink(raw:string,query:RideQuery,serviceId:number,direct=false):string{
  if(raw.length>8192)throw new Error('Invalid Grab link');const u=new URL(raw);
  if(u.username||u.password||u.port||u.hash||[...u.searchParams.keys()].some(k=>u.searchParams.getAll(k).length!==1))throw new Error('Invalid Grab link');
  if(!direct){
    if(u.protocol!=='https:'||u.hostname!=='grab.onelink.me'||u.pathname!=='/2695613898'||[...u.searchParams.keys()].some(k=>!['af_dp','c','pid'].includes(k))||!u.searchParams.has('af_dp'))throw new Error('Invalid Grab link');
    checkedGrabLink(u.searchParams.get('af_dp')!,query,serviceId,true);
  }else{
    const allowed=['screenType','taxiTypeId','sourceID','pickUpLatitude','pickUpLongitude','dropOffLatitude','dropOffLongitude','pickUpAddress','dropOffAddress'];
    if(u.protocol!=='grab:'||u.hostname!=='open'||u.pathname!==''||u.searchParams.get('screenType')!=='BOOKING'||u.searchParams.get('taxiTypeId')!==String(serviceId)||[...u.searchParams.keys()].some(k=>!allowed.includes(k)))throw new Error('Invalid Grab link');
    for(const [key,value] of Object.entries({pickUpLatitude:query.pickup.latitude,pickUpLongitude:query.pickup.longitude,dropOffLatitude:query.dropoff.latitude,dropOffLongitude:query.dropoff.longitude})){
      const actual=u.searchParams.get(key);if(actual===null||!actual.trim()||!Number.isFinite(Number(actual))||Number(actual)!==value)throw new Error('Grab route differs');
    }
  }
  return u.href;
}
export function handoff(url:string){return rideHandoffSchema.parse({url,status:'user_action_required',requiresUserConfirmation:true,budgetEnforced:false,orderCreated:false,paymentInitiated:false});}
