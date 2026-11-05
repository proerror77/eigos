import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { AuthorizedOntologyView } from '../packages/security/view.js';
import { TaskSecurity } from '../packages/security/task-service.js';
import { createSubmittedTask } from '../packages/core/task-submission.js';
import { PostgresTaskReadService } from '../packages/postgres/task-read-service.js';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { paClassifications } from '../packages/ontology/pa-classification-kernel.js';

test('the PostgreSQL Gateway bundle excludes Mac command execution and SQLite', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../packages/postgres/task-command-service.ts', import.meta.url))],
    bundle: true, write: false, metafile: true, platform: 'browser', format: 'esm',
    external: ['node:*'], logLevel: 'silent',
  });
  const imports = Object.values(bundle.metafile.outputs).flatMap(output => output.imports.map(value => value.path));
  assert(!imports.includes('node:child_process'), 'public task/metadata code must not load local provider executors');
  assert(!imports.includes('node:sqlite'), 'PostgreSQL Gateway must not load SQLite persistence');
});

test('PostgreSQL task-pinned PA classification matches SQLite after publication and still rejects expired roles',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true });
    let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
    try {
      const definitions = f.jobs.definitions, before = definitions.namespace(), prior = definitions.active();
      let draft = definitions.createDraft(f.owner, before.id, 'PA metadata fixture', true);
      for (const type of prior.document.objects) draft = definitions.putResource(f.owner, draft.id, draft.revision, 'object', { ...type, classification: paClassifications[type.id] }, true);
      const validation = definitions.validate(draft.id); assert.equal(validation.valid, true, JSON.stringify(validation.issues));
      const published = definitions.publish(f.owner, draft.id, draft.revision, true);
      definitions.activate(f.owner, published.release, before.generation, true);
      const installation = f.installation('PA classified metadata fixture', 3600000), expiresAt = new Date(Date.now() + 3600000).toISOString();
      f.coordinator.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: ['brief.prepare'], resources: [
        { type: 'ServiceRequest', fields: ['requestId', 'originalGoal'] }, { type: 'HotelProperty', fields: ['objectId', 'hotelName'] },
      ], sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt });
      const p = { ...f.principal, access: f.coordinator.authenticate(f.principal, installation.token) };
      f.jobs.security.policies.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'], channels: ['agent_response'], expiresAt }, f.jobs.security.policies.revision());
      for (const id of ['ServiceRequest', 'HotelProperty']) f.jobs.security.policies.setRole({ subjectKind: 'installation', subjectId: installation.id, role: 'Viewer', expiresAt,
        resource: { kind: 'objectType', id, version: f.jobs.security.policies.resourceVersion('objectType', id) } }, f.jobs.security.policies.revision());
      const task = new TaskSecurity(f.jobs).submit(p, () => {
        const job = createSubmittedTask(p, { service: 'eigos.delegate', goal: 'Hotel metadata only', requestId: 'pa-metadata' }, definitions.active().ref);
        f.jobs.save(f.owner, job); return f.jobs.get(f.owner, job.id);
      });
      const view = new AuthorizedOntologyView(f.jobs.ontologyForTaskRead(f.owner, task.id), f.jobs.security, p);
      const inputs = [
        { taskId: task.id, view: 'pa', domains: ['hotel'], limit: 5 }, { taskId: task.id, view: 'all', limit: 5 },
        { taskId: task.id, view: 'pa', domains: ['appointment'], limit: 5 }, { taskId: task.id, search: 'HotelProperty' },
      ];
      const expected = inputs.map(input => view.describe(input));
      assert(expected[0]!.types.some(type => type.id === 'HotelProperty'));
      assert(!expected[2]!.types.some(type => type.id === 'HotelProperty'));
      assert(!JSON.stringify(expected).includes('privatePayload'));
      target = await importPostgresFixture(f);
      const service = new PostgresTaskReadService(target.database, target.policy);
      for (let index = 0; index < inputs.length; index++) {
        await target.refreshEligibility();
        assert.deepEqual(await service.describeOntology(p, inputs[index]), expected[index]);
      }
      await assert.rejects(service.describeOntology({ ...p, subject: 'other-member' }, inputs[0]));
      await target.client.query(`UPDATE "${target.schema}".security_roles SET body=jsonb_set(body::jsonb,'{expiresAt}',to_jsonb($1::text))::text`, [new Date(Date.now() - 1).toISOString()]);
      assert.deepEqual((await service.describeOntology(p, inputs[0])).types, []);
    } finally { if (target) await target.close(); f.close(); }
  });

test('PostgreSQL definition discovery matches the reviewed SQLite view and current installation roles',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true });
    let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
    try {
      const installation = f.installation('Synthetic metadata PA', 3600000);
      f.approve(installation.id);
      const p = { ...f.principal, access: f.coordinator.authenticate(f.principal, installation.token) };
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      f.jobs.security.policies.setRecipient(installation.id, { classification: 'sensitive',
        markings: ['member_private', 'personal_data'], channels: ['agent_response'], expiresAt }, f.jobs.security.policies.revision());
      for (const id of ['ServiceRequest', 'Place']) f.jobs.security.policies.setRole({
        subjectKind: 'installation', subjectId: installation.id, role: 'Viewer', expiresAt,
        resource: { kind: 'objectType', id, version: f.jobs.security.policies.resourceVersion('objectType', id) },
      }, f.jobs.security.policies.revision());
      const submitted = new TaskSecurity(f.jobs).submit(p, () => {
        const job = createSubmittedTask(p, { service: 'eigos.delegate', goal: 'Synthetic metadata task', requestId: 'metadata' }, f.jobs.definitions.active().ref);
        f.jobs.save(f.owner, job); return f.jobs.get(f.owner, job.id);
      });
      const source = new AuthorizedOntologyView(f.jobs.ontology, f.jobs.security, p);
      const inputs = [{}, { search: 'ServiceRequest', limit: 1 }, { kind: 'actions' }, { kind: 'functions' },
        { search: 'Place' }, { taskId: submitted.id, search: 'ServiceRequest' }];
      const expected = inputs.map(input => source.describe(input));
      assert.deepEqual(expected[4]!.types, [], 'a role alone cannot extend the parent data boundary');
      assert.equal(expected[1]!.types[0]?.id, 'ServiceRequest');
      target = await importPostgresFixture(f);
      const t = target, service = new PostgresTaskReadService(t.database, t.policy);
      for (let index = 0; index < inputs.length; index++) {
        await t.refreshEligibility();
        assert.deepEqual(await service.describeOntology(p, inputs[index]), expected[index]);
      }
      // Definition-only discovery requires services:read, without inventing
      // tasks:read or task authority on behalf of a metadata-only caller.
      const scopes = p.scopes.filter(scope => scope !== 'tasks:read');
      const metadataOnly = { ...p, scopes, access: { ...p.access, tokenScopes: scopes } };
      assert.deepEqual(await service.describeOntology(metadataOnly, {}), expected[0]);
      await assert.rejects(service.describeOntology(metadataOnly, { taskId: submitted.id }), /scope|FORBIDDEN|Missing/i);
      await assert.rejects(service.describeOntology(p, {}, { ontologyId: 'eigos.business' }), /task-scoped/);
      const q = `"${t.schema}"`;
      await t.client.query(`UPDATE ${q}.security_roles SET body=jsonb_set(body::jsonb,'{expiresAt}',to_jsonb($1::text))::text`, [new Date(Date.now() - 1).toISOString()]);
      assert.deepEqual((await service.describeOntology(p, {})).types, [], 'expired roles disappear on the next call');
      await t.client.query(`UPDATE ${q}.security_subjects SET epoch=epoch+1 WHERE installation_id=$1`, [installation.id]);
      await assert.rejects(service.describeOntology(p, {}), /POLICY_CHANGED/);
    } finally { if (target) await target.close(); f.close(); }
  });
