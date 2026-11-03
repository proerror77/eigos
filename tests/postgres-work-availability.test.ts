import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type pg from 'pg';
import {PostgresDatabase} from '../packages/postgres/database.js';
import {postgresWorkAvailable} from '../packages/postgres/work-availability.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';

const authority={id:'synthetic-runtime',revision:1,digest:'a'.repeat(64)},schema='eigos_business_fixture';
const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
const row=(available=false)=>({id:authority.id,revision:'1',configuration_digest:authority.digest,available});
type Query={text:string;values:unknown[];query_timeout:number};
function poolFixture(query:(request:Query)=>Promise<{rowCount:number;rows:Record<string,unknown>[]}>) {
  const stats={connects:0,releases:0,evictions:0,queries:0,ends:0,leaseConnects:0,leaseEnds:0};
  const release=(error?:Error|boolean)=>{stats.releases++;if(error)stats.evictions++;};
  const client={pipeline:false,getTransactionStatus:()=> 'I',release,
    query:async(request:Query)=>{stats.queries++;return query(request);}} as unknown as pg.PoolClient;
  // node-postgres installs a new lease release function on every acquisition.
  const pool={connect:async()=>{stats.connects++;client.release=release;return client;},end:async()=>{stats.ends++;}};
  const lease={connect:async()=>{stats.leaseConnects++;throw new Error('Hint must not occupy heartbeat capacity');},end:async()=>{stats.leaseEnds++;}};
  return {stats,client,pool,lease,database:new PostgresDatabase(pool,schema,authority,{leasePool:lease})};
}

test('work availability is a fresh single autocommit metadata read with no heartbeat lease or result cache',async()=>{
  let current=false;const requests:Query[]=[],x=poolFixture(async request=>{requests.push(request);return {rowCount:1,rows:[row(current)]};});
  try{
    assert.equal(await x.database.workAvailable(),false);current=true;assert.equal(await x.database.workAvailable(),true);
    assert.equal(x.stats.connects,2);assert.equal(x.stats.releases,2);assert.equal(x.stats.evictions,0);assert.equal(x.stats.leaseConnects,0);
    assert(requests.every(request=>request.query_timeout===10000&&request.values[0]&&Number.isSafeInteger(request.values[1])));
    assert(requests.every(request=>!/(BEGIN|COMMIT|UPDATE |INSERT |DELETE |FOR UPDATE|eigos_business_mutex|eigos_lock_runtime_authority)/.test(request.text)));
    assert(requests.every(request=>request.text.includes('eigos_current_runtime_authority()')));
  }finally{await x.database.close();}assert.equal(x.stats.ends,1);assert.equal(x.stats.leaseEnds,1);
});

test('missing, mismatched or failed work hints reject instead of declaring an empty queue and release exactly once',async()=>{
  const error=new Error('Synthetic query reply loss');
  for(const reply of [async()=>{throw error;},async()=>({rowCount:0,rows:[]}),async()=>({rowCount:1,rows:[{...row(),configuration_digest:'b'.repeat(64)}]}),async()=>({rowCount:1,rows:[{...row(),available:null}]})]){
    const x=poolFixture(reply);try{await assert.rejects(x.database.workAvailable());assert.equal(x.stats.connects,1);assert.equal(x.stats.releases,1);assert.equal(x.stats.evictions,1);assert.equal(x.stats.leaseConnects,0);}finally{await x.database.close();}
  }
});

test('a work hint preserves a direct caller transaction and an owned non-idle pool lease is evicted before querying',async()=>{
  let queries=0,ended=0;
  const direct={pipeline:false,getTransactionStatus:()=> 'T',query:async()=>{queries++;},end:async()=>{ended++;}} as unknown as pg.Client;
  await assert.rejects(postgresWorkAvailable(direct,schema,authority),/idle, non-pipelined/);assert.equal(queries,0);assert.equal(ended,0);
  const x=poolFixture(async()=>({rowCount:1,rows:[row()]}));x.client.getTransactionStatus=()=> 'T';
  try{await assert.rejects(x.database.workAvailable(),/idle non-pipelined/);assert.equal(x.stats.queries,0);assert.equal(x.stats.releases,1);assert.equal(x.stats.evictions,1);}finally{await x.database.close();}
});

test('closing while work-hint acquisition is pending releases a late connection without starting a query',async()=>{
  const x=poolFixture(async()=>({rowCount:1,rows:[row()]}));let acquired!:(client:pg.PoolClient)=>void;
  x.pool.connect=()=>new Promise<pg.PoolClient>(resolve=>{x.stats.connects++;acquired=resolve;});
  const pending=x.database.workAvailable();await x.database.close();acquired(x.client);
  await assert.rejects(pending,/runtime is closing/);assert.equal(x.stats.releases,1);assert.equal(x.stats.queries,0);assert.equal(x.stats.leaseConnects,0);
});

async function fixture(){
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic work availability',3600000);f.approve(installation.id);
    const principal={...f.principal,scopes:['tasks:write'],access:f.coordinator.authenticate({...f.principal,scopes:['tasks:write']},installation.token)};
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`;
    const commands=new PostgresTaskCommandService(t.database,t.policy),worker=new PostgresWorkerStore(t.database,t.policy);
    const setJob=async(id:string,change:(body:Record<string,any>)=>void)=>{
      const job=JSON.parse(String((await t.client.query(`SELECT body FROM ${q}.jobs WHERE id=$1`,[id])).rows[0].body));change(job);
      await t.client.query(`UPDATE ${q}.jobs SET state=$1,body=$2 WHERE id=$3`,[job.state,JSON.stringify(job),id]);
    };
    return {f,t,q,commands,worker,principal,setJob,installation,close:async()=>{await t.close();f.close();}};
  }catch(error){if(target)await target.close();f.close();throw error;}
}

test('actual SQL hints cover normal/recovery scheduling and cleanup without granting or renewing a claim',local,async()=>{
  const x=await fixture();try{
    const {t,q,worker,commands,principal}=x;
    assert.equal(await t.database.workAvailable(),false);assert.equal(await worker.claim(['eigos.delegate'],30000),undefined);
    const task=await commands.submit(principal,{requestId:randomUUID(),goal:'Synthetic availability queue item'});
    const grants=await t.client.query(`SELECT id,revision,expires_at,state FROM ${q}.security_grants ORDER BY id`);
    assert.equal(await t.database.workAvailable(),true);
    assert.deepEqual((await t.client.query(`SELECT id,revision,expires_at,state FROM ${q}.security_grants ORDER BY id`)).rows,grants.rows);
    assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.work_claims`)).rows[0].n),0);
    await x.setJob(task.id,job=>{job.delegation.nextAt=Date.now()+60000;});assert.equal(await t.database.workAvailable(),false);
    await x.setJob(task.id,job=>{job.delegation.nextAt=0;job.authorityId='other-runtime';});assert.equal(await t.database.workAvailable(),false);
    assert.equal(await worker.claim(['eigos.delegate'],30000),undefined);
    await x.setJob(task.id,job=>{job.authorityId=t.authority.id;job.delegation.backendVersion='historical-backend';});assert.equal(await t.database.workAvailable(),false);
    // Restore the actual compiled backend from the original submission rather
    // than declaring a second supported backend or weakening current admission.
    const {BACKEND_VERSION}=await import('../packages/ontology/execution.js');
    await x.setJob(task.id,job=>{job.delegation.backendVersion=BACKEND_VERSION;job.executionMode='worker';});assert.equal(await t.database.workAvailable(),false);
    await x.setJob(task.id,job=>{job.executionMode='worker-security-v2';});
    const claim=await worker.claim(['eigos.delegate'],30000);assert(claim);assert.equal(claim.job.id,task.id);
    const before=(await t.client.query(`SELECT * FROM ${q}.work_claims WHERE job_id=$1`,[task.id])).rows;
    assert.equal(await t.database.workAvailable(),false);assert.deepEqual((await t.client.query(`SELECT * FROM ${q}.work_claims WHERE job_id=$1`,[task.id])).rows,before);
    await t.client.query(`DELETE FROM ${q}.runtime_work_claims WHERE job_id=$1`,[task.id]);assert.equal(await t.database.workAvailable(),true);
    await t.database.cleanupReleasedClaims();assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.work_claims`)).rows[0].n),1,'a hint or missing runtime row is not a proved finish');
    await t.client.query(`INSERT INTO ${q}.runtime_work_claims(job_id,token,authority_digest) VALUES($1,$2,$3)`,[task.id,claim.token,t.authority.digest]);
    await t.client.query(`UPDATE ${q}.work_claims SET expires_at=0 WHERE job_id=$1`,[task.id]);assert.equal(await t.database.workAvailable(),true);
    await t.client.query(`DELETE FROM ${q}.runtime_work_claims WHERE job_id=$1`,[task.id]);await t.client.query(`DELETE FROM ${q}.work_claims WHERE job_id=$1`,[task.id]);
    await x.setJob(task.id,job=>{job.state='completed';job.delegation.recoveryPending=false;});assert.equal(await t.database.workAvailable(),false);
    await x.setJob(task.id,job=>{job.delegation.recoveryPending=true;job.delegation.nextAt=Date.now()+60000;});assert.equal(await t.database.workAvailable(),false);
    await x.setJob(task.id,job=>{job.delegation.nextAt=0;});assert.equal(await t.database.workAvailable(),true);
    const recovery=await worker.claim(['eigos.delegate'],30000);assert(recovery);assert.equal(recovery.recovery,true);
    await t.client.query(`DELETE FROM ${q}.runtime_work_claims WHERE job_id=$1`,[task.id]);await t.client.query(`DELETE FROM ${q}.work_claims WHERE job_id=$1`,[task.id]);
    await t.client.query(`UPDATE ${q}.security_subjects SET state='denied' WHERE installation_id=$1`,[x.installation.id]);
    assert.equal(await t.database.workAvailable(),true,'a positive scheduling hint carries no eligibility assertion');
    assert.equal(await worker.claim(['eigos.delegate'],30000),undefined,'actual claim still denies revoked eligibility');
  }finally{await x.close();}
});

test('actual work hints return only metadata while the business mutex and authority row are locked elsewhere',local,async()=>{
  const x=await fixture();let opened=false;try{
    const {t,q}=x;await x.commands.submit(x.principal,{requestId:randomUUID(),goal:'Synthetic lock-independent queue hint'});
    await t.client.query('BEGIN');opened=true;await t.client.query(`LOCK TABLE ${q}.eigos_business_mutex IN EXCLUSIVE MODE`);await t.client.query(`SELECT * FROM ${q}.eigos_lock_runtime_authority()`);
    const started=Date.now(),pending=t.database.workAvailable();let available:boolean;
    try{available=await Promise.race([pending,delay(2000).then(()=>{throw new Error('Availability waited for the business lock');})]);}
    finally{await t.client.query('ROLLBACK');opened=false;await pending.catch(()=>{});}
    assert.equal(available,true);assert(Date.now()-started<2000);
    const observed={pipeline:false,getTransactionStatus:()=>t.client.getTransactionStatus(),query:async(request:Query)=>{
      const result=await t.client.query(request);assert(Buffer.byteLength(JSON.stringify(result.rows))<1000);assert.deepEqual(Object.keys(result.rows[0]!).sort(),['available','configuration_digest','id','revision']);return result;
    }} as unknown as pg.Client;
    assert.equal(await postgresWorkAvailable(observed,t.schema,t.authority),true);
    await assert.rejects(postgresWorkAvailable(observed,t.schema,{...t.authority,digest:'b'.repeat(64)}),/authority changed/);
  }finally{if(opened)await x.t.client.query('ROLLBACK');await x.close();}
});

test('paused histories are excluded by CASE before parsing their body',local,async()=>{
  const x=await fixture();let definition:string|undefined;try{
    const {t,q}=x,id=randomUUID(),marker='SYNTHETIC_PAUSED_BODY_MUST_NOT_BE_PARSED';
    await t.client.query(`INSERT INTO ${q}.jobs(id,owner,context_id,state,created_at,updated_at,body) VALUES($1,$2,$3,'paused','synthetic','synthetic',$4)`,[id,x.f.owner,randomUUID(),JSON.stringify({marker})]);
    definition=String((await t.client.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[`${q}.eigos_try_jsonb(text)`])).rows[0].definition);
    await t.client.query(`CREATE OR REPLACE FUNCTION ${q}.eigos_try_jsonb(value TEXT) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER AS $$ BEGIN IF position('${marker}' IN value)>0 THEN RAISE EXCEPTION 'Paused task was parsed'; END IF; RETURN value::jsonb; EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR untranslatable_character THEN RETURN NULL; END; $$`);
    assert.equal(await t.database.workAvailable(),false);
  }finally{if(definition)await x.t.client.query(definition);await x.close();}
});
