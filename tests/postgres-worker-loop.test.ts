import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { PostgresTaskCommandService } from '../packages/postgres/task-command-service.js';
import { PostgresWorkerStore } from '../packages/postgres/worker-store.js';
import { PostgresTaskWorker } from '../apps/worker/postgres-worker.js';
import type {WorkClaim} from '../packages/core/store.js';

// Scheduling-only test doubles. No database, authorization decision, model or
// production Worker is started by these unit tests.
function syntheticClaim():WorkClaim{
  const at='2026-01-01T00:00:00.000Z';
  return {owner:'synthetic-owner',token:'synthetic-original-token',job:{id:'synthetic-task',contextId:'synthetic-context',service:'eigos.delegate',goal:'Synthetic scheduling only',state:'working',revision:1,messages:[],createdAt:at,updatedAt:at}};
}
function schedulingStore(claim:WorkClaim){
  let claimed=false;
  return {claim:async()=>{if(claimed)return;claimed=true;return claim;},renew:async()=>true,active:async()=>true,
    releaseCheckpoint:async(_claim:WorkClaim,signal?:AbortSignal)=>{signal?.throwIfAborted();return true;},
    finish:async(_claim:WorkClaim,update:(job:WorkClaim['job'])=>void)=>{update(claim.job);return true;},
    beginModelUsage:async()=>{},finishModelUsage:async()=>{}};
}

test('the selected single-session Worker drains one original claim before claiming another',async()=>{
  const first=syntheticClaim(),second={...syntheticClaim(),token:'second-original-token',job:{...syntheticClaim().job,id:'second-original-task'}},queue=[first,second],store=schedulingStore(first),started:string[]=[];let claims=0,release!:()=>void;
  store.claim=async()=>{claims++;return queue.shift();};
  const loop=new PostgresTaskWorker(store,{maxConcurrent:1,pollMs:10000,run:async(claim,signal)=>{started.push(claim.token);await new Promise<void>(resolve=>{release=resolve;signal.addEventListener('abort',()=>resolve(),{once:true});});}});
  try{await loop.tick();await until(()=>started.length===1);assert.equal(claims,1);assert.deepEqual(started,[first.token]);release();await loop.pauseClaims();assert.equal(claims,1);loop.resumeClaims();await until(()=>started.length===2);assert.equal(claims,2);assert.deepEqual(started,[first.token,second.token]);}
  finally{await loop.close();}
});

test('the default SQL Worker keeps the existing five-minute execution deadline',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});const store=schedulingStore(syntheticClaim());let signal!:AbortSignal,started!:()=>void,failed!:()=>void;const running=new Promise<void>(resolve=>{started=resolve;}),ended=new Promise<void>(resolve=>{failed=resolve;});
  const loop=new PostgresTaskWorker(store,{pollMs:10000,run:async(_claim,current)=>{signal=current;started();await new Promise<void>(resolve=>current.addEventListener('abort',()=>resolve(),{once:true}));},onError:async(_claim,error)=>{assert(error instanceof Error);assert.equal(error.message,'Worker execution time budget ended');failed();}});
  try{await loop.tick();await running;context.mock.timers.tick(299999);assert.equal(signal.aborted,false);context.mock.timers.tick(1);await ended;assert.equal(signal.aborted,true);}
  finally{await loop.close();}
});

test('a returned host checkpoint uses one atomic release instead of a second active/read and empty finish',async()=>{
  const claim=syntheticClaim(),store=schedulingStore(claim);let active=0,released=0,finished=0;
  store.active=async()=>{active++;return true;};
  store.releaseCheckpoint=async(original,signal)=>{assert.equal(original,claim);signal?.throwIfAborted();released++;return true;};
  store.finish=async()=>{finished++;throw new Error('No result mutation belongs to checkpoint release');};
  const loop=new PostgresTaskWorker(store,{run:async()=>{},leaseMs:15000,pollMs:10000,timeoutMs:600000});
  try{await loop.tick();await until(()=>released===1);await loop.pauseClaims();assert.equal(active,1);assert.equal(finished,0);assert.equal(released,1);}
  finally{await loop.close();}
});

test('a committed checkpoint cannot be mistaken for heartbeat lease loss while its response is pending',async context=>{
  context.mock.timers.enable({apis:['setInterval','setTimeout']});
  const claim=syntheticClaim(),store=schedulingStore(claim);let committed=false,afterRelease=0,observed:unknown;
  let acknowledge!:()=>void,entered!:()=>void;
  const acknowledgement=new Promise<void>(resolve=>{acknowledge=resolve;}),releaseEntered=new Promise<void>(resolve=>{entered=resolve;});
  store.renew=async()=>{if(committed)afterRelease++;return !committed;};
  store.releaseCheckpoint=async(_claim,signal)=>{committed=true;entered();await acknowledgement;signal?.throwIfAborted();return true;};
  const loop=new PostgresTaskWorker(store,{run:async()=>{},onError:async(_claim,error)=>{observed=error;},leaseMs:150,pollMs:10000,timeoutMs:5000});
  try{
    await loop.tick();await releaseEntered;
    context.mock.timers.tick(1000);await Promise.resolve();await Promise.resolve();
    acknowledge();await loop.pauseClaims();
    assert.equal(afterRelease,0,'A naturally released claim must not receive another heartbeat');
    assert.equal(observed,undefined,'Delayed checkpoint acknowledgement is not a lost execution authority');
  }finally{acknowledge();await loop.close();}
});

test('checkpoint release drains an already started heartbeat and retains a real failed renewal',async context=>{
  for(const valid of [true,false])await context.test(String(valid),async t=>{
    t.mock.timers.enable({apis:['setInterval','setTimeout']});
    const claim=syntheticClaim(),store=schedulingStore(claim);let releases=0,observed:unknown;
    let finishHandler!:()=>void,renewed!:(valid:boolean)=>void,started!:()=>void,renewStarted!:()=>void;
    const handler=new Promise<void>(resolve=>{finishHandler=resolve;}),renewal=new Promise<boolean>(resolve=>{renewed=resolve;});
    const handlerStarted=new Promise<void>(resolve=>{started=resolve;}),heartbeatStarted=new Promise<void>(resolve=>{renewStarted=resolve;});
    store.renew=()=>{renewStarted();return renewal;};
    store.releaseCheckpoint=async(_claim,signal)=>{signal?.throwIfAborted();releases++;return true;};
    const loop=new PostgresTaskWorker(store,{run:async()=>{started();await handler;},onError:async(_claim,error)=>{observed=error;},leaseMs:150,pollMs:10000,timeoutMs:5000});
    try{
      await loop.tick();await handlerStarted;t.mock.timers.tick(50);await heartbeatStarted;finishHandler();
      for(let i=0;i<8;i++)await Promise.resolve();
      assert.equal(releases,0,'The outstanding renewal must settle before releasing its original claim');
      renewed(valid);await loop.pauseClaims();assert.equal(releases,valid?1:0);
      if(valid)assert.equal(observed,undefined);else{assert(observed instanceof Error);assert.equal(observed.message,'The original Worker lease or authority ended');}
    }finally{finishHandler();renewed(valid);await loop.close();}
  });
});

test('checkpoint release retains the original execution-budget abort',async()=>{
  const claim=syntheticClaim(),store=schedulingStore(claim);let aborted=false,finished=0;let observed:unknown;
  store.releaseCheckpoint=async(_claim,signal)=>{aborted=signal?.aborted===true;signal?.throwIfAborted();return true;};
  store.finish=async()=>{finished++;return true;};
  const loop=new PostgresTaskWorker(store,{run:async()=>{await delay(20);},onError:async(_claim,error)=>{observed=error;},leaseMs:15000,pollMs:10000,timeoutMs:5});
  try{await loop.tick();await until(()=>observed!==undefined);await loop.pauseClaims();assert(aborted);assert(observed instanceof Error);assert.equal(observed.message,'Worker execution time budget ended');assert.equal(finished,0);}
  finally{await loop.close();}
});

test('a handler that already finished is not written a second time',async()=>{
  const claim=syntheticClaim(),store=schedulingStore(claim);let finished=0,released=0,inactive=false;
  store.finish=async(_claim,update)=>{finished++;update(claim.job);inactive=true;return true;};
  store.releaseCheckpoint=async()=>{released++;assert(inactive);return false;};
  const loop=new PostgresTaskWorker(store,{run:async original=>{await store.finish(original,job=>{job.state='paused';job.question='Actual synthetic handler output';});},leaseMs:15000,pollMs:10000,timeoutMs:600000});
  try{await loop.tick();await until(()=>released===1);await loop.pauseClaims();assert.equal(finished,1);assert.equal(claim.job.question,'Actual synthetic handler output');}
  finally{await loop.close();}
});

async function until(check: () => boolean | Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() >= deadline) throw new Error('Synthetic Worker condition did not complete'); await delay(25); }
}

test('real PostgreSQL checkpoint acknowledgement cannot lose an already released original Worker token',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async context=>{
   for(const mode of ['checkpoint','finished'] as const)await context.test(mode,async()=>{
    const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined,loop:PostgresTaskWorker|undefined;
    let acknowledge!:()=>void;const acknowledgement=new Promise<void>(resolve=>{acknowledge=resolve;});
    try{
      const installation=f.installation('Synthetic checkpoint acknowledgement',3600000);f.approve(installation.id);
      const principal={...f.principal,scopes:['tasks:write'],access:f.coordinator.authenticate({...f.principal,scopes:['tasks:write']},installation.token)};
      target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`;
      const task=await new PostgresTaskCommandService(t.database,t.policy).submit(principal,{requestId:'checkpoint-heartbeat-race',goal:'Synthetic scheduling fixture; no model or business effect.'});
      const store=new PostgresWorkerStore(t.database,t.policy),release=store.releaseCheckpoint.bind(store),finish=store.finish.bind(store),renew=store.renew.bind(store);
      let committed=false,renewalsAfterCommit=0,body:unknown;const failures:unknown[]=[];
      store.renew=(...args)=>{if(committed)renewalsAfterCommit++;return renew(...args);};
      if(mode==='checkpoint')store.releaseCheckpoint=async(claim,signal)=>{
        const result=await release(claim,signal);assert.equal(result,true);committed=true;
        await acknowledgement;signal?.throwIfAborted();return result;
      };
      else store.finish=async(...args)=>{
        const result=await finish(...args);assert.equal(result,true);
        body=(await t.client.query(`SELECT body FROM ${q}.jobs WHERE id=$1`,[task.id])).rows[0].body;committed=true;
        await acknowledgement;return result;
      };
      loop=new PostgresTaskWorker(store,{leaseMs:5000,pollMs:10000,timeoutMs:30000,
        run:async claim=>{if(mode==='finished')await store.finish(claim,job=>{job.state='paused';});else body=(await t.client.query(`SELECT body FROM ${q}.jobs WHERE id=$1`,[task.id])).rows[0].body;},
        onError:async(_claim,error)=>{failures.push(error);}});
      await loop.tick();await until(()=>committed);await delay(2000);acknowledge();await loop.pauseClaims();
      assert.equal(renewalsAfterCommit,0,'An actual committed checkpoint must not be renewed by its finished Worker');assert.deepEqual(failures,[]);
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.work_claims`)).rows[0].n),0);
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.runtime_work_claims`)).rows[0].n),0);
      assert.equal((await t.client.query(`SELECT body FROM ${q}.jobs WHERE id=$1`,[task.id])).rows[0].body,body,'Checkpoint acknowledgement cannot rewrite the original task');
    }finally{acknowledge();await loop?.close();if(target)await target.close();f.close();}
   });
  });

test('the SQL Worker drains its two original claims, renews while executing, and aborts canceled work before writeback',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true }); let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined, loop: PostgresTaskWorker | undefined;
    const release = new Map<string, () => void>(), started = new Set<string>(), ended = new Set<string>();
    try {
      const installation = f.installation('Synthetic SQL Worker loop', 3600000); f.approve(installation.id);
      const principal = { ...f.principal, scopes: ['tasks:write'], access: f.coordinator.authenticate({ ...f.principal, scopes: ['tasks:write'] }, installation.token) };
      target = await importPostgresFixture(f); const t = target, q = `"${t.schema}"`;
      const service = new PostgresTaskCommandService(t.database, t.policy), store = new PostgresWorkerStore(t.database, t.policy);
      const tasks = [];
      for (let i = 0; i < 3; i++) tasks.push(await service.submit(principal, { requestId: `sql-loop-${i}`, goal: `Synthetic original SQL queue ${i}` }));
      let active = 0, maximum = 0, canceledWrite: boolean | undefined;
      loop = new PostgresTaskWorker(store, { leaseMs: 5000, pollMs: 50, timeoutMs: 60000, run: async (claim, signal) => {
        active++; maximum = Math.max(maximum, active); started.add(claim.job.id);
        try {
          await new Promise<void>(resolve => { release.set(claim.job.id, resolve); signal.addEventListener('abort', () => resolve(), { once: true }); });
          if (signal.aborted) { canceledWrite = await store.finish(claim, job => { job.state = 'completed'; }); return; }
          assert(await store.finish(claim, job => { job.state = 'paused'; }));
        } finally { active--; ended.add(claim.job.id); }
      } });
      loop.start(); await until(() => started.size === 2);
      const initial = (await t.client.query(`SELECT job_id,token,expires_at FROM ${q}.work_claims ORDER BY job_id`)).rows;
      assert.equal(initial.length, 2); await delay(5600);
      const renewed = (await t.client.query(`SELECT job_id,token,expires_at FROM ${q}.work_claims ORDER BY job_id`)).rows;
      assert.deepEqual(renewed.map(row => [row.job_id, row.token]), initial.map(row => [row.job_id, row.token]));
      assert(renewed.every((row, i) => Number(row.expires_at) > Number(initial[i]!.expires_at)));
      let drained = false; const pause = loop.pauseClaims().then(() => { drained = true; }); await delay(20); assert.equal(drained, false);
      for (const id of started) release.get(id)!(); await pause; assert.equal(started.size, 2); assert.equal(ended.size, 2);
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.work_claims`)).rows[0]!.n), 0);
      const third = tasks.find(task => !started.has(task.id))!; loop.resumeClaims(); await until(() => started.has(third.id));
      await service.cancel(principal, third.id); await until(() => ended.has(third.id));
      assert.equal(canceledWrite, false); assert.equal((await t.client.query(`SELECT state FROM ${q}.jobs WHERE id=$1`, [third.id])).rows[0]!.state, 'canceled');
      assert.equal(maximum, 2); await loop.close(); loop = undefined;
    } finally { for (const done of release.values()) done(); await loop?.close(); if (target) await target.close(); f.close(); }
  });
