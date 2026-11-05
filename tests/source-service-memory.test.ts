// Regression of the shared legacy mapper without a listening socket. Crypto,
// enrollment and HTTP transport remain covered by the separate Relay suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {digest} from '../packages/core/delegation.js';
import {DidiRelayService} from '../packages/agent-transport/didi-service.js';
import {DidiMcpConnector} from '../packages/capabilities/didi/connector.js';
import {sourceReadRequestSchema,sourceReadResponseSchema,SOURCE_RELAY_PROTOCOL} from '../packages/agent-transport/service-contracts.js';
import type {SourceRelayTransport} from '../packages/agent-transport/source-service.js';
import {didiFixture} from './fixtures/didi.js';
import {join} from 'node:path';
test('legacy DiDi uses the shared durable receipt mapper and preserves its original wire contract',async()=>{
 const f=didiFixture(),gateway='agent_'+'b'.repeat(43),authorityId=randomUUID(),request=sourceReadRequestSchema.parse({protocol:SOURCE_RELAY_PROTOCOL,kind:'source.read',callId:randomUUID(),authorityId,gatewayOrigin:'https://synthetic-primary.example',expiresAt:Date.now()+60000,context:{requestId:randomUUID(),requestRevision:1,planId:'plan',intentId:'intent',attemptId:'attempt',modelRunId:'model',programId:'didi.ride-estimate',programDigest:'a'.repeat(64),action:'SearchDidiPlaces',actionInputDigest:'b'.repeat(64)},source:{bindingId:f.binding.bindingId,keySha256:f.binding.keySha256,environment:'production'},tool:'maps_textsearch',input:{keywords:'Synthetic',city:'北京市'}});
 let checks=0,denied=false;const queue:unknown[]=[],delivered:unknown[]=[],client:SourceRelayTransport={async sourceReadProof(){return 'synthetic-opaque-proof';},async queue(_p,_c,result){queue.push(JSON.parse(JSON.stringify(result)));return String(queue.length-1);},async deliver(id,options){await options?.beforeSend?.();delivered.push(queue[Number(id)]);}};
 const authorize:typeof fetch=async()=>{checks++;return denied?new Response(null,{status:403}):new Response(JSON.stringify({authorized:true,authorityId,callId:request.callId,requestDigest:digest(request),expiresAt:request.expiresAt}));};
 const config={version:1 as const,authorityId,gatewayAgentId:gateway,gatewayOrigin:request.gatewayOrigin,relayUrl:'https://synthetic-relay.example',credentialPath:join(f.binding.auditDirectory!,'not-opened'),ledgerPath:join(f.binding.auditDirectory!,'source.sqlite'),displayName:'Synthetic DiDi',binding:{...f.binding,environment:'production' as const}};
 const message={createdAt:Date.now(),id:randomUUID(),senderId:gateway,connectionId:randomUUID(),expiresAt:request.expiresAt,content:request};let service=new DidiRelayService(client,config,new DidiMcpConnector(f.binding,f.fetcher),authorize);
 try{await service.handle(message,new AbortController().signal);const first=sourceReadResponseSchema.parse(delivered[0]);assert(first.result);assert.equal(checks,4);assert.equal(f.calls.filter(c=>c.name).length,1);service.close();service=new DidiRelayService(client,config,new DidiMcpConnector(f.binding,f.fetcher),authorize);await service.handle(message,new AbortController().signal);assert.deepEqual(delivered[1],first);assert.equal(f.calls.filter(c=>c.name).length,1);denied=true;await service.handle(message,new AbortController().signal);assert.equal(sourceReadResponseSchema.parse(delivered[2]).error,'AUTHORIZATION_REJECTED');assert.equal(f.calls.filter(c=>c.name).length,1);}finally{service.close();f.close();}
});
