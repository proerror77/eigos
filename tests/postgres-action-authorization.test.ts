import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import type {AgentActionPlan,AgentDecision,AgentExecutionState} from '../packages/ontology/agent-actions.js';
import type {ActionIntent,ActionResult} from '../packages/ontology/actions.js';
import type {ServiceCapability} from '../packages/ontology/execution.js';
import {digest} from '../packages/core/delegation.js';
import {rideEstimateActionSchemas} from '../packages/ontology/ride-estimate.js';
import {SecurityError} from '../packages/security/errors.js';
import {PostgresTaskReadService} from '../packages/postgres/task-read-service.js';
import {documentActionSchema} from '../packages/ontology/document-action.js';
import {createGoalCoverage} from '../packages/ontology/goal-coverage.js';
import {executionStepRef} from '../packages/ontology/execution-projection.js';
import {graphRead} from '../packages/ontology/graph-program.js';
import {withAuthorization,withProjection} from '../packages/security/context.js';
import {PostgresActionJournal} from '../packages/postgres/action-journal.js';
import {createPostgresActionAuthorization,type PostgresActionAuthorizationOptions,type PostgresActionProgramPolicy} from '../packages/postgres/action-authorization.js';
import {PostgresNativePlanningSession} from '../packages/postgres/native-planning-session.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {evidence} from './backend-fixture.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
const policyChanged=(error:unknown)=>error instanceof SecurityError&&error.reason==='POLICY_CHANGED';
async function fixture(dependent=false,readable=false){
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined,timer:ReturnType<typeof setInterval>|undefined,pending:Promise<void>|undefined,heartbeatFailure:unknown;
  try{
    const installation=f.installation('Synthetic action policy owner',3600000),expiry=new Date(Date.now()+3600000).toISOString(),model=f.jobs.ontology.model;
    const action=dependent?'SearchDidiPlaces':'ComposeDocument',effect=dependent?'read' as const:'local' as const,scopeType=dependent?'RideEstimateTask':'DocumentTask',outputType=dependent?'DidiPlaceObservation':'DocumentDraft';
    const programRef={id:'synthetic.document',version:'1'},configurationDigest=digest({synthetic:'document'}),scope={type:scopeType,id:randomUUID()},bindingId='synthetic-document-source';
    const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only');
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[programRef.id],resources:['ServiceRequest',scopeType,outputType,'Place'].map(type=>({type,fields:fields(type)})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt:expiry});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},role:'Viewer',executeActions:[action],expiresAt:expiry},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt:expiry},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel('synthetic:action-policy',{classification:'sensitive',markings:['member_private','personal_data'],expiresAt:expiry},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:programRef.id,programDigest:configurationDigest,operations:[action],outputTypes:[scopeType,outputType],expiresAt:expiry},f.jobs.security.policies.revision());
    const save=f.jobs.save.bind(f.jobs);f.jobs.save=(owner,job)=>{job.delegation!.request.messages=[{id:randomUUID(),text:job.goal,receivedAt:job.createdAt}];f.jobs.save=save;return save(owner,job);};
    const task=f.task(installation.id),job=task.job,graph=f.jobs.ontologyForJob(f.owner,job),at=new Date().toISOString();
    f.jobs.security.revokeGrant(f.owner,task.grant.id,task.grant.revision);
    const grant=f.jobs.security.issueTaskGrant({...task.grant,id:randomUUID(),inputs:[],channels:readable?['agent_response','registered_model']:task.grant.channels,operations:readable?['task.process','task.query','task.result.read']:['task.process'],
      outputs:[scopeType,outputType].map(type=>({programId:programRef.id,programDigest:configurationDigest,sourceBindingId:bindingId,type,fields:fields(type)}))});
    const authority=f.jobs.security.attachTaskAuthority({...task.authority,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision}});
    const original=f.jobs.claim(['eigos.delegate'],30000);assert(original);
    const scopeProperties={id:scope.id,displayTitle:'Synthetic local document',requestRevision:1,input:dependent?{mode:'places',city:'Synthetic City',keywords:'Synthetic Place'}:{format:'markdown'},configurationDigest,allowedActions:[action]};
    withAuthorization(f.jobs.security.workerScope(f.owner,job.id,authority.id,original.token),()=>{
      graph.read(f.owner,{type:'ServiceRequest',id:job.id});
      withProjection({programId:programRef.id,programDigest:configurationDigest,sourceBindingId:bindingId},()=>graph.ingest(f.owner,{objects:[{ref:scope,properties:scopeProperties}],links:[{type:dependent?'RideEstimateTaskRequest':'DocumentTaskRequest',from:scope,to:{type:'ServiceRequest',id:job.id}}]}, {kind:'synthetic',id:'synthetic-document-fixture',observedAt:at}));
    });f.jobs.release(original);
    const capability:ServiceCapability={ref:programRef,ontologyRef:model.ref,name:'Synthetic document',description:'Fixture only; no model/provider invocation',tags:[],inputSchema:{type:'object'},ontology:{},actions:[{ref:{id:action,version:model.action(action).read?.version??model.action(action).operation!.version},effect}],predicates:[],verifierRef:{id:'synthetic',version:'1'},environment:'local'};
    const input:Record<string,unknown>=dependent?{scope,role:'search',keywords:'Synthetic Place'}:{scope},review={requestRevision:1,verdict:'covered' as const,message:'Explicit synthetic coverage',clauses:job.delegation!.request.messages.map(message=>({messageId:message.id,quote:message.text,disposition:'covered' as const,inputKeys:Object.keys(input),requirementIds:[],conditionIds:[],reason:'Synthetic local contract'}))};
    const reviewRun={...evidence(),decisionDigest:digest(review),purpose:'goal_coverage' as const};
    job.delegation!.goalCoverage=createGoalCoverage({request:job.delegation!.request,capability,input},review,reviewRun);job.runs=[reviewRun];
    const state:AgentExecutionState={version:'1',programRef,programDigest:configurationDigest,scope,input,requestRevision:1,plans:[],observations:[],feedback:[]};job.delegation!.agent=state;f.jobs.save(f.owner,job);
    const principal={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
    target=await importPostgresFixture(f);const t=target,worker=new PostgresWorkerStore(t.database,t.policy),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);
    timer=setInterval(()=>{if(!pending)pending=worker.renew(claim,30000).then(ok=>{assert(ok);}).catch(error=>{heartbeatFailure=error;}).finally(()=>{pending=undefined;});},5000);timer.unref();
    const session=await PostgresNativePlanningSession.create(worker,claim,t.policy,'synthetic:action-policy',{boundRefs:[scope],readScope:'request'});
    const description=await session.call('describe_ontology',{actions:[action],kind:'actions'});assert.equal(session.lastReceipt()?.status,'ok',JSON.stringify(description));
    const query=await session.call('query_ontology',{object:scope,select:['id','displayTitle']});assert.equal(session.lastReceipt()?.status,'ok',JSON.stringify(query));
    await session.acceptReceipts(session.receipts().filter(read=>read.status==='ok').map(read=>read.id));
    const planning=await session.finish();session.close();
    const selected={id:'document',action,argumentsJson:JSON.stringify(input),dependsOn:[] as string[],inputRefs:[]},selectedSteps=[selected,...(dependent?[{...selected,id:'dependent-document',dependsOn:[selected.id]}]:[])],decision:AgentDecision={kind:'execute',requestRevision:1,message:'Synthetic local execution',steps:selectedSteps,completionJson:''},run={...evidence(),decisionDigest:digest(decision),purpose:'planning' as const};
    const intentId=randomUUID(),body:Omit<AgentActionPlan,'digest'>={id:randomUUID(),version:'2',sequence:1,requestId:job.id,requestRevision:1,programRef,programDigest:configurationDigest,scope,scopeDigest:digest(scopeProperties),modelRunId:run.id,modelDecision:decision,reasoning:decision.message,createdAt:at,ontologyPlanning:planning,
      steps:selectedSteps.map((selection,index)=>({...selection,definitionDigest:digest(model.action(action)),input,intentId:index===0?intentId:randomUUID(),operationKey:randomUUID(),effect}))};
    const plan={...body,digest:digest(body)},intent:ActionIntent={id:intentId,owner:f.owner,jobId:job.id,stepId:selected.id,businessOperationKey:plan.steps[0]!.operationKey,planDigest:plan.digest,bindingRef:programRef,inputDigest:digest({input,inputRefs:[]}),privateDigest:digest({}),privateData:{},effect,state:'ready',nextAt:0,createdAt:at};
    assert.equal(await worker.checkpoint(claim,current=>{current.delegation!.agent!.plans.push(plan);current.delegation!.agent!.pendingPlanId=plan.id;current.runs=[...(current.runs??[]),run];}),true);
    const registration:PostgresActionProgramPolicy={program:{ref:programRef,configurationDigest,actionIds:[action],capability:()=>capability,schema:()=>dependent?rideEstimateActionSchemas.SearchDidiPlaces:documentActionSchema},
      validate:function*(context){const current=yield* graphRead(f.owner,scope);assert.equal(current.ref.id,scope.id);assert.deepEqual(context.input,input);return {privateDigest:digest({}),validUntil:Date.now()+60000};},
      verifyObservation:function*(_context,_attempt,response,result){assert.deepEqual(response.evidenceRefs,result.evidenceRefs);assert.equal(response.value,'synthetic-provider-value');}};
    const options:PostgresActionAuthorizationOptions={policyDigest:t.policy,modelChannel:'synthetic:action-policy',inspectClaim:c=>t.database.inspectClaim(c,t.policy),programs:[registration]};
    const journal=(client:Client,changes:Partial<PostgresActionAuthorizationOptions>={})=>new PostgresActionJournal(client,{...options,authorize:createPostgresActionAuthorization(client,{...options,...changes})});
    return {f,t,worker,claim,intent,principal,dependentIntent:dependent?{...intent,id:plan.steps[1]!.intentId,stepId:plan.steps[1]!.id,businessOperationKey:plan.steps[1]!.operationKey}:undefined,plan,registration,options,journal,installation,scope,bindingId,q:`"${t.schema}"`,close:async()=>{if(timer)clearInterval(timer);if(pending)await pending;await t.close();f.close();assert.equal(heartbeatFailure,undefined);}};
  }catch(error){if(timer)clearInterval(timer);if(pending)await pending;if(target)await target.close();f.close();throw error;}
}

test('real PostgreSQL action policy admits only a current source, plan, role and verified original response',local,async()=>{
  const x=await fixture();try{
    await x.t.run(c=>x.journal(c).createIntent(x.claim,x.intent));
    const attempt=await x.t.run(c=>x.journal(c).startAttempt(x.claim,x.intent.id,'dispatch',digest(x.plan.steps[0]!.input)));
    const response={value:'synthetic-provider-value',evidenceRefs:['synthetic-provider-event']},result:ActionResult={kind:'confirmed',eventId:attempt.id,sourceVersion:attempt.ordinal,output:{source:response.value},evidenceRefs:response.evidenceRefs};
    const receipt=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,x.intent.id,attempt.id,result));
    await assert.rejects(x.t.run(c=>x.journal(c).commitObservation(x.intent.id,receipt.id,true,{claim:x.claim,apply:async()=>{}})),/SOURCE_NOT_AUTHORIZED/);
    await assert.rejects(x.t.run(c=>x.journal(c,{observation:{attemptId:randomUUID(),response}}).commitObservation(x.intent.id,receipt.id,true,{claim:x.claim,apply:async()=>{}})),/SOURCE_NOT_AUTHORIZED/);
    assert.equal((await x.t.run(c=>x.journal(c,{observation:{attemptId:attempt.id,response}}).commitObservation(x.intent.id,receipt.id,true,{claim:x.claim,apply:async job=>{job.delegation!.events.push({at:new Date().toISOString(),event:'synthetic-provider-mapped'});}}))).applied,true);
  }finally{await x.close();}
});

test('real PostgreSQL action policy fails closed when semantic or provider verification ports are missing',local,async()=>{
  const x=await fixture();try{
    await assert.rejects(x.t.run(c=>x.journal(c,{programs:[{program:x.registration.program}]}).createIntent(x.claim,x.intent)),/semantic proof is not installed/);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.action_intents`)).rows[0].n,0);
    await x.t.run(c=>x.journal(c).createIntent(x.claim,x.intent));const attempt=await x.t.run(c=>x.journal(c).startAttempt(x.claim,x.intent.id,'dispatch',digest(x.plan.steps[0]!.input)));
    const response={value:'synthetic-provider-value',evidenceRefs:['synthetic-provider-event']},result:ActionResult={kind:'confirmed',eventId:attempt.id,sourceVersion:attempt.ordinal,output:{source:response.value},evidenceRefs:response.evidenceRefs};
    const receipt=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,x.intent.id,attempt.id,result));
    await assert.rejects(x.t.run(c=>x.journal(c,{programs:[{program:x.registration.program,validate:x.registration.validate}],observation:{attemptId:attempt.id,response}}).commitObservation(x.intent.id,receipt.id,true,{claim:x.claim,apply:async()=>{}})),/semantic verifier is not installed/);
    assert.equal(Number((await x.t.client.query(`SELECT applied FROM ${x.q}.action_observations WHERE id=$1`,[receipt.id])).rows[0].applied),0);
  }finally{await x.close();}
});

test('real PostgreSQL action policy denies source, exact binding, execution role and model channel revocation',local,async()=>{
  const x=await fixture();try{
    const source=(await x.t.client.query(`SELECT body FROM ${x.q}.security_sources WHERE binding_id=$1`,[x.bindingId])).rows[0].body;
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindingId]);
    await assert.rejects(x.t.run(c=>x.journal(c).createIntent(x.claim,x.intent)),/SOURCE_NOT_AUTHORIZED/);
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='active',body=$1 WHERE binding_id=$2`,[JSON.stringify({...JSON.parse(source),programDigest:'a'.repeat(64)}),x.bindingId]);
    await assert.rejects(x.t.run(c=>x.journal(c).createIntent(x.claim,x.intent)),/SOURCE_NOT_AUTHORIZED/);
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET body=$1 WHERE binding_id=$2`,[source,x.bindingId]);
    const data=(await x.t.client.query(`SELECT id,body FROM ${x.q}.security_grants WHERE kind='task_data' AND state='active'`)).rows[0];
    await x.t.client.query(`UPDATE ${x.q}.security_grants SET body=$1 WHERE id=$2`,[JSON.stringify({...JSON.parse(data.body),outputs:JSON.parse(data.body).outputs.map((output:Record<string,unknown>)=>({...output,sourceBindingId:'another-source-binding'}))}),data.id]);
    await assert.rejects(x.t.run(c=>x.journal(c).createIntent(x.claim,x.intent)),/SOURCE_NOT_AUTHORIZED/);
    await x.t.client.query(`UPDATE ${x.q}.security_grants SET body=$1 WHERE id=$2`,[data.body,data.id]);
    const role=(await x.t.client.query(`SELECT id,body FROM ${x.q}.security_roles WHERE subject_id=$1`,[x.installation.id])).rows[0];
    await x.t.client.query(`UPDATE ${x.q}.security_roles SET body=$1 WHERE id=$2`,[JSON.stringify({...JSON.parse(role.body),executeActions:[]}),role.id]);
    await assert.rejects(x.t.run(c=>x.journal(c).createIntent(x.claim,x.intent)),/ACCESS_REVOKED/);
    await x.t.client.query(`UPDATE ${x.q}.security_roles SET body=$1 WHERE id=$2`,[role.body,role.id]);
    await x.t.client.query(`UPDATE ${x.q}.security_model_channels SET body=$1 WHERE id='synthetic:action-policy'`,[JSON.stringify({classification:'private',markings:[],expiresAt:new Date(Date.now()-1).toISOString()})]);
    await assert.rejects(x.t.run(c=>x.journal(c).createIntent(x.claim,x.intent)),/OUTPUT_NOT_ALLOWED/);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.action_intents`)).rows[0].n,0);
  }finally{await x.close();}
});

test('real PostgreSQL action policy binds dispatch input, original lease and immutable plan identity',local,async()=>{
  const x=await fixture();try{
    await assert.rejects(x.t.run(c=>x.journal(c).createIntent(x.claim,{...x.intent,state:'effect_confirmed',acceptedOutput:{object:x.scope}})),/manufactured result/);
    await assert.rejects(x.t.run(c=>x.journal(c).createIntent(x.claim,{...x.intent,lastVerifiedResult:{kind:'confirmed',eventId:'manufactured',sourceVersion:1,evidenceRefs:[]}})),/manufactured result/);
    await assert.rejects(x.t.run(c=>x.journal(c).createIntent(x.claim,{...x.intent,privateData:{tampered:true}})),policyChanged);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.action_intents`)).rows[0].n,0);
    await assert.rejects(x.t.run(c=>x.journal(c).createIntent(x.claim,{...x.intent,privateDigest:digest({changed:true})})),policyChanged);
    await assert.rejects(x.t.run(c=>x.journal(c).createIntent(x.claim,{...x.intent,inputDigest:digest({changed:true})})),policyChanged);
    await x.t.run(c=>x.journal(c).createIntent(x.claim,x.intent));
    await x.t.client.query(`UPDATE ${x.q}.action_intents SET private_data=$1 WHERE id=$2`,[JSON.stringify({tampered:true}),x.intent.id]);
    await assert.rejects(x.t.run(c=>x.journal(c).startAttempt(x.claim,x.intent.id,'dispatch',digest(x.plan.steps[0]!.input))),policyChanged);
    assert.equal((await x.t.run(c=>x.journal(c).attempts(x.f.owner,x.intent.id))).length,0);
    await x.t.client.query(`UPDATE ${x.q}.action_intents SET private_data=$1 WHERE id=$2`,[JSON.stringify(x.intent.privateData),x.intent.id]);
    await assert.rejects(x.t.run(c=>x.journal(c).startAttempt(x.claim,x.intent.id,'dispatch',digest({changed:true}))),policyChanged);
    await assert.rejects(x.t.run(c=>x.journal(c).startAttempt({...x.claim,token:randomUUID()},x.intent.id,'dispatch',digest(x.plan.steps[0]!.input))),/ACCESS_REVOKED/);
    assert.equal((await x.t.run(c=>x.journal(c).attempts(x.f.owner,x.intent.id))).length,0);
    const current=await x.t.run(c=>new PostgresTaskStorage(c).get(x.f.owner,x.claim.job.id));current.delegation!.agent!.plans[0]!.programDigest='a'.repeat(64);
    await x.t.client.query(`UPDATE ${x.q}.jobs SET body=$1 WHERE id=$2`,[JSON.stringify(current),current.id]);
    await assert.rejects(x.t.run(c=>x.journal(c).startAttempt(x.claim,x.intent.id,'dispatch',digest(x.plan.steps[0]!.input))),/AUTHORIZATION_REQUIRED|POLICY_CHANGED/);
  }finally{await x.close();}
});

test('real PostgreSQL dispatch waits for its exact predecessor and rejects ledger/projection state disagreement',local,async()=>{
  const x=await fixture(true);try{
    assert(x.dependentIntent);
    await x.t.run(c=>x.journal(c).createIntent(x.claim,x.intent));
    await x.t.run(c=>x.journal(c).createIntent(x.claim,x.dependentIntent!));
    await assert.rejects(x.t.run(c=>x.journal(c).startAttempt(x.claim,x.dependentIntent!.id,'dispatch',digest(x.plan.steps[1]!.input))),/predecessor has no confirmed outcome/);
    assert.equal((await x.t.run(c=>x.journal(c).attempts(x.f.owner,x.dependentIntent!.id))).length,0);
    const ref=executionStepRef(x.plan,x.plan.steps[0]!.id),row=(await x.t.client.query(`SELECT body FROM ${x.q}.ontology_objects WHERE owner=$1 AND type=$2 AND id=$3`,[x.f.owner,ref.type,ref.id])).rows[0];
    const body=JSON.parse(row.body);body.properties.state='effect_confirmed';
    await x.t.client.query(`UPDATE ${x.q}.ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[JSON.stringify(body),x.f.owner,ref.type,ref.id]);
    await assert.rejects(x.t.run(c=>x.journal(c).startAttempt(x.claim,x.intent.id,'dispatch',digest(x.plan.steps[0]!.input))),/invocation state differs/);
    assert.equal((await x.t.run(c=>x.journal(c).attempts(x.f.owner,x.intent.id))).length,0);
    await x.t.client.query(`UPDATE ${x.q}.ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[row.body,x.f.owner,ref.type,ref.id]);
    const attempt=await x.t.run(c=>x.journal(c).startAttempt(x.claim,x.intent.id,'dispatch',digest(x.plan.steps[0]!.input)));
    const response={value:'synthetic-provider-value',evidenceRefs:['synthetic-predecessor-event']},result:ActionResult={kind:'confirmed',eventId:attempt.id,sourceVersion:attempt.ordinal,output:{source:response.value},evidenceRefs:response.evidenceRefs};
    const receipt=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,x.intent.id,attempt.id,result));
    assert((await x.t.run(c=>x.journal(c,{observation:{attemptId:attempt.id,response}}).commitObservation(x.intent.id,receipt.id,true,{claim:x.claim,apply:async()=>{}}))).applied);
    assert.equal((await x.t.run(c=>x.journal(c).startAttempt(x.claim,x.dependentIntent!.id,'dispatch',digest(x.plan.steps[1]!.input)))).intentId,x.dependentIntent.id);
  }finally{await x.close();}
});

test('verified action output is sealed with its original acceptance and a seal failure rolls back every transition',local,async()=>{
  const x=await fixture(false,true);try{
    await x.t.run(c=>x.journal(c).createIntent(x.claim,x.intent));
    const attempt=await x.t.run(c=>x.journal(c).startAttempt(x.claim,x.intent.id,'dispatch',digest(x.plan.steps[0]!.input)));
    const response={value:'synthetic-provider-value',evidenceRefs:['synthetic-sealed-output-event']},result:ActionResult={kind:'confirmed',eventId:attempt.id,sourceVersion:attempt.ordinal,output:{source:response.value},evidenceRefs:response.evidenceRefs};
    const receipt=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,x.intent.id,attempt.id,result));
    const accept=()=>x.t.run(c=>x.journal(c,{observation:{attemptId:attempt.id,response}}).commitObservation(x.intent.id,receipt.id,true,{claim:x.claim,apply:async job=>{
      job.state='input-required';job.question='Synthetic source output accepted under original scope';job.delegation!.phase='clarifying';job.updatedAt=new Date().toISOString();
      job.delegation!.events.push({at:new Date().toISOString(),event:'synthetic-output-mapped'});
    }}));
    await x.t.client.query(`CREATE FUNCTION ${x.q}.reject_fixture_seal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic output seal failure'; END $$;
      CREATE TRIGGER reject_fixture_seal BEFORE INSERT OR UPDATE ON ${x.q}.security_outputs FOR EACH ROW EXECUTE FUNCTION ${x.q}.reject_fixture_seal()`);
    await assert.rejects(accept(),/Synthetic output seal failure/);
    const prior=await x.t.run(c=>new PostgresTaskStorage(c).get(x.f.owner,x.claim.job.id));
    assert.equal(prior.state,'working');assert.equal(prior.question,undefined);assert(!prior.delegation!.events.some(event=>event.event==='synthetic-output-mapped'));
    assert.equal(Number((await x.t.client.query(`SELECT applied FROM ${x.q}.action_observations WHERE id=$1`,[receipt.id])).rows[0].applied),0);
    assert.equal((await x.t.run(c=>x.journal(c).intent(x.f.owner,x.intent.id))).state,'dispatching');
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.runtime_work_claims WHERE job_id=$1 AND token=$2`,[x.claim.job.id,x.claim.token])).rows[0].n,1);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.security_outputs WHERE task_id=$1`,[x.claim.job.id])).rows[0].n,0);
    await x.t.client.query(`DROP TRIGGER reject_fixture_seal ON ${x.q}.security_outputs; DROP FUNCTION ${x.q}.reject_fixture_seal()`);
    assert((await accept()).applied);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.runtime_work_claims WHERE job_id=$1 AND token=$2`,[x.claim.job.id,x.claim.token])).rows[0].n,0);
    await x.t.database.cleanupReleasedClaims();
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.work_claims WHERE job_id=$1`,[x.claim.job.id])).rows[0].n,0);
    const view=await new PostgresTaskReadService(x.t.database,x.t.policy).get(x.principal,x.claim.job.id);
    assert.equal(view.id,x.claim.job.id);assert.equal(view.outputStatus,'available');assert.equal(view.question,'Synthetic source output accepted under original scope');
  }finally{await x.close();}
});

test('committed dispatch preflight rechecks original source and authority without creating another attempt',local,async()=>{
  const x=await fixture();try{
    await x.t.run(c=>x.journal(c).createIntent(x.claim,x.intent));
    const attempt=await x.t.run(c=>x.journal(c).startAttempt(x.claim,x.intent.id,'dispatch',digest(x.plan.steps[0]!.input)));
    const before=await x.t.run(c=>x.journal(c).attempts(x.f.owner,x.intent.id));
    await x.t.run(c=>x.journal(c).assertDispatchAllowed(x.claim,x.intent.id,attempt.id));
    await assert.rejects(x.t.run(c=>x.journal(c).assertDispatchAllowed(x.claim,x.intent.id,randomUUID())),/ACCESS_REVOKED/);
    await assert.rejects(x.t.run(c=>x.journal(c).assertDispatchAllowed({...x.claim,token:randomUUID()},x.intent.id,attempt.id)),/ACCESS_REVOKED/);
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindingId]);
    await assert.rejects(x.t.run(c=>x.journal(c).assertDispatchAllowed(x.claim,x.intent.id,attempt.id)),/SOURCE_NOT_AUTHORIZED/);
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='active' WHERE binding_id=$1`,[x.bindingId]);
    await x.t.run(c=>x.journal(c).assertDispatchAllowed(x.claim,x.intent.id,attempt.id));
    assert.deepEqual(await x.t.run(c=>x.journal(c).attempts(x.f.owner,x.intent.id)),before);
    assert.equal((await x.t.run(c=>x.journal(c).intent(x.f.owner,x.intent.id))).state,'dispatching');
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.action_observations`)).rows[0].n,0);
  }finally{await x.close();}
});
