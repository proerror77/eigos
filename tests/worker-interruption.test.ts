import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from '../apps/worker/worker.js';
import { securityFixture } from './fixtures/security.js';
import { authorizationScope, type AuthorizationScope } from '../packages/security/context.js';
import { SecurityError } from '../packages/security/store.js';
import type { WorkClaim } from '../packages/core/store.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('cutover drains current work before pausing new claims and resumes explicitly', { timeout: 60000 }, async () => {
  const f = securityFixture(), install = f.installation('Cutover drain'); f.approve(install.id); f.task(install.id);
  let enter!: () => void, release!: () => void, next!: () => void, firstSignal: AbortSignal | undefined, calls=0;
  const started=new Promise<void>(resolve=>{enter=resolve;}), gate=new Promise<void>(resolve=>{release=resolve;}), nextStarted=new Promise<void>(resolve=>{next=resolve;});
  const worker=new Worker(f.jobs,{leaseMs:30000,pollMs:20,timeoutMs:60000,coordinator:{
    run:async (_claim,signal)=>{if(++calls===1){firstSignal=signal;enter();await gate;}else{next();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));}},
  }});
  try {
    worker.tick(); await started;
    const paused=worker.pauseClaims(), later=f.task(install.id);
    worker.tick(); await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(calls,1); assert.equal(firstSignal?.aborted,false);
    assert.equal(f.jobs.get(f.owner,later.job.id).state,'submitted');
    assert.equal(await Promise.race([paused.then(()=> 'paused'),new Promise<string>(resolve=>setTimeout(()=>resolve('pending'),100))]),'pending');
    release(); await paused;
    assert.equal(firstSignal?.aborted,false); assert.equal(calls,1);
    f.coordinator.close();
    assert.equal(f.jobs.security.workAuthority(f.owner,later.job.id),undefined,'Gateway shutdown releases the manager lease');
    worker.tick(); assert.equal(calls,1);
    f.coordinator.start();
    assert(f.jobs.security.workAuthority(f.owner,later.job.id),'Gateway recovery republishes the existing authority');
    worker.resumeClaims(); await nextStarted;
    assert.equal(calls,2);
  } finally { release(); await worker.close(); f.close(); }
});

test('a model context cleanup rejection is distinguished from committed recovery writeback', async t => {
  const f = securityFixture(), install = f.installation('Cleanup boundary');
  f.approve(install.id); const task = f.task(install.id), warnings: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { if (String(args[0]).startsWith('Worker ')) warnings.push(args); });
  const secret = 'private-fixture-message-and-path-never-log';
  let released!: () => void; const cleanup = new Promise<void>(resolve => { released = resolve; });
  const worker = new Worker(f.jobs, { leaseMs: 30000, coordinator: {
    run: async () => { throw new Error('Synthetic model interruption'); },
    releaseModelContext: async () => {
      released(); const error = new SecurityError('OUTPUT_NOT_ALLOWED', secret);
      error.stack = `SecurityError: ${secret}\n at controller (file:///private/${secret}/dist/packages/security/policy-store.js:777:9)\n at ignored (/private/${secret}.js:1:2)`;
      throw error;
    },
  } });
  try {
    worker.tick(); await cleanup; await turn(); await worker.close();
    assert.equal(f.jobs.get(f.owner, task.job.id).delegation!.recovery?.code, 'model_unavailable');
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]![0]), /^Worker cleanup failed/);
    const detail = warnings[0]![1]; assert(detail && typeof detail === 'object');
    assert('phase' in detail && 'recoveryWriteback' in detail && 'origins' in detail);
    assert.equal(detail.phase, 'model_context_cleanup'); assert.equal(detail.recoveryWriteback, 'committed');
    assert.deepEqual(detail.origins, ['packages/security/policy-store.js:777:9']);
    assert(!JSON.stringify(warnings).includes(secret));
    assert.equal(f.jobs.security.listGrants(f.owner).filter(grant => grant.kind === 'task_data').length, 1);
  } finally { await worker.close(); f.close(); }
});

test('cleanup cannot hide an earlier recovery writeback rejection', async t => {
  const f = securityFixture(), install = f.installation('Two rejected phases');
  f.approve(install.id); const task = f.task(install.id), warnings: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { if (String(args[0]).startsWith('Worker ')) warnings.push(args); });
  t.mock.method(f.jobs, 'finish', () => { throw new SecurityError('OUTPUT_NOT_ALLOWED'); });
  let released!: () => void; const cleanup = new Promise<void>(resolve => { released = resolve; });
  let before: ReturnType<typeof f.jobs.get> | undefined;
  const worker = new Worker(f.jobs, { leaseMs: 30000, coordinator: {
    run: async () => { before = f.jobs.get(f.owner, task.job.id); throw new Error('Synthetic model interruption'); },
    releaseModelContext: async () => { released(); throw new SecurityError('ACCESS_REVOKED'); },
  } });
  try {
    worker.tick(); await cleanup; await turn(); await worker.close();
    assert(before);
    assert.deepEqual(f.jobs.get(f.owner, task.job.id), before);
    const details = warnings.map(entry => entry[1]);
    assert(details.some(detail => detail && typeof detail === 'object' && 'phase' in detail && detail.phase === 'recovery_writeback'
      && 'reason' in detail && detail.reason === 'OUTPUT_NOT_ALLOWED'));
    assert(details.some(detail => detail && typeof detail === 'object' && 'phase' in detail && detail.phase === 'model_context_cleanup'
      && 'reason' in detail && detail.reason === 'ACCESS_REVOKED'));
  } finally { await worker.close(); f.close(); }
});

test('technical recovery renews its still-current original lease during a long projection', {timeout:60000}, async t => {
  let clock=Date.now(); t.mock.method(Date,'now',()=>clock);
  const f=securityFixture(()=>clock),install=f.installation('Long recovery projection');f.approve(install.id);
  const task=f.task(install.id),request=structuredClone(task.job.delegation!.request),warnings:unknown[][]=[];
  t.mock.method(console,'error',(...args:unknown[])=>{if(String(args[0]).startsWith('Worker '))warnings.push(args);});
  let signal:AbortSignal|undefined,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const bind=f.jobs.security.policies.bindTaskProjection.bind(f.jobs.security.policies),renew=f.jobs.renew.bind(f.jobs);
  let renewals=0;
  t.mock.method(f.jobs,'renew',(...args:Parameters<typeof renew>)=>{const value=renew(...args);if(value)renewals++;return value;});
  t.mock.method(f.jobs.security.policies,'bindTaskProjection',(...args:Parameters<typeof bind>)=>{
    if(signal?.aborted)for(let chunk=0;chunk<3;chunk++){clock+=6000;authorizationScope()!.assertCurrent();}
    return bind(...args);
  });
  const worker=new Worker(f.jobs,{leaseMs:15000,pollMs:1000,timeoutMs:50,coordinator:{
    run:async(_claim,current)=>{signal=current;entered();await new Promise<void>((_resolve,reject)=>current.addEventListener('abort',()=>reject(new Error('Synthetic timeout')),{once:true}));},
  }});
  try{
    worker.tick();await started;await new Promise(resolve=>setTimeout(resolve,100));await worker.close();
    const current=f.jobs.get(f.owner,task.job.id);
    assert.equal(current.delegation?.recovery?.code,'worker_timeout',JSON.stringify(warnings));
    assert.equal(renewals,3,'Each renewal must retain the original claim and interval');
    assert.deepEqual(current.delegation?.request,request);assert.equal(current.revision,task.job.revision);
    assert.equal(current.artifact,undefined);assert.deepEqual(warnings,[]);
  }finally{await worker.close();f.close();}
});

test('technical recovery cannot renew beyond its bounded metadata window', {timeout:60000}, async t => {
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const f=securityFixture(()=>clock),install=f.installation('Recovery metadata window');f.approve(install.id);const task=f.task(install.id);
  let signal:AbortSignal|undefined,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const bind=f.jobs.security.policies.bindTaskProjection.bind(f.jobs.security.policies),renew=f.jobs.renew.bind(f.jobs);let renewals=0;
  t.mock.method(console,'error',()=>{});
  t.mock.method(f.jobs,'renew',(...args:Parameters<typeof renew>)=>{renewals++;return renew(...args);});
  t.mock.method(f.jobs.security.policies,'bindTaskProjection',(...args:Parameters<typeof bind>)=>{
    if(signal?.aborted){clock+=31000;authorizationScope()!.assertCurrent();}return bind(...args);
  });
  const worker=new Worker(f.jobs,{leaseMs:60000,pollMs:1000,timeoutMs:50,coordinator:{
    run:async(_claim,current)=>{signal=current;entered();await new Promise<void>((_resolve,reject)=>current.addEventListener('abort',()=>reject(new Error('Synthetic timeout')),{once:true}));},
  }});
  try{
    worker.tick();await started;await new Promise(resolve=>setTimeout(resolve,100));await worker.close();
    const current=f.jobs.get(f.owner,task.job.id);
    assert.equal(current.delegation?.recovery,undefined,'An overlong metadata write must roll back');
    assert.equal(renewals,0,'Still-valid consent does not permit extending the recovery window');
  }finally{await worker.close();f.close();}
});

test('heartbeat checks authority on each tick but only renews a current lease when due', { timeout: 60000 }, async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const f = securityFixture(() => clock), install = f.installation('Heartbeat cadence');
  f.approve(install.id); f.task(install.id);
  let checks = 0, renewals = 0, checked!: () => void, renewed!: () => void;
  const checkedPromise = new Promise<void>(resolve => { checked = resolve; });
  const renewedPromise = new Promise<void>(resolve => { renewed = resolve; });
  const workerScope = f.jobs.security.workerScope.bind(f.jobs.security), renew = f.jobs.renew.bind(f.jobs);
  t.mock.method(f.jobs.security, 'workerScope', (...args: Parameters<typeof workerScope>) => {
    const scope = workerScope(...args), assertCurrent = scope.assertCurrent;
    scope.assertCurrent = () => { assertCurrent(); if (++checks >= 3) checked(); };
    return scope;
  });
  t.mock.method(f.jobs, 'renew', (...args: Parameters<typeof renew>) => {
    const result = renew(...args); renewals++; renewed(); return result;
  });
  const worker = new Worker(f.jobs, { leaseMs: 15000, pollMs: 20, timeoutMs: 60000, coordinator: {
    run: async (_claim, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Synthetic shutdown')), { once: true });
    }),
  } });
  try {
    worker.tick(); await checkedPromise;
    assert.equal(renewals, 0, 'Heartbeat must not repeatedly parse large task fences before renewal is due');
    clock += 6000; await renewedPromise;
    assert.equal(renewals, 1);
    assert(checks >= 3, 'Current policy and authority must still be checked between renewals');
  } finally { await worker.close(); f.close(); }
});

test('cancellation interrupts a current Foundation claim before its next renewal without changing grants', { timeout: 60000 }, async t => {
  const clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const f = securityFixture(() => clock), install = f.installation('Canceled before renewal');
  f.approve(install.id); const task = f.task(install.id);
  let entered!: () => void, signal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const worker = new Worker(f.jobs, { leaseMs: 30000, pollMs: 20, timeoutMs: 60000, coordinator: {
    run: async (_claim, current) => { signal = current; entered(); await new Promise<void>((_resolve, reject) => {
      current.addEventListener('abort', () => reject(new Error('Synthetic cancel')), { once: true });
    }); },
  } });
  try {
    worker.tick(); await started;
    const grants = structuredClone(f.jobs.security.listGrants(f.owner)), current = f.jobs.get(f.owner, task.job.id);
    current.state = 'canceled'; current.delegation!.phase = 'canceled'; f.jobs.save(f.owner, current);
    assert(f.jobs.security.workAuthority(f.owner, current.id), 'Cancellation signal must not depend on grant revocation');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(signal?.aborted, true);
    await worker.close();
    assert.equal(f.jobs.get(f.owner, task.job.id).state, 'canceled');
    assert.equal(f.jobs.get(f.owner, task.job.id).artifact, undefined);
    assert.deepEqual(f.jobs.security.listGrants(f.owner), grants);
  } finally { await worker.close(); f.close(); }
});

for (const interruption of ['timeout', 'shutdown'] as const) {
  test(`Foundation Worker records ${interruption} recovery under its still-current original authority`, { timeout: 60000 }, async t => {
    const f = securityFixture(), install = f.installation('Interrupted read-only task');
    f.approve(install.id);
    const task = f.task(install.id), request = structuredClone(task.job.delegation!.request);
    const warnings: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { if (String(args[0]).startsWith('Worker writeback')) warnings.push(args); });
    let entered!: () => void, aborted!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const stopped = new Promise<void>(resolve => { aborted = resolve; });
    let executions = 0, releases = 0;
    let executionScope: AuthorizationScope | undefined, executionSignal: AbortSignal | undefined;
    const finish = f.jobs.finish.bind(f.jobs);
    t.mock.method(f.jobs, 'finish', (...args: Parameters<typeof finish>) => {
      if (executionSignal?.aborted) {
        assert.throws(() => executionScope!.assertCurrent(), /Execution lease or task authority ended/,
          'Late execution must retain the abort guard while recovery is committed');
        assert.doesNotThrow(() => authorizationScope()!.assertCurrent(),
          'Recovery must still validate the original current authority and lease');
      }
      return finish(...args);
    });
    const worker = new Worker(f.jobs, { leaseMs: 30000, pollMs: 1000,
      timeoutMs: interruption === 'timeout' ? 50 : 30000,
      coordinator: {
        run: async (_claim, signal) => {
          executionScope = authorizationScope(); executionSignal = signal;
          executions++; entered();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => { aborted(); reject(new Error('Synthetic interrupted read')); }, { once: true });
          });
        },
        releaseModelContext: async () => { releases++; },
      },
    });
    try {
      worker.tick(); await started;
      if (interruption === 'timeout') { await stopped; await turn(); }
      await worker.close();
      const current = f.jobs.get(f.owner, task.job.id);
      assert.equal(current.delegation?.recovery?.code, interruption === 'timeout' ? 'worker_timeout' : 'worker_interrupted');
      assert.equal(current.delegation?.recovery?.state, 'scheduled');
      assert.equal(current.id, task.job.id); assert.equal(current.revision, 1);
      assert.deepEqual(current.delegation?.request, request);
      assert.equal(current.artifact, undefined);
      assert.equal(f.jobs.security.workAuthority(f.owner, current.id)?.dataGrant.id, task.grant.id);
      assert.equal(executions, 1); assert.equal(releases, 1);
      assert.deepEqual(warnings, [], 'An execution abort must not invalidate authorized recovery bookkeeping');
    } finally { await worker.close(); f.close(); }
  });
}

for (const boundary of ['revoked', 'expired_lease', 'request_revision'] as const) {
  test(`Interrupted Foundation Worker cannot write recovery after ${boundary}`, { timeout: 60000 }, async t => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const f = securityFixture(() => clock), install = f.installation('Fenced interrupted task');
    f.approve(install.id); const task = f.task(install.id);
    let entered!: () => void, claim: WorkClaim | undefined, releases = 0;
    const started = new Promise<void>(resolve => { entered = resolve; });
    t.mock.method(console, 'error', () => {});
    const worker = new Worker(f.jobs, { leaseMs: 30000, pollMs: 1000, timeoutMs: 60000, coordinator: {
      run: async (work, signal) => { claim = work; entered(); await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Synthetic interrupted read')), { once: true });
      }); },
      releaseModelContext: async () => { releases++; },
    } });
    try {
      worker.tick(); await started;
      if (boundary === 'revoked') f.coordinator.revokeInstallation(f.member.id, install.id);
      else if (boundary === 'expired_lease') clock += 30001;
      else {
        const current = f.jobs.get(f.owner, task.job.id);
        current.revision!++; current.delegation!.request.revision++;
        f.jobs.save(f.owner, current);
      }
      const before = f.jobs.get(f.owner, task.job.id);
      await worker.close();
      assert.deepEqual(f.jobs.get(f.owner, task.job.id), before, 'Stale recovery must not overwrite current task state');
      assert.equal(f.jobs.renew(claim!, 30000), false);
      assert.equal(releases, 1);
    } finally { await worker.close(); f.close(); }
  });
}
