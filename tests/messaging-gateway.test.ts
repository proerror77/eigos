import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ClientFactory } from '@a2a-js/sdk/client';
import { SendMessageRequest } from '@a2a-js/sdk';
import { z } from 'zod';
import { messagingGatewayFixture } from './fixtures/messaging-gateway.js';
import { AgentConnector } from '../packages/agent-client/client.js';
import { COMMUNICATION_SCHEMA, MESSAGING_SCOPES } from '../packages/agent-messaging/contracts.js';
import { TASK_SCOPES } from '../packages/core/domain.js';

const record = z.record(z.string(), z.unknown());
function toolValue(value: unknown) { return z.object({ structuredContent: z.object({ result: record }) }).parse(value).structuredContent.result; }

test('the same primary MCP/A2A entry points exchange PA messages via Relay without a business grant or task', { timeout: 60000 }, async t => {
  const f = await messagingGatewayFixture(); let mcp: Client | undefined;
  try {
    const a = await f.actor('Alice'), b = await f.actor('Bob');
    const ga = await f.approve(a), gb = await f.approve(b);
    let submits = 0;
    const submit = f.gateway.tasks.submit.bind(f.gateway.tasks);
    t.mock.method(f.gateway.tasks, 'submit', (...args: Parameters<typeof submit>) => { submits++; return submit(...args); });
    const agent = await AgentConnector.open({ baseUrl: f.base, credentialPath: a.credentialPath, displayName: 'Alice PA' });
    const admission = await agent.status(); assert.equal(admission.status, 'data_authorization_required'); assert.equal(admission.messaging?.state, 'ready');
    await assert.rejects(agent.accessToken(), /data_authorization_required/);
    assert.equal(await agent.accessToken({ purpose: 'messaging' }), a.token);
    assert.equal(z.array(record).parse(record.parse(await agent.communicate({ action: 'find', limit: 20 })).items).length, 2);
    const errors: Error[] = [];
    mcp = new Client({ name: 'PA Alice', version: '1' }); mcp.onerror = error => errors.push(error);
    await mcp.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { fetch: f.fetcher, requestInit: { headers: { Authorization: `Bearer ${a.token}` } } }));
    const names = (await mcp.listTools()).tools.map(tool => tool.name);
    assert(names.includes('send_agent_message')); assert(!names.includes('submit_task'));
    const found = toolValue(await mcp.callTool({ name: 'find_agents', arguments: {} }));
    assert.equal(z.array(record).parse(found.items).length, 2);
    const contact = toolValue(await mcp.callTool({ name: 'request_agent_contact', arguments: { endpointId: gb.id, requestId: randomUUID() } }));
    assert.equal(contact.state, 'pending');
    const a2a = await new ClientFactory().createFromUrl(f.base);
    const communicate = async (operation: object, token = b.token) => {
      const requestId = 'requestId' in operation ? String(operation.requestId) : randomUUID();
      const response = await a2a.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: requestId, role: 'ROLE_USER', parts: [{ data: { schema: COMMUNICATION_SCHEMA, operation } }] } }),
        { serviceParameters: { Authorization: `Bearer ${token}` } });
      assert('messageId' in response); assert(!('id' in response));
      const part = response.parts[0]; assert(part?.content?.$case === 'data');
      const body = z.object({ result: record }).parse(part.content.value); return body.result;
    };
    const waiting = await communicate({ action: 'list', limit: 20 }); assert.equal(z.array(record).parse(waiting.contacts)[0]?.contactId, contact.contactId);
    await communicate({ action: 'contact.respond', contactId: contact.contactId, decision: 'accept', requestId: randomUUID() });
    const op = { endpointId: gb.id, text: 'http-relay-private-canary', requestId: randomUUID() };
    const sent = toolValue(await mcp.callTool({ name: 'send_agent_message', arguments: op }));
    const repeated = await communicate({ action: 'send', ...op }, a.token); assert.equal(repeated.messageId, sent.messageId);
    await communicate({ action: 'list', limit: 20 });
    const read = await communicate({ action: 'read', messageId: sent.messageId }); assert.equal(read.text, op.text);
    assert.equal(read.state, 'delivered_to_endpoint');
    const reply = await communicate({ action: 'reply', messageId: sent.messageId, text: 'reply from PA Bob', requestId: randomUUID() });
    assert.equal(reply.inReplyTo, sent.messageId); assert.equal(reply.conversationId, sent.conversationId);
    await mcp.callTool({ name: 'list_agent_messages', arguments: {} });
    assert.equal(toolValue(await mcp.callTool({ name: 'read_agent_message', arguments: { messageId: reply.messageId } })).text, 'reply from PA Bob');
    assert.equal(f.gateway.store.list(a.owner, { limit: 20, offset: 0 }).total, 0);
    assert.equal(f.gateway.store.list(b.owner, { limit: 20, offset: 0 }).total, 0); assert.equal(submits, 0);
    const denied = await f.post('/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'submit_task', arguments: { requestId: randomUUID(), goal: 'service' } } }, { Authorization: `Bearer ${a.token}` });
    assert.equal(denied.status, 403); assert.equal(submits, 0);
    const bytes = Buffer.concat(readdirSync(f.directory).filter(name => name.startsWith('relay.sqlite')).map(name => readFileSync(join(f.directory, name))));
    assert(!bytes.includes(Buffer.from(op.text))); assert(!bytes.includes(Buffer.from(a.token)));
    const get = await f.fetcher(f.base + '/mcp', { headers: { Authorization: `Bearer ${a.token}`, Accept: 'text/event-stream' } }); assert.equal(get.status, 405);
    const emptyJsonGet = await f.fetcher(f.base + '/mcp', { headers: { Authorization: `Bearer ${a.token}`, Accept: 'text/event-stream', 'Content-Type': 'application/json', 'Content-Length': '0' } }); assert.equal(emptyJsonGet.status, 405);
    assert.equal(errors.length, 0, errors.map(e => e.message).join('; '));
    const c = await f.actor('Service user', [...TASK_SCOPES, ...MESSAGING_SCOPES]);
    await f.approve(c);
    f.gateway.security!.approveAgentGrant(c.member.id, { installationId: c.id, capabilityIds: ['brief.prepare'], resources: [{ type: 'ServiceRequest', fields: ['requestId', 'originalGoal'] }], sourceBindingIds: [], channels: ['agent_response'], expiresAt: new Date(Date.now() + 3600000).toISOString() });
    const policy = f.gateway.store.security.policies, until = new Date(Date.now() + 3600000).toISOString();
    policy.setRole({ subjectKind: 'installation', subjectId: c.id, resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest }, role: 'Viewer', expiresAt: until }, policy.revision());
    policy.setRecipient(c.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'], channels: ['agent_response'], expiresAt: until }, policy.revision());
    const business = await a2a.sendMessage(SendMessageRequest.fromJSON({ configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Prepare a synthetic task brief only' }] } }), { serviceParameters: { Authorization: `Bearer ${c.token}` } });
    assert('id' in business); assert.equal(submits, 1); assert.equal(f.gateway.store.list(c.owner, { limit: 20, offset: 0 }).total, 1);
    assert.equal(ga.custody, 'eigos-service');
  } finally { await mcp?.close(); await f.close(); }
});

test('communication envelopes, controller consent and persistent revocation fences cannot bypass business or restore old grants', { timeout: 60000 }, async () => {
  const f = await messagingGatewayFixture();
  try {
    const a = await f.actor('Alice'), b = await f.actor('Bob');
    const raw = async (operation: object, token = a.token) => f.post('/communication', { schema: COMMUNICATION_SCHEMA, operation }, { Authorization: `Bearer ${token}` });
    assert.equal((await raw({ action: 'find' })).status, 403);
    const invalidConsent = await f.post('/members/communications/review', { _csrf: a.session.csrf, installationId: a.id }, { Authorization: `Bearer ${a.token}`, origin: f.base });
    assert.equal(invalidConsent.status, 403);
    const ga = await f.approve(a), gb = await f.approve(b);
    const c = await f.actor('Carol'), gc = await f.approve(c);
    const requestId = randomUUID();
    const contactResponse = await raw({ action: 'contact.request', endpointId: gb.id, requestId });
    assert.equal(contactResponse.status, 200); const contact = record.parse(await contactResponse.json());
    assert.equal((await raw({ action: 'contact.request', endpointId: gc.id, requestId })).status, 409);
    await raw({ action: 'contact.respond', contactId: contact.contactId, decision: 'accept', requestId: randomUUID() }, b.token);
    const malformed = [
      { schema: COMMUNICATION_SCHEMA, operation: { action: 'send', endpointId: gb.id, sender: b.id, text: 'forged', requestId: randomUUID() } },
      { schema: 'eigos.agent-communication/2', operation: { action: 'find' } },
    ];
    for (const data of malformed) {
      const response = await f.post('/a2a/', { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data }] } } }, { Authorization: `Bearer ${a.token}` });
      const value = await response.json(); assert(value.error);
    }
    const mixed = await f.post('/a2a', { jsonrpc: '2.0', id: 2, method: 'SendMessage', params: { message: { messageId: randomUUID(), role: 'ROLE_USER', taskId: randomUUID(), parts: [{ data: { schema: COMMUNICATION_SCHEMA, operation: { action: 'find' } } }] } } }, { Authorization: `Bearer ${a.token}` });
    assert((await mixed.json()).error);
    const batch = await f.post('/mcp', [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_agents', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'submit_task', arguments: { requestId: randomUUID(), goal: 'do not create this task' } } }], { Authorization: `Bearer ${a.token}` });
    assert.equal(batch.status, 403);
    const foreignTenant = await f.post('/a2a', { jsonrpc: '2.0', id: 3, method: 'SendMessage', params: { tenant: 'other', message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { schema: COMMUNICATION_SCHEMA, operation: { action: 'find' } } }] } } }, { Authorization: `Bearer ${a.token}` });
    assert((await foreignTenant.json()).error);
    const missingScope = await f.actor('Task-only', [...TASK_SCOPES]); await f.approve(missingScope);
    const noScope = await raw({ action: 'find' }, missingScope.token); assert.equal(noScope.status, 403); assert(noScope.headers.get('www-authenticate')?.includes('messaging:read'));
    const taskDiscovery = await f.post('/mcp', { jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }, { Authorization: `Bearer ${missingScope.token}` });
    assert.equal(taskDiscovery.status, 403); assert.equal((await taskDiscovery.json()).permissions_url, f.base + '/members/permissions');
    assert.equal(f.gateway.store.list(a.owner, { limit: 20, offset: 0 }).total, 0);
    const fence = f.gateway.store.security.deny({ ownerKey: a.owner, kind: 'installation', targetId: a.id });
    assert.equal((await raw({ action: 'find' })).status, 403);
    f.gateway.store.security.settleFence(fence, 'cleared');
    assert.equal((await raw({ action: 'find' })).status, 403, 'restoring eligibility must not restore old communication consent');
    const revoked = await f.post('/members/communications/revoke', { _csrf: a.session.csrf, id: ga.id, revision: ga.revision }, { cookie: a.cookie, origin: f.base }); assert.equal(revoked.status, 303);
    const fresh = await f.approve(a); assert.notEqual(fresh.id, ga.id);
    assert.equal((await raw({ action: 'find' })).status, 200);
    assert.equal(f.gateway.store.list(a.owner, { limit: 20, offset: 0 }).total, 0);
  } finally { await f.close(); }
});

test('a native MCP installation can discover communications and obtain separate controller consent without task access', { timeout: 60000 }, async () => {
  const f = await messagingGatewayFixture({ native: true }); let client: Client | undefined;
  try {
    const a = await f.actor('Native Alice', [...MESSAGING_SCOPES], true);
    client = new Client({ name: 'native phone PA', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { fetch: f.fetcher, requestInit: { headers: { Authorization: `Bearer ${a.token}` } } }));
    assert((await client.listTools()).tools.some(tool => tool.name === 'send_agent_message'));
    const missing = await client.callTool({ name: 'find_agents', arguments: {} }); assert.equal(missing.isError, true);
    await f.approve(a);
    const found = toolValue(await client.callTool({ name: 'find_agents', arguments: {} })); assert.equal(z.array(record).parse(found.items).length, 1);
    assert.equal(f.gateway.store.list(a.owner, { limit: 20, offset: 0 }).total, 0);
    const fence = f.gateway.store.security.deny({ ownerKey: a.owner, kind: 'connection', targetId: a.p.clientId });
    const denied = await f.post('/communication', { schema: COMMUNICATION_SCHEMA, operation: { action: 'find' } }, { Authorization: `Bearer ${a.token}` }); assert.equal(denied.status, 403);
    f.gateway.store.security.settleFence(fence, 'cleared');
    const stillDenied = await client.callTool({ name: 'find_agents', arguments: {} }); assert.equal(stillDenied.isError, true);
  } finally { await client?.close(); await f.close(); }
});

test('the Gateway restarts with the same PA inbox ciphertext and original conversation', { timeout: 60000 }, async () => {
  const f = await messagingGatewayFixture();
  try {
    const a = await f.actor('Alice'), b = await f.actor('Bob'); const ga = await f.approve(a), gb = await f.approve(b);
    const call = async (token: string, operation: object) => {
      const response = await f.post('/communication', { schema: COMMUNICATION_SCHEMA, operation }, { Authorization: `Bearer ${token}` });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return record.parse(body);
    };
    const contact = await call(a.token, { action: 'contact.request', endpointId: gb.id, requestId: randomUUID() });
    await call(b.token, { action: 'contact.respond', contactId: contact.contactId, decision: 'accept', requestId: randomUUID() });
    const sent = await call(a.token, { action: 'send', endpointId: gb.id, text: 'survives primary restart', requestId: randomUUID() });
    await f.restart();
    await call(b.token, { action: 'list', limit: 20 });
    await f.restart();
    const message = await call(b.token, { action: 'read', messageId: sent.messageId }); assert.equal(message.text, 'survives primary restart');
    const reply = await call(b.token, { action: 'reply', messageId: sent.messageId, text: 'same conversation', requestId: randomUUID() });
    assert.equal(reply.conversationId, sent.conversationId);
    assert.equal(f.gateway.messaging!.store.installation(a.id)?.id, ga.id);
    assert.equal(f.gateway.store.list(a.owner, { limit: 20, offset: 0 }).total, 0);
  } finally { await f.close(); }
});
