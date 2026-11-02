import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { PostgresTaskCommandService } from '../packages/postgres/task-command-service.js';
import { PostgresWorkerStore } from '../packages/postgres/worker-store.js';
import { PostgresTaskWorker } from '../apps/worker/postgres-worker.js';

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
