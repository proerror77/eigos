import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { accountGateway } from './account-harness.js';
import { fixture } from './fixture.js';

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

    const task = await f.tasks.claim('interactive');
    assert.equal(task?.id, taskId);
    assert(task);
    await f.db.withOwner(task.owner, () => f.tasks.finish(task, 'completed', { quote: 'synthetic-private-price' }));
    const completed = read(await poll());
    assert.equal(completed.state, 'completed');
    assert.equal(completed.result.quote, 'synthetic-private-price');
    const unknown = randomUUID();
    assert.equal((await client.callTool({ name: 'get_task', arguments: { taskId: unknown } })).isError, true);

    const logs = logger.mock.calls.map(call => JSON.parse(call.arguments[0]));
    assert.deepEqual(logs.map(({ event, tool, taskState, toolStatus }) => [event, tool, taskState, toolStatus]), [
      ['mcp_request', 'submit_task', 'submitted', 200],
      ['mcp_request', 'get_task', 'submitted', 200],
      ['mcp_request', 'get_task', 'completed', 200],
      ['mcp_request', 'get_task', undefined, 404],
    ]);
    assert(logs.slice(0, 3).every(row => row.taskId === taskId && row.clientId === 'grok' && row.transport === 'sent'));
    assert.equal(logs[1].resultIncluded, false);
    assert.equal(logs[2].resultIncluded, true);
    assert.equal(logs[2].taskCompletedAt, completed.updatedAt);
    assert.equal(logs[3].taskId, undefined);
    assert.equal(new Set(logs.map(row => row.mcpRequestId)).size, 4);
    assert(logs.every(row => row.durationMs >= 0 && [row.receivedAt, row.toolStartedAt, row.finishedAt].every(time => Number.isFinite(Date.parse(time)))));
    assert(!JSON.stringify(logs).includes('synthetic-private'));
    assert(!JSON.stringify(logs).includes(unknown));
  } finally {
    await client.close();
    await gateway.close();
    await f.close();
  }
});
