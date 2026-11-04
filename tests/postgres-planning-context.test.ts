import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '../packages/core/delegation.js';
import { test } from 'node:test';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { PostgresTaskCommandService } from '../packages/postgres/task-command-service.js';
import { PostgresWorkerStore } from '../packages/postgres/worker-store.js';
import { postgresTaskQuerySelection } from '../packages/postgres/task-read-access.js';
import { withPostgresPlanningReadGraph } from '../packages/postgres/planning-read-graph.js';
import { runGraphProgramAsync } from '../packages/ontology/graph-program.js';
import { readTaskContextProgram, assertTaskContextCurrentProgram, readTaskInstructionsProgram } from '../packages/coordinator/task-context.js';
import { taskContextFields } from '../packages/security/task-context-contract.js';
import { assessConditionsProgram } from '../packages/coordinator/conditions.js';
import { PostgresPlanningReadRows } from '../packages/postgres/ontology-read-query.js';

test('a processing-only PostgreSQL Worker reconstructs the original graph context without a user read token',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true });
    let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined, heartbeat: Promise<void> | undefined, heartbeatFailure: unknown;
    try {
      const installation = f.installation('Synthetic native planning context', 3600000);
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      f.coordinator.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: ['brief.prepare'],
        resources: ['ServiceRequest', ...Object.keys(taskContextFields)].map(type => ({ type, fields: Object.keys(f.jobs.security.policies.fields(type)).filter(field => f.jobs.security.policies.fieldPolicy(type, field) !== 'internal_only') })),
        sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt });
      f.jobs.security.policies.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'], channels: ['agent_response'], expiresAt }, f.jobs.security.policies.revision());
      f.jobs.security.policies.setRole({ subjectKind: 'installation', subjectId: installation.id, role: 'Viewer',
        resource: { kind: 'namespace', id: f.jobs.ontology.model.ref.id, version: f.jobs.ontology.model.ref.digest }, invokeFunctions: ['taskOutcomeStatus'], expiresAt }, f.jobs.security.policies.revision());
      f.jobs.security.policies.setModelChannel('synthetic:planning-context', { classification: 'sensitive', markings: ['member_private', 'personal_data'], expiresAt }, f.jobs.security.policies.revision());
      const p = { ...f.principal, scopes: ['tasks:write'], access: f.coordinator.authenticate({ ...f.principal, scopes: ['tasks:write'] }, installation.token) };
      target = await importPostgresFixture(f); const t = target;
      const service = new PostgresTaskCommandService(t.database, t.policy);
      const goal = 'Preserve this exact original request. Query only; no orders or payments.';
      const task = await service.submit(p, { requestId: 'original-native-context', goal });
      const other = await service.submit(p, { requestId: 'another-native-context', goal: 'Another owned task remains outside the original claim.' });
      const worker = new PostgresWorkerStore(t.database, t.policy), claim = await worker.claim(['eigos.delegate'], 30000); assert(claim); assert.equal(claim.job.id, task.id);
      const q = `"${t.schema}"`, specification = (await t.client.query(`SELECT id FROM ${q}.ontology_objects WHERE owner=$1 AND type='RequestSpecification' AND ${q}.eigos_try_jsonb(body)#>>'{source,id}'=$2`, [claim.owner, task.id])).rows[0]!;
      const change = { id: randomUUID(), componentId: 'synthetic-source', object: { type: 'RequestSpecification', id: specification.id }, reason: 'changed', fields: ['requestedDeliverable'], semanticRevision: 2, at: new Date().toISOString() };
      await t.client.query(`INSERT INTO ${q}.ontology_pipeline_fact_changes(id,owner,job_id,request_revision,body) VALUES($1,$2,$3,1,$4)`, [change.id, claim.owner, task.id, JSON.stringify(change)]);
      timer = setInterval(() => { if (!heartbeat) heartbeat = worker.renew(claim, 30000).then(async ok => {
        if (!ok) assert.equal((await t.client.query(`SELECT 1 FROM ${q}.requests WHERE owner=$1 AND operation=$2 AND request_id=$3`,
          [claim.owner, `eigos.worker.finish:${t.authority.digest}`, digest([claim.job.id, claim.token])])).rowCount, 1);
      }).catch(error => { heartbeatFailure = error; }).finally(() => { heartbeat = undefined; }); }, 5000); timer.unref();
      let escaped: Parameters<Parameters<typeof withPostgresPlanningReadGraph>[6]>[0] | undefined;
      let objectReads = 0;
      const context = await worker.readEvidence(claim, 'synthetic:planning-context', (auth, admission, principal, client) =>
        withPostgresPlanningReadGraph(client, principal, task.id, t.policy, {
          ...auth, async readObject(...args) { objectReads++; return auth.readObject(...args); },
        }, admission, async graph => {
          escaped = graph;
          assert.equal(principal.access?.actorKind, 'worker'); assert(!principal.scopes.includes('tasks:read'));
          assert.deepEqual(admission.grant.operations.includes('task.query'), false);
          const context = await runGraphProgramAsync(graph, readTaskContextProgram(graph, claim.owner, task.id, 1,
            { purpose: 'grounding' }, 'actual-sql-context', [], { includeDefinitions: false }));
          assert.equal(context.data.request.originalGoal, goal); assert.equal(context.data.request.messages[0]!.text, goal);
          assert.deepEqual(context.data.sourceChanges, [change]);
          assert.equal(context.context.requestId, task.id); assert.equal(context.context.instructionCount, 1);
          assert(context.instructionRefs.length); assert(graph.evidence()!.lineage.length);
          const originalQuery = client.query, physical = { exists: 0, related: 0 };
          client.query = new Proxy(originalQuery, { apply(method, receiver, args) {
            const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
            if (typeof sql === 'string') {
              if (sql.startsWith(`SELECT 1 FROM ${q}.ontology_objects WHERE`)) physical.exists++;
              if (sql.startsWith('SELECT selected.type,selected.object_id')) physical.related++;
            }
            return Reflect.apply(method, receiver, args);
          } });
          try {
            const root = { type: 'ServiceRequest', id: task.id }, budget = { remaining: 2 }, before = objectReads;
            const first = await graph.read(claim.owner, root, budget);
            first.properties.originalGoal = 'A caller cannot change the next checked view';
            assert.equal((await graph.read(claim.owner, root, budget)).properties.originalGoal, goal);
            assert.equal(objectReads - before, 2, 'each logical read still checks the object authorization');
            assert.equal(budget.remaining, 0);
            await assert.rejects(graph.read(claim.owner, root, budget), /work budget/);
            assert(physical.exists <= 1, 'repeated existence checks share only raw rows in this callback');
            const navigation = graph.model.sides(root.type).find(side => side.other.type === 'RequestSpecification')!;
            const query = { from: root, link: navigation.side.name, limit: 1,
              select: [graph.model.object('RequestSpecification').primaryKey, graph.model.object('RequestSpecification').titleKey] };
            const firstQuery = await graph.query(claim.owner, query), secondQuery = await graph.query(claim.owner, query);
            assert.equal(firstQuery.items.length, 1); assert.deepEqual(secondQuery.items, firstQuery.items);
            assert(physical.related <= 1, 'each checked relationship query reuses only its raw candidate rows');
          } finally { client.query = originalQuery; }
          const selection = await postgresTaskQuerySelection(client, principal, task.id, t.policy), size = selection.rows.length, revision = selection.revision;
          selection.rows.length = 0; selection.revision = 0;
          const again = await postgresTaskQuerySelection(client, principal, task.id, t.policy);
          assert.equal(again.rows.length, size); assert.equal(again.revision, revision);
          assert.deepEqual(await runGraphProgramAsync(graph, assessConditionsProgram(graph, claim.owner, context.data.request)), []);
          await assert.rejects(graph.read(claim.owner, { type: 'ServiceRequest', id: other.id }), /AUTHORIZATION_REQUIRED/);
          assert.throws(() => graph.ingest(), /AUTHORIZATION_REQUIRED/); assert.throws(() => graph.readPrivate(), /AUTHORIZATION_REQUIRED/);
          assert.throws(() => graph.planning.virtualMembership(claim.owner, { id: 'different-task', revision: 1 }, { type: 'ServiceRequest', id: task.id }), /AUTHORIZATION_REQUIRED/);
          return context;
        }));
      await assert.rejects(escaped!.read(claim.owner, { type: 'ServiceRequest', id: task.id }), /AUTHORIZATION_REQUIRED/);
      let rawRows: PostgresPlanningReadRows | undefined, loaded = 0;
      await t.run(async client => {
        rawRows = new PostgresPlanningReadRows(client);
        const load = async () => { loaded++; return (await client.query<{ marker: string }>("SELECT 'synthetic original'::text AS marker")).rows; };
        const first = await rawRows.read(client, ['synthetic-row'], load); first[0]!.marker = 'changed by caller';
        assert.equal((await rawRows.read(client, ['synthetic-row'], load))[0]!.marker, 'synthetic original');
        assert.equal(loaded, 1);
      });
      await t.database.run(async client => {
        await assert.rejects(rawRows!.read(client, ['synthetic-row'], async () => []), /AUTHORIZATION_REQUIRED/, 'another client cannot use the original raw rows');
      });
      await t.run(async client => {
        await assert.rejects(rawRows!.read(client, ['synthetic-row'], async () => []), /AUTHORIZATION_REQUIRED/, 'the same client cannot lend a new transaction to an old cache');
        rawRows!.close();
        await assert.rejects(rawRows!.read(client, ['synthetic-row'], async () => []), /AUTHORIZATION_REQUIRED/);
      });
      // Native tools own separate snapshots; a preceding call cannot lend its
      // identity projection lifetime or cached permission to a later RPC.
      await worker.readEvidence(claim, 'synthetic:planning-context', (auth, admission, principal, client) =>
        withPostgresPlanningReadGraph(client, principal, task.id, t.policy, auth, admission, graph =>
          runGraphProgramAsync(graph, assertTaskContextCurrentProgram(graph, claim.owner, context.context))));
      await worker.readEvidence(claim, 'synthetic:planning-context', (auth, admission, principal, client) =>
        withPostgresPlanningReadGraph(client, principal, task.id, t.policy, auth, admission, async graph => {
          const instructions = await runGraphProgramAsync(graph, readTaskInstructionsProgram(graph, claim.owner, task.id, 1, { limit: 1 }));
          assert.equal(instructions.items[0]!.properties.text, goal);
        }));
      await worker.readEvidence(claim, 'synthetic:planning-context', (auth, admission, principal, client) =>
        withPostgresPlanningReadGraph(client, principal, task.id, t.policy, auth, admission, async graph => {
          const value = await graph.evaluate(claim.owner, { function: 'taskOutcomeStatus', object: { type: 'ServiceRequest', id: task.id } });
          assert.equal(value.status, 'unknown'); assert.equal(value.functionRef.id, 'taskOutcomeStatus');
          assert.equal(value.model.version, 'authorized.v2'); assert.equal(value.model.id, graph.model.ref.id);
          assert.notEqual(value.model.digest, graph.model.ref.digest);
        }));
      await t.client.query(`INSERT INTO ${q}.security_labels(owner,type,object_id,field,body) VALUES($1,$2,$3,$4,$5)`,
        [claim.owner, change.object.type, change.object.id, 'requestedDeliverable', JSON.stringify({ classification: 'internal', requiredMarkings: [], channels: ['agent_response'] })]);
      await worker.readEvidence(claim, 'synthetic:planning-context', (auth, admission, principal, client) =>
        withPostgresPlanningReadGraph(client, principal, task.id, t.policy, auth, admission, async graph => {
          assert.deepEqual(await graph.planning.pipelineChanges(claim.owner, task.id, 1), [], 'a removed field notice retains its current field and model restrictions');
        }));
      assert.equal(await worker.finish(claim, job => { job.state = 'paused'; }), true);
      assert.equal(heartbeatFailure, undefined);
    } finally { if (timer) clearInterval(timer); if (heartbeat) await heartbeat; if (target) await target.close(); f.close(); }
  });
