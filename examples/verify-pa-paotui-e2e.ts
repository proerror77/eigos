// Opt-in live harness. It observes a real PA submission; it never submits on the PA's behalf.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Job } from '../packages/core/domain.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import { digest } from '../packages/core/delegation.js';
import { paotuiPreviewSchema } from '../packages/capabilities/paotui-contracts.js';
import { ontologyReceiptSchema } from '../packages/capabilities/paotui-mcp-server.js';

if (!process.argv.includes('--live')) throw new Error('Live PA and personal Meituan reads require --live');
const queryFile = process.env.EIGOS_PAOTUI_E2E_QUERY_FILE;
const skill = process.env.EIGOS_PAOTUI_SKILL_DIR;
if (!queryFile || !isAbsolute(queryFile) || !skill || !isAbsolute(skill)) throw new Error('Set absolute EIGOS_PAOTUI_E2E_QUERY_FILE and EIGOS_PAOTUI_SKILL_DIR');
const query = paotuiPreviewSchema.parse(JSON.parse(readFileSync(queryFile, 'utf8')));
const directory = join(homedir(), '.local/share/eigos/pa-paotui-e2e', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const privateJson = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const token = randomUUID() + randomUUID(); const tokenPath = join(directory, 'gateway.token');
writeFileSync(tokenPath, token, { mode: 0o600 });
const children: ChildProcess[] = [];
let stopping = false;
process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
async function start(name: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [resolve(`dist/tests/fixtures/${name}.js`)], { env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR, NODE_NO_WARNINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  let diagnostics = ''; child.stderr!.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-8000); });
  return new Promise<{ port?: number }>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Live process readiness deadline exceeded')), 15000); let buffer = '';
    child.stdout!.on('data', data => { buffer += data; const lines = buffer.split('\n'); buffer = lines.pop()!; for (const line of lines) { try { const value = JSON.parse(line); clearTimeout(timer); done(value); } catch { /* Non-JSON diagnostics are not readiness. */ } } });
    child.once('exit', code => { clearTimeout(timer); if (code) reject(new Error(`Live process failed (${code}); inspect private diagnostics`)); privateJson(name + '-diagnostics.json', { diagnostics }); });
  });
}
const sourceFiles = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? sourceFiles(join(path, e.name)) : e.name.endsWith('.ts') ? [join(path, e.name)] : []);
const files = [...sourceFiles('apps'), ...sourceFiles('packages'), 'tests/fixtures/ontology-gateway.ts', 'tests/fixtures/live-worker.ts'].sort();
const implementationSnapshot = { capturedAt: new Date().toISOString(), fileCount: files.length, digest: digest(files.map(path => ({ path: 'dist/' + path.replace(/\.ts$/, '.js'), digest: digest(readFileSync('dist/' + path.replace(/\.ts$/, '.js'), 'utf8')) }))) };
const watcher = new Client({ name: 'eigos-live-e2e-observer', version: '1' });
try {
  const env = { EIGOS_AUTH_MODE: 'development', HOST: '127.0.0.1', EIGOS_COORDINATOR: 'codex', EIGOS_EXECUTOR: 'disabled', EIGOS_PAOTUI_ORDERS_ENABLED: 'false', EIGOS_PAOTUI_SKILL_DIR: skill, EIGOS_ONTOLOGY_AUDIT_PATH: join(directory, 'ontology-reads.jsonl'), DATABASE_PATH: join(directory, 'tasks.sqlite'), EIGOS_CODEX_BIN: process.env.EIGOS_CODEX_BIN ?? 'codex', EIGOS_EXECUTOR_TIMEOUT_MS: '120000', EIGOS_AUDIT_PATH: join(directory, 'gateway-audit.jsonl') };
  const gateway = await start('ontology-gateway', { ...env, GATEWAY_TOKEN_FILE: tokenPath }); const base = `http://127.0.0.1:${gateway.port}`;
  await start('live-worker', { ...env, PUBLIC_URL: base });
  privateJson('profile.json', { cardUrl: base + '/.well-known/agent-card.json', tokenFile: tokenPath, allowLoopbackHttp: true, allowedServices: ['eigos.delegate'], defaultService: 'eigos.delegate' });
  copyFileSync('integrations/grok/eigos-delegate/scripts/eigos_a2a.py', join(directory, 'eigos_a2a.py'));
  copyFileSync('integrations/grok/eigos-delegate/SKILL.md', join(directory, 'SKILL.md'));
  const requestId = 'pa-paotui-' + randomUUID();
  const goal = `请通过 EIGOS 查询美团跑腿当前配送价格。使用本人已保存、此前只读测试使用过的同城地址：senderAddressId=${query.senderAddressId}，recipientAddressId=${query.recipientAddressId}。物品：${query.goodsName}；分类：${query.category}；重量：${query.weightKg} 公斤；服务：${query.service}。只查价格，不创建订单、不下单、不付款；送达时间只是估计。请返回真实查询结果。`;
  privateJson('task-input.json', { service: 'eigos.delegate', goal, requirements: [{ id: 'read_only', kind: 'condition', strength: 'hard', expected: { predicate: 'execution.no_order' } }] });
  privateJson('session.json', { directory, base, requestId, implementationSnapshot });
  console.log(JSON.stringify({ readyForPA: true, directory, base, requestId }));
  await watcher.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  let job: Job | undefined;
  const deadline = Date.now() + 1200000;
  while (Date.now() < deadline) {
    assert(!stopping, 'Live test stopped');
    const response = await watcher.callTool({ name: 'list_tasks', arguments: {} });
    const jobs = (response.structuredContent as { result: { jobs: Job[] } }).result;
    const list = jobs.jobs;
    job = list?.find(j => j.delegation?.request.originalGoal === goal);
    if (job && !['submitted', 'working', 'input-required'].includes(job.state)) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  assert(job, 'No actual PA submission observed before deadline');
  privateJson('task.json', job);
  assert.equal(job.state, 'completed', 'PA task did not complete; inspect original task and private evidence');
  assert.equal(job.delegation!.backendVersion, BACKEND_VERSION); assert.equal(job.delegation!.plan!.capabilityRef.id, 'delivery.quote');
  assert.equal(job.delegation!.acceptance!.accepted, true); assert.equal(job.delegation!.resolution!.scope.realSupply, true);
  const result = job.artifact!.data.result as Record<string, unknown>;
  assert.equal(result.source, 'meituan'); assert.equal(result.orderCreated, false); assert.equal(result.previewOnly, true);
  const receipt = ontologyReceiptSchema.parse(result.ontologyReceipt); assert.equal(receipt.evidenceKind, 'live_readonly');
  assert(receipt.sourceCalls.includes('delivery_preview')); assert(receipt.sourceCalls.every(c => ['get_address_list', 'get_address_info', 'delivery_preview'].includes(c)));
  const receipts = readFileSync(join(directory, 'ontology-reads.jsonl'), 'utf8').trim().split('\n').map(line => ontologyReceiptSchema.parse(JSON.parse(line)));
  assert(receipts.some(r => r.id === receipt.id)); assert(receipts.length >= 2);
  const a2a = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'GetTask', params: { id: job.id } }) }).then(r => r.json());
  const task = a2a.result.task ?? a2a.result; assert.equal(task.status.state, 'TASK_STATE_COMPLETED'); assert.equal(digest(task.artifacts[0].parts[0].data), digest(job.artifact!.data));
  privateJson('verification.json', { status: 'backend_passed_await_pa_readback', backendVersion: BACKEND_VERSION, implementationSnapshot,
    taskId: job.id, state: job.state, capabilityRef: job.delegation!.plan!.capabilityRef, bindingRef: job.delegation!.plan!.bindingRef, planDigest: job.delegation!.plan!.digest, realSupply: true, modelReceipts: job.runs, quote: result.quote, receipts,
    protocolArtifactDigestsMatch: true, orderCreated: false, paymentsMade: false, paInitiation: 'Submitted externally by the actual PA; harness only observes. PA UI/client readback must be archived separately.' });
  console.log(JSON.stringify({ backendPassed: true, taskId: job.id, directory, quote: result.quote }));
  // Keep the same task reachable so the PA can poll/get its actual completed delivery.
  const readbackDeadline = Date.now() + 600000;
  let peerDigest: string | undefined;
  while (Date.now() < readbackDeadline) {
    assert(!stopping, 'Live test stopped');
    try {
      const received = JSON.parse(readFileSync(join(directory, 'pa-received.json'), 'utf8')); const peer = received.task ?? received;
      if (peer.id === job.id && peer.status?.state === 'TASK_STATE_COMPLETED') { peerDigest = digest(peer.artifacts[0].parts[0].data); break; }
    } catch { /* PA has not saved its readback yet. */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  assert.equal(peerDigest, digest(job.artifact!.data), 'Actual PA must save the same completed delivery before E2E can pass');
  const verification = JSON.parse(readFileSync(join(directory, 'verification.json'), 'utf8'));
  privateJson('verification.json', { ...verification, status: 'passed', paReceivedArtifactDigest: peerDigest });
  console.log(JSON.stringify({ passed: true, taskId: job.id, directory }));
} finally {
  await watcher.close().catch(() => {});
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { const exit = new Promise<void>(r => child.once('exit', () => r())); child.kill('SIGTERM'); await exit; }
}
