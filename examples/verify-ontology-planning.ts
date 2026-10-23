// Opt-in real model, synthetic address/quote source, ephemeral HTTP Gateway and Worker.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { readConfig } from '../packages/core/config.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { Coordinator, CodexReasoner } from '../packages/coordinator/coordinator.js';
import { CodexExecutor } from '../packages/capabilities/executor.js';
import { PaotuiRequestAdapter, DELIVERY_REQUEST_CAPABILITY, DELIVERY_REQUEST_BINDING } from '../packages/capabilities/paotui-request.js';
import { ontologyReceiptSchema } from '../packages/capabilities/paotui-mcp-server.js';
import { digest } from '../packages/core/delegation.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import type { Job } from '../packages/core/domain.js';

if (!process.argv.includes('--live')) throw new Error('Pass --live to authorize the real model verification');
const output = resolve(process.argv.find(a => a.startsWith('--output='))?.slice(9) ?? 'data/ontology-n2-model-run');
mkdirSync(output, { recursive: true, mode: 0o700 });
const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`, token = randomUUID();
const calls: unknown[] = [], failures: string[] = [], modelResponses: unknown[] = [];
const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, PUBLIC_URL: base, DATABASE_PATH: ':memory:' }), undefined, store => {
  const adapter = new PaotuiRequestAdapter({ query: async query => {
    calls.push(query);
    const { action, ...input } = query;
    const business = query.action === 'addresses'
      ? { source: 'meituan', readOnly: true, addresses: [{ addressId: 'synthetic-origin', address: '合成住处', cityId: 1 }, { addressId: 'synthetic-destination', address: '合成办公室', cityId: 1 }] }
      : query.action === 'preview'
        ? { source: 'meituan', previewOnly: true, orderCreated: false, goods: { name: query.goodsName, category: query.category, weightKg: query.weightKg }, service: query.service,
          route: { sender: '合成住处', recipient: '合成办公室' }, quote: { _previewTotal: '19.40' } }
        : (() => { throw new Error('This fixture only supports address and quote reads'); })();
    const id = query.action === 'addresses' ? 'address.book.read' : 'delivery.quote';
    return { ...business, ontologyReceipt: ontologyReceiptSchema.parse({ id: randomUUID(), transport: 'mcp-stdio', server: 'eigos-ontology', capabilityRef: { id, version: '1' }, ontologyRef: { id: 'locations-and-parcel-quotes', version: '1' },
      tool: 'ontology_' + id.replaceAll('.', '_'), evidenceKind: 'fixture', inputDigest: digest(input), resultDigest: digest(business), observedAt: new Date().toISOString(), sourceCalls: query.action === 'addresses' ? ['get_address_list'] : ['get_address_info', 'delivery_preview'], readOnly: true }) };
  } }, store, 'n2-synthetic-source');
  const capability = { ...DELIVERY_REQUEST_CAPABILITY, environment: 'sandbox' as const, name: 'Synthetic parcel quote exercise', description: 'Explicit synthetic exercise only. Read local synthetic saved-address options and a synthetic quote through the same adapter contract. Input sender/recipient are exact names or choice labels from the user. Missing inputs may be null and are clarified in the same task. Preserve the parcel weight and ordinary/express service. All evidence remains synthetic; no provider network, order, payment or fulfillment occurs.' };
  return new ExecutionCatalog([capability], [{ ...DELIVERY_REQUEST_BINDING, verification: { level: 'simulated', evidenceRefs: ['synthetic-n2-source'] } }], [adapter]);
});
server.on('request', gateway.app);
const model = new CodexExecutor(process.env.EIGOS_CODEX_BIN ?? 'codex', 120000);
const coordinator = new Coordinator(gateway.store, new CodexReasoner({ runStructured: async (prompt, schema, signal, options) => {
  const result = await model.runStructured(prompt, schema, signal, options); modelResponses.push({ evidenceId: result.evidence.id, output: result.output }); return result;
} }), gateway.catalog);
const worker = new Worker(gateway.store, { coordinator: { run: async (claim, signal) => { try { await coordinator.run(claim, signal); } catch (e) { failures.push(e instanceof Error ? e.message : String(e)); throw e; } } }, pollMs: 100, leaseMs: 15000, timeoutMs: 600000 });
worker.start();
const client = new Client({ name: 'n2-protocol-observer', version: '1' });
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
async function rpc(method: string, params: object) {
  const response = await fetch(base + '/a2a', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
  const body = await response.json(); assert(response.ok && !body.error, JSON.stringify(body)); return body.result.task ?? body.result;
}
let task: Record<string, unknown> | undefined, readback: Job | undefined;
try {
  const goal = '这是明确获准的本地合成数据演练，不要求真实报价。请查从合成住处寄到合成办公室，1公斤文件，普通送的合成价格。成功条件是合成报价适用于这1公斤文件和普通送；请说明费用性质及仍未知的费用。只查价，不下单、不付款。';
  const initial = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', executionEnvironment: 'sandbox', requestId: randomUUID(), goal } }] } });
  console.log(JSON.stringify({ taskId: initial.id, state: initial.status.state, scope: 'real-model-synthetic-source' }));
  const deadline = Date.now() + 590000;
  do {
    task = await rpc('GetTask', { id: initial.id });
    if (!['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes((task!.status as { state: string }).state)) break;
    await pause(1000);
  } while (Date.now() < deadline);
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const response = await client.callTool({ name: 'get_task', arguments: { taskId: initial.id } }); assert(!response.isError);
  readback = (response.structuredContent as { result: Job }).result;
  assert.equal(readback.id, initial.id); assert.equal(readback.state, 'completed', JSON.stringify({ state: readback.state, failures, question: readback.question }));
  assert.equal(readback.delegation!.backendVersion, BACKEND_VERSION);
  assert(readback.runs!.length >= 4 && readback.runs!.every(r => r.runtime === 'codex-exec' && r.threadId));
  assert(readback.delegation!.ontologyReads!.some(r => r.tool === 'query_ontology' && r.status === 'ok'));
  assert(readback.delegation!.request.conditions!.some(c => c.predicateRef.id === 'parcel.quote_matches_request'));
  assert(readback.delegation!.conditionChecks!.every(c => c.result === 'pass'));
  assert(readback.delegation!.acceptance!.accepted);
  assert.equal((task!.status as { state: string }).state, 'TASK_STATE_COMPLETED');
  console.log(JSON.stringify({ state: readback.state, modelRuns: readback.runs!.length, ontologyReads: readback.delegation!.ontologyReads!.length, conditionChecks: readback.delegation!.conditionChecks }));
} finally {
  writeFileSync(join(output, 'verification.json'), JSON.stringify({ evidenceScope: 'Real Codex reasoning; all source data synthetic; protocol observer, not an actual user Personal Agent; no real transaction or deployment', task, readback, sourceCalls: calls, modelResponses, failures }, null, 2), { mode: 0o600 });
  await client.close(); await worker.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await gateway.close();
}
