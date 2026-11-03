import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../../packages/core/delegation.js';
import {ExecutionCatalog} from '../../packages/core/catalog.js';
import {createGoalContract} from '../../packages/core/goal-contract.js';
import {goalState,GoalProgram} from '../../packages/coordinator/goal-program.js';
import {DocumentAgentProgram} from '../../packages/capabilities/document-agent.js';
import type {RunEvidence} from '../../packages/capabilities/executor.js';
import type {AgentDecision} from '../../packages/ontology/agent-actions.js';
import {OntologyObjectStore} from '../../packages/ontology/object-store.js';
import {taskContextFields} from '../../packages/security/task-context-contract.js';
import {PostgresWorkerStore} from '../../packages/postgres/worker-store.js';
import {PostgresTaskStorage} from '../../packages/postgres/task-storage.js';
import {PostgresNativePlanningSession,type PostgresPlanningDiscoveryContext} from '../../packages/postgres/native-planning-session.js';
import {discoverPostgresDocumentActions} from '../../packages/postgres/document-bindings.js';
import {createPostgresDocumentPolicy} from '../../packages/postgres/document-policy.js';
import {preparePostgresGoalContexts} from '../../packages/postgres/goal-contexts.js';
import {installPostgresAgentPlan} from '../../packages/postgres/agent-plan.js';
import {securityFixture} from './security.js';
import {importPostgresFixture} from './postgres-business.js';
import {evidence} from '../backend-fixture.js';

/** Actual PostgreSQL/Doc/Goal/native receipt fixture. Model choices are
 * explicitly synthetic; there is no permissive semantic or source callback. */
export async function postgresGoalFixture(){
  const f=securityFixture(Date.now,{unified:true}),program=new DocumentAgentProgram(),channel='synthetic:native-goal-contexts',bindingId='synthetic-native-document-source';
  let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined,timer:ReturnType<typeof setInterval>|undefined,pending:Promise<void>|undefined,failure:unknown;
  try{
    const installation=f.installation('Synthetic native goal preparation',3600000),expiresAt=new Date(Date.now()+3600000).toISOString(),model=f.jobs.ontology.model;
    const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only'),types=[...new Set(['ServiceRequest','DocumentTask','DocumentDraft','Place',...Object.keys(taskContextFields)])];
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[program.ref.id],resources:types.map(type=>({type,fields:fields(type)})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},role:'Viewer',executeActions:['ComposeDocument'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:['member_private','personal_data'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:['ComposeDocument'],outputTypes:['DocumentTask','DocumentDraft'],expiresAt},f.jobs.security.policies.revision());
    const save=f.jobs.save.bind(f.jobs);f.jobs.save=(owner,job)=>{job.goal='Produce a Markdown document using this supplied synthetic information';job.delegation!.request.originalGoal=job.goal;job.delegation!.request.messages=[{id:randomUUID(),text:job.goal,receivedAt:job.createdAt}];f.jobs.save=save;return save(owner,job);};
    const task=f.task(installation.id),request=task.job.delegation!.request;
    f.jobs.security.revokeGrant(f.owner,task.grant.id,task.grant.revision);
    const grant=f.jobs.security.issueTaskGrant({...task.grant,id:randomUUID(),operations:['task.process','task.query','task.result.read'],channels:['agent_response','registered_model'],outputs:['DocumentTask','DocumentDraft'].map(type=>({type,fields:fields(type),programId:program.ref.id,programDigest:program.configurationDigest,sourceBindingId:bindingId}))});
    f.jobs.security.attachTaskAuthority({...task.authority,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision}});
    const principal={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)},message=request.messages[0]!,goal=createGoalContract(request,task.job.delegation!.ontologyRelease!,[{id:'document',predicate:'document.markdown',phase:'artifact',description:'The requested Markdown document',messageId:message.id,quote:message.text,requirementIds:[]}],[program.capability()]);
    // Source metadata oracle is used only before the offline import, never as
    // a second active store for the PostgreSQL decisions below.
    const actionCatalog=new ExecutionCatalog([program.capability()],[],[],[],[program]),sourceDb=new DatabaseSync(f.database);let sourcePage:ReturnType<ExecutionCatalog['discoverActions']>;
    try{const release=f.jobs.definitions.active(),graph=new OntologyObjectStore(sourceDb,release.model,Date.now,undefined,{ontologyId:release.ref.ontologyId,releaseRef:release.ref,skipLegacyMigration:true},false);sourcePage=actionCatalog.discoverActions(graph,f.owner,request,{actionId:'ComposeDocument',programRef:program.ref});}finally{sourceDb.close();}
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`,worker=new PostgresWorkerStore(t.database,t.policy),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);
    timer=setInterval(()=>{if(!pending)pending=worker.renew(claim,30000).then(ok=>{assert(ok);}).catch(error=>{failure=error;}).finally(()=>{pending=undefined;});},4000);timer.unref();
    assert(await worker.checkpoint(claim,job=>{job.delegation!.agent=goalState(job.delegation!.request,goal);job.delegation!.phase='planning';}));
    const directory=await worker.catalogue(claim,[{capability:program.capability(),program}],channel);assert.equal(directory.items.length,1);assert.deepEqual(directory.items[0]!.ref,program.ref);assert.equal(directory.hasMore,false);
    const options={policyDigest:t.policy,modelChannel:channel,sourceBindingId:bindingId,inspectClaim:(value:Parameters<typeof t.database.inspectClaim>[0])=>t.database.inspectClaim(value,t.policy),programs:[createPostgresDocumentPolicy()]};
    let capturedContext:PostgresPlanningDiscoveryContext|undefined;
    const session=async(refs:readonly {type:string;id:string}[]=[])=>{
      const startedAt=new Date().toISOString(),value=await PostgresNativePlanningSession.create(worker,claim,t.policy,channel,{taskContext:{purpose:'agent',program:new GoalProgram(goal),refs,capabilityDirectory:{bootstrapComplete:true,discoveryTool:'discover_actions'}},actionCatalog,readScope:'request',boundRefs:[{type:'ServiceRequest',id:claim.job.id},...refs],
        discoverActions:(graph,owner,request,input,context)=>{capturedContext=context;return discoverPostgresDocumentActions(graph,owner,request,input,context,options);}});
      return {value,startedAt};
    };
    const prepareDecision=async(id='document')=>{
      const {value,startedAt}=await session();try{
        const context=await value.call('read_task_context',{});assert.equal(value.lastReceipt()?.status,'ok',JSON.stringify(context));
        const page=await value.call('discover_actions',{actionId:'ComposeDocument',programRef:program.ref}) as typeof sourcePage;assert.equal(value.lastReceipt()?.status,'ok',JSON.stringify(page));
        assert.equal(page.items[0]!.bindings[0]!.readiness,'ready');const pin=page.items[0]!.bindings[0]!.pin;
        const decision:AgentDecision={kind:'prepare',requestRevision:1,message:'Explicit synthetic native document component selection',steps:[],completionJson:'',contexts:[{id,bindingDigest:pin.digest,inputJson:'{"format":"markdown"}'}]};
        await value.acceptReceipts(value.receipts().filter(read=>read.status==='ok').map(read=>read.id));const reads=await value.finish(),run={...evidence(),startedAt,completedAt:new Date().toISOString(),purpose:'planning' as const,decisionDigest:digest(decision)};assert(await worker.recordRun(claim,run,'agent_decision'));
        return {decision,reads,run,page};
      }finally{value.close();}
    };
    const prepare=(selected:Awaited<ReturnType<typeof prepareDecision>>)=>t.database.run(client=>preparePostgresGoalContexts(client,claim,selected.decision,selected.run.id,selected.reads,options));
    const executeDecision=async(component:Awaited<ReturnType<typeof prepare>>[number])=>{
      const {value,startedAt}=await session([component.scope]);try{
        const context=await value.call('read_task_context',{});assert.equal(value.lastReceipt()?.status,'ok',JSON.stringify(context));
        const page=await value.call('discover_actions',{actionId:'ComposeDocument',programRef:program.ref}) as typeof sourcePage;assert.equal(value.lastReceipt()?.status,'ok',JSON.stringify(page));
        const object=await value.call('query_ontology',{object:component.scope});assert.equal(value.lastReceipt()?.status,'ok',JSON.stringify(object));
        const pin=page.items[0]!.bindings[0]!.pin,decision:AgentDecision={kind:'execute',requestRevision:1,message:'Explicit synthetic native document invocation',steps:[{id:'compose',action:'ComposeDocument',bindingDigest:pin.digest,contextId:component.id,contributesTo:['document'],argumentsJson:JSON.stringify({scope:component.scope}),dependsOn:[],inputRefs:[]}],completionJson:''};
        await value.acceptReceipts(value.receipts().filter(read=>read.status==='ok').map(read=>read.id));const reads=await value.finish(),run={...evidence(),startedAt,completedAt:new Date().toISOString(),purpose:'planning' as const,decisionDigest:digest(decision)};assert(await worker.recordRun(claim,run,'agent_decision'));
        return {decision,reads,run,page};
      }finally{value.close();}
    };
    const install=(selected:Awaited<ReturnType<typeof executeDecision>>)=>t.database.run(client=>installPostgresAgentPlan(client,claim,selected.decision,selected.run.id,selected.reads,options));
    const stored=()=>t.database.run(client=>new PostgresTaskStorage(client).get(f.owner,claim.job.id));
    const record=async(decision:AgentDecision,startedAt:string)=>{const run={...evidence(),startedAt,completedAt:new Date().toISOString(),purpose:'planning' as const,decisionDigest:digest(decision)};assert(await worker.recordRun(claim,run,'agent_decision'));return run;};
    return {f,t,q,worker,claim,program,goal,task,request,grant,installation,principal,bindingId,channel,options,sourcePage,directory,session,prepareDecision,prepare,executeDecision,install,record,stored,capturedContext:()=>capturedContext,
      close:async()=>{if(timer)clearInterval(timer);if(pending)await pending;await t.close();f.close();assert.equal(failure,undefined);}};
  }catch(error){if(timer)clearInterval(timer);if(pending)await pending;if(target)await target.close();f.close();throw error;}
}
