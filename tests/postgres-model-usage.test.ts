import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { PostgresTaskCommandService } from '../packages/postgres/task-command-service.js';
import { PostgresWorkerStore } from '../packages/postgres/worker-store.js';
import { NativeModelTrace } from '../packages/capabilities/native-model-timing.js';
import { evidence as syntheticEvidence } from './backend-fixture.js';
import { digest } from '../packages/core/delegation.js';
import {PostgresTaskBindings} from '../packages/postgres/task-bindings.js';
import {postgresWorkerAdmission} from '../packages/postgres/worker-admission.js';

test('PostgreSQL registers each model dispatch once and late accounting cannot revive a lease or publish a result',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true }); let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
    try {
      const installation = f.installation('Synthetic SQL model accounting', 3600000); f.approve(installation.id);
      const principal = { ...f.principal, scopes: ['tasks:write'], access: f.coordinator.authenticate({ ...f.principal, scopes: ['tasks:write'] }, installation.token) };
      target = await importPostgresFixture(f); const t = target, q = `"${t.schema}"`;
      const service = new PostgresTaskCommandService(t.database, t.policy);
      const task = await service.submit(principal, { requestId: 'model-accounting-original', goal: 'Synthetic accounting only; never a business result.' });
      const other = await service.submit(principal, { requestId: 'model-accounting-other', goal: 'Another task cannot receive the original attempt.' });
      const worker = new PostgresWorkerStore(t.database, t.policy), claim = await worker.claim(['eigos.delegate'], 300000); assert(claim); assert.equal(claim.job.id, task.id);
      const initial = (await t.client.query(`SELECT body,state,updated_at FROM ${q}.jobs WHERE id=$1`, [task.id])).rows[0];
      await assert.rejects(t.database.run(async c=>{
        const admission=await postgresWorkerAdmission(c,claim.owner,task.id,t.policy),bindings=new PostgresTaskBindings(c);
        const readBinding=async()=>JSON.parse((await c.query(`SELECT body FROM ${q}.security_bindings WHERE grant_id=$1 AND type='ServiceRequest' AND object_id=$2`,[admission.grant.id,task.id])).rows[0].body);
        await bindings.project(admission.grant,admission.parent,claim.job);const before=await readBinding();
        await c.query(`UPDATE ${q}.ontology_objects SET revision=revision+1 WHERE owner=$1 AND type='ServiceRequest' AND id=$2`,[claim.owner,task.id]);
        await c.query(`INSERT INTO ${q}.security_labels(owner,type,object_id,field,body) VALUES($1,'ServiceRequest',$2,'originalGoal',$3)
          ON CONFLICT(owner,type,object_id,field) DO UPDATE SET body=excluded.body`,[claim.owner,task.id,JSON.stringify({classification:'sensitive',requiredMarkings:['financial'],channels:['registered_model']})]);
        await bindings.project(admission.grant,admission.parent,claim.job);const after=await readBinding();
        assert.equal(after.revision,before.revision+1,'A reused binder must read current facts for every projection call');
        assert(after.envelope.requiredMarkings.includes('financial'),'Current labels must still constrain a repeated projection');
        assert.deepEqual(after.envelope.channels,['registered_model']);
        throw new Error('Synthetic binding regression rollback');
      }),/Synthetic binding regression rollback/);
      const runId = randomUUID(), startedAt = new Date().toISOString(), runtime = 'synthetic-accounting';
      await worker.beginModelUsage(claim, runId, runtime, startedAt);
      const read = async (id: string) => (await t.client.query(`SELECT state,body FROM ${q}.member_model_usage WHERE run_id=$1`, [id])).rows[0]!;
      assert.equal((await read(runId)).state, 'running'); assert.equal(JSON.parse((await read(runId)).body).claimTokenDigest, digest(claim.token));
      await assert.rejects(worker.beginModelUsage(claim, runId, runtime, startedAt), /cannot be dispatched twice/);
      await assert.rejects(worker.beginModelUsage({ ...claim, token: 'wrong-original-token' }, randomUUID(), runtime, startedAt), /lease/);
      await assert.rejects(worker.finishModelUsage({ ...claim, job: { ...claim.job, id: other.id } }, runId, undefined, 'failed'), /another execution/);
      await assert.rejects(worker.finishModelUsage({ ...claim, token: 'wrong-original-token' }, runId, undefined, 'failed'), /another claim/);
      let clock = 0; const trace = new NativeModelTrace(() => clock, startedAt); trace.mark('spawnRequested'); clock = 10; trace.mark('processExited');
      const timing = trace.finish('succeeded'), completedAt = new Date().toISOString();
      const reported = { id: runId, runtime, startedAt, completedAt, model: 'synthetic-model', usage: { input_tokens: 10, negative: -1, invalid: NaN, 'unsafe-key': 99 }, nativeTiming: { ...timing, prompt: 'PRIVATE_PROMPT' } };
      await worker.finishModelUsage(claim, runId, reported, 'completed');
      const finished = JSON.parse((await read(runId)).body); assert.deepEqual(finished.usage, { input_tokens: 10 }); assert.equal(finished.usageReported, true);
      assert.equal(finished.nativeTiming, undefined); assert(!JSON.stringify(finished).includes('PRIVATE_PROMPT'));
      await worker.finishModelUsage(claim, runId, { ...reported, nativeTiming: timing }, 'completed');
      await worker.finishModelUsage(claim, runId, undefined, 'failed');
      assert.deepEqual(JSON.parse((await read(runId)).body).nativeTiming, timing, 'the first valid timing survives late accounting');
      assert.deepEqual((await t.client.query(`SELECT body,state,updated_at FROM ${q}.jobs WHERE id=$1`, [task.id])).rows[0], initial);
      const modelRun = { ...syntheticEvidence(), id: randomUUID(), runtime, startedAt, completedAt, model: 'synthetic-model', usage: { input_tokens: 2 } };
      await worker.beginModelUsage(claim, modelRun.id, runtime, startedAt); await worker.finishModelUsage(claim, modelRun.id, modelRun, 'completed');
      assert.equal(await worker.recordRun(claim, modelRun, 'request_interpreted'), true);
      const projectionVersions=async()=>{
        const result:Record<string,unknown>={};
        for(const table of ['jobs','ontology_objects','ontology_object_versions','security_outputs'])result[table]=(await t.client.query(`SELECT count(*)::int AS n,
          md5(coalesce(string_agg(xmin::text||':'||ctid::text,',' ORDER BY xmin::text,ctid::text),'')) AS row_versions FROM ${q}.${table}`)).rows[0];
        return result;
      };
      const beforeDuplicate=await projectionVersions();
      assert.equal(await worker.recordRun(claim, modelRun, 'request_interpreted'), true);
      assert.deepEqual(await projectionVersions(),beforeDuplicate,'An identical model receipt must not rewrite the task, graph history or output seals');
      const recorded = (await t.client.query(`SELECT body,state,updated_at FROM ${q}.jobs WHERE id=$1`, [task.id])).rows[0]!;
      const job = JSON.parse(recorded.body); assert.equal(job.runs.length, 1); assert.equal(job.runs[0].id, modelRun.id); assert.equal(job.runs[0].purpose, 'grounding');
      await assert.rejects(worker.recordRun(claim, { ...modelRun, usage: { input_tokens: 999 } }, 'request_interpreted'), /changed/);
      await assert.rejects(worker.recordRun(claim, { ...modelRun, outputSha256: 'changed-original-output' }, 'request_interpreted'), /changed/);
      await assert.rejects(worker.recordRun(claim,modelRun,'goal_coverage_reviewed'),/changed/,'The same run cannot be relabeled as another model purpose');
      const lateId = randomUUID(); await worker.beginModelUsage(claim, lateId, runtime, startedAt);
      await t.client.query(`UPDATE ${q}.work_claims SET expires_at=$1 WHERE job_id=$2`, [Date.now() - 1, task.id]);
      const expired = (await t.client.query(`SELECT token,revision,expires_at FROM ${q}.work_claims WHERE job_id=$1`, [task.id])).rows[0];
      await worker.finishModelUsage(claim, lateId, { id: lateId, runtime, startedAt, completedAt, usage: { input_tokens: 3 } }, 'completed');
      assert.equal((await read(lateId)).state, 'completed');
      await assert.rejects(worker.beginModelUsage(claim, randomUUID(), runtime, startedAt), /lease/);
      assert.equal(await worker.recordRun(claim,modelRun,'request_interpreted'),false,'Duplicate accounting cannot revive an expired original claim');
      assert.equal(await worker.finish(claim, job => { job.state = 'completed'; }), false);
      assert.deepEqual((await t.client.query(`SELECT body,state,updated_at FROM ${q}.jobs WHERE id=$1`, [task.id])).rows[0], recorded);
      assert.deepEqual((await t.client.query(`SELECT token,revision,expires_at FROM ${q}.work_claims WHERE job_id=$1`, [task.id])).rows[0], expired);
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.member_model_usage WHERE owner=$1 AND job_id=$2`, [claim.owner, task.id])).rows[0]!.n), 3);
    } finally { if (target) await target.close(); f.close(); }
  });
