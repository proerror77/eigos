// In-process synthetic readers only; no CLI, model, PA account or real source.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { digest } from '../packages/core/delegation.js';
import { DomainError } from '../packages/core/domain.js';
import { PaotuiReadAdapter, PAOTUI_READ_BINDINGS, PAOTUI_READ_CAPABILITIES } from '../packages/capabilities/paotui-read.js';
import { ontologyReceiptSchema } from '../packages/capabilities/paotui-mcp-server.js';
import { backend, interpretation, reasoner, owner } from './backend-fixture.js';

const quoteInput = { senderAddressId: 'synthetic-a', recipientAddressId: 'synthetic-b', goodsName: '文件', category: '文件', weightKg: 1, service: 'ordinary' };
function runner(index: number, store = new JobStore(':memory:'), price: string | number = '16.80') {
  const input = index === 0 ? { city: '北京市', keyword: '合成地点' } : quoteInput;
  const capability = PAOTUI_READ_CAPABILITIES[index]!;
  let reads = 0;
  const adapter = new PaotuiReadAdapter(index, { query: async () => {
    reads++;
    const business = index === 0
      ? { source: 'meituan', readOnly: true, places: [{ poiId: 'synthetic-place', name: '同名合成地点', address: '合成公开位置', lat: 39.9, lng: 116.4, coordinateUnit: 'degree' }, { name: '同名合成地点' }] }
      : { source: 'meituan', previewOnly: true, orderCreated: false, goods: { name: '文件', category: '文件', weightKg: 1 }, service: 'ordinary', route: { sender: '合成寄件位置', recipient: '合成收件位置' }, quote: { _previewTotal: price } };
    const receipt = ontologyReceiptSchema.parse({ id: randomUUID(), transport: 'mcp-stdio', server: 'eigos-ontology', capabilityRef: capability.ref, ontologyRef: capability.ontologyRef,
      tool: index === 0 ? 'ontology_geo_search' : 'ontology_delivery_quote', evidenceKind: 'fixture', inputDigest: digest(input), resultDigest: digest(business),
      observedAt: new Date().toISOString(), sourceCalls: index === 0 ? ['search_poi'] : ['get_address_info', 'delivery_preview'], readOnly: true });
    return { ...business, ontologyReceipt: receipt };
  } });
  const catalog = new ExecutionCatalog([capability], [PAOTUI_READ_BINDINGS[index]!], [adapter]);
  return { ...backend(catalog, reasoner(r => ({ ...interpretation(r, capability.ref.id, input), capabilityRef: capability.ref })), store), reads: () => reads };
}

test('N1 current task projection persists quote applicability without new reads or repeated revisions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-n1-projection-')), path = join(directory, 'tasks.sqlite');
  const b = runner(1, new JobStore(path)); let reopened: JobStore | undefined;
  try {
    const submitted = b.submit({ goal: '合成1公斤文件普通送查价' });
    assert.equal(b.store.ontology.read(owner, { type: 'ServiceRequest', id: submitted.id }).properties.projectionState, 'request_only');
    const done = await b.run(); assert.equal(done.state, 'completed'); assert.equal(b.reads(), 2);
    const request = { type: 'ServiceRequest', id: done.id }, graph = b.store.ontology;
    const receiptId = ((done.artifact!.data.result as Record<string, unknown>).ontologyReceipt as { id: string }).id;
    const quote = graph.read(owner, { type: 'DeliveryQuote', id: receiptId });
    assert.equal(graph.query(owner, { from: request, link: 'offers' }).items.length, 2, 'Prepared and final source observations remain distinct');
    assert.equal(quote.ref.type, 'DeliveryQuote'); assert.equal(quote.source.kind, 'synthetic');
    assert.deepEqual(quote.properties.pricingTerms, { total: { minor: '1680', currency: 'CNY' }, scope: 'unknown', components: [] });
    assert.equal(graph.evaluate(owner, { function: 'deliveryQuoteMatches', object: quote.ref, request, serviceLevel: 'ordinary' }).value, 'pass');
    assert.equal(graph.evaluate(owner, { function: 'withinBudget', object: quote.ref, budget: { minor: '2000', currency: 'CNY' }, priceBasis: 'estimate' }).status, 'unknown');
    assert.equal(graph.query(owner, { from: quote.ref, link: 'sourceReceipts' }).items[0]!.properties.evidenceLevel, 'synthetic');
    const revision = graph.revision(owner), quoteBefore = graph.read(owner, quote.ref);
    b.store.save(owner, done); b.store.save(owner, done);
    assert.equal(graph.revision(owner), revision); assert.deepEqual(graph.read(owner, quote.ref), quoteBefore); assert.equal(b.reads(), 2);
    reopened = new JobStore(path);
    assert.deepEqual(reopened.ontology.read(owner, quote.ref), quoteBefore);
    assert.deepEqual(reopened.get(owner, done.id).artifact, done.artifact);
    assert.equal(reopened.ontology.query(owner, { type: 'Payment' }).items.length, 0);
    assert.equal(reopened.ontology.query(owner, { type: 'Order' }).items.length, 0);
  } finally { reopened?.close(); b.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('N1 public places keep source identity and receipt-local identity without becoming offers', async () => {
  const b = runner(0);
  try {
    b.submit(); const done = await b.run(); assert.equal(done.state, 'completed');
    const graph = b.store.ontology, request = { type: 'ServiceRequest', id: done.id };
    assert.equal(graph.read(owner, request).properties.projectionState, 'typed_result');
    const places = graph.query(owner, { type: 'Place' });
    assert.equal(places.items.length, 2); assert.notEqual(places.items[0]!.ref.id, places.items[1]!.ref.id);
    for (const place of places.items) assert.equal(graph.query(owner, { from: place.ref, link: 'sourceReceipts' }).items.length, 1);
    assert.equal(graph.query(owner, { type: 'Offer' }).items.length, 0);
    assert(graph.query(owner, { type: 'Provider' }).items.every(value => value.source.kind === 'task'), 'Configured read-provider identity is not source-verified supply');
    assert.equal(b.reads(), 1);
  } finally { b.store.close(); }
});

test('N2 preserves the existing numeric source-price contract when projecting exact minor units', async () => {
  const b = runner(1, new JobStore(':memory:'), 16.8);
  try {
    b.submit(); const done = await b.run(); assert.equal(done.state, 'completed');
    const receiptId = ((done.artifact!.data.result as Record<string, unknown>).ontologyReceipt as { id: string }).id;
    const object = b.store.ontology.read(owner, { type: 'DeliveryQuote', id: receiptId });
    assert.deepEqual((object.properties.pricingTerms as { total: unknown }).total, { minor: '1680', currency: 'CNY' });
    assert.equal(b.store.ontology.evaluate(owner, { function: 'deliveryQuoteMatches', object: object.ref, request: { type: 'ServiceRequest', id: done.id }, serviceLevel: 'ordinary' }).value, 'pass');
  } finally { b.store.close(); }
});

test('N1 invalid receipt projection is explicit and atomic while the canonical task remains readable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-n1-import-')), sourcePath = join(directory, 'source.sqlite'), baseline = join(directory, 'definition-baseline.sqlite');
  const source = runner(1, new JobStore(sourcePath));
  try {
    // Preserve the exact release identities while importing no task, source
    // objects or execution ledger. A task pin must never be rewritten merely
    // because the receiving fixture created its own random bootstrap IDs.
    const snapshot = new DatabaseSync(sourcePath);
    try { snapshot.prepare('VACUUM INTO ?').run(baseline); } finally { snapshot.close(); }
    source.submit(); const done = await source.run();
    for (const change of [
      (r: Record<string, unknown>) => { (r.ontologyReceipt as Record<string, unknown>).resultDigest = '0'.repeat(64); },
      (r: Record<string, unknown>) => { (r.ontologyReceipt as Record<string, unknown>).inputDigest = '0'.repeat(64); },
      (r: Record<string, unknown>) => { r.ontologyReceipt = { invalid: true }; },
      (r: Record<string, unknown>) => { (r.ontologyReceipt as Record<string, unknown>).sourceCalls = ['submit_order']; },
      (r: Record<string, unknown>) => {
        (r.goods as Record<string, unknown>).name = 'x'.repeat(501);
        const { ontologyReceipt, ...business } = r; (ontologyReceipt as Record<string, unknown>).resultDigest = digest(business);
      },
    ]) {
      const importedPath = join(directory, `import-${randomUUID()}.sqlite`);
      copyFileSync(baseline, importedPath);
      const store = new JobStore(importedPath);
      try {
        const copy = structuredClone(done); change(copy.artifact!.data.result as Record<string, unknown>);
        store.save(owner, copy);
        assert.deepEqual(store.get(owner, copy.id), copy);
        assert.equal(store.ontology.read(owner, { type: 'ServiceRequest', id: copy.id }).properties.projectionState, 'invalid_source');
        for (const type of ['DeliveryQuote', 'Parcel', 'DeliveryRoute', 'SourceReceipt', 'Provider']) assert.deepEqual(store.ontology.query(owner, { type }).items, []);
        for (const type of ['ExecutionPlan', 'ExecutionInput', 'Authorization']) assert.deepEqual(store.ontology.query(owner, { type }).items, [], 'Invalid imported source cannot reconstruct execution or authority');
        assert.equal(store.intents(owner, copy.id).length, 0);
      } finally { store.close(); }
    }
    const plansBefore = source.store.ontology.query(owner, { type: 'ExecutionPlan' }).items;
    const inputsBefore = source.store.ontology.query(owner, { type: 'ExecutionInput' }).items;
    const damaged = structuredClone(done);
    (damaged.artifact!.data.result as { ontologyReceipt: { resultDigest: string } }).ontologyReceipt.resultDigest = '0'.repeat(64);
    source.store.save(owner, damaged);
    assert.equal(source.store.ontology.read(owner, { type: 'ServiceRequest', id: done.id }).properties.projectionState, 'invalid_source');
    assert.deepEqual(source.store.ontology.query(owner, { type: 'ExecutionPlan' }).items, plansBefore);
    assert.deepEqual(source.store.ontology.query(owner, { type: 'ExecutionInput' }).items, inputsBefore, 'Invalid later source does not rewrite earlier valid execution evidence');
  } finally { source.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('N1 task and graph writes roll back together, isolate owners and do not reinterpret historical tasks', () => {
  const b = runner(1);
  try {
    const job = b.store.get(owner, b.submit().id), request = { type: 'ServiceRequest', id: job.id };
    assert.throws(() => b.store.save('other-owner', job), /owner mismatch/);
    assert.deepEqual(b.store.ontology.query('other-owner', { type: 'ServiceRequest' }).items, []);
    const before = b.store.ontology.read(owner, request), copy = structuredClone(job); copy.state = 'canceled';
    const ingest = b.store.ontology.ingest;
    b.store.ontology.ingest = () => { throw new DomainError('CONFLICT', 'Synthetic storage conflict'); };
    assert.throws(() => b.store.save(owner, copy), /storage conflict/);
    b.store.ontology.ingest = ingest;
    assert.deepEqual(b.store.get(owner, job.id), job); assert.deepEqual(b.store.ontology.read(owner, request), before);
    const old = structuredClone(job); old.id = randomUUID(); Object.assign(old.delegation!, { backendVersion: 'ontology-execution-v2' });
    b.store.save(owner, old);
    assert.equal(b.store.get(owner, old.id).delegation!.backendVersion, 'ontology-execution-v2');
    assert.equal(b.store.ontology.query(owner, { type: 'ServiceRequest', where: [{ property: 'requestId', op: 'eq', value: old.id }] }).items.length, 0);
  } finally { b.store.close(); }
});
