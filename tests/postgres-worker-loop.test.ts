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
