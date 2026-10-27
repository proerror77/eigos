import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AgentCard, GetTaskRequest, SendMessageRequest, Task } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createMcpServer } from '../apps/gateway/mcp.js';
import { A2AGateway, AgentUser } from '../apps/gateway/a2a.js';
import { digest } from '../packages/core/delegation.js';
import type { Job } from '../packages/core/domain.js';
import { observerFixture } from './fixtures/pipeline-observer.js';

beforeEach(t => { assert('mock' in t); t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); });

for (const secured of [false, true]) test(`${secured ? 'foundation' : 'legacy'} MCP/A2A share observation controls, task identity and safe readback`, async () => {
  const f = observerFixture(secured), server = createMcpServer(f.tasks, f.actor), client = new Client({ name: 'synthetic-observer', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await f.install(); await server.connect(b); await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }); assert(!result.isError, JSON.stringify(result));
      return (result.structuredContent as { result: Job }).result;
    };
    const submitted = await call('submit_task', { service: 'eigos.delegate', goal: '独立读取合成报名记录，不提交、不付款', requestId: randomUUID(), executionEnvironment: 'sandbox',
      observationBudget: { until: new Date(f.now() + 120000).toISOString(), maxReads: 12, maxActiveMs: 60000 } });
    await f.until(submitted.id, job => job.delegation?.phase === 'observing');
    const initial = await call('get_task', { taskId: submitted.id }), watch = initial.observation!.watches[0]!;
    const a2a = new A2AGateway(f.tasks, AgentCard.fromJSON({})), ctx = new ServerCallContext({ user: new AgentUser(f.actor) });
    const hint = { action: 'report_observation_change', expectedRevision: initial.revision, watchId: watch.id, eventId: 'synthetic-hint', contentDigest: digest('untrusted notification') };
    const request = SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), taskId: initial.id, contextId: initial.contextId, role: 'ROLE_USER', parts: [{ data: hint }] }, configuration: { returnImmediately: true } });
    await a2a.sendMessage(request, ctx); await a2a.sendMessage(request, ctx);
    assert.equal(f.store.observationWatches.watch(f.owner, watch.id).hintSequence, 1);
    const badContext = SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), taskId: initial.id, contextId: randomUUID(), role: 'ROLE_USER', parts: [{ data: hint }] }, configuration: { returnImmediately: true } });
    await assert.rejects(a2a.sendMessage(badContext, ctx));
    const invalid = await client.callTool({ name: 'control_task_observation', arguments: { ...hint, taskId: initial.id, requestId: randomUUID(), payload: { arbitrary: 'cannot become a fact' } } });
    assert.equal(invalid.isError, true);
    const stopped = await call('control_task_observation', { action: 'stop_observation', taskId: initial.id, expectedRevision: initial.revision, requestId: randomUUID() });
    assert.equal(stopped.observation!.stopped, true);
    const read = Task.toJSON(await a2a.getTask(GetTaskRequest.fromJSON({ id: initial.id }), ctx)) as { metadata: { observation: unknown } };
    assert.deepEqual(JSON.parse(JSON.stringify(read.metadata.observation)), JSON.parse(JSON.stringify(stopped.observation)));
    const resumed = await a2a.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), taskId: initial.id, contextId: initial.contextId, role: 'ROLE_USER',
      parts: [{ data: { action: 'resume_observation', expectedRevision: initial.revision } }] }, configuration: { returnImmediately: true } }), ctx);
    assert.equal(resumed.id, initial.id);
    assert.equal((await call('get_task', { taskId: initial.id })).observation!.watches[0]!.status, 'active');
    const foreign = new ServerCallContext({ user: new AgentUser({ ...f.actor, subject: 'foreign-member' }) });
    await assert.rejects(a2a.sendMessage(request, foreign));
    assert(!JSON.stringify(read).includes('PRIVATE_'));
    assert(!JSON.stringify(read).includes('sourceAccount'));
  } finally { await client.close(); await server.close(); f.close(); }
});
