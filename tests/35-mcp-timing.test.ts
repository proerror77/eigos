import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Worker } from '../apps/worker/worker.js';
import { bindOperationTiming, timeOperation, withOperationTiming } from '../packages/core/operation-timing.js';
import { accountGateway } from './account-harness.js';
import { fixture, route } from './fixture.js';

test('tool callbacks keep their own timing identity when invoked outside the originating scope', async t => {
  const logger = t.mock.method(console, 'info', (_line: string) => {});
  const bind = (taskId: string) => withOperationTiming({ taskId, workerRunId: taskId + '-run' }, async () =>
    bindOperationTiming((input: string) => timeOperation('agent_tool', async () => input, 'estimate')));
  const [first, second] = await Promise.all([bind('task-one'), bind('task-two')]);
  assert.deepEqual(await Promise.all([first('private-route-one'), second('private-route-two')]), ['private-route-one', 'private-route-two']);
  const records = logger.mock.calls.map(call => JSON.parse(call.arguments[0]));
  assert.deepEqual(records.map(({ taskId, workerRunId, stage }) => [taskId, workerRunId, stage]), [
    ['task-one', 'task-one-run', 'agent_tool'], ['task-two', 'task-two-run', 'agent_tool'],
  ]);
  assert(records.every(record => record.outcome === 'returned' && record.durationMs >= 0));
  assert(!JSON.stringify(records).includes('private-route'));
});

test('Gateway timings link a Grok account task to its pending and completed MCP reads', async t => {
  const f = await fixture(), gateway = await accountGateway(f, { signup: 'open' });
  const client = new Client({ name: 'test-grok-timing', version: '1' });
  const logger = t.mock.method(console, 'info', (_line: string) => {});
  try {
    const { cookie } = await gateway.login('rider', 'rider@example.test');
    assert.equal((await gateway.form('approve', cookie)).status, 303);
    const token = await gateway.token('rider', { scope: 'tasks:read tasks:write', issuedAt: Math.ceil(Date.now() / 1000) });
    await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }));
    const read = (reply: { content?: unknown }) => JSON.parse((reply.content as { text: string }[])[0]!.text);
    const submission = await client.callTool({ name: 'submit_task', arguments: {
      requestId: 'synthetic-private-request-id', message: 'synthetic-private-prompt',
    } });
    assert(!submission.isError, JSON.stringify(submission));
    const taskId = read(submission).id;
    const poll = () => client.callTool({ name: 'get_task', arguments: { taskId } });
    assert.equal(read(await poll()).state, 'submitted');

    const worker = new Worker(f.tasks, {
      async run(task) {
        assert.equal(task.id, taskId);
        return timeOperation('model_session', async () => ({ quote: 'synthetic-private-price' }));
      },
    });
    assert.equal(await worker.runOne('interactive'), true);
    const completed = read(await poll());
    assert.equal(completed.state, 'completed');
    assert.equal(completed.result.quote, 'synthetic-private-price');
    const unknown = randomUUID();
    assert.equal((await client.callTool({ name: 'get_task', arguments: { taskId: unknown } })).isError, true);

    const records = logger.mock.calls.map(call => JSON.parse(call.arguments[0]));
    const logs = records.filter(row => row.event === 'mcp_request');
    assert.deepEqual(logs.map(({ event, tool, taskState, toolStatus }) => [event, tool, taskState, toolStatus]), [
      ['mcp_request', 'submit_task', 'submitted', 200],
      ['mcp_request', 'get_task', 'submitted', 200],
      ['mcp_request', 'get_task', 'completed', 200],
      ['mcp_request', 'get_task', undefined, 404],
    ]);
    assert(logs.slice(0, 3).every(row => row.taskId === taskId && row.clientId === 'grok' && row.transport === 'sent'));
    assert.equal(logs[1].resultIncluded, false);
    assert.equal(logs[2].resultIncluded, true);
    assert.equal(logs[0].taskCreatedAt, completed.createdAt);
    assert.equal(logs[2].taskCompletedAt, completed.updatedAt);
    assert.equal(logs[3].taskId, undefined);
    assert.equal(new Set(logs.map(row => row.mcpRequestId)).size, 4);
    assert(logs.every(row => row.durationMs >= 0 && [row.receivedAt, row.toolStartedAt, row.toolFinishedAt, row.finishedAt].every(time => Number.isFinite(Date.parse(time)))));
    const workerLogs = records.filter(row => row.event !== 'mcp_request');
    assert.deepEqual(workerLogs.map(row => row.event), ['worker_claim', 'stage_timing', 'worker_finish']);
    assert(workerLogs.every(row => row.taskId === taskId && row.workerRunId === workerLogs[0].workerRunId));
    assert.equal(workerLogs[0].taskCreatedAt, completed.createdAt);
    assert(Number.isFinite(Date.parse(workerLogs[0].taskAvailableAt)));
    assert(Date.parse(workerLogs[0].taskClaimedAt) >= Date.parse(workerLogs[0].taskAvailableAt));
    assert.equal(workerLogs[1].stage, 'model_session');
    assert.equal(workerLogs[2].taskState, 'completed');
    assert(!JSON.stringify(records).includes('synthetic-private'));
    assert(!JSON.stringify(logs).includes(unknown));
  } finally {
    await client.close();
    await gateway.close();
    await f.close();
  }
});

test('one synchronous quote ties the Action, DiDi calls and readback to its MCP request', async t => {
  const f = await fixture();
  const logger = t.mock.method(console, 'info', (_line: string) => {});
  try {
    const mcpRequestId = randomUUID(), requestId = 'synthetic-private-quote-id';
    const selected = f.capabilities.actions.resolve(f.access, f.model, {
      interface: { type: 'RideInquiry', action: 'estimate', implementation: 'RideRequest' }, input: route,
    });
    await withOperationTiming({ mcpRequestId }, () => f.capabilities.actions.complete(f.access, f.model, selected, requestId,
      { function: 'readRideEstimates', resultParameter: 'request' }, undefined, AbortSignal.timeout(15000)));
    const records = logger.mock.calls.map(call => JSON.parse(call.arguments[0]));
    assert(records.every(row => row.event === 'stage_timing' && row.mcpRequestId === mcpRequestId && row.outcome === 'returned'));
    for (const stage of ['didi_read', 'didi_rpc']) {
      assert.deepEqual(records.filter(row => row.stage === stage).map(row => row.operation).sort(),
        ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    }
    assert.deepEqual(records.filter(row => row.stage === 'action_apply' || row.stage === 'result_read').map(row => row.operation),
      ['EstimateRide', 'readRideEstimates']);
    assert(!JSON.stringify(records).includes(requestId));
    assert(!JSON.stringify(records).includes(route.origin));
  } finally { await f.close(); }
});
