import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {securityFixture} from './fixtures/security.js';
import {importPostgresPrimaryFixture} from './fixtures/postgres-primary.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {postgresTaskView} from '../packages/postgres/task-view.js';
import {postgresTaskReadGrant} from '../packages/postgres/task-read-access.js';
import {SecurityError} from '../packages/security/errors.js';
import pg from 'pg';
import {PostgresDatabase} from '../packages/postgres/database.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {postgresProvisionTask,postgresIsNewTaskGrant} from '../packages/postgres/task-grants.js';
import {digest} from '../packages/core/delegation.js';

const enabled=process.env.EIGOS_TEST_PG_LOCAL==='1';
async function fixture(options:{processingOnly?:boolean}={}){
 const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>|undefined;
 try{
  const installation=f.installation('Current eligibility snapshot',600000);f.approve(installation.id);const expiresAt=new Date(Date.now()+3600000).toISOString();
  f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
  f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,role:'Viewer',resource:{kind:'namespace',id:f.jobs.ontology.model.ref.id,version:f.jobs.ontology.model.ref.digest},expiresAt},f.jobs.security.policies.revision());
  f.jobs.security.policies.setModelChannel('synthetic:current-eligibility',{classification:'sensitive',markings:['member_private','personal_data'],expiresAt},f.jobs.security.policies.revision());
  target=await importPostgresPrimaryFixture(f);const t=target,principal=options.processingOnly?{...f.principal,scopes:['tasks:write']}:f.principal,p={...principal,access:await t.publisher.authenticate(principal,installation.token)};
  const commands=new PostgresTaskCommandService(t.database,t.policy),job=await commands.submit(p,{goal:'Original current eligibility task',requestId:'current-eligibility'});
  const q=`"${t.schema}"`;
  const fixed=()=>t.client.query(`SELECT id,revision,state,expires_at,body FROM ${q}.security_grants ORDER BY id`).then(result=>result.rows);
  const shorten=async()=>{const until=Date.now()+2500;await t.client.query(`UPDATE ${q}.security_manager SET expires_at=$1 WHERE slot=1`,[until]);await t.client.query(`UPDATE ${q}.security_subjects SET valid_until=$1 WHERE installation_id=$2`,[until,installation.id]);return until;};
  const refresh=async()=>{await t.publisher.renew();await t.publisher.publish(f.member.id,installation.id);};
  return {f,t,p,job,goal:'Original current eligibility task',q,installation,commands,fixed,shorten,refresh,close:async()=>{try{await t.close();}finally{f.close();}}};
 }catch(error){await target?.close();f.close();throw error;}
}
function gate(){let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});return {enter,entered};}
async function entered(ready:ReturnType<typeof gate>,work:Promise<unknown>){await Promise.race([ready.entered,work.then(()=>{throw new Error('The callback did not reach its protected read');})]);}

test('a long Agent transaction checks current unchanged eligibility after its old snapshot timestamps expire', {skip:!enabled},async()=>{
 const x=await fixture();try{
  const before=await x.fixed(),oldUntil=await x.shorten(),ready=gate();
  const result=x.t.database.run(async client=>{
   const admission=await postgresTaskReadGrant(client,x.p,x.job.id,x.t.policy);assert(admission.validUntil>oldUntil);
   ready.enter();await delay(3000);assert(Date.now()>oldUntil);
   return postgresTaskView(client,x.p,x.job.id,x.t.policy);
  });
  await entered(ready,result);await x.refresh();assert.equal((await result).id,x.job.id);assert.deepEqual(await x.fixed(),before);
 }finally{await x.close();}
});

test('a Worker retains its processing-only identity while current unchanged qualification refreshes independently', {skip:!enabled},async()=>{
 const x=await fixture({processingOnly:true});try{
  const store=new PostgresWorkerStore(x.t.database,x.t.policy),claim=await store.claim(['eigos.delegate'],15000);assert(claim);
  const before=await x.fixed(),oldUntil=await x.shorten(),ready=gate();
  const result=store.readEvidence(claim,'synthetic:current-eligibility',async(auth,admission)=>{
   assert.equal(admission.actor.actorKind,'worker');assert.deepEqual(admission.actor.tokenScopes,['tasks:write']);assert.deepEqual(admission.grant.operations,['task.process']);assert(admission.validUntil>oldUntil);await auth.readTaskRoot();ready.enter();await delay(3000);
   return (await auth.readObject({type:'ServiceRequest',id:x.job.id},['originalGoal'])).object.properties.originalGoal;
  });
  await entered(ready,result);await x.refresh();assert.equal(await result,x.goal);assert.deepEqual(await x.fixed(),before);assert(await store.active(claim));
  await assert.rejects(x.commands.get(x.p,x.job.id));
  const reader={...x.f.principal,access:await x.t.publisher.authenticate(x.f.principal,x.installation.token)};await assert.rejects(x.commands.get(reader,x.job.id));
 }finally{await x.close();}
});

test('expired qualification without an acknowledged refresh still rejects the original snapshot at commit', {skip:!enabled},async()=>{
 const x=await fixture();try{
  const oldUntil=await x.shorten(),ready=gate();
  const result=x.t.database.run(async client=>{await postgresTaskReadGrant(client,x.p,x.job.id,x.t.policy);ready.enter();await delay(3000);assert(Date.now()>oldUntil);return 'must never escape';});
  void result.catch(()=>{});await entered(ready,result);await assert.rejects(result,error=>error instanceof SecurityError);
 }finally{await x.close();}
});

test('current qualification never extends a fixed task grant deadline', {skip:!enabled},async()=>{
 const x=await fixture();try{
  const data=(await x.t.client.query(`SELECT id,body FROM ${x.q}.security_grants WHERE kind='task_data' AND state='active'`)).rows[0],until=Date.now()+2500,body={...JSON.parse(data.body),expiresAt:new Date(until).toISOString()};
  await x.t.client.query(`UPDATE ${x.q}.security_grants SET expires_at=$1,body=$2 WHERE id=$3`,[until,JSON.stringify(body),data.id]);
  const ready=gate(),result=x.t.database.run(async client=>{const admission=await postgresTaskReadGrant(client,x.p,x.job.id,x.t.policy);assert.equal(admission.validUntil,until);ready.enter();await delay(3000);return 'must never escape';});
  void result.catch(()=>{});await entered(ready,result);await x.refresh();await assert.rejects(result,error=>error instanceof SecurityError);
  assert.equal(Number((await x.t.client.query(`SELECT expires_at FROM ${x.q}.security_grants WHERE id=$1`,[data.id])).rows[0].expires_at),until);
 }finally{await x.close();}
});

test('current qualification cannot extend the fixed role deadline captured by a protected object read', {skip:!enabled},async()=>{
 const x=await fixture();try{
  const until=Date.now()+2500,role=(await x.t.client.query(`SELECT id,body FROM ${x.q}.security_roles WHERE subject_id=$1`,[x.installation.id])).rows[0];
  await x.t.client.query(`UPDATE ${x.q}.security_roles SET body=$1 WHERE id=$2`,[JSON.stringify({...JSON.parse(role.body),expiresAt:new Date(until).toISOString()}),role.id]);
  const ready=gate(),result=x.t.database.run(async client=>{
   const {withPostgresTaskReadAuthorization}=await import('../packages/postgres/task-output.js');
   return withPostgresTaskReadAuthorization(client,x.p,x.job.id,x.t.policy,async auth=>{await auth.readTaskRoot();ready.enter();await delay(3000);return 'must never escape';});
  });
  void result.catch(()=>{});await entered(ready,result);await x.refresh();await assert.rejects(result,error=>error instanceof SecurityError);
  assert.equal(JSON.parse((await x.t.client.query(`SELECT body FROM ${x.q}.security_roles WHERE id=$1`,[role.id])).rows[0].body).expiresAt,new Date(until).toISOString());
 }finally{await x.close();}
});

test('new issuance receipts are private to their transaction and cannot certify existing or rolled-back rows', {skip:!enabled},async()=>{
 const x=await fixture();try{
  let stale:Parameters<typeof postgresIsNewTaskGrant>[1]|undefined;
  await x.t.database.run(async client=>{
   const before=await postgresTaskReadGrant(client,x.p,x.job.id,x.t.policy),existing={id:before.grant.id,revision:before.grant.revision,bodyDigest:digest(before.grant),taskId:x.job.id,requestRevision:before.grant.requestRevision};
   assert.equal(await postgresIsNewTaskGrant(client,existing),false);
   await client.query('SAVEPOINT rolled_back_issuance');
   const job=await new PostgresTaskStorage(client).get(x.f.owner,x.job.id),issued=await postgresProvisionTask(client,x.p,job,x.t.policy,[],{previous:before.grant});
   stale={id:issued.grant.id,revision:issued.grant.revision,bodyDigest:digest(issued.grant),taskId:x.job.id,requestRevision:issued.grant.requestRevision};
   assert(await postgresIsNewTaskGrant(client,stale));
   await client.query('ROLLBACK TO SAVEPOINT rolled_back_issuance');await client.query('RELEASE SAVEPOINT rolled_back_issuance');
   assert.equal(await postgresIsNewTaskGrant(client,stale),false);assert.equal((await postgresTaskReadGrant(client,x.p,x.job.id,x.t.policy)).grant.id,before.grant.id);
  });
  assert(stale);await x.t.database.run(async client=>{assert.equal(await postgresIsNewTaskGrant(client,stale!),false);});
  assert.equal((await x.commands.get(x.p,x.job.id)).id,x.job.id);
 }finally{await x.close();}
});

test('a held COMMIT reply cannot deliver protected data after manager continuity ends', {skip:!enabled},async()=>{
 const x=await fixture();const pool=new pg.Pool({max:1}),control=new pg.Pool({max:2});let acknowledge!:()=>void,reached!:()=>void;
 const committed=new Promise<void>(resolve=>{reached=resolve;}),held=new Promise<void>(resolve=>{acknowledge=resolve;});let intercepted=false;
 const wrapped={connect:async()=>{
  const client=await pool.connect(),query=client.query.bind(client);
  client.query=(async(sql:string,values?:unknown[])=>{const result=await query(sql,values);if(sql==='COMMIT'&&!intercepted){intercepted=true;reached();await held;}return result;}) as typeof client.query;return client;
 },end:()=>pool.end()};
 const database=new PostgresDatabase(wrapped as Pick<pg.Pool,'connect'|'end'>,x.t.schema,x.t.authority,{eligibilityPool:control});
 try{
  const read=new PostgresTaskCommandService(database,x.t.policy).get(x.p,x.job.id);void read.catch(()=>{});
  await Promise.race([committed,read.then(()=>{throw new Error('The protected transaction did not reach COMMIT');})]);
  await x.t.publisher.close();acknowledge();await assert.rejects(read,error=>error instanceof SecurityError&&error.reason==='AUTHORITY_UNAVAILABLE');
 }finally{acknowledge?.();await database.close();await x.close();}
});
