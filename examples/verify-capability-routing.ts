// Opt-in live-model verification in an isolated loopback backend. No deployment or transactions.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/gateway/app.js';
import { createWorker } from '../apps/worker/runtime.js';
import { readConfig } from '../packages/core/config.js';
import { BACKEND_VERSION, type ServiceCapability, type ServiceRequest, type CandidateFacts } from '../packages/ontology/execution.js';
import { ExecutionCatalog, type ExecutionAdapter } from '../packages/core/catalog.js';
import { CodexReasoner } from '../packages/coordinator/coordinator.js';
import { CodexExecutor } from '../packages/capabilities/executor.js';
import { CapabilityResolver } from '../packages/coordinator/resolver.js';
import { proposePlan } from '../packages/coordinator/plan.js';

if (!process.argv.includes('--live')) throw new Error('Live model calls require --live');
const directory = mkdtempSync(join(tmpdir(), 'eigos-live-v2-'));
writeFileSync(join(directory, 'sample.csv'), 'record_id,email,amount_cny,event_date\nA,broken,-1,2026-02-30\nA,a@example.test,2,2026-10-17\n');
const output = resolve('data/ontology-backend-live', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(output, { recursive: true, mode: 0o700 });
const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
const token = randomUUID() + randomUUID();
const config = readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, PUBLIC_URL: base, PORT: String(address.port), DATABASE_PATH: join(directory, 'tasks.sqlite'),
  EIGOS_COORDINATOR: 'codex', EIGOS_CSV_PILOT: 'true', EIGOS_CSV_INPUT_DIR: directory,
  EIGOS_CODEX_BIN: process.env.EIGOS_CODEX_BIN ?? 'codex', EIGOS_EXECUTOR_TIMEOUT_MS: '120000' });
const gateway = createApp(config); server.on('request', gateway.app); const worker = createWorker(config, { store: gateway.store });
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
const transcript: unknown[] = []; const summary: unknown[] = [];
async function rpc(method: string, params: object) {
  const request = { jsonrpc: '2.0', id: randomUUID(), method, params };
  const response = await fetch(base + '/a2a', { method: 'POST', headers, body: JSON.stringify(request) }); const body = await response.json();
  assert(response.ok && !body.error, JSON.stringify(body)); return body.result.task ?? body.result;
}
async function settle(id: string) {
  const deadline = Date.now() + 290000;
  while (Date.now() < deadline) {
    const task = await rpc('GetTask', { id }); if (!['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(task.status.state)) return task;
    await delay(1000);
  }
  throw new Error('Live model deadline exceeded; inspect the original task instead of replaying it');
}
const scenarios = [
  { name: 'brief', capability: 'brief.prepare', goal: '请生成一份JSON任务说明。说明中的业务目标是将来比较供应商，交付标准是记录价格、产能与资料来源要求。本次只整理任务说明。' },
  { name: 'csv', capability: 'data.quality.audit.simulated', goal: '请实际审计 sample.csv，执行全部已注册的五项规则，交付完整审计报告。不是只编写一份任务说明。' },
  { name: 'unsupported', capability: null, goal: '请实际购买咖啡并配送给我。我要真实购买和送达。' },
  { name: 'subset', capability: null, goal: '请只审计 sample.csv 的 invalid_email，不能执行其他检查，也不能改成全量审计。' },
];
try {
  for (const scenario of process.argv.includes('--providers-only') ? [] : scenarios) {
    console.log(JSON.stringify({ scenario: scenario.name, progress: 'submitted' }));
    const task = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: scenario.goal }] } });
    let result = await settle(task.id);
    transcript.push({ scenario, initialResult: result });
    assert.equal(result.metadata.delegation.backendVersion, BACKEND_VERSION);
    if (scenario.name === 'csv') {
      assert.equal(result.status.state, 'TASK_STATE_AUTH_REQUIRED', JSON.stringify(result));
      const quote = result.metadata.delegation.plan.quote;
      assert.equal(quote.environment, 'local_simulation'); assert.deepEqual(quote.amount, { minor: '100', currency: 'CNY' });
      const approval = { requestId: randomUUID(), action: 'confirm_simulated_payment', quoteId: quote.id, quoteDigest: quote.digest };
      const response = await fetch(base + `/tasks/${task.id}/authorize`, { method: 'POST', headers, body: JSON.stringify(approval) }); assert(response.ok);
      result = await settle(task.id);
    }
    if (scenario.capability) {
      assert.equal(result.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(result));
      assert.equal(result.metadata.delegation.plan.capabilityRef.id, scenario.capability); assert(result.metadata.delegation.acceptance.accepted);
    } else {
      assert(['TASK_STATE_REJECTED', ...(scenario.name === 'subset' ? ['TASK_STATE_INPUT_REQUIRED'] : [])].includes(result.status.state), JSON.stringify(result));
      assert.equal(result.artifacts?.length ?? 0, 0); assert.equal(result.metadata.delegation.intentId, undefined);
    }
    if (scenario.name === 'brief') assert.equal(result.artifacts[0].parts[0].data.execution, 'not_started');
    assert.equal(result.metadata.pilot, undefined);
    assert(result.metadata.runs.length > 0 && result.metadata.runs.every((r: { runtime: string; threadId?: string }) => r.runtime === 'codex-exec' && r.threadId));
    const row = { scenario: scenario.name, taskId: result.id, state: result.status.state, capabilityRef: result.metadata.delegation.plan?.capabilityRef ?? null,
      bindingRef: result.metadata.delegation.plan?.bindingRef ?? null, modelRuns: result.metadata.runs.length, acceptance: result.metadata.delegation.acceptance ?? null, receipts: result.metadata.runs };
    transcript.push({ scenario, result }); summary.push(row); console.log(JSON.stringify({ scenario: scenario.name, state: result.status.state, modelRuns: result.metadata.runs.length }));
  }
  const capability: ServiceCapability = { ref: { id: 'fixture.supply-proposal', version: '2' }, ontologyRef: { id: 'fixture.supply', version: '2' }, name: 'Synthetic supply planning',
    description: 'Test-only proposal using synthetic supplier facts. Never place an order or claim delivery.', tags: ['synthetic'], inputSchema: { type: 'object' }, ontology: { objects: ['SyntheticOffer'], evidenceScope: 'Fixture data only; planning validation, not real supply' },
    actions: [{ ref: { id: 'read_proposal', version: '2' }, effect: 'read' }], predicates: [], verifierRef: { id: 'fixture.proposal', version: '2' } };
  const supplies: { id: string; facts: CandidateFacts }[] = [
    { id: 'fixture.cheap-late', facts: { quantity: { amount: '20', unit: '杯' }, totalPrice: { minor: '30000', currency: 'CNY' }, deliveryBy: '2026-10-18T09:30:00+08:00' } },
    { id: 'fixture.on-time', facts: { quantity: { amount: '20', unit: '杯' }, totalPrice: { minor: '45000', currency: 'CNY' }, deliveryBy: '2026-10-18T08:30:00+08:00' } },
    { id: 'fixture.unknown-capacity', facts: { totalPrice: { minor: '20000', currency: 'CNY' }, deliveryBy: '2026-10-18T08:00:00+08:00' } },
  ];
  const adapters: ExecutionAdapter[] = supplies.map(s => ({ id: s.id, permitted: () => true,
    prepare: async () => ({ kind: 'ready', input: {}, details: { environment: 'synthetic' }, facts: s.facts, evidenceRefs: ['synthetic:' + s.id], observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() }),
    execute: async () => { throw new Error('Planning-only fixture must never dispatch'); }, verify: () => ({ accepted: false, reason: 'No fixture dispatch permitted' }) }));
  const catalog = new ExecutionCatalog([capability], supplies.map(s => ({ ref: { id: s.id, version: '2' }, capabilityRef: capability.ref, providerId: s.id, channelId: 'synthetic', adapterId: s.id,
    protocol: 'local', enabled: true, verification: { level: 'local_test', evidenceRefs: ['synthetic-fixture'] }, recovery: { idempotency: 'none', lookup: false } })), adapters);
  const now = new Date().toISOString();
  const request: ServiceRequest = { id: randomUUID(), revision: 1, originalGoal: '选择满足20杯、500元、2026-10-18上午9点前条件的合成供给方案；只验证规划，不下单。', messages: [],
    requirements: [
      { id: 'cups', kind: 'quantity', strength: 'hard', expected: { amount: '20', unit: '杯' }, provenance: { source: 'pa', interpretation: 'structured', messageId: 'fixture', receivedAt: now } },
      { id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '50000', currency: 'CNY' }, provenance: { source: 'pa', interpretation: 'structured', messageId: 'fixture', receivedAt: now } },
      { id: 'deadline', kind: 'deadline', strength: 'hard', expected: { at: '2026-10-18T09:00:00+08:00', timezone: 'Asia/Shanghai', original: '2026-10-18上午9点前' }, provenance: { source: 'pa', interpretation: 'structured', messageId: 'fixture', receivedAt: now } },
    ] };
  const resolution = await new CapabilityResolver(catalog).resolve({ owner: 'fixture', request }, capability.ref, {}, new AbortController().signal);
  console.log(JSON.stringify({ scenario: 'providers', progress: 'planning' }));
  const planned = await new CodexReasoner(new CodexExecutor(config.EIGOS_CODEX_BIN, 120000)).plan({ request, capability, resolution: { candidates: resolution.candidates, scope: resolution.scope } }, new AbortController().signal);
  const selected = resolution.candidates.find(c => c.id === planned.decision.candidateId); assert(selected);
  const plan = proposePlan(catalog, 'fixture', request, capability, selected, planned.decision); assert.equal(plan.bindingRef.id, 'fixture.on-time');
  const row = { scenario: 'providers', state: 'PLAN_VALIDATED', bindingRef: plan.bindingRef, modelRuns: 1, receipts: [planned.evidence], summary: planned.decision.message };
  summary.push(row); transcript.push({ scenario: 'providers', request, candidates: resolution.candidates, proposal: planned.decision, plan }); console.log(JSON.stringify(row));
} finally {
  const text = JSON.stringify({ backendVersion: BACKEND_VERSION, evidenceScope: 'Live Codex decisions, synthetic CSV, local adapters; no real merchant, payment, deployment or fulfillment', summary, transcript }, null, 2);
  assert(!text.includes(token)); writeFileSync(join(output, 'verification.json'), text, { mode: 0o600 }); console.log('Evidence directory:', output);
  await worker.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await gateway.close(); rmSync(directory, { recursive: true, force: true });
}
