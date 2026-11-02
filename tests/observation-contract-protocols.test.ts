import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AgentCard, GetTaskRequest, CancelTaskRequest, SendMessageRequest } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createMcpServer } from '../apps/gateway/mcp.js';
import { A2AGateway, AgentUser } from '../apps/gateway/a2a.js';
import type { TaskSummary } from '../packages/core/task-summary.js';
import { observationContractFixture } from './fixtures/observation-contract.js';

test('MCP and A2A prepare, read and cancel the same inactive guardian without leaking private targets', async () => {
  const f = observationContractFixture(), server = createMcpServer(f.tasks, f.p), client = new Client({ name: 'watch-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    const args = f.input(), prepared = await client.callTool({ name: 'prepare_observation_contract', arguments: args });
    assert(!prepared.isError, JSON.stringify(prepared));
    const task = (prepared.structuredContent as { result: TaskSummary }).result;
    assert.equal(task.state, 'paused'); assert.equal(task.observation!.monitoring, false);
    const gateway = new A2AGateway(f.tasks, AgentCard.fromJSON({})), ctx = new ServerCallContext({ user: new AgentUser(f.p) });
    const read = await gateway.getTask(GetTaskRequest.fromJSON({ id: task.id }), ctx);
    assert.deepEqual(read.metadata?.observation, task.observation);
    assert.equal(read.metadata?.internalState, 'paused');
    await gateway.cancelTask(CancelTaskRequest.fromJSON({ id: task.id }), ctx);
    const canceled = await client.callTool({ name: 'get_task', arguments: { taskId: task.id } });
    const view = (canceled.structuredContent as { result: TaskSummary }).result;
    assert.equal(view.observation!.status, 'revoked'); assert.equal(view.state, 'canceled');
    const second = f.input();
    const native = await gateway.sendMessage(SendMessageRequest.fromJSON({ configuration: { returnImmediately: true }, message: {
      role: 'ROLE_USER', messageId: second.requestId, taskId: f.original.id, contextId: f.original.contextId, parts: [{ data: second }],
    } }), ctx);
    assert('status' in native); assert.notEqual(native.id, task.id);
    const same = await client.callTool({ name: 'get_task', arguments: { taskId: native.id } });
    const sameTask = (same.structuredContent as { result: TaskSummary }).result;
    assert.deepEqual(sameTask.observation, native.metadata?.observation);
    for (const value of [prepared, read, canceled, native, same]) {
      const json = JSON.stringify(value); assert(!json.includes('PRIVATE_ACCOUNT')); assert(!json.includes('PRIVATE_NATIVE')); assert(!json.includes('private-synthetic'));
    }
    assert.equal(f.jobs.get(f.owner, f.original.id).state, 'completed'); assert.equal(f.modelInputs.length, 0);
    assert.equal(f.sourceCalls(), 0);
    const bad = f.input();
    await assert.rejects(gateway.sendMessage(SendMessageRequest.fromJSON({ configuration: { returnImmediately: true }, message: {
      role: 'ROLE_USER', messageId: randomUUID(), taskId: f.original.id, parts: [{ data: { ...bad, originalTaskId: randomUUID() } }],
    } }), ctx), /Original task reference/);
  } finally { await client.close(); await server.close(); f.close(); }
});
