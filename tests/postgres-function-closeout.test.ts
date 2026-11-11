import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../packages/core/delegation.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import {
  compiledSeedModel,
  createExecutableContractKernelDefinition,
  createFunctionContractCloseoutDefinition,
  FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF,
  stagedKernelComponents,
} from '../packages/ontology/seed-definition.js';
import { postgresOntologyRelease } from '../packages/postgres/ontology-release.js';
import { PostgresTaskReadService } from '../packages/postgres/task-read-service.js';
import { AuthorizedOntologyView } from '../packages/security/view.js';
import { syntheticOntology } from './fixtures/ontology-objects.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { securityFixture } from './fixtures/security.js';

test('PostgreSQL executes v35 Function contracts only under the exact published role', {
  skip: process.env.EIGOS_TEST_PG_LOCAL !== '1',
}, async () => {
  const fixture = securityFixture(Date.now, { unified: true });
  const sqlite = new DatabaseSync(fixture.database);
  let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
  try {
    const policy = fixture.jobs.security.policies;
    const v28 = fixture.jobs.ontology.model;
    const world = syntheticOntology();
    const storage = new OntologyObjectStore(sqlite, v28, Date.now, undefined, { skipLegacyMigration: true });
    storage.ingest(fixture.owner, world.batch, world.source);
    const approvedIds = [
      'quote-D', 'receipt-quote-D', 'line', 'order', 'allocation', 'delivery-event',
      'shipment', 'receipt-allocation', 'receipt-delivery-event',
    ];
    const types = new Set(['ServiceRequest', ...approvedIds.map(id => world.ids[id]!.type)]);
    const resources = [...types].map(type => ({
      type,
      fields: Object.keys(policy.fields(type)).filter(field => policy.fieldPolicy(type, field) !== 'internal_only'),
    }));
    const installation = fixture.installation('Synthetic v35 function contract caller', 3600000);
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    fixture.coordinator.approveAgentGrant(fixture.member.id, {
      installationId: installation.id, capabilityIds: ['brief.prepare'], resources,
      sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt,
    });
    policy.setRecipient(installation.id, {
      classification: 'sensitive', markings: ['member_private', 'personal_data', 'financial', 'precise_location'],
      channels: ['agent_response'], expiresAt,
    }, policy.revision());
    const functions = ['offerFreshness', 'withinBudget', 'remainingQuantity'];
    const role = {
      subjectKind: 'installation' as const, subjectId: installation.id, role: 'Viewer' as const,
      resource: { kind: 'namespace' as const, id: v28.ref.id, version: v28.ref.digest },
      invokeFunctions: functions, expiresAt,
    };
    policy.setRole(role, policy.revision());
    const principal = {
      ...fixture.principal, access: fixture.coordinator.authenticate(fixture.principal, installation.token),
    };
    const task = fixture.task(installation.id);
    const legacyTask = fixture.task(installation.id);
    for (const original of [task, legacyTask]) {
      fixture.jobs.security.revokeGrant(fixture.owner, original.grant.id, 1);
      fixture.jobs.security.issueTaskGrant({
        ...original.grant, id: randomUUID(),
        operations: ['task.query', 'task.result.read', 'member_asset.read'], channels: ['agent_response'],
        inputs: approvedIds.map(id => {
          const object = world.ids[id]!;
          return { object, objectRevision: 1, fields: resources.find(resource => resource.type === object.type)!.fields };
        }),
      });
    }
    const calls = [
      { function: 'offerFreshness', object: world.ids['quote-D']! },
      { function: 'withinBudget', object: world.ids['quote-D']!, priceBasis: 'estimate', budget: { minor: '1700', currency: 'CNY' } },
      { function: 'remainingQuantity', object: world.ids.line! },
    ];
    const input = (taskId: string, call: unknown) => ({ version: 2, taskId, expectedRequestRevision: 1, call });
    const old = new AuthorizedOntologyView(fixture.jobs.ontology, fixture.jobs.security, principal);
    const expected = calls.map(call => old.evaluate(input(legacyTask.job.id, call)));
    assert.deepEqual(expected.map(result => result.status), ['known', 'known', 'known'], JSON.stringify(expected));
    assert.deepEqual(expected.map(result => result.value), [true, 'pass', { amount: '2', unit: 'cup' }]);

    const v34 = createExecutableContractKernelDefinition();
    const v35 = createFunctionContractCloseoutDefinition();
    const model = compiledSeedModel(v35, v35.registry);
    assert.deepEqual(model.ref, FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF);
    target = await importPostgresFixture(fixture);
    const t = target, schema = `"${t.schema}"`;
    assert.equal(stagedKernelComponents(t.kernel).model.ref.version, '28');
    const ref = { ontologyId: model.ref.id, releaseId: `synthetic-v35-${randomUUID()}`, digest: digest(v35.document) };
    // Seed the explicit publication and the fixture task pin together. Host
    // startup has only installed trusted code, not selected or granted v35.
    await t.run(async client => {
      await client.query(`INSERT INTO ${schema}.ontology_definition_releases
        (id,ontology_id,sequence,digest,model_digest,body,created_at)
        VALUES($1,$2,(SELECT max(sequence)+1 FROM ${schema}.ontology_definition_releases WHERE ontology_id=$2),$3,$4,$5,$6)`,
      [ref.releaseId, ref.ontologyId, ref.digest, model.ref.digest, JSON.stringify(v35.document), new Date().toISOString()]);
      await client.query(`UPDATE ${schema}.ontology_namespaces SET active_release_id=$1,generation=generation+1 WHERE id=$2`,
        [ref.releaseId, ref.ontologyId]);
      await client.query(`UPDATE ${schema}.jobs SET body=jsonb_set(body::jsonb,'{delegation,ontologyRelease}',$1::jsonb)::text
        WHERE owner=$2 AND id=$3`, [JSON.stringify(ref), fixture.owner, task.job.id]);
    });
    const loaded = await t.run(client => postgresOntologyRelease(client, ref));
    assert.deepEqual(loaded.model.ref, model.ref);
    for (const id of functions) {
      const contract = loaded.model.function(id).executionContract;
      assert.equal(contract?.version, '2');
      assert.equal(contract?.mode, 'validated');
    }
    const grantRole = async (version: string) => {
      const next = { ...role, resource: { ...role.resource, version } };
      const id = digest([next.subjectKind, next.subjectId, next.resource]);
      await t.client.query(`INSERT INTO ${schema}.security_roles(id,subject_id,body) VALUES($1,$2,$3)`,
        [id, installation.id, JSON.stringify(next)]);
      return id;
    };
    await grantRole(compiledSeedModel(v34, v34.registry).ref.digest);
    await t.refreshEligibility();
    const service = new PostgresTaskReadService(t.database, t.policy);
    await assert.rejects(service.evaluateOntology(principal, input(task.job.id, calls[0])), /AUTHORIZATION_REQUIRED|INSUFFICIENT_ACCESS/);
    assert.equal((await service.evaluateOntology(principal, input(legacyTask.job.id, calls[0]))).value, true);

    const currentRole = await grantRole(model.ref.digest);
    for (const [index, call] of calls.entries()) {
      const result = await service.evaluateOntology(principal, input(task.job.id, call));
      assert.equal(result.status, 'known', result.reason);
      assert.deepEqual(result.value, expected[index]!.value);
      assert.deepEqual(result.evidenceRefs, expected[index]!.evidenceRefs);
      assert(!JSON.stringify(result).includes('PRIVATE_RECEIPT_MARKER'));
    }
    await assert.rejects(service.evaluateOntology(principal, input(task.job.id, { ...calls[0], unexpected: true })));
    const unknown = await service.evaluateOntology(principal, input(task.job.id, { ...calls[1], budget: { minor: '1700', currency: 'USD' } }));
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.value, undefined);
    await t.client.query(`DELETE FROM ${schema}.security_roles WHERE id=$1`, [currentRole]);
    await assert.rejects(service.evaluateOntology(principal, input(task.job.id, calls[0])), /AUTHORIZATION_REQUIRED|INSUFFICIENT_ACCESS/);
  } finally {
    if (target) await target.close();
    sqlite.close();
    fixture.close();
  }
});
