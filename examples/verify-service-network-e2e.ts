// Opt-in, real Codex + official read-only MCD + authenticated loopback sandbox E2E.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Job } from '../packages/core/domain.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import { digest } from '../packages/core/delegation.js';

if (!process.argv.includes('--live')) throw new Error('Real model/provider reads require --live');
const mcdTokenFile = process.env.EIGOS_MCD_TOKEN_FILE;
if (!mcdTokenFile || !isAbsolute(mcdTokenFile)) throw new Error('Set EIGOS_MCD_TOKEN_FILE to the existing private authorized credential file');
const dir = mkdtempSync(join(tmpdir(), 'eigos-live-network-')); const output = resolve('data/service-network-e2e', new Date().toISOString().replaceAll(':', '-')); mkdirSync(output, { recursive: true, mode: 0o700 });
const tokens = Object.fromEntries(['gateway', 'provider', 'control'].map(name => [name, randomUUID() + randomUUID()])); const files: Record<string, string> = {};
for (const [name, token] of Object.entries(tokens)) { files[name] = join(dir, name + '.token'); writeFileSync(files[name]!, token, { mode: 0o600 }); }
const processes: ChildProcess[] = [];
async function start(file: string, env: NodeJS.ProcessEnv) {
  const process = spawn(globalThis.process.execPath, [resolve('dist/tests/fixtures', file + '.js')], { env: { PATH: globalThis.process.env.PATH, HOME: globalThis.process.env.HOME, USER: globalThis.process.env.USER, TMPDIR: globalThis.process.env.TMPDIR, NODE_NO_WARNINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); processes.push(process);
  let stderr = ''; process.stderr!.on('data', data => { stderr = (stderr + data.toString()).slice(-16000); });
  return new Promise<{ port?: number }>((done, reject) => { let text = ''; const timer = setTimeout(() => reject(new Error('E2E process did not become ready')), 15000);
    process.stdout!.on('data', data => { text += data; const lines = text.split('\n'); text = lines.pop()!; for (const line of lines) { try { const value = JSON.parse(line); clearTimeout(timer); done(value); } catch { /* Runtime commentary. */ } } });
    process.once('exit', code => { clearTimeout(timer); reject(new Error(`E2E process exited before readiness (${code}): ${stderr}`)); }); });
}
async function stop(child: ChildProcess) { if (child.exitCode !== null || child.signalCode !== null) return; const done = new Promise<void>(r => child.once('exit', () => r())); child.kill('SIGTERM'); await done; }
const transcript: unknown[] = []; const results: { scenario: string; task: Job }[] = [];
const codeFiles = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? codeFiles(join(path, entry.name)) : entry.name.endsWith('.js') ? [join(path, entry.name)] : []);
const implementationFiles = [...codeFiles('dist/apps'), ...codeFiles('dist/packages'), ...['business-provider', 'ontology-gateway', 'live-worker'].map(name => `dist/tests/fixtures/${name}.js`)].sort();
const implementationSnapshot = { capturedAt: new Date().toISOString(), fileCount: implementationFiles.length, digest: digest(implementationFiles.map(path => ({ path, digest: digest(readFileSync(path, 'utf8')) }))) };
const mcp = new Client({ name: 'eigos-live-network-e2e', version: '3' });
try {
  const provider = await start('business-provider', { PROVIDER_DATABASE: join(dir, 'provider.sqlite'), PROVIDER_TOKEN_FILE: files.provider, PROVIDER_CONTROL_TOKEN_FILE: files.control }); const providerUrl = `http://127.0.0.1:${provider.port}`;
  const common = { EIGOS_AUTH_MODE: 'development', HOST: '127.0.0.1', EIGOS_COORDINATOR: 'codex', EIGOS_EXECUTOR: 'disabled', EIGOS_ACTION_SANDBOX: 'true', EIGOS_SANDBOX_PROVIDER_URL: providerUrl, EIGOS_SANDBOX_TOKEN_FILE: files.provider, EIGOS_MCD_TOKEN_FILE: mcdTokenFile, DATABASE_PATH: join(dir, 'tasks.sqlite'), EIGOS_CODEX_BIN: process.env.EIGOS_CODEX_BIN ?? 'codex', EIGOS_EXECUTOR_TIMEOUT_MS: '120000' };
  const gateway = await start('ontology-gateway', { ...common, GATEWAY_TOKEN_FILE: files.gateway }); const base = `http://127.0.0.1:${gateway.port}`;
  await start('live-worker', { ...common, PUBLIC_URL: base });
  const headers = { Authorization: `Bearer ${tokens.gateway}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
  await mcp.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: headers.Authorization } } }));
  const rpc = async (method: string, params: object) => { const r = await fetch(base + '/a2a', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) }); const body = await r.json(); assert(r.ok && !body.error, JSON.stringify(body)); return body.result.task ?? body.result; };
  const read = async (id: string) => { const r = await mcp.callTool({ name: 'get_task', arguments: { taskId: id } }); assert(!r.isError); return (r.structuredContent as { result: Job }).result; };
  const wait = async (id: string, condition: (job: Job) => boolean) => { const deadline = Date.now() + 290000; while (Date.now() < deadline) { const j = await read(id); if (condition(j)) return j; await new Promise(r => setTimeout(r, 500)); } throw new Error('E2E wait timed out; inspect the existing task instead of replaying effects'); };
  const send = async (goal: string, extra: object = {}) => { const task = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', goal, ...extra } }] } }); return task.id as string; };
  const paused = (j: Job) => !['working', 'submitted'].includes(j.state);
  const quantity = { id: 'quantity', kind: 'quantity', strength: 'hard', expected: { amount: '20', unit: '杯' } };
  const budget = { id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '50000', currency: 'CNY' } };
  console.log('Live MCD comparison submitted');
  const mcdId = await send('只查询并比较上海市虹桥火车站附近麦当劳20杯美式咖啡到店自取的当前报价，总预算500元。允许比较不同规格，注明实际默认配置和未知项，最多查询5家门店。选出当前已查范围内的报价方案。不下单、不付款。', { requirements: [quantity, budget, { id: 'read_only', kind: 'condition', strength: 'hard', expected: { predicate: 'execution.no_order' } }] });
  const mcd = await wait(mcdId, paused); transcript.push({ scenario: 'official_mcd_read', task: mcd }); assert.equal(mcd.state, 'completed', JSON.stringify(mcd));
  assert.equal(mcd.delegation!.backendVersion, BACKEND_VERSION); assert.equal(mcd.delegation!.plan!.capabilityRef.id, 'food.pickup.compare'); assert(mcd.delegation!.resolution!.scope.realSupply);
  assert(mcd.delegation!.resolution!.comparison!.merchantGroups.length >= 2, 'This live comparison needs at least two observed real stores; never invent supply');
  const mcdResult = mcd.artifact!.data.result as { orderCreated: boolean; paymentConfirmed: boolean; deliveryConfirmed: boolean };
  assert.equal(mcdResult.orderCreated, false); assert.equal(mcdResult.paymentConfirmed, false); assert.equal(mcdResult.deliveryConfirmed, false);
  results.push({ scenario: 'official_mcd_read', task: mcd }); console.log(JSON.stringify({ scenario: 'official_mcd_read', state: mcd.state, stores: mcd.delegation!.resolution!.comparison!.merchantGroups.length }));
  console.log('Real purchase boundary submitted');
  const unsupportedId = await send('请实际购买20杯咖啡并配送给我，预算500元。需要真实购买和送达，不要测试、模拟、报价或任务说明。', { requirements: [quantity, budget] });
  const unsupported = await wait(unsupportedId, paused); transcript.push({ scenario: 'real_purchase_boundary', task: unsupported }); assert.equal(unsupported.state, 'rejected', JSON.stringify(unsupported)); assert.equal(unsupported.artifact, undefined); assert.equal(unsupported.delegation!.intentId, undefined); results.push({ scenario: 'real_purchase_boundary', task: unsupported });
  console.log('Live-model sandbox workflow submitted');
  const sandboxId = await send('请在已配置的本机沙箱中实际运行20杯测试商品服务，模拟付款预算500元，并最终核验完整交付。只使用沙箱，不运行真实商家订单或真实资金，不是写任务说明。', { executionEnvironment: 'sandbox', requirements: [quantity, budget, { id: 'sandbox_only', kind: 'condition', strength: 'hard', expected: { predicate: 'environment.sandbox' } }, { id: 'delivered', kind: 'condition', strength: 'hard', expected: { predicate: 'delivery.confirmed' } }] });
  const offered = await wait(sandboxId, paused); transcript.push({ scenario: 'sandbox_plan', task: offered }); assert.equal(offered.state, 'auth-required', JSON.stringify(offered)); assert.equal(offered.delegation!.plan!.steps.length, 3);
  const scope = offered.delegation!.authorizationRequest!; const approval = { action: 'approve_plan', requestId: randomUUID(), planDigest: scope.planDigest, allowedEffects: scope.effects, maxAmount: scope.maxAmount, payeeIds: scope.payeeIds, expiresAt: new Date(Date.now() + 120000).toISOString(), environment: 'sandbox' };
  const approved = await fetch(base + `/tasks/${sandboxId}/authorize`, { method: 'POST', headers, body: JSON.stringify(approval) }); assert(approved.ok);
  const control = async (path: string, body?: object) => { const r = await fetch(providerUrl + '/_control/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tokens.control}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); assert(r.ok); return r.json(); };
  let ledger: any; const paidDeadline = Date.now() + 30000;
  while (Date.now() < paidDeadline) { ledger = await control('ledger'); if (ledger.counters.charges === 1) break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(ledger?.counters.charges, 1); const beforeDelivery = await read(sandboxId); assert.notEqual(beforeDelivery.state, 'completed'); assert.equal(beforeDelivery.artifact, undefined);
  await control('advance', { orderId: ledger.orders[0].id, fulfillment: 'delivered' }); const sandbox = await wait(sandboxId, paused);
  transcript.push({ scenario: 'sandbox_delivery', beforeDelivery, task: sandbox }); assert.equal(sandbox.state, 'completed', JSON.stringify(sandbox)); assert.equal(sandbox.delegation!.outcome!.status, 'satisfied');
  ledger = await control('ledger'); assert.equal(ledger.counters.ordersCreated, 1); assert.equal(ledger.counters.charges, 1); assert.equal(ledger.counters.orderPostCalls, 1); assert.equal(ledger.counters.payPostCalls, 1);
  const a2a = await rpc('GetTask', { id: sandboxId }); assert.equal(a2a.status.state, 'TASK_STATE_COMPLETED'); assert.equal(digest(a2a.artifacts[0].parts[0].data), digest(sandbox.artifact!.data));
  transcript.push({ scenario: 'sandbox_provider_ledger', ledger }); results.push({ scenario: 'live_model_sandbox', task: sandbox }); console.log(JSON.stringify({ scenario: 'live_model_sandbox', state: sandbox.state, counters: ledger.counters }));
} finally {
  const summary = results.map(({ scenario, task }) => ({ scenario, taskId: task.id, state: task.state, requestEnvironment: task.delegation!.request.executionEnvironment, capabilityRef: task.delegation!.plan?.capabilityRef, planDigest: task.delegation!.plan?.digest,
    modelReceipts: task.runs, outcome: task.delegation!.outcome, offers: task.delegation!.resolution?.comparison?.offers, coverage: task.delegation!.resolution?.scope }));
  const report = JSON.stringify({ backendVersion: BACKEND_VERSION, implementationSnapshot, evidenceScope: 'Real Codex reasoning + official MCD read-only supply + separately labeled loopback sandbox effects; no real merchant order or payment', summary, transcript }, null, 2);
  try {
    if ([...Object.values(tokens), readFileSync(mcdTokenFile, 'utf8').trim()].some(token => token && report.includes(token))) throw new Error('Credential found in output; refusing evidence export');
    writeFileSync(join(output, 'verification.json'), report, { mode: 0o600 }); console.log('Evidence directory:', output);
  } finally { await mcp.close().catch(() => {}); for (const process of [...processes].reverse()) await stop(process); rmSync(dir, { recursive: true, force: true }); }
}
