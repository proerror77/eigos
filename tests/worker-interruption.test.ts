import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from '../apps/worker/worker.js';
import { securityFixture } from './fixtures/security.js';
import { authorizationScope, type AuthorizationScope } from '../packages/security/context.js';
import type { WorkClaim } from '../packages/core/store.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

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
