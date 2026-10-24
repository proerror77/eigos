import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../packages/core/store.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { DELIVERY_REQUEST_CAPABILITY as cap, DELIVERY_REQUEST_BINDING as binding, PaotuiRequestAdapter } from './fixtures/legacy-paotui/paotui-request.js';
import { readConfig } from '../packages/core/config.js';
import { submitSchema } from '../packages/core/domain.js';
import { backend, reasoner, interpretation, principal, owner, proposal } from './backend-fixture.js';
import type { PaotuiQuery } from '../packages/capabilities/paotui-contracts.js';

const missing = { sender: null, recipient: null, goodsName: '文件', category: '文件', weightKg: 1, service: 'ordinary' };
function source() {
  const calls: PaotuiQuery[] = [];
  let addresses = [{ addressId: 'private-a', address: '测试住处', cityId: 1 }, { addressId: 'private-b', address: '测试办公室', cityId: 1 }, { addressId: 'private-c', address: '外地办公室', cityId: 2 }];
  return { calls, setAddresses: (value: typeof addresses) => { addresses = value; }, getAddresses: () => addresses,
    reader: { query: async (q: PaotuiQuery) => {
      calls.push(q);
      if (q.action === 'addresses') return { source: 'meituan', readOnly: true, addresses: structuredClone(addresses), ontologyReceipt: { evidenceKind: 'fixture' } };
      assert.equal(q.action, 'preview'); if (q.action !== 'preview') throw new Error('Unexpected read');
      return { source: 'meituan', previewOnly: true, orderCreated: false, goods: { name: q.goodsName, category: q.category, weightKg: q.weightKg }, service: q.service, quote: { _previewTotal: 12.5 }, route: { sender: '测试住处', recipient: '测试办公室' } };
    } },
  };
}
function runner(store: JobStore, s: ReturnType<typeof source>, selects = { sender: '地址1', recipient: '地址2' }) {
  const adapter = new PaotuiRequestAdapter(s.reader, store, 'fixture-config');
  const catalog = new ExecutionCatalog([cap], [binding], [adapter]);
  return backend(catalog, reasoner(r => ({ ...interpretation(r, cap.ref.id, r.messages.length > 1 ? { ...missing, ...selects } : missing), capabilityRef: cap.ref }), ctx => {
    assert(!JSON.stringify(ctx).includes('测试住处')); assert(!JSON.stringify(ctx).includes('private-a'));
    return proposal(ctx);
  }), store);
}

test('natural quote retains original task, private choices and hard constraints across restart and source reorder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-address-flow-')); const path = join(dir, 'tasks.sqlite'); const s = source();
  let store = new JobStore(path); let b = runner(store, s);
  try {
    const submitted = b.submit({ goal: '查一下1公斤文件普通送的价格，先让我选择地址。', requirements: [{ id: 'weight', kind: 'quantity', strength: 'hard', expected: { amount: '1', unit: '公斤' } }] });
    const asked = await b.run(); assert.equal(asked.state, 'input-required'); assert.match(asked.question!, /地址1：测试住处/); assert.equal(asked.runs!.length, 1); assert.equal(asked.artifact, undefined);
    assert.deepEqual(s.calls.map(q => q.action), ['addresses']);
    assert.throws(() => store.preparationContext('different-owner', submitted.id, 'delivery-addresses:fixture-config'), /not found/);
    store.close(); store = new JobStore(path); b = runner(store, s);
    s.setAddresses([...s.getAddresses()].reverse());
    const reply = { taskId: submitted.id, requestId: 'choice', answer: '1 寄到 2，只查价。' };
    b.tasks.reply(principal, reply); b.tasks.reply(principal, reply);
    const done = await b.run(); assert.equal(done.id, submitted.id); assert.equal(done.state, 'completed'); assert(done.delegation!.acceptance!.accepted); assert.equal(done.delegation!.request.revision, 2);
    assert.equal(done.goal, submitted.goal); assert.deepEqual(done.delegation!.request.requirements[0]!.expected, { amount: '1', unit: '公斤' });
    const quotes = s.calls.filter(q => q.action === 'preview'); assert.equal(quotes.length, 2);
    assert(quotes.every(q => q.action === 'preview' && q.senderAddressId === 'private-a' && q.recipientAddressId === 'private-b'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unseen, invented, ambiguous or cross-city selections never query a price', async () => {
  for (const selections of [{ sender: '1', recipient: '2' }, { sender: '地址10', recipient: '地址2' }, { sender: '地址1', recipient: '地址3' }, { sender: '办公室', recipient: '地址1' }]) {
    const s = source(); const store = new JobStore(':memory:'); const b = runner(store, s, selections);
    try {
      const j = b.submit({ goal: '查1公斤文件普通送运费' }); await b.run();
      b.tasks.reply(principal, { taskId: j.id, requestId: 'choice', answer: '我选办公室；寄件地址1，收件地址3。' });
      const asked = await b.run(); assert.equal(asked.state, 'input-required'); assert(!s.calls.some(q => q.action === 'preview'));
    } finally { store.close(); }
  }
});

test('changed address identity invalidates the old displayed selection', async () => {
  const s = source(); const store = new JobStore(':memory:'); const b = runner(store, s);
  try {
    const j = b.submit(); await b.run(); s.setAddresses(s.getAddresses().map(a => a.addressId === 'private-a' ? { ...a, address: '已修改的新住处' } : a));
    b.tasks.reply(principal, { taskId: j.id, requestId: 'choice', answer: '寄件地址1、收件地址2' });
    const asked = await b.run(); assert.equal(asked.state, 'input-required'); assert.match(asked.question!, /旧选项已失效/); assert.match(asked.question!, /新2-1/); assert(!s.calls.some(q => q.action === 'preview'));
  } finally { store.close(); }
});

test('numbers in weight or a different choice number cannot authorize a route', async () => {
  for (const answer of ['重量1公斤，最好2分钟内', '21寄到2']) {
    const s = source(); const store = new JobStore(':memory:'); const b = runner(store, s, { sender: '1', recipient: '2' });
    try {
      const j = b.submit(); await b.run(); b.tasks.reply(principal, { taskId: j.id, requestId: 'invalid-choice', answer });
      assert.equal((await b.run()).state, 'input-required'); assert(!s.calls.some(q => q.action === 'preview'));
    } finally { store.close(); }
  }
});

test('retired modes and direct service names cannot reopen old execution or enable real orders', () => {
  const env = { EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32) };
  assert.equal(readConfig(env).EIGOS_COORDINATOR, 'codex');
  assert.throws(() => readConfig({ ...env, EIGOS_COORDINATOR: 'disabled' }));
  assert.throws(() => readConfig({ ...env, EIGOS_PAOTUI_ORDERS_ENABLED: 'true' }));
  for (const service of ['brief.prepare', 'agent.execute', 'life.request', 'meituan.paotui.read', 'meituan.paotui.order', 'data.quality.audit.simulated']) assert.throws(() => submitSchema.parse({ service, goal: 'test', requestId: 'retired' }));
});
