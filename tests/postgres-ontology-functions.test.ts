import {digest} from '../packages/core/delegation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { syntheticOntology } from './fixtures/ontology-objects.js';
import { currentKernelImplementation } from '../packages/ontology/definition-store.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { AuthorizedOntologyView } from '../packages/security/view.js';
import { PostgresTaskReadService } from '../packages/postgres/task-read-service.js';
import { withPostgresTaskReadAuthorization, type PostgresFunctionReadAuthorization } from '../packages/postgres/task-output.js';
import { taskProtocolFixture } from './fixtures/task-protocol.js';
import type { TaskServicePort } from '../packages/core/task-service-port.js';
import { postgresEvaluateAuthorizedFunction } from '../packages/postgres/ontology-functions.js';
import { PostgresTaskCommandService } from '../packages/postgres/task-command-service.js';
import { PostgresWorkerStore } from '../packages/postgres/worker-store.js';

test('PostgreSQL registered functions retain invocation, private proof, incomplete evidence and escaped scope boundaries',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true }), sqlite = new DatabaseSync(f.database);
    let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
    try {
      const model = currentKernelImplementation(), world = syntheticOntology();
      const raw = new OntologyObjectStore(sqlite, model, Date.now, undefined, { skipLegacyMigration: true });
      raw.ingest(f.owner, world.batch, world.source);
      const installation = f.installation('Synthetic calculation PA', 3600000), expiresAt = new Date(Date.now() + 3600000).toISOString();
      const resources = ['ServiceRequest', 'DeliveryQuote', 'SourceReceipt'].map(type => ({ type,
        fields: Object.keys(f.jobs.security.policies.fields(type)).filter(field => f.jobs.security.policies.fieldPolicy(type, field) !== 'internal_only') }));
      f.coordinator.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: ['brief.prepare'], resources,
        sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt });
      f.jobs.security.policies.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'], channels: ['agent_response'], expiresAt }, f.jobs.security.policies.revision());
      f.jobs.security.policies.setModelChannel('synthetic:sql-native', { classification: 'sensitive', markings: ['member_private', 'personal_data'], expiresAt }, f.jobs.security.policies.revision());
      f.jobs.security.policies.setRole({ subjectKind: 'installation', subjectId: installation.id, role: 'Viewer',
        resource: { kind: 'namespace', id: model.ref.id, version: model.ref.digest }, invokeFunctions: ['offerFreshness'], expiresAt }, f.jobs.security.policies.revision());
      const p = { ...f.principal, access: f.coordinator.authenticate(f.principal, installation.token) }, task = f.task(installation.id);
      f.jobs.security.revokeGrant(f.owner, task.grant.id, 1);
      const quote = world.ids['quote-D']!, receipt = world.ids['receipt-quote-D']!;
      const grant = f.jobs.security.issueTaskGrant({ ...task.grant, id: randomUUID(), operations: ['task.query', 'task.process', 'task.result.read', 'member_asset.read'],
        channels: ['agent_response', 'registered_model'], inputs: [quote, receipt].map(object => ({ object, objectRevision: 1, fields: resources.find(resource => resource.type === object.type)!.fields })) });
      const source = new AuthorizedOntologyView(f.jobs.ontology, f.jobs.security, p);
      const input = { version: 2, taskId: task.job.id, expectedRequestRevision: 1, call: { function: 'offerFreshness', object: quote } };
      const expected = source.evaluate(input); assert.equal(expected.status, 'known'); assert.equal(expected.value, true);
      target = await importPostgresFixture(f);
      const t = target, service = new PostgresTaskReadService(t.database, t.policy), q = `"${t.schema}"`;
      await t.refreshEligibility();
      const result = await service.evaluateOntology(p, input);
      assert.deepEqual(result, expected); assert(!JSON.stringify(result).includes('PRIVATE_'));
      const derivedInput = { version: 2, taskId: task.job.id, expectedRequestRevision: 1, query: { object: quote, select: ['isFresh'] } };
      const role = (await t.client.query(`SELECT body FROM ${q}.security_roles WHERE subject_id=$1`, [installation.id])).rows[0]!.body;
      await t.client.query(`UPDATE ${q}.security_roles SET body=jsonb_set(body::jsonb,'{invokeFunctions}','[]'::jsonb)::text WHERE subject_id=$1`, [installation.id]);
      let invoked = false;
      await assert.rejects(t.run(c => withPostgresTaskReadAuthorization(c, p, task.job.id, t.policy, auth =>
        auth.readView(quote, quote.type, ['isFresh'], async () => { invoked = true; throw new Error('Unpermitted derivation reached'); }))), /AUTHORIZATION_REQUIRED/);
      assert.equal(invoked, false, 'the storage boundary checks invocation before calling a derivation producer');
      await t.client.query(`UPDATE ${q}.security_roles SET body=$1 WHERE subject_id=$2`, [role, installation.id]);
      assert.deepEqual(await service.queryOntology(p, derivedInput), source.query(derivedInput));
      const derivedRead = await t.run(c => withPostgresTaskReadAuthorization(c, p, task.job.id, t.policy, auth =>
        auth.readView(quote, quote.type, ['isFresh'], (id, object) => postgresEvaluateAuthorizedFunction(c, p, task.job.id, 1,
          { function: id, object }, t.policy, auth, undefined, { accessErrors: 'throw' }))));
      assert(derivedRead.envelope.lineage.some(dependency => dependency.object.id === receipt.id));
      assert(derivedRead.envelope.lineage.some(dependency => dependency.object.id === quote.id && dependency.fields?.includes('isFresh')));
      await t.client.query(`INSERT INTO ${q}.security_labels(owner,type,object_id,field,body) VALUES($1,$2,$3,'isFresh',$4)`,
        [f.owner, quote.type, quote.id, JSON.stringify({ classification: 'internal', requiredMarkings: [], channels: ['agent_response'] })]);
      await assert.rejects(t.run(c => withPostgresTaskReadAuthorization(c, p, task.job.id, t.policy,
        auth => auth.authorizeEvidence(derivedRead.envelope))), /OUTPUT_NOT_ALLOWED/);
      await assert.rejects(service.queryOntology(p, derivedInput), /INSUFFICIENT_ACCESS/);
      await t.client.query(`DELETE FROM ${q}.security_labels WHERE owner=$1 AND type=$2 AND object_id=$3 AND field='isFresh'`, [f.owner, quote.type, quote.id]);
      await assert.rejects(service.evaluateOntology(p, { ...input, call: { function: 'taskOutcomeStatus', object: { type: 'ServiceRequest', id: task.job.id } } }), /AUTHORIZATION_REQUIRED/);
      await assert.rejects(service.evaluateOntology(p, { ...input, expectedRequestRevision: 2 }), /POLICY_CHANGED/);
      await t.run(c => withPostgresTaskReadAuthorization(c, p, task.job.id, t.policy, async auth => {
        let escaped: PostgresFunctionReadAuthorization | undefined;
        await auth.withFunction('offerFreshness', async calculation => {
          escaped = calculation; assert.equal(calculation.integrity(), false);
          await assert.rejects(calculation.readPrivate(receipt), /AUTHORIZATION_REQUIRED/);
          const privateBody = await calculation.withIntegrity(() => calculation.readPrivate(receipt));
          assert.equal(privateBody.properties.privatePayload, 'PRIVATE_RECEIPT_MARKER');
          await assert.rejects(calculation.withIntegrity(async () => { throw new Error('synthetic proof failure'); }), /synthetic proof failure/);
          assert.equal(calculation.integrity(), false);
        });
        await assert.rejects(escaped!.readPrivate(receipt), /AUTHORIZATION_REQUIRED/);
        await assert.rejects(escaped!.readObject(quote), /AUTHORIZATION_REQUIRED/);
        await assert.rejects(escaped!.withIntegrity(async () => true), /AUTHORIZATION_REQUIRED/);
      }));
      const port = new Proxy({} as TaskServicePort, { get(_target, key) {
        if (key === 'secured') return true; if (key === 'services') return () => [];
        const method = Reflect.get(service, key); if (typeof method === 'function') return method.bind(service);
        return async () => { throw new Error('Fixture operation is not connected'); };
      } });
      const protocol = await taskProtocolFixture(port, p);
      try {
        const delivered = await protocol.call('evaluate_ontology', input); assert(!delivered.isError, JSON.stringify(delivered));
        assert.deepEqual((delivered.structuredContent as { result: unknown }).result, JSON.parse(JSON.stringify(expected)));
      } finally { await protocol.close(); }
      const scopes = p.scopes.filter(scope => scope !== 'tasks:read'), writer = { ...p, scopes, access: { ...p.access, tokenScopes: scopes } };
      const submitted = await new PostgresTaskCommandService(t.database, t.policy).submit(writer, { requestId: 'processing-only', goal: 'Synthetic processing-only model function scope' });
      const worker = new PostgresWorkerStore(t.database, t.policy), claim = await worker.claim(['eigos.delegate'], 30000);
      assert(claim); assert.equal(claim.job.id, submitted.id);
      let heartbeat:Promise<void>|undefined,heartbeatFailure:unknown;
      const timer=setInterval(()=>{if(!heartbeat)heartbeat=worker.renew(claim,30000).then(async ok=>{
        if(ok)return;
        // The original token must stop renewing once its successful finish
        // receipt commits, including while physical cleanup is still returning.
        const finished=await t.client.query(`SELECT 1 FROM ${q}.requests WHERE owner=$1 AND operation=$2 AND request_id=$3`,
          [f.owner,`eigos.worker.finish:${t.authority.digest}`,digest([claim.job.id,claim.token])]);
        if(finished.rowCount!==1)throw new Error('Synthetic function Worker lost its original lease before finish');
      })
        .catch(error=>{heartbeatFailure=error;}).finally(()=>{heartbeat=undefined;});},5000);timer.unref();
      try{
        await t.client.query(`UPDATE ${q}.security_roles SET body=jsonb_set(body::jsonb,'{invokeFunctions}','["offerFreshness","taskOutcomeStatus"]'::jsonb)::text WHERE subject_id=$1`, [installation.id]);
        await worker.readEvidence(claim, 'synthetic:sql-native', async (auth, admission, principal, c) => {
          assert.equal(principal.access?.actorKind, 'worker'); assert(!principal.scopes.includes('tasks:read'));
          assert(!admission.grant.operations.includes('task.query')); assert(!admission.grant.operations.includes('task.result.read'));
          const computed = await postgresEvaluateAuthorizedFunction(c, principal, submitted.id, 1,
            { function: 'taskOutcomeStatus', object: { type: 'ServiceRequest', id: submitted.id } }, t.policy, auth);
          assert.equal(computed.computation.status, 'unknown'); assert.equal(computed.envelope.ownerKey, f.owner);
        });
        await assert.rejects(service.get(p, submitted.id), /AUTHORIZATION_REQUIRED/);
        assert.equal(await worker.finish(claim, job => { job.state = 'paused'; }), true);
      }finally{clearInterval(timer);if(heartbeat)await heartbeat;}
      assert.equal(heartbeatFailure,undefined);
      await t.client.query(`UPDATE ${q}.security_roles SET body=$1 WHERE subject_id=$2`, [role, installation.id]);
      sqlite.prepare('DELETE FROM security_bindings WHERE grant_id=? AND type=? AND object_id=?').run(grant.id, receipt.type, receipt.id);
      await t.client.query(`DELETE FROM ${q}.security_bindings WHERE grant_id=$1 AND type=$2 AND object_id=$3`, [grant.id, receipt.type, receipt.id]);
      const incomplete = await service.evaluateOntology(p, input);
      assert.deepEqual(incomplete, source.evaluate(input)); assert.equal(incomplete.status, 'unknown');
      assert.match(incomplete.reason!, /incomplete/); assert.equal(incomplete.value, undefined);
      await t.client.query(`UPDATE ${q}.security_roles SET body=jsonb_set(body::jsonb,'{expiresAt}',to_jsonb($1::text))::text`, [new Date(Date.now() - 1).toISOString()]);
      await assert.rejects(service.evaluateOntology(p, input), /AUTHORIZATION_REQUIRED/);
    } finally { if (target) await target.close(); sqlite.close(); f.close(); }
  });
