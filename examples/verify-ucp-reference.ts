// Real UCP HTTP transport to the separately running official local merchant.
// --live uses Codex reasoning; without it only the reasoner is a deterministic fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { readConfig } from '../packages/core/config.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { UCP_CONFIRM, UCP_PREPARE, type UcpSandboxOptions } from '../packages/capabilities/ucp/adapter.js';
import { CodexExecutor } from '../packages/capabilities/executor.js';
import { Coordinator, CodexReasoner } from '../packages/coordinator/coordinator.js';
import { businessModel } from '../packages/ontology/business-model.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import { digest } from '../packages/core/delegation.js';
import type { Job } from '../packages/core/domain.js';
import { interpretation, reasoner } from '../tests/backend-fixture.js';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const merchant = arg('merchant'); if (!merchant) throw new Error('Pass --merchant=http://127.0.0.1:<port> for the official local merchant');
const output = resolve(arg('output') ?? 'data/ucp-reference-run');
if (existsSync(join(output, 'tasks.db'))) throw new Error('Preserve the existing test operations and choose a new output directory');
mkdirSync(output, { recursive: true, mode: 0o700 });
const live = process.argv.includes('--live'), key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), keyId = `eigos-${randomUUID()}`;
const profile = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public,max-age=60'); res.end(JSON.stringify({ ucp: { version: '2026-04-08', capabilities: { 'dev.ucp.shopping.checkout': [{ version: '2026-04-08' }], 'dev.ucp.shopping.order': [{ version: '2026-04-08' }] } }, signing_keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: keyId, alg: 'ES256', use: 'sig' }] })); });
profile.listen(0, '127.0.0.1'); await once(profile, 'listening');
const sourceReceipts: unknown[] = [], modelOutputs: unknown[] = [], tasks: unknown[] = [], failures: unknown[] = [];
let preparationTaskId = '', activePhase = '';
const connection: UcpSandboxOptions = { merchantId: 'official-flower-shop', baseUrl: merchant, platformProfileUrl: `http://127.0.0.1:${(profile.address() as { port: number }).port}/.well-known/ucp`, keyId, privateKey: key.privateKey, onReceipt: receipt => { sourceReceipts.push(receipt); appendFileSync(join(output, 'http-receipts.jsonl'), JSON.stringify(receipt) + '\n', { mode: 0o600 }); }, fulfillmentProfiles: { office: { label: '合成测试办公室', destination: { address_country: 'US', postal_code: '94103', address_region: 'CA', address_locality: 'San Francisco', street_address: '123 Test Street' }, optionId: 'std-ship' } } };
const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, token = randomUUID();
const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, EIGOS_ACTION_SANDBOX: 'true', PUBLIC_URL: base, DATABASE_PATH: join(output, 'tasks.db') }), undefined, store => createExecutionCatalog({ store, ucpSandbox: connection }));
server.on('request', gateway.app);
const executor = new CodexExecutor(process.env.EIGOS_CODEX_BIN ?? 'codex', 120000);
const actualReasoner = live ? new CodexReasoner({ runStructured: async (prompt, schema, signal) => { const result = await executor.runStructured(prompt, schema, signal); modelOutputs.push({ phase: activePhase, ...result }); appendFileSync(join(output, 'model-turns.jsonl'), JSON.stringify({ phase: activePhase, ...result }) + '\n', { mode: 0o600 }); console.log(JSON.stringify({ phase: activePhase, modelTurn: modelOutputs.length, receiptId: result.evidence.id })); return result; } }) : reasoner(req => {
  const prepare = activePhase === 'prepare', id = prepare ? UCP_PREPARE : UCP_CONFIRM;
  return { ...interpretation(req, id, prepare ? { items: [{ id: 'bouquet_roses', quantity: 2 }], fulfillmentProfile: 'office' } : { preparationTaskId, budget: { minor: '10000', currency: 'USD' } }), capabilityRef: { id, version: '1' } };
});
const coordinator = new Coordinator(gateway.store, actualReasoner, gateway.catalog, { allowSandbox: true });
const worker = new Worker(gateway.store, { coordinator: { run: async (claim, signal) => { try { await coordinator.run(claim, signal); } catch (e) { failures.push({ phase: activePhase, taskId: claim.job.id, message: String(e) }); throw e; } } }, pollMs: 100, leaseMs: 15000, timeoutMs: 600000 });
const client = new Client({ name: 'ucp-protocol-observer', version: '1' });
const persist = () => writeFileSync(join(output, 'verification.json'), JSON.stringify({ scope: 'Official local UCP reference merchant over signed HTTP; no live merchant, actual user PA, real payment or deployment', reasoning: live ? 'codex-exec' : 'fixture', backendVersion: BACKEND_VERSION, model: businessModel.ref, tasks, failures, sourceReceipts, modelOutputs }, null, 2), { mode: 0o600 });
async function rpc(method: string, params: object) { const response = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) }); const value = await response.json(); assert(response.ok && !value.error, JSON.stringify(value)); return value.result.task ?? value.result; }
try {
  worker.start(); await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  for (const phase of ['prepare', 'confirm'] as const) {
    activePhase = phase;
    const goal = phase === 'prepare' ? '这是明确获准的官方本地测试商家演练，使用沙箱。请为商品 bouquet_roses 数量2件创建结账会话，使用 office 测试收货资料。只取得会话和商家报价，不下单或付款；商品件数是会话输入，不是本次要求交付实物。' : `这是明确获准的官方本地测试商家演练，使用沙箱。请确认准备任务 ${preparationTaskId} 的结账，保持原商品、数量、收货资料和报价。预算已通过结构化最小货币单位字段提供。目标只到订单确认，不要求现在送达；不要声称真实购买或付款到账。`;
    const initial = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', executionEnvironment: 'sandbox', goal, ...(phase === 'confirm' ? { requirements: [{ id: 'service-budget', kind: 'budget', role: 'service_total', strength: 'hard', expected: { minor: '10000', currency: 'USD' } }] } : {}) } }] } });
    console.log(JSON.stringify({ phase, taskId: initial.id, state: initial.status.state }));
    let task = initial, approved = false; const deadline = Date.now() + 590000;
    do {
      task = await rpc('GetTask', { id: initial.id });
      if (task.status.state === 'TASK_STATE_AUTH_REQUIRED' && !approved) {
        const auth = task.metadata.delegation.authorizationRequest;
        assert.equal(auth.environment, 'sandbox'); assert.equal(auth.realOperationsAllowed, false); assert.deepEqual(auth.effects, phase === 'prepare' ? ['reserve'] : ['order', 'payment']); assert.equal(auth.maxAmount.currency, 'USD'); assert(BigInt(auth.maxAmount.minor) <= (phase === 'prepare' ? 0n : 10000n)); assert.deepEqual(auth.payeeIds, ['official-flower-shop']);
        const response = await fetch(`${base}/tasks/${initial.id}/authorize`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve_plan', requestId: randomUUID(), planDigest: auth.planDigest, allowedEffects: auth.effects, maxAmount: auth.maxAmount, payeeIds: auth.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }) });
        assert.equal(response.status, 200); approved = true; continue;
      }
      if (!['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(task.status.state)) break;
      await pause(1000);
    } while (Date.now() < deadline);
    const response = await client.callTool({ name: 'get_task', arguments: { taskId: initial.id } }); assert(!response.isError);
    const readback = (response.structuredContent as { result: Job }).result;
    const protocolMatch = task.id === readback.id && !!readback.artifact && task.artifacts?.[0]?.artifactId === readback.artifact.id && digest(task.artifacts[0].parts[0].data) === digest(readback.artifact.data);
    const expected = phase === 'prepare' ? { items: [{ id: 'bouquet_roses', quantity: 2 }], fulfillmentProfile: 'office' } : { preparationTaskId, budget: { minor: '10000', currency: 'USD' } };
    const parametersMatch = digest(readback.delegation?.plan?.steps[0]?.input ?? null) === digest(expected);
    const record = { phase, taskId: readback.id, state: readback.state, approved, protocolMatch, parametersMatch, modelRuns: readback.runs?.length ?? 0, ontologyReads: readback.delegation?.ontologyReads?.length ?? 0, task, readback };
    tasks.push(record); persist(); console.log(JSON.stringify({ ...record, task: undefined, readback: undefined }));
    if (readback.state !== 'completed') break;
    if (phase === 'prepare') preparationTaskId = readback.id;
  }
} finally {
  persist(); await client.close(); await worker.close(); server.closeAllConnections(); profile.closeAllConnections(); await Promise.all([new Promise<void>(done => server.close(() => done())), new Promise<void>(done => profile.close(() => done()))]); await gateway.close();
}
if (tasks.length !== 2 || tasks.some(value => { const t = value as { state: string; protocolMatch: boolean; parametersMatch: boolean }; return t.state !== 'completed' || !t.protocolMatch || !t.parametersMatch; })) process.exitCode = 1;
