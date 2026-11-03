import type { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { PostgresTaskCommandService } from '../packages/postgres/task-command-service.js';
import { PostgresWorkerStore } from '../packages/postgres/worker-store.js';
import { DocumentAgentProgram } from '../packages/capabilities/document-agent.js';
import { taskContextFields } from '../packages/security/task-context-contract.js';
import { discoverPostgresDocumentBindings } from '../packages/postgres/document-bindings.js';
import { postgresBusinessToken } from '../packages/postgres/runtime-transaction.js';

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

/** Actual imported Doc metadata and permissions; no model or provider runs. */
async function requestDiscoveryFixture() {
  const f=securityFixture(Date.now,{unified:true}),program=new DocumentAgentProgram(),channel='synthetic:batched-request',bindingId='synthetic-batched-document';
  let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined,timer:ReturnType<typeof setInterval>|undefined,pending:Promise<void>|undefined,failure:unknown;
  const stopRenewals=async()=>{clearInterval(timer);timer=undefined;if(pending)await pending;assert.equal(failure,undefined);};
  try{
    const installation=f.installation('Synthetic request and discovery transaction',3600000),expiresAt=new Date(Date.now()+3600000).toISOString(),model=f.jobs.ontology.model;
    const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only');
    const types=[...new Set(['ServiceRequest','DocumentTask','DocumentDraft','Place',...Object.keys(taskContextFields)])];
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[program.ref.id],resources:types.map(type=>({type,fields:fields(type)})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},role:'Viewer',executeActions:['ComposeDocument'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:['member_private','personal_data'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:['ComposeDocument'],outputTypes:['DocumentTask','DocumentDraft'],expiresAt},f.jobs.security.policies.revision());
    const task=f.task(installation.id);f.jobs.security.revokeGrant(f.owner,task.grant.id,task.grant.revision);
    const grant=f.jobs.security.issueTaskGrant({...task.grant,id:randomUUID(),outputs:['DocumentTask','DocumentDraft'].map(type=>({type,fields:fields(type),programId:program.ref.id,programDigest:program.configurationDigest,sourceBindingId:bindingId}))});
    f.jobs.security.attachTaskAuthority({...task.authority,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision}});
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`,worker=new PostgresWorkerStore(t.database,t.policy,t.kernel),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);
    timer=setInterval(()=>{if(!pending)pending=worker.renew(claim,30000).then(ok=>{assert(ok);}).catch(error=>{failure=error;}).finally(()=>{pending=undefined;});},4000);timer.unref();
    const options={policyDigest:t.policy,modelChannel:channel,builder:t.kernel,sourceBindingId:bindingId,inspectClaim:(value:Parameters<typeof t.database.inspectClaim>[0])=>t.database.inspectClaim(value,t.policy)};
    return {f,t,q,worker,claim,task,installation,program,channel,options,stopRenewals,close:async()=>{try{await stopRenewals();}finally{try{await t.close();}finally{f.close();}}}};
  }catch(error){try{await stopRenewals();}finally{try{if(target)await target.close();}finally{f.close();}}throw error;}
}

test('checked Worker request and real Doc discovery use one outer transaction with separate read snapshots',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
    const x=await requestDiscoveryFixture();try{
      const request=await x.worker.readRequest(x.claim,x.channel),query={actionId:'ComposeDocument',programRef:x.program.ref};
      const expected=await x.t.database.run(client=>discoverPostgresDocumentBindings(client,x.claim,request,query,x.options));
      assert.equal(expected.items[0]?.bindings[0]?.readiness,'ready');
      const grants=()=>x.t.client.query(`SELECT id,revision,state,expires_at,body FROM ${x.q}.security_grants WHERE installation_id=$1 ORDER BY id`,[x.installation.id]);
      const before=(await grants()).rows;let runs=0,continued=false,captured:Client|undefined;
      const worker=new PostgresWorkerStore({
        run:<T>(action:(client:Client)=>Promise<T>)=>{runs++;return x.t.database.run(action);},
        renewClaim:x.t.database.renewClaim.bind(x.t.database),inspectClaim:x.t.database.inspectClaim.bind(x.t.database),cleanupReleasedClaims:x.t.database.cleanupReleasedClaims.bind(x.t.database),
      },x.t.policy,x.t.kernel);
      const result=await worker.withAuthorizedRequest(x.claim,x.channel,async(current,client)=>{
        continued=true;captured=client;assert.deepEqual(current,request);assert.equal(current.id,x.task.job.id);
        return {request:current,page:await discoverPostgresDocumentBindings(client,x.claim,current,query,x.options)};
      });
      assert(continued);assert.equal(runs,1);assert.deepEqual(result.request,request);assert.deepEqual(result.page,expected);
      assert.equal((await x.t.client.query(`SELECT context_id FROM ${x.q}.jobs WHERE id=$1`,[x.claim.job.id])).rows[0].context_id,x.task.job.contextId);
      assert.deepEqual((await grants()).rows,before,'batching must not issue, extend or rewrite permission');assert(captured);assert.throws(()=>postgresBusinessToken(captured!),/active PostgreSQL business transaction/);
      const missing=await worker.withAuthorizedRequest(x.claim,x.channel,(current,client)=>discoverPostgresDocumentBindings(client,x.claim,current,query,{...x.options,sourceBindingId:'synthetic-unregistered-source'}));
      assert(!missing.items.some(item=>item.bindings.some(binding=>binding.readiness==='ready')),'an absent source cannot become ready through request admission');
      const unsupported=await worker.withAuthorizedRequest(x.claim,x.channel,(current,client)=>discoverPostgresDocumentBindings(client,x.claim,current,{actionId:'SearchDidiPlaces'},x.options));
      assert.equal(unsupported.items.length,1);assert.equal(unsupported.items[0]!.action.id,'SearchDidiPlaces');assert.equal(unsupported.items[0]!.status,'binding_unavailable');assert.deepEqual(unsupported.items[0]!.bindings,[],'Visible definitions cannot acquire an uninstalled fallback binding');
    }finally{await x.close();}
  });

test('batched request discovery preserves between-action and outer egress revocation fences',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async t=>{
    for(const change of ['parent','expiry','claim','manager-before-commit'] as const)await t.test(change,async()=>{
      const x=await requestDiscoveryFixture();try{
        let continued=false,discovered=false;
        await assert.rejects(x.worker.withAuthorizedRequest(x.claim,x.channel,async(request,client)=>{
          continued=true;assert.equal(request.id,x.claim.job.id);await x.stopRenewals();
          // A separate fixture connection models a state change after the
          // first checked snapshot. It is not part of the host continuation.
          if(change==='parent')await x.t.client.query(`UPDATE ${x.q}.security_grants SET state='revoked' WHERE id=$1`,[x.task.authority.agentGrant.id]);
          if(change==='expiry')await x.t.client.query(`UPDATE ${x.q}.work_claims SET expires_at=$1 WHERE job_id=$2`,[Date.now()-1,x.claim.job.id]);
          if(change==='claim')await x.t.client.query(`UPDATE ${x.q}.work_claims SET token=$1 WHERE job_id=$2`,['synthetic-replacement-claim',x.claim.job.id]);
          const page=await discoverPostgresDocumentBindings(client,x.claim,request,{actionId:'ComposeDocument',programRef:x.program.ref},x.options);discovered=true;
          if(change==='manager-before-commit')await x.t.client.query(`UPDATE ${x.q}.security_manager SET expires_at=0 WHERE slot=1`);
          return page;
        }),/ACCESS_REVOKED|POLICY_CHANGED|AUTHORITY_UNAVAILABLE|OUTPUT_NOT_ALLOWED/);
        assert(continued,'the request must pass before the fixture changes current authority');
        assert.equal(discovered,change==='manager-before-commit','the outer transaction must reject even after both read snapshots completed');
      }finally{await x.close();}
    });
  });
