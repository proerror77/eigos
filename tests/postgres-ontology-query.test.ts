import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { currentKernelImplementation } from '../packages/ontology/definition-store.js';
import { AuthorizedOntologyView } from '../packages/security/view.js';
import { PostgresTaskReadService } from '../packages/postgres/task-read-service.js';
import type { ObjectQuery } from '../packages/ontology/object-store.js';
import type { TaskServicePort } from '../packages/core/task-service-port.js';
import { taskProtocolFixture } from './fixtures/task-protocol.js';

test('PostgreSQL task queries filter visibility before predicates and pages, retaining opaque cursor and field boundaries',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true }), sqlite = new DatabaseSync(f.database);
    let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
    try {
      const model = currentKernelImplementation(), raw = new OntologyObjectStore(sqlite, model, Date.now, undefined, { skipLegacyMigration: true });
      const a = f.installation('Synthetic query A', 3600000), b = f.installation('Synthetic query B', 3600000);
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      for (const installation of [a, b]) {
        f.coordinator.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: ['brief.prepare'],
          resources: [{ type: 'ServiceRequest', fields: ['requestId', 'originalGoal'] },
            { type: 'Place', fields: ['placeId', 'displayTitle', 'name', 'address'] },
            { type: 'HotelProperty', fields: ['objectId', 'displayTitle', 'hotelName'] }], sourceBindingIds: [],
          channels: ['agent_response', 'registered_model'], expiresAt });
        f.jobs.security.policies.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'],
          channels: ['agent_response'], expiresAt }, f.jobs.security.policies.revision());
        f.jobs.security.policies.setRole({ subjectKind: 'installation', subjectId: installation.id, role: 'Viewer', expiresAt,
          resource: { kind: 'namespace', id: model.ref.id, version: model.ref.digest } }, f.jobs.security.policies.revision());
      }
      const p = { ...f.principal, access: f.coordinator.authenticate(f.principal, a.token) };
      const other = { ...f.principal, access: f.coordinator.authenticate(f.principal, b.token) };
      const refs = ['a-visible', 'b-hidden', 'c-visible', 'd-visible'].map(id => ({ type: 'Place', id }));
      for (const ref of refs) {
        const receipt = { type: 'SourceReceipt', id: `receipt-${ref.id}` };
        raw.ingest(f.owner, { objects: [{ ref, properties: { placeId: ref.id, displayTitle: ref.id,
          name: ref.id, address: { text: 'Synthetic private street' } } }, { ref: receipt,
          properties: { receiptId: receipt.id, displayTitle: 'Synthetic fixture', safeSummary: 'Synthetic fixture', evidenceLevel: 'synthetic' } }],
          links: [{ type: 'PlaceEvidence', from: ref, to: receipt }] }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
      }
      const hotel = { type: 'HotelProperty', id: 'synthetic-hotel' };
      raw.ingest(f.owner, { objects: [{ ref: hotel, properties: { objectId: hotel.id, displayTitle: 'Hotel', hotelName: 'Synthetic hotel' } }],
        links: [{ type: 'HotelPropertyLocation', from: hotel, to: refs[0]! }] }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
      const task = f.task(a.id);
      f.jobs.security.revokeGrant(f.owner, task.grant.id, 1);
      const grant = f.jobs.security.issueTaskGrant({ ...task.grant, id: randomUUID(),
        operations: ['task.query', 'task.process', 'task.result.read', 'member_asset.read'], channels: ['agent_response', 'registered_model'],
        inputs: [...refs.filter(ref => ref.id !== 'b-hidden').map(object => ({ object, objectRevision: 1, fields: ['placeId', 'displayTitle', 'name'] })),
          { object: hotel, objectRevision: 1, fields: ['objectId', 'displayTitle', 'hotelName'] }] });
      const source = new AuthorizedOntologyView(f.jobs.ontology, f.jobs.security, p);
      const input = (query: ObjectQuery) => ({ version: 2, taskId: task.job.id, expectedRequestRevision: 1, query });
      const queries: ObjectQuery[] = [{ object: { type: 'ServiceRequest', id: task.job.id } }, { type: 'Place' },
        { type: 'Place', where: [{ property: 'name', op: 'eq', value: 'c-visible' }], select: ['name'] },
        { from: hotel, as: 'Located', link: 'location' },
        { type: 'Place', where: [{ property: 'address', op: 'eq', value: 'not a scalar' }] }];
      const expected = queries.slice(0, -1).map(query => source.query(input(query)));
      const sourcePage = source.query(input({ type: 'Place', limit: 1 }));
      assert(sourcePage.page.cursor);
      target = await importPostgresFixture(f);
      const t = target, service = new PostgresTaskReadService(t.database, t.policy), q = `"${t.schema}"`;
      const query = async (value: ObjectQuery) => { await t.refreshEligibility(); return service.queryOntology(p, input(value)); };
      for (let index = 0; index < expected.length; index++) assert.deepEqual(await query(queries[index]!), expected[index]);
      const importedContinuation = await query({ type: 'Place', limit: 1, cursor: sourcePage.page.cursor });
      assert.deepEqual(importedContinuation.items.map(item => item.ref.id), ['c-visible'], 'existing SQLite cursor remains on its original task and grant');
      const port = new Proxy({} as TaskServicePort, { get(_target, property) {
        if (property === 'secured') return true;
        if (property === 'services') return () => [];
        const method = Reflect.get(service, property);
        if (typeof method === 'function') return method.bind(service);
        return async () => { throw new Error('Fixture operation is not connected'); };
      } });
      const protocol = await taskProtocolFixture(port, p);
      try {
        const delivered = await protocol.call('query_ontology', input({ type: 'Place' }));
        assert(!delivered.isError, JSON.stringify(delivered));
        assert.deepEqual((delivered.structuredContent as { result: unknown }).result, JSON.parse(JSON.stringify(expected[1])));
      } finally { await protocol.close(); }
      await t.client.query(`INSERT INTO ${q}.security_bindings
        SELECT grant_id,owner,task_id,request_revision,'unrelated-invalid-type','ignored',object_revision,'invalid unrelated body'
        FROM ${q}.security_bindings WHERE grant_id=$1 LIMIT 1`, [grant.id]);
      assert.deepEqual(await query({ type: 'Place' }), expected[1], 'a narrow query does not inspect unrelated binding metadata');
      const page = await query({ type: 'Place', limit: 1 });
      assert.deepEqual(page.items.map(item => item.ref.id), ['a-visible']); assert.equal(page.page.hasMore, true);
      assert.match(page.page.cursor!, /^[a-f0-9-]{36}$/); assert(!page.page.cursor!.includes('Place'));
      const next = await query({ type: 'Place', limit: 1, cursor: page.page.cursor });
      assert.deepEqual(next.items.map(item => item.ref.id), ['c-visible']);
      assert.equal((await query({ type: 'Place', where: [{ property: 'name', op: 'eq', value: 'b-hidden' }] })).items.length, 0);
      await assert.rejects(query({ object: refs[1]! }), /AUTHORIZATION_REQUIRED|not available/);
      await assert.rejects(query({ type: 'Place', select: ['address'] }), /INSUFFICIENT_ACCESS/);
      await assert.rejects(query({ object: refs[0]!, as: 'Addressable', select: ['address'] }), /INSUFFICIENT_ACCESS/);
      await assert.rejects(query(queries.at(-1)!), /scalar/);
      await assert.rejects(service.queryOntology(other, input({ type: 'Place' })), /AUTHORIZATION_REQUIRED/);
      await assert.rejects(service.queryOntology(p, { ...input({ type: 'Place' }), expectedRequestRevision: 2 }), /POLICY_CHANGED/);
      await assert.rejects(query({ type: 'Place', limit: 2, cursor: page.page.cursor }), /POLICY_CHANGED/);
      await t.client.query(`UPDATE ${q}.security_cursors SET expires_at=$1`, [Date.now() - 1]);
      await assert.rejects(query({ type: 'Place', limit: 1, cursor: page.page.cursor }), /POLICY_CHANGED/);
      await t.client.query(`INSERT INTO ${q}.security_bindings
        SELECT b.grant_id,b.owner,b.task_id,b.request_revision,'unrelated-invalid-type','budget-'||series.n,b.object_revision,'invalid unrelated body'
        FROM (SELECT * FROM ${q}.security_bindings WHERE grant_id=$1 LIMIT 1) b CROSS JOIN generate_series(1,2000) AS series(n)`, [grant.id]);
      await assert.rejects(query({ object: { type: 'ServiceRequest', id: task.job.id } }), /Task object boundary/);
      await t.client.query(`UPDATE ${q}.security_subjects SET epoch=epoch+1 WHERE installation_id=$1`, [a.id]);
      await assert.rejects(service.queryOntology(p, input({ type: 'Place' })), /POLICY_CHANGED/);
    } finally { if (target) await target.close(); sqlite.close(); f.close(); }
  });
