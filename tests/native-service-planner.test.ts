import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openOntologyMcp } from '../packages/coordinator/ontology-mcp.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import type { ServicePlan } from '../packages/coordinator/service-planner.js';
import { setupDidi, input } from './fixtures/didi.js';
import { owner } from './backend-fixture.js';

test('the native task MCP publishes and executes the read-only planning contract with actual receipts', async () => {
  const t = setupDidi(), job = t.b.submit(), request = job.delegation!.request;
  const session = new OntologyPlanningSession(t.store.ontologyForJob(owner, job), owner, request, [], undefined, undefined, 'request', [], {
    taskContext: { purpose: 'grounding' }, actionCatalog: t.catalog,
  });
  const endpoint = await openOntologyMcp(session, new AbortController().signal);
  const client = new Client({ name: 'native-planning-contract-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.connection.url), { requestInit: { headers: { Authorization: `Bearer ${endpoint.connection.token}` } } });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'plan_services');
    assert(tool); assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.inputSchema.type, 'object'); assert(tool.inputSchema.properties?.goal);
    const args = { goal: { kind: 'needs', needs: [{ id: 'ride', role: 'ride.estimate',
      source: { messageId: request.messages[0]!.id, quote: request.messages[0]!.text },
      output: { type: 'RideEstimateObservation', phase: 'quote' }, target: { origin: input.origin, destination: input.destination } }] } };
    const beforeContext = await client.callTool({ name: 'plan_services', arguments: args });
    assert.equal((beforeContext.structuredContent as { result: { receipt: { status: string } } }).result.receipt.status, 'rejected');
    const context = await client.callTool({ name: 'read_task_context', arguments: {} });
    assert(!context.isError);
    const result = await client.callTool({ name: 'plan_services', arguments: args });
    assert(!result.isError);
    const value = (result.structuredContent as { result: { result: ServicePlan; receipt: { id: string; status: string } } }).result;
    assert.equal(value.receipt.status, 'ok'); assert.equal(value.result.needs[0]!.alternatives[0]!.steps.length, 3);
    assert.equal(value.result.executionAllowed, false); assert.equal(value.result.availabilityProof, false);
    assert.equal(session.lastReceipt()!.id, value.receipt.id);
    assert.equal(session.lastReceipt()!.actionBindings!.pins.length, 2);
    assert.equal(t.calls.length, 0); assert.equal(t.store.intents(owner, job.id).length, 0);
    assert.throws(() => endpoint.result(), /did not submit/, 'A planner proposal never becomes a model decision automatically');
  } finally { await client.close(); await transport.close(); await endpoint.close(); t.close(); }
});
