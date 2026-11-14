import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { createApp } from '../apps/gateway/app.js';
import type { Config } from '../packages/core/config.js';
import type { AgentDriver, AgentTool } from '../packages/runtime/agent.js';
import { Objects } from '../packages/runtime/objects.js';
import { OntologyClient } from '../packages/sdk/client.js';
import { LuckinMcp, luckinMcpEndpoint } from '../packages/sdk/luckin-mcp.js';
import { LuckinPA } from '../packages/sdk/luckin-pa.js';
import { pickupOrderType } from '../packages/ontology/luckin.js';
import { digest } from '../packages/core/identity.js';

const shopData = { deptId: 19, deptName: '瑞幸测试店', address: '测试大厦', latitude: 31.2, longitude: 121.5 };
const line = { productId: 129, sku: 'SKU-LATTE-HOT', quantity: 1 };
const coupon = 'provider-coupon-keep-on-pa';
const qr = 'https://m.lkcoffee.com/transfer/qrcode?token=keep-on-pa';
const originalOrder = '7639308439653908490';
const previewData = {
  shopInfo: shopData, discountPrice: 13.1, totalInitialPrice: 16,
  productInfoList: [{ productId: line.productId, skuCode: line.sku, name: '拿铁', amount: 1, additionDesc: '热' }],
  couponCodeList: [coupon], aboutTime: 1794659133000,
};
const availableTools = {
  queryShopList: ['longitude', 'latitude', 'deptName'],
  searchProductForMcp: ['deptId', 'query', 'delivery'],
  previewOrder: ['deptId', 'productList'],
  createOrder: ['deptId', 'productList', 'longitude', 'latitude', 'couponCodeList', 'delivery'],
  queryOrderDetailInfo: ['orderId'],
} as const;

function provider() {
  let failCreate = false, raisePrice = false, reportPaid = false, changePreview = false;
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const transport: typeof fetch = async (input, init) => {
    assert.equal(String(input), luckinMcpEndpoint);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer luckin-test-token-without-access');
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    const envelope = JSON.parse(String(init?.body));
    if (envelope.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    let result;
    if (envelope.method === 'initialize') result = {
      protocolVersion: envelope.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
    };
    else if (envelope.method === 'tools/list') result = { tools: Object.entries(availableTools).map(([name, keys]) => ({
      name, inputSchema: { type: 'object', properties: Object.fromEntries(keys.map(key => [key, {}])) },
    })) };
    else if (envelope.method === 'tools/call') {
      const { name, arguments: input } = envelope.params;
      calls.push({ name, input });
      let data;
      if (name === 'queryShopList') data = [{ ...shopData, distance: 0.34 }];
      if (name === 'searchProductForMcp') data = [{ productId: 129, skuCode: line.sku, productName: '拿铁', estimatePrice: 13.1 }];
      if (name === 'previewOrder') data = { ...previewData, discountPrice: changePreview ? 14 : 13.1 };
      if (name === 'createOrder') {
        if (failCreate) throw new Error('Fixture lost reply after dispatch');
        data = { orderIdStr: originalOrder, needPay: true, discountPrice: raisePrice ? 14 : 13.1,
          payOrderQrCodeUrl: qr, payOrderUrl: 'weixin://private' };
      }
      if (name === 'queryOrderDetailInfo') data = { orderId: originalOrder, orderStatus: reportPaid ? 60 : 10,
        takeMealCodeInfo: { code: 'A083' } };
      assert(data, 'Unexpected tool ' + name);
      result = { content: [{ type: 'text', text: JSON.stringify({ code: 0, success: true, data }) }] };
    }
    return Response.json({ jsonrpc: '2.0', id: envelope.id, result });
  };
  const client = new LuckinMcp('luckin-test-token-without-access', transport);
  return { client, calls, loseCreate: () => failCreate = true, raisePrice: () => raisePrice = true,
    markPaid: () => reportPaid = true, changePreview: () => changePreview = true };
}

class PickupAgent implements AgentDriver {
  readonly model = 'synthetic';
  async run(_prompt: string, tools: ReadonlyMap<string, AgentTool>) {
    const call = (name: string, input: Record<string, unknown>) => tools.get(name)!.invoke(input);
    const preview = await call('apply_action', { action: 'PreviewLuckinPickup', input: { shopId: 19, items: [line], currency: 'CNY' } });
    if ('waitingForPA' in (preview as object)) return;
    await call('apply_action', { action: 'SubmitLuckinPickup', input: { order: preview } });
    await call('complete_with_function', { function: 'readLuckinPickup', input: { order: preview } });
  }
}

test('Luckin pickup confirms and resumes the original PA task, pins the merchant receipt and keeps payment on the PA', async () => {
  const f = await fixture(new PickupAgent());
  const local = await mkdtemp(join(tmpdir(), 'eigos-test-luckin-'));
  const supply = provider();
  const token = 'fixture-luckin-eigos-token-'.repeat(3);
  const config: Config = {
    DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL!, EIGOS_PG_SCHEMA: f.schema, HOST: '127.0.0.1', PORT: 0,
    PUBLIC_URL: 'http://127.0.0.1', EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token,
    OAUTH_TENANT_CLAIM: 'tenant_id', EIGOS_HARNESS_MODEL: 'synthetic', EIGOS_HARNESS_REASONING_EFFORT: 'low',
  };
  const server = createApp(config, f.db, f.source).app.listen(0, '127.0.0.1');
  const listening = await new Promise<{ port: number }>(resolve => server.once('listening', () => resolve(server.address() as {port: number})));
  const client = new OntologyClient({ baseUrl: 'http://127.0.0.1:' + listening.port, token });
  try {
    const task = await f.tasks.submit(principal, { requestId: 'luckin', message: '瑞幸测试店一杯热拿铁，自取' });
    await assert.rejects(client.apply({ action: 'PreviewLuckinPickup', requestId: 'direct', input: { shopId: 19, items: [line], currency: 'CNY' } }), /original authenticated PA task/);
    assert(await f.worker.runOne());
    const first = await f.tasks.get(principal, task.id);
    assert.equal((first.result as { capability: string }).capability, 'luckin.pickup.preview');
    let approvals = 0;
    const pa = new LuckinPA({ ontology: client, provider: supply.client, localConnectionId: digest('fixture-pa'),
      privateDirectory: local, confirm: async ({ quote }) => {
        approvals++;
        assert.equal(quote.shop.name, shopData.deptName);
        assert.equal(quote.items[0]?.optionsLabel, '热');
        assert.equal(quote.totalMinor, 1310);
        return true;
      },
    });
    await pa.answer(task.id);
    assert(await f.worker.runOne());
    const waiting = await f.tasks.get(principal, task.id);
    assert.equal((waiting.result as { capability: string }).capability, 'luckin.pickup.create');
    await assert.rejects(pa.answer(task.id), /present this exact Luckin preview/);
    assert.deepEqual(supply.calls.map(c => c.name), ['previewOrder']);
    const placement = await pa.answer(task.id, AbortSignal.timeout(5000), 'submit');
    assert.equal(placement.paymentLink, qr);
    assert.equal(placement.priceChanged, false);
    assert.equal(approvals, 1);
    assert.deepEqual(supply.calls.map(c => c.name), ['previewOrder', 'previewOrder', 'createOrder']);
    assert.deepEqual(supply.calls[2]!.input, { deptId: 19, productList: [{ productId: 129, skuCode: line.sku, amount: 1 }],
      latitude: shopData.latitude, longitude: shopData.longitude, couponCodeList: [coupon], delivery: 'pick' });
    assert(await f.worker.runOne());
    const terminal = await f.tasks.get(principal, task.id);
    assert.equal(terminal.state, 'completed');
    const rows = (await new Objects(f.db, f.model, f.access).query({ type: pickupOrderType })).items;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.properties.merchantOrderId, originalOrder);
    assert.equal(rows[0]?.properties.state, 'awaiting_payment');
    assert.equal(rows[0]?.properties.merchantAmountMinor, 1310);
    assert.doesNotMatch(JSON.stringify([terminal.result, rows, placement.continuation]), /keep-on-pa|payOrder/);
    assert.deepEqual((await f.db.query(`SELECT (SELECT count(*)::int FROM ${f.db.schema}.scenarios) scenarios,
      (SELECT count(*)::int FROM ${f.db.schema}.scheduled_actions) scheduled`)).rows[0], { scenarios: 0, scheduled: 0 });
    assert.equal((await supply.client.status(originalOrder, AbortSignal.timeout(5000))).pickupCode, null);
    supply.markPaid();
    assert.equal((await supply.client.status(originalOrder, AbortSignal.timeout(5000))).pickupCode, 'A083');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(local, { recursive: true, force: true });
    await f.close();
  }
});

async function localApproval(supply: ReturnType<typeof provider>, directory: string) {
  const taskId = '32879d60-7b55-4dba-b580-acf5df53185f';
  const requestId = '9e3cb555-0206-46e3-b79f-9bc990ef56d8';
  const localConnectionId = digest('second-fixture');
  const { coupons, ...terms } = await supply.client.preview({ shopId: 19, items: [line], currency: 'CNY' }, AbortSignal.timeout(5000));
  const quote = { ...terms, couponDigest: digest(coupons) };
  const result = { kind: 'pa-request', taskId, requestId, capability: 'luckin.pickup.create',
    input: { order: { type: pickupOrderType, id: 'original' }, quote, quoteDigest: digest(quote),
      connectionRef: supply.client.connectionRef(localConnectionId), expiresAt: new Date(Date.now() + 240000).toISOString() },
  };
  const responses: unknown[] = [];
  const ontology = { async request<T>(_path: string, body?: unknown) {
    if (body) responses.push(body);
    return { id: taskId, state: 'input-required', result } as T;
  }};
  const pa = new LuckinPA({ ontology, provider: supply.client, privateDirectory: directory, localConnectionId, confirm: () => true });
  return { call: () => pa.answer(taskId, AbortSignal.timeout(5000), 'submit'), responses };
}
test('PA never retries a lost Luckin create response, and posts the identical saved receipt after EIGOS response loss', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-test-luckin-loss-'));
  const healthy = await mkdtemp(join(tmpdir(), 'eigos-test-luckin-replay-'));
  try {
    const lost = provider(), waiting = await localApproval(lost, directory);
    lost.loseCreate();
    await assert.rejects(waiting.call(), /could not be verified/);
    await assert.rejects(waiting.call(), /original Luckin submission is unresolved/);
    assert.equal(lost.calls.filter(c => c.name === 'createOrder').length, 1);
    assert.equal(waiting.responses.length, 0);
    const ok = provider(), saved = await localApproval(ok, healthy);
    const first = await saved.call(), second = await saved.call();
    assert.equal(first.paymentLink, second.paymentLink);
    assert.deepEqual(saved.responses[0], saved.responses[1]);
    assert.equal(ok.calls.filter(c => c.name === 'createOrder').length, 1);
    // Give this independent checkout its own PA journal.
    const distinct = await mkdtemp(join(tmpdir(), 'eigos-test-luckin-new-price-'));
    try {
      const willChange = provider(), review = await localApproval(willChange, distinct);
      willChange.changePreview();
      await review.call();
      assert.equal(willChange.calls.filter(c => c.name === 'createOrder').length, 0);
      assert.deepEqual((review.responses[0] as { response: unknown }).response, { status: 'changed' });
    } finally { await rm(distinct, { recursive: true, force: true }); }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(healthy, { recursive: true, force: true });
  }
});

test('a Luckin price change reported after creation preserves the original order ID and withholds its payment link', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-test-luckin-price-'));
  try {
    const supply = provider(), waiting = await localApproval(supply, directory);
    supply.raisePrice();
    const result = await waiting.call();
    assert.equal(result.priceChanged, true);
    assert.equal(result.paymentLink, undefined);
    const sent = (waiting.responses[0] as { response: { data: { orderId: string; totalMinor: number } } }).response.data;
    assert.equal(sent.orderId, originalOrder);
    assert.equal(sent.totalMinor, 1400);
    assert.equal(supply.calls.filter(c => c.name === 'createOrder').length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
