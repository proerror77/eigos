import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../packages/core/delegation.js';
import {PaRideConnector} from '../packages/capabilities/rides/connector.js';
import {rideConfigurationDigest,type RideBinding,type RideProvider,type RideToken} from '../packages/capabilities/rides/contracts.js';
import {RideRelayService} from '../packages/agent-transport/ride-service.js';
import {rideSourceRequestSchema,rideSourceResponseSchema,checkedRideReply} from '../packages/agent-transport/ride-contracts.js';
import {assertSourceReadInput,assertSourceTaskEnvironment,checkedSourceReply} from '../packages/agent-transport/source-protocol.js';
import type {SourceRelayTransport} from '../packages/agent-transport/source-service.js';
import type {ReceivedMessage} from '../packages/agent-transport/client.js';
import {SOURCE_RELAY_PROTOCOL,sourceReadRequestSchema} from '../packages/agent-transport/service-contracts.js';
const owner=JSON.stringify(['local-development','local','developer']),peer='agent_'+'a'.repeat(43),gateway='agent_'+'b'.repeat(43);
function fixture(provider:RideProvider,crash=false){
 const directory=mkdtempSync(join(tmpdir(),'eigos-ride-source-test-')),binding:RideBinding={provider,environment:'sandbox',bindingId:'synthetic',connectionId:randomUUID(),revision:1,owner};
 const {owner:_owner,...source}=binding,request=rideSourceRequestSchema.parse({protocol:SOURCE_RELAY_PROTOCOL,kind:'source.read',provider,callId:randomUUID(),authorityId:randomUUID(),gatewayOrigin:'https://synthetic-primary.example',expiresAt:Date.now()+60000,context:{requestId:randomUUID(),requestRevision:1,planId:'plan',intentId:'intent',attemptId:'attempt',modelRunId:'model',programId:`ride.${provider}.estimate`,programDigest:rideConfigurationDigest(binding,peer,'fixture'),action:provider==='uber'?'EstimateUberRide':'EstimateGrabRide',actionInputDigest:'a'.repeat(64)},source:{...source,connectionDigest:digest(binding),evidenceKind:'fixture'},tool:'estimate',input:{coordinateSystem:'WGS84',pickup:{latitude:1.28,longitude:103.85,address:'Synthetic origin'},dropoff:{latitude:1.36,longitude:103.99,address:'Synthetic destination'}}});
 let calls=0,checks=0,denied=false,localRevoked=false,unavailableAt=0;const outbox:unknown[]=[],delivered:unknown[]=[];let deliveries=0;
 const transport:SourceRelayTransport={async sourceReadProof(){return 'synthetic-proof-opaque';},async queue(_peer,_connection,content){outbox.push(JSON.parse(JSON.stringify(content)));return String(outbox.length-1);},async deliver(id,options){await options?.beforeSend?.();delivered.push(outbox[Number(id)]);deliveries++;return undefined;}};
 const controller=new AbortController();
 const connector=new PaRideConnector(binding,{enabled:true,partnerApproved:true},{readConnection(binding){return {binding,state:localRevoked?'revoked':'active',expiresAt:new Date(Date.now()+60000).toISOString()};},async loadToken(){const token:RideToken={owner,provider,environment:'sandbox',connectionId:binding.connectionId,revision:binding.revision,value:'synthetic_private_token',riderId:'synthetic-rider',expiresAt:new Date(Date.now()+60000).toISOString()};return token;},async resolveUberRider(){return 'synthetic-rider';}},async()=>{
  calls++;if(crash){controller.abort();throw controller.signal.reason;}
  if(provider==='uber')return new Response(JSON.stringify({ride_estimate:{product_estimates:[{product:{product_id:'synthetic'},fare:{fare_id:'fare',currency_code:'SGD',contractual:false,point_fare:'12345'}}]}}));
  const direct=new URL('grab://open');for(const[k,v]of Object.entries({screenType:'BOOKING',taxiTypeId:302,pickUpLatitude:1.28,pickUpLongitude:103.85,dropOffLatitude:1.36,dropOffLongitude:103.99}))direct.searchParams.set(k,String(v));const deep=new URL('https://grab.onelink.me/2695613898');deep.searchParams.set('af_dp',direct.href);
  return new Response(JSON.stringify({services:[{serviceID:302,serviceName:'Synthetic',eta:1,fare:{minFare:10,maxFare:20,currency:'SGD'},surgeNotice:'NONE',deepLink:deep.href,directDeepLink:direct.href}]}));
 },true);
 const authorize:typeof fetch=async(url,init)=>{checks++;assert.equal(String(url),request.gatewayOrigin+`/relay/source-reads/${request.callId}/authorize`);assert.equal(new Headers(init!.headers).get('DPoP'),'synthetic-proof-opaque');if(checks===unavailableAt)return new Response(null,{status:503});if(denied)return new Response(null,{status:403});return new Response(JSON.stringify({authorized:true,authorityId:request.authorityId,callId:request.callId,requestDigest:digest(request),expiresAt:request.expiresAt}));};
 const config={version:1 as const,authorityId:request.authorityId,gatewayAgentId:gateway,gatewayOrigin:request.gatewayOrigin,ledgerPath:join(directory,'source.sqlite'),binding};
 const message:ReceivedMessage={createdAt:Date.now(),id:randomUUID(),senderId:gateway,connectionId:randomUUID(),expiresAt:request.expiresAt,content:request};
 return {request,config,message,controller,delivered,connector,transport,authorize,calls:()=>calls,checks:()=>checks,revoke:()=>{denied=true;},localRevoke:()=>{localRevoked=true;},unavailableAt:(n:number)=>{unavailableAt=n;},close:()=>rmSync(directory,{recursive:true,force:true}),deliveries:()=>deliveries};
}
for(const provider of ['uber','grab']as const){
 test(`${provider}: enrolled source retains its receipt across restart and never repeats the provider read`,async()=>{
  const f=fixture(provider);let service=new RideRelayService(f.transport,f.config,f.connector,f.authorize);
  try{await service.handle(f.message,new AbortController().signal);assert.equal(f.calls(),1);assert.equal(f.checks(),4);const first=rideSourceResponseSchema.parse(f.delivered[0]);assert(first.result);assert(!JSON.stringify(first).includes('synthetic_private_token'));service.close();service=new RideRelayService(f.transport,f.config,f.connector,f.authorize);await service.handle(f.message,new AbortController().signal);assert.equal(f.calls(),1);assert.deepEqual(f.delivered[1],first);assert.equal(f.deliveries(),2);}finally{service.close();f.close();}
 });
 test(`${provider}: crash after source dispatch remains unknown after restart without replay`,async()=>{
  const f=fixture(provider,true);let service=new RideRelayService(f.transport,f.config,f.connector,f.authorize);
  try{await assert.rejects(service.handle(f.message,f.controller.signal));assert.equal(f.calls(),1);service.close();service=new RideRelayService(f.transport,f.config,f.connector,f.authorize);await service.handle(f.message,new AbortController().signal);assert.equal(rideSourceResponseSchema.parse(f.delivered[0]).error,'READ_OUTCOME_UNKNOWN');assert.equal(f.calls(),1);}finally{service.close();f.close();}
 });
 for(const stage of [3,4])test(`${provider}: authorization outage at check ${stage} retains data privately and revocation prevents later delivery`,async()=>{
  const f=fixture(provider);f.unavailableAt(stage);let service=new RideRelayService(f.transport,f.config,f.connector,f.authorize);
  try{await assert.rejects(service.handle(f.message,new AbortController().signal),/unavailable/);assert.equal(f.calls(),1);assert.equal(f.delivered.length,0);service.close();service=new RideRelayService(f.transport,f.config,f.connector,f.authorize);f.revoke();await service.handle(f.message,new AbortController().signal);const r=rideSourceResponseSchema.parse(f.delivered[0]);assert.equal(r.error,'AUTHORIZATION_REJECTED');assert.equal(r.result,undefined);assert.equal(f.calls(),1);}finally{service.close();f.close();}
 });
 test(`${provider}: request pins owner, provider, task, attempt, peer and environment`,async()=>{
  const f=fixture(provider),service=new RideRelayService(f.transport,f.config,f.connector,f.authorize);
  try{assert.doesNotThrow(()=>assertSourceReadInput(f.request,owner,peer));assert.throws(()=>assertSourceReadInput(f.request,JSON.stringify(['other','tenant','owner']),peer));assert.throws(()=>assertSourceReadInput(f.request,owner,gateway));assert.throws(()=>assertSourceTaskEnvironment(f.request,'live'));assert.doesNotThrow(()=>assertSourceTaskEnvironment(f.request,'sandbox'));assert.equal(sourceReadRequestSchema.safeParse(f.request).success,false);await service.handle(f.message,new AbortController().signal);const r=rideSourceResponseSchema.parse(f.delivered[0]);
   for(const request of [{...f.request,callId:randomUUID()},{...f.request,context:{...f.request.context,attemptId:'foreign'}},{...f.request,context:{...f.request.context,requestId:randomUUID()}}])assert.throws(()=>checkedRideReply(request,r));
   assert.throws(()=>checkedSourceReply(f.request,{...r,provider:provider==='uber'?'grab':'uber'}));
  }finally{service.close();f.close();}
 });
}

for(const provider of ['uber','grab'] as const)test(`${provider}: PA-local revocation withholds a persisted receipt even while the primary permission remains active`,async()=>{
 const f=fixture(provider);let service=new RideRelayService(f.transport,f.config,f.connector,f.authorize);
 try{await service.handle(f.message,new AbortController().signal);assert.equal(f.calls(),1);service.close();service=new RideRelayService(f.transport,f.config,f.connector,f.authorize);f.localRevoke();await service.handle(f.message,new AbortController().signal);const response=rideSourceResponseSchema.parse(f.delivered[1]);assert.equal(response.error,'AUTHORIZATION_REJECTED');assert.equal(response.result,undefined);assert.equal(f.calls(),1);}finally{service.close();f.close();}
});

for(const provider of ['uber','grab'] as const)test(`${provider}: disabling the PA source or partner switch blocks delivery of an existing cached receipt`,async()=>{
 const f=fixture(provider);let service=new RideRelayService(f.transport,f.config,f.connector,f.authorize);
 try{await service.handle(f.message,new AbortController().signal);assert.equal(f.calls(),1);service.close();
  for(const [index,options] of [{enabled:false,partnerApproved:true},{enabled:true,partnerApproved:false}].entries()){
   const disabled=new PaRideConnector(f.config.binding,options,{readConnection(binding){return {binding,state:'active',expiresAt:new Date(Date.now()+60000).toISOString()};},async loadToken(){assert.fail('Disabled cache path loaded token');}},async()=>{assert.fail('Disabled source read');},true);
   service=new RideRelayService(f.transport,f.config,disabled,f.authorize);await service.handle(f.message,new AbortController().signal);const response=rideSourceResponseSchema.parse(f.delivered.at(-1));assert.equal(response.error,'AUTHORIZATION_REJECTED');assert.equal(response.result,undefined);assert.equal(f.calls(),1);if(index===0)service.close();
  }
 }finally{service.close();f.close();}
});
