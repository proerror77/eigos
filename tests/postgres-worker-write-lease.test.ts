import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { PostgresTaskCommandService } from '../packages/postgres/task-command-service.js';
import { PostgresTaskStorage } from '../packages/postgres/task-storage.js';
import { PostgresWorkerStore } from '../packages/postgres/worker-store.js';

test('a slow fenced finish and concurrent heartbeat commit once and release only a proved finished token',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true }); let t: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
    try {
      const install = f.installation('Synthetic slow write', 3600000); f.approve(install.id);
      const expiry = new Date(Date.now() + 3600000).toISOString();
      f.jobs.security.policies.setRole({ subjectKind: 'installation', subjectId: install.id, role: 'Viewer', expiresAt: expiry,
        resource: { kind: 'objectType', id: 'ServiceRequest', version: f.jobs.security.policies.resourceVersion('objectType', 'ServiceRequest') } }, f.jobs.security.policies.revision());
      f.jobs.security.policies.setRecipient(install.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'], channels: ['agent_response'], expiresAt: expiry }, f.jobs.security.policies.revision());
      const p = { ...f.principal, access: f.coordinator.authenticate(f.principal, install.token) };
      t = await importPostgresFixture(f); const target=t,q=`"${t.schema}"`, commands = new PostgresTaskCommandService(t.database,t.policy),worker=new PostgresWorkerStore(t.database,t.policy);
      const task=await commands.submit(p,{requestId:'slow-finish',goal:'Synthetic delayed writeback'}),claim=await worker.claim(['eigos.delegate'],5000);assert(claim);
      let pending:Promise<void>|undefined,renewals=0,failure:unknown,delayed=false;
      const timer=setInterval(()=>{if(!pending)pending=worker.renew(claim,5000).then(ok=>{if(ok)renewals++;}).catch(error=>{failure=error;}).finally(()=>{pending=undefined;});},400);timer.unref();
      const save=PostgresTaskStorage.prototype.save;
      PostgresTaskStorage.prototype.save=async function(owner,job){if(job.id===task.id&&!delayed){delayed=true;await delay(5600);}return save.call(this,owner,job);};
      try{assert.equal(await worker.finish(claim,job=>{job.state='paused';}),true);}
      finally{PostgresTaskStorage.prototype.save=save;clearInterval(timer);if(pending)await pending;}
      assert(delayed);assert(renewals>0);assert.equal(failure,undefined);
      assert.equal((await commands.get(p,task.id)).state,'paused');
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.work_claims WHERE job_id=$1`,[task.id])).rows[0].n),0);
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.runtime_work_claims WHERE job_id=$1`,[task.id])).rows[0].n),0);
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.requests WHERE owner=$1 AND operation LIKE 'eigos.worker.finish:%'`,[f.owner])).rows[0].n),1);
      assert.equal(await worker.finish(claim,job=>{job.state='failed';}),false);assert.equal((await commands.get(p,task.id)).state,'paused');
      const next=await commands.submit(p,{requestId:'unproved-release',goal:'Synthetic unproved missing runtime binding'}),other=await worker.claim(['eigos.delegate'],30000);assert(other);assert.equal(other.job.id,next.id);
      await t.client.query(`DELETE FROM ${q}.runtime_work_claims WHERE job_id=$1 AND token=$2`,[other.job.id,other.token]);
      await target.database.cleanupReleasedClaims();
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.work_claims WHERE job_id=$1`,[other.job.id])).rows[0].n),1,'missing binding alone is not proof of successful finish');
    } finally { if(t)await t.close();f.close(); }
  });
