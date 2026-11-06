import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {SignJWT,generateKeyPair,exportJWK,decodeJwt} from 'jose';
import {digest} from '../packages/core/delegation.js';
import type {Principal} from '../packages/core/domain.js';
import {createNodeKeys,createProof,verifyProof} from '../packages/agent-transport/crypto.js';
import {TaskRelayHost,type TaskRelayHostPort,type TaskRelayTasks,type TaskRelayTransport} from '../packages/agent-transport/task-host.js';
import {RelayEnrollmentIssuer,type RelayEnrollmentAuthority} from '../packages/agent-transport/enrollment.js';
import {TASK_RELAY_PROTOCOL,taskRelayResponseSchema} from '../packages/agent-transport/task-contracts.js';
import {SOURCE_RELAY_PROTOCOL} from '../packages/agent-transport/service-contracts.js';
import {receiptSchema} from '../packages/relay/contracts.js';
import {PostgresTaskRelay} from '../packages/postgres/task-relay.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {PostgresRelayReadAuthority} from '../packages/postgres/relay-read-authority.js';
import {DidiAgentProgram} from '../packages/capabilities/didi/program.js';
import {bindPersonalSourceOwner} from '../packages/core/source-owner.js';
import {OntologyObjectStore} from '../packages/ontology/object-store.js';
import {planningSnapshot} from '../packages/ontology/planning-contract.js';
import type {AgentActionPlan,AgentDecision} from '../packages/ontology/agent-actions.js';
import type {ActionIntent,ExecutionAttempt} from '../packages/ontology/actions.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {evidence} from './backend-fixture.js';
import {TaskService} from '../packages/core/tasks.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import type {TaskRelayGatewayPort} from '../apps/gateway/relay.js';
const relayPort=(value:PostgresTaskRelay):TaskRelayGatewayPort=>value;void relayPort;
const unavailable=async():Promise<never>=>{throw new Error('Unexpected synthetic transport operation');};
async function transport(peerId:string,gatewayId:string,beforeQueue?:()=>Promise<void>){
  const outbox:unknown[]=[],messageId=randomUUID();let sent=0;
  const client:TaskRelayTransport={agentId:gatewayId,peer:unavailable,contacts:unavailable,ensureContact:unavailable,respondContact:unavailable,listen:unavailable,register:unavailable,renew:unavailable,close(){},
    async queue(_peer,_connection,content){outbox.push(structuredClone(content));await beforeQueue?.();return messageId;},
    async deliver(id,options){await options?.beforeSend?.();sent++;return receiptSchema.parse({id,senderId:gatewayId,recipientId:peerId,digest:'a'.repeat(64),expiresAt:Date.now()+60000,status:'queued'});}};
  return {client,outbox,sent:()=>sent};
}

test('Task Relay awaits async authority/command/projection and rechecks after response encryption',async()=>{
  // Scheduling oracle only, not a business permission or completed-result proof.
  const peer=(await createNodeKeys('Synthetic PA')).identity.card.agentId,gateway=(await createNodeKeys('Synthetic gateway')).identity.card.agentId;
  const authorityId=randomUUID(),taskId=randomUUID(),events:string[]=[],p:Principal={issuer:'https://synthetic.example',tenant:'fixture',subject:'owner',clientId:'fixture',scopes:['tasks:write','services:read']};let authorized=true;
  const task={view:'eigos.task.v2' as const,id:taskId,contextId:randomUUID(),service:'eigos.delegate',state:'submitted' as const,goal:'',messages:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),outputStatus:'receipt_only' as const};
  const port:TaskRelayHostPort={authorityId,authorityCurrent:async()=>true,principal:async()=>{await Promise.resolve();if(!authorized)throw new Error('Synthetic revoked before send');events.push('principal');return p;},command:async()=>{events.push('command');return 'synthetic-id';},project:async()=>{await Promise.resolve();events.push('project');return task;}};
  const tasks:TaskRelayTasks={submit:async()=>{events.push('submit');return task;},reply:unavailable,cancel:unavailable,get:async()=>task};
  const outgoing=await transport(peer,gateway,async()=>{authorized=false;});
  await assert.rejects(new TaskRelayHost(port,tasks,outgoing.client,authorityId).handle({senderId:peer,id:randomUUID(),connectionId:randomUUID(),createdAt:Date.now(),expiresAt:Date.now()+60000,content:{protocol:TASK_RELAY_PROTOCOL,kind:'task.submit',authorityId,requestId:randomUUID(),input:{service:'eigos.delegate',requestId:randomUUID(),goal:'Synthetic task'}}},new AbortController().signal),/revoked before send/);
  assert.deepEqual(events.slice(0,4),['principal','command','submit','project']);assert.equal(outgoing.sent(),0);
});

test('the original SQLite Task Relay constructor still uses its real task, grant and safe projection',async()=>{
  const f=securityFixture(Date.now,{unified:true});const tasks=new TaskService(f.jobs,{catalog:new ExecutionCatalog([],[],[])});
  try{
    const a=f.installation('Synthetic legacy PA',3600000);f.approve(a.id);const policy=f.jobs.security.policies,expiresAt=new Date(Date.now()+3600000).toISOString();
    policy.setRole({subjectKind:'installation',subjectId:a.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt},policy.revision());
    policy.setRecipient(a.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},policy.revision());
    const p={...f.principal,access:f.coordinator.authenticate(f.principal,a.token)},node=await createNodeKeys('Synthetic legacy node'),gateway=await createNodeKeys('Synthetic gateway');
    f.jobs.security.relay.bind(p,node.identity.card.agentId,Date.now()+60000,{jti:randomUUID(),expiresAt:Date.now()+30000});
    const out=await transport(node.identity.card.agentId,gateway.identity.card.agentId),host=new TaskRelayHost(f.jobs,tasks,out.client,f.authority!.id),requestId=randomUUID();
    const message={senderId:node.identity.card.agentId,id:randomUUID(),connectionId:randomUUID(),createdAt:Date.now(),expiresAt:Date.now()+60000,content:{protocol:TASK_RELAY_PROTOCOL,kind:'task.submit',authorityId:f.authority!.id,requestId,input:{service:'eigos.delegate',requestId,goal:'Synthetic legacy task'}}};
    await host.handle(message,new AbortController().signal);await host.handle(message,new AbortController().signal);const replies=out.outbox.map(value=>taskRelayResponseSchema.parse(value));assert(replies[0]?.task);assert.equal(replies[0].task.id,replies[1]?.task?.id);assert.equal(f.jobs.list(f.owner,{limit:100,offset:0}).total,1);assert(!JSON.stringify(replies).includes('delegation'));
  }finally{await tasks.close();f.close();}
});

test('Relay enrollment awaits admission and retains the node-bound minute limit',async()=>{
  const key=await generateKeyPair('EdDSA',{crv:'Ed25519',extractable:true}),jwk=await exportJWK(key.privateKey),node=await createNodeKeys('Synthetic enrolled node');let calls=0;
  const authority:RelayEnrollmentAuthority={now:Date.now,withEnrollmentAdmission:async(_p,action)=>{calls++;await Promise.resolve();return action({ownerKey:'synthetic-owner',installationId:randomUUID(),expiresAt:Date.now()+30000});}};
  const parsedKey={kty:'OKP' as const,crv:'Ed25519' as const,x:jwk.x!,d:jwk.d!},issuer=new RelayEnrollmentIssuer(parsedKey,'https://primary.example','https://relay.example',authority),bearer=await new SignJWT({exp:Math.floor(Date.now()/1000)+600}).setProtectedHeader({alg:'EdDSA'}).sign(key.privateKey);
  const result=await issuer.issue({issuer:'https://synthetic.example',tenant:'fixture',subject:'owner',clientId:'fixture',scopes:['services:read']},bearer,node.identity.card.agentId);
  const claims=decodeJwt(result.accessToken);assert.equal(calls,1);assert.equal(claims.eigos_agent_id,node.identity.card.agentId);assert(claims.exp!-claims.iat!<=30);assert(!JSON.stringify(issuer).includes(jwk.d!));
});

test('PostgreSQL Task Relay persists DPoP/command identity and routes the same authorized task with a last-send fence',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic Relay PA',3600000);f.approve(installation.id);const policy=f.jobs.security.policies,expiresAt=new Date(Date.now()+3600000).toISOString();
    policy.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt},policy.revision());
    policy.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},policy.revision());
    const second=f.installation('Other Relay PA',3600000);f.approve(second.id);
    const other={...f.principal,access:f.coordinator.authenticate(f.principal,second.token)},p={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)},node=await createNodeKeys('Synthetic PA'),gateway=await createNodeKeys('Synthetic gateway');
    target=await importPostgresFixture(f);const t=target,port=new PostgresTaskRelay({database:t.database,policyDigest:t.policy,authority:f.authority!,builder:t.kernel}),tasks=new PostgresTaskCommandService(t.database,t.policy,t.kernel);
    const proof=await verifyProof(await createProof(node,'synthetic-oauth','POST',port.gatewayOrigin+'/relay/bind'),'synthetic-oauth','POST',port.gatewayOrigin+'/relay/bind',node.identity.card.agentId);
    await port.bind(p,node.identity.card.agentId,Date.now()+60000,proof);await assert.rejects(port.bind(p,node.identity.card.agentId,Date.now()+60000,proof),/ACCESS_REVOKED/);
    await assert.rejects(port.bind(other,node.identity.card.agentId,Date.now()+60000,{jti:randomUUID(),expiresAt:Date.now()+30000}),/AUTHORIZATION_REQUIRED/);
    const before=(await port.principal(node.identity.card.agentId)).access;assert.equal(before?.actorKind,'agent');
    const requestId=randomUUID(),command={protocol:TASK_RELAY_PROTOCOL,kind:'task.submit',authorityId:port.authorityId,requestId,input:{service:'eigos.delegate',requestId,goal:'Synthetic scoped encrypted task'}};
    const outgoing=await transport(node.identity.card.agentId,gateway.identity.card.agentId),host=new TaskRelayHost(port,tasks,outgoing.client,port.authorityId),message={senderId:node.identity.card.agentId,id:randomUUID(),connectionId:randomUUID(),createdAt:Date.now(),expiresAt:Date.now()+60000,content:command};
    await host.handle(message,new AbortController().signal);await host.handle(message,new AbortController().signal);const replies=outgoing.outbox.map(value=>taskRelayResponseSchema.parse(value));assert(replies[0]?.task);assert.equal(replies[0].task.id,replies[1]!.task?.id);
    assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM "${t.schema}".jobs`)).rows[0].n),1);
    assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM "${t.schema}".security_grants WHERE kind='task_data'`)).rows[0].n),1);
    await assert.rejects(port.command(node.identity.card.agentId,requestId,digest({...command,input:{...command.input,goal:'Different command'}})),/already bound/);
    assert(!JSON.stringify(replies).includes('delegation'));assert(!JSON.stringify(replies).includes('claimToken'));
    const reduced={...p,scopes:['ontology:read'],access:{...p.access,tokenScopes:['ontology:read']}},foreign={...other,scopes:['ontology:read'],access:{...other.access,tokenScopes:['ontology:read']}};
    await assert.rejects(port.revoke(foreign,node.identity.card.agentId),/AUTHORIZATION_REQUIRED/);
    await assert.rejects(port.revoke({...reduced,access:{...reduced.access,authEpoch:reduced.access.authEpoch+1}},node.identity.card.agentId),/POLICY_CHANGED/);
    await assert.rejects(port.bind(reduced,node.identity.card.agentId,Date.now()+60000,{jti:randomUUID(),expiresAt:Date.now()+30000}),/scope|AUTHORIZATION_REQUIRED/);
    const revokeSend=await transport(node.identity.card.agentId,gateway.identity.card.agentId,()=>port.revoke(reduced,node.identity.card.agentId));
    await assert.rejects(new TaskRelayHost(port,tasks,revokeSend.client,port.authorityId).handle({...message,id:randomUUID(),content:{protocol:TASK_RELAY_PROTOCOL,kind:'task.get',authorityId:port.authorityId,requestId:randomUUID(),taskId:replies[0].task.id}},new AbortController().signal),/AUTHORIZATION_REQUIRED/);assert.equal(revokeSend.sent(),0);
    await assert.rejects(port.bind(p,node.identity.card.agentId,Date.now()+60000,{jti:randomUUID(),expiresAt:Date.now()+30000}),/ACCESS_REVOKED/);
  }finally{if(target)await target.close();f.close();}
});

test('PostgreSQL source Relay checks the existing dispatch, facts and receipt without granting or completing a business action',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
  // Explicit existing-dispatch fixture. The test exercises the transport
  // adapter and never represents a Didi executor/provider acceptance test.
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const binding={bindingId:'synthetic-didi',keyFile:'/synthetic/nonexistent/didi.key',keySha256:'a'.repeat(64),environment:'production' as const},program=new DidiAgentProgram(binding);bindPersonalSourceOwner(program,f.owner);
    const installation=f.installation('Synthetic source-read PA',3600000),policy=f.jobs.security.policies,expiry=new Date(Date.now()+3600000).toISOString(),fields=(type:string)=>Object.keys(policy.fields(type)).filter(field=>policy.fieldPolicy(type,field)!=='internal_only');
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[program.ref.id],resources:['ServiceRequest','RideEstimateTask','DidiPlaceObservation'].map(type=>({type,fields:fields(type)})),sourceBindingIds:[binding.bindingId],channels:['agent_response','registered_model'],expiresAt:expiry});
    policy.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',executeActions:['SearchDidiPlaces'],expiresAt:expiry},policy.revision());
    policy.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt:expiry},policy.revision());
    policy.setSource(f.owner,{installationId:installation.id,bindingId:binding.bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:['SearchDidiPlaces'],outputTypes:['RideEstimateTask','DidiPlaceObservation'],expiresAt:expiry},policy.revision());
    const task=f.task(installation.id),job=task.job,p={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)},scope={type:'RideEstimateTask',id:'pipeline:synthetic-relay-scope'},pin=job.delegation!.ontologyRelease!,db=new DatabaseSync(f.database),model=f.jobs.ontology.model;
    const graph=new OntologyObjectStore(db,model,Date.now,undefined,{releaseRef:pin,skipLegacyMigration:true}),properties={id:scope.id,displayTitle:'Synthetic scope',requestRevision:1,input:{mode:'places',city:'Synthetic City',keywords:'Synthetic Place'},configurationDigest:program.configurationDigest,allowedActions:['SearchDidiPlaces']},link={type:'RideEstimateTaskRequest',from:scope,to:{type:'ServiceRequest',id:job.id}};
    graph.ingest(f.owner,{objects:[{ref:scope,properties}],links:[link]},{kind:'synthetic',id:'synthetic-transport-fixture',observedAt:new Date().toISOString()});
    const snapshot={ref:scope,revision:1,propertiesDigest:digest(properties),linksDigest:graph.relationshipDigest(f.owner,scope,{remaining:1000})};
    const fact={sourceKey:'synthetic-source-key',object:scope,revision:1,semanticRevision:1,semanticDigest:digest(properties),properties,conflicted:false,intakeDigest:'b'.repeat(64),mappingId:'scope',release:pin,observedAt:new Date().toISOString(),expiresAt:expiry,evidenceRefs:['synthetic-source'],sourceId:'synthetic-source',sourceRevision:'1',sourceDigest:'c'.repeat(64),evidenceLevel:'synthetic',relationshipTypes:[link.type],relationshipDigest:digest([link])};
    db.prepare('INSERT INTO ontology_pipeline_facts VALUES(?,?,?,?,?,?)').run(f.owner,pin.ontologyId,fact.sourceKey,scope.type,scope.id,JSON.stringify(fact));db.close();
    f.jobs.security.revokeGrant(f.owner,task.grant.id,task.grant.revision);const grant=f.jobs.security.issueTaskGrant({...task.grant,id:randomUUID(),inputs:[{object:scope,objectRevision:1,fields:fields(scope.type)}],operations:['task.process','member_asset.read'],outputs:[{programId:program.ref.id,programDigest:program.configurationDigest,sourceBindingId:binding.bindingId,type:scope.type,fields:fields(scope.type)}]});
    f.jobs.security.attachTaskAuthority({...task.authority,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision},submittedScopes:['tasks:write','tasks:read']});
    const input={scope,role:'search',keywords:'Synthetic Place'},selection={id:'search',action:'SearchDidiPlaces',argumentsJson:JSON.stringify(input),dependsOn:[],inputRefs:[]},decision:AgentDecision={kind:'execute',requestRevision:1,message:'Synthetic existing dispatch only',steps:[selection],completionJson:''},run={...evidence(),purpose:'planning' as const,decisionDigest:digest(decision)},intentId=randomUUID();
    const body:Omit<AgentActionPlan,'digest'>={id:randomUUID(),version:'2',sequence:1,requestId:job.id,requestRevision:1,programRef:program.ref,programDigest:program.configurationDigest,scope,scopeDigest:digest(properties),modelRunId:run.id,modelDecision:decision,reasoning:decision.message,createdAt:job.createdAt,ontologyPlanning:planningSnapshot({mode:'model_queries',model:model.ref,requestRevision:1,conditionsDigest:digest([]),reads:[],objects:[snapshot],conditionChecks:[],actionProposals:[]}),steps:[{...selection,definitionDigest:digest(model.action(selection.action)),input,intentId,operationKey:randomUUID(),effect:'read'}]},plan={...body,digest:digest(body)};
    job.runs=[run];job.delegation!.agent={version:'1',programRef:program.ref,programDigest:program.configurationDigest,scope,input:properties.input,requestRevision:1,plans:[plan],pendingPlanId:plan.id,observations:[],feedback:[]};f.jobs.save(f.owner,job);
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`,worker=new PostgresWorkerStore(t.database,t.policy,t.kernel),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);
    let renewal:Promise<unknown>|undefined;const timer=setInterval(()=>{if(!renewal)renewal=worker.renew(claim,30000).catch(()=>{}).finally(()=>{renewal=undefined;});},5000);timer.unref();
    try{
      const attempt:ExecutionAttempt={id:randomUUID(),intentId,kind:'dispatch',requestKey:plan.steps[0]!.operationKey,startedAt:new Date().toISOString(),claimToken:claim.token,requestRevision:claim.job.revision??0,inputDigest:digest(input),planDigest:plan.digest,ordinal:1};
      const intent:ActionIntent={id:intentId,owner:f.owner,jobId:job.id,stepId:selection.id,businessOperationKey:plan.steps[0]!.operationKey,planDigest:plan.digest,bindingRef:program.ref,inputDigest:digest({input,inputRefs:[]}),privateDigest:digest({}),privateData:{},dispatchInput:input,effect:'read',state:'dispatching',nextAt:0,createdAt:job.createdAt};const {privateData,...stored}=intent;
      await t.database.run(async c=>{await c.query(`INSERT INTO ${q}.action_intents(id,owner,job_id,business_key,state,private_data,body) VALUES($1,$2,$3,$4,'dispatching',$5,$6)`,[intentId,f.owner,job.id,intent.businessOperationKey,JSON.stringify(privateData),JSON.stringify(stored)]);await c.query(`INSERT INTO ${q}.action_attempts(id,owner,intent_id,body) VALUES($1,$2,$3,$4)`,[attempt.id,f.owner,intentId,JSON.stringify(attempt)]);});
      const reads=new PostgresRelayReadAuthority({database:t.database,policyDigest:t.policy,authority:f.authority!,builder:t.kernel}),peer=(await createNodeKeys('Synthetic source')).identity.card.agentId,context={requestId:job.id,requestRevision:1,planId:plan.id,intentId,attemptId:attempt.id,modelRunId:run.id,programId:program.ref.id,programDigest:program.configurationDigest,action:selection.action,actionInputDigest:digest(input)},requestInput={authorityId:f.authority!.id,gatewayOrigin:f.authority!.canonicalOrigin,source:{bindingId:binding.bindingId,keySha256:binding.keySha256,environment:'production' as const},context,tool:'maps_textsearch' as const,input:{city:'Synthetic City',keywords:'Synthetic Place'}};
      await assert.rejects(reads.create(claim,peer,{...requestInput,context:{...context,attemptId:randomUUID()}}),/ACCESS_REVOKED/);
      await assert.rejects(reads.create(claim,peer,{...requestInput,context:{...context,programDigest:'f'.repeat(64)}}),/SOURCE_NOT_AUTHORIZED/);
      const request=await reads.create(claim,peer,requestInput);assert.equal((await reads.create(claim,peer,requestInput)).callId,request.callId);assert.equal((await reads.pending())[0]?.request.callId,request.callId);
      const connection=randomUUID();await reads.route(request.callId,connection);await assert.rejects(reads.route(request.callId,randomUUID()),/ACCESS_REVOKED/);
      await t.client.query(`UPDATE ${q}.security_sources SET state='revoked' WHERE owner=$1 AND installation_id=$2`,[f.owner,installation.id]);await assert.rejects(reads.authorize(request.callId,peer),/SOURCE_NOT_AUTHORIZED/);
      await t.client.query(`UPDATE ${q}.security_sources SET state='active' WHERE owner=$1 AND installation_id=$2`,[f.owner,installation.id]);
      const proof={jti:randomUUID(),expiresAt:Date.now()+30000};assert.equal((await reads.authorizeProof(request.callId,peer,proof)).callId,request.callId);await assert.rejects(reads.authorizeProof(request.callId,peer,proof),/ACCESS_REVOKED/);
      await t.client.query(`UPDATE ${q}.ontology_pipeline_facts SET body=jsonb_set(body::jsonb,'{conflicted}','true'::jsonb)::text WHERE owner=$1 AND source_key=$2`,[f.owner,fact.sourceKey]);await assert.rejects(reads.authorize(request.callId,peer),/SOURCE_NOT_AUTHORIZED/);
      await t.client.query(`UPDATE ${q}.ontology_pipeline_facts SET body=$1 WHERE owner=$2 AND source_key=$3`,[JSON.stringify(fact),f.owner,fact.sourceKey]);
      const data={kind:'places' as const,places:[]},response={protocol:SOURCE_RELAY_PROTOCOL,kind:'source.result' as const,callId:request.callId,authorityId:request.authorityId,requestDigest:digest(request),result:{data,receipt:{id:randomUUID(),bindingId:binding.bindingId,environment:'production' as const,endpoint:'https://mcp.didichuxing.com/mcp-servers' as const,tool:request.tool,inputDigest:digest(request.input),resultDigest:digest(data),responseSha256:'d'.repeat(64),toolSchemaDigest:'e'.repeat(64),startedAt:new Date().toISOString(),receivedAt:new Date().toISOString()}}};
      await reads.dispatched(request.callId,connection);await assert.rejects(reads.accept(peer,randomUUID(),response),/AUTHORIZATION_REQUIRED/);await reads.accept(peer,connection,response);await reads.accept(peer,connection,response);assert.equal(await reads.ready(claim,request.callId),true);assert.deepEqual(await reads.result(claim,request.callId),response);
      await assert.rejects(reads.accept(peer,connection,{...response,result:{...response.result,receipt:{...response.result.receipt,id:randomUUID()}}}),/POLICY_CHANGED/);
      assert.equal((await t.database.run(c=>new PostgresTaskStorage(c,t.kernel).get(f.owner,job.id))).state,'working','Synthetic transport receipt does not complete a business task');
      assert.equal((await t.database.run(c=>new PostgresTaskStorage(c,t.kernel).intent(f.owner,intentId))).state,'dispatching','Transport data is not a verified business observation');
      const commands=new PostgresTaskCommandService(t.database,t.policy,t.kernel);await commands.cancel(p,job.id);await assert.rejects(reads.authorize(request.callId,peer),/ACCESS_REVOKED/);await assert.rejects(reads.result(claim,request.callId),/ACCESS_REVOKED/);
    }finally{clearInterval(timer);if(renewal)await renewal;}
  }finally{if(target)await target.close();f.close();}
});
