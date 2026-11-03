import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {digest} from '../packages/core/delegation.js';
import {SecurityError} from '../packages/security/errors.js';
import {agentAccessGrantSchema,taskDataGrantSchema} from '../packages/security/contracts.js';
import {postgresInspectEligibility} from '../packages/postgres/eligibility-inspection.js';
import type {PostgresEligibilityReference} from '../packages/postgres/eligibility-reference.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresPrimaryFixture} from './fixtures/postgres-primary.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
const reason=(value:SecurityError['reason'])=>(error:unknown)=>error instanceof SecurityError&&error.reason===value;
async function fixture(){
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic current eligibility',3600000),parent=f.approve(installation.id),task=f.task(installation.id);
    target=await importPostgresPrimaryFixture(f);const t=target,pool=new pg.Pool({max:2}),q=`"${t.schema}"`;
    const token=(await t.client.query(`SELECT token FROM ${q}.security_manager`)).rows[0].token;
    const policyRevision=Number((await t.client.query(`SELECT revision FROM ${q}.security_policy WHERE slot=1`)).rows[0].revision);
    const reference:PostgresEligibilityReference={ownerKey:f.owner,memberId:f.member.id,installationId:installation.id,clientId:f.principal.clientId,authEpoch:1,
      policyRevision,policyDigest:t.policy,managerTokenDigest:digest(token),parentGrant:{id:parent.id,revision:parent.revision,bodyDigest:digest(parent)},
      taskGrant:{id:task.grant.id,revision:task.grant.revision,bodyDigest:digest(task.grant),taskId:task.job.id,requestRevision:task.grant.requestRevision}};
    const inspect=(ref=reference,using:Pick<pg.Pool,'connect'>=pool)=>postgresInspectEligibility(using,t.schema,t.authority,ref);
    return {f,t,pool,q,reference,parent,task,installation,inspect,close:async()=>{await pool.end();await t.close();f.close();}};
  }catch(error){if(target)await target.close();f.close();throw error;}
}
function instrument(pool:pg.Pool,hooks:{acquired?:(client:pg.PoolClient)=>Promise<void>;replied?:(text:unknown,query:pg.PoolClient['query'])=>Promise<void>}={}){
  const stats={evictions:0,commits:0,begins:0};
  const wrapped:Pick<pg.Pool,'connect'>={connect:new Proxy(pool.connect.bind(pool),{apply(fn,self,args){return Promise.resolve(Reflect.apply(fn,self,args)).then(async(client:pg.PoolClient)=>{
    const query=client.query,release=client.release;
    client.query=new Proxy(query,{apply(method,target,values){return Promise.resolve(Reflect.apply(method,target,values)).then(async result=>{
      if(typeof values[0]==='string'&&values[0].startsWith('BEGIN'))stats.begins++;if(values[0]==='COMMIT')stats.commits++;
      await hooks.replied?.(values[0],query.bind(client));return result;
    });}});
    client.release=error=>{if(error)stats.evictions++;client.query=query;client.release=release;release.call(client,error);};await hooks.acquired?.(client);return client;
  });}})};return {wrapped,stats};
}

test('fresh original-token eligibility survives expiration of an old business snapshot without taking its mutex',local,async()=>{
  const x=await fixture();try{
    const oldUntil=Date.now()+5000;
    await x.t.client.query(`UPDATE ${x.q}.security_manager SET expires_at=$1`,[oldUntil]);await x.t.client.query(`UPDATE ${x.q}.security_subjects SET valid_until=$1`,[oldUntil]);
    const grants=(await x.t.client.query(`SELECT id,revision,state,expires_at,body FROM ${x.q}.security_grants ORDER BY id`)).rows;
    await x.t.database.run(async client=>{
      const old=(await client.query(`SELECT m.expires_at,s.valid_until FROM ${x.q}.security_manager m CROSS JOIN ${x.q}.security_subjects s`)).rows[0];
      await x.t.publisher.renew();await x.t.publisher.publish(x.f.member.id,x.installation.id);await delay(5100);
      assert(Number(old.expires_at)<=Date.now());assert(Number(old.valid_until)<=Date.now());
      const result=await x.inspect();assert(result.validUntil>Date.now()+30000);
      assert(result.validUntil<=Date.parse(x.parent.expiresAt));assert(result.validUntil<=Date.parse(x.task.grant.expiresAt));
      const snapshot=(await client.query(`SELECT expires_at FROM ${x.q}.security_manager`)).rows[0];assert.equal(Number(snapshot.expires_at),Number(old.expires_at));
    });
    assert.deepEqual((await x.t.client.query(`SELECT id,revision,state,expires_at,body FROM ${x.q}.security_grants ORDER BY id`)).rows,grants);
  }finally{await x.close();}
});

test('eligibility inspection is read-only/read-committed, with bounded settings and no business authority row lock',local,async()=>{
  const x=await fixture();try{
    const statements:string[]=[],settings:Record<string,string>={};let checked=false;
    const {wrapped}=instrument(x.pool,{replied:async(text,query)=>{
      if(typeof text==='string')statements.push(text);
      if(!checked&&typeof text==='string'&&text.startsWith('SELECT')&&text.includes('manager_until')){
        checked=true;for(const name of ['transaction_read_only','transaction_isolation','statement_timeout','lock_timeout','idle_in_transaction_session_timeout'])settings[name]=(await query(`SELECT current_setting('${name}') AS value`)).rows[0].value;
      }
    }});
    assert((await x.inspect(x.reference,wrapped)).validUntil>Date.now());
    assert.deepEqual(settings,{transaction_read_only:'on',transaction_isolation:'read committed',statement_timeout:'10s',lock_timeout:'5s',idle_in_transaction_session_timeout:'10s'});
    assert(!statements.some(sql=>/eigos_lock_runtime_authority|LOCK TABLE|^UPDATE|^INSERT|^DELETE/.test(sql)));
    const parentOnly={...x.reference,taskGrant:undefined};assert((await x.inspect(parentOnly)).validUntil>Date.now());
  }finally{await x.close();}
});

test('original token, runtime and exact policy configuration are mandatory',local,async()=>{
  const x=await fixture();try{
    await assert.rejects(x.inspect({...x.reference,managerTokenDigest:digest(randomUUID())}),reason('AUTHORITY_UNAVAILABLE'));
    await assert.rejects(postgresInspectEligibility(x.pool,x.t.schema,{...x.t.authority,revision:x.t.authority.revision+1},x.reference),reason('AUTHORITY_UNAVAILABLE'));
    await assert.rejects(postgresInspectEligibility(x.pool,x.t.schema,{...x.t.authority,id:'another-runtime'},x.reference),reason('AUTHORITY_UNAVAILABLE'));
    await assert.rejects(postgresInspectEligibility(x.pool,x.t.schema,{...x.t.authority,digest:'0'.repeat(64)},x.reference),reason('AUTHORITY_UNAVAILABLE'));
    const expiry=(await x.t.client.query(`SELECT expires_at FROM ${x.q}.security_manager`)).rows[0].expires_at;
    await x.t.client.query(`UPDATE ${x.q}.security_manager SET expires_at=$1`,[Date.now()-1]);await assert.rejects(x.inspect(),reason('AUTHORITY_UNAVAILABLE'));await x.t.client.query(`UPDATE ${x.q}.security_manager SET expires_at=$1`,[expiry]);
    await assert.rejects(x.inspect({...x.reference,policyRevision:x.reference.policyRevision+1}),reason('AUTHORITY_UNAVAILABLE'));
    await assert.rejects(x.inspect({...x.reference,policyDigest:'0'.repeat(64)}),reason('AUTHORITY_UNAVAILABLE'));
    await x.t.client.query(`UPDATE ${x.q}.security_settings SET mode='legacy'`);await assert.rejects(x.inspect(),reason('AUTHORITY_UNAVAILABLE'));await x.t.client.query(`UPDATE ${x.q}.security_settings SET mode='foundation'`);
    await x.t.client.query(`UPDATE ${x.q}.security_manager SET token=$1`,[randomUUID()]);await assert.rejects(x.inspect(),reason('AUTHORITY_UNAVAILABLE'));
  }finally{await x.close();}
});

test('denial, expiration, identity changes, epochs and fences cannot inherit a captured eligibility reference',local,async()=>{
  const x=await fixture();try{
    await assert.rejects(x.inspect({...x.reference,authEpoch:2}),reason('POLICY_CHANGED'));
    await assert.rejects(x.inspect({...x.reference,clientId:'another-client'}),reason('POLICY_CHANGED'));
    await x.t.client.query(`UPDATE ${x.q}.security_subjects SET state='denied'`);await assert.rejects(x.inspect(),reason('ACCESS_REVOKED'));await x.t.client.query(`UPDATE ${x.q}.security_subjects SET state='active'`);
    const old=(await x.t.client.query(`SELECT valid_until FROM ${x.q}.security_subjects`)).rows[0].valid_until;
    await x.t.client.query(`UPDATE ${x.q}.security_subjects SET valid_until=$1`,[Date.now()-1]);await assert.rejects(x.inspect(),reason('ACCESS_REVOKED'));await x.t.client.query(`UPDATE ${x.q}.security_subjects SET valid_until=$1`,[old]);
    await x.t.client.query(`INSERT INTO ${x.q}.security_fences(id,owner,kind,target_id,revision,state) VALUES($1,$2,'installation',$3,1,'pending')`,[randomUUID(),x.f.owner,x.installation.id]);
    await assert.rejects(x.inspect(),reason('ACCESS_REVOKED'));
    await x.t.client.query(`UPDATE ${x.q}.security_fences SET state='cleared'; UPDATE ${x.q}.security_subjects SET epoch=2`);await assert.rejects(x.inspect(),reason('POLICY_CHANGED'));
  }finally{await x.close();}
});

test('parent and task grants retain exact bodies, revisions, identity, parentage and fixed expiry',local,async()=>{
  const x=await fixture();try{
    const rows=(await x.t.client.query(`SELECT * FROM ${x.q}.security_grants ORDER BY id`)).rows,parent=rows.find(row=>row.id===x.parent.id)!,data=rows.find(row=>row.id===x.task.grant.id)!;
    const restore=async(row:Record<string,unknown>)=>{await x.t.client.query(`UPDATE ${x.q}.security_grants SET revision=$1,state=$2,expires_at=$3,body=$4,parent_id=$5,parent_revision=$6,owner=$8,member_id=$9,installation_id=$10 WHERE id=$7`,[row.revision,row.state,row.expires_at,row.body,row.parent_id,row.parent_revision,row.id,row.owner,row.member_id,row.installation_id]);};
    for(const row of [parent,data]){
      for(const field of ['owner','member_id','installation_id']){await x.t.client.query(`UPDATE ${x.q}.security_grants SET ${field}=$1 WHERE id=$2`,[field==='owner'?JSON.stringify(['synthetic-other','tenant','subject']):randomUUID(),row.id]);await assert.rejects(x.inspect(),reason('POLICY_CHANGED'));await restore(row);}
      await x.t.client.query(`UPDATE ${x.q}.security_grants SET revision=revision+1 WHERE id=$1`,[row.id]);await assert.rejects(x.inspect(),reason('POLICY_CHANGED'));await restore(row);
      await x.t.client.query(`UPDATE ${x.q}.security_grants SET body=$1 WHERE id=$2`,[JSON.stringify({...JSON.parse(row.body),expiresAt:new Date(Date.parse(JSON.parse(row.body).expiresAt)-1000).toISOString()}),row.id]);await assert.rejects(x.inspect(),reason('POLICY_CHANGED'));await restore(row);
      await x.t.client.query(`UPDATE ${x.q}.security_grants SET state='revoked' WHERE id=$1`,[row.id]);await assert.rejects(x.inspect(),reason('ACCESS_REVOKED'));if(row.id===data.id)assert((await x.inspect({...x.reference,taskGrant:undefined})).validUntil>Date.now());await restore(row);
      await x.t.client.query(`UPDATE ${x.q}.security_grants SET expires_at=$1 WHERE id=$2`,[Date.now()-1,row.id]);await assert.rejects(x.inspect(),reason('ACCESS_REVOKED'));await restore(row);
    }
    await assert.rejects(x.inspect({...x.reference,taskGrant:{...x.reference.taskGrant!,id:randomUUID()}}),reason('ACCESS_REVOKED'));
    await assert.rejects(x.inspect({...x.reference,taskGrant:{...x.reference.taskGrant!,requestRevision:2}}),reason('POLICY_CHANGED'));
    await assert.rejects(x.inspect({...x.reference,taskGrant:{...x.reference.taskGrant!,taskId:randomUUID()}}),reason('POLICY_CHANGED'));
    await x.t.client.query(`UPDATE ${x.q}.security_grants SET parent_id=$1 WHERE id=$2`,[randomUUID(),data.id]);await assert.rejects(x.inspect(),reason('POLICY_CHANGED'));await restore(data);
    const expired={...JSON.parse(data.body),issuedAt:new Date(Date.now()-3000).toISOString(),expiresAt:new Date(Date.now()-1000).toISOString()};
    await x.t.client.query(`UPDATE ${x.q}.security_grants SET body=$1 WHERE id=$2`,[JSON.stringify(expired),data.id]);
    await assert.rejects(x.inspect({...x.reference,taskGrant:{...x.reference.taskGrant!,bodyDigest:digest(taskDataGrantSchema.parse(expired))}}),reason('ACCESS_REVOKED'));await restore(data);
    const short=Date.now()+5000;await x.t.client.query(`UPDATE ${x.q}.security_grants SET expires_at=$1 WHERE id=$2`,[short,parent.id]);assert.equal((await x.inspect()).validUntil,short);await restore(parent);
    await x.t.client.query(`UPDATE ${x.q}.security_grants SET body=$1 WHERE id=$2`,[JSON.stringify({oversized:'x'.repeat(1048577)}),parent.id]);await assert.rejects(x.inspect(),reason('POLICY_CHANGED'));
  }finally{await x.close();}
});

test('expired fixed grant deadlines are rejected after COMMIT acknowledgement',local,async()=>{
  const x=await fixture();try{
    const body={...x.parent,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+1000).toISOString()};
    await x.t.client.query(`UPDATE ${x.q}.security_grants SET body=$1 WHERE id=$2`,[JSON.stringify(body),body.id]);
    const reference={...x.reference,parentGrant:{...x.reference.parentGrant,bodyDigest:digest(agentAccessGrantSchema.parse(body))}};
    const {wrapped}=instrument(x.pool,{replied:async text=>{if(text==='COMMIT')await delay(1200);}});
    await assert.rejects(x.inspect(reference,wrapped),reason('ACCESS_REVOKED'));
  }finally{await x.close();}
});

test('eligibility preflight, uncertain BEGIN and uncertain COMMIT evict without retry',local,async()=>{
  const x=await fixture();try{
    for(const phase of ['preflight','BEGIN','COMMIT']){
      const pool=new pg.Pool({max:1});let backend=0;const wire=new Error(`Synthetic ${phase} reply loss`);
      const {wrapped,stats}=instrument(pool,{acquired:async client=>{backend=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);if(phase==='preflight')await client.query('BEGIN');},replied:async text=>{if(phase==='BEGIN'&&typeof text==='string'&&text.startsWith('BEGIN ISOLATION')||phase==='COMMIT'&&text==='COMMIT')throw wire;}});
      try{
        await assert.rejects(x.inspect(x.reference,wrapped),reason('AUTHORITY_UNAVAILABLE'));assert.equal(stats.evictions,1);assert.equal(stats.commits,phase==='COMMIT'?1:0);
        const replacement=await pool.connect();try{assert.equal(replacement.getTransactionStatus(),'I');assert.notEqual(Number((await replacement.query('SELECT pg_backend_pid() AS pid')).rows[0].pid),backend);}finally{replacement.release();}
      }finally{await pool.end();}
    }
  }finally{await x.close();}
});

// This test budget also includes the real imported membership/business fixture
// and its cleanup. The application watchdog remains exactly 10 seconds below.
test('the eligibility watchdog bounds acquisition and rejects a late connection before BEGIN',{...local,timeout:60000},async()=>{
  const x=await fixture(),pool=new pg.Pool({max:1});let arrived!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{arrived=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const {wrapped,stats}=instrument(pool,{acquired:async()=>{arrived();await gate;}});
  try{
    const pending=x.inspect(x.reference,wrapped);await entered;await assert.rejects(pending,error=>reason('AUTHORITY_UNAVAILABLE')(error)&&error instanceof Error&&error.cause instanceof Error&&/timed out after 10000 ms/.test(error.cause.message));
    release();await delay(50);assert.equal(stats.evictions,1);assert.equal(stats.begins,0);assert.equal(stats.commits,0);
  }finally{release();await pool.end();await x.close();}
});

test('a lost eligibility COMMIT reply cannot adopt late validity or replace the original timeout cause',{...local,timeout:60000},async()=>{
  const x=await fixture(),pool=new pg.Pool({max:1});let arrived!:()=>void,release!:()=>void,adopted=false,hold=true;
  const entered=new Promise<void>(resolve=>{arrived=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const {wrapped,stats}=instrument(pool,{replied:async text=>{if(text==='COMMIT'&&hold){hold=false;arrived();await gate;}}});let failure:unknown;
  try{
    const pending=x.inspect(x.reference,wrapped);void pending.then(()=>{adopted=true;},()=>{});await entered;
    try{await pending;assert.fail('A lost reply must time out');}catch(error){failure=error;}
    assert(reason('AUTHORITY_UNAVAILABLE')(failure));assert(failure instanceof Error&&failure.cause instanceof Error);assert.match(failure.cause.message,/timed out after 10000 ms/);assert.equal(stats.evictions,1);assert.equal(stats.commits,1);
    assert((await x.inspect()).validUntil>Date.now());release();await delay(50);assert.equal(adopted,false);await assert.rejects(pending,error=>error===failure);assert.equal(stats.commits,1);
  }finally{release();await pool.end();await x.close();}
});

test('invalid schema and reference input are rejected before acquiring a connection',async()=>{
  let acquisitions=0;const pool={connect:new Proxy(new pg.Pool().connect,{apply(){acquisitions++;throw new Error('Must not connect');}})};
  await assert.rejects(postgresInspectEligibility(pool,'public',{id:'runtime',revision:1,digest:'0'.repeat(64)},{} as PostgresEligibilityReference),/Invalid PostgreSQL eligibility/);
  await assert.rejects(postgresInspectEligibility(pool,'eigos_business_synthetic',{id:'runtime',revision:1,digest:'0'.repeat(64)},{} as PostgresEligibilityReference),reason('POLICY_CHANGED'));assert.equal(acquisitions,0);
});
