import { PaotuiAddressSelection } from '../packages/capabilities/paotui-address-selection.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { owner, principal } from './backend-fixture.js';
import { setup, observe, decide, step, bookChoice } from './fixtures/paotui-agent.js';
import { paotuiAgentEvidence } from '../packages/ontology/paotui-agent-evidence.js';
import { NetworkEvidence } from '../packages/network/evidence.js';

const goal = '查询1公斤文件普通送费用，先让我选地址';
test('model selects book-only or separate detail/quote reads; same-task clarification hides private payloads from ontology and model', async () => {
  const f = setup();
  try {
    const job = f.b.submit({ goal }); const asked = await f.finish(job.id);
    assert.equal(asked.state, 'input-required'); assert(asked.question?.includes('PRIVATE_ORIGIN'));
    assert.deepEqual(f.calls.map(c => c.operation), ['get_address_list']);
    f.b.tasks.reply(principal, { taskId: job.id, requestId: randomUUID(), answer: '1寄到2，只查价' });
    const done = await f.finish(job.id); assert.equal(done.state, 'completed', JSON.stringify(done));
    assert.equal(done.id, job.id); assert(done.delegation?.agent?.completion); assert(!done.delegation?.plan);
    assert.deepEqual(f.calls.map(c => c.operation), ['get_address_list', 'get_address_list', 'get_address_info', 'get_address_info', 'delivery_preview']);
    assert.equal((f.calls.at(-1)!.input.sender as { lat: number }).lat, 40019368, 'Preserve CLI microdegrees without conversion');
    assert.equal((f.calls.at(-1)!.input.sender as { cityId: number }).cityId, 110100);
    const data = JSON.stringify(done.delegation!.agent); assert(!data.includes('PRIVATE_')); assert(!data.includes('13800000000')); assert(!data.includes('"addressId"'));
    assert.equal((done.artifact!.data.result as any).paotuiAnswer.totalPrice.minor, '1250');
    const graph = f.store.ontology, refs = done.delegation!.agent!.observations;
    for (const ref of refs) {
      assert(!JSON.stringify(graph.query(owner, { object: ref })).includes('PRIVATE_'));
      assert.throws(() => graph.query(owner, { object: ref, select: ['privateSnapshot'] }), /Restricted/);
      assert.throws(() => graph.query('other-owner', { object: ref }));
    }
    const quote = graph.query(owner, { type: 'DeliveryQuote' }).items[0]!;
    assert.equal(graph.evaluate(owner, { function: 'deliveryQuoteMatches', object: quote.ref, request: { type: 'ServiceRequest', id: job.id }, serviceLevel: 'ordinary' }).value, 'pass');
    assert(paotuiAgentEvidence(f.store, f.catalog, owner, done));
    const body = new NetworkEvidence(f.store.createNetworkStore(), f.store, f.catalog).resultSummary(owner, job.id);
    assert.equal(body.evidenceLevel, 'synthetic_validation'); assert.equal(body.outcome, 'query_completed'); assert.equal(Object.keys(body).length, 7); assert(!JSON.stringify(body).includes('PRIVATE_'));
  } finally { f.store.close(); }
  const b = setup(bookChoice, 'addresses'); try { const job = b.b.submit({ goal: '只看本人地址簿' }); assert.equal((await b.finish(job.id)).state, 'completed'); assert.deepEqual(b.calls.map(c => c.operation), ['get_address_list']); } finally { b.store.close(); }
});

test('model can choose named addresses and inspect details before preview; connector never chooses next action', async () => {
  const f = setup((ctx, access) => {
    const observations = observe(ctx, access), book = observations.find(o => o.summary.action === 'ReadSavedAddresses'), quote = observations.find(o => o.summary.action === 'PreviewDeliveryQuote');
    if (!book) return decide(ctx, [step('book', 'ReadSavedAddresses', { scope: ctx.state.scope })]);
    if (quote) return decide(ctx, [], { observation: quote.ref, rationale: 'Current preview' });
    const sender = observations.find(o => o.summary.role === 'sender'), recipient = observations.find(o => o.summary.role === 'recipient');
    if (!sender) return decide(ctx, [step('origin', 'ReadSavedAddressDetail', { scope: ctx.state.scope, book: book.ref, selector: '家里', role: 'sender' })]);
    if (!recipient) return decide(ctx, [step('destination', 'ReadSavedAddressDetail', { scope: ctx.state.scope, book: book.ref, selector: '公司', role: 'recipient' })]);
    return decide(ctx, [step('price', 'PreviewDeliveryQuote', { scope: ctx.state.scope, sender: sender.ref, recipient: recipient.ref, goodsName: '文件', category: '文件', weightKg: 1, service: 'ordinary' })]);
  });
  try { const job = f.b.submit({ goal: '从家里寄文件到公司，1公斤，普通送，只查价' }); const done = await f.finish(job.id); assert.equal(done.state, 'completed', JSON.stringify(done)); assert.deepEqual(f.calls.map(c => c.operation), ['get_address_list', 'get_address_info', 'get_address_info', 'delivery_preview']); assert.equal(done.delegation!.agent!.plans.length, 4); } finally { f.store.close(); }
});

test('changed address book invalidates old numeric choices and fresh connection revisions do not reuse them', async () => {
  const f = setup(); try {
    const job = f.b.submit({ goal }); await f.finish(job.id); f.flags.changedBook = true;
    f.b.tasks.reply(principal, { taskId: job.id, requestId: randomUUID(), answer: '1寄到2' });
    const paused = await f.finish(job.id); assert.equal(paused.state, 'input-required'); assert.equal(f.calls.filter(c => c.operation === 'delivery_preview').length, 0);
    assert.equal(f.calls.filter(c => c.operation === 'get_address_info').length, 0);
  } finally { f.store.close(); }
});

test('unread completion, invented selector, cross-task reference and write action are rejected before source calls', async () => {
  for (const mode of ['unread', 'invented', 'write', 'foreign'] as const) {
    const f = setup((ctx, access) => {
      const items = observe(ctx, access, mode !== 'unread');
      if (!items.length) return decide(ctx, [step('book', 'ReadSavedAddresses', { scope: ctx.state.scope })]);
      if (mode === 'unread') return decide(ctx, [], { observation: items[0]!.ref, rationale: 'Attempt without required evaluation' });
      return decide(ctx, [step('bad', mode === 'write' ? 'CreateOrder' : 'ReadSavedAddressDetail', { scope: ctx.state.scope, book: mode === 'foreign' ? { type: 'PaotuiObservation', id: 'other-task' } : items[0]!.ref, selector: 'invented address', role: 'sender' })]);
    }, mode === 'unread' ? 'addresses' : 'quote');
    try { const job = f.b.submit({ goal }); const result = await f.finish(job.id); assert.equal(result.state, 'input-required', mode); assert.deepEqual(f.calls.map(c => c.operation), ['get_address_list']); assert(!result.artifact); } finally { f.store.close(); }
  }
});

test('cancellation during a single read retains the observation ledger but cannot project a late response', async () => {
  const f = setup(bookChoice, 'addresses'); try {
    const job = f.b.submit({ goal: '读取地址簿' }); f.flags.before = async () => { f.b.tasks.cancel(principal, job.id); };
    await f.b.run(); await f.b.run(); const result = f.store.get(owner, job.id);
    assert.equal(result.state, 'canceled'); assert.equal(result.delegation!.agent!.observations.length, 0); assert.equal(f.store.ontology.query(owner, { type: 'PaotuiObservation' }).items.length, 0); assert(!result.artifact);
  } finally { f.store.close(); }
});

test('source/summary tampering removes historical query-card proof without leaking source details', async () => {
  const f = setup(bookChoice, 'addresses'); try {
    const job = f.b.submit({ goal: '地址簿查询' }), done = await f.finish(job.id); assert(paotuiAgentEvidence(f.store, f.catalog, owner, done));
    const ref = done.delegation!.agent!.observations[0]!, original = f.store.ontology.readPrivate(owner, ref);
    f.store.ontology.ingest(owner, { objects: [{ ref, expectedRevision: original.revision, properties: { ...original.properties, summary: { ...(original.properties.summary as object), count: 99 } } }] }, original.source);
    assert.equal(paotuiAgentEvidence(f.store, f.catalog, owner, done), undefined);
    assert.equal(new NetworkEvidence(f.store.createNetworkStore(), f.store, f.catalog).resultSummary(owner, job.id).evidenceLevel, 'insufficient_evidence');
  } finally { f.store.close(); }
});

test('missing parcel facts and a stale observation cannot be replaced by model defaults', async () => {
  const f = setup(); try {
    const job = f.b.submit({ goal: '查询文件费用，先让我选地址' }); await f.finish(job.id);
    f.b.tasks.reply(principal, { taskId: job.id, requestId: randomUUID(), answer: '1寄到2' });
    const result = await f.finish(job.id); assert.equal(result.state, 'input-required'); assert.equal(f.calls.filter(c => c.operation === 'delivery_preview').length, 0);
  } finally { f.store.close(); }
  const stale = setup(bookChoice, 'addresses'); try {
    const job = stale.b.submit({ goal: '地址簿查询' }); await stale.b.run(); await stale.b.run();
    const clock = stale.store.ontology.now; (stale.store.ontology as { now: () => number }).now = () => clock() + 300001;
    const result = await stale.finish(job.id); assert.equal(result.state, 'input-required'); assert(!result.artifact);
  } finally { stale.store.close(); }
});

test('lease loss drops late projection and a recovered claim does not replay an uncertain read', async () => {
  const f = setup(bookChoice, 'addresses'); try {
    const job = f.b.submit({ goal: '地址簿查询' }); await f.b.run();
    const claim = f.store.claim(['eigos.delegate'], 15000)!;
    f.flags.before = async () => { assert(f.store.renew(claim, 1, Date.now() - 100)); };
    await f.b.coordinator.run(claim, new AbortController().signal);
    assert.equal(f.store.ontology.query(owner, { type: 'PaotuiObservation' }).items.length, 0);
    const recovered = f.store.claim(['eigos.delegate'], 15000)!; assert(recovered); await f.b.coordinator.run(recovered, new AbortController().signal);
    assert.equal(f.calls.length, 1); assert.equal(f.store.get(owner, job.id).delegation!.agent!.observations.length, 0);
  } finally { f.store.close(); }
});

test('private choice labels survive provider reorder and another question, but never turn weight into a route', () => {
  const f = setup(); try {
    const choices = new PaotuiAddressSelection(f.store), job = f.b.submit({ goal }), request = job.delegation!.request;
    const addresses = [{ addressId: 'a', address: 'Private A', cityId: '1', lat: 1, lng: 1 }, { addressId: 'b', address: 'Private B', cityId: '1', lat: 2, lng: 2 }];
    choices.observe(owner, request, 'source-v1', addresses); choices.present(owner, request, 'source-v1');
    const answer = { id: randomUUID(), text: '1寄到2', receivedAt: new Date().toISOString() }, current = { ...request, revision: 2, messages: [...request.messages, answer] };
    choices.observe(owner, current, 'source-v1', [...addresses].reverse()); choices.present(owner, current, 'source-v1');
    assert.equal(choices.select(owner, current, 'source-v1', [...addresses].reverse(), '1', 'sender').addressId, 'a');
    assert.throws(() => choices.select(owner, { ...current, messages: [...request.messages, { ...answer, text: '重量1到2公斤' }] }, 'source-v1', addresses, '1', 'sender'));
    assert.throws(() => choices.select(owner, current, 'source-v2', addresses, '1', 'sender'));
  } finally { f.store.close(); }
});
