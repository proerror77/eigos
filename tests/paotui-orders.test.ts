import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaotuiOrders, type PaotuiOrderProvider, type PreparedOrder } from '../packages/capabilities/paotui-orders.js';
import { LocalPaotuiReader } from '../packages/capabilities/paotui.js';

const signal = new AbortController().signal;
const query = { action: 'prepare_order', intentId: 'delivery-1', preview: { action: 'preview', senderAddressId: 'a', recipientAddressId: 'b', goodsName: '文件', category: '文件', weightKg: 1, service: 'ordinary' } };
const prepared: PreparedOrder = { summary: { route: { sender: 'A', recipient: 'B' }, goods: '1kg files', service: 'ordinary' }, amountFen: 5250, submissionArgs: ['--order-token', 'SECRET-QUOTE', '--sender', 'SECRET-PHONE'], credentialHash: 'SECRET-AUTH-HASH' };
function fixture() {
  const calls = { prepare: 0, submit: 0, links: 0 };
  const provider: PaotuiOrderProvider = {
    prepare: async () => { calls.prepare++; return structuredClone(prepared); },
    submit: async () => { calls.submit++; return { orderId: 'TEST-ORDER', tradeNo: 'TEST-TRADE', payToken: 'SECRET-PAY' }; },
    paymentLinks: async () => { calls.links++; return { mobilePayUrl: 'https://pay.meituan.com/test-mobile', pcPayUrl: 'https://pay.meituan.com/test-pc' }; },
  };
  return { calls, provider };
}
const confirmation = (p: any) => ({ action: 'confirm_order', previewId: p.previewId, digest: p.digest, amountFen: p.amountFen, confirmation: '确认下单' });

test('default disabled gate blocks valid confirmation and payment links before provider side effects', async () => {
  const f = fixture(), flow = new PaotuiOrders(':memory:', f.provider);
  try {
    const p: any = await flow.run('owner', query, signal);
    assert.equal(p.state, 'awaiting_confirmation'); assert.equal(p.ordersEnabled, false);
    await assert.rejects(flow.run('owner', confirmation(p), signal), /disabled/);
    await assert.rejects(flow.run('owner', { action: 'payment_links', previewId: p.previewId }, signal), /disabled/);
    assert.equal(f.calls.submit, 0); assert.equal(f.calls.links, 0);
    assert(!JSON.stringify(p).includes('SECRET'));
  } finally { flow.close(); }
});

test('exact confirmation, ownership, expiry and immutable intent are enforced', async () => {
  const f = fixture(); let now = 1000;
  const flow = new PaotuiOrders(':memory:', f.provider, true, () => now);
  try {
    const p: any = await flow.run('owner', query, signal);
    await assert.rejects(flow.run('other', confirmation(p), signal), /not found/);
    await assert.rejects(flow.run('owner', { ...confirmation(p), amountFen: 1 }, signal), /match/);
    await assert.rejects(flow.run('owner', { ...confirmation(p), digest: '0'.repeat(64) }, signal), /match/);
    await assert.rejects(flow.run('owner', { ...confirmation(p), confirmation: '放门口' }, signal));
    await assert.rejects(flow.run('owner', { ...query, preview: { ...query.preview, weightKg: 2 } }, signal), /different preview/);
    now += 300000;
    await assert.rejects(flow.run('owner', confirmation(p), signal), /expired/);
    assert.equal(f.calls.submit, 0);
  } finally { flow.close(); }
});

test('concurrent confirmations, new request IDs and restart cannot duplicate a submitted order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-paotui-')); const path = join(dir, 'orders.sqlite');
  const f = fixture(); let flow = new PaotuiOrders(path, f.provider, true);
  try {
    const p: any = await flow.run('owner', query, signal);
    assert.equal((await flow.run('owner', query, signal) as any).previewId, p.previewId);
    await Promise.all([flow.run('owner', confirmation(p), signal), flow.run('owner', confirmation(p), signal)]);
    assert.equal(f.calls.submit, 1);
    flow.close(); flow = new PaotuiOrders(path, f.provider, true);
    const result: any = await flow.run('owner', confirmation(p), signal);
    assert.equal(result.state, 'awaiting_payment'); assert.equal(f.calls.submit, 1);
    assert(!readFileSync(path).includes(Buffer.from('SECRET')));
    const links: any = await flow.run('owner', { action: 'payment_links', previewId: p.previewId }, signal);
    assert.equal(links.paymentConfirmed, false); assert.equal(links.deliveryConfirmed, false);
    assert(!JSON.stringify(links).includes('SECRET-PAY'));
  } finally { flow.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('timeout or ambiguous provider response never causes an automatic submission retry', async () => {
  const f = fixture(); f.provider.submit = async () => { f.calls.submit++; throw new Error('SECRET-TIMEOUT'); };
  const flow = new PaotuiOrders(':memory:', f.provider, true);
  try {
    const p: any = await flow.run('owner', query, signal);
    const first: any = await flow.run('owner', confirmation(p), signal);
    assert.equal(first.state, 'submission_unknown');
    await flow.run('owner', confirmation(p), signal);
    await assert.rejects(flow.run('owner', { action: 'payment_links', previewId: p.previewId }, signal), /No confirmed/);
    assert.equal(f.calls.submit, 1); assert(!JSON.stringify(first).includes('SECRET'));
  } finally { flow.close(); }
});

test('payment-link retry never resubmits and rejects untrusted checkout hosts', async () => {
  const f = fixture();
  f.provider.paymentLinks = async () => { f.calls.links++; if (f.calls.links === 1) throw new Error('timeout'); return { mobilePayUrl: 'https://pay.meituan.com/m', pcPayUrl: 'https://pay.meituan.com/p' }; };
  const flow = new PaotuiOrders(':memory:', f.provider, true);
  try {
    const p: any = await flow.run('owner', query, signal);
    await flow.run('owner', confirmation(p), signal);
    const q = { action: 'payment_links', previewId: p.previewId };
    await assert.rejects(flow.run('owner', q, signal)); await flow.run('owner', q, signal);
    assert.equal(f.calls.submit, 1); assert.equal(f.calls.links, 2);
    f.provider.paymentLinks = async () => ({ mobilePayUrl: 'https://meituan.com.evil.example/m', pcPayUrl: 'https://pay.meituan.com/p' });
    await assert.rejects(flow.run('owner', q, signal), /Untrusted/);
  } finally { flow.close(); }
});

test('real CLI has a second independent disabled gate', async () => {
  const real = new LocalPaotuiReader('/does-not-exist');
  await assert.rejects(real.submit(prepared, signal), /disabled/);
  await assert.rejects(real.paymentLinks({ orderId: 'x', tradeNo: 'x', payToken: 'x' }, signal), /disabled/);
});

test('MCP preview and A2A confirmation/link readback share the same durable workflow (fixture provider only)', async () => {
  const { createLocalApp: createApp } = await import('../apps/local.js');
  const { readConfig } = await import('../packages/core/config.js');
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const { randomUUID } = await import('node:crypto');
  const f = fixture(), token = 'test-local-token-'.repeat(4);
  const config = readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, DATABASE_PATH: ':memory:', EIGOS_PAOTUI_SKILL_DIR: '/fixture-only', EIGOS_PAOTUI_ORDERS_ENABLED: 'true' });
  const gateway = createApp(config, undefined, undefined, f.provider);
  const server = gateway.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: 'paotui-order-fixture', version: '1' });
  const p = { issuer: 'local-development', tenant: 'local', subject: 'developer', clientId: 'eigos-local-dev', scopes: ['tasks:write', 'tasks:read'] };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const r = await client.callTool({ name: 'submit_task', arguments: { service: 'meituan.paotui.order', goal: JSON.stringify(query), requestId: randomUUID() } });
    assert(!r.isError);
    const job = (r.structuredContent as any).result;
    const done = await gateway.tasks.wait(p, job.id); const preview: any = done.artifact?.data.result;
    async function a2a(q: object) {
      const response = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'SendMessage', params: { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'meituan.paotui.order', goal: JSON.stringify(q) } }] } } }) });
      const body = await response.json(); assert(!body.error, JSON.stringify(body));
      return (body.result.task ?? body.result).artifacts[0].parts[0].data.result;
    }
    const confirmed = await a2a(confirmation(preview)); assert.equal(confirmed.state, 'awaiting_payment');
    const links = await a2a({ action: 'payment_links', previewId: preview.previewId });
    assert.equal(links.paymentLinks.mobilePayUrl, 'https://pay.meituan.com/test-mobile');
    await a2a(confirmation(preview)); assert.equal(f.calls.submit, 1);
  } finally {
    await client.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await gateway.close();
  }
});
