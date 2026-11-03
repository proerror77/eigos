// Real PostgreSQL authority, planning receipts, queue, journal and source
// projection. The executor below is explicitly synthetic, not a live LLM.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {digest} from '../packages/core/delegation.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {createGoalCoverage} from '../packages/ontology/goal-coverage.js';
import type {AgentActionPlan,AgentDecision,AgentExecutionState} from '../packages/ontology/agent-actions.js';
import type {ActionIntent} from '../packages/ontology/actions.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {createGoalContract} from '../packages/core/goal-contract.js';
import {goalState} from '../packages/coordinator/goal-program.js';
import {OntologyObjectStore} from '../packages/ontology/object-store.js';
import {templatePlanning} from '../packages/ontology/planning-contract.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {initializeDocumentProgram} from '../packages/capabilities/document-program.js';
import type {Executor,ExecutionResult} from '../packages/capabilities/executor.js';
import {modelUsageRecorder} from '../packages/core/model-usage-context.js';
import {authorizeModelDispatch} from '../packages/core/model-dispatch-context.js';
import {graphRead} from '../packages/ontology/graph-program.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {PostgresDocumentExecution} from '../packages/postgres/document-execution.js';
import {PostgresNativePlanningSession} from '../packages/postgres/native-planning-session.js';
import {PostgresActionJournal} from '../packages/postgres/action-journal.js';
import {createPostgresActionAuthorization} from '../packages/postgres/action-authorization.js';
import {createPostgresDocumentPolicy} from '../packages/postgres/document-policy.js';
import {PostgresTaskReadService} from '../packages/postgres/task-read-service.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {evidence} from './backend-fixture.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},channel='synthetic:document-execution';
async function fixture(composed=false){
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined,timer:ReturnType<typeof setInterval>|undefined,heartbeat:Promise<void>|undefined,failure:unknown;
  try{
    const program=new DocumentAgentProgram(),installation=f.installation('Synthetic document execution',3600000),expiry=new Date(Date.now()+3600000).toISOString(),bindingId='synthetic-document-execution-source';
    const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only'),types=['ServiceRequest','DocumentTask','DocumentDraft','Place',...Object.keys(taskContextFields)];
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[program.ref.id],resources:types.map(type=>({type,fields:fields(type)})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt:expiry});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'namespace',id:f.jobs.ontology.model.ref.id,version:f.jobs.ontology.model.ref.digest},executeActions:['ComposeDocument'],expiresAt:expiry},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt:expiry},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:['member_private','personal_data'],expiresAt:expiry},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:['ComposeDocument'],outputTypes:['DocumentTask','DocumentDraft'],expiresAt:expiry},f.jobs.security.policies.revision());
    const save=f.jobs.save.bind(f.jobs);f.jobs.save=(owner,job)=>{job.goal='Produce a Markdown draft from supplied information';job.delegation!.request.originalGoal=job.goal;job.delegation!.request.messages=[{id:randomUUID(),text:job.goal,receivedAt:job.createdAt}];f.jobs.save=save;return save(owner,job);};
    const original=f.task(installation.id);f.jobs.security.revokeGrant(f.owner,original.grant.id,original.grant.revision);
    const grant=f.jobs.security.issueTaskGrant({...original.grant,id:randomUUID(),operations:['task.process','task.query','task.result.read'],channels:['agent_response','registered_model'],outputs:['DocumentTask','DocumentDraft'].map(type=>({type,fields:fields(type),programId:program.ref.id,programDigest:program.configurationDigest,sourceBindingId:bindingId}))});
    f.jobs.security.attachTaskAuthority({...original.authority,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision}});
    const principal={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
    // Fixture-only binding discovery uses the real source catalog before import.
    // No SQLite reader remains once the PostgreSQL execution begins.
    const sourceDb=new DatabaseSync(f.database);let pin:ReturnType<ExecutionCatalog['discoverActions']>['items'][number]['bindings'][number]['pin']|undefined;
    try{if(composed){const release=f.jobs.definitions.active(),sourceGraph=new OntologyObjectStore(sourceDb,release.model,Date.now,undefined,{ontologyId:release.ref.ontologyId,releaseRef:release.ref,skipLegacyMigration:true},false),catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]);pin=catalog.discoverActions(sourceGraph,f.owner,original.job.delegation!.request,{actionId:'ComposeDocument',programRef:program.ref}).items[0]!.bindings[0]!.pin;}}finally{sourceDb.close();}
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`,worker=new PostgresWorkerStore(t.database,t.policy),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);
    timer=setInterval(()=>{if(!heartbeat)heartbeat=worker.renew(claim,30000).then(ok=>{assert(ok);}).catch(error=>{failure=error;}).finally(()=>{heartbeat=undefined;});},5000);timer.unref();
    const options={modelChannel:channel,programRef:program.ref,configurationDigest:program.configurationDigest,sourceBindingId:bindingId,action:'ComposeDocument'};
    const scope=await worker.project(claim,options,function*({graph,job,request}){
      const initialized=yield* initializeDocumentProgram(program,f.owner,request,{format:'markdown'},composed?{id:'document',scopeKey:digest({request:request.id,component:'document'})}:undefined),input=initialized.input;
      let state:AgentExecutionState={version:'1',programRef:program.ref,programDigest:program.configurationDigest,scope:initialized.scope,input,requestRevision:request.revision,plans:[],observations:[],feedback:[]};
      if(composed){assert(pin);const message=request.messages[0]!,goal=createGoalContract(request,graph.releaseRef!,[{id:'draft',predicate:'document.markdown',phase:'artifact',description:'Explicit synthetic document component',messageId:message.id,quote:message.text,requirementIds:[]}],[program.capability()]);state=goalState(request,goal);
        const setup:AgentDecision={kind:'prepare',requestRevision:request.revision,message:'Explicit synthetic component setup',steps:[],completionJson:'',contexts:[{id:'document',bindingDigest:pin.digest,inputJson:'{\"format\":\"markdown\"}'}]},setupRun={...evidence(),decisionDigest:digest(setup),purpose:'planning' as const};
        const body={id:'document',programRef:program.ref,programDigest:program.configurationDigest,requestRevision:request.revision,...initialized,initializedBy:{modelRunId:setupRun.id,binding:pin,decision:setup,ontologyPlanning:templatePlanning(request,graph.model.ref)}};state.composition!.contexts.push({...body,digest:digest(body)});job.runs=[...(job.runs??[]),setupRun];}
      job.delegation!.agent=state;
      const review={requestRevision:request.revision,verdict:'covered' as const,message:'Explicit synthetic document coverage',clauses:request.messages.map(message=>({messageId:message.id,quote:message.text,disposition:'covered' as const,inputKeys:['format'],requirementIds:[],conditionIds:[],reason:'The supplied request asks for a local Markdown document'}))},run={...evidence(),decisionDigest:digest(review),purpose:'goal_coverage' as const};
      job.delegation!.goalCoverage=createGoalCoverage({request,capability:program.capability(),input},review,run);job.runs=[...(job.runs??[]),run];return initialized.scope;
    });assert(scope.applied);
    const session=await PostgresNativePlanningSession.create(worker,claim,t.policy,channel,{boundRefs:[scope.value],readScope:'request'});
    try{
      const description=await session.call('describe_ontology',{actions:['ComposeDocument'],kind:'actions'});assert.equal(session.lastReceipt()?.status,'ok',JSON.stringify(description));
      const selected=await session.call('query_ontology',{object:scope.value,select:['id','displayTitle']});assert.equal(session.lastReceipt()?.status,'ok',JSON.stringify(selected));
      await session.acceptReceipts(session.receipts().filter(read=>read.status==='ok').map(read=>read.id));
      const planning=await session.finish(),input={scope:scope.value},selection={id:'document',action:'ComposeDocument',argumentsJson:JSON.stringify(input),dependsOn:[] as string[],inputRefs:[],...(composed?{bindingDigest:pin!.digest,contextId:'document',contributesTo:['draft']}:{})},decision:AgentDecision={kind:'execute',requestRevision:1,message:'Explicit synthetic document selection',steps:[selection],completionJson:''},run={...evidence(),decisionDigest:digest(decision),purpose:'planning' as const};
      const intentId=randomUUID();let plan:AgentActionPlan|undefined;
      assert((await worker.project(claim,options,function*({graph,job,request}){
        const properties=(yield* graphRead(f.owner,scope.value)).properties,component=job.delegation!.agent!.composition?.contexts.find(value=>value.id==='document'),body:Omit<AgentActionPlan,'digest'>={id:randomUUID(),version:'2',sequence:1,requestId:job.id,requestRevision:request.revision,programRef:job.delegation!.agent!.programRef,programDigest:job.delegation!.agent!.programDigest,scope:job.delegation!.agent!.scope,scopeDigest:composed?digest(request):digest(properties),modelRunId:run.id,modelDecision:decision,reasoning:decision.message,createdAt:new Date().toISOString(),ontologyPlanning:planning,steps:[{...selection,...(component?{binding:pin!,contextDigest:component.digest,contextScope:component.scope,scopeDigest:digest(properties)}:{}),definitionDigest:digest(graph.model.action('ComposeDocument')),input,intentId,operationKey:randomUUID(),effect:'local'}]};
        plan={...body,digest:digest(body)};job.delegation!.agent!.plans.push(plan);job.delegation!.agent!.pendingPlanId=plan.id;job.runs=[...(job.runs??[]),run];
      })).applied);assert(plan);
      const originalPlan:AgentActionPlan=plan,step=originalPlan.steps[0]!,intent:ActionIntent={id:intentId,owner:f.owner,jobId:claim.job.id,stepId:selection.id,businessOperationKey:step.operationKey,planDigest:originalPlan.digest,bindingRef:step.binding?.ref??program.ref,inputDigest:digest({input,inputRefs:[]}),privateDigest:digest({}),privateData:{},effect:'local',state:'ready',nextAt:0,createdAt:originalPlan.createdAt};
      const authorization={policyDigest:t.policy,modelChannel:channel,inspectClaim:(value:Parameters<typeof t.database.inspectClaim>[0])=>t.database.inspectClaim(value,t.policy),programs:[createPostgresDocumentPolicy()]};
      await t.database.run(c=>new PostgresActionJournal(c,{...authorization,authorize:createPostgresActionAuthorization(c,authorization)}).createIntent(claim,intent));
      let calls=0,runs=0,activeTransactions=0,prompt:Parameters<Executor['run']>[0]|undefined,beforeDispatch:()=>Promise<void>=async()=>{},afterDispatch:()=>Promise<void>=async()=>{};
      const database={inspectClaim:t.database.inspectClaim.bind(t.database),run:<T>(action:Parameters<typeof t.database.run<T>>[0])=>t.database.run(async client=>{activeTransactions++;try{return await action(client);}finally{activeTransactions--;}})};
      const executor:Executor&{securityChannelId:string}={securityChannelId:channel,run:async(job,signal)=>{
        runs++;assert.equal(activeTransactions,0,'model call must be outside the document business transaction');const recorder=modelUsageRecorder();assert(recorder);const run=evidence();await recorder.begin(run.id,run.runtime,run.startedAt);let receipt:ExecutionResult['evidence']|undefined,outcome:'completed'|'failed'|'interrupted'='failed';
        try{await beforeDispatch();await authorizeModelDispatch(channel);signal.throwIfAborted();calls++;prompt=job;await afterDispatch();receipt={...run,completedAt:new Date().toISOString()};outcome='completed';return {output:{decision:'complete',message:'Synthetic document produced',artifact:'# Supplied information\n\nThis is an explicit synthetic executor output.'},evidence:receipt};}
        finally{await recorder.finish(run.id,receipt??{...run,completedAt:new Date().toISOString()},signal.aborted?'interrupted':outcome);}
      }};
      const execution=new PostgresDocumentExecution({database,store:worker,executor,modelChannel:channel,policyDigest:t.policy,sourceBindingId:bindingId});
      const status=()=>t.run(async client=>({job:await new PostgresTaskStorage(client).get(f.owner,claim.job.id),intent:await new PostgresTaskStorage(client).intent(f.owner,intentId),drafts:(await client.query(`SELECT id FROM ${q}.ontology_objects WHERE owner=$1 AND type='DocumentDraft'`,[f.owner])).rows,observations:(await client.query(`SELECT applied,body FROM ${q}.action_observations WHERE owner=$1 AND intent_id=$2`,[f.owner,intentId])).rows,usage:(await client.query(`SELECT state,body FROM ${q}.member_model_usage WHERE owner=$1 AND job_id=$2`,[f.owner,claim.job.id])).rows}));
      const pauseHeartbeat=async()=>{if(timer)clearInterval(timer);if(heartbeat)await heartbeat;};
      return {f,t,q,worker,claim,intent,principal,installation,bindingId,execution,program,plan:originalPlan,status,calls:()=>calls,runs:()=>runs,prompt:()=>prompt,beforeDispatch:(action:()=>Promise<void>)=>{beforeDispatch=action;},afterDispatch:(action:()=>Promise<void>)=>{afterDispatch=action;},pauseHeartbeat,close:async()=>{await pauseHeartbeat();await t.close();f.close();assert.equal(failure,undefined);}};
    }finally{session.close();}
  }catch(error){if(timer)clearInterval(timer);if(heartbeat)await heartbeat;if(target)await target.close();f.close();throw error;}
}

test('real PostgreSQL document execution preserves original dispatch, durable model receipt and authorized draft without completing the task',local,async()=>{
  const x=await fixture();try{
    const accepted=await x.execution.execute(x.claim,x.intent.id,new AbortController().signal);assert(accepted.applied);assert.equal(x.calls(),1);assert.equal(x.runs(),1);assert.equal(x.prompt()!.id,x.claim.job.id);
    const current=await x.status();assert.equal(current.job.state,'working');assert.equal(current.job.delegation!.acceptance,undefined);assert.equal(current.intent.state,'effect_confirmed');assert.deepEqual(current.intent.acceptedOutput?.object,accepted.object);assert(current.job.delegation!.agent!.observations.some(value=>digest(value)===digest(accepted.object)));
    const modelRun=current.job.runs!.find(run=>run.purpose==='document');assert(modelRun);assert.equal(current.usage.find(row=>JSON.parse(row.body).id===modelRun.id)?.state,'completed');assert.equal(Number(current.observations[0]!.applied),1);
    const read=new PostgresTaskReadService(x.t.database,x.t.policy);try{const result=await read.queryOntology(x.principal,{version:2,taskId:x.claim.job.id,query:{object:accepted.object}});assert.equal((result.items[0]!.properties.snapshot as {markdown:string}).markdown,'# Supplied information\n\nThis is an explicit synthetic executor output.');}finally{await read.close();}
    await assert.rejects(x.execution.execute(x.claim,x.intent.id,new AbortController().signal),/automatic replay/);assert.equal(x.calls(),1);
  }finally{await x.close();}
});

test('document pre-spawn guard rejects current source revocation after usage reservation',local,async()=>{
  const x=await fixture();try{
    x.beforeDispatch(async()=>{await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindingId]);});
    await assert.rejects(x.execution.execute(x.claim,x.intent.id,new AbortController().signal),/SOURCE_NOT_AUTHORIZED/);
    const current=await x.status();assert.equal(x.calls(),0);assert.equal(current.intent.state,'dispatching');assert.equal(current.drafts.length,0);assert.equal(Number(current.observations[0]!.applied),0);assert.equal(JSON.parse(current.observations[0]!.body).kind,'unknown');assert(current.usage.some(row=>row.state==='failed'));
  }finally{await x.close();}
});

test('late document response retains accounting and original audit after actual task cancellation',local,async()=>{
  const x=await fixture();try{
    x.afterDispatch(async()=>{await x.pauseHeartbeat();const service=new PostgresTaskCommandService(x.t.database,x.t.policy);try{await service.cancel(x.principal,x.claim.job.id);}finally{await service.close();}});
    await assert.rejects(x.execution.execute(x.claim,x.intent.id,new AbortController().signal),/ACCESS_REVOKED|POLICY_CHANGED/);
    const current=await x.status();assert.equal(x.calls(),1);assert.equal(current.job.state,'canceled');assert.equal(current.drafts.length,0);assert.equal(Number(current.observations[0]!.applied),0);assert(current.usage.some(row=>row.state==='completed'));assert(!current.job.runs?.some(run=>run.purpose==='document'));
  }finally{await x.close();}
});

test('document mapper failure rolls back accepted source projection and prevents model replay',local,async()=>{
  const x=await fixture();try{
    await x.t.client.query(`CREATE FUNCTION ${x.q}.reject_document_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='DocumentDraft' THEN RAISE EXCEPTION 'Synthetic document mapper rejection'; END IF; RETURN NEW; END $$;CREATE TRIGGER reject_document_fixture BEFORE INSERT OR UPDATE ON ${x.q}.ontology_objects FOR EACH ROW EXECUTE FUNCTION ${x.q}.reject_document_fixture()`);
    await assert.rejects(x.execution.execute(x.claim,x.intent.id,new AbortController().signal),/Synthetic document mapper rejection/);
    const current=await x.status();assert.equal(x.calls(),1);assert.equal(current.intent.state,'dispatching');assert.equal(current.drafts.length,0);assert.equal(Number(current.observations[0]!.applied),0);assert.equal(JSON.parse(current.observations[0]!.body).kind,'confirmed');assert(current.job.runs!.some(run=>run.purpose==='document'));
    await assert.rejects(x.execution.execute(x.claim,x.intent.id,new AbortController().signal),/automatic replay/);assert.equal(x.calls(),1);
  }finally{await x.close();}
});

 test('real PostgreSQL document component seals typed model-origin ports in the same accepted observation',local,async()=>{
  const x=await fixture(true);try{const accepted=await x.execution.execute(x.claim,x.intent.id,new AbortController().signal);assert(accepted.applied);const current=await x.status();assert.equal(current.job.state,'working');const ports=current.intent.acceptedOutput?.ports as {port:string;intentId:string;observationId:string;evidence:{origin:string};objects:{ref:unknown}[]}[];assert.equal(ports.length,1);assert.equal(ports[0]!.port,'result');assert.equal(ports[0]!.intentId,x.intent.id);assert.equal(ports[0]!.observationId,accepted.observationId);assert.equal(ports[0]!.evidence.origin,'model');assert.deepEqual(ports[0]!.objects[0]!.ref,accepted.object);assert.equal(x.calls(),1);}finally{await x.close();}
});
