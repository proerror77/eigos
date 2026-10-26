import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openOntologyMcp } from '../packages/coordinator/ontology-mcp.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { DomainError } from '../packages/core/domain.js';
import { reasonWithOntology } from '../packages/coordinator/reasoning-loop.js';
import { backend, owner, evidence } from './backend-fixture.js';

async function fixture(finalSchema?: object) {
  const b = backend(createExecutionCatalog()), job = b.submit(), other = b.submit({ requestId: 'another-owned-task' });
  let authorized = true;
  const abort = new AbortController();
  const session = new OntologyPlanningSession(b.store.ontology, owner, job.delegation!.request, [], () => {
    if (!authorized) throw new DomainError('FORBIDDEN', 'Claim expired');
  }, undefined, 'request', [], { taskContext: { purpose: 'grounding' } });
  const mcp = await openOntologyMcp(session, abort.signal, undefined, finalSchema);
  const client = new Client({ name: 'native-protocol-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(mcp.connection.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.connection.token}` } } });
  await client.connect(transport);
  return { b, job, other, session, mcp, client, abort, expire: () => { authorized = false; },
    close: async () => { await client.close(); await transport.close(); await mcp.close(); b.store.close(); } };
}
const value = (response: Awaited<ReturnType<Client['callTool']>>) => (response.structuredContent as { result: any }).result;

test('invalid final schema is corrected in the same native session before any decision freezes', async () => {
  const f = await fixture({ type: 'object', properties: { requestRevision: { type: 'integer', minimum: 1 } }, required: ['requestRevision'], additionalProperties: false });
  try {
    const read = value(await f.client.callTool({ name: 'read_task_context', arguments: {} }));
    const receiptIds = [read.receipt.id];
    assert((await f.client.callTool({ name: 'submit_decision', arguments: { receiptIds, decisionJson: '{"requestRevision":null}' } })).isError);
    assert.throws(() => f.mcp.result(), /did not submit/);
    const response = await f.client.callTool({ name: 'submit_decision', arguments: { receiptIds, decisionJson: '{"requestRevision":1}' } });
    assert(!response.isError); assert.deepEqual(f.mcp.result().output, { requestRevision: 1 });
    assert.equal(f.b.store.intents(owner, f.job.id).length, 0);
  } finally { await f.close(); }
});

test('native Ontology MCP authenticates its session and confines reads to the bound task', async () => {
  const f = await fixture();
  try {
    for (const token of ['', 'wrong']) {
      const response = await fetch(f.mcp.connection.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      assert.equal(response.status, 401);
    }
    const directory = (await f.client.listTools()).tools;
    const tools = directory.map(t => t.name);
    const evaluate = directory.find(t => t.name === 'evaluate_ontology')!.inputSchema;
    assert(evaluate.properties?.function && evaluate.properties.object, 'Native clients must see the actual function/object argument names at the root');
    assert.equal((evaluate.properties.function as { type: string }).type, 'string');
    assert((evaluate.properties.function as { enum: string[] }).enum.includes('rideEstimateStatus'));
    assert(directory.find(t => t.name === 'query_ontology')!.inputSchema.properties?.object);
    assert(tools.includes('read_task_context') && tools.includes('submit_decision'));
    assert(!tools.includes('submit_task') && !tools.includes('execute_action'));
    const read = value(await f.client.callTool({ name: 'read_task_context', arguments: {} }));
    assert.equal(read.result.data.request.id, f.job.id); assert.equal(read.receipt.status, 'ok');
    assert((await f.client.callTool({ name: 'evaluate_ontology', arguments: { function: 'rideEstimateStatus', object: { type: 'ServiceRequest', id: f.job.id }, argumentsJson: JSON.stringify({ object: { type: 'ServiceRequest', id: f.other.id } }) } })).isError, 'Extra parameters cannot replace the selected object');
    const mixed = value(await f.client.callTool({ name: 'query_ontology', arguments: { object: { type: 'ServiceRequest', id: f.job.id }, type: 'ServiceRequest' } }));
    assert.equal(mixed.receipt.status, 'rejected', 'The original union still rejects mixed alternatives');
    const foreign = value(await f.client.callTool({ name: 'query_ontology', arguments: { object: { type: 'ServiceRequest', id: f.other.id } } }));
    assert.equal(foreign.receipt.status, 'rejected'); assert.equal(foreign.result.error, 'FORBIDDEN');
    assert(!JSON.stringify(foreign).includes(f.other.goal));
    f.expire();
    const count = f.session.receipts().length;
    const denied = await f.client.callTool({ name: 'read_task_context', arguments: {} });
    assert(denied.isError); assert.equal(f.session.receipts().length, count);
  } finally { await f.close(); }
});

test('native decision completion requires real receipts and freezes the proposal without executing it', async () => {
  const f = await fixture();
  try {
    const rejected = await f.client.callTool({ name: 'submit_decision', arguments: { receiptIds: ['invented'], decisionJson: '{}' } });
    assert(rejected.isError); assert.throws(() => f.mcp.result(), /did not submit/);
    const read = value(await f.client.callTool({ name: 'read_task_context', arguments: {} }));
    const args = { receiptIds: [read.receipt.id], decisionJson: JSON.stringify({ requestRevision: 1 }) };
    const accepted = value(await f.client.callTool({ name: 'submit_decision', arguments: args }));
    assert.equal(accepted.execution, 'not_dispatched'); assert.equal(accepted.taskId, f.job.id);
    assert.deepEqual(value(await f.client.callTool({ name: 'submit_decision', arguments: args })), accepted);
    assert((await f.client.callTool({ name: 'submit_decision', arguments: { ...args, decisionJson: '{"requestRevision":2}' } })).isError);
    assert((await f.client.callTool({ name: 'read_task_context', arguments: {} })).isError);
    assert.equal(f.mcp.result().digest, accepted.decisionDigest);
    assert.equal(f.b.store.get(owner, f.job.id).artifact, undefined);
    assert.equal(f.b.store.intents(owner, f.job.id).length, 0);
    assert(f.mcp.evidence().decisionSubmitted);
    f.expire();
    assert((await f.client.callTool({ name: 'submit_decision', arguments: args })).isError, 'Idempotent decision readback still requires the current claim');
  } finally { await f.close(); }
});

test('aborting a native model session closes the endpoint and rejects late decisions', async () => {
  const f = await fixture();
  try {
    await f.client.callTool({ name: 'read_task_context', arguments: {} });
    f.abort.abort();
    await assert.rejects(fetch(f.mcp.connection.url, { headers: { Authorization: `Bearer ${f.mcp.connection.token}` } }));
    assert.throws(() => f.mcp.result());
    assert.equal(f.session.receipts().length, 1);
  } finally { await f.close(); }
});

test('plain model JSON cannot replace native MCP completion and the attempted run remains accounted for', async () => {
  const f = await fixture();
  let runs = 0;
  try {
    await assert.rejects(reasonWithOntology({ ontologyTransport: 'native-mcp', runStructured: async prompt => {
      assert(prompt.includes('mcp__eigos_ontology__read_task_context'));
      assert(prompt.includes('mcp__eigos_ontology__submit_decision'));
      return { output: { decisionDigest: 'a'.repeat(64) }, evidence: evidence() };
    } }, 'Read this task.', {}, f.session, new AbortController().signal, run => {
      runs++; assert.equal(run.ontologyMcp?.decisionSubmitted, false); assert.equal(run.ontologyMcp?.calls.length, 0);
    }), /did not submit a decision through native/);
    assert.equal(runs, 1); assert.equal(f.b.store.get(owner, f.job.id).artifact, undefined);
  } finally { await f.close(); }
});
