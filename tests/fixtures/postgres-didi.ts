import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {digest} from '../../packages/core/delegation.js';
import {structuredDidiGoal,type DidiEstimateRequest} from '../../packages/core/didi-estimate-request.js';
import {bindPersonalSourceOwner} from '../../packages/core/source-owner.js';
import {createGoalContract} from '../../packages/core/goal-contract.js';
import {goalState,GoalProgram} from '../../packages/coordinator/goal-program.js';
import {createGoalCoverage} from '../../packages/ontology/goal-coverage.js';
import type {AgentDecision,AgentComponentContext} from '../../packages/ontology/agent-actions.js';
import type {ActionDiscoveryPage} from '../../packages/core/action-bindings.js';
import type {DidiMemberConnection} from '../../packages/core/didi-source.js';
import {DidiAgentProgram} from '../../packages/capabilities/didi/program.js';
import {taskContextFields} from '../../packages/security/task-context-contract.js';
import {createNodeKeys,createProof,verifyProof} from '../../packages/agent-transport/crypto.js';
import {SOURCE_RELAY_PROTOCOL} from '../../packages/agent-transport/service-contracts.js';
import {PostgresRelayReadAuthority} from '../../packages/postgres/relay-read-authority.js';
import {PostgresDidiAccount} from '../../packages/postgres/didi-account.js';
import {PostgresReadProgramRegistry} from '../../packages/postgres/didi-registry.js';
import {PostgresDidiExecution} from '../../packages/postgres/didi-execution.js';
import {PostgresWorkerStore} from '../../packages/postgres/worker-store.js';
import {postgresWorkerLane} from '../../packages/postgres/worker-capacity.js';
import {PostgresTaskStorage} from '../../packages/postgres/task-storage.js';
import {PostgresNativePlanningSession} from '../../packages/postgres/native-planning-session.js';
import {discoverPostgresReadActions} from '../../packages/postgres/document-bindings.js';
import {preparePostgresGoalContexts} from '../../packages/postgres/goal-contexts.js';
import {installPostgresAgentPlan} from '../../packages/postgres/agent-plan.js';
import {acceptPostgresGoal} from '../../packages/postgres/goal-acceptance.js';
import {securityFixture} from './security.js';
import {didiFixture} from './didi.js';
import {importPostgresPrimaryFixture} from './postgres-primary.js';
import {evidence,syntheticGoalReview} from '../backend-fixture.js';
import {createExecutableContractKernelDefinition,createFunctionContractCloseoutDefinition,compiledSeedModel} from '../../packages/ontology/seed-definition.js';
import {createSubmittedTask} from '../../packages/core/task-submission.js';
import {postgresProvisionTask} from '../../packages/postgres/task-grants.js';
import {withPostgresAgentWrite,postgresTaskProcessingGrant} from '../../packages/postgres/task-read-access.js';

/** All choices and upstream MCP responses are explicitly synthetic. The
 * PostgreSQL current account, native read ledger, real semantic/journal/source
 * projection and whole-goal acceptance have no permissive verifier callback. */
export async function postgresDidiFixture(relay=false,transport:{deliverSource?:boolean;shortPath?:DidiEstimateRequest;scheduled?:boolean;executionEnvironment?:'live'|'sandbox';goal?:string;releaseVersion?:'34'|'35'}={}){
  const f=securityFixture(Date.now,{unified:true}),source=didiFixture(),sourceKeys=relay?await createNodeKeys('Explicit synthetic provider transport'):undefined,peerId=sourceKeys?.identity.card.agentId;
  const transportDigest=relay?digest({transport:digest({protocol:'eigos.source-read/1',authorityId:f.authority!.id,gatewayOrigin:f.authority!.canonicalOrigin,peerId}),fixture:'explicit-synthetic-provider-v1'}):undefined;
  let pumping:Promise<void>|undefined,pumpTimer:ReturnType<typeof setInterval>|undefined,pumpFailure:unknown,target:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>|undefined,timer:ReturnType<typeof setInterval>|undefined,pending:Promise<void>|undefined,heartbeatFailure:unknown;
  try{
    if(relay&&transport.executionEnvironment==='sandbox')throw new Error('Sandbox fixture registration does not replace a Relay production registration');
    if(transport.releaseVersion&&!transport.shortPath)throw new Error('The forward execution fixture requires an explicit short path');
    const forward=transport.releaseVersion==='35'?createFunctionContractCloseoutDefinition():transport.releaseVersion==='34'?createExecutableContractKernelDefinition():undefined;
    const forwardModel=forward?compiledSeedModel(forward,forward.registry):undefined;
    const forwardRef=forward?{ontologyId:forward.document.id,releaseId:`synthetic-didi-v${forward.document.version}-${randomUUID()}`,digest:digest(forward.document)}:undefined;
    const installation=f.installation('Synthetic DiDi readonly owner',3600000),expiresAt=new Date(Date.now()+3600000).toISOString(),channel='synthetic:didi-readonly',bindingId='synthetic-pg-didi-source',model=f.jobs.ontology.model;
    let descriptor:DidiMemberConnection={version:1,connectionId:randomUUID(),revision:1,memberId:f.member.id,owner:{issuer:f.principal.issuer,tenant:f.principal.tenant,subject:f.principal.subject},localUid:process.getuid?.()??0,purpose:'ride_estimate_readonly',state:'active',expiresAt,binding:{...source.binding,environment:'production',auditDirectory:source.binding.auditDirectory!}};
    const accountDigest=digest({policy:'member-didi-estimate@1',connection:descriptor});f.jobs.admitMemberDidiSource(descriptor,accountDigest);
    const fixtureEnvironment=transport.executionEnvironment==='sandbox'?'sandbox' as const:undefined;
    const initialProgram=fixtureEnvironment?new PostgresReadProgramRegistry(f.jobs.security.policies.definitionDigest,{documentEnabled:false,didi:{kind:'synthetic-fixture',fixtureEnvironment,binding:source.binding,owner:f.owner,
      account:{readCurrent:()=>descriptor,expectedDigest:accountDigest},connector:source.connector}}).entries[0]!.didi!.program
      :new DidiAgentProgram(source.binding,{connector:relay?{evidenceKind:'fixture',transportDigest,invoke:source.connector.invoke.bind(source.connector)}:source.connector});
    bindPersonalSourceOwner(initialProgram,f.owner);
    const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only'),types=[...new Set(['ServiceRequest',...initialProgram.projectionTypes,...Object.keys(taskContextFields)])];
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[initialProgram.ref.id],resources:types.map(type=>({type,fields:fields(type)})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},role:'Owner',executeActions:[...initialProgram.actionIds],invokeFunctions:['rideEstimateStatus','selectDidiPlace'],expiresAt},f.jobs.security.policies.revision());
    const markings=['member_private','personal_data','precise_location','financial','account_private'] as const;
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:[...markings],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:[...markings],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:initialProgram.ref.id,programDigest:initialProgram.configurationDigest,operations:[...initialProgram.actionIds],outputTypes:initialProgram.projectionTypes,expiresAt},f.jobs.security.policies.revision());
    const save=f.jobs.save.bind(f.jobs);f.jobs.save=(owner,job)=>{
      const d=job.delegation!,request=d.request,short=transport.shortPath;
      job.goal=short?.mode==='structured'?structuredDidiGoal(short):short?transport.goal??'只查北京市北京西站到西二旗地铁站的滴滴估价，不叫车不付款。':'只读查询合成滴滴地点或车型估价，不叫车、不付款';
      request.originalGoal=job.goal;
      request.messages=[{id:randomUUID(),text:job.goal,receivedAt:job.createdAt}];
      if(short){
        request.capabilityRef=initialProgram.ref;request.executionEnvironment=transport.executionEnvironment??'live';
        job.messages=[{id:request.messages[0]!.id,role:'user',text:job.goal,at:job.createdAt}];
        d.didiEstimate={request:short,revision:request.revision};
      }
      f.jobs.save=save;return save(owner,job);
    };
    const task=forwardRef?{job:createSubmittedTask(f.principal,{service:'eigos.delegate',goal:transport.shortPath!.mode==='structured'?structuredDidiGoal(transport.shortPath!):transport.goal??'只查滴滴估价',requestId:randomUUID(),executionEnvironment:transport.executionEnvironment,capabilityRef:initialProgram.ref},forwardRef),grant:undefined,authority:undefined}:f.task(installation.id);
    let grant:ReturnType<typeof f.task>['grant']|undefined;
    if(forwardRef){f.jobs.save=save;task.job.delegation!.didiEstimate={request:transport.shortPath!,revision:1};}
    else{
      f.jobs.security.revokeGrant(f.owner,task.grant!.id,task.grant!.revision);
      grant=f.jobs.security.issueTaskGrant({...task.grant!,id:randomUUID(),operations:['task.process','task.query','task.result.read'],channels:['agent_response','registered_model'],outputs:initialProgram.projectionTypes.map(type=>({type,fields:fields(type),programId:initialProgram.ref.id,programDigest:initialProgram.configurationDigest,sourceBindingId:bindingId}))});
      f.jobs.security.attachTaskAuthority({...task.authority!,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision}});
    }
    const request=task.job.delegation!.request,message=request.messages[0]!,goal=createGoalContract(request,task.job.delegation!.ontologyRelease!,[{id:'query',predicate:'ride.query_readback',phase:'fact',description:'An explicitly synthetic readonly DiDi source query result',messageId:message.id,quote:message.text,requirementIds:[]}],[initialProgram.capability()]);
    const fixed=new GoalProgram(goal),reviewContext={request,capability:fixed.capability(),input:{}},review=await syntheticGoalReview(reviewContext),coverage=createGoalCoverage(reviewContext,review.decision,{...review.evidence,purpose:'goal_coverage'});
    if(!transport.shortPath){
      task.job.delegation!.agent=goalState(request,goal);task.job.delegation!.goalCoverage=coverage;
      task.job.delegation!.phase='planning';task.job.runs=[{...review.evidence,purpose:'goal_coverage'}];f.jobs.save(f.owner,task.job);
    }
    target=await importPostgresPrimaryFixture(f);const t=target,q=`"${t.schema}"`,account=new PostgresDidiAccount(source.binding,f.owner,{readCurrent:()=>descriptor,expectedDigest:accountDigest}),reads=relay?new PostgresRelayReadAuthority({database:t.database,policyDigest:t.policy,authority:f.authority!,builder:t.kernel,didiAccount:account}):undefined;
    if(forward&&forwardRef&&forwardModel){
      await t.client.query(`INSERT INTO ${q}.ontology_definition_releases(id,ontology_id,sequence,digest,model_digest,body,created_at) VALUES($1,$2,(SELECT max(sequence)+1 FROM ${q}.ontology_definition_releases WHERE ontology_id=$2),$3,$4,$5,$6)`,[forwardRef.releaseId,forwardRef.ontologyId,forwardRef.digest,forwardModel.ref.digest,JSON.stringify(forward.document),new Date().toISOString()]);
      await t.client.query(`UPDATE ${q}.ontology_namespaces SET active_release_id=$1,generation=generation+1 WHERE id=$2`,[forwardRef.releaseId,forwardRef.ontologyId]);
      const role={subjectKind:'installation',subjectId:installation.id,role:'Owner',resource:{kind:'namespace',id:forwardModel.ref.id,version:forwardModel.ref.digest},executeActions:[...initialProgram.actionIds],invokeFunctions:['rideEstimateStatus','selectDidiPlace'],expiresAt};
      await t.client.query(`INSERT INTO ${q}.security_roles(id,subject_id,body) VALUES($1,$2,$3)`,[digest([role.subjectKind,role.subjectId,role.resource]),installation.id,JSON.stringify(role)]);
      const principal={...f.principal,access:await t.publisher.authenticate(f.principal,installation.token)};
      await t.database.run(client=>withPostgresAgentWrite(client,principal,t.policy,async()=>{
        const store=new PostgresTaskStorage(client,t.kernel);await store.save(f.owner,task.job);
        await postgresProvisionTask(client,principal,task.job,t.policy,[],{builder:t.kernel});
        grant=(await postgresTaskProcessingGrant(client,principal,task.job.id,t.policy)).grant;task.job=await store.get(f.owner,task.job.id);
      }));
    }
    assert(grant);
    const common={binding:source.binding,owner:f.owner,account,sourceBindingId:bindingId};
    const registry=new PostgresReadProgramRegistry(t.policy,{documentEnabled:false,didi:relay?{...common,kind:'relay-fixture',reads:reads!,peerId:peerId!,authority:{id:f.authority!.id,gatewayOrigin:f.authority!.canonicalOrigin}}:{...common,kind:'synthetic-fixture',connector:source.connector,...(fixtureEnvironment?{fixtureEnvironment}:{})}}),program=registry.entries[0]!.program;
    assert.equal(program.configurationDigest,initialProgram.configurationDigest);const worker=new PostgresWorkerStore(t.database,t.policy,t.kernel,transport.scheduled?{classify:(job,intents)=>postgresWorkerLane(job,intents,registry)}:{}),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);
    timer=setInterval(()=>{if(!pending)pending=worker.renew(claim,30000).then(ok=>{if(!ok&&timer)clearInterval(timer);}).catch(error=>{heartbeatFailure=error;}).finally(()=>{pending=undefined;});},4000);timer.unref();
    const options={policyDigest:t.policy,modelChannel:channel,builder:t.kernel,registry,programs:registry.policies(),inspectClaim:(value:Parameters<typeof t.database.inspectClaim>[0])=>t.database.inspectClaim(value,t.policy)};
    const stored=()=>t.database.run(client=>new PostgresTaskStorage(client,t.kernel).get(f.owner,claim.job.id));
    const session=async()=>{
      const current=await stored(),refs=[...(current.delegation!.agent!.composition?.contexts??[]).map(component=>component.scope),...current.delegation!.agent!.observations],startedAt=new Date().toISOString();
      const value=await PostgresNativePlanningSession.create(worker,claim,t.policy,channel,{builder:t.kernel,readScope:'request',boundRefs:[{type:'ServiceRequest',id:claim.job.id},...refs],actionCatalog:registry.catalog,taskContext:{purpose:'agent',program:fixed,refs,capabilityDirectory:{bootstrapComplete:true,discoveryTool:'discover_actions'}},discoverActions:(graph,owner,request,input,context)=>discoverPostgresReadActions(graph,owner,request,input,context,options)});
      return {value,startedAt};
    };
    const finish=async(active:Awaited<ReturnType<typeof session>>,decision:AgentDecision)=>{
      await active.value.acceptReceipts(active.value.receipts().filter(receipt=>receipt.status==='ok').map(receipt=>receipt.id));const reads=await active.value.finish(),run={...evidence(),purpose:'planning' as const,startedAt:active.startedAt,completedAt:new Date().toISOString(),decisionDigest:digest(decision)};assert(await worker.recordRun(claim,run,'agent_decision'));return {decision,reads,run};
    };
    const prepare=async(input:object={mode:'places',city:'北京市',keywords:'北京西站'})=>{
      const active=await session();try{
        await active.value.call('read_task_context',{});const page=await active.value.call('discover_actions',{actionId:'SearchDidiPlaces',programRef:program.ref}) as ActionDiscoveryPage;assert.equal(active.value.lastReceipt()?.status,'ok',JSON.stringify(page));assert.equal(page.items[0]!.bindings[0]!.readiness,'ready');
        const decision:AgentDecision={kind:'prepare',requestRevision:request.revision,message:'Explicit synthetic readonly component selection',steps:[],completionJson:'',contexts:[{id:'didi',bindingDigest:page.items[0]!.bindings[0]!.pin.digest,inputJson:JSON.stringify(input)}]},selected=await finish(active,decision);
        return(await t.database.run(client=>preparePostgresGoalContexts(client,claim,decision,selected.run.id,selected.reads,options)))[0]!;
      }finally{active.value.close();}
    };
    const install=async(component:AgentComponentContext,action:string,input:Record<string,unknown>)=>{
      const active=await session();try{
        await active.value.call('read_task_context',{});const page=await active.value.call('discover_actions',{actionId:action,programRef:program.ref}) as ActionDiscoveryPage;assert.equal(active.value.lastReceipt()?.status,'ok',JSON.stringify(page));
        await active.value.call('query_ontology',{object:component.scope});assert.equal(active.value.lastReceipt()?.status,'ok');
        const current=await stored();for(const observation of current.delegation!.agent!.observations){await active.value.call('query_ontology',{object:observation});await active.value.call('evaluate_ontology',{function:'rideEstimateStatus',object:observation});assert.equal(active.value.lastReceipt()?.status,'ok');}
        const decision:AgentDecision={kind:'execute',requestRevision:request.revision,message:'Explicit synthetic readonly action',steps:[{id:`read-${(current.delegation!.agent!.plans.length)+1}`,action,bindingDigest:page.items[0]!.bindings[0]!.pin.digest,contextId:component.id,contributesTo:['query'],argumentsJson:JSON.stringify(input),dependsOn:[],inputRefs:[]}],completionJson:''},selected=await finish(active,decision);
        return t.database.run(client=>installPostgresAgentPlan(client,claim,decision,selected.run.id,selected.reads,options));
      }finally{active.value.close();}
    };
    if(reads&&sourceKeys&&transport.deliverSource!==false){
      // Explicit synthetic provider transport only. The real read-authority
      // APIs, signed DPoP proof, original journal context and actual MCP SDK
      // receipt remain intact; no verifier/acceptance boolean is injected.
      const handled=new Set<string>();pumpTimer=setInterval(()=>{if(!pumping)pumping=(async()=>{
        for(const item of await reads.pending()){
          const request=item.request;if(handled.has(request.callId))continue;handled.add(request.callId);const connection=randomUUID();
          await reads.route(request.callId,connection);const url=f.authority!.canonicalOrigin+`/relay/source-reads/${request.callId}/authorize`,proof=await createProof(sourceKeys,request.callId,'POST',url),verified=await verifyProof(proof,request.callId,'POST',url,peerId!);
          await reads.authorizeProof(request.callId,peerId!,verified);await reads.dispatched(request.callId,connection);
          const result=await source.connector.invoke(request.context,request.tool,request.input,new AbortController().signal,async()=>{await reads.authorize(request.callId,peerId!);await t.database.run(async client=>registry.assertConfigured(client,registry.entries[0]!,claim,await new PostgresTaskStorage(client,t.kernel).get(f.owner,claim.job.id)));});
          await reads.accept(peerId!,connection,{protocol:SOURCE_RELAY_PROTOCOL,kind:'source.result',callId:request.callId,authorityId:request.authorityId,requestDigest:digest(request),result});
        }
      })().catch(error=>{pumpFailure=error;}).finally(()=>{pumping=undefined;});},10);pumpTimer.unref();
    }
    const execution=new PostgresDidiExecution({...options,database:t.database,registry});
    const execute=async(plan:Awaited<ReturnType<typeof install>>)=>{
      const result=await execution.execute(claim,plan.steps[0]!.intentId,new AbortController().signal);assert(result.applied);
      assert(await worker.checkpoint(claim,current=>{delete current.delegation!.agent!.pendingPlanId;current.delegation!.phase='planning';}));return result;
    };
    const complete=async(component:AgentComponentContext,observation:{type:string;id:string})=>{
      const active=await session();try{
        await active.value.call('read_task_context',{});await active.value.call('query_ontology',{object:component.scope});await active.value.call('query_ontology',{object:observation});await active.value.call('evaluate_ontology',{function:'rideEstimateStatus',object:observation});assert.equal(active.value.lastReceipt()?.status,'ok');
        const proposal={components:[{contextId:component.id,proposalJson:JSON.stringify({observation,rationale:'Only the explicitly synthetic source read is complete; no ride/payment'})}],criteria:[{id:'query',contextIds:[component.id]}],conditions:[]},decision:AgentDecision={kind:'complete',requestRevision:request.revision,message:'Synthetic source read selected for independent domain and fixed-goal acceptance',steps:[],completionJson:JSON.stringify(proposal)},selected=await finish(active,decision);
        return t.database.run(client=>acceptPostgresGoal(client,claim,decision,selected.run.id,selected.reads,options));
      }finally{active.value.close();}
    };
    const stopRenewals=async()=>{if(timer)clearInterval(timer);timer=undefined;if(pending)await pending;};
    return {f,t,q,source,reads,registry,program,worker,claim,request,goal,grant,bindingId,installation,channel,options,accountDigest,stored,session,prepare,install,execute,execution,complete,stopRenewals,setDescriptor:(value:DidiMemberConnection)=>{descriptor=value;},descriptor:()=>structuredClone(descriptor),close:async()=>{await stopRenewals();if(pumpTimer)clearInterval(pumpTimer);if(pumping)await pumping;try{await t.close();}finally{f.close();source.close();}assert.equal(heartbeatFailure,undefined);assert.equal(pumpFailure,undefined);}};
  }catch(error){if(timer)clearInterval(timer);if(pumpTimer)clearInterval(pumpTimer);if(pending)await pending;if(pumping)await pumping;try{await target?.close();}finally{f.close();source.close();}throw error;}
}
