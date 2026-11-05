// Actual PostgreSQL, HTTP MCP/A2A, native Ontology HTTP receipts and registered
// Doc/Goal semantics. Reasoner and document model outputs are explicit synthetic
// fixtures. This suite neither invokes a live LLM nor proves formal cutover.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {digest,goalGroundingSchema,type Grounding} from '../packages/core/delegation.js';
import {DomainError} from '../packages/core/domain.js';
import type {TaskServicePort} from '../packages/core/task-service-port.js';
import {modelUsageRecorder,withModelUsage} from '../packages/core/model-usage-context.js';
import {authorizeModelDispatch,withModelDispatchGuard} from '../packages/core/model-dispatch-context.js';
import type {RunEvidence} from '../packages/capabilities/executor.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {CodexExecutor} from '../packages/capabilities/executor.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {agentDecisionSchema,type AgentDecision} from '../packages/ontology/agent-actions.js';
import {openOntologyMcp} from '../packages/coordinator/ontology-mcp.js';
import type {PlanningAccess} from '../packages/coordinator/coordinator.js';
import {createPostgresWorker,postgresCodexReasoner} from '../apps/worker/postgres-runtime.js';
import type {PostgresExecutor,PostgresReasoner} from '../packages/postgres/coordinator.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresDatabase} from '../packages/postgres/database.js';
import type {Pool} from 'pg';
import {securityFixture} from './fixtures/security.js';
import {importPostgresPrimaryFixture} from './fixtures/postgres-primary.js';
import {postgresGatewayProtocolFixture} from './fixtures/postgres-gateway.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},channel='synthetic:acknowledged-postgres-coordinator';
type Stage='ground'|'review'|'act'|'document';
interface Hooks {beforeDispatch?(stage:Stage,taskId:string):Promise<void>;afterDocumentDispatch?(taskId:string):Promise<void>;partial?:boolean}

test('the default Codex review preserves native mode and uses the acknowledged guarded transport',async t=>{
  const model=new CodexExecutor('must-not-start',1000,{model:'inherited-config',reasoningEffort:'medium',serviceTier:'priority'}),events:string[]=[],id=randomUUID(),at=new Date().toISOString();
  t.mock.method(model,'openStructuredSession',()=>{throw new Error('The unadapted app-server session must not receive a review prompt');});
  t.mock.method(model,'runStructured',async()=>{
    const recorder=modelUsageRecorder();assert(recorder);await recorder.begin(id,'synthetic-known-codex-view',at);await authorizeModelDispatch(model.securityChannelId);events.push('prompt');
    const evidence={id,runtime:'synthetic-known-codex-view',startedAt:at,completedAt:new Date().toISOString(),outputSha256:'explicit-synthetic-review'};
    await recorder.finish(id,evidence,'completed');return {output:{requestRevision:1,verdict:'covered',message:'Explicit synthetic review',clauses:[{messageId:'message',quote:'Write a draft',disposition:'covered',inputKeys:['format'],requirementIds:[],conditionIds:[],reason:'Fixture only'}]},evidence};
  });
  const reasoner=postgresCodexReasoner(model);assert.equal(reasoner.ontologyContextMode,'task');assert.equal(reasoner.securityChannelId,model.securityChannelId);
  try{
    const response=await withModelUsage({begin:async()=>{await Promise.resolve();events.push('begin-ack');},finish:async()=>{await Promise.resolve();events.push('finish-ack');}},()=>withModelDispatchGuard({channelId:model.securityChannelId,authorize:async()=>{assert.deepEqual(events,['begin-ack']);events.push('current-dispatch');}},()=>reasoner.reviewGoal!({request:{id:randomUUID(),revision:1,originalGoal:'Write a draft',requirements:[],messages:[{id:'message',text:'Write a draft',receivedAt:at}]},capability:new DocumentAgentProgram().capability(),input:{format:'markdown'}},new AbortController().signal)));
    assert.equal(response.decision.verdict,'covered');assert.deepEqual(events,['begin-ack','current-dispatch','prompt','finish-ack']);
  }finally{await reasoner.closeTask?.();}
});

test('an unadapted synchronous model port is rejected before any prompt or database work',async()=>{
  let acquired=0,invoked=0;
  const pool={connect:async()=>{acquired++;throw new Error('Must not acquire');},end:async()=>{}} as Pick<Pool,'connect'|'end'>;
  const database=new PostgresDatabase(pool,'eigos_business_model_contract',{id:'synthetic-contract-runtime',revision:1,digest:'a'.repeat(64)});
  const unadapted={securityChannelId:channel,run:async()=>{invoked++;throw new Error('Must not invoke');}} as unknown as PostgresExecutor;
  const reasoner={securityChannelId:channel,ground:async()=>{invoked++;throw new Error('Must not invoke');},plan:async()=>{throw new Error('Must not invoke');}} as unknown as PostgresReasoner;
  try{assert.throws(()=>createPostgresWorker({EIGOS_CODEX_BIN:'must-not-start',EIGOS_EXECUTOR_TIMEOUT_MS:1000,EIGOS_CODEX_MODEL:'inherited-config',EIGOS_CODEX_REASONING_EFFORT:'medium',EIGOS_CODEX_SERVICE_TIER:'priority'},
    {database,policyDigest:'a'.repeat(64),reasoner,executor:unadapted,modelChannel:channel}),/acknowledged usage/);assert.equal(acquired,0);assert.equal(invoked,0);}
  finally{await database.close();}
});

async function fixture(hooks:Hooks={}){
  const f=securityFixture(Date.now,{unified:true}),doc=new DocumentAgentProgram();let target:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>|undefined;
  let protocol:Awaited<ReturnType<typeof postgresGatewayProtocolFixture>>|undefined,runtime:ReturnType<typeof createPostgresWorker>|undefined;
  const stats={models:0,documents:0,documentBegins:0,nativeDecisions:0},errors:string[]=[];
  try{
    const installation=f.installation('Synthetic actual PostgreSQL coordinator',3600000),expiry=new Date(Date.now()+3600000).toISOString(),bindingId='synthetic-coordinator-doc';
    const types=[...new Set(['ServiceRequest','DocumentTask','DocumentDraft','Place',...Object.keys(taskContextFields)])];
    const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only');
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[doc.ref.id],resources:types.map(type=>({type,fields:fields(type)})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt:expiry});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:f.jobs.ontology.model.ref.id,version:f.jobs.ontology.model.ref.digest},role:'Viewer',executeActions:['ComposeDocument'],expiresAt:expiry},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt:expiry},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:['member_private','personal_data'],expiresAt:expiry},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:doc.ref.id,programDigest:doc.configurationDigest,operations:['ComposeDocument'],outputTypes:['DocumentTask','DocumentDraft'],expiresAt:expiry},f.jobs.security.policies.revision());
    const principal={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
    target=await importPostgresPrimaryFixture(f);const t=target,q=`"${t.schema}"`,commands=new PostgresTaskCommandService(t.database,t.policy);
    const port:TaskServicePort=commands;void port;
    protocol=await postgresGatewayProtocolFixture(f,t,commands,installation,[doc],{requestTimeoutMs:180000});
    const acknowledge=async<T>(stage:Stage,taskId:string,signal:AbortSignal,work:()=>Promise<T>)=>{
      const recorder=modelUsageRecorder();assert(recorder);const startedAt=new Date().toISOString(),id=randomUUID(),runtimeName='synthetic-acknowledged-model';
      if(stage==='document')stats.documentBegins++;await recorder.begin(id,runtimeName,startedAt);
      let result:T|undefined,evidence:RunEvidence|undefined;
      try{
        await hooks.beforeDispatch?.(stage,taskId);await authorizeModelDispatch(channel);signal.throwIfAborted();stats.models++;
        result=await work();evidence={id,runtime:runtimeName,startedAt,completedAt:new Date().toISOString(),outputSha256:digest(result)};
        await recorder.finish(id,evidence,'completed');return {value:result,evidence};
      }catch(error){await recorder.finish(id,evidence,signal.aborted?'interrupted':'failed');throw error;}
    };
    const native=async<T>(stage:'ground'|'act',taskId:string,signal:AbortSignal,access:PlanningAccess,schema:object,choose:(call:(name:string,args:Record<string,unknown>)=>Promise<any>)=>Promise<T>)=>{
      const invoked=await acknowledge(stage,taskId,signal,async()=>{
        const mcp=await openOntologyMcp(access.session,signal,undefined,schema,channel),client=new Client({name:'explicit-synthetic-native-model',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(mcp.connection.url),{requestInit:{headers:{Authorization:`Bearer ${mcp.connection.token}`}}});
        try{
          await client.connect(transport,{timeout:180000});
          const call=async(name:string,args:Record<string,unknown>)=>{const response=await client.callTool({name,arguments:args},{timeout:180000});assert(!response.isError,JSON.stringify(response));const result=(response.structuredContent as {result:any}).result;return result.result??result;};
          await call('read_task_context',{});const decision=await choose(call);
          await call('submit_decision',{decisionJson:JSON.stringify(decision),receiptIds:access.session.receipts().filter(read=>read.status==='ok').map(read=>read.id)});
          assert.deepEqual(mcp.result().output,decision);stats.nativeDecisions++;return {decision,receipt:mcp.evidence()};
        }finally{await client.close();await transport.close();await mcp.close();}
      });
      return {decision:invoked.value.decision,evidence:{...invoked.evidence,decisionDigest:digest(invoked.value.decision),ontologyMcp:invoked.value.receipt}};
    };
    const reasoner:PostgresReasoner={postgresModelDispatch:'acknowledged-v1',ontologyContextMode:'task',securityChannelId:channel,
      ground:(request,_catalogue,signal,access)=>native<Grounding>('ground',request.id,signal,access,z.toJSONSchema(goalGroundingSchema),async()=>({kind:'compose',requestRevision:request.revision,message:'Explicit synthetic single-document whole goal',requirementsJson:'[]',conditionsJson:'[]',criteriaJson:JSON.stringify([{id:'draft',predicate:'document.markdown',phase:'artifact',description:'Requested Markdown artifact only',messageId:request.messages[0]!.id,quote:request.messages[0]!.text,requirementIds:[]}])})),
      plan:async()=>{throw new Error('The actual native composed goal must not become a replacement legacy resolution');},
      reviewGoal:async(context,signal)=>{
        const result=await acknowledge('review',context.request.id,signal,async()=>({requestRevision:context.request.revision,verdict:'covered' as const,message:'Independent synthetic fixture review; not a live semantic review',clauses:context.request.messages.map((message,index)=>({messageId:message.id,quote:message.text,disposition:'covered' as const,inputKeys:index?[]:Object.keys(context.input),requirementIds:index?[]:[...context.request.requirements,...(context.request.successCriteria??[])].map(value=>value.id),conditionIds:index?[]:(context.request.conditions??[]).map(value=>value.id),reason:'Explicit supplied-information document fixture'}))}));
        return {decision:result.value,evidence:{...result.evidence,decisionDigest:digest(result.value)}};
      },
      act:(context,signal,access)=>native<AgentDecision>('act',context.request.id,signal,access,z.toJSONSchema(agentDecisionSchema),async call=>{
        const base={requestRevision:context.request.revision,message:'Explicit synthetic choice from actual current receipts',completionJson:'',steps:[]};
        const component=context.preparedContextNavigation?.find(value=>!value.retired);
        if(!component){const page=await call('discover_actions',{actionId:'ComposeDocument',programRef:doc.ref});const pin=page.items[0].bindings[0].pin;return {...base,kind:'prepare',contexts:[{id:'document',bindingDigest:pin.digest,inputJson:'{"format":"markdown"}'}]};}
        const drafts=await call('query_ontology',{type:'DocumentDraft',limit:5});
        if(drafts.items.length){const object=drafts.items[0].ref;return {...base,kind:'complete',completionJson:JSON.stringify({components:[{contextId:component.id,proposalJson:JSON.stringify({document:object})}],criteria:[{id:'draft',contextIds:[hooks.partial?'unproved-component':component.id]}],conditions:[]})};}
        await call('query_ontology',{object:component.scope});const page=await call('discover_actions',{actionId:'ComposeDocument',programRef:doc.ref});
        return {...base,kind:'execute',steps:[{id:'document',action:'ComposeDocument',argumentsJson:JSON.stringify({scope:component.scope}),dependsOn:[],inputRefs:[],bindingDigest:page.items[0].bindings[0].pin.digest,contextId:component.id,contributesTo:['draft']}]};
      }),
    };
    const executor:PostgresExecutor={postgresModelDispatch:'acknowledged-v1',securityChannelId:channel,run:async(job,signal)=>{
      const result=await acknowledge('document',job.id,signal,async()=>{stats.documents++;await hooks.afterDocumentDispatch?.(job.id);return {decision:'complete' as const,message:'Synthetic document model response',artifact:'# Synthetic original document\n\nSupplied fixture information only.'};});return {output:result.value,evidence:result.evidence};
    }};
    runtime=createPostgresWorker({EIGOS_CODEX_BIN:'unused-with-explicit-fixture-ports',EIGOS_EXECUTOR_TIMEOUT_MS:180000,EIGOS_CODEX_MODEL:'inherited-fixture-config',EIGOS_CODEX_REASONING_EFFORT:'medium',EIGOS_CODEX_SERVICE_TIER:'priority',EIGOS_TASK_MAX_MS:86400000},{database:t.database,policyDigest:t.policy,sourceBindingId:bindingId,reasoner,executor,modelChannel:channel,timing:{leaseMs:15000,pollMs:250,timeoutMs:600000}});
    const onError=runtime.coordinator.onError.bind(runtime.coordinator);runtime.coordinator.onError=async(claim,error,signal)=>{errors.push(String(error).slice(0,1000));await onError(claim,error,signal);};
    const state=async(id:string)=>(await t.client.query(`SELECT state FROM ${q}.jobs WHERE id=$1`,[id])).rows[0]?.state as string|undefined;
    const wait=async(check:()=>Promise<boolean>,timeout=600000)=>{const until=Date.now()+timeout;while(!await check()){if(Date.now()>until)throw new Error('Actual PostgreSQL coordinator did not reach its expected durable boundary');await delay(250);}};
    const submit=async(ingress:'mcp'|'a2a',requestId=randomUUID())=>{
      const goal='Produce a Markdown draft from the supplied synthetic information; no external research, order or payment.';
      if(ingress==='mcp')return (await protocol!.job('submit_task',{goal,requestId})).id;
      const response=await protocol!.rpc('SendMessage',{message:{messageId:requestId,role:'ROLE_USER',parts:[{text:goal}]},configuration:{returnImmediately:true}});assert(!response.error,JSON.stringify(response));return response.result.task.id as string;
    };
    return {f,t,q,commands,principal,installation,bindingId,protocol,runtime,stats,errors,state,wait,submit,close:async()=>{await runtime!.close();await protocol!.close();await t.close();f.close();}};
  }catch(error){await runtime?.close();await protocol?.close();if(target)await target.close();f.close();throw error;}
}

test('HTTP MCP and A2A reach the same original SQL task through native compose, real Doc and whole-goal acceptance',local,async()=>{
  const x=await fixture();try{
    const originalIds:string[]=[];
    for(const ingress of ['mcp','a2a'] as const){
      const id=await x.submit(ingress);originalIds.push(id);x.runtime.start();await x.wait(async()=>['completed','paused','failed','rejected'].includes((await x.state(id))??''));assert.equal(await x.state(id),'completed',JSON.stringify({stats:x.stats,errors:x.errors}));
      const mcp=await x.protocol.job('get_task',{taskId:id}),a2a=await x.protocol.rpc('GetTask',{id});assert(!a2a.error,JSON.stringify(a2a));
      assert.equal(mcp.id,id);assert.equal('accepted'in mcp?mcp.accepted:undefined,true);assert.equal('outputStatus'in mcp?mcp.outputStatus:undefined,'available');assert.equal(a2a.result.id,id);assert.equal(a2a.result.status.state,'TASK_STATE_COMPLETED');assert(JSON.stringify(mcp.artifact).includes('# Synthetic original document'));
      const sameArtifact=a2a.result.artifacts?.find((artifact:{artifactId:string})=>artifact.artifactId===mcp.artifact?.id);
      assert(sameArtifact&&JSON.stringify(sameArtifact.parts).includes('# Synthetic original document'),'A2A must deliver the same sealed artifact id and actual document body');
      assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.jobs WHERE id=$1`,[id])).rows[0].n,1);
      const row=(await x.t.client.query(`SELECT ${x.q}.eigos_try_jsonb(body) AS body FROM ${x.q}.jobs WHERE id=$1`,[id])).rows[0].body;
      assert.equal(row.delegation.groundingDecisions[0].decision.kind,'compose');assert.equal(row.delegation.agent.composition.assessment.accepted,true);assert.equal(row.delegation.outcome.status,'satisfied');assert.equal(row.delegation.agent.plans[0].version,'3');
    }
    assert.equal(x.stats.documents,2);assert(x.stats.nativeDecisions>=8);
    assert.deepEqual((await x.t.client.query(`SELECT id FROM ${x.q}.jobs ORDER BY id`)).rows.map(row=>row.id),originalIds.sort(),'both protocols must preserve exactly the two original tasks');
  }finally{await x.close();}
});

test('parent, action role, source and model revocation cannot produce a completed original goal',local,async t=>{
  for(const revoked of ['parent','role','source','model'] as const)await t.test(revoked,async()=>{
    let changed=false;let x:Awaited<ReturnType<typeof fixture>>;
    x=await fixture({beforeDispatch:async()=>{if(changed)return;changed=true;
      if(revoked==='parent')await x.t.client.query(`UPDATE ${x.q}.security_grants SET state='revoked' WHERE kind='agent_access'`);
      if(revoked==='role')await x.t.client.query(`UPDATE ${x.q}.security_roles SET body=jsonb_set(body::jsonb,'{executeActions}','[]'::jsonb)::text`);
      if(revoked==='source')await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindingId]);
      if(revoked==='model')await x.t.client.query(`UPDATE ${x.q}.security_model_channels SET body=jsonb_set(body::jsonb,'{expiresAt}',to_jsonb($1::text))::text WHERE id=$2`,[new Date(Date.now()-1).toISOString(),channel]);
    }});
    try{const id=await x.submit('mcp');x.runtime.start();await x.wait(async()=>revoked==='parent'?changed:await x.state(id)==='paused');await x.runtime.pause();assert.notEqual(await x.state(id),'completed');assert.equal(x.stats.documents,0);assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.jobs`)).rows[0].n,1);}finally{await x.close();}
  });
});

test('canceling the original task retains late model accounting and publishes no document or replacement task',local,async()=>{
  let x:Awaited<ReturnType<typeof fixture>>;x=await fixture({afterDocumentDispatch:async id=>{await x.commands.cancel(x.principal,id);}});
  try{
    const id=await x.submit('a2a');x.runtime.start();await x.wait(async()=>await x.state(id)==='canceled');await x.runtime.pause();
    assert.equal(x.stats.documents,1);assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.ontology_objects WHERE type='DocumentDraft'`)).rows[0].n,0);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.jobs`)).rows[0].n,1);assert((await x.t.client.query(`SELECT state FROM ${x.q}.member_model_usage WHERE job_id=$1`,[id])).rows.some(row=>row.state==='completed'));
  }finally{await x.close();}
});

test('an incomplete whole-goal assessment preserves the verified document without claiming completion',local,async()=>{
  const x=await fixture({partial:true});try{
    const id=await x.submit('mcp');x.runtime.start();await x.wait(async()=>{const row=(await x.t.client.query(`SELECT ${x.q}.eigos_try_jsonb(body)#>'{delegation,agent,composition,assessment}' AS assessment FROM ${x.q}.jobs WHERE id=$1`,[id])).rows[0];return row?.assessment?.accepted===false;});
    await x.runtime.pause();const current=await x.protocol.job('get_task',{taskId:id});assert.notEqual(current.state,'completed');assert.notEqual('accepted'in current?current.accepted:undefined,true);assert.equal(current.artifact!.data.execution,'partial');assert.equal(x.stats.documents,1);
  }finally{await x.close();}
});

test('an unknown original document invocation is paused without automatic replay',local,async t=>{
  const logs:unknown[][]=[];t.mock.method(console,'error',(...args:unknown[])=>{logs.push(args);});
  for(const error of [new Error('Explicit synthetic lost model result'),new DomainError('CONFLICT','SYNTHETIC_PRIVATE_REJECTION')]){
    const start=logs.length,x=await fixture({afterDocumentDispatch:async()=>{throw error;}});try{
      const id=await x.submit('mcp');x.runtime.start();await x.wait(async()=>await x.state(id)==='paused');await delay(600);await x.runtime.pause();assert.equal(x.stats.documentBegins,1);assert.equal(x.stats.documents,1);
      const intents=(await x.t.client.query(`SELECT state FROM ${x.q}.action_intents WHERE job_id=$1`,[id])).rows;assert(intents.some(row=>['dispatching','effect_unknown','needs_review'].includes(row.state)));assert.notEqual(await x.state(id),'completed');
      const diagnostics=logs.slice(start).filter(args=>args[0]==='Worker execution rejected; original task retained');
      assert.deepEqual(diagnostics,error instanceof DomainError?[[ 'Worker execution rejected; original task retained',{event:'worker_execution_rejected',taskId:id,reason:'CONFLICT'}]]:[]);
      const job=(await x.t.client.query(`SELECT body FROM ${x.q}.jobs WHERE id=$1`,[id])).rows[0].body;
      assert(!JSON.stringify({logs,job}).includes('SYNTHETIC_PRIVATE'));assert(!String(job).includes('worker_execution_rejected'));
    }finally{await x.close();}
  }
});
