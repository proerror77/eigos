import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresDatabase} from '../packages/postgres/database.js';
import type {Job} from '../packages/core/domain.js';
import type {ActionIntent,PlanGrant} from '../packages/ontology/actions.js';
import type {AgentActionPlan,AgentExecutionState} from '../packages/ontology/agent-actions.js';
import type {ExecutionPlan} from '../packages/ontology/execution.js';
import {BACKEND_VERSION} from '../packages/ontology/execution.js';
import {initialExecutionBudget} from '../packages/core/execution-budget.js';
import {digest} from '../packages/core/delegation.js';
import {recordPAPaymentHandoff,recordPAPaymentSelection,type PAHandoffRequest} from '../packages/core/pa-payment.js';
import {runRecoveryProgram,runRecoveryProgramAsync,reconcileTransition,revokeAuthorizationTransition,type RecoveryStorage} from '../packages/core/recovery-commands.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';

function agent(job:Job):AgentExecutionState{return {version:'1',programRef:{id:'synthetic.recovery',version:'1'},programDigest:digest({program:'synthetic-recovery'}),scope:{type:'ServiceRequest',id:job.id},input:{},requestRevision:job.delegation!.request.revision,plans:[],observations:[],feedback:[]};}
function intent(job:Job,effect:ActionIntent['effect'],state:ActionIntent['state']):ActionIntent{return {id:randomUUID(),owner:'synthetic-owner',jobId:job.id,stepId:'synthetic-step',businessOperationKey:randomUUID(),planDigest:digest({plan:'synthetic'}),bindingRef:{id:'synthetic',version:'1'},inputDigest:digest({}),privateDigest:digest({}),privateData:{},effect,state,failedQueries:3,nextAt:123,createdAt:job.createdAt};}
function base(state:Job['state']='input-required'):Job{
  const id=randomUUID(),at=new Date().toISOString();return {id,contextId:randomUUID(),service:'eigos.delegate',goal:'Synthetic original recovery task',state,revision:7,messages:[],runs:[],createdAt:at,updatedAt:at,
    delegation:{backendVersion:BACKEND_VERSION,request:{id,revision:3,originalGoal:'Synthetic original recovery task',requirements:[],messages:[],executionEnvironment:'sandbox'},phase:'executing',events:[],executionBudget:initialExecutionBudget(at)}};
}
function payment(job:Job,owner:string,version:2|3=2):void{
  job.delegation!.agent=agent(job);const expiresAt=new Date(Date.now()+3600000).toISOString(),providerId='synthetic-provider',bookingId='synthetic-original-booking',payeeId='synthetic-payee';
  const terms:PAHandoffRequest['terms']=version===2?{providerId,bookingId,bookingTermsDigest:digest({bookingId}),booking:{type:'BookingObservation',id:'synthetic-original-booking'},unpaidObservation:{type:'BookingPaymentObservation',id:'synthetic-original-unpaid'},description:'Synthetic original PA handoff',amount:{minor:'60',currency:'USD'},
    handler:{id:'synthetic-handler',type:'sandbox.pa-wallet',payeeId,endpoint:'https://synthetic.invalid/pa-wallet',supported:true},checkout:{id:'synthetic-checkout',type:'link_checkout',bookingId,payeeId,url:'https://synthetic.invalid/checkout',supported:true,userConfirmationRequired:true},routePolicy:'prefer_link_agent_wallet',expiresAt,environment:'sandbox',evidenceLevel:'synthetic'}:
    {providerId,payeeId,resource:{type:'shopify_checkout',id:'synthetic-checkout',termsDigest:digest({checkout:true})},checkoutObservation:{type:'ShopifyPaymentCheckoutObservation',id:'synthetic-checkout-observation'},unpaidObservation:{type:'ShopifyCheckoutPaymentObservation',id:'synthetic-unpaid-observation'},description:'Synthetic original checkout PA handoff',amount:{minor:'60',currency:'USD'},
      checkout:{id:'synthetic-checkout',type:'provider_checkout',url:'https://synthetic.invalid/checkout',testMode:true},routes:[{id:'pa_vault',type:'sandbox.pa-checkout',endpoint:'https://synthetic.invalid/pa-vault',supported:true}],routePolicy:'pa_selects_authorized_capability',expiresAt,environment:'sandbox',evidenceLevel:'synthetic'};
  recordPAPaymentHandoff(job,owner,digest({handoff:job.id}),terms,'request');
}
function memory(current:ActionIntent[]){
  const stored=structuredClone(current),saved:Job[]=[],effects:string[]=[];
  const port:RecoveryStorage={intents:()=>structuredClone(stored),saveIntent:(_owner,value)=>{effects.push(`intent:${value.id}`);stored.splice(stored.findIndex(item=>item.id===value.id),1,structuredClone(value));},revokeGrants:()=>{effects.push('revoke-plan-permits');},saveTask:(_owner,job)=>{effects.push('save-task');saved.push(structuredClone(job));}};
  return {port,stored,saved,effects};
}

test('source synchronous and PostgreSQL asynchronous recovery drivers preserve every PA-payment branch',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});t.after(()=>t.mock.timers.reset());
  for(const version of [2,3] as const)for(const state of ['submitted','working','completed','input-required','paused','auth-required','canceled','failed','rejected'] as const)for(const foundation of [false,true]){
    const original=base();payment(original,'synthetic-owner',version);original.state=state;original.question='Original PA question';
    const handoff=original.delegation!.agent!.paPayment!;handoff.selection=recordPAPaymentSelection(handoff,version===2?{wallet:{status:'available',reason:'ready',observedAt:new Date().toISOString()}}:{capability:{route:'pa_vault',status:'available',environment:'sandbox',observedAt:new Date().toISOString()}});handoff.reports=[{id:randomUUID(),outcome:'submitted',receivedAt:new Date().toISOString()}];
    original.delegation!.agent!.paPayment!.recoveryAttempts=3;original.delegation!.agent!.paPayment!.readbackSequence=4;
    const sync=memory([]),async=memory([]),before=structuredClone(original),requestId=randomUUID();
    if(foundation&&version===3){
      assert.throws(()=>runRecoveryProgram(sync.port,reconcileTransition(structuredClone(original),'synthetic-owner',requestId,{foundation})),/reviewed foundation projection/);
      await assert.rejects(runRecoveryProgramAsync(async.port,reconcileTransition(structuredClone(original),'synthetic-owner',requestId,{foundation})),/reviewed foundation projection/);assert.deepEqual(sync.effects,[]);assert.deepEqual(async.effects,[]);continue;
    }
    const a=runRecoveryProgram(sync.port,reconcileTransition(structuredClone(original),'synthetic-owner',requestId,{foundation})),b=await runRecoveryProgramAsync(async.port,reconcileTransition(structuredClone(original),'synthetic-owner',requestId,{foundation}));
    assert.deepEqual(a,b);assert.deepEqual(sync.effects,async.effects);assert.equal(a.legacyView,true);assert.deepEqual(a.job.delegation!.request,before.delegation!.request);assert.deepEqual(a.job.delegation!.executionBudget,before.delegation!.executionBudget);
    const paid=a.job.delegation!.agent!.paPayment!;assert.deepEqual(paid.request,before.delegation!.agent!.paPayment!.request);assert.deepEqual(paid.selection,before.delegation!.agent!.paPayment!.selection);assert.deepEqual(paid.reports,before.delegation!.agent!.paPayment!.reports);
    if(['submitted','working','completed'].includes(state)){assert.deepEqual(a.job,before);assert.equal(sync.saved.length,0);}
    else{const terminal=['canceled','failed','rejected'].includes(state);assert.equal(a.job.state,terminal?state:'submitted');assert.equal(a.job.revision,8);assert.equal(paid.readbackSequence,5);assert.equal(paid.recoveryAttempts,0);assert.equal(paid.status,terminal?'withdrawn':'reported');assert.equal(a.job.delegation!.recoveryPending,terminal);assert.equal(a.job.question,terminal?'Original PA question':undefined);}
  }
});

test('shared recovery preserves uncertain effects, confirmed readback, simulation and plan-permit-only revocation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});t.after(()=>t.mock.timers.reset());
  for(const mode of ['agent','fixed'] as const)for(const state of ['working','input-required','rejected','canceled','failed','completed','auth-required'] as const){
    const original=base(state);if(mode==='agent')original.delegation!.agent=agent(original);else original.delegation!.plan={digest:digest({fixed:true})} as ExecutionPlan;
    const current=[intent(original,'order','dispatching'),{...intent(original,'reserve','effect_confirmed'),remoteRef:'synthetic-original-remote'},intent(original,'read','needs_review'),intent(original,'local','ready')];
    const a=memory(current),b=memory(current),requestId=randomUUID();
    const result=runRecoveryProgram(a.port,reconcileTransition(structuredClone(original),'synthetic-owner',requestId,{foundation:true}));
    assert.deepEqual(result,await runRecoveryProgramAsync(b.port,reconcileTransition(structuredClone(original),'synthetic-owner',requestId,{foundation:true})));assert.deepEqual(a.stored,b.stored);assert.deepEqual(a.saved,b.saved);assert.deepEqual(a.effects,b.effects);
    assert.equal(a.stored[0]!.state,'effect_unknown');assert.equal(a.stored[0]!.businessOperationKey,current[0]!.businessOperationKey);assert.equal(a.stored[0]!.failedQueries,0);
    assert.equal(a.stored[1]!.needsObservation,mode==='fixed'?true:undefined);assert.equal(a.stored[2]!.state,mode==='fixed'?'effect_unknown':'needs_review');assert.equal(a.stored[3]!.state,'ready');
    assert.equal(result.job.state,['canceled','failed','completed','auth-required'].includes(state)?state:'working');assert.equal(result.job.delegation!.request.revision,3);assert.equal(result.job.revision,8);assert(!a.effects.includes('revoke-plan-permits'));
  }
  for(const mode of ['agent','fixed','simulation'] as const)for(const pending of [true,false]){
    const job=base('working'),d=job.delegation!;d.authorizationRequest={planDigest:digest({plan:true}),effects:['order'],maxAmount:{minor:'60',currency:'USD'},payeeIds:['synthetic-payee'],environment:'sandbox',realOperationsAllowed:false};
    if(mode==='fixed')d.plan={digest:digest({fixed:true})} as ExecutionPlan;
    else{d.agent=agent(job);if(mode==='simulation'){const plan={id:randomUUID(),digest:digest({simulation:true}),quote:{id:randomUUID()}} as AgentActionPlan;d.agent.plans=[plan];d.agent.pendingPlanId=plan.id;d.approval={planDigest:plan.digest,quoteDigest:digest({}),at:job.createdAt,simulationOnly:true};}}
    const current=[intent(job,'order',pending?'dispatching':'effect_confirmed'),intent(job,'read','dispatching')],a=memory(current),b=memory(current),requestId=randomUUID();
    const result=runRecoveryProgram(a.port,revokeAuthorizationTransition(structuredClone(job),'synthetic-owner',requestId));
    assert.deepEqual(result,await runRecoveryProgramAsync(b.port,revokeAuthorizationTransition(structuredClone(job),'synthetic-owner',requestId)));assert.deepEqual(a.stored,b.stored);assert.deepEqual(a.saved,b.saved);assert.deepEqual(a.effects,b.effects);
    assert.equal(a.effects.includes('revoke-plan-permits'),mode!=='simulation');assert.equal(a.stored[1]!.state,'dispatching');assert.equal(result.job.delegation!.request.revision,3);assert.deepEqual(result.job.delegation!.executionBudget,job.delegation!.executionBudget);
    assert.equal(result.job.state,mode==='agent'&&!pending?'working':'auth-required');assert.equal(result.job.revision,mode==='agent'&&!pending?7:8);
    assert.equal(a.stored[0]!.state,mode==='agent'&&pending?'effect_unknown':current[0]!.state);if(mode==='simulation')assert.equal(result.job.delegation!.approval,undefined);
  }
  for(const state of ['completed','failed','canceled'] as const){const closed=base(state);closed.delegation!.agent=agent(closed);closed.delegation!.authorizationRequest={planDigest:digest({}),effects:['order'],maxAmount:{minor:'60',currency:'USD'},payeeIds:['synthetic-payee'],environment:'sandbox',realOperationsAllowed:false};
    const port=memory([]);assert.throws(()=>runRecoveryProgram(port.port,revokeAuthorizationTransition(closed,'synthetic-owner','closed')),/No open plan authorization/);assert.deepEqual(port.effects,[]);}
  for(const mode of ['agent','fixed'] as const){const idle=base(),port=memory([]);if(mode==='agent')idle.delegation!.agent=agent(idle);else idle.delegation!.plan={digest:digest({fixed:true})} as ExecutionPlan;const before=structuredClone(idle);assert.deepEqual(runRecoveryProgram(port.port,reconcileTransition(idle,'synthetic-owner','nothing',{foundation:true})).job,before);assert.deepEqual(port.effects,[]);}
  const asynchronous=base();asynchronous.delegation!.agent=agent(asynchronous);const invalid={...memory([]).port,intents:async()=>[]};assert.throws(()=>runRecoveryProgram(invalid as unknown as RecoveryStorage,reconcileTransition(asynchronous,'synthetic-owner','invalid-sync-port',{foundation:true})),/Synchronous task recovery received asynchronous storage/);
  const empty=base();assert.throws(()=>runRecoveryProgram(memory([]).port,reconcileTransition(empty,'synthetic-owner','none',{foundation:true})),/No current business operation/);
});

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
async function postgresFixture(configure?:(job:Job,owner:string)=>void){
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic recovery commands',3600000);f.approve(installation.id);
    const save=f.jobs.save.bind(f.jobs);f.jobs.save=(owner,job)=>{job.delegation!.request.executionEnvironment='sandbox';f.jobs.save=save;return save(owner,job);};
    const task=f.task(installation.id),job=task.job;
    job.delegation!.agent=agent(job);job.delegation!.authorizationRequest={planDigest:digest({plan:'synthetic'}),effects:['order'],maxAmount:{minor:'60',currency:'USD'},payeeIds:['synthetic-payee'],environment:'sandbox',realOperationsAllowed:false};job.delegation!.executionBudget=initialExecutionBudget(job.createdAt);
    configure?.(job,f.owner);f.jobs.save(f.owner,job);
    const current={...intent(job,'order','dispatching'),owner:f.owner};f.jobs.createIntent(f.owner,current);
    const principal={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
    target=await importPostgresFixture(f);const commands=new PostgresTaskCommandService(target.database,target.policy);
    return {f,t:target,commands,job,current,principal,task,close:async()=>{await target!.close();f.close();}};
  }catch(error){if(target)await target.close();f.close();throw error;}
}

test('PostgreSQL reconcile schedules only original-key readback, is idempotent and returns a permission-scoped receipt',local,async()=>{
  const x=await postgresFixture();try{
    const q=`"${x.t.schema}"`,before=(await x.t.client.query(`SELECT id,revision,state,expires_at,body FROM ${q}.security_grants ORDER BY id`)).rows;
    const result=await x.commands.reconcile(x.principal,x.job.id,'original-readback');assert.equal(result.id,x.job.id);assert.equal(result.state,'working');
    assert.equal('delegation'in result,false);assert.equal('view'in result&&result.view,'eigos.task.v2');assert.equal('outputStatus'in result&&result.outputStatus,'receipt_only');
    const revision=result.revision;assert.equal((await x.commands.reconcile(x.principal,x.job.id,'original-readback')).revision,revision);
    const stored=await x.t.run(c=>new PostgresTaskStorage(c).get(x.f.owner,x.job.id));assert.equal(stored.delegation!.request.revision,1);assert.deepEqual(stored.delegation!.executionBudget,x.job.delegation!.executionBudget);
    const rows=(await x.t.client.query(`SELECT body,state,business_key,private_data FROM ${q}.action_intents`)).rows;assert.equal(rows.length,1);assert.equal(rows[0].state,'effect_unknown');assert.equal(rows[0].business_key,x.current.businessOperationKey);assert.equal(JSON.parse(rows[0].body).failedQueries,0);assert.equal(rows[0].private_data,JSON.stringify(x.current.privateData));
    assert.equal((await x.t.client.query(`SELECT count(*) AS n FROM ${q}.action_attempts`)).rows[0].n,'0');assert.equal((await x.t.client.query(`SELECT count(*) AS n FROM ${q}.action_observations`)).rows[0].n,'0');
    assert.deepEqual((await x.t.client.query(`SELECT id,revision,state,expires_at,body FROM ${q}.security_grants ORDER BY id`)).rows,before);
    const worker=new PostgresWorkerStore(x.t.database,x.t.policy),claim=await worker.claim(['eigos.delegate'],15000);assert(claim);assert.equal(claim.job.id,x.job.id);assert(await worker.finish(claim,job=>{job.state='paused';}));
    await assert.rejects(x.commands.reconcile({...x.principal,scopes:['tasks:read']},x.job.id,'no-write'));
    await x.t.client.query(`UPDATE ${q}.security_task_authorities SET state='revoked' WHERE task_id=$1`,[x.job.id]);
    await assert.rejects(x.commands.reconcile(x.principal,x.job.id,'lost-authority'));
  }finally{await x.close();}
});

test('PostgreSQL plan-permit revocation preserves task grants, budgets and uncertain original effects',local,async()=>{
  const x=await postgresFixture();try{
    const q=`"${x.t.schema}"`,grant:PlanGrant={id:randomUUID(),owner:x.f.owner,jobId:x.job.id,planDigest:x.current.planDigest,bindingRefs:[x.current.bindingRef],allowedEffects:['order'],maxAmount:{minor:'60',currency:'USD'},payeeIds:['synthetic-payee'],environment:'sandbox',approvedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),revoked:false};
    await x.t.run(async c=>{await c.query(`INSERT INTO ${q}.plan_grants(id,owner,job_id,body) VALUES($1,$2,$3,$4)`,[grant.id,x.f.owner,x.job.id,JSON.stringify(grant)]);await c.query(`INSERT INTO ${q}.budget_reservations(intent_id,owner,grant_id,minor,currency,state) VALUES($1,$2,$3,'60','USD','held')`,[x.current.id,x.f.owner,grant.id]);});
    const security=(await x.t.client.query(`SELECT * FROM ${q}.security_grants ORDER BY id`)).rows,budget=(await x.t.client.query(`SELECT * FROM ${q}.budget_reservations`)).rows;
    await x.t.client.query(`CREATE FUNCTION ${q}.reject_recovery_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-recovery-save-rejected'; END $$; CREATE TRIGGER reject_recovery_save BEFORE UPDATE ON ${q}.jobs FOR EACH ROW EXECUTE FUNCTION ${q}.reject_recovery_save()`);
    await assert.rejects(x.commands.revokeAuthorization(x.principal,x.job.id,'revoke-original-permit'),/synthetic-recovery-save-rejected/);
    assert.deepEqual(JSON.parse((await x.t.client.query(`SELECT body FROM ${q}.plan_grants WHERE id=$1`,[grant.id])).rows[0].body),grant);
    assert.equal((await x.t.client.query(`SELECT state FROM ${q}.action_intents WHERE id=$1`,[x.current.id])).rows[0].state,'dispatching');
    assert.equal((await x.t.client.query(`SELECT count(*) AS n FROM ${q}.requests WHERE request_id='revoke-original-permit'`)).rows[0].n,'0');
    await x.t.client.query(`DROP TRIGGER reject_recovery_save ON ${q}.jobs; DROP FUNCTION ${q}.reject_recovery_save()`);
    const result=await x.commands.revokeAuthorization(x.principal,x.job.id,'revoke-original-permit');assert.equal(result.state,'auth-required');const revision=result.revision;
    const permit=JSON.parse((await x.t.client.query(`SELECT body FROM ${q}.plan_grants WHERE id=$1`,[grant.id])).rows[0].body);assert.equal(permit.revoked,true);assert.equal(permit.expiresAt,grant.expiresAt);assert.equal(typeof permit.revokedAt,'string');
    await x.commands.revokeAuthorization(x.principal,x.job.id,'revoke-original-permit');assert.equal((await x.commands.revokeAuthorization(x.principal,x.job.id,'revoke-original-permit')).revision,revision);
    const repeated=JSON.parse((await x.t.client.query(`SELECT body FROM ${q}.plan_grants WHERE id=$1`,[grant.id])).rows[0].body);assert.equal(repeated.revokedAt,permit.revokedAt);
    assert.deepEqual((await x.t.client.query(`SELECT * FROM ${q}.security_grants ORDER BY id`)).rows,security);assert.deepEqual((await x.t.client.query(`SELECT * FROM ${q}.budget_reservations`)).rows,budget);
    const current=(await x.t.client.query(`SELECT state,business_key FROM ${q}.action_intents WHERE id=$1`,[x.current.id])).rows[0];assert.equal(current.state,'effect_unknown');assert.equal(current.business_key,x.current.businessOperationKey);
  }finally{await x.close();}
});

test('PostgreSQL PA reconciliation preserves the immutable handoff and rolls back rejected foundation versions',local,async()=>{
  for(const version of [2,3] as const)for(const state of ['input-required','canceled'] as const){const x=await postgresFixture((job,owner)=>{payment(job,owner,version);job.state=state;job.delegation!.agent!.paPayment!.recoveryAttempts=3;});try{
    const original=structuredClone(x.job.delegation!.agent!.paPayment!),q=`"${x.t.schema}"`;
    if(version===3){await assert.rejects(x.commands.reconcile(x.principal,x.job.id,'v3-rejected'),/reviewed foundation projection/);assert.equal((await x.t.client.query(`SELECT count(*) AS n FROM ${q}.requests WHERE request_id='v3-rejected'`)).rows[0].n,'0');}
    else{const result=await x.commands.reconcile(x.principal,x.job.id,'pa-original-readback');assert.equal(result.state,state==='canceled'?'canceled':'submitted');const current=await x.t.run(c=>new PostgresTaskStorage(c).get(x.f.owner,x.job.id));assert.deepEqual(current.delegation!.agent!.paPayment!.request,original.request);assert.equal(current.delegation!.agent!.paPayment!.status,state==='canceled'?'withdrawn':'reported');assert.equal(current.delegation!.recoveryPending,state==='canceled');assert.equal(current.delegation!.agent!.paPayment!.recoveryAttempts,0);assert.equal(current.delegation!.agent!.paPayment!.readbackSequence,1);}
  }finally{await x.close();}}
});


test('a lost PostgreSQL recovery COMMIT reply is not retried and explicit retry reads the original task receipt',local,async()=>{
  const x=await postgresFixture(),pool=new pg.Pool({max:1});let commits=0,evictions=0;
  const wrapped:Pick<pg.Pool,'connect'|'end'>={connect:new Proxy(pool.connect.bind(pool),{apply(fn,self,args){return Promise.resolve(Reflect.apply(fn,self,args)).then((client:pg.PoolClient)=>{
    const query=client.query,release=client.release;client.query=new Proxy(query,{apply(method,target,values){return Promise.resolve(Reflect.apply(method,target,values)).then(result=>{if(values[0]==='COMMIT'){commits++;throw new Error('Synthetic lost recovery COMMIT reply');}return result;});}});
    client.release=error=>{if(error)evictions++;client.query=query;client.release=release;release.call(client,error);};return client;
  });}}),end:()=>pool.end()};
  const database=new PostgresDatabase(wrapped,x.t.schema,x.t.authority),commands=new PostgresTaskCommandService(database,x.t.policy);
  try{
    await assert.rejects(commands.reconcile(x.principal,x.job.id,'uncertain-original-readback'),/commit outcome is unknown/);assert.equal(commits,1);assert.equal(evictions,1);
    const current=await x.t.run(c=>new PostgresTaskStorage(c).get(x.f.owner,x.job.id));const repeated=await x.commands.reconcile(x.principal,x.job.id,'uncertain-original-readback');assert.equal(repeated.revision,current.revision);assert.equal(current.id,x.job.id);
    assert.equal((await x.t.client.query(`SELECT count(*) AS n FROM "${x.t.schema}".requests WHERE request_id='uncertain-original-readback'`)).rows[0].n,'1');
    assert.equal((await x.t.client.query(`SELECT count(*) AS n FROM "${x.t.schema}".action_attempts`)).rows[0].n,'0');
  }finally{await database.close();await x.close();}
});
