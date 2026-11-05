import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import type {ActionIntent} from '../packages/ontology/actions.js';
import type {AgentActionPlan,AgentDecision,AgentExecutionState} from '../packages/ontology/agent-actions.js';
import type {ServiceCapability} from '../packages/ontology/execution.js';
import {digest} from '../packages/core/delegation.js';
import {createAgentSandboxGrant} from '../packages/core/agent-authorization.js';
import {domainAtomicMetadata} from '../packages/ontology/domain-composition.js';
import {linkSnapshotDigest} from '../packages/ontology/object-store.js';
import {createGoalCoverage} from '../packages/ontology/goal-coverage.js';
import {graphRead} from '../packages/ontology/graph-program.js';
import {withAuthorization,withProjection} from '../packages/security/context.js';
import {SecurityError} from '../packages/security/errors.js';
import {PostgresActionJournal} from '../packages/postgres/action-journal.js';
import {createPostgresActionAuthorization,type PostgresActionAuthorizationOptions,type PostgresActionProgramPolicy} from '../packages/postgres/action-authorization.js';
import {PostgresNativePlanningSession} from '../packages/postgres/native-planning-session.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {evidence} from './backend-fixture.js';

/** Explicit synthetic program semantics only. This fixture never invokes a
 * hotel provider, a model, or a business executor. Ontology descriptions and
 * object receipts come from the real PostgreSQL planning session. */
async function permitFixture(){
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  let timer:ReturnType<typeof setInterval>|undefined,pending:Promise<void>|undefined,heartbeatFailure:unknown;
  try{
    const model=f.jobs.ontology.model,metadata=domainAtomicMetadata('hotel'),action=metadata.execute,definition=model.action(action);
    assert(definition.operation?.effect==='reserve');assert.equal(definition.operation.environment,'sandbox');
    const programRef={id:'synthetic.hotel-permit',version:'1'},configurationDigest=digest({synthetic:'hotel-permit'}),bindingId='synthetic-hotel-permit-source';
    const scope={type:'HotelRequest',id:randomUUID()},option={type:'HotelOption',id:randomUUID()},input={scope,option};
    const installation=f.installation('Synthetic exact dispatch permit',3600000),expiresAt=new Date(Date.now()+3600000).toISOString();
    const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only');
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[programRef.id],
      resources:['ServiceRequest','HotelRequest','HotelOption','HotelReservation','Provider','SourceReceipt'].map(type=>({type,fields:fields(type)})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},role:'Viewer',executeActions:[action],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel('synthetic:action-permit',{classification:'sensitive',markings:['member_private','personal_data'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:programRef.id,programDigest:configurationDigest,operations:[action],outputTypes:['HotelRequest','HotelOption','HotelReservation','Provider','SourceReceipt'],expiresAt},f.jobs.security.policies.revision());
    const save=f.jobs.save.bind(f.jobs);f.jobs.save=(owner,job)=>{
      job.delegation!.request.executionEnvironment='sandbox';job.delegation!.request.messages=[{id:randomUUID(),text:job.goal,receivedAt:job.createdAt}];
      f.jobs.save=save;return save(owner,job);
    };
    const task=f.task(installation.id),job=task.job,graph=f.jobs.ontologyForJob(f.owner,job),at=new Date().toISOString();
    f.jobs.security.revokeGrant(f.owner,task.grant.id,task.grant.revision);
    const grant=f.jobs.security.issueTaskGrant({...task.grant,id:randomUUID(),inputs:[],operations:['task.process'],
      outputs:['HotelRequest','HotelOption','HotelReservation','Provider','SourceReceipt'].map(type=>({programId:programRef.id,programDigest:configurationDigest,sourceBindingId:bindingId,type,fields:fields(type)}))});
    const authority=f.jobs.security.attachTaskAuthority({...task.authority,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision}});
    const sourceClaim=f.jobs.claim(['eigos.delegate'],30000);assert(sourceClaim);
    const scopeProperties={objectId:scope.id,displayTitle:'Synthetic hotel request'},optionProperties={objectId:option.id,displayTitle:'Synthetic hotel option'};
    const provider={type:'Provider',id:'synthetic-hotel-provider'},receipt={type:'SourceReceipt',id:randomUUID()},root={type:'ServiceRequest',id:job.id};
    const links=[{type:'HotelRequestRequest',from:scope,to:root},{type:'HotelOptionRequest',from:option,to:root},{type:'HotelOptionRequirements',from:option,to:scope},
      {type:'HotelOptionProvider',from:option,to:provider},{type:'HotelOptionEvidence',from:option,to:receipt},{type:'ReceiptRequest',from:receipt,to:root}];
    const subjects=[{object:option,digest:digest(optionProperties),linksDigest:linkSnapshotDigest(option,links)}];
    withAuthorization(f.jobs.security.workerScope(f.owner,job.id,authority.id,sourceClaim.token),()=>{
      graph.read(f.owner,{type:'ServiceRequest',id:job.id});
      withProjection({programId:programRef.id,programDigest:configurationDigest,sourceBindingId:bindingId},()=>graph.ingest(f.owner,
        {objects:[{ref:scope,properties:scopeProperties},{ref:option,properties:optionProperties},{ref:provider,properties:{providerId:provider.id,displayTitle:'Synthetic hotel provider',name:'Synthetic hotel provider'}},
          {ref:receipt,properties:{receiptId:receipt.id,displayTitle:'Synthetic fixture receipt',safeSummary:'Synthetic input evidence only; no booking action',sourceIdentity:provider.id,sourceEventId:'synthetic-permit-input',scope:'domain_hotel',observedAt:at,evidenceLevel:'synthetic',subjects,contentDigest:digest(subjects)}}],links},
        {kind:'synthetic',id:'synthetic-permit-policy-inputs',observedAt:at}));
    });f.jobs.release(sourceClaim);
    const cost={minor:'60',currency:'USD',payeeId:'synthetic-hotel'},operationScope='synthetic-original-hotel-operation';
    const capability:ServiceCapability={ref:programRef,ontologyRef:model.ref,name:'Synthetic permit admission',description:'Policy regression only; no booking provider or model invocation',tags:[],inputSchema:{type:'object'},ontology:{},
      actions:[{ref:{id:action,version:definition.operation.version},effect:'reserve'}],predicates:[],verifierRef:{id:'synthetic',version:'1'},environment:'sandbox'};
    const review={requestRevision:1,verdict:'covered' as const,message:'Explicit synthetic fixture coverage',clauses:job.delegation!.request.messages.map(message=>({messageId:message.id,quote:message.text,disposition:'covered' as const,inputKeys:['scope','option'],requirementIds:[],conditionIds:[],reason:'Synthetic authorization fixture'}))};
    const reviewRun={...evidence(),decisionDigest:digest(review),purpose:'goal_coverage' as const};
    job.delegation!.goalCoverage=createGoalCoverage({request:job.delegation!.request,capability,input},review,reviewRun);job.runs=[reviewRun];
    const state:AgentExecutionState={version:'1',programRef,programDigest:configurationDigest,scope,input,requestRevision:1,plans:[],observations:[],feedback:[]};job.delegation!.agent=state;f.jobs.save(f.owner,job);
    target=await importPostgresFixture(f);const t=target,worker=new PostgresWorkerStore(t.database,t.policy),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);
    timer=setInterval(()=>{if(!pending)pending=worker.renew(claim,30000).then(ok=>{assert(ok);}).catch(error=>{heartbeatFailure=error;}).finally(()=>{pending=undefined;});},5000);timer.unref();
    const session=await PostgresNativePlanningSession.create(worker,claim,t.policy,'synthetic:action-permit',{boundRefs:[scope,option],readScope:'request'});
    try{
      const description=await session.call('describe_ontology',{actions:[action],kind:'actions'});assert.equal(session.lastReceipt()?.status,'ok',JSON.stringify(description));
      for(const ref of [scope,option]){
        const query=await session.call('query_ontology',{object:ref,select:['objectId','displayTitle']});assert.equal(session.lastReceipt()?.status,'ok',JSON.stringify(query));
      }
      await session.acceptReceipts(session.receipts().filter(read=>read.status==='ok').map(read=>read.id));
      const planning=await session.finish();assert(planning.reads.length>=3);
      const selected={id:'reserve',action,argumentsJson:JSON.stringify(input),dependsOn:[],inputRefs:[]},decision:AgentDecision={kind:'execute',requestRevision:1,message:'Synthetic exact permit test',steps:[selected],completionJson:''};
      const run={...evidence(),decisionDigest:digest(decision),purpose:'planning' as const},intentId=randomUUID();
      const body:Omit<AgentActionPlan,'digest'>={id:randomUUID(),version:'2',sequence:1,environment:'sandbox',requestId:job.id,requestRevision:1,programRef,programDigest:configurationDigest,scope,scopeDigest:digest(scopeProperties),
        modelRunId:run.id,modelDecision:decision,reasoning:decision.message,createdAt:at,ontologyPlanning:planning,
        steps:[{...selected,definitionDigest:digest(definition),input,intentId,operationKey:randomUUID(),effect:'reserve',cost,operationScope}]};
      const plan={...body,digest:digest(body)},intent:ActionIntent={id:intentId,owner:f.owner,jobId:job.id,stepId:selected.id,businessOperationKey:plan.steps[0]!.operationKey,planDigest:plan.digest,bindingRef:programRef,inputDigest:digest({input,inputRefs:[]}),privateDigest:digest({}),privateData:{},effect:'reserve',state:'ready',nextAt:0,createdAt:at};
      assert(await worker.checkpoint(claim,current=>{current.delegation!.agent!.plans.push(plan);current.delegation!.agent!.pendingPlanId=plan.id;current.runs=[...(current.runs??[]),run];}));
      const registration:PostgresActionProgramPolicy={program:{ref:programRef,configurationDigest,actionIds:[action],capability:()=>capability,schema:()=>metadata.executeSchema},
        validate:function*(context){
          for(const ref of [scope,option]){const current=yield* graphRead(f.owner,ref);assert.equal(current.ref.id,ref.id);}
          assert.deepEqual(context.input,input);return {privateDigest:digest({}),validUntil:Date.now()+60000,authority:{operationScope,cost}};
        }};
      const options:PostgresActionAuthorizationOptions={policyDigest:t.policy,modelChannel:'synthetic:action-permit',inspectClaim:c=>t.database.inspectClaim(c,t.policy),programs:[registration],allowSandbox:true};
      const journal=(client:Client)=>new PostgresActionJournal(client,{...options,authorize:createPostgresActionAuthorization(client,options)});
      const permit=createAgentSandboxGrant(f.owner,job.id,plan,{planDigest:plan.digest,allowedEffects:['reserve'],maxAmount:{minor:cost.minor,currency:cost.currency},payeeIds:[cost.payeeId],expiresAt});
      return {f,t,claim,journal,intent,input,permit,q:`"${t.schema}"`,close:async()=>{if(timer)clearInterval(timer);if(pending)await pending;await t.close();f.close();assert.equal(heartbeatFailure,undefined);}};
    }finally{session.close();}
  }catch(error){if(timer)clearInterval(timer);if(pending)await pending;if(target)await target.close();f.close();throw error;}
}

test('real PostgreSQL dispatch requires its exact durable permit ID even with the original budget held',{skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
  const x=await permitFixture();try{
    await x.t.run(async client=>{
      await x.journal(client).createIntent(x.claim,x.intent);
      await client.query(`INSERT INTO ${x.q}.plan_grants(id,owner,job_id,body) VALUES($1,$2,$3,$4)`,[x.permit.id,x.f.owner,x.intent.jobId,JSON.stringify(x.permit)]);
      const store=new PostgresTaskStorage(client);await store.save(x.f.owner,await store.get(x.f.owner,x.intent.jobId));
      await x.journal(client).reserveBudget(x.claim,x.intent.id,x.permit,x.permit.maxAmount);
    });
    const held=await x.t.client.query(`SELECT grant_id,minor,currency,state FROM ${x.q}.budget_reservations WHERE owner=$1 AND intent_id=$2`,[x.f.owner,x.intent.id]);
    assert.equal(held.rowCount,1);assert.deepEqual(held.rows[0],{grant_id:x.permit.id,minor:'60',currency:'USD',state:'held'});
    const dispatch=(authorizationId?:string)=>x.t.run(client=>x.journal(client).startAttempt(x.claim,x.intent.id,'dispatch',digest(x.input),undefined,undefined,authorizationId));
    await assert.rejects(dispatch(),error=>error instanceof SecurityError&&error.reason==='AUTHORIZATION_REQUIRED'&&/Exact durable plan permit/.test(error.message));
    await assert.rejects(dispatch(randomUUID()),error=>error instanceof SecurityError&&error.reason==='AUTHORIZATION_REQUIRED');
    assert.equal((await x.t.run(client=>x.journal(client).attempts(x.f.owner,x.intent.id))).length,0);
    assert.equal((await x.t.run(client=>x.journal(client).intent(x.f.owner,x.intent.id))).state,'ready');
    assert.equal((await x.t.client.query(`SELECT state FROM ${x.q}.budget_reservations WHERE intent_id=$1`,[x.intent.id])).rows[0].state,'held');
    const accepted=await dispatch(x.permit.id);assert.equal(accepted.authorizationId,x.permit.id);assert.equal(accepted.claimToken,x.claim.token);assert.equal(accepted.requestKey,x.intent.businessOperationKey);
    const attempts=await x.t.run(client=>x.journal(client).attempts(x.f.owner,x.intent.id));assert.equal(attempts.length,1);assert.equal(attempts[0]!.authorizationId,x.permit.id);
    assert.equal((await x.t.run(client=>x.journal(client).intent(x.f.owner,x.intent.id))).state,'dispatching');
    assert.equal((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations`)).rows[0].n,'0','Dispatch admission does not fabricate a provider result');
  }finally{await x.close();}
});
