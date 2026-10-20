import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AgentCard, GetTaskRequest, Task, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createMcpServer } from '../apps/gateway/mcp.js';
import { A2AGateway, AgentUser } from '../apps/gateway/a2a.js';
import { taskSummary, type TaskSummary } from '../packages/core/task-summary.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { backend, owner, principal } from './backend-fixture.js';
import { scheduleTaskRecovery } from '../packages/core/task-recovery.js';
import type { Job, Principal } from '../packages/core/domain.js';
import type { ExecutionPlan } from '../packages/ontology/execution.js';

function addInternalReads(job: Job, count: number) {
  job.delegation!.ontologyReads = Array.from({ length: count }, (_, n) => ({
    id: `internal-read-${n}`, at: job.createdAt, tool: 'read_task_context', inputDigest: 'input', outputDigest: 'output', datasetRevision: 1, status: 'ok' as const,
    objects: [], definitions: { modelDigest: 'model', bindingDigest: 'binding', payloadDigest: 'payload', originalReceiptId: `original-${n}`,
      payload: { definitions: 'INTERNAL_DEFINITION_MARKER'.repeat(5000) } },
  }));
}
async function connect(tasks: ReturnType<typeof backend>['tasks'], identity: Principal = principal) {
  const server = createMcpServer(tasks, identity), client = new Client({ name: 'task-summary-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args }); assert(!response.isError, JSON.stringify(response));
  const value = (response.structuredContent as { result: TaskSummary }).result;
  const text = response.content[0]; assert(text?.type === 'text'); assert.deepEqual(JSON.parse(text.text), JSON.parse(JSON.stringify(value)));
  assert.equal(value.view, 'summary'); assert(!('messages' in value)); assert(!('runs' in value));
  return value;
}

test('public task summary preserves decisions and intact artifacts while growing internal receipts stay internal', () => {
  const f = backend(createExecutionCatalog()); try {
    const job = f.submit(), d = job.delegation!;
    job.state = 'auth-required'; job.question = 'Approve this exact sandbox quote'; job.error = 'retained state detail';
    job.artifact = { id: randomUUID(), name: 'full-result.json', data: { goal: job.goal, deliverable: 'Complete artifact', execution: 'completed', result: { verbatim: 'result'.repeat(10000) } } };
    d.acceptance = { accepted: true, reason: 'Verified fixture result', at: job.updatedAt, checks: [], evidenceRefs: ['result-evidence'] };
    d.authorizationRequest = { planDigest: 'plan-digest', effects: ['payment'], maxAmount: { minor: '1250', currency: 'CNY' }, payeeIds: ['payee'], environment: 'sandbox', realOperationsAllowed: false };
    d.sourceAuthorization = { provider: 'meituan-paotui', nextAction: 'begin_source_connection', resumeAction: 'resume_source_task' };
    d.plan = { id: 'plan', digest: 'plan-digest', expiresAt: job.createdAt, quote: { id: 'quote', digest: 'quote-digest', amount: { minor: '1250', currency: 'CNY' }, expiresAt: job.createdAt, environment: 'local_simulation' } } as ExecutionPlan;
    d.actions = [{ id: 'intent', stepId: 'payment', state: 'effect_confirmed', remoteRef: 'provider-operation', latestObservationId: 'observation' }];
    d.businessFacts = [{ intentId: 'intent', sourceVersion: 1, evidenceRefs: ['result-evidence'], snapshot: { payment: 'paid', facts: { conditions: ['INTERNAL_FACT_DETAILS'] } } }];
    d.authorizationBudget = [{ minor: '1250', currency: 'CNY', state: 'consumed', intentId: 'intent' }];
    d.pendingActionInput = { intentId: 'intent', question: 'Pending fact' };
    const before = taskSummary(job); addInternalReads(job, 40); const summary = taskSummary(job);
    assert.deepEqual(summary, before, 'adding megabytes of internal reads cannot change the business response');
    assert.deepEqual(summary.artifact, job.artifact); assert.deepEqual(summary.artifact!.data.result, { verbatim: 'result'.repeat(10000) });
    assert.equal(summary.state, job.state); assert.equal(summary.revision, job.revision); assert.equal(summary.question, job.question); assert.equal(summary.error, job.error);
    for (const key of ['acceptance', 'authorizationRequest', 'sourceAuthorization', 'actions', 'authorizationBudget', 'pendingActionInput'] as const) assert.deepEqual(summary.delegation![key], d[key]);
    assert.deepEqual(summary.delegation!.plan!.quote, d.plan.quote);
    assert.equal(summary.delegation!.businessFacts![0]!.snapshot.payment, 'paid');
    assert(!JSON.stringify(summary).includes('INTERNAL_'));
    assert(JSON.stringify(job).length > 4_000_000);
    assert(JSON.stringify(summary).length < JSON.stringify(job.artifact).length + 5000, 'only the intact artifact can dominate this business response');
    scheduleTaskRecovery(job, 'worker_timeout', 'Restore runtime, no owner facts required', { automatic: false });
    assert.deepEqual(taskSummary(job).delegation!.recovery, job.delegation!.recovery);
    assert.equal(taskSummary(job).delegation!.executionBudgetStatus!.profile, 'standard');
  } finally { f.store.close(); }
});

test('business summary exposes only the latest accepted owner input and keeps older replies and agent history internal', () => {
  const f = backend(createExecutionCatalog()); try {
    const job = f.submit();
    job.messages.push(
      { id: randomUUID(), role: 'user', text: 'OBSOLETE_OWNER_REPLY', at: job.createdAt },
      { id: randomUUID(), role: 'agent', text: 'OLDER_AGENT_MESSAGE', at: job.createdAt },
    );
    const current = { id: randomUUID(), role: 'user' as const, text: '重量改为500克，其他信息不变。', at: '2026-10-20T10:00:00.000Z' };
    job.messages.push(current, { id: randomUUID(), role: 'agent', text: 'LATER_AGENT_MESSAGE', at: '2026-10-20T10:00:01.000Z' });
    const summary = taskSummary(job);
    assert.deepEqual(summary.latestInput, { id: current.id, text: current.text, receivedAt: current.at });
    assert.equal(summary.counts.messages, 5); assert(!('messages' in summary));
    for (const text of ['OBSOLETE_OWNER_REPLY', 'OLDER_AGENT_MESSAGE', 'LATER_AGENT_MESSAGE']) assert(!JSON.stringify(summary).includes(text));
    job.messages = []; assert.equal(taskSummary(job).latestInput, undefined);
  } finally { f.store.close(); }
});

test('default MCP read/list and A2A read return the same completed artifact without internal receipts; ownership and scopes still gate readback', async () => {
  const f = backend(createExecutionCatalog()), wire = await connect(f.tasks);
  try {
    const submitted = await call(wire.client, 'submit_task', { goal: 'Return the exact fixture artifact', requestId: randomUUID() });
    const job = f.store.get(owner, submitted.id); job.state = 'completed'; job.delegation!.phase = 'accepted';
    job.artifact = { id: randomUUID(), name: 'result.json', data: { goal: job.goal, deliverable: 'Result', execution: 'completed', result: { total: '12.50', unit: 'CNY', nested: ['unaltered', { weightKg: 0.5 }] } } };
    job.delegation!.acceptance = { accepted: true, reason: 'Independent fixture result', at: job.updatedAt, checks: [], evidenceRefs: ['fixture'] };
    addInternalReads(job, 20); f.store.save(owner, job);
    const summary = await call(wire.client, 'get_task', { taskId: job.id });
    assert.deepEqual(summary.artifact, job.artifact); assert.deepEqual(summary.delegation!.acceptance, job.delegation!.acceptance);
    assert(JSON.stringify(summary).length < 10000);
    assert.equal(f.tasks.get(principal, job.id).delegation!.ontologyReads!.length, 20, 'internal task service keeps the original ledger');
    const listed = await wire.client.callTool({ name: 'list_tasks', arguments: {} });
    const page = (listed.structuredContent as { result: { jobs: TaskSummary[]; total: number } }).result;
    assert.equal(page.total, 1); assert.deepEqual(page.jobs[0], summary);
    const a2a = new A2AGateway(f.tasks, AgentCard.fromJSON({})), ctx = new ServerCallContext({ user: new AgentUser(principal) });
    const task = await a2a.getTask(GetTaskRequest.fromJSON({ id: job.id }), ctx);
    const json = Task.toJSON(task) as { artifacts: { artifactId: string; parts: { data: unknown }[] }[]; metadata: { delegation: unknown; view: string; latestInput: unknown } };
    assert.equal(task.status!.state, TaskState.TASK_STATE_COMPLETED); assert.equal(task.history.length, 0);
    assert.equal(json.artifacts[0]!.artifactId, summary.artifact!.id); assert.deepEqual(json.artifacts[0]!.parts[0]!.data, summary.artifact!.data);
    assert.deepEqual(JSON.parse(JSON.stringify(json.metadata.delegation)), JSON.parse(JSON.stringify(summary.delegation))); assert.equal(json.metadata.view, 'summary');
    assert.deepEqual(json.metadata.latestInput, summary.latestInput);
    assert(!JSON.stringify(json).includes('INTERNAL_DEFINITION_MARKER')); assert(JSON.stringify(json).length < 10000);
    const withHistory = await a2a.getTask(GetTaskRequest.fromJSON({ id: job.id, historyLength: 1 }), ctx); assert.equal(withHistory.history.length, 1);
    job.artifact.data.markdown = '完整结果：0.5 公斤，12.50 元。'; f.store.save(owner, job);
    const withMarkdown = Task.toJSON(await a2a.getTask(GetTaskRequest.fromJSON({ id: job.id }), ctx)) as { artifacts: { parts: { text?: string; data?: unknown }[] }[] };
    assert.equal(withMarkdown.artifacts[0]!.parts[0]!.text, job.artifact.data.markdown);
    assert.deepEqual(withMarkdown.artifacts[0]!.parts[1]!.data, job.artifact.data, 'readable Markdown cannot discard the artifact structured result');
    assert.deepEqual((await call(wire.client, 'get_task', { taskId: job.id })).artifact, job.artifact);
    for (const identity of [{ ...principal, subject: 'other' }, { ...principal, scopes: ['tasks:write'] }]) {
      const denied = await connect(f.tasks, identity); try {
        const response = await denied.client.callTool({ name: 'get_task', arguments: { taskId: job.id } });
        assert.equal(response.isError, true); assert(!JSON.stringify(response).includes('Return the exact fixture artifact'));
        await assert.rejects(a2a.getTask(GetTaskRequest.fromJSON({ id: job.id }), new ServerCallContext({ user: new AgentUser(identity) })));
      } finally { await denied.close(); }
    }
    const escape = await wire.client.callTool({ name: 'get_task', arguments: { taskId: job.id, view: 'full' } }); assert.equal(escape.isError, true);
  } finally { await wire.close(); f.store.close(); }
});

test('MCP continuation responses use the same compact boundary without adding read authority to writes', async () => {
  const f = backend(createExecutionCatalog()), wire = await connect(f.tasks, { ...principal, scopes: ['tasks:write'] });
  try {
    let summary = await call(wire.client, 'submit_task', { goal: 'Need a brief', requestId: randomUUID() });
    const job = f.store.get(owner, summary.id); addInternalReads(job, 3); job.state = 'input-required'; job.question = 'Which format?'; f.store.save(owner, job);
    summary = await call(wire.client, 'reply_to_task', { taskId: job.id, requestId: randomUUID(), expectedRevision: job.revision, answer: 'A table' });
    summary = await call(wire.client, 'amend_task', { taskId: job.id, requestId: randomUUID(), expectedRevision: summary.revision, answer: 'Use a concise table' });
    const paused = f.store.get(owner, job.id); scheduleTaskRecovery(paused, 'worker_timeout', 'Temporary fixture pause', { automatic: false }); f.store.save(owner, paused);
    summary = await call(wire.client, 'resume_task', { taskId: job.id, requestId: randomUUID(), expectedRevision: paused.revision });
    assert.equal(summary.delegation!.recovery!.state, 'scheduled'); assert.equal(summary.delegation!.recovery!.ownerInputRequired, false);
    summary = await call(wire.client, 'cancel_task', { taskId: job.id }); assert.equal(summary.state, 'canceled');
    assert(!JSON.stringify(summary).includes('INTERNAL_DEFINITION_MARKER'));
    assert.equal(f.store.get(owner, job.id).delegation!.ontologyReads!.length, 3);
  } finally { await wire.close(); f.store.close(); }
});
