import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { DOCUMENT_CAPABILITY } from '../packages/capabilities/document.js';
import { PaotuiReadAdapter, PAOTUI_READ_BINDINGS, PAOTUI_READ_CAPABILITIES } from '../packages/capabilities/paotui-read.js';
import { CSV_CAPABILITY, CSV_BINDING, CsvAuditAdapter } from '../packages/capabilities/csv-audit.js';
import { CSV_CHECKS } from '../packages/ontology/csv-audit.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { digest } from '../packages/core/delegation.js';
import { validatePlan } from '../packages/coordinator/plan.js';
import { checkRequirements } from '../packages/coordinator/resolver.js';
import type { Executor } from '../packages/capabilities/executor.js';
import { backend, principal, owner, interpretation, reasoner } from './backend-fixture.js';

test('document generation uses the common action runtime, resumes the same task and verifies draft scope', async () => {
  const seen: string[][] = [];
  const executor: Executor = { run: async job => {
    seen.push(job.messages.filter(m => m.role === 'user').map(m => m.text));
    return { output: job.messages.some(m => m.text === '100字以内') ? { decision: 'complete', message: 'Draft ready', artifact: '# 工作坊草稿\n\n这是基于用户资料的文档草稿。' } : { decision: 'ask_user', message: '希望草稿多长？', artifact: '' },
      evidence: { id: randomUUID(), runtime: 'document-test-fixture', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), outputSha256: digest('fixture') } };
  } };
  const catalog = createExecutionCatalog({ documentEnabled: true, documentExecutor: executor });
  const b = backend(catalog, reasoner(r => ({ ...interpretation(r, DOCUMENT_CAPABILITY.ref.id, { format: 'markdown' }), capabilityRef: DOCUMENT_CAPABILITY.ref })));
  try {
    const original = b.submit({ goal: '请写一份工作坊文档草稿' }); const asked = await b.run(); assert.equal(asked.state, 'input-required'); assert(asked.delegation!.pendingActionInput);
    b.tasks.reply(principal, { taskId: original.id, answer: '100字以内', requestId: 'answer' }); const done = await b.run();
    assert.equal(done.id, original.id); assert.equal(done.state, 'completed'); assert(done.artifact!.data.markdown!.includes('工作坊'));
    assert(seen[1]!.includes('100字以内')); assert.equal(done.runs!.filter(r => r.purpose === 'document').length, 2); assert.equal(done.runs!.length, 4);
    assert.equal(b.store.intents(owner, done.id).length, 1); assert.equal(b.store.attempts(owner, done.delegation!.intentId!)[1]!.kind, 'resume');
    const facts = b.store.capabilityFacts(owner, done.delegation!.plan!.bindingRef); assert.equal(facts.summary.evidenceLevelCounts.model_generated, 1); assert.equal(facts.summary.automaticPromotion, false);
  } finally { b.store.close(); }
});

test('Paotui read capabilities preserve private preparation and execute through the ontology backend', async () => {
  const calls: string[] = [];
  const result = { source: 'meituan', previewOnly: true, orderCreated: false, goods: { name: '文件', category: '文件', weightKg: 1 }, service: 'ordinary', route: { sender: 'PRIVATE_ADDRESS_MARKER', recipient: '另一处授权地址' }, quote: { _previewTotal: '52.50', estimateTime: '预计时间' } };
  const reader = { query: async (q: { action: string }) => { calls.push(q.action); return result; } };
  const cap = PAOTUI_READ_CAPABILITIES[1]!; const adapter = new PaotuiReadAdapter(1, reader);
  const catalog = new ExecutionCatalog([cap], [PAOTUI_READ_BINDINGS[1]!], [adapter]);
  const b = backend(catalog, reasoner(r => ({ ...interpretation(r, cap.ref.id, { senderAddressId: 'a', recipientAddressId: 'b', goodsName: '文件', category: '文件', weightKg: 1, service: 'ordinary' }), capabilityRef: cap.ref }), ctx => {
    assert(!JSON.stringify(ctx).includes('PRIVATE_ADDRESS_MARKER'));
    const candidate = ctx.resolution.candidates[0]!;
    return { kind: 'propose_plan', requestRevision: ctx.request.revision, candidateId: candidate.id, message: 'Read-only quote', steps: [{ id: 'quote', actionTypeRef: cap.actions[0]!.ref, bindingRef: candidate.binding.ref, inputJson: JSON.stringify(candidate.input), dependsOn: [] }] };
  }));
  try {
    b.submit({ goal: '查询本人地址间文件配送报价' }); const done = await b.run(); assert.equal(done.state, 'completed'); assert.equal((done.artifact!.data.result as { orderCreated: boolean }).orderCreated, false);
    assert.deepEqual(calls, ['preview', 'preview']); assert.throws(() => b.tasks.get({ ...principal, subject: 'other' }, done.id), /not found/);
    assert.deepEqual(catalog.summaries('other'), []);
  } finally { b.store.close(); }
});

test('same-version provider/definition drift and recomputed plan tampering cannot reuse an approved quote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-pinning-')); writeFileSync(join(dir, 'sample.csv'), 'record_id,email,amount_cny,event_date\nA,a@example.test,1,2026-10-17\n');
  const catalog = createExecutionCatalog({ csvInputDirectory: dir }); const b = backend(catalog, reasoner(r => ({ ...interpretation(r, CSV_CAPABILITY.ref.id, { fileName: 'sample.csv', checks: [...CSV_CHECKS] }), capabilityRef: CSV_CAPABILITY.ref })));
  try {
    b.submit(); const offered = await b.run(); const plan = offered.delegation!.plan!;
    const switched = new ExecutionCatalog([CSV_CAPABILITY], [{ ...CSV_BINDING, providerId: 'different-provider' }], [new CsvAuditAdapter(dir)]);
    assert.throws(() => validatePlan(switched, owner, offered.delegation!.request, plan, b.store.ontologyForJob(owner, offered).model.ref), /Pinned provider/);
    const changed = new ExecutionCatalog([{ ...CSV_CAPABILITY, completion: 'delivery' }], [CSV_BINDING], [new CsvAuditAdapter(dir)]);
    assert.throws(() => validatePlan(changed, owner, offered.delegation!.request, plan, b.store.ontologyForJob(owner, offered).model.ref), /Pinned capability/);
    plan.steps[0]!.input.fileName = 'different.csv'; const { digest: _old, ...body } = plan; plan.digest = digest(body); b.store.save(owner, offered);
    assert.throws(() => b.tasks.authorize(principal, offered.id, { requestId: 'old-quote', action: 'confirm_simulated_payment', quoteId: plan.quote!.id, quoteDigest: plan.quote!.digest }), /Quote is not bound/);
  } finally { b.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('search-area checks cannot be used as a guaranteed delivery destination or a different city', () => {
  const req = { id: randomUUID(), revision: 1, originalGoal: '上海市虹桥火车站附近只查询报价', messages: [], requirements: [{ id: 'scope', kind: 'location' as const, strength: 'hard' as const, expected: { ref: '上海市虹桥火车站附近' }, provenance: { source: 'pa' as const, interpretation: 'structured' as const, messageId: 'm', receivedAt: new Date().toISOString() } }] };
  const facts = { searchArea: { city: '上海市', keyword: '虹桥火车站' } };
  assert.equal(checkRequirements(req, facts, ['provider-search-receipt'], [], 'search_area')[0]!.result, 'pass');
  assert.equal(checkRequirements(req, facts, ['provider-search-receipt'], [], 'destination')[0]!.result, 'unknown');
  req.requirements[0]!.expected.ref = '北京市虹桥火车站附近'; assert.equal(checkRequirements(req, facts, ['provider-search-receipt'], [], 'search_area')[0]!.result, 'unknown');
});

test('a city-only requirement is checked as query scope only for search-area capabilities', () => {
  const req = { id: randomUUID(), revision: 1, originalGoal: '查询北京市的公开地点，关键词天安门', messages: [], requirements: [{ id: 'city-scope', kind: 'location' as const, strength: 'hard' as const, expected: { ref: '北京市' }, provenance: { source: 'pa' as const, interpretation: 'structured' as const, messageId: 'm', receivedAt: new Date().toISOString() } }] };
  const facts = { searchArea: { city: '北京市', keyword: '天安门' } };
  for (const ref of ['北京市', '北京']) {
    req.requirements[0]!.expected.ref = ref;
    assert.equal(checkRequirements(req, facts, ['query-receipt'], [], 'search_area')[0]!.result, 'pass');
    assert.equal(checkRequirements(req, facts, ['query-receipt'], [], 'destination')[0]!.result, 'unknown');
    assert.equal(checkRequirements(req, facts, ['query-receipt'])[0]!.result, 'unknown');
    assert.equal(checkRequirements(req, facts, [], [], 'search_area')[0]!.result, 'unknown');
  }
  for (const ref of ['上海市', '北京市故宫']) {
    req.requirements[0]!.expected.ref = ref;
    assert.equal(checkRequirements(req, facts, ['query-receipt'], [], 'search_area')[0]!.result, 'unknown');
  }
  assert.equal(PAOTUI_READ_CAPABILITIES[0]!.locationSemantics, 'search_area');
  assert.equal(PAOTUI_READ_CAPABILITIES[1]!.locationSemantics, undefined);
});
