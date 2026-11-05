import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import express from 'express';
import {readConfig} from '../packages/core/config.js';
import {MessagingError} from '../packages/agent-messaging/contracts.js';
import {mountMessagingMemberRoutes,type MessagingMemberIdentityPort,type MessagingMemberRoutesPort} from '../apps/gateway/messaging/routes.js';
import {messagingGatewayFixture} from './fixtures/messaging-gateway.js';

test('communication member routes await real consent storage and return asynchronous revocation denial',async()=>{
  const request=globalThis.fetch,f=await messagingGatewayFixture(),server=createServer();
  try{
    const actor=await f.actor('Async consent'),service=f.gateway.messaging!,members=f.gateway.members;
    let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const storage:MessagingMemberIdentityPort={session:async token=>members.session(token),authorizationFacts:async(...args)=>members.authorizationFacts(...args),agents:{list:async id=>members.agents.list(id)}};
    const messaging:MessagingMemberRoutesPort={store:{grants:async id=>service.store.grants(id),installation:async id=>service.store.installation(id)},
      approve:async(...args)=>{entered();await gate;return service.approve(...args);},
      revoke:async()=>{throw new MessagingError('MESSAGING_AUTHORIZATION_REQUIRED');},prepareEndpoint:id=>service.prepareEndpoint(id)};
    const config=readConfig({EIGOS_AUTH_MODE:'jwt',PUBLIC_URL:f.base,OAUTH_ISSUER:f.authority.issuer,OAUTH_AUDIENCE:f.base,OAUTH_JWKS_URL:f.authority.issuer+'jwks',OIDC_AGENT_CLIENT_ID:actor.p.clientId});
    const app=express();app.use(express.json());mountMessagingMemberRoutes(app,config,storage,messaging);server.on('request',app);server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
    const headers={cookie:actor.cookie,origin:f.base,'content-type':'application/json'};
    const post=(action:string,body:object)=>request(base+'/members/communications/'+action,{method:'POST',headers,body:JSON.stringify(body),redirect:'manual'});
    const view=await request(base+'/members/communications',{headers});assert.equal(view.status,200);assert((await view.text()).includes('Async consent'));
    const review=await post('review',{_csrf:actor.session.csrf,installationId:actor.id,displayName:'Async consent PA',scopes:['messaging:read','messaging:write'],visibility:'private',durationHours:1,custodyConsent:true});assert.equal(review.status,200);
    const id=(await review.text()).match(/name="reviewId" value="([^"]+)"/)?.[1];assert(id);
    const pending=post('approve',{_csrf:actor.session.csrf,reviewId:id,confirm:'approve'});await started;
    assert.equal(service.store.installation(actor.id),undefined,'Approval remains pending until its actual storage acknowledges');release();
    assert.equal((await pending).status,303);const grant=service.store.installation(actor.id);assert(grant);
    const denied=await post('revoke',{_csrf:actor.session.csrf,id:grant.id,revision:grant.revision});assert.equal(denied.status,403);assert.equal(service.store.grant(grant.id).revoked,false);
    assert.equal((await post('revoke',{_csrf:'wrong',id:grant.id,revision:grant.revision})).status,403);
  }finally{if(server.listening){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}await f.close();}
});
