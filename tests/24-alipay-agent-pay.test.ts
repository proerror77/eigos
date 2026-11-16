import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { z } from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { digest } from '../packages/core/identity.js';
import {
  alipayAgentPayRehearsal, alipayOrderObservation, alipayPACapability, alipayPARequest, alipayPaymentType,
} from '../packages/ontology/alipay-agent-pay.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { alipayAgentPayRehearsalFunctions } from '../packages/capabilities/payments/alipay-agent-pay.js';
import type { AgentDriver } from '../packages/runtime/agent.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { document, fixture, principal } from './fixture.js';

type Observation = z.infer<typeof alipayOrderObservation>;

async function syntheticMerchant(t: TestContext) {
  const checkout = 'https://cashier.alipay.invalid/checkout/merchant-issued-fixture';
  const merchantOrderId = 'sim-merchant-order', transactionId = 'sim-alipay-receipt';
  let createCount = 0, paymentCount = 0, amountMinor = 5900;
  let status: Observation['status'] = 'awaiting_payment';
  let observedAt = new Date().toISOString();
  const snapshot = () => ({
    name: 'Fixture mug', merchant: 'Fixture Taobao store', merchantOrderId, amountMinor, currency: 'CNY',
    skuId: 'fixture-blue', quantity: 1, checkoutDigest: digest(checkout),
    expiresAt: new Date(Date.parse(observedAt) + 3600_000).toISOString(),
    observedAt, status, evidence: 'synthetic', ...(status === 'paid' ? { transactionId } : {}),
  });
  const expiresAt = snapshot().expiresAt;
  let reads = 0, paymentReads = 0, wrongReceipt = false;
  const expressApp = express();
  expressApp.use(express.json());
  expressApp.post('/mcp', async (req, res) => {
    const mcp = new McpServer({ name: 'synthetic-supplier', version: '1' });
    const content = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
    mcp.registerTool('create_order', { description: 'Synthetic supplier issues an order and checkout.',
      inputSchema: z.strictObject({ skuId: z.literal('fixture-blue'), quantity: z.literal(1) }) }, () => {
      createCount++;
      return content({ merchantOrderId, checkout });
    });
    mcp.registerTool('read_order', { description: 'Read the existing synthetic supplier order.',
      inputSchema: z.strictObject({ merchantOrderId: z.literal(merchantOrderId) }) }, () => {
      assert.equal(createCount, 1);
      reads++;
      return content({ ...snapshot(), expiresAt });
    });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    res.on('close', () => { void mcp.close(); });
    await transport.handleRequest(req, res, req.body);
  });
  const server = expressApp.listen(0, '127.0.0.1');
  await new Promise<void>((done, reject) => { server.once('listening', done); server.once('error', reject); });
  const client = new Client({ name: 'payment-rehearsal', version: '1' });
  t.after(async () => { await client.close(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + address.port + '/mcp')));
  async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const reply = await client.callTool({ name, arguments: args }, { signal });
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    return JSON.parse((reply.content as { text: string }[])[0]!.text) as unknown;
  }
  return {
    async create() {
      return await call('create_order', { skuId: 'fixture-blue', quantity: 1 }) as { merchantOrderId: string; checkout: string };
    },
    async read(id: string, signal: AbortSignal) {
      return alipayOrderObservation.parse(await call('read_order', { merchantOrderId: id }, signal));
    },
    beginPaPayment(material: string, termsHash: string, approvedAmount: number) {
      assert.equal(material, checkout);
      assert.equal(digest(material), termsHash);
      assert.equal(approvedAmount, amountMinor);
      paymentCount++;
      status = 'processing';
      observedAt = new Date().toISOString();
    },
    settlePaPayment() { assert.equal(paymentCount, 1); status = 'paid'; observedAt = new Date().toISOString(); },
    async readTransaction(id: string, signal: AbortSignal) {
      signal.throwIfAborted();
      assert.equal(id, transactionId);
      assert.equal(status, 'paid');
      paymentReads++;
      return { merchantOrderId, merchant: 'Fixture Taobao store', currency: 'CNY' as const,
        amountMinor: wrongReceipt ? amountMinor + 1 : amountMinor,
        checkoutDigest: digest(checkout), transactionId, evidence: 'synthetic' as const };
    },
    setWrongReceipt(value: boolean) { wrongReceipt = value; },
    changeAmount() { amountMinor++; },
    counts() { return { createCount, paymentCount, reads, paymentReads }; },
    transactionId,
  };
}

test('a supplier MCP order reaches its PA payment request on one task with independent readback', async t => {
  const merchant = await syntheticMerchant(t);
  const original = await merchant.create();
  const driver: AgentDriver = {
    model: 'synthetic-alipay-agent-pay',
    async run(prompt, tools) {
      const { userRequest } = JSON.parse(prompt.split('\n').at(-1)!);
      const { merchantOrderId } = JSON.parse(userRequest.message);
      const apply = (action: string, input: Record<string, unknown>) => tools.get('apply_action')!.invoke({ action, input });
      const order = await apply('RegisterAlipayRehearsalOrder', { merchantOrderId }) as ObjectRef;
      const payment = await apply('PrepareAlipayAgentPayRehearsal', { order }) as ObjectRef;
      const result = await apply('HandoffAlipayAgentPayRehearsal', { payment }) as { waitingForPA?: boolean };
      if (result.waitingForPA) return;
      await tools.get('complete_with_object_set')!.invoke({ set: { op: 'query', query: { type: alipayPaymentType } } });
    },
  };
  const definition = {
    ...document, version: document.version + '-alipay-rehearsal',
    objectTypes: [...document.objectTypes, ...alipayAgentPayRehearsal.objectTypes],
    linkTypes: [...document.linkTypes, ...alipayAgentPayRehearsal.linkTypes],
    functionTypes: [...document.functionTypes, ...alipayAgentPayRehearsal.functionTypes],
    actionTypes: [...document.actionTypes, ...alipayAgentPayRehearsal.actionTypes],
  };
  const f = await fixture(driver, undefined, undefined, definition, undefined, {
    functions: alipayAgentPayRehearsalFunctions(async owner => {
      assert.equal(owner, principal.owner);
      return { authorityId: 'synthetic-merchant-binding', readOrder: merchant.read, readTransaction: merchant.readTransaction };
    }),
  }, { sandbox: true });
  t.after(() => f.close());
  await assert.rejects(f.capabilities.actions.apply(f.access, f.model, 'RegisterAlipayRehearsalOrder',
    { merchantOrderId: 'real-looking-order-id' }, 'reject-live-order'));
  assert.equal(merchant.counts().reads, 0);
  const taskInput = { message: JSON.stringify({ merchantOrderId: original.merchantOrderId }) };
  const task = await f.tasks.submit(principal, { ...taskInput, requestId: 'original-shopping-task' });
  assert(await f.worker.runOne());
  const pa = new PARequests(f.tasks), pending = (await pa.pending(principal)).items;
  assert.equal(pending.length, 1, JSON.stringify(await f.tasks.get(principal, task.id)));
  const { request } = pending[0]!;
  assert.equal(request.taskId, task.id);
  assert.equal(request.capability, alipayPACapability);
  const terms = alipayPARequest.parse(request.input);
  assert.equal(terms.merchantOrderId, original.merchantOrderId);
  assert.equal(terms.amountMinor, 5900);
  assert(!JSON.stringify(request).includes(original.checkout));

  const duplicate = await f.tasks.submit(principal, { ...taskInput, requestId: 'other-shopping-task' });
  assert(await f.worker.runOne());
  assert.equal((await f.tasks.get(principal, duplicate.id)).state, 'failed');
  assert.equal((await pa.pending(principal)).items.length, 1);
  await assert.rejects(pa.respond({ ...principal, owner: 'another-owner' }, task.id,
    { requestId: request.requestId, response: { decision: 'check_status' } }), /unavailable/);
  await assert.rejects(pa.respond(principal, task.id,
    { requestId: request.requestId, response: { decision: 'check_status', paid: true } }));

  merchant.beginPaPayment(original.checkout, terms.checkoutDigest, terms.amountMinor);
  const reply = { requestId: request.requestId, response: { decision: 'check_status' } };
  await pa.respond(principal, task.id, reply);
  await pa.respond(principal, task.id, reply);
  assert(await f.worker.runOne());
  assert.equal((await f.tasks.get(principal, task.id)).state, 'completed');
  assert.equal((await pa.pending(principal)).items.length, 0);

  const graph = new Objects(f.db, f.model, f.access);
  assert.equal((await graph.read(terms.payment)).properties.status, 'processing');
  merchant.settlePaPayment();
  const refresh = (id: string) =>
    f.capabilities.actions.apply(f.access, f.model, 'RefreshAlipayAgentPayRehearsal', { payment: terms.payment }, id);
  merchant.setWrongReceipt(true);
  await assert.rejects(refresh('mismatched-alipay-receipt'), /receipt differs/);
  assert.equal((await graph.read(terms.payment)).properties.status, 'processing');
  merchant.setWrongReceipt(false);
  assert.deepEqual(await refresh('refresh-original-payment'), terms.payment);
  const paid = await graph.read(terms.payment);
  assert.equal(paid.properties.status, 'paid');
  assert.equal(paid.properties.transactionId, merchant.transactionId);
  assert.equal(paid.properties.evidence, 'synthetic');
  assert.equal(paid.properties.independentRead, true);
  assert.equal(merchant.counts().createCount, 1);
  assert.equal(merchant.counts().paymentCount, 1);
  assert(merchant.counts().reads >= 3);
  assert.equal(merchant.counts().paymentReads, 2);

  merchant.changeAmount();
  await assert.rejects(refresh('changed-supplier-amount'), /checkout terms changed/);
  assert.deepEqual(await graph.read(terms.payment), paid);
});
