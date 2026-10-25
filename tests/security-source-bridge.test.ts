import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {securityFixture} from './fixtures/security.js';
import {securedProgramFixture} from './fixtures/secured-program.js';
import {ParticipantBookingProgram} from '../packages/capabilities/free-booking/program.js';
import {ParticipantBrowserConnector} from '../packages/capabilities/free-booking/connector.js';
import {createParticipantBrowserBridge} from '../packages/capabilities/free-booking/browser-bridge.js';
import {digest} from '../packages/core/delegation.js';

test('foundation browser queue checks the current exact plan and stops operator dispatch after source revocation',async()=>{
  const base=securityFixture(),workerToken=randomBytes(32).toString('hex'),operatorToken=randomBytes(32).toString('hex'),tokenFile=join(base.directory,'source-token'),attendeeRef=digest('synthetic participant'),bindingId='s5-synthetic';
  writeFileSync(tokenFile,workerToken,{mode:0o600});
  const bridge=await createParticipantBrowserBridge({databasePath:join(base.directory,'source.sqlite'),taskDatabasePath:base.database,evidenceDirectory:join(base.directory,'evidence'),bindingId,attendeeRef,workerToken,operatorToken,ownerKey:base.owner});
  const source=new ParticipantBrowserConnector({endpoint:bridge.endpoint,tokenFile,bindingId,attendeeRef});
  const f=securedProgramFixture(()=>new ParticipantBookingProgram(source),{kind:'event_registration',serviceUrl:'https://luma.com/synthetic-read-only',completionTarget:'confirmed',participants:1,startsAt:null},(ctx,access)=>{
    access.session.call('describe_ontology',{search:'RegistrationTask',limit:1});access.session.call('query_ontology',{object:ctx.state.scope});
    return {kind:'execute',requestRevision:ctx.request.revision,message:'Read an existing synthetic registration page',steps:[{id:'inspect',action:'InspectRegistrationPage',argumentsJson:JSON.stringify({scope:ctx.state.scope}),dependsOn:[],inputRefs:[]}],completionJson:''};
  },base);
  try {
    const job=f.tasks.submit(f.p,{service:'eigos.delegate',requestId:randomUUID(),goal:'Read a synthetic participant page'});await f.tick();await f.tick();
    const intent=f.jobs.intents(f.owner,job.id)[0]!;assert.equal(intent.state,'awaiting_remote',JSON.stringify(f.jobs.get(f.owner,job.id).delegation?.agent?.feedback));
    const headers={authorization:`Bearer ${operatorToken}`};
    const queued=await fetch(bridge.endpoint+'/operator/next',{headers}).then(r=>r.json());assert.equal(queued.operations.length,1);
    f.policy.revokeSource(f.owner,f.a.id,f.catalog.securityProfiles(f.owner)[0]!.bindingId,f.policy.revision());
    const denied=await fetch(bridge.endpoint+'/operator/dispatch/'+intent.businessOperationKey,{method:'POST',headers});assert.equal(denied.status,403);assert.match((await denied.json()).error,/authority/);
    const audit=await fetch(bridge.endpoint+'/audit/operations/'+intent.businessOperationKey,{headers:{authorization:`Bearer ${workerToken}`,'x-eigos-recovery':Buffer.from(JSON.stringify({id:randomUUID(),token:randomUUID()})).toString('base64url')}});assert.equal(audit.status,403);
    assert.equal(f.jobs.intents(f.owner,job.id).length,1);assert.equal((await fetch(bridge.endpoint+'/operator/next',{headers}).then(r=>r.json())).operations[0].state,'queued');
  }finally{await bridge.close();f.close();}
});
