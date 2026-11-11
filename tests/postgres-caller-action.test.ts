import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {graphManagedDispatchCheck,graphApplyManaged,runGraphProgram,runGraphProgramAsync,type GraphStorage,type SyncGraphStorage,type GraphProgram} from '../packages/ontology/graph-program.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {DynamicOntologyProgram} from '../packages/capabilities/dynamic-ontology.js';
import {personalActionIds,selfPersonRef,personalPreferenceRef} from '../packages/ontology/personal-context.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {PostgresCallerActionExecution} from '../packages/postgres/caller-action.js';
import {PostgresReadProgramRegistry} from '../packages/postgres/didi-registry.js';
import {postgresWorkerLane,postgresWorkerReservation} from '../packages/postgres/worker-capacity.js';
import {postgresTaskProcessingGrant} from '../packages/postgres/task-read-access.js';
import {readPostgresObservationContract} from '../packages/postgres/observation-contract.js';
import type {TaskServicePort} from '../packages/core/task-service-port.js';
const taskPort=(service:PostgresTaskCommandService):TaskServicePort=>service;void taskPort;

const invocation={requestId:'synthetic-request',planId:'synthetic-plan',intentId:'synthetic-intent',attemptId:'synthetic-attempt'};
function* dispatch():GraphProgram<void>{yield* graphManagedDispatchCheck('synthetic-owner',invocation);yield* graphApplyManaged('synthetic-owner',{objects:[]},{kind:'user',id:invocation.intentId,observedAt:new Date(0).toISOString()});}
const unsupported=():never=>{throw new Error('Unexpected synthetic storage operation');};
function unusedStorage():SyncGraphStorage{return {read:unsupported,readPrivate:unsupported,query:unsupported,related:unsupported,ingest:unsupported,containsLinks:unsupported,relationshipDigest:unsupported,evidencePropertiesDigest:unsupported,tombstone:unsupported};}

test('managed dispatch operation awaits the original host fence and propagates denial before writing',async()=>{
  // This fake storage verifies scheduling only. It is never a production
  // policy, semantic proof, model receipt or provider acceptance.
  const order:string[]=[],graph:GraphStorage={...unusedStorage(),managedDispatchCheck:async(owner,actual)=>{assert.equal(owner,'synthetic-owner');assert.deepEqual(actual,invocation);order.push('guard-enter');await Promise.resolve();order.push('guard-ack');},applyManaged:()=>{order.push('write');}};
  await runGraphProgramAsync(graph,dispatch());assert.deepEqual(order,['guard-enter','guard-ack','write']);
  graph.managedDispatchCheck=async()=>{throw new Error('synthetic original claim rejected');};order.length=0;
  await assert.rejects(runGraphProgramAsync(graph,dispatch()),/original claim rejected/);assert.deepEqual(order,[]);
  delete graph.managedDispatchCheck;await assert.rejects(runGraphProgramAsync(graph,dispatch()),/dispatch authority is unavailable/);assert.deepEqual(order,[]);
});

test('synchronous managed wrapper cannot silently accept an asynchronous dispatch fence',()=>{
  let wrote=false;const graph={...unusedStorage(),managedDispatchCheck:async()=>{},applyManaged:()=>{wrote=true;}};
  assert.throws(()=>runGraphProgram(graph,dispatch()),/Synchronous graph program received asynchronous storage/);assert.equal(wrote,false);
});

test('PostgreSQL caller preparation, exact approval and actual managed readback retain one task with no model channel',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const ontology=f.jobs.ontology,program=new DynamicOntologyProgram(ontology.model,ontology.releaseRef!,f.owner),policy=f.jobs.security.policies;
    const until=new Date(Date.now()+3600000).toISOString(),sourceBindingId=`program:${program.ref.id}`,installation=f.installation('Synthetic non-model caller',3600000);
    const resources=[...new Set(['ServiceRequest','Person','PersonalPreference','SavedAddress',...Object.keys(taskContextFields)])].map(type=>({type,fields:Object.keys(policy.fields(type)).filter(field=>policy.fieldPolicy(type,field)!=='internal_only')}));
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[program.ref.id],resources,sourceBindingIds:[sourceBindingId],channels:['agent_response'],expiresAt:until});
    policy.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:ontology.model.ref.id,version:ontology.model.ref.digest},role:'Viewer',executeActions:[...personalActionIds],invokeFunctions:ontology.model.functionIds(),expiresAt:until},policy.revision());
    policy.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data','precise_location','financial','health','account_private'],channels:['agent_response'],expiresAt:until},policy.revision());
    policy.setSource(f.owner,{installationId:installation.id,bindingId:sourceBindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:[...personalActionIds],outputTypes:['Person','PersonalPreference'],expiresAt:until},policy.revision());
    const p={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`,tasks=new PostgresTaskCommandService(t.database,t.policy,t.kernel),registry=new PostgresReadProgramRegistry(t.policy),
      worker=new PostgresWorkerStore(t.database,t.policy,t.kernel,{classify:(job,intents)=>postgresWorkerLane(job,intents,registry)});
    const database={inspectClaim:t.database.inspectClaim.bind(t.database),run:()=>{throw new Error('Caller execution must use the original owner scope');},
      runOwner:<T>(owner:string,action:Parameters<typeof t.database.run<T>>[0])=>t.database.runOwner(owner,async client=>{
        assert.equal(owner,f.owner);const modes=(await client.query('SELECT mode FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND relation=$1::regclass AND granted',[`${q}.eigos_business_mutex`])).rows.map(row=>row.mode);
        assert(modes.includes('RowExclusiveLock'));assert(!modes.includes('ExclusiveLock'));return action(client);
      })};
    const execution=new PostgresCallerActionExecution({database,policyDigest:t.policy,builder:t.kernel});
    const read=(id:string)=>t.run(c=>new PostgresTaskStorage(c,t.kernel).get(f.owner,id));
    const perform=async(action:string,input:Record<string,unknown>)=>{
      await t.refreshEligibility();const command={action,input,requestId:randomUUID()},prepared=await tasks.prepareOntologyAction(p,command),raw=await read(prepared.id);
      assert.equal(prepared.state,'auth-required');assert.equal((await tasks.prepareOntologyAction(p,command)).id,prepared.id);
      assert.equal(await worker.claim(['eigos.delegate'],30000),undefined,'READY metadata before approval is not executable');
      const preview=await tasks.callerActionPreview(p,prepared.id),plan=raw.delegation!.agent!.plans[0]!;
      assert.equal(preview.status,'prepared');assert.equal(preview.digest,preview.scope.previewDigest);assert.equal(preview.planDigest,plan.digest);
      const permit={action:'approve_object_write',requestId:randomUUID(),planDigest:plan.digest,objectWrite:preview.scope,expiresAt:until,environment:'managed'};
      await assert.rejects(tasks.authorize(p,prepared.id,{...permit,objectWrite:{...preview.scope,inputDigest:'f'.repeat(64)}}),/preview|differs|changed/i);
      const approved=await tasks.authorize(p,prepared.id,permit);assert.equal(approved.id,prepared.id);assert.equal(approved.state,'submitted');
      const claim=await worker.claim(['eigos.delegate'],30000);assert(claim);assert.equal(claim.job.id,prepared.id);
      assert.equal(postgresWorkerReservation(claim.token).lane,'execution');
      await assert.rejects(worker.beginModelUsage(claim,randomUUID(),'must-not-start',new Date().toISOString()),/no model capacity/);
      let renewing:Promise<unknown>|undefined,renewalFailure:unknown;
      const timer=setInterval(()=>{if(!renewing)renewing=worker.renew(claim,30000).catch(error=>{renewalFailure=error;}).finally(()=>{renewing=undefined;});},5000);timer.unref();
      try{await execution.run(claim,new AbortController().signal);}finally{clearInterval(timer);if(renewing)await renewing;}
      assert.equal(renewalFailure,undefined);const completed=await read(prepared.id);assert.equal(completed.state,'completed');assert.equal(completed.delegation!.acceptance?.accepted,true);assert.equal(completed.runs!.length,0);
      const committed=await tasks.callerActionPreview(p,prepared.id);assert.equal(committed.status,'committed');assert.equal(committed.digest,preview.digest);
      const intents=await t.run(c=>new PostgresTaskStorage(c,t.kernel).intents(f.owner,prepared.id));assert.equal(intents.length,1);assert.equal(intents[0]!.state,'effect_confirmed');
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.action_attempts WHERE intent_id=$1`,[intents[0]!.id])).rows[0].n),1);
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.budget_reservations WHERE intent_id=$1`,[intents[0]!.id])).rows[0].n),0);
      await assert.rejects(execution.run(claim,new AbortController().signal),/ACCESS_REVOKED|frontier|POLICY_CHANGED/,'A completed claim cannot replay its mutation');
      return completed;
    };
    const bound=await perform('BindSelfPerson',{self:true,displayTitle:'Synthetic self'});
    assert.equal(Number((await t.client.query(`SELECT revision FROM ${q}.ontology_objects WHERE owner=$1 AND type='Person' AND id=$2`,[f.owner,selfPersonRef(f.owner).id])).rows[0].revision),1);
    await perform('CreatePersonalPreference',{key:'rideClass',value:{kind:'rideClass',value:'comfort'}});
    await perform('SetPersonalPreference',{key:'rideClass',expectedRevision:1,value:{kind:'rideClass',value:'standard'}});
    assert.equal(Number((await t.client.query(`SELECT revision FROM ${q}.ontology_objects WHERE owner=$1 AND type='PersonalPreference' AND id=$2`,[f.owner,personalPreferenceRef(f.owner,'rideClass').id])).rows[0].revision),2);
    assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.security_model_channels`)).rows[0].n),0,'No configured LLM recipient is borrowed');
    assert.equal((await tasks.get(p,bound.id)).state,'completed');
    await assert.rejects(tasks.prepareOntologyAction(p,{action:'SubmitServiceRequest',input:{},requestId:randomUUID()}),/reviewed personal actions/);
    const waiting=await tasks.prepareOntologyAction(p,{action:'ClearPersonalPreference',input:{key:'rideClass',expectedRevision:2},requestId:randomUUID()}),preview=await tasks.callerActionPreview(p,waiting.id);
    await tasks.authorize(p,waiting.id,{action:'approve_object_write',requestId:randomUUID(),planDigest:preview.planDigest,objectWrite:preview.scope,expiresAt:until,environment:'managed'});
    const claim=await worker.claim(['eigos.delegate'],30000);assert(claim);assert.equal(claim.job.id,waiting.id);
    await assert.rejects(execution.run({...claim,token:randomUUID()},new AbortController().signal),/ACCESS_REVOKED/);
    const canceled=new AbortController();canceled.abort(new Error('Synthetic cancellation before dispatch'));
    await assert.rejects(execution.run(claim,canceled.signal),/cancellation before dispatch/);
    assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.action_attempts a JOIN ${q}.action_intents i ON i.owner=a.owner AND i.id=a.intent_id WHERE i.job_id=$1`,[waiting.id])).rows[0].n),0);
    // Inject failure only after the third actual production transaction's
    // mapper/seal completes. The real database performs the rollback; no query
    // proxy, permissive policy or fake provider result is substituted.
    let transactions=0;
    const fault=new PostgresCallerActionExecution({policyDigest:t.policy,builder:t.kernel,database:{inspectClaim:t.database.inspectClaim.bind(t.database),
      run:action=>t.database.run(async client=>{const ordinal=++transactions,result=await action(client);if(ordinal===3)throw new Error('Synthetic failure after actual apply and seal');return result;})}});
    let renewing:Promise<unknown>|undefined;const timer=setInterval(()=>{if(!renewing)renewing=worker.renew(claim,30000).finally(()=>{renewing=undefined;});},5000);timer.unref();
    try{await assert.rejects(fault.run(claim,new AbortController().signal),/failure after actual apply and seal/);}finally{clearInterval(timer);if(renewing)await renewing;}
    const original=(await t.run(c=>new PostgresTaskStorage(c,t.kernel).intents(f.owner,waiting.id)))[0]!;
    assert.equal(original.state,'dispatching');assert.equal(Number((await t.client.query(`SELECT applied FROM ${q}.action_observations WHERE intent_id=$1`,[original.id])).rows[0].applied),0);
    assert.equal(Number((await t.client.query(`SELECT revision FROM ${q}.ontology_objects WHERE owner=$1 AND type='PersonalPreference' AND id=$2`,[f.owner,personalPreferenceRef(f.owner,'rideClass').id])).rows[0].revision),2,'failed acceptance preserves the original exact object version');
    assert.notEqual((await read(waiting.id)).state,'completed');
    await assert.rejects(execution.run(claim,new AbortController().signal),/reconciliation|replay/);
    await tasks.cancel(p,waiting.id);await assert.rejects(execution.run(claim,new AbortController().signal),/ACCESS_REVOKED|frontier/);
    assert.equal((await read(waiting.id)).state,'canceled');
  }finally{if(target)await target.close();f.close();}
});

test('PostgreSQL observation registration is inactive, immutable and cancellable without lending the original grant',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
  const {observationContractFixture}=await import('./fixtures/observation-contract.js');
  const f=observationContractFixture(false,securityFixture(Date.now,{unified:true}));let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`;
    const commands=new PostgresTaskCommandService(t.database,t.policy,t.kernel,{resolveObservationProgram:async(_client,owner,_release,ref)=>{
      assert.equal(owner,f.owner);assert.deepEqual(ref,f.program.ref);return f.program;
    }}),worker=new PostgresWorkerStore(t.database,t.policy,t.kernel),args=f.input();
    const read=(id:string)=>t.run(c=>new PostgresTaskStorage(c,t.kernel).get(f.owner,id)),before=await read(f.original.id);
    const prepared=await commands.prepareObservationContract(f.p,args);assert.equal(prepared.state,'paused');assert.notEqual(prepared.id,before.id);assert.equal(prepared.contextId,before.contextId);
    const view=await commands.get(f.p,prepared.id);assert.equal(view.observation?.monitoring,false);assert.equal(view.observation?.targetIdentity,'unverified');assert.equal(view.observation?.activation,'observer_not_installed');assert.equal(view.observation?.sourcePermission,'current');
    assert.deepEqual(await read(before.id),before);assert.equal(f.sourceCalls(),0);assert.equal(f.modelInputs.length,0);
    assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.security_task_authorities WHERE task_id=$1`,[prepared.id])).rows[0].n),0);
    assert.equal(await worker.claim(['eigos.delegate'],30000),undefined);assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.action_intents WHERE job_id=$1`,[prepared.id])).rows[0].n),0);
    const grant=await t.run(c=>postgresTaskProcessingGrant(c,f.p,prepared.id,t.policy));assert.deepEqual(grant.grant.inputs,[]);assert.deepEqual(grant.grant.outputs,[]);
    assert.equal((await commands.prepareObservationContract(f.p,args)).id,prepared.id);
    const stored=await read(prepared.id),changed=structuredClone(stored);delete changed.delegation!.observationContract;
    await assert.rejects(t.run(c=>new PostgresTaskStorage(c,t.kernel).save(f.owner,changed)),/Observation delegation is immutable/);
    const different=structuredClone(stored);different.delegation!.observationContract!.digest='f'.repeat(64);
    await assert.rejects(t.run(c=>new PostgresTaskStorage(c,t.kernel).save(f.owner,different)),/Observation delegation is immutable/);
    const count=Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.jobs`)).rows[0].n);
    await assert.rejects(commands.prepareObservationContract(f.p,{...args,requestId:randomUUID(),expectedRevision:100}),/current completed/);
    await assert.rejects(commands.prepareObservationContract(f.p,{...args,requestId:randomUUID(),source:{...args.source,mappingId:'missing'}}),/mapping is unavailable/);
    assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.jobs`)).rows[0].n),count);
    const digest=stored.delegation!.observationContract!.digest;
    const pin=await t.run(c=>readPostgresObservationContract(c,f.owner,prepared.id));assert.equal(pin.digest,digest);
    await t.client.query(`UPDATE ${q}.security_sources SET state='revoked' WHERE owner=$1 AND installation_id=$2 AND binding_id=$3`,[f.owner,f.a.id,pin.pins.sourceBindingId]);
    const revokedSource=await commands.get(f.p,prepared.id);assert.equal(revokedSource.observation?.sourcePermission,'unavailable');
    const canceled=await commands.cancel(f.p,prepared.id);assert.equal(canceled.state,'canceled');assert.equal((await commands.get(f.p,prepared.id)).observation?.status,'revoked');
    assert.equal((await commands.prepareObservationContract(f.p,args)).id,prepared.id);assert.equal((await commands.get(f.p,prepared.id)).observation?.monitoring,false);
    assert.equal((await read(before.id)).state,'completed');assert.equal(f.sourceCalls(),0);assert.equal(f.modelInputs.length,0);
  }finally{if(target)await target.close();f.close();}
});
