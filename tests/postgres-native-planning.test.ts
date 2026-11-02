import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest } from '../packages/core/delegation.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { taskContextFields } from '../packages/security/task-context-contract.js';
import { PostgresTaskCommandService } from '../packages/postgres/task-command-service.js';
import { PostgresWorkerStore } from '../packages/postgres/worker-store.js';
import { PostgresNativePlanningSession } from '../packages/postgres/native-planning-session.js';
import { openOntologyMcp } from '../packages/coordinator/ontology-mcp.js';

const value = (response: Awaited<ReturnType<Client['callTool']>>) => (response.structuredContent as { result: any }).result;

test('native MCP uses real PostgreSQL planning state, durable receipts and rollback without borrowing user reads',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true }), channel = 'synthetic:postgres-native';
    let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined, session: PostgresNativePlanningSession | undefined;
    let mcp: Awaited<ReturnType<typeof openOntologyMcp>> | undefined, client: Client | undefined, transport: StreamableHTTPClientTransport | undefined;
    const call = (params: Parameters<Client['callTool']>[0]) => client!.callTool(params, { timeout: 180000 });
    let stage = 'setup';
    let timer: ReturnType<typeof setInterval> | undefined, heartbeat: Promise<void> | undefined, heartbeatFailure: unknown;
    try {
      const installation = f.installation('Synthetic SQL native MCP', 3600000), expiresAt = new Date(Date.now() + 3600000).toISOString();
      f.coordinator.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: ['brief.prepare'],
        resources: ['ServiceRequest', ...Object.keys(taskContextFields)].map(type => ({ type, fields: Object.keys(f.jobs.security.policies.fields(type)).filter(field => f.jobs.security.policies.fieldPolicy(type, field) !== 'internal_only') })),
        sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt });
      f.jobs.security.policies.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'], channels: ['agent_response'], expiresAt }, f.jobs.security.policies.revision());
      f.jobs.security.policies.setRole({ subjectKind: 'installation', subjectId: installation.id, role: 'Viewer',
        resource: { kind: 'namespace', id: f.jobs.ontology.model.ref.id, version: f.jobs.ontology.model.ref.digest }, invokeFunctions: ['taskOutcomeStatus'], expiresAt }, f.jobs.security.policies.revision());
      f.jobs.security.policies.setModelChannel(channel, { classification: 'sensitive', markings: ['member_private', 'personal_data'], expiresAt }, f.jobs.security.policies.revision());
      const principal = { ...f.principal, scopes: ['tasks:write'], access: f.coordinator.authenticate({ ...f.principal, scopes: ['tasks:write'] }, installation.token) };
      target = await importPostgresFixture(f); const t = target, q = `"${t.schema}"`;
      const goal = 'NATIVE_SQL_ORIGINAL: read the exact original request; no orders or payments.';
      const task = await new PostgresTaskCommandService(t.database, t.policy).submit(principal, { requestId: 'native-sql-original-task', goal });
      assert.equal(task.goal, '', 'the write-only Agent receipt does not borrow the Worker model view');
      const other = await new PostgresTaskCommandService(t.database, t.policy).submit(principal, { requestId: 'other-native-sql-task', goal: 'PRIVATE_OTHER_NATIVE_SQL' });
      const worker = new PostgresWorkerStore(t.database, t.policy), claim = await worker.claim(['eigos.delegate'], 30000); assert(claim); assert.equal(claim.job.id, task.id);
      timer = setInterval(() => { if (!heartbeat) heartbeat = worker.renew(claim, 30000).then(async ok => {
        if (!ok) assert.equal((await t.client.query(`SELECT 1 FROM ${q}.requests WHERE owner=$1 AND operation=$2 AND request_id=$3`,
          [claim.owner, `eigos.worker.finish:${t.authority.digest}`, digest([claim.job.id, claim.token])])).rowCount, 1);
      }).catch(error => { heartbeatFailure = error; }).finally(() => { heartbeat = undefined; }); }, 5000); timer.unref();
      const grants = (await t.client.query(`SELECT body FROM ${q}.security_grants WHERE owner=$1 ORDER BY id`, [claim.owner])).rows;
      let rejectCommit = false;
      const store: Pick<PostgresWorkerStore, 'readRequest' | 'readEvidence'> = {
        readRequest: worker.readRequest.bind(worker),
        readEvidence: (reference, model, action) => worker.readEvidence(reference, model, async (...args) => {
          const result = await action(...args);
          if (rejectCommit) throw new Error('Synthetic failure before receipt commit');
          return result;
        }),
      };
      stage = 'session_create';
      session = await PostgresNativePlanningSession.create(store, claim, t.policy, channel, { taskContext: { purpose: 'grounding' } });
      const activeSession = session, abort = new AbortController();
      assert.equal(session.request.id, task.id); assert.equal(session.request.originalGoal, goal);
      stage = 'mcp_open';
      mcp = await openOntologyMcp(session, abort.signal, undefined, { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }, channel);
      client = new Client({ name: 'real-postgres-native-test', version: '1' });
      transport = new StreamableHTTPClientTransport(new URL(mcp.connection.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.connection.token}` } } });
      stage = 'client_connect';
      await client.connect(transport, { timeout: 180000 });
      stage = 'context_read';
      const contextResponse = await call({ name: 'read_task_context', arguments: {} }); assert(!contextResponse.isError, JSON.stringify(contextResponse));
      const context = value(contextResponse); assert.equal(context.result.data.request.originalGoal, goal); assert.equal(context.receipt.id, session.lastReceipt()!.id);
      const stored = async () => (await t.client.query(`SELECT ${q}.eigos_try_jsonb(body)#>'{delegation,ontologyReads}' AS reads FROM ${q}.jobs WHERE owner=$1 AND id=$2`, [claim.owner, task.id])).rows[0]!.reads;
      assert.equal((await stored()).length, 1);
      stage = 'foreign_read';
      const foreign = await call({ name: 'query_ontology', arguments: { object: { type: 'ServiceRequest', id: other.id } } });
      assert.equal(value(foreign).receipt.status, 'rejected'); assert(!JSON.stringify(foreign).includes('PRIVATE_OTHER_NATIVE_SQL'));
      assert.equal((await stored()).length, 2);
      stage = 'rollback_read';
      const before = session.readBudget(); rejectCommit = true;
      const failed = await call({ name: 'query_ontology', arguments: { object: { type: 'ServiceRequest', id: task.id }, select: ['originalGoal'] } });
      assert.equal(failed.isError, true); assert(!JSON.stringify(failed).includes('NATIVE_SQL_ORIGINAL'));
      assert.deepEqual(session.readBudget(), before); assert.equal(session.receipts().length, 2); assert.equal((await stored()).length, 2);
      rejectCommit = false;
      stage = 'concurrent_reads';
      const responses = await Promise.all(['originalGoal', 'requestId'].map(field => call({ name: 'query_ontology', arguments: { object: { type: 'ServiceRequest', id: task.id }, select: [field] } })));
      for (const response of responses) assert(!response.isError, JSON.stringify(response));
      assert.equal(value(responses[0]!).result.items[0].properties.originalGoal, goal);
      assert.equal(session.receipts().length, 4); assert.equal((await stored()).length, 4);
      stage = 'decision';
      const refused = await call({ name: 'submit_decision', arguments: { receiptIds: session.receipts().map(receipt => receipt.id), decisionJson: JSON.stringify({ message: 'Cannot cite a rejected read' }) } });
      assert.equal(refused.isError, true); assert.throws(() => mcp!.result(), /did not submit/);
      const receiptIds = session.receipts().filter(receipt => receipt.status === 'ok').map(receipt => receipt.id), decision = await call({ name: 'submit_decision', arguments: { receiptIds, decisionJson: JSON.stringify({ message: 'Synthetic native SQL proposal' }) } });
      assert(!decision.isError, JSON.stringify(decision)); assert.deepEqual(mcp.result().receiptIds, receiptIds);
      await t.client.query(`UPDATE ${q}.security_model_channels SET body=jsonb_set(body::jsonb,'{expiresAt}',to_jsonb($1::text))::text WHERE id=$2`, [new Date(Date.now() - 1).toISOString(), channel]);
      await assert.rejects(session.finish(), /OUTPUT_NOT_ALLOWED/);
      await t.client.query(`UPDATE ${q}.security_model_channels SET body=jsonb_set(body::jsonb,'{expiresAt}',to_jsonb($1::text))::text WHERE id=$2`, [expiresAt, channel]);
      stage = 'snapshot_finish';
      const snapshot = await session.finish(); assert.equal(snapshot.context!.receiptId, context.receipt.id); assert.deepEqual(snapshot.reads.map(receipt => receipt.id), receiptIds);
      assert.deepEqual((await t.client.query(`SELECT body FROM ${q}.security_grants WHERE owner=$1 ORDER BY id`, [claim.owner])).rows, grants);
      await client.close(); client = undefined; await transport.close(); transport = undefined; await mcp.close(); mcp = undefined;
      stage = 'worker_finish';
      assert.equal(await worker.finish(claim, job => { job.state = 'paused'; }), true);
      await assert.rejects(activeSession.authorizeModel(channel), /ACCESS_REVOKED|POLICY_CHANGED/);
      assert.equal(heartbeatFailure, undefined); stage = 'complete';
    } finally {
      if (process.env.EIGOS_TEST_REPORT_SCHEMA === '1') console.log('Synthetic native progress', JSON.stringify({ stage, receipts: session?.receipts().length, transport: mcp?.evidence() }));
      await client?.close(); await transport?.close(); await mcp?.close(); session?.close();
      if (timer) clearInterval(timer); if (heartbeat) await heartbeat;
      if (target) await target.close(); f.close();
    }
  });
