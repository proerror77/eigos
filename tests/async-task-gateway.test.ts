import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { GatewayTaskService } from '../apps/gateway/task-service.js';
import { JobStore } from '../packages/core/store.js';
import { DomainError, type Job } from '../packages/core/domain.js';
import { SecurityError } from '../packages/security/errors.js';
import { LocalTasks } from './local-tasks.js';
import { principal } from './backend-fixture.js';
import { taskProtocolFixture } from './fixtures/task-protocol.js';

// The real SQLite service and Worker are exercised through delayed protocol
// operations. This tests asynchronous dispatch, not PostgreSQL persistence.
async function fixture() {
  const store = new JobStore(':memory:'), tasks = new LocalTasks(store);
  const failures = new Map<PropertyKey, Error>();
  const asynchronous = new Proxy(tasks, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key === 'services') return value.bind(target);
      return async (...args: unknown[]) => {
        await setImmediate();
        if (failures.has(key)) throw failures.get(key);
        return Reflect.apply(value, target, args);
      };
    },
  }) as GatewayTaskService;
  const protocol=await taskProtocolFixture(asynchronous,principal);
  return {...protocol,tasks,failures,close:async()=>{
    await protocol.close();await tasks.close();store.close();
  }};
}

test('asynchronous task service preserves the same task across MCP, A2A and the local Worker', async () => {
  const f = await fixture();
  try {
    const submitted = await f.job('submit_task', { goal: 'Prepare a synthetic brief', requestId: randomUUID() });
    const pending = await f.job('get_task', { taskId: submitted.id, waitMs: 30000 });
    assert.equal(pending.state, 'input-required');
    const reply = await f.rpc('SendMessage', { message: { messageId: randomUUID(), taskId: pending.id, role: 'ROLE_USER',
      metadata: { expectedRevision: pending.revision }, parts: [{ text: 'A one-page synthetic brief.' }] } });
    assert(!reply.error, JSON.stringify(reply)); assert.equal(reply.result.task.id, submitted.id);
    assert.equal(reply.result.task.status.state, 'TASK_STATE_COMPLETED');
    const read = await f.job('get_task', { taskId: submitted.id });
    assert.equal(read.state, 'completed'); assert.equal(read.artifact?.data.deliverable, 'A one-page synthetic brief.');
    const list = await f.rpc('ListTasks', { pageSize: 10 });
    assert(!list.error, JSON.stringify(list)); assert(list.result.tasks.some((task: { id: string }) => task.id === submitted.id));
    const listed = await f.call('list_tasks', { limit: 10 });
    assert(!listed.isError); assert((listed.structuredContent as { result: { jobs: Job[] } }).result.jobs.some(task => task.id === submitted.id));
    const other = await f.job('submit_task', { goal: 'Another synthetic brief', requestId: randomUUID() });
    const canceled = await f.rpc('CancelTask', { id: other.id });
    assert(!canceled.error, JSON.stringify(canceled)); assert.equal(canceled.result.status.state, 'TASK_STATE_CANCELED');
    assert.equal((await f.job('get_task', { taskId: other.id })).state, 'canceled');
  } finally { await f.close(); }
});

test('asynchronous service denials retain MCP and A2A error contracts, including blocking waits', async () => {
  const f = await fixture();
  try {
    f.failures.set('get', new DomainError('NOT_FOUND', 'private diagnostic'));
    const missing = await f.rpc('GetTask', { id: randomUUID() });
    assert.equal(missing.error.code, -32001); assert(!JSON.stringify(missing).includes('private diagnostic'));
    f.failures.set('cancel', new DomainError('CONFLICT', 'Task cannot be canceled'));
    assert.equal((await f.rpc('CancelTask', { id: randomUUID() })).error.code, -32002);
    f.failures.set('submit', new SecurityError('ACCESS_REVOKED', 'private diagnostic'));
    const denied = await f.call('submit_task', { goal: 'Synthetic', requestId: randomUUID() });
    assert(denied.isError); assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'ACCESS_REVOKED');
    assert(!JSON.stringify(denied).includes('private diagnostic'));
    const deniedA2a = await f.rpc('SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Synthetic' }] } });
    assert.match(deniedA2a.error.message, /ACCESS_REVOKED/); assert(!JSON.stringify(deniedA2a).includes('private diagnostic'));
    f.failures.delete('submit'); f.failures.set('wait', new SecurityError('OUTPUT_NOT_ALLOWED', 'private diagnostic'));
    const wait = await f.rpc('SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Synthetic' }] } });
    assert.match(wait.error.message, /OUTPUT_NOT_ALLOWED/); assert(!JSON.stringify(wait).includes('private diagnostic'));
  } finally { await f.close(); }
});
