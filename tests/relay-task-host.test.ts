import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TaskRelayHost } from '../packages/agent-transport/task-host.js';
import { TASK_RELAY_PROTOCOL, taskRelayResponseSchema } from '../packages/agent-transport/task-contracts.js';
import { TaskService } from '../packages/core/tasks.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { SecurityError } from '../packages/security/store.js';
import { securityFixture } from './fixtures/security.js';
import { relayFixture } from './fixtures/relay.js';

function setup() {
  const f = securityFixture(Date.now, { primary: true }), tasks = new TaskService(f.jobs, { catalog: new ExecutionCatalog([], [], []) });
  const install = (name: string) => {
    const a = f.installation(name); f.approve(a.id);
    const policy = f.jobs.security.policies, expiresAt = new Date(Date.now() + 3600000).toISOString();
    policy.setRole({ subjectKind: 'installation', subjectId: a.id, resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest }, role: 'Viewer', expiresAt }, policy.revision());
    policy.setRecipient(a.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'], channels: ['agent_response', 'registered_model'], expiresAt }, policy.revision());
    return { ...a, principal: { ...f.principal, access: f.coordinator.authenticate(f.principal, a.token) } };
  };
  const bind = (a: ReturnType<typeof install>, agentId: string) => f.jobs.security.relay.bind(a.principal, agentId, Date.now() + 60000, { jti: randomUUID(), expiresAt: Date.now() + 30000 });
  return { ...f, tasks, install, bind };
}

test('an interrupted encrypted submit resumes the same primary task without another grant or private ledger disclosure', async () => {
  const f = setup(), transport = await relayFixture(); let loseSend = true;
  try {
    const pa = await transport.client('PA'), a = f.install('A'); f.bind(a, pa.agentId);
    let gateway = await transport.client('EIGOS', async (url, init) => {
      const response = await fetch(url, init);
      if (loseSend && String(url).endsWith('/v1/messages') && init?.method === 'POST') { loseSend = false; throw new Error('Synthetic lost send response'); }
      return response;
    });
    const connectionId = await transport.connect(pa, gateway), requestId = randomUUID();
    const request = { protocol: TASK_RELAY_PROTOCOL, kind: 'task.submit', authorityId: f.authority!.id, requestId, input: { service: 'eigos.delegate', requestId, goal: 'Private synthetic task' } };
    await pa.send(gateway.agentId, connectionId, request);
    let host = new TaskRelayHost(f.jobs, f.tasks, gateway, f.authority!.id);
    const message = (await gateway.poll())[0]!;
    await assert.rejects(host.handle(message, AbortSignal.timeout(10000)), /lost send response/);
    const first = taskRelayResponseSchema.parse((await pa.poll())[0]!.content); assert(first.task);
    gateway.close(); gateway = await transport.client('EIGOS'); host = new TaskRelayHost(f.jobs, f.tasks, gateway, f.authority!.id);
    assert.equal((await gateway.pending()).length, 1);
    await host.handle((await gateway.pending())[0]!, AbortSignal.timeout(10000));
    gateway.markHandled(message.senderId, message.id);
    const responses = (await pa.poll()).map(m => taskRelayResponseSchema.parse(m.content));
    assert(responses.every(r => r.task?.id === first.task!.id));
    assert.equal(f.jobs.list(f.owner, { limit: 100, offset: 0 }).total, 1);
    assert.equal(f.jobs.security.listGrants(f.owner).filter(g => g.kind === 'task_data').length, 1);
    assert.equal(first.task.authorityId, f.authority!.id);
    assert(!JSON.stringify(responses).includes('delegation')); assert(!JSON.stringify(responses).includes('claimToken'));
  } finally { await f.tasks.close(); await transport.close(); f.close(); }
});

test('Relay reads retain installation isolation and deny a previously queued request after revocation', async () => {
  const f = setup(), transport = await relayFixture();
  try {
    const pa = await transport.client('PA'), second = await transport.client('OtherPA'), gateway = await transport.client('EIGOS');
    const a = f.install('A'), b = f.install('B'); f.bind(a, pa.agentId); f.bind(b, second.agentId);
    const connectionA = await transport.connect(pa, gateway), connectionB = await transport.connect(second, gateway);
    const task = f.tasks.submit(a.principal, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Private A only' });
    const host = new TaskRelayHost(f.jobs, f.tasks, gateway, f.authority!.id);
    for (const [client, connection] of [[second, connectionB], [pa, connectionA]] as const) {
      const requestId = randomUUID();
      await client.send(gateway.agentId, connection, { protocol: TASK_RELAY_PROTOCOL, kind: 'task.get', authorityId: f.authority!.id, requestId, taskId: task.id });
      if (client === pa) f.jobs.security.relay.revoke(a.principal, pa.agentId);
      const message = (await gateway.poll())[0]!;
      await host.handle(message, AbortSignal.timeout(10000)); gateway.markHandled(message.senderId, message.id);
      const response = taskRelayResponseSchema.parse((await client.poll())[0]!.content);
      assert.equal(response.error, 'AUTHORIZATION_REQUIRED'); assert.equal(response.task, undefined);
      assert(!JSON.stringify(response).includes('Private A only'));
    }
  } finally { await f.tasks.close(); await transport.close(); f.close(); }
});

test('revocation during response encryption stops the last send boundary', async () => {
  const f = setup(), transport = await relayFixture(); let revoke: (() => void) | undefined;
  try {
    const pa = await transport.client('PA'), a = f.install('A'); f.bind(a, pa.agentId);
    const gateway = await transport.client('EIGOS', async (url, init) => {
      const response = await fetch(url, init);
      if (revoke && String(url).includes('/v1/agents/') && (!init?.method || init.method === 'GET')) { const action = revoke; revoke = undefined; action(); }
      return response;
    });
    const connectionId = await transport.connect(pa, gateway), task = f.tasks.submit(a.principal, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Private result' });
    await pa.send(gateway.agentId, connectionId, { protocol: TASK_RELAY_PROTOCOL, kind: 'task.get', authorityId: f.authority!.id, requestId: randomUUID(), taskId: task.id });
    const message = (await gateway.poll())[0]!, host = new TaskRelayHost(f.jobs, f.tasks, gateway, f.authority!.id);
    revoke = () => f.jobs.security.relay.revoke(a.principal, pa.agentId);
    await assert.rejects(host.handle(message, AbortSignal.timeout(10000)), SecurityError);
    assert.equal((await pa.poll()).length, 0);
  } finally { await f.tasks.close(); await transport.close(); f.close(); }
});

test('a separately authorized member cannot read another member task through a valid Relay contact', async () => {
  const f = setup(), transport = await relayFixture();
  try {
    const a = f.install('A'), task = f.tasks.submit(a.principal, { service: 'eigos.delegate', requestId: randomUUID(), goal: 'Private Alice goal' });
    const principal = { ...f.principal, subject: 'separate-member-bob' }, member = f.members.login(principal);
    f.members.apply(member.id, { displayName: 'Synthetic Bob', locale: 'en', timezone: 'UTC', consent: true }, false);
    const id = randomUUID(), token = 'bob-' + randomUUID(), credential = 'b'.repeat(43);
    f.members.agents.create({ registrationId: id, displayName: 'Bob PA' }, credential);
    f.members.agents.bind(id, credential, principal, member.id, token, Date.now() + 600000, Date.now(), true);
    f.members.authorize(principal);
    f.coordinator.approveAgentGrant(member.id, { installationId: id, capabilityIds: ['brief.prepare'], resources: [{ type: 'ServiceRequest', fields: ['requestId', 'originalGoal'] }], sourceBindingIds: [], channels: ['agent_response'], expiresAt: new Date(Date.now() + 600000).toISOString() });
    const bob = { ...principal, access: f.coordinator.authenticate(principal, token) }, node = await transport.client('Bob'), gateway = await transport.client('EIGOS');
    f.jobs.security.relay.bind(bob, node.agentId, Date.now() + 60000, { jti: randomUUID(), expiresAt: Date.now() + 30000 });
    const connectionId = await transport.connect(node, gateway);
    await node.send(gateway.agentId, connectionId, { protocol: TASK_RELAY_PROTOCOL, kind: 'task.get', authorityId: f.authority!.id, requestId: randomUUID(), taskId: task.id });
    await new TaskRelayHost(f.jobs, f.tasks, gateway, f.authority!.id).handle((await gateway.poll())[0]!, AbortSignal.timeout(10000));
    const response = taskRelayResponseSchema.parse((await node.poll())[0]!.content);
    assert.equal(response.error, 'AUTHORIZATION_REQUIRED'); assert.equal(response.task, undefined); assert(!JSON.stringify(response).includes('Private Alice goal'));
  } finally { await f.tasks.close(); await transport.close(); f.close(); }
});
