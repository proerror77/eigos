import type { Client } from 'pg';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { PostgresTaskCommandService } from '../packages/postgres/task-command-service.js';
import { PostgresWorkerStore } from '../packages/postgres/worker-store.js';

test('a Worker read uses fresh original-token validity across heartbeats without extending or reviving a lease',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true });
    let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
    try {
      const installation = f.installation('Synthetic long Worker read', 3600000); f.approve(installation.id);
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      f.jobs.security.policies.setRole({ subjectKind: 'installation', subjectId: installation.id, role: 'Viewer',
        resource: { kind: 'objectType', id: 'ServiceRequest', version: f.jobs.security.policies.resourceVersion('objectType', 'ServiceRequest') }, expiresAt }, f.jobs.security.policies.revision());
      f.jobs.security.policies.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'], channels: ['agent_response'], expiresAt }, f.jobs.security.policies.revision());
      f.jobs.security.policies.setModelChannel('synthetic:long-read', { classification: 'sensitive', markings: ['member_private', 'personal_data'], expiresAt }, f.jobs.security.policies.revision());
      const p = { ...f.principal, access: f.coordinator.authenticate(f.principal, installation.token) };
      target = await importPostgresFixture(f);
      const t = target, q = `"${t.schema}"`, commands = new PostgresTaskCommandService(t.database, t.policy);
      const submitted = await commands.submit(p, { requestId: 'long-original-read', goal: 'Synthetic continuously leased Worker input' });
      const worker = new PostgresWorkerStore(t.database, t.policy), claim = await worker.claim(['eigos.delegate'], 5000);
      assert(claim); assert.equal(claim.job.id, submitted.id);
      const grantBefore = (await t.client.query(`SELECT body FROM ${q}.security_grants WHERE kind='task_data' AND owner=$1`, [f.owner])).rows.map(row => row.body);
      let renewals = 0, failure: unknown, pending: Promise<void> | undefined;
      const timer = setInterval(() => {
        if (!pending) pending = worker.renew(claim, 5000).then(ok => { assert(ok); renewals++; })
          .catch(error => { failure = error; }).finally(() => { pending = undefined; });
      }, 400); timer.unref();
      try {
        const goal = await worker.readEvidence(claim, 'synthetic:long-read', async (auth, _admission, principal, c) => {
          assert.equal(principal.access?.actorKind, 'worker');
          const initial = (await c.query(`SELECT expires_at FROM ${q}.work_claims WHERE job_id=$1`, [claim.job.id])).rows[0]!.expires_at;
          await delay(5600);
          const snapshot = (await c.query(`SELECT expires_at FROM ${q}.work_claims WHERE job_id=$1`, [claim.job.id])).rows[0]!.expires_at;
          assert.equal(snapshot, initial, 'SERIALIZABLE keeps its original lease timestamp');
          assert(Number(snapshot) < Date.now(), 'the original timestamp has elapsed while the same token was renewed');
          return (await auth.readObject({ type: 'ServiceRequest', id: claim.job.id }, ['originalGoal'])).object.properties.originalGoal;
        });
        assert.equal(goal, submitted.goal); assert(renewals > 0); assert.equal(failure, undefined);
        const slow = new PostgresWorkerStore({
          run:<T>(action:(client:Client)=>Promise<T>)=>t.database.run(async client=>{const result=await action(client);await delay(5600);return result;}),
          renewClaim:t.database.renewClaim.bind(t.database),inspectClaim:t.database.inspectClaim.bind(t.database),cleanupReleasedClaims:t.database.cleanupReleasedClaims.bind(t.database),
        },t.policy);
        assert.equal(await slow.active(claim),true,'active waits past the original lease timestamp while the same token is renewed');
        assert.equal(failure,undefined);

      } finally { clearInterval(timer); if (pending) await pending; }
      const before = (await t.client.query(`SELECT expires_at FROM ${q}.work_claims WHERE job_id=$1`, [claim.job.id])).rows[0]!.expires_at;
      assert(await t.database.inspectClaim(claim, t.policy));
      assert.equal(await Reflect.apply(worker.renew, worker, [claim, undefined]), false, 'a missing renewal duration cannot become a successful inspection');
      assert.equal((await t.client.query(`SELECT expires_at FROM ${q}.work_claims WHERE job_id=$1`, [claim.job.id])).rows[0]!.expires_at, before, 'inspection never renews the timestamp');
      assert.equal(await t.database.inspectClaim({ ...claim, token: 'wrong-original-token' }, t.policy), undefined);
      assert.deepEqual((await t.client.query(`SELECT body FROM ${q}.security_grants WHERE kind='task_data' AND owner=$1`, [f.owner])).rows.map(row => row.body), grantBefore);
      await t.client.query(`UPDATE ${q}.work_claims SET expires_at=$1 WHERE job_id=$2`, [Date.now() + 1800, claim.job.id]);
      await assert.rejects(worker.readEvidence(claim, 'synthetic:long-read', async () => { await delay(2400); return 'must not leave the transaction'; }), /ACCESS_REVOKED|POLICY_CHANGED/);
      assert.equal(await worker.renew(claim, 5000), false, 'an expired token cannot revive');
    } finally { if (target) await target.close(); f.close(); }
  });
