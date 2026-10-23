// Protocol/negative cases use explicit fixtures; live PA + source evidence is separate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import { createPaotuiOntologyServer, ontologyReceiptSchema } from './fixtures/legacy-paotui/paotui-mcp-server.js';
import { PAOTUI_READ_CAPABILITIES, PAOTUI_READ_BINDINGS, PaotuiReadAdapter } from './fixtures/legacy-paotui/paotui-read.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { backend, interpretation, reasoner } from './backend-fixture.js';

const query = { senderAddressId: 'owned-a', recipientAddressId: 'owned-b', goodsName: '文件', category: '文件', weightKg: 1, service: 'ordinary' };
const quote = () => ({ source: 'meituan', previewOnly: true, orderCreated: false, goods: { name: query.goodsName, category: query.category, weightKg: query.weightKg }, service: query.service, quote: { _previewTotal: '52.50' }, route: { sender: 'PRIVATE_SENDER', recipient: 'PRIVATE_RECIPIENT' } });

test('Ontology MCP exposes only pinned read tools and links actual read receipts to input/result', async () => {
  const calls: string[] = [];
  const server = createPaotuiOntologyServer({ query: async input => { calls.push(input.action); return quote(); } }, { evidenceKind: 'fixture' });
  const client = new Client({ name: 'fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  try {
    const tools = await client.listTools(); assert.equal(tools.tools.length, 4); assert(tools.tools.every(t => t.annotations?.readOnlyHint === true));
    const described = await client.callTool({ name: 'ontology_definition', arguments: { id: 'delivery.quote' } });
    assert.deepEqual(z.object({ capability: z.unknown() }).parse(described.structuredContent).capability, PAOTUI_READ_CAPABILITIES[1]);
    const response = await client.callTool({ name: 'ontology_delivery_quote', arguments: query });
    assert(!response.isError);
    const body = z.object({ result: z.unknown(), receipt: ontologyReceiptSchema }).parse(response.structuredContent);
    assert.equal(body.receipt.evidenceKind, 'fixture'); assert.equal(body.receipt.inputDigest, digest(query)); assert.equal(body.receipt.resultDigest, digest(quote()));
    assert(!JSON.stringify(body.receipt).includes('PRIVATE_'));
    for (const params of [ { name: 'submit_order', arguments: {} }, { name: 'ontology_delivery_quote', arguments: { ...query, confirmation: '下单' } }, { name: 'ontology_delivery_quote', arguments: { ...query, weightKg: -1 } } ]) {
      await client.callTool(params).then(r => assert.equal(r.isError, true), () => {});
    }
    assert.deepEqual(calls, ['preview']);
  } finally { await client.close(); await server.close(); }
});

test('an invalid source receipt fails closed without leaking provider errors', async () => {
  const server = createPaotuiOntologyServer({ query: async () => { throw new Error('SECRET_PROVIDER_TOKEN'); } }, { evidenceKind: 'fixture' });
  const client = new Client({ name: 'fixture', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  try {
    const response = await client.callTool({ name: 'ontology_delivery_quote', arguments: query });
    assert.equal(response.isError, true); assert(!JSON.stringify(response).includes('SECRET_PROVIDER_TOKEN'));
  } finally { await client.close(); await server.close(); }
});

test('distinct MCP read receipt IDs do not invalidate an unchanged business quote', async () => {
  const cap = PAOTUI_READ_CAPABILITIES[1]!;
  let reads = 0;
  const adapter = new PaotuiReadAdapter(1, { query: async () => { reads++; return { ...quote(), ontologyReceipt: { id: randomUUID(), evidenceKind: 'fixture', observedAt: new Date().toISOString() } }; } });
  const catalog = new ExecutionCatalog([cap], [PAOTUI_READ_BINDINGS[1]!], [adapter]);
  const runner = backend(catalog, reasoner(r => ({ ...interpretation(r, cap.ref.id, query), capabilityRef: cap.ref })));
  try {
    runner.submit({ goal: 'Read a 1公斤 parcel quote only', requirements: [{ id: 'goods_weight', kind: 'quantity', strength: 'hard', expected: { amount: '1', unit: '公斤' } }] }); const done = await runner.run();
    assert.equal(done.state, 'completed'); assert.equal(reads, 2); assert.equal(done.delegation!.acceptance!.accepted, true);
    assert.equal(done.delegation!.resolution!.candidates[0]!.requirementChecks[0]!.result, 'pass');
  } finally { runner.store.close(); }
});

test('quotes with a different weight or missing total cannot become executable candidates', async () => {
  const cap = PAOTUI_READ_CAPABILITIES[1]!;
  for (const changed of [{ ...quote(), goods: { ...quote().goods, weightKg: 2 } }, { ...quote(), quote: {} }]) {
    const adapter = new PaotuiReadAdapter(1, { query: async () => changed });
    const prepared = await adapter.prepare({ owner: JSON.stringify(['local-development', 'local', 'developer']), request: { id: randomUUID(), revision: 1, originalGoal: 'Read quote', messages: [], requirements: [] } }, query, new AbortController().signal);
    assert.equal(prepared.kind, 'unavailable');
  }
});
