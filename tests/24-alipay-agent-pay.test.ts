import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { z } from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { digest } from '../packages/core/identity.js';
import {
  alipayAgentPayRehearsal, alipayCheckoutTerms, alipayOrderObservation, alipayPACapability, alipayPARequest,
  alipayPaymentResult, alipaySubmission, alipayTransactionObservation,
} from '../packages/ontology/alipay-agent-pay.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { alipayAgentPayRehearsalFunctions } from '../packages/capabilities/payments/alipay-agent-pay.js';
import type { AgentDriver } from '../packages/runtime/agent.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { document, fixture, principal } from './fixture.js';

type Observation = z.infer<typeof alipayOrderObservation>;

async function syntheticMerchant(t: TestContext, loseAcknowledgement: boolean) {
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
    mcp.registerTool('submit_payment', { description: 'Submit a synthetic payment against the original order.',
      inputSchema: z.strictObject({ terms: alipayCheckoutTerms, operationId: z.string().regex(/^alipay-rehearsal:[a-f0-9]{64}$/) }) },
    ({ terms }) => {
      assert.equal(terms.merchantOrderId, merchantOrderId);
      assert.equal(terms.merchant, 'Fixture Taobao store');
      assert.equal(terms.checkoutDigest, digest(checkout));
      assert.equal(terms.amountMinor, amountMinor);
      assert.equal(terms.skuId, 'fixture-blue');
      assert.equal(status, 'awaiting_payment');
      assert.equal(paymentCount, 0);
      paymentCount++;
      status = 'processing';
      observedAt = new Date().toISOString();
      if (loseAcknowledgement) return { ...content({ code: 'response_lost' }), isError: true };
      return content({ merchantOrderId, checkoutDigest: digest(checkout), evidence: 'synthetic', state: 'accepted' });
    });
    mcp.registerTool('read_transaction', { description: 'Read the independent synthetic payment receipt.',
      inputSchema: z.strictObject({ transactionId: z.literal(transactionId) }) }, () => {
      assert.equal(status, 'paid');
      paymentReads++;
      return content({ merchantOrderId, merchant: 'Fixture Taobao store', currency: 'CNY',
        amountMinor: wrongReceipt ? amountMinor + 1 : amountMinor,
        checkoutDigest: digest(checkout), transactionId, evidence: 'synthetic' });
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
    async submitPayment(terms: z.infer<typeof alipayCheckoutTerms>, operationId: string, signal: AbortSignal) {
      return alipaySubmission.parse(await call('submit_payment', { terms, operationId }, signal));
    },
    settlePayment() { assert.equal(paymentCount, 1); status = 'paid'; observedAt = new Date().toISOString(); },
    async readTransaction(id: string, signal: AbortSignal) {
      return alipayTransactionObservation.parse(await call('read_transaction', { transactionId: id }, signal));
    },
    setWrongReceipt(value: boolean) { wrongReceipt = value; },
    changeAmount() { amountMinor++; },
    counts() { return { createCount, paymentCount, reads, paymentReads }; },
    transactionId,
  };
}

const scenarios = [
  ['accepted', 'Ontology submits one supplier payment after approval and independently verifies settlement'],
  ['lost_ack', 'Ontology reads the original payment after a lost acknowledgement'],
  ['declined', 'Ontology records declined approval without calling the payment connector'],
  ['changed_terms', 'Ontology rejects a payment whose original terms changed after approval'],
] as const;
for (const [scenario, title] of scenarios) {
  test(title, async t => {
    const loseAcknowledgement = scenario === 'lost_ack';
    const merchant = await syntheticMerchant(t, loseAcknowledgement);
    const original = await merchant.create();
    let modelCalls = 0;
    const driver: AgentDriver = {
      model: 'synthetic-alipay-agent-pay',
      async run(prompt, tools) {
        modelCalls++;
        const { userRequest } = JSON.parse(prompt.split('\n').at(-1)!);
        const { merchantOrderId } = JSON.parse(userRequest.message);
        const apply = (action: string, input: Record<string, unknown>) => tools.get('apply_action')!.invoke({ action, input });
        const order = await apply('RegisterAlipayRehearsalOrder', { merchantOrderId }) as ObjectRef;
        const payment = await apply('PrepareAlipayAgentPayRehearsal', { order }) as ObjectRef;
        await tools.get('complete_with_action')!.invoke({
          action: { interface: { type: 'AgentPay', object: payment, action: 'submit' }, input: { payment } },
          read: { function: 'readAlipayAgentPayRehearsal', resultParameter: 'payment' },
        });
      },
    };
    const definition = {
      ...document, version: document.version + '-alipay-rehearsal',
      objectTypes: [...document.objectTypes, ...alipayAgentPayRehearsal.objectTypes],
      interfaceTypes: [...document.interfaceTypes, ...alipayAgentPayRehearsal.interfaceTypes],
      linkTypes: [...document.linkTypes, ...alipayAgentPayRehearsal.linkTypes],
      functionTypes: [...document.functionTypes, ...alipayAgentPayRehearsal.functionTypes],
      actionTypes: [...document.actionTypes, ...alipayAgentPayRehearsal.actionTypes],
    };
    const f = await fixture(driver, undefined, undefined, definition, undefined, {
      functions: alipayAgentPayRehearsalFunctions(async owner => {
        assert.equal(owner, principal.owner);
        return { authorityId: 'synthetic-merchant-binding', readOrder: merchant.read, readTransaction: merchant.readTransaction,
          submitPayment: merchant.submitPayment };
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
    assert.equal(merchant.counts().paymentCount, 0);
    const reply = { requestId: request.requestId, response: {
      decision: scenario === 'declined' ? 'decline' : 'approve', termsDigest: terms.termsDigest,
    } };
    await assert.rejects(pa.respond({ ...principal, owner: 'another-owner' }, task.id, reply), /unavailable/);
    await assert.rejects(pa.respond(principal, task.id, { ...reply, response: { ...reply.response, paid: true } }));

    await pa.respond(principal, task.id, reply);
    await pa.respond(principal, task.id, reply);
    assert.equal(merchant.counts().paymentCount, 0, 'approval only resumes the original Ontology Action');
    if (scenario === 'changed_terms') merchant.changeAmount();
    if (loseAcknowledgement) {
      const abandoned = await f.tasks.claim('interactive');
      assert(abandoned && abandoned.id === task.id);
      const call = abandoned.input.placeContinuation;
      assert(call && call.waitingFor === 'pa-request');
      // The supplier sees the charge, but the worker loses its lease before committing the Action result.
      await assert.rejects(f.capabilities.actions.apply(f.access, f.model, call.action, call.input, call.requestId, async client => {
        await f.tasks.current(abandoned, client, true);
        const operation = await f.db.query(`SELECT state FROM ${f.db.schema}.external_operations WHERE task_id=$1`, [task.id], client);
        if (operation.rowCount) throw new Error('simulated worker loss after dispatch');
      }, { task: abandoned, tasks: f.tasks }), /simulated worker loss after dispatch/);
      assert.equal(merchant.counts().paymentCount, 1);
      assert.equal((await f.db.query(`SELECT 1 FROM ${f.db.schema}.actions WHERE request_id=$1`, [call.requestId])).rowCount, 0);
      await f.db.query(`UPDATE ${f.db.schema}.tasks SET lease_until=now()-interval '1 second' WHERE id=$1 AND token=$2`, [task.id, abandoned.token]);
    }
    const callsBeforeResume = modelCalls;
    assert(await f.worker.runOne());
    const done = await f.tasks.get(principal, task.id);
    if (scenario === 'changed_terms' || scenario === 'declined') {
      assert.equal(merchant.counts().paymentCount, 0);
      const dispatched = await f.db.query(`SELECT state FROM ${f.db.schema}.external_operations WHERE task_id=$1`, [task.id]);
      assert.equal(dispatched.rowCount, 0);
      if (scenario === 'changed_terms') {
        assert.equal(done.state, 'failed');
        assert.match(done.error ?? '', /checkout terms changed/);
      } else {
        assert.equal(done.state, 'completed', done.error ?? undefined);
        assert.equal(alipayPaymentResult.strip().parse(done.result).submissionState, 'declined');
      }
      return;
    }
    assert.equal(done.state, 'completed', done.error ?? JSON.stringify(done.result));
    assert.equal(modelCalls, callsBeforeResume, 'the Action resumes without a second Agent decision');
    assert.equal((await pa.pending(principal)).items.length, 0);
    assert.equal((done.result as { execution: { mode: string } }).execution.mode, 'action-continuation');
    const result = alipayPaymentResult.strip().parse(done.result);
    assert.equal(result.submissionState, loseAcknowledgement ? 'unknown' : 'accepted');
    assert.equal(result.status, loseAcknowledgement ? 'processing' : 'awaiting_payment', 'only an independent source read changes settlement status');
    assert.equal(result.transactionId, undefined);
    assert.equal(merchant.counts().paymentCount, 1);
    const dispatch = (await f.db.query(`SELECT state,request_id,task_id FROM ${f.db.schema}.external_operations
      WHERE owner=$1 AND operation_key=$2`, [principal.owner, 'alipay-rehearsal:' + terms.payment.id])).rows[0];
    assert.equal(dispatch?.state, loseAcknowledgement ? 'unknown' : 'confirmed');
    assert.equal(dispatch?.task_id, task.id);
    assert.equal(typeof dispatch?.request_id, 'string');

    const graph = new Objects(f.db, f.model, f.access);
    merchant.settlePayment();
    const refresh = (id: string) =>
      f.capabilities.actions.apply(f.access, f.model, 'RefreshAlipayAgentPayRehearsal', { payment: terms.payment }, id);
    merchant.setWrongReceipt(true);
    await assert.rejects(refresh('mismatched-alipay-receipt'), /receipt differs/);
    assert.equal((await graph.read(terms.payment)).properties.status, result.status);
    merchant.setWrongReceipt(false);
    assert.deepEqual(await refresh('refresh-original-payment'), terms.payment);
    const paid = await graph.read(terms.payment);
    assert.equal(paid.properties.status, 'paid');
    assert.equal(paid.properties.transactionId, merchant.transactionId);
    assert.equal(paid.properties.evidence, 'synthetic');
    assert.equal(paid.properties.submissionState, loseAcknowledgement ? 'unknown' : 'accepted');
    assert.deepEqual(await refresh('read-again-without-resubmitting'), terms.payment);
    assert.equal(paid.properties.independentRead, true);
    assert.equal(merchant.counts().createCount, 1);
    assert.equal(merchant.counts().paymentCount, 1);
    assert(merchant.counts().reads >= 3);
    assert.equal(merchant.counts().paymentReads, 3);

    merchant.changeAmount();
    await assert.rejects(refresh('changed-supplier-amount'), /checkout terms changed/);
    assert.deepEqual(await graph.read(terms.payment), paid);
  });
}
