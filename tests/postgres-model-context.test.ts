// Real scoped SQL reads and current model authorization; all user text and
// persisted execution fixtures are synthetic. No model/provider is invoked.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {digest} from '../packages/core/delegation.js';
import {initialExecutionBudget} from '../packages/core/execution-budget.js';
import {createGoalContract} from '../packages/core/goal-contract.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {GoalProgram,goalState} from '../packages/coordinator/goal-program.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {initializeDocumentProgram} from '../packages/capabilities/document-program.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {PostgresNativePlanningSession,type PostgresPlanningDiscoveryContext} from '../packages/postgres/native-planning-session.js';
import {postgresGoalReviewContext,postgresAgentPlanningContext,postgresAgentPlanningContextFromDiscoveryContext,type PostgresModelContextOptions,type PostgresModelProgramMetadata} from '../packages/postgres/model-context.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},secret='PRIVATE_PLAN_PROMPT_AND_PROVIDER_TOKEN';
async function fixture(kind:'goal'|'doc'){
  const f=securityFixture(Date.now,{unified:true}),doc=new DocumentAgentProgram(),channel='synthetic:model-context';let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined,timer:ReturnType<typeof setInterval>|undefined,pending:Promise<void>|undefined,failure:unknown;
  try{
    const installation=f.installation('Synthetic model context',3600000),expiresAt=new Date(Date.now()+3600000).toISOString(),bindingId='program:document.compose';
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[doc.ref.id],resources:[...new Set(['ServiceRequest',...Object.keys(taskContextFields),'DocumentTask','DocumentDraft'])].map(type=>({type,fields:Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only')})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'namespace',id:f.jobs.ontology.model.ref.id,version:f.jobs.ontology.model.ref.digest},executeActions:['ComposeDocument'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data','financial','account_private','precise_location'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:['member_private','personal_data','financial','account_private','precise_location'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:doc.ref.id,programDigest:doc.configurationDigest,operations:[...doc.actionIds],outputTypes:['DocumentTask','DocumentDraft'],expiresAt},f.jobs.security.policies.revision());
    const principal={...f.principal,scopes:['tasks:write'],access:f.coordinator.authenticate({...f.principal,scopes:['tasks:write']},installation.token)};
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`,task=await new PostgresTaskCommandService(t.database,t.policy).submit(principal,{requestId:randomUUID(),goal:'Create a Markdown document from supplied information only.'});
    const worker=new PostgresWorkerStore(t.database,t.policy),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);assert.equal(claim.job.id,task.id);
    timer=setInterval(()=>{if(!pending)pending=worker.renew(claim,30000).then(ok=>{assert(ok);}).catch(error=>{failure=error;}).finally(()=>{pending=undefined;});},5000);timer.unref();
    const request=await worker.readRequest(claim,channel);let program:PostgresModelProgramMetadata=doc;
    if(kind==='doc'){
      const result=await worker.project(claim,{modelChannel:channel,programRef:doc.ref,configurationDigest:doc.configurationDigest,sourceBindingId:bindingId},function*({request,job}){const initialized=yield* initializeDocumentProgram(doc,claim.owner,request,{format:'markdown'});job.delegation!.agent={version:'1',programRef:doc.ref,programDigest:doc.configurationDigest,...initialized,requestRevision:request.revision,plans:[],observations:[],feedback:[]};});assert(result.applied);
    }else{
      const goal=createGoalContract(request,claim.job.delegation!.ontologyRelease!,[{id:'document',predicate:'document.markdown',phase:'artifact',description:'Supplied-information document',messageId:request.messages[0]!.id,quote:request.messages[0]!.text,requirementIds:[]}],[doc.capability()]);program=new GoalProgram(goal);
      assert(await worker.checkpoint(claim,job=>{job.delegation!.agent=goalState(request,goal);}));
    }
    const options:PostgresModelContextOptions={policyDigest:t.policy,modelChannel:channel,inspectClaim:ref=>t.database.inspectClaim(ref,t.policy),componentPrograms:[doc]};
    const row=(await t.client.query(`SELECT body FROM ${q}.jobs WHERE id=$1`,[task.id])).rows[0],job=JSON.parse(row.body);
    job.delegation.agent.privatePlans={raw:secret};job.delegation.agent.callerCompletion={privateToken:secret};job.delegation.agent.feedback=[{at:new Date().toISOString(),kind:'runtime',message:secret,inputDigest:digest(secret)}];
    job.delegation.executionBudget=initialExecutionBudget(job.createdAt);job.delegation.executionBudget.window.privateToken=secret;
    await t.client.query(`UPDATE ${q}.jobs SET body=$1 WHERE id=$2`,[JSON.stringify(job),task.id]);
    return {f,t,q,task,claim,worker,program,doc,request,options,installation,job,
      act:()=>t.database.run(c=>postgresAgentPlanningContext(c,claim,program,options)),review:()=>t.database.run(c=>postgresGoalReviewContext(c,claim,program,options)),
      close:async()=>{if(timer)clearInterval(timer);if(pending)await pending;await t.close();f.close();assert.equal(failure,undefined);}};
  }catch(error){if(timer)clearInterval(timer);if(pending)await pending;if(target)await target.close();f.close();throw error;}
}

for(const kind of ['goal','doc'] as const)test(`${kind} model DTO uses current SQL graph inputs and excludes private state and budget fields`,local,async()=>{
  const x=await fixture(kind);try{
    const review=await x.review(),act=await x.act();assert.equal(review.context.request.originalGoal,x.request.originalGoal);assert.deepEqual(review.context.input,kind==='goal'?{}:{format:'markdown'});
    assert.deepEqual(act.context.state.input,review.context.input);assert.deepEqual(act.context.state.plans,[]);assert.deepEqual(act.context.state.feedback,[]);assert.equal(act.context.state.composition,undefined);assert.equal(act.context.state.callerCompletion,undefined);
    assert.equal(act.context.state.programDigest,x.program.configurationDigest);assert.deepEqual(act.context.actionIds,kind==='goal'?[]:['ComposeDocument']);assert(act.maxTurns>0);assert.equal(act.executionBudget.used.modelTurns,0);assert(!JSON.stringify({review,act}).includes(secret));
    const reads=(await x.t.client.query(`SELECT body FROM ${x.q}.security_reads`)).rows.map(row=>JSON.parse(row.body));assert(reads.some(value=>value.submission?.taskId===x.task.id&&value.requiredMarkings.includes('personal_data')));
    await x.t.client.query(`UPDATE ${x.q}.security_model_channels SET body=jsonb_set(body::jsonb,'{expiresAt}',to_jsonb($1::text))::text WHERE id=$2`,[new Date(Date.now()-1).toISOString(),x.options.modelChannel]);
    await assert.rejects(x.review(),/OUTPUT_NOT_ALLOWED/);await assert.rejects(x.act(),/OUTPUT_NOT_ALLOWED/);
  }finally{await x.close();}
});

test('model context reuses a real Native host frame and rejects fake or closed frames',local,async()=>{
  const x=await fixture('doc');let session:PostgresNativePlanningSession|undefined,escaped:PostgresPlanningDiscoveryContext|undefined,view:Awaited<ReturnType<typeof postgresAgentPlanningContextFromDiscoveryContext>>|undefined;
  try{
    assert.throws(()=>postgresAgentPlanningContextFromDiscoveryContext({} as PostgresPlanningDiscoveryContext,x.program),/AUTHORIZATION_REQUIRED/);
    const catalog=new ExecutionCatalog([x.doc.capability()],[],[],[],[x.doc]);
    session=await PostgresNativePlanningSession.create(x.worker,x.claim,x.t.policy,x.options.modelChannel,{taskContext:{purpose:'agent'},actionCatalog:catalog,discoverActions:async(_graph,_owner,_request,_input,scope)=>{escaped=scope;view=await postgresAgentPlanningContextFromDiscoveryContext(scope,x.program);throw new Error('Synthetic stop after the checked context');}});
    await session.call('read_task_context',{});await assert.rejects(session.call('discover_actions',{}),/Synthetic stop after the checked context/);assert(view);assert.deepEqual(view.context.state.input,{format:'markdown'});assert(!JSON.stringify(view).includes(secret));assert(escaped);
    assert.throws(()=>postgresAgentPlanningContextFromDiscoveryContext(escaped!,x.program),/AUTHORIZATION_REQUIRED/);
  }finally{session?.close();await x.close();}
});
