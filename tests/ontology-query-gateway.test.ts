// Actual authenticated HTTP/MCP/A2A transports; only synthetic data, no Worker or live source.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { ownerKey, SCOPES, type Principal } from '../packages/core/domain.js';
import { syntheticOntology } from './fixtures/ontology-objects.js';

test('N1 queries share PA authentication, owner and scope boundaries without exposing any write operation', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const principal = (subject: string, scopes = [...SCOPES], tenant = 'local'): Principal => ({ issuer: 'local-development', tenant, subject, clientId: 'n1-fixture', scopes });
  const people: Record<string, Principal> = { alice: principal('alice'), bob: principal('bob'), tenant: principal('alice', [...SCOPES], 'other'), catalog: principal('alice', ['services:read']), data: principal('alice', ['tasks:read']) };
  const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'synthetic-token-for-query-tests-only', DATABASE_PATH: ':memory:', PUBLIC_URL: base }), async token => {
    const p = people[token]; if (!p) throw new Error('Invalid test credential'); return p;
  });
  server.on('request', gateway.app);
  const fixture = syntheticOntology(); gateway.store.ontology.ingest(ownerKey(people.alice!), fixture.batch, fixture.source);
  const client = new Client({ name: 'n1-fixture-pa', version: '1' });
  const post = async (path: string, body: object, token?: string) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.equal((await post('/ontology/query', { type: 'Offer' })).status, 401);
    assert.equal((await post('/ontology/query', { type: 'Offer' }, 'catalog')).status, 403);
    assert.equal((await post('/ontology/describe', {}, 'data')).status, 403);
    const defs = await post('/ontology/describe', { search: '报价', limit: 2 }, 'alice'); assert.equal(defs.status, 200); assert(defs.value.types.length <= 2);
    const offers = await post('/ontology/query', { type: 'Offer', select: ['offerId', 'isFresh'] }, 'alice');
    assert.equal(offers.status, 200); assert.equal(offers.value.items.length, 3); assert(offers.value.items.every((o: { source: { kind: string } }) => o.source.kind === 'synthetic'));
    for (const actor of ['bob', 'tenant']) {
      assert.deepEqual((await post('/ontology/query', { type: 'Offer' }, actor)).value.items, []);
      assert.equal((await post('/ontology/query', { from: fixture.ids.D, link: 'offers' }, actor)).status, 404);
      assert.equal((await post('/ontology/evaluate', { function: 'remainingQuantity', object: fixture.ids.line }, actor)).status, 404);
    }
    const addresses = await post('/ontology/query', { type: 'SavedAddress' }, 'alice'); assert(!JSON.stringify(addresses).includes('PRIVATE_'));
    assert.equal((await post('/ontology/query', { type: 'SavedAddress', where: [{ property: 'contactInstructions', op: 'eq', value: 'PRIVATE_CONTACT_MARKER' }] }, 'alice')).status, 403);
    assert.equal((await post('/ontology/query', { type: 'Offer', owner: ownerKey(people.alice!) }, 'bob')).status, 400);
    assert.equal((await post('/ontology/query', { type: 'Offer', limit: 9999 }, 'alice')).status, 400);
    assert.equal((await post('/ontology/evaluate', { function: 'PayDeposit', object: fixture.ids.payment }, 'alice')).status, 400);
    const before = gateway.store.ontology.revision(ownerKey(people.alice!));
    assert.equal((await post('/ontology/query', { objects: fixture.batch.objects }, 'alice')).status, 400);
    assert.equal(gateway.store.ontology.revision(ownerKey(people.alice!)), before);
    const value = await post('/ontology/evaluate', { function: 'remainingQuantity', object: fixture.ids.line }, 'alice');
    assert.deepEqual(value.value.value, { amount: '2', unit: 'cup' }); assert.deepEqual(value.value.evidenceLevels, ['synthetic']);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer alice' } } }));
    const response = await client.callTool({ name: 'query_ontology', arguments: { type: 'Offer', select: ['offerId', 'priceKind'] } }); assert(!response.isError);
    const data = response.structuredContent as { result: { items: { ref: { type: string } }[] } };
    assert.deepEqual(data.result.items.map(i => i.ref.type), ['DeliveryQuote', 'ProductOffer', 'ReservationOffer']);
    const rpc = await post('/a2a', { jsonrpc: '2.0', id: 'n1', method: 'SendMessage', params: { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: '只准备一个说明，验证原 PA 入口' }] } } }, 'alice');
    assert.equal(rpc.status, 200); const task = rpc.value.result.task;
    const viaMcp = await client.callTool({ name: 'get_task', arguments: { taskId: task.id } }); assert(!viaMcp.isError);
    const projected = await post('/ontology/query', { type: 'ServiceRequest', where: [{ property: 'requestId', op: 'eq', value: task.id }] }, 'alice');
    assert.equal(projected.value.items.length, 1); assert.equal(projected.value.items[0].properties.projectionState, 'request_only');
    assert.equal(projected.value.items[0].properties.originalGoal, '只准备一个说明，验证原 PA 入口');
    const card = await fetch(base + '/.well-known/agent-card.json').then(r => r.json());
    assert.deepEqual(card.skills.map((s: { id: string }) => s.id), ['eigos.delegate']);
    assert.equal((await fetch(base + '/health').then(r => r.json())).backend, 'ontology-execution-v20');
  } finally { await client.close(); await gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
