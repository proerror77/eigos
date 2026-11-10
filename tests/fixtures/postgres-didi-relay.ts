// Actual encrypted Relay/Gateway/ServiceAgent and PostgreSQL authority. Model
// choices and the upstream MCP fetch are explicit synthetic fixtures only.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import express from 'express';
import {z} from 'zod';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {TaskRelayGateway,mountTaskRelay} from '../../apps/gateway/relay.js';
import {digest} from '../../packages/core/delegation.js';
import {bindPersonalSourceOwner} from '../../packages/core/source-owner.js';
import {createGoalContract} from '../../packages/core/goal-contract.js';
import {goalState,GoalProgram} from '../../packages/coordinator/goal-program.js';
import {openOntologyMcp} from '../../packages/coordinator/ontology-mcp.js';
import type {ServicePlan} from '../../packages/coordinator/service-planner.js';
import {createGoalCoverage} from '../../packages/ontology/goal-coverage.js';
import {agentDecisionSchema,type AgentDecision,type AgentComponentContext} from '../../packages/ontology/agent-actions.js';
import type {ActionDiscoveryPage} from '../../packages/core/action-bindings.js';
import type {DidiMemberConnection} from '../../packages/core/didi-source.js';
import {DidiAgentProgram} from '../../packages/capabilities/didi/program.js';
import {DidiMcpConnector,type DidiConnector,type DidiReadResult} from '../../packages/capabilities/didi/connector.js';
import {DidiRelayService,type DidiServiceConfig,type SourceAuthorizationEvent} from '../../packages/agent-transport/didi-service.js';
import {taskContextFields} from '../../packages/security/task-context-contract.js';
import {sourceReadRequestSchema} from '../../packages/agent-transport/service-contracts.js';
import {PostgresTaskRelay} from '../../packages/postgres/task-relay.js';
import {PostgresDidiAccount} from '../../packages/postgres/didi-account.js';
import {PostgresReadProgramRegistry} from '../../packages/postgres/didi-registry.js';
import {PostgresDidiExecution} from '../../packages/postgres/didi-execution.js';
import {PostgresWorkerStore} from '../../packages/postgres/worker-store.js';
import {PostgresTaskStorage} from '../../packages/postgres/task-storage.js';
import {PostgresTaskCommandService} from '../../packages/postgres/task-command-service.js';
import {PostgresNativePlanningSession} from '../../packages/postgres/native-planning-session.js';
import {openPostgresRelayNode,relayNodeWrappingKey} from '../../packages/postgres/relay-node-store.js';
import {installPostgresMessagingStorage} from '../../packages/postgres/messaging-schema.js';
import {discoverPostgresReadActions} from '../../packages/postgres/document-bindings.js';
import {preparePostgresGoalContexts} from '../../packages/postgres/goal-contexts.js';
import {installPostgresAgentPlan} from '../../packages/postgres/agent-plan.js';
import {acceptPostgresGoal} from '../../packages/postgres/goal-acceptance.js';
import {securityFixture} from './security.js';
import {didiFixture} from './didi.js';
import {relayFixture} from './relay.js';
import {importPostgresPrimaryFixture} from './postgres-primary.js';
import {syntheticGoalReview} from '../backend-fixture.js';

export interface PostgresDidiRelayHooks {
  afterToolsListed?:()=>Promise<void>;
  afterProviderReceipt?:(result:DidiReadResult)=>Promise<void>;
}
export async function waitForDidiRelay(check:()=>Promise<boolean>,timeout=30000){
  const until=Date.now()+timeout;while(!await check()){if(Date.now()>=until)throw new Error('The actual DiDi Relay did not reach the expected durable boundary');await delay(25);}
}

/** This fixture may be run only by the LOCAL PostgreSQL owner. The business
 * task and its preapproved grants are imported once; the source Agent retains
 * its own private Key, node identity and receipt ledger. No completed source
 * request or business observation is seeded to simulate transport success. */
export async function postgresDidiRelayFixture(hooks:PostgresDidiRelayHooks={}){
  const f=securityFixture(Date.now,{unified:true}),provider=didiFixture(),relay=await relayFixture(),sourceNode=await relay.client('DiDi-source');
  const peerId=sourceNode.agentId,authority=f.authority!,transportDigest=digest({transport:digest({protocol:'eigos.source-read/1',authorityId:authority.id,gatewayOrigin:authority.canonicalOrigin,peerId}),fixture:'explicit-synthetic-provider-v1'});
  // Only configuration metadata is needed before the source transport exists.
  // This constructor is pure; any accidental provider dispatch is a failure.
  const unavailable:DidiConnector={evidenceKind:'fixture',transportDigest,invoke:async()=>{throw new Error('The preimport metadata program cannot dispatch');}};
  const initialProgram=new DidiAgentProgram(provider.binding,{connector:unavailable});bindPersonalSourceOwner(initialProgram,f.owner);
  let target:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>|undefined,gateway:TaskRelayGateway|undefined,service:DidiRelayService|undefined,gatewayNode:Awaited<ReturnType<typeof openPostgresRelayNode>>|undefined;
  let renewal:Promise<unknown>|undefined,timer:ReturnType<typeof setInterval>|undefined,heartbeatFailure:unknown,sourceRun:Promise<void>|undefined;
  const sourceStop=new AbortController(),http=createServer(),sourceEvents:SourceAuthorizationEvent[]=[],sourceFailures:unknown[]=[];
  const httpChecks:{callId:string;status:number}[]=[],proofReplays:number[]=[],sourceMessages:{senderId:string;id:string;connectionId:string;callId:string}[]=[];
  const close=async()=>{
    sourceStop.abort();const errors:unknown[]=[];const attempt=async(work:()=>unknown|Promise<unknown>)=>{try{await work();}catch(error){errors.push(error);}};
    await attempt(()=>sourceRun);await attempt(()=>gateway?.close());await attempt(()=>gatewayNode?.close());await attempt(()=>service?.close());
    if(timer)clearInterval(timer);await attempt(()=>renewal);http.closeAllConnections();if(http.listening)await attempt(()=>new Promise<void>((resolve,reject)=>http.close(error=>error?reject(error):resolve())));
    await attempt(()=>target?.close());await attempt(()=>relay.close());await attempt(()=>f.close());await attempt(()=>provider.close());
    if(heartbeatFailure)errors.push(heartbeatFailure);errors.push(...sourceFailures);if(errors.length)throw new AggregateError(errors,'Encrypted DiDi fixture cleanup failed');
  };
  try{
    const installation=f.installation('Synthetic encrypted DiDi PA',3600000),expiresAt=new Date(Date.now()+3600000).toISOString(),channel='synthetic:encrypted-didi-native',bindingId='synthetic-encrypted-didi-source',model=f.jobs.ontology.model;
    let descriptor:DidiMemberConnection={version:1,connectionId:randomUUID(),revision:1,memberId:f.member.id,owner:{issuer:f.principal.issuer,tenant:f.principal.tenant,subject:f.principal.subject},localUid:process.getuid?.()??0,purpose:'ride_estimate_readonly',state:'active',expiresAt,binding:{...provider.binding,environment:'production',auditDirectory:provider.binding.auditDirectory!}};
    const accountDigest=digest({policy:'member-didi-estimate@1',connection:descriptor});f.jobs.admitMemberDidiSource(descriptor,accountDigest);
    const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only'),types=[...new Set(['ServiceRequest',...initialProgram.projectionTypes,...Object.keys(taskContextFields)])];
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[initialProgram.ref.id],resources:types.map(type=>({type,fields:fields(type)})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},role:'Owner',executeActions:[...initialProgram.actionIds],invokeFunctions:['rideEstimateStatus','selectDidiPlace'],expiresAt},f.jobs.security.policies.revision());
    const markings=['member_private','personal_data','precise_location','financial','account_private'] as const;
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:[...markings],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:[...markings],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:initialProgram.ref.id,programDigest:initialProgram.configurationDigest,operations:[...initialProgram.actionIds],outputTypes:initialProgram.projectionTypes,expiresAt},f.jobs.security.policies.revision());
    const save=f.jobs.save.bind(f.jobs);f.jobs.save=(owner,job)=>{job.goal='只读查询合成滴滴地点，不叫车、不付款';job.delegation!.request.originalGoal=job.goal;job.delegation!.request.messages=[{id:randomUUID(),text:job.goal,receivedAt:job.createdAt}];f.jobs.save=save;return save(owner,job);};
    const task=f.task(installation.id);f.jobs.security.revokeGrant(f.owner,task.grant.id,task.grant.revision);
    const grant=f.jobs.security.issueTaskGrant({...task.grant,id:randomUUID(),operations:['task.process','task.query','task.result.read'],channels:['agent_response','registered_model'],outputs:initialProgram.projectionTypes.map(type=>({type,fields:fields(type),programId:initialProgram.ref.id,programDigest:initialProgram.configurationDigest,sourceBindingId:bindingId}))});
    f.jobs.security.attachTaskAuthority({...task.authority,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision}});
    const request=task.job.delegation!.request,message=request.messages[0]!,goal=createGoalContract(request,task.job.delegation!.ontologyRelease!,[{id:'query',predicate:'ride.query_readback',phase:'fact',description:'Explicit synthetic place query, with real encrypted source transport',messageId:message.id,quote:message.text,requirementIds:[]}],[initialProgram.capability()]);
    const fixed=new GoalProgram(goal),reviewContext={request,capability:fixed.capability(),input:{}},review=await syntheticGoalReview(reviewContext),coverage=createGoalCoverage(reviewContext,review.decision,{...review.evidence,purpose:'goal_coverage'});
    task.job.delegation!.agent=goalState(request,goal);task.job.delegation!.goalCoverage=coverage;task.job.delegation!.phase='planning';task.job.runs=[{...review.evidence,purpose:'goal_coverage'}];f.jobs.save(f.owner,task.job);
    // Preserve the real source messaging schema even when no endpoint was
    // enrolled in this synthetic source. Runtime startup never creates it.
    f.jobs.createMessagingStore();target=await importPostgresPrimaryFixture(f);const t=target,q=`"${t.schema}"`;
    // Explicit fixture migration-administrator step, never a host startup DDL.
    await t.database.run(client=>t.publisher.withManagement(client,()=>installPostgresMessagingStorage(client)));
    const account=new PostgresDidiAccount(provider.binding,f.owner,{readCurrent:()=>descriptor,expectedDigest:accountDigest}),port=new PostgresTaskRelay({database:t.database,policyDigest:t.policy,authorityId:authority.id,gatewayOrigin:authority.canonicalOrigin,builder:t.kernel,didiAccount:account});
    const wrappingKey=await relayNodeWrappingKey(randomBytes(32)),nodeId='gateway:synthetic-encrypted-didi';
    gatewayNode=await openPostgresRelayNode({database:t.database,publisher:t.publisher,nodeId,baseUrl:relay.baseUrl,wrappingKey,displayName:'Synthetic PostgreSQL gateway',createIfMissing:true,assertCurrent:async()=>{await port.authorityCurrent();}});await gatewayNode.register('fixture-owner');
    const contact=await gatewayNode.requestContact(sourceNode.agentId);await sourceNode.respondContact(contact.id,'accept');
    const registry=new PostgresReadProgramRegistry(t.policy,{documentEnabled:false,didi:{kind:'relay-fixture',binding:provider.binding,owner:f.owner,account,reads:port.reads,peerId,authority:{id:authority.id,gatewayOrigin:authority.canonicalOrigin},sourceBindingId:bindingId}}),program=registry.entries[0]!.program;
    assert.equal(program.configurationDigest,initialProgram.configurationDigest);const commands=new PostgresTaskCommandService(t.database,t.policy,t.kernel),worker=new PostgresWorkerStore(t.database,t.policy,t.kernel),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);
    timer=setInterval(()=>{if(!renewal)renewal=worker.renew(claim,30000).then(ok=>{if(!ok&&timer)clearInterval(timer);}).catch(error=>{heartbeatFailure=error;}).finally(()=>{renewal=undefined;});},4000);timer.unref();
    gateway=new TaskRelayGateway(port,commands,authority.canonicalOrigin,{version:1,relayUrl:relay.baseUrl,displayName:'Synthetic PostgreSQL gateway'},sourceNode.agentId,{openClient:async()=>gatewayNode!});
    const app=express();app.use(express.json({limit:'64kb'}));mountTaskRelay(app,gateway,port,(_req,res)=>{res.sendStatus(401);},()=>{throw new Error('The source DPoP route must not invent a PA login');});http.on('request',app);http.listen(0,'127.0.0.1');await once(http,'listening');
    const address=http.address();assert(address&&typeof address!=='string');const primaryHttp=`http://127.0.0.1:${address.port}`;
    const authorizeFetch:typeof fetch=async(input,init)=>{
      const url=new URL(input instanceof Request?input.url:String(input));assert.equal(url.origin,authority.canonicalOrigin);assert.match(url.pathname,/^\/relay\/source-reads\/[a-f0-9-]+\/authorize$/);assert.equal(init?.method,'POST');assert(new Headers(init.headers).has('DPoP'));
      // Only TCP routing changes for loopback. The actual route validates the
      // source-signed DPoP against its pinned canonical HTTPS URL and consumes
      // the jti in the actual PostgreSQL proof table.
      const response=await fetch(primaryHttp+url.pathname,init);httpChecks.push({callId:url.pathname.split('/')[3]!,status:response.status});
      if(response.ok&&!proofReplays.length){const replay=await fetch(primaryHttp+url.pathname,init);proofReplays.push(replay.status);await replay.body?.cancel();assert.equal(replay.status,403,'The actual HTTP route must reject replay of the consumed source proof');}
      return response;
    };
    const providerFetch:typeof fetch=async(input,init)=>{const response=await provider.fetcher(input,init);if(init?.method==='POST'&&JSON.parse(String(init.body)).method==='tools/list')await hooks.afterToolsListed?.();return response;};
    const upstream=new DidiMcpConnector(provider.binding,providerFetch),connector:DidiConnector={evidenceKind:'live_readonly',invoke:async(...args)=>{const result=await upstream.invoke(...args);await hooks.afterProviderReceipt?.(result);return result;}};
    const ledgerPath=join(f.directory,'didi-source-receipts.sqlite'),config:DidiServiceConfig={version:1,authorityId:authority.id,gatewayAgentId:gatewayNode.agentId,gatewayOrigin:authority.canonicalOrigin,relayUrl:relay.baseUrl,credentialPath:join(relay.directory,'DiDi-source.json'),ledgerPath,displayName:'Explicit synthetic provider source',binding:{...provider.binding,environment:'production'}};
    service=new DidiRelayService(sourceNode,config,connector,authorizeFetch,event=>sourceEvents.push(event));
    await gateway.start();sourceRun=sourceNode.listen(async message=>{const request=sourceReadRequestSchema.parse(message.content);sourceMessages.push({senderId:message.senderId,id:message.id,connectionId:message.connectionId,callId:request.callId});await service!.handle(message,sourceStop.signal);},sourceStop.signal,{concurrency:2}).catch(error=>{if(!sourceStop.signal.aborted)sourceFailures.push(error);});
    await waitForDidiRelay(async()=>gateway!.status==='connected');
    const options={policyDigest:t.policy,modelChannel:channel,builder:t.kernel,registry,programs:registry.policies(),inspectClaim:(value:Parameters<typeof t.database.inspectClaim>[0])=>t.database.inspectClaim(value,t.policy)};
    const stored=()=>t.database.run(client=>new PostgresTaskStorage(client,t.kernel).get(f.owner,claim.job.id));
    const session=async()=>{
      const current=await stored(),refs=[...(current.delegation!.agent!.composition?.contexts??[]).map(component=>component.scope),...current.delegation!.agent!.observations],startedAt=new Date().toISOString(),id=randomUUID(),runtime='synthetic-encrypted-didi-native-choice';
      const value=await PostgresNativePlanningSession.create(worker,claim,t.policy,channel,{builder:t.kernel,readScope:'request',boundRefs:[{type:'ServiceRequest',id:claim.job.id},...refs],actionCatalog:registry.catalog,taskContext:{purpose:'agent',program:fixed,refs,capabilityDirectory:{bootstrapComplete:true,discoveryTool:'discover_actions'}},discoverActions:(graph,owner,request,input,context)=>discoverPostgresReadActions(graph,owner,request,input,context,options)});
      await worker.beginModelUsage(claim,id,runtime,startedAt);let finished=false;const mcp=await openOntologyMcp(value,new AbortController().signal,undefined,z.toJSONSchema(agentDecisionSchema),channel),client=new Client({name:'explicit-synthetic-encrypted-source-chooser',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(mcp.connection.url),{requestInit:{headers:{Authorization:`Bearer ${mcp.connection.token}`}}});
      await value.authorizeModel(channel);await client.connect(transport,{timeout:120000});
      const call=async(name:string,args:Record<string,unknown>)=>{const response=await client.callTool({name,arguments:args},{timeout:120000});assert(!response.isError,JSON.stringify(response));const result=(response.structuredContent as {result:any}).result;return result.result??result;};
      return {value,id,runtime,startedAt,mcp,call,markFinished:()=>{finished=true;},close:async()=>{await client.close();await transport.close();await mcp.close();value.close();if(!finished)await worker.finishModelUsage(claim,id,undefined,'interrupted');}};
    };
    const finish=async(active:Awaited<ReturnType<typeof session>>,decision:AgentDecision)=>{
      await active.call('submit_decision',{decisionJson:JSON.stringify(decision),receiptIds:active.value.receipts().filter(receipt=>receipt.status==='ok').map(receipt=>receipt.id)});assert.deepEqual(active.mcp.result().output,decision);
      const reads=await active.value.finish(),run={id:active.id,runtime:active.runtime,startedAt:active.startedAt,completedAt:new Date().toISOString(),outputSha256:digest(decision),purpose:'planning' as const,decisionDigest:digest(decision),ontologyMcp:active.mcp.evidence()};
      await worker.finishModelUsage(claim,run.id,run,'completed');active.markFinished();assert(await worker.recordRun(claim,run,'agent_decision'));return {decision,reads,run};
    };
    const prepare=async(checkServicePlan=false)=>{const active=await session();try{
      await active.call('read_task_context',{});
      if(checkServicePlan){
        const {id:messageId,text:quote}=request.messages[0]!;
        const plan=await active.call('plan_services',{goal:{kind:'needs',needs:[{id:'estimate',role:'transport.estimate',
          source:{messageId,quote},output:{type:'RideEstimateObservation',phase:'quote'}}]}}) as ServicePlan;
        const read=active.value.lastReceipt()!;
        assert.equal(read.status,'ok');assert.equal(plan.executionAllowed,false);assert.equal(plan.availabilityProof,false);
        const steps=plan.needs[0]!.alternatives[0]!.steps;
        assert.deepEqual(steps.map(step=>step.action),['SearchDidiPlaces','SearchDidiPlaces','EstimateDidiRide']);
        assert.deepEqual(steps[2]!.dependsOn,steps.slice(0,2).map(step=>step.id));
        assert.deepEqual(read.actionBindings,{snapshotDigest:plan.digest,pins:plan.contracts.map(contract=>contract.binding)});
        assert.equal(provider.calls.filter(call=>call.method==='tools/call').length,0);
      }
      const page=await active.call('discover_actions',{actionId:'SearchDidiPlaces',programRef:program.ref}) as ActionDiscoveryPage;assert.equal(active.value.lastReceipt()?.status,'ok');assert.equal(page.items[0]!.bindings[0]!.readiness,'ready');
      const decision:AgentDecision={kind:'prepare',requestRevision:request.revision,message:'Explicit synthetic selection using the actual native Ontology HTTP receipts',steps:[],completionJson:'',contexts:[{id:'didi',bindingDigest:page.items[0]!.bindings[0]!.pin.digest,inputJson:JSON.stringify({mode:'places',city:'北京市',keywords:'北京西站'})}]},selected=await finish(active,decision);
      return(await t.database.run(client=>preparePostgresGoalContexts(client,claim,decision,selected.run.id,selected.reads,options)))[0]!;
    }finally{await active.close();}};
    const install=async(component:AgentComponentContext)=>{const active=await session();try{
      await active.call('read_task_context',{});const page=await active.call('discover_actions',{actionId:'SearchDidiPlaces',programRef:program.ref}) as ActionDiscoveryPage;await active.call('query_ontology',{object:component.scope});assert.equal(active.value.lastReceipt()?.status,'ok');
      const decision:AgentDecision={kind:'execute',requestRevision:request.revision,message:'Explicit synthetic readonly choice with actual source and binding authorization',steps:[{id:'search',action:'SearchDidiPlaces',bindingDigest:page.items[0]!.bindings[0]!.pin.digest,contextId:component.id,contributesTo:['query'],argumentsJson:JSON.stringify({scope:component.scope,role:'search',keywords:'北京西站'}),dependsOn:[],inputRefs:[]}],completionJson:''},selected=await finish(active,decision);
      return t.database.run(client=>installPostgresAgentPlan(client,claim,decision,selected.run.id,selected.reads,options));
    }finally{await active.close();}};
    const execution=new PostgresDidiExecution({...options,database:t.database,registry}),execute=async(plan:Awaited<ReturnType<typeof install>>,signal:AbortSignal)=>{const result=await execution.execute(claim,plan.steps[0]!.intentId,signal);assert(result.applied);assert(await worker.checkpoint(claim,current=>{delete current.delegation!.agent!.pendingPlanId;current.delegation!.phase='planning';}));return result;};
    const complete=async(component:AgentComponentContext,observation:{type:string;id:string})=>{const active=await session();try{
      await active.call('read_task_context',{});await active.call('query_ontology',{object:component.scope});await active.call('query_ontology',{object:observation});await active.call('evaluate_ontology',{function:'rideEstimateStatus',object:observation});assert.equal(active.value.lastReceipt()?.status,'ok');
      const proposal={components:[{contextId:component.id,proposalJson:JSON.stringify({observation,rationale:'Only the synthetic supplied source read is complete; no ride or payment'})}],criteria:[{id:'query',contextIds:[component.id]}],conditions:[]},decision:AgentDecision={kind:'complete',requestRevision:request.revision,message:'Independent real domain and fixed-goal acceptance over encrypted synthetic data',steps:[],completionJson:JSON.stringify(proposal)},selected=await finish(active,decision);
      return t.database.run(client=>acceptPostgresGoal(client,claim,decision,selected.run.id,selected.reads,options));
    }finally{await active.close();}};
    const sourceLedger=()=>{const db=new DatabaseSync(ledgerPath,{readOnly:true});try{return db.prepare('SELECT id,request_digest,state,result FROM source_relay_reads ORDER BY id').all().map(row=>({id:String(row.id),requestDigest:String(row.request_digest),state:String(row.state),result:row.result?JSON.parse(String(row.result)):undefined}));}finally{db.close();}};
    const revokeSource=()=>t.database.run(client=>client.query(`UPDATE ${q}.security_sources SET state='revoked' WHERE binding_id=$1`,[bindingId]).then(()=>{}));
    return {f,t,q,relay,provider,sourceNode,gatewayNode,gateway,port,account,registry,program,commands,worker,claim,request,goal,installation,grant,bindingId,nodeId,sourceEvents,httpChecks,proofReplays,sourceMessages,sourceLedger,stored,prepare,install,execution,execute,complete,revokeSource,setDescriptor:(value:DidiMemberConnection)=>{descriptor=value;},descriptor:()=>structuredClone(descriptor),sourceAudit:()=>readFileSync(join(provider.binding.auditDirectory!,'reads.jsonl'),'utf8'),close};
  }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Encrypted DiDi fixture setup failed',{cause:error});}throw error;}
}
