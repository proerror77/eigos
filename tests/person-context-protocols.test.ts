import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { securityGatewayFixture } from './fixtures/security-gateway.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { Coordinator, type Reasoner } from '../packages/coordinator/coordinator.js';
import { Worker } from '../apps/worker/worker.js';
import { taskContextFields } from '../packages/security/task-context-contract.js';
import { selfPersonRef, personalActionIds } from '../packages/ontology/personal-context.js';
import { ownerKey } from '../packages/core/domain.js';

const noModel: Reasoner = { ground: async () => { throw new Error('Only explicit caller actions run'); }, plan: async () => { throw new Error('No model'); }, act: async () => { throw new Error('No model'); } };
test('public MCP personal actions and A2A task inputs share Foundation authority and the same Person', { timeout: 90000 }, async () => {
  const f = await securityGatewayFixture(store => createExecutionCatalog({ store })), installation = f.install(), client = new Client({ name: 'person-context', version: '1' });
  const store = f.gateway.store, policy = store.security.policies, owner = ownerKey(f.p), until = new Date(Date.now() + 3600000).toISOString();
  let worker: Worker | undefined;
  try {
    const profile = f.gateway.security!.sourceProfiles(f.member.id).profiles.find(profile => profile.programId.startsWith('ontology.managed.'))!; assert(profile);
    const resources = [...new Set(['ServiceRequest', ...profile.outputTypes, ...Object.keys(taskContextFields)])].map(type => ({ type, fields: Object.keys(policy.fields(type)).filter(field => policy.fieldPolicy(type, field) !== 'internal_only') }));
    f.gateway.security!.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: [profile.programId], resources, sourceBindingIds: [profile.bindingId], channels: ['agent_response','registered_model'], expiresAt: until });
    f.qualify(installation.id);
    policy.setRole({ subjectKind: 'installation', subjectId: installation.id, resource: { kind: 'namespace', id: store.ontology.model.ref.id, version: store.ontology.model.ref.digest }, role: 'Viewer', executeActions: [...personalActionIds], expiresAt: until }, policy.revision());
    policy.setSource(owner, { installationId: installation.id, bindingId: profile.bindingId, programId: profile.programId, programDigest: profile.programDigest, operations: [...personalActionIds], outputTypes: profile.outputTypes, expiresAt: until }, policy.revision());
    const headers = { authorization: `Bearer ${installation.token}` };
    await client.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { requestInit: { headers } }));
    const prepared = await client.callTool({ name: 'prepare_ontology_action', arguments: { action: 'BindSelfPerson', requestId: randomUUID(), input: { self: true, displayTitle: 'Protocol self' } } });
    assert(!prepared.isError, JSON.stringify(prepared));
    const data = (prepared.structuredContent as { result: { task: { id: string }; preview: { planDigest: string; scope: object } } }).result;
    const rejected = await f.post('/ontology/v1/actions/approve', { taskId: data.task.id, requestId: randomUUID(), planDigest: '0'.repeat(64), objectWrite: data.preview.scope, expiresAt: until }, headers);
    assert.equal(rejected.status, 403);
    const approved = await f.post('/ontology/v1/actions/approve', { taskId: data.task.id, requestId: randomUUID(), planDigest: data.preview.planDigest, objectWrite: data.preview.scope, expiresAt: until }, headers);
    assert.equal(approved.status, 200, JSON.stringify(approved));
    worker = new Worker(store, { coordinator: new Coordinator(store, noModel, f.gateway.catalog), pollMs: 10, leaseMs: 30000 }); worker.start();
    const deadline = Date.now() + 30000;
    while (['submitted','working'].includes(store.get(owner, data.task.id).state) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(store.get(owner, data.task.id).state, 'completed'); await worker.close(); worker = undefined;
    const result = await client.callTool({ name: 'get_task', arguments: { taskId: data.task.id } }); assert(!result.isError);
    assert(JSON.stringify(result).includes('self_asserted'));
    const delegated = await f.post('/a2a', { jsonrpc: '2.0', id: randomUUID(), method: 'SendMessage', params: { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', goal: '为本人准备东京旅行的上下文', personalContext: { self: true } } }] } } }, headers);
    assert.equal(delegated.status, 200); assert(!delegated.value.error, JSON.stringify(delegated));
    const id = delegated.value.result.task.id;
    const read = await client.callTool({ name: 'query_ontology', arguments: { version: 2, taskId: id, query: { object: selfPersonRef(owner), select: ['identityBasis'] } } });
    assert(!read.isError, JSON.stringify(read)); assert(JSON.stringify(read).includes('self_asserted'));
    f.gateway.security!.revokeInstallation(f.member.id, installation.id);
    assert.notEqual((await f.post('/ontology/query', { version: 2, taskId: id, query: { object: selfPersonRef(owner) } }, headers)).status, 200);
  } finally { await worker?.close(); await client.close(); await f.close(); }
});
