import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {copyFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {securityFixture} from './fixtures/security.js';
import {planBusinessSnapshot} from '../packages/postgres/business-snapshot.js';
import {importBusinessSnapshot} from '../packages/postgres/business-import.js';
import {runtimeAuthorityDigest} from '../packages/core/runtime-authority.js';
import {PostgresDatabase} from '../packages/postgres/database.js';
import {PostgresAuthorizationPublisher,type PostgresEligibilityMembers} from '../packages/postgres/authority-publisher.js';
import {SecurityError} from '../packages/security/errors.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
const reason=(expected:SecurityError['reason'])=>(error:unknown)=>error instanceof SecurityError&&error.reason===expected;
async function fixture(count=1){
  const f=securityFixture(Date.now,{unified:true}),installations=Array.from({length:count},(_,i)=>f.installation(`Synthetic publisher ${i}`,3600000));
  for(const installation of installations)f.approve(installation.id);
  const task=f.task(installations[0]!.id),snapshot=join(f.directory,'publisher-snapshot.sqlite');
  f.coordinator.close();const source=new DatabaseSync(f.database);try{source.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{source.close();}
  copyFileSync(f.database,snapshot);chmodSync(snapshot,0o600);const offline=new DatabaseSync(snapshot);try{offline.exec('PRAGMA journal_mode=DELETE');}finally{offline.close();}
  const schema=`eigos_business_${randomUUID().replaceAll('-','')}`,runtime={id:f.authority!.id,revision:f.authority!.revision,digest:runtimeAuthorityDigest(f.authority!)};
  const policy=f.jobs.security.policies.definitionDigest,connection={host:'127.0.0.1',port:Number(process.env.PGPORT??52744),user:'postgres',database:'postgres',password:process.env.PGPASSWORD,ssl:false as const};
  const client=new pg.Client(connection);await client.connect();const pool=new pg.Pool({...connection,max:2}),controlPool=new pg.Pool({...connection,max:1});
  const database=new PostgresDatabase(pool,schema,runtime),plan=planBusinessSnapshot(snapshot,runtime.digest,policy);
  await importBusinessSnapshot(client,{snapshot,schema,expectedFileDigest:plan.fileDigest,expectedAuthorityDigest:runtime.digest,expectedPolicyDigest:policy,maxDatabaseBytes:1000000000});
  const members:PostgresEligibilityMembers={agents:{authorize:(principal,bearer)=>f.members.agents.authorize(principal,bearer)},authorize:principal=>f.members.authorize(principal),authorizationFacts:(member,id)=>f.members.authorizationFacts(member,id)};
  const options={database,controlPool,schema,runtime,policyDigest:policy,members},publisher=new PostgresAuthorizationPublisher(options),q=`"${schema}"`;
  return {f,client,pool,controlPool,database,schema,runtime,policy,members,options,publisher,q,installations,task,
    close:async()=>{await publisher.close();await controlPool.end();await database.close();try{await client.query(`DROP SCHEMA ${q} CASCADE`);}finally{await client.end();f.close();}}};
}

test('the PostgreSQL publisher authenticates trusted membership and never revives denied subjects or revoked grants',local,async()=>{
  const t=await fixture();try{
    const {f,publisher,client,q}=t,installation=t.installations[0]!;await publisher.start();
    const initial=(await client.query(`SELECT token,expires_at FROM ${q}.security_manager`)).rows[0];
    assert(Number(initial.expires_at)>Date.now()+58000);assert(Number(initial.expires_at)<=Date.now()+60000);
    const actor=await publisher.authenticate(f.principal,installation.token);assert.equal(actor.actorKind,'agent');
    assert.equal(actor.authEpoch,1);if(actor.actorKind!=='agent')throw new Error('Expected agent actor');assert.equal(actor.agentGrant.id,t.task.authority.agentGrant.id);
    await publisher.renew();assert.equal((await client.query(`SELECT token FROM ${q}.security_manager`)).rows[0].token,initial.token);
    let eligible=false;t.members.authorizationFacts=(member,id)=>({...f.members.authorizationFacts(member,id),active:eligible});
    const denied=await publisher.publish(f.member.id,installation.id);assert.equal(denied.active,false);assert.equal(denied.epoch,2);
    assert.equal((await client.query(`SELECT state FROM ${q}.security_task_authorities WHERE id=$1`,[t.task.authority.id])).rows[0].state,'revoked');
    assert.equal((await client.query(`SELECT state FROM ${q}.security_grants WHERE id=$1`,[actor.agentGrant.id])).rows[0].state,'revoked');
    eligible=true;await publisher.refresh();assert.equal((await publisher.publish(f.member.id,installation.id)).active,false);
    await assert.rejects(publisher.authenticate(f.principal,installation.token),reason('ACCESS_REVOKED'));
    const fence=await publisher.deny({ownerKey:f.owner,kind:'installation',targetId:installation.id});await publisher.settleFence(fence,'cleared');
    const restored=(await client.query(`SELECT epoch,state,valid_until FROM ${q}.security_subjects WHERE installation_id=$1`,[installation.id])).rows[0];
    assert.equal(restored.state,'active');assert.equal(Number(restored.valid_until),0);assert.equal(Number(restored.epoch),3);
    const current=await publisher.publish(f.member.id,installation.id);assert(current.active);assert.equal(current.epoch,3);
    await assert.rejects(publisher.authenticate(f.principal,installation.token),reason('AUTHORIZATION_REQUIRED'));
    assert.equal((await client.query(`SELECT count(*) AS n FROM ${q}.security_grants WHERE state='active'`)).rows[0].n,'0');
  }finally{await t.close();}
});

test('deny fences are committed before membership work; stale restore revisions and overlapping fences stay denied',local,async()=>{
  const t=await fixture(2);try{
    const {f,publisher,client,q}=t;await publisher.start();const target={ownerKey:f.owner,kind:'installation' as const,targetId:t.installations[0]!.id};
    const a=await publisher.deny(target),b=await publisher.deny(target);assert.equal(b.revision,a.revision+1);
    await assert.rejects(publisher.settleFence(a,'cleared'),reason('POLICY_CHANGED'));
    const member=await publisher.deny({ownerKey:f.owner,kind:'member',targetId:f.member.id});await publisher.settleFence(b,'cleared');
    await publisher.refresh();assert.equal((await client.query(`SELECT count(*) AS n FROM ${q}.security_subjects WHERE state='active'`)).rows[0].n,'0');
    await publisher.settleFence(member,'cleared');await publisher.refresh();
    assert.equal((await client.query(`SELECT count(*) AS n FROM ${q}.security_subjects WHERE state='active'`)).rows[0].n,'2');
    await assert.rejects(publisher.coordinate(target,async()=>{
      assert.equal((await client.query(`SELECT state FROM ${q}.security_fences WHERE kind='installation'`)).rows[0].state,'pending');
      await t.database.run(async c=>{await c.query(`SELECT 1`);}); // no membership await holds the business mutex
      throw new Error('Synthetic membership transaction failed');
    }),reason('REVOCATION_PENDING'));
    const subjects=(await client.query(`SELECT installation_id,state FROM ${q}.security_subjects ORDER BY installation_id`)).rows;
    assert.equal(subjects.find(s=>s.installation_id===target.targetId)!.state,'denied');
    assert.equal(subjects.find(s=>s.installation_id!==target.targetId)!.state,'active');
    const read=t.members.authorizationFacts;t.members.authorizationFacts=async(member,id)=>({...await read(member,id),active:id===target.targetId});
    await publisher.publish(f.member.id,t.installations[1]!.id);
    const restored=await publisher.deny(target);await publisher.settleFence(restored,'cleared');
    assert.equal((await client.query(`SELECT state FROM ${q}.security_subjects WHERE installation_id=$1`,[t.installations[1]!.id])).rows[0].state,'denied');
  }finally{await t.close();}
});

test('slow membership facts and blocked projections do not occupy the independent manager heartbeat connection',local,async()=>{
  const t=await fixture();let releaseFacts:()=>void=()=>{},releaseBusiness:()=>void=()=>{};try{
    const {publisher,client,q,f}=t;await publisher.start();const read=t.members.authorizationFacts;
    let entered!:()=>void;const factsEntered=new Promise<void>(resolve=>{entered=resolve;}),waitFacts=new Promise<void>(resolve=>{releaseFacts=resolve;});
    t.members.authorizationFacts=async(member,id)=>{entered();await waitFacts;return read(member,id);};
    const publish=publisher.publish(f.member.id,t.installations[0]!.id);await factsEntered;
    await t.database.run(async c=>{await c.query('SELECT 1');});releaseFacts();await publish;t.members.authorizationFacts=read;
    let blocked!:()=>void;const lockHeld=new Promise<void>(resolve=>{blocked=resolve;}),waitBusiness=new Promise<void>(resolve=>{releaseBusiness=resolve;});
    await client.query(`UPDATE ${q}.security_subjects SET valid_until=$1`,[Date.now()-1]);
    const business=t.database.run(async()=>{blocked();await waitBusiness;});await lockHeld;
    const refresh=publisher.refresh();await publisher.renew();await refresh;
    const subject=(await client.query(`SELECT state,epoch,valid_until FROM ${q}.security_subjects`)).rows[0];
    assert.equal(subject.state,'active');assert.equal(Number(subject.epoch),1);assert(Number(subject.valid_until)>Date.now()+58000);
    assert.equal((await client.query(`SELECT state FROM ${q}.security_grants WHERE id=$1`,[t.task.grant.id])).rows[0].state,'active');
    const lease=(await client.query(`SELECT expires_at FROM ${q}.security_manager`)).rows[0];assert(Number(lease.expires_at)>Date.now()+58000);
    releaseBusiness();await business;
  }finally{releaseFacts();releaseBusiness();await t.close();}
});

test('the real 30-second timer refreshes unchanged subjects past their old deadline while the business mutex stays held',{...local,timeout:45000},async()=>{
  const t=await fixture();let releaseBusiness:()=>void=()=>{};try{
    await t.publisher.start();const before=(await t.client.query(`SELECT token,expires_at FROM ${t.q}.security_manager`)).rows[0],oldSubjectUntil=Date.now()+35000;
    await t.client.query(`UPDATE ${t.q}.security_subjects SET valid_until=$1`,[oldSubjectUntil]);
    let entered!:()=>void;const held=new Promise<void>(resolve=>{entered=resolve;}),wait=new Promise<void>(resolve=>{releaseBusiness=resolve;});
    const business=t.database.run(async()=>{entered();await wait;});await held;await delay(36000);
    const manager=(await t.client.query(`SELECT token,expires_at FROM ${t.q}.security_manager`)).rows[0],subject=(await t.client.query(`SELECT state,epoch,valid_until FROM ${t.q}.security_subjects`)).rows[0];
    assert.equal(manager.token,before.token);assert(Number(manager.expires_at)>Number(before.expires_at)+20000);
    assert(Date.now()>oldSubjectUntil);assert.equal(subject.state,'active');assert.equal(Number(subject.epoch),1);assert(Number(subject.valid_until)>Date.now()+45000);
    assert.equal(t.publisher.failure,undefined);releaseBusiness();await business;
  }finally{releaseBusiness();await t.close();}
});

test('a competing manager cannot replace a live token; expiry stops the original publisher without reacquisition',local,async()=>{
  const t=await fixture(),other=new PostgresAuthorizationPublisher(t.options);try{
    await t.publisher.start();const initial=(await t.client.query(`SELECT token FROM ${t.q}.security_manager`)).rows[0].token;
    await assert.rejects(other.start(),reason('AUTHORITY_UNAVAILABLE'));await other.close();
    await t.publisher.renew();assert.equal((await t.client.query(`SELECT token FROM ${t.q}.security_manager`)).rows[0].token,initial);
    await t.client.query(`UPDATE ${t.q}.security_manager SET expires_at=0`);await assert.rejects(t.publisher.renew(),reason('AUTHORITY_UNAVAILABLE'));
    assert.equal(t.publisher.failure?.operation,'renew');await assert.rejects(t.publisher.start(),/only start once/);await t.publisher.close();
    const row=(await t.client.query(`SELECT token,expires_at FROM ${t.q}.security_manager`)).rows[0];assert.equal(row.token,initial);assert.equal(Number(row.expires_at),0);
    await assert.rejects(t.publisher.publish(t.f.member.id,t.installations[0]!.id),reason('AUTHORITY_UNAVAILABLE'));
  }finally{await other.close();await t.close();}
});

test('fresh facts are bound to their observation deadline and an existing installation cannot change identity',local,async()=>{
  const t=await fixture(),realNow=Date.now;try{
    await t.publisher.start();const read=t.members.authorizationFacts,id=t.installations[0]!.id;
    const initial=(await t.client.query(`SELECT valid_until FROM ${t.q}.security_subjects WHERE installation_id=$1`,[id])).rows[0];
    t.members.authorizationFacts=async(member,installation)=>{const facts=await read(member,installation);Date.now=()=>realNow()+31000;return facts;};
    await assert.rejects(t.publisher.publish(t.f.member.id,id),reason('AUTHORITY_UNAVAILABLE'));Date.now=realNow;
    assert.equal((await t.client.query(`SELECT valid_until FROM ${t.q}.security_subjects WHERE installation_id=$1`,[id])).rows[0].valid_until,initial.valid_until);
    assert.equal(t.publisher.failure?.operation,'publish');await t.publisher.close();t.members.authorizationFacts=read;
    const restarted=new PostgresAuthorizationPublisher(t.options);await restarted.start();
    t.members.authorizationFacts=async(member,installation)=>({...await read(member,installation),clientId:'different-client'});
    try{await assert.rejects(restarted.publish(t.f.member.id,id),reason('POLICY_CHANGED'));}finally{await restarted.close();}
    assert.equal((await t.client.query(`SELECT client_id FROM ${t.q}.security_subjects WHERE installation_id=$1`,[id])).rows[0].client_id,t.f.principal.clientId);
  }finally{Date.now=realNow;await t.close();}
});

test('runtime, foundation policy and the reviewed subject bound are required before projection',local,async()=>{
  const t=await fixture(2),wrong=new PostgresAuthorizationPublisher({...t.options,policyDigest:'0'.repeat(64)}),bounded=new PostgresAuthorizationPublisher({...t.options,maxSubjects:1});try{
    await assert.rejects(wrong.start(),reason('AUTHORITY_UNAVAILABLE'));await wrong.close();
    await assert.rejects(bounded.start(),reason('AUTHORITY_UNAVAILABLE'));await bounded.close();
    assert.equal(Number((await t.client.query(`SELECT expires_at FROM ${t.q}.security_manager`)).rows[0].expires_at),0);
    assert.equal((await t.client.query(`SELECT count(*) AS n FROM ${t.q}.security_grants WHERE state='active'`)).rows[0].n,'3');
    const badRuntime=new PostgresAuthorizationPublisher({...t.options,runtime:{...t.runtime,revision:t.runtime.revision+1}});
    try{await assert.rejects(badRuntime.start(),reason('AUTHORITY_UNAVAILABLE'));}finally{await badRuntime.close();}
  }finally{await wrong.close();await bounded.close();await t.close();}
});

function observeControl(pool:pg.Pool,afterCommit:()=>void,afterBegin?:()=>void,afterQuery?:(text:unknown)=>Promise<void>):Pick<pg.Pool,'connect'>{
  return {connect:new Proxy(pool.connect.bind(pool),{apply(target,thisArg,args){
    return Promise.resolve(Reflect.apply(target,thisArg,args)).then((client:pg.PoolClient)=>{
      const query=client.query,release=client.release;
      client.query=new Proxy(query,{apply(fn,self,argumentsList){return Promise.resolve(Reflect.apply(fn,self,argumentsList)).then(async value=>{if(argumentsList[0]==='COMMIT')afterCommit();if(argumentsList[0]==='BEGIN ISOLATION LEVEL READ COMMITTED')afterBegin?.();await afterQuery?.(argumentsList[0]);return value;});}});
      client.release=error=>{client.query=query;client.release=release;release.call(client,error);};return client;
    });
  }})};
}

test('a lost BEGIN acknowledgement evicts its uncertain connection before another publisher can acquire',local,async()=>{
  const t=await fixture();let lose=true;const publisher=new PostgresAuthorizationPublisher({...t.options,controlPool:observeControl(t.controlPool,()=>{},()=>{if(lose){lose=false;throw new Error('Synthetic BEGIN acknowledgement loss');}})});
  try{
    await assert.rejects(publisher.start(),reason('AUTHORITY_UNAVAILABLE'));assert.equal(publisher.failure?.operation,'start');await publisher.close();
    await t.publisher.start();const token=(await t.client.query(`SELECT token FROM ${t.q}.security_manager`)).rows[0].token;assert.equal(typeof token,'string');
    await publisher.close();assert.equal((await t.client.query(`SELECT token FROM ${t.q}.security_manager`)).rows[0].token,token);
  }finally{await publisher.close();await t.close();}
});

test('unknown control COMMIT acknowledgements retain their first cause and never advertise a running publisher',local,async()=>{
  const t=await fixture();let lose=true;const wire=new Error('Synthetic acknowledgement connection loss');
  const publisher=new PostgresAuthorizationPublisher({...t.options,controlPool:observeControl(t.controlPool,()=>{if(lose){lose=false;throw wire;}})});
  try{
    await assert.rejects(publisher.start(),reason('AUTHORITY_UNAVAILABLE'));const failure=publisher.failure;assert.equal(failure?.operation,'start');
    assert(failure?.cause instanceof Error);assert.equal(failure.cause.cause,wire);await publisher.close();
    assert.equal(Number((await t.client.query(`SELECT expires_at FROM ${t.q}.security_manager`)).rows[0].expires_at),0);
    await assert.rejects(publisher.authenticate(t.f.principal,t.installations[0]!.token),reason('AUTHORITY_UNAVAILABLE'));
  }finally{await publisher.close();await t.close();}
});

test('an uncertain unchanged-subject publication stops the publisher and preserves the failure for diagnosis',local,async()=>{
  const t=await fixture();let lose=false;const wire=new Error('Synthetic projection acknowledgement loss');
  const publisher=new PostgresAuthorizationPublisher({...t.options,controlPool:observeControl(t.controlPool,()=>{if(lose){lose=false;throw wire;}})});
  try{
    await publisher.start();lose=true;await assert.rejects(publisher.publish(t.f.member.id,t.installations[0]!.id),/commit outcome is unknown/);
    assert.equal(publisher.failure?.operation,'publish');await publisher.close();
    assert.equal(Number((await t.client.query(`SELECT expires_at FROM ${t.q}.security_manager`)).rows[0].expires_at),0);
    assert.equal((await t.client.query(`SELECT state FROM ${t.q}.security_grants WHERE id=$1`,[t.task.grant.id])).rows[0].state,'active');
    await assert.rejects(publisher.authenticate(t.f.principal,t.installations[0]!.token),reason('AUTHORITY_UNAVAILABLE'));
  }finally{await publisher.close();await t.close();}
});

test('the control watchdog also bounds connection acquisition and discards a late-arriving client',{...local,timeout:30000},async()=>{
  const t=await fixture();let delayed=true,arrived!:()=>void,releaseConnection:()=>void=()=>{};
  const entered=new Promise<void>(resolve=>{arrived=resolve;}),waiting=new Promise<void>(resolve=>{releaseConnection=resolve;});
  const controlPool:Pick<pg.Pool,'connect'>={connect:new Proxy(t.controlPool.connect.bind(t.controlPool),{apply(fn,self,args){return Promise.resolve(Reflect.apply(fn,self,args)).then(async(client:pg.PoolClient)=>{if(delayed){delayed=false;arrived();await waiting;}return client;});}})};
  const publisher=new PostgresAuthorizationPublisher({...t.options,controlPool});
  try{
    const starting=publisher.start();await entered;await assert.rejects(starting,reason('AUTHORITY_UNAVAILABLE'));
    assert(publisher.failure?.cause instanceof Error);assert.match(publisher.failure.cause.message,/acknowledgement timed out/);
    releaseConnection();await publisher.close();await t.publisher.start();
    const token=(await t.client.query(`SELECT token FROM ${t.q}.security_manager`)).rows[0].token;
    await delay(25);assert.equal((await t.client.query(`SELECT token FROM ${t.q}.security_manager`)).rows[0].token,token);
  }finally{releaseConnection();await publisher.close();await t.close();}
});

test('the 10-second acknowledgement watchdog evicts a lost reply and late completion cannot revive its old manager',{...local,timeout:30000},async()=>{
  const t=await fixture();let hold=false,releaseAck:()=>void=()=>{},entered!:()=>void;
  const ack=new Promise<void>(resolve=>{releaseAck=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  const publisher=new PostgresAuthorizationPublisher({...t.options,controlPool:observeControl(t.controlPool,()=>{},undefined,async text=>{if(hold&&text==='COMMIT'){hold=false;entered();await ack;}})});
  let timeout:unknown;
  try{
    await publisher.start();const originalToken=(await t.client.query(`SELECT token FROM ${t.q}.security_manager`)).rows[0].token;hold=true;
    const renew=publisher.renew();await waiting;
    try{await renew;assert.fail('A lost acknowledgement must time out');}catch(error){timeout=error;}
    assert(timeout instanceof Error);assert.match(timeout.message,/acknowledgement timed out after 10000 ms/);assert.equal(publisher.failure?.cause,timeout);
    assert.equal(publisher.failure?.operation,'renew');await publisher.close();
    await t.publisher.start();const currentToken=(await t.client.query(`SELECT token FROM ${t.q}.security_manager`)).rows[0].token;assert.notEqual(currentToken,originalToken);
    releaseAck();await delay(50);assert.equal(publisher.failure?.cause,timeout);
    await assert.rejects(publisher.renew(),reason('AUTHORITY_UNAVAILABLE'));await publisher.close();
    assert.equal((await t.client.query(`SELECT token FROM ${t.q}.security_manager`)).rows[0].token,currentToken);
  }finally{releaseAck();await publisher.close();await t.close();}
});

test('a lease acknowledged after its fixed deadline fails closed even when the server committed renewal',local,async()=>{
  const t=await fixture(),realNow=Date.now;let late=false;
  const publisher=new PostgresAuthorizationPublisher({...t.options,controlPool:observeControl(t.controlPool,()=>{if(late){late=false;Date.now=()=>realNow()+61000;}})});
  try{
    await publisher.start();late=true;await assert.rejects(publisher.renew(),reason('AUTHORITY_UNAVAILABLE'));assert.equal(publisher.failure?.operation,'renew');
    Date.now=realNow;await publisher.close();assert.equal(Number((await t.client.query(`SELECT expires_at FROM ${t.q}.security_manager`)).rows[0].expires_at),0);
  }finally{Date.now=realNow;await publisher.close();await t.close();}
});
