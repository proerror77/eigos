import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {normalizeRideData,PaRideConnector} from '../packages/capabilities/rides/connector.js';
import {checkedGrabLink} from '../packages/capabilities/rides/handoff.js';
import {rideQuerySchema,RideReadError,type RideBinding,type RideToken,type RideContext,type RideSourceHost} from '../packages/capabilities/rides/contracts.js';
import {digest} from '../packages/core/delegation.js';
const owner=JSON.stringify(['local-development','local','developer']);
const query={coordinateSystem:'WGS84' as const,pickup:{latitude:1.28,longitude:103.85,address:'Synthetic origin'},dropoff:{latitude:1.36,longitude:103.99,address:'Synthetic destination'}};
const context:RideContext={requestId:randomUUID(),requestRevision:1,planId:'plan',intentId:'intent',attemptId:'attempt',modelRunId:'model',programId:'ride.uber.estimate',programDigest:'a'.repeat(64),action:'EstimateUberRide',actionInputDigest:'b'.repeat(64)};
const binding=(provider:RideBinding['provider']):RideBinding=>({provider,environment:'sandbox',owner,bindingId:'synthetic-binding',connectionId:randomUUID(),revision:1});
function wire(provider:RideBinding['provider']){
  if(provider==='uber')return {ride_estimate:{product_estimates:[{product:{product_id:'synthetic-uber',display_name:'Synthetic Uber'},eta:{eta_in_seconds:60},fare:{fare_id:'synthetic-fare',currency_code:'SGD',contractual:false,point_fare:'12345',expires_at:'provider-units-unverified'}}]}};
  const direct=new URL('grab://open');for(const [k,v]of Object.entries({screenType:'BOOKING',taxiTypeId:302,pickUpLatitude:1.28,pickUpLongitude:103.85,dropOffLatitude:1.36,dropOffLongitude:103.99}))direct.searchParams.set(k,String(v));
  const deep=new URL('https://grab.onelink.me/2695613898');deep.searchParams.set('af_dp',direct.href);
  return {services:[{serviceID:302,serviceName:'Synthetic Grab',eta:1,fare:{currency:'SGD',minFare:10,maxFare:20},surgeNotice:'NONE',deepLink:deep.href,directDeepLink:direct.href}]};
}
function sourceHost(b:RideBinding,changes:Partial<RideToken>={}):RideSourceHost{return {async loadToken(){return {owner:b.owner,provider:b.provider,environment:b.environment,connectionId:b.connectionId,revision:b.revision,value:'synthetic_private_token',expiresAt:new Date(Date.now()+60000).toISOString(),riderId:'linked-rider',...changes};},async resolveUberRider(){return 'linked-rider';}};}
const error=(code:string)=>(e:unknown)=>e instanceof RideReadError&&e.code===code;
for(const provider of ['uber','grab']as const){
 test(`${provider}: disabled and unapproved reads never load a token or dispatch`,async()=>{
  const b=binding(provider),h:RideSourceHost={async loadToken(){assert.fail('Disabled source loaded token');}};
  for(const [options,code]of [[{},'DISABLED'],[{enabled:true},'PARTNER_APPROVAL_REQUIRED']]as const)await assert.rejects(new PaRideConnector(b,options,h).read(context,query,new AbortController().signal,()=>{}),error(code));
 });
 test(`${provider}: official estimate wire contract, task-bound receipt and user confirmation`,async()=>{
  const b=binding(provider),checks:string[]=[],c=new PaRideConnector(b,{enabled:true,partnerApproved:true},sourceHost(b),async(url,init)=>{
   assert.equal(String(url),provider==='uber'?'https://sandbox-api.uber.com/v1/rides/estimates':'https://partner-api.stg-myteksi.com/farefeed/v1/estimate');assert.equal(init!.method,'POST');assert.equal(init!.redirect,'manual');assert.equal(new Headers(init!.headers).get('Authorization'),'Bearer synthetic_private_token');
   const body=JSON.parse(String(init!.body));if(provider==='grab')assert.deepEqual(body,{pickUp:query.pickup,dropOff:query.dropoff});else{assert.equal(body.participant_spec.requester.user_id,'linked-rider');assert.deepEqual(body.intent.ride_intent_spec.origin.point,{latitude:1.28,longitude:103.85});}
   return new Response(JSON.stringify(wire(provider)));
  },true);
  const value=await c.read(context,query,new AbortController().signal,phase=>{checks.push(phase);});
  assert.deepEqual(checks,['prepare','dispatch','result']);assert.equal(value.receipt.contextDigest,digest(context));assert.equal(value.receipt.connectionDigest,digest(b));assert.equal(value.receipt.inputDigest,digest(query));assert.equal(value.receipt.resultDigest,digest(value.data));
  assert(!JSON.stringify(value).includes('synthetic_private_token'));assert(JSON.stringify(value).includes('user_action_required'));assert(JSON.stringify(value).includes('"orderCreated":false'));
  if(value.data.provider==='uber'){assert.equal(value.data.products[0]!.etaSeconds,60);assert.equal(value.data.amountUnit,'provider_wire_unverified');assert.equal(value.data.products[0]!.fare.point,'12345');}else assert.equal(value.data.services[0]!.etaMinutes,1);
 });
 test(`${provider}: owner, provider, environment, connection and expiry cannot cross`,async()=>{
  const b=binding(provider);for(const changes of [{owner:JSON.stringify(['foreign','tenant','person'])},{provider:provider==='uber'?'grab' as const:'uber' as const},{environment:'production' as const},{connectionId:randomUUID()},{revision:2},{expiresAt:new Date(Date.now()-1000).toISOString()}]){
   let called=false;const c=new PaRideConnector(b,{enabled:true,partnerApproved:true},sourceHost(b,changes),async()=>{called=true;assert.fail('Foreign token dispatched');});await assert.rejects(c.read(context,query,new AbortController().signal,()=>{}),error('TOKEN_BINDING_REJECTED'));assert.equal(called,false);
  }
 });
 test(`${provider}: empty quotes, malformed responses and HTTP errors never become completed estimates`,async()=>{
  const b=binding(provider);for(const [status,payload]of [[200,provider==='uber'?{}:{services:[]}],[302,{}],[401,{private:'secret'}],[403,{}],[429,{}],[500,{}]]as const){let count=0;const c=new PaRideConnector(b,{enabled:true,partnerApproved:true},sourceHost(b),async()=>{count++;return new Response(JSON.stringify(payload),{status});});await assert.rejects(c.read(context,query,new AbortController().signal,()=>{}));assert.equal(count,1);}
 });
 test(`${provider}: revoked permission or cancellation suppresses dispatch and late output`,async()=>{
  const b=binding(provider);for(const phase of ['prepare','dispatch','result']){let calls=0;const c=new PaRideConnector(b,{enabled:true,partnerApproved:true},sourceHost(b),async()=>{calls++;return new Response(JSON.stringify(wire(provider)));});await assert.rejects(c.read(context,query,new AbortController().signal,p=>{if(p===phase)throw new Error('private authorization failure');}),error('READ_REJECTED'));assert.equal(calls,phase==='result'?1:0);}
  const controller=new AbortController(),c=new PaRideConnector(b,{enabled:true,partnerApproved:true},sourceHost(b),async()=>{controller.abort();return new Response(JSON.stringify(wire(provider)));});await assert.rejects(c.read(context,query,controller.signal,()=>{}),error('ABORTED'));
 });
}
test('timeouts stop stalled authorization and token loads without provider requests',async()=>{
 const b=binding('grab');for(const phase of ['authorize','token']as const){let calls=0;const h=sourceHost(b);if(phase==='token')h.loadToken=()=>new Promise(()=>{});const c=new PaRideConnector(b,{enabled:true,partnerApproved:true},h,async()=>{calls++;assert.fail('Stalled preparation dispatched');});const controller=new AbortController(),pending=c.read(context,query,controller.signal,()=>phase==='authorize'?new Promise(()=>{}):undefined);setTimeout(()=>controller.abort(),10);await assert.rejects(pending,error('ABORTED'));assert.equal(calls,0);}
});
test('oversized bodies and escaped credential echoes are rejected',async()=>{
 const b=binding('uber');for(const payload of ['x'.repeat(1048577),JSON.stringify(wire('uber')).replace('Synthetic Uber','synthetic_private_token'),JSON.stringify(wire('uber')).replace('Synthetic Uber','synthetic_private_token'.split('').map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''))]){const c=new PaRideConnector(b,{enabled:true,partnerApproved:true},sourceHost(b),async()=>new Response(payload));await assert.rejects(c.read(context,query,new AbortController().signal,()=>{}));}
});
test('Grab links reject foreign origins, duplicate arguments, nested redirects and changed route or vehicle',()=>{
 const response=wire('grab') as {services:{deepLink:string;directDeepLink:string}[]},s=response.services[0]!;
 assert.equal(checkedGrabLink(s.deepLink,query,302),s.deepLink);
 for(const invalid of [s.deepLink.replace('grab.onelink.me','evil.example'),s.deepLink+'&af_web_dp=https://evil.example',s.deepLink+'&af_dp=grab://open',s.deepLink.replace('1.28','2.28')])assert.throws(()=>checkedGrabLink(invalid,query,302));
 assert.throws(()=>checkedGrabLink(s.deepLink,query,303));
 assert.equal(rideQuerySchema.safeParse({...query,coordinateSystem:'GCJ02'}).success,false);
});


test('Uber keeps available quotes beside legitimate absent fare and no_fare products',()=>{
 const fare={fare_id:'fare',currency_code:'SGD',contractual:false};
 const response={ride_estimate:{product_estimates:[{product:{product_id:'available'},fare:{...fare,point_fare:'0'}},{product:{product_id:'missing'}},{product:{product_id:'not-upfront'},fare:{...fare,no_fare:{description:'Computed after trip'}}}]}};
 const data=normalizeRideData('uber',response,query);assert.equal(data.provider,'uber');if(data.provider!=='uber')assert.fail('Wrong provider');assert.deepEqual(data.products.map(p=>p.productId),['available']);assert.equal(data.products[0]!.fare.point,'0');
 assert.throws(()=>normalizeRideData('uber',{ride_estimate:{product_estimates:response.ride_estimate.product_estimates.slice(1)}},query),error('NO_ESTIMATE'));
 assert.throws(()=>normalizeRideData('uber',{ride_estimate:{product_estimates:[response.ride_estimate.product_estimates[0],{product:{product_id:'malformed'},fare:{...fare,point_fare:'NaN'}}]}},query));
});
test('Uber range bounds use exact decimals without guessing a monetary scale',()=>{
 const response=(lower:string,upper:string)=>({ride_estimate:{product_estimates:[{product:{product_id:'range'},fare:{fare_id:'range-fare',currency_code:'SGD',contractual:false,range_fare:{lower,upper}}}]}});
 for(const [lower,upper]of [['20','10'],['9007199254740993.00000001','9007199254740993.00000000'],['0.00000002','0.00000001']])assert.throws(()=>normalizeRideData('uber',response(lower!,upper!),query));
 const data=normalizeRideData('uber',response('0001.000','1'),query);if(data.provider!=='uber')assert.fail('Wrong provider');assert.deepEqual(data.products[0]!.fare.range,{lower:'0001.000',upper:'1'});assert.equal(data.amountUnit,'provider_wire_unverified');
});
