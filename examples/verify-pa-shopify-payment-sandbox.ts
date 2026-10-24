// Runs a real Personal Agent and a real EIGOS Worker against an isolated test
// merchant. The observer creates no business task and never pays on their behalf.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { verifyShopifyPAResult } from './lib/verify-shopify-pa-result.js';
import { z } from 'zod';
import { createApp } from '../apps/gateway/app.js';
import { createWorker } from '../apps/worker/runtime.js';
import { readConfig } from '../packages/core/config.js';
import { createShopifyPASandbox, SHOPIFY_TEST_MERCHANT, SHOPIFY_TEST_VARIANT } from '../packages/capabilities/shopify/pa-checkout-sandbox.js';

if (!process.argv.includes('--run')) throw new Error('Pass --run to run real models with isolated test payments only');
const directoryIndex = process.argv.indexOf('--directory'), directory = resolve(directoryIndex >= 0 ? process.argv[directoryIndex + 1]! : 'data/shopify-pa-payment-acceptance');
assert(!existsSync(join(directory, 'session.json')), 'This acceptance attempt already exists; preserve and inspect its original tasks and payment operation');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const save = (name: string, value: unknown) => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); return path; };
const credential = (name: string) => { const value = randomBytes(32).toString('hex'), path = join(directory, name); writeFileSync(path, value, { mode: 0o600 }); return { value, path }; };
const source = credential('source-token'), pa = credential('pa-token'), gatewayToken = credential('gateway-token'), paToolsToken = credential('pa-tools-token');
const provider = await createShopifyPASandbox({ databasePath: join(directory, 'provider.sqlite'), sourceToken: source.value, paToken: pa.value });
const gatewayServer = createServer(); gatewayServer.listen(0, '127.0.0.1'); await once(gatewayServer, 'listening');
const base = `http://127.0.0.1:${(gatewayServer.address() as { port: number }).port}`;
const config = readConfig({ NODE_ENV: 'development', EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: gatewayToken.value, PUBLIC_URL: base, DATABASE_PATH: join(directory, 'tasks.sqlite'), EIGOS_EXECUTOR: 'codex', EIGOS_CODEX_BIN: process.env.EIGOS_CODEX_BIN ?? 'codex', EIGOS_EXECUTOR_TIMEOUT_MS: '180000', EIGOS_ACTION_SANDBOX: 'true', EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL: provider.endpoint, EIGOS_SHOPIFY_PAYMENT_SANDBOX_TOKEN_FILE: source.path });
const gateway = createApp(config); gatewayServer.on('request', gateway.app);
const worker = createWorker(config, { timing: { pollMs: 100, leaseMs: 60000, timeoutMs: 3600000 } });
const exec = promisify(execFile), a2aScript = resolve('integrations/grok/eigos-delegate/scripts/eigos_a2a.py'), paymentScript = resolve('integrations/grok/eigos-delegate/scripts/eigos_test_payment.py');
const a2aProfile = join(directory, 'pa-a2a.json');
const safe = (value: string) => [source.value, pa.value, gatewayToken.value, paToolsToken.value].reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
const python = async (script: string, profile: string, args: string[]) => {
  try { const result = await exec('python3', [script, '--config', profile, ...args], { maxBuffer: 8 * 1024 * 1024 }); return JSON.parse(result.stdout); }
  catch (error) { throw new Error(safe(String((error as { stderr?: string }).stderr ?? 'Private PA helper failed'))); }
};
await python(a2aScript, a2aProfile, ['configure', '--card-url', base + '/.well-known/agent-card.json', '--token-file', gatewayToken.path, '--allow-loopback-http']);
const vault = save('test-vault.json', { environment: 'sandbox', instrument: { type: 'test_card', number: '4242424242424242', expiry: '12/30', cvc: '123' } });
const paymentProfile = save('pa-payment.json', { version: 1, environment: 'sandbox', realPayments: false, endpoint: provider.endpoint, tokenFile: pa.path, vaultFile: vault, accountId: 'pa-test-account', allowedRoutes: ['pa_vault'], a2aConfig: a2aProfile, databasePath: join(directory, 'pa-payments.sqlite'), authorization: { kind: 'isolated_test_only', payeeId: SHOPIFY_TEST_MERCHANT.id, currency: 'USD', maximumMinor: '100', maximumPayments: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() } });
const toolCalls: { at: string; tool: string; taskId: string; outcome: unknown }[] = [];
// This connector belongs to the PA. The EIGOS Gateway/Worker never receives its
// bearer token, payment profile, Vault path or test payment account credential.
const paApp = createMcpExpressApp({ host: '127.0.0.1', allowedHosts: ['127.0.0.1'], allowedOrigins: ['127.0.0.1'], jsonLimit: '64kb' });
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'personal-agent-test-payments', version: '1' });
  for (const [tool, command, description] of [
    ['payment_capabilities', 'capabilities', 'Inspect your own isolated test Vault/account and its current authorization for this EIGOS checkout. Returns no credentials.'],
    ['pay_test_checkout', 'pay', 'Use your own isolated test Vault/account to pay the exact original checkout under the user test authorization. It is incapable of real payment. Durable repeats only QUERY the original operation. Report the outcome to EIGOS afterward.'],
    ['query_test_payment', 'query', 'Query your saved original test payment operation after response loss or uncertainty; never dispatch another payment.'],
  ] as const) server.registerTool(tool, { description, inputSchema: z.strictObject({ taskId: z.uuid() }), annotations: { readOnlyHint: command !== 'pay', destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ taskId }) => {
    try { const result = await python(paymentScript, paymentProfile, [command, '--task-id', taskId]); toolCalls.push({ at: new Date().toISOString(), tool, taskId, outcome: result }); save('pa-payment-tool-calls.json', toolCalls); return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: safe(String(error)) }] }; }
  });
  server.registerTool('authorize_test_checkout', { description: 'Approve the exact current EIGOS sandbox reservation after inspecting its planDigest and zero payment spend. This only prepares one unpaid test checkout; the PA separately pays using its own test capability.', inputSchema: z.strictObject({ taskId: z.uuid(), requestId: z.uuid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/) }), annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ taskId, requestId, planDigest }) => {
    try {
      const current = await python(a2aScript, a2aProfile, ['get', '--task-id', taskId]), grant = current.metadata?.delegation?.authorizationRequest;
      assert.equal(current.status.state, 'TASK_STATE_AUTH_REQUIRED'); assert.equal(grant.planDigest, planDigest); assert.deepEqual(grant.effects, ['reserve']); assert.equal(grant.maxAmount.minor, '0'); assert.equal(grant.maxAmount.currency, 'USD'); assert.deepEqual(grant.payeeIds, [SHOPIFY_TEST_MERCHANT.id]);
      const file = save('pa-reservation-approval.json', { requestId, action: 'approve_plan', planDigest, allowedEffects: grant.effects, maxAmount: grant.maxAmount, payeeIds: grant.payeeIds, expiresAt: new Date(Date.now() + 300000).toISOString(), environment: 'sandbox' });
      const result = await python(a2aScript, a2aProfile, ['authorize', '--task-id', taskId, '--input-file', file]); toolCalls.push({ at: new Date().toISOString(), tool: 'authorize_test_checkout', taskId, outcome: { planDigest, paymentSpend: '0' } }); save('pa-payment-tool-calls.json', toolCalls);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: safe(String(error)) }] }; }
  });
  return server;
}, { legacy: 'stateless', maxSubscriptions: 0 });
const nodeHandler = toNodeHandler(handler);
paApp.all('/mcp', async (req, res) => { if (req.headers.authorization !== `Bearer ${paToolsToken.value}`) { res.sendStatus(401); return; } await nodeHandler(req, res, req.body); });
const paServer = createServer(paApp); paServer.listen(0, '127.0.0.1'); await once(paServer, 'listening');
const paBase = `http://127.0.0.1:${(paServer.address() as { port: number }).port}`;
const marker = 'shopify-pa-payment-' + randomUUID();
const goal = `[${marker}] 请在隔离 Shopify 测试环境购买测试咖啡 1 件（merchantId=${SHOPIFY_TEST_MERCHANT.id}，variantId=${SHOPIFY_TEST_VARIANT}，quantity=1），最终预算 1 美元。创建且保留同一个测试结账，把准确付款请求交给我的 Personal Agent，由它用自己的测试 Vault 付款，再独立核验原结账对应的付款与订单确认。不得真实付款；这里的商家和支付均为隔离合约模拟器。`;
const prompt = `你是用户的真实 Personal Agent。用户授权本轮隔离测试：创建一笔最多 1 USD 的测试结账，用你自己的测试 Vault 完成一次模拟付款，再由 EIGOS 回读确认。你拥有 eigos MCP 和独立 pa_payments MCP；支付凭据在你的私有连接器中，EIGOS 不持有它们。只使用这两个连接器，禁止任何真实商家或付款。\n先发现 EIGOS 服务，然后提交且只提交一个 eigos.delegate 任务，executionEnvironment=sandbox、executionBudget=extended，goal 原文为：\n${goal}\n可用结构化预算要求 service_total=100 USD 最小单位，数量要求 item_quantity=1 piece。工作状态用 get_task(waitMs=30000) 等待。EIGOS Worker 自主读取 Ontology 和选择业务动作，你不得指定内部固定步骤。\n收到 TASK_STATE_AUTH_REQUIRED 时检查是 sandbox、effects=[reserve]、maxAmount.minor=0、payeeIds=[shopify-sandbox]，然后用你自己的 authorize_test_checkout 工具传原 taskId/planDigest 与稳定 UUID。这仅允许准备测试结账，不允许 EIGOS 付款。\n收到 awaiting_pa_payment 时读取完整 request 与 selection；没有选择时调用你自己的 payment_capabilities，然后把返回的 pa_vault capability 连同原 handoffId、handoffDigest 交给 eigos.select_payment_route，使用稳定请求 UUID。随后调用你自己的 pay_test_checkout，只传原 taskId。若结果 unknown，就 query_test_payment 查询原操作，绝不重付。把仅含原 handoffId/digest 和 outcome=submitted 或 unknown 的结构化通知交给 eigos.report_payment_result。付款不是 EIGOS 完成，继续等待同一个 taskId，直到 EIGOS 完成独立付款与订单核验。\n最后必须再次 get_task 读到实际交付物，返回 taskId、原 checkoutId、paymentId、orderId、paymentRoute 及简短中文总结。明确这是模拟商家与模拟付款，realPayment=false。不要创建替代任务，失败或技术暂停就保留原任务并报告；必要时最多等待 25 分钟。`;
const finalSchema = { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' }, checkoutId: { type: 'string' }, paymentId: { type: 'string' }, orderId: { type: 'string' }, paymentRoute: { type: 'string' }, summary: { type: 'string' } }, required: ['taskId', 'checkoutId', 'paymentId', 'orderId', 'paymentRoute', 'summary'] };
save('session.json', { startedAt: new Date().toISOString(), marker, goal, base, paBase, provider: provider.endpoint, environment: 'sandbox', evidenceLevel: 'synthetic', realPayment: false, userAuthorization: 'One isolated test purchase using the PA own test Vault, no real payment' });
save('pa-output-schema.json', finalSchema); writeFileSync(join(directory, 'pa-prompt.txt'), prompt, { mode: 0o600 });
const temporary = mkdtempSync(join(tmpdir(), 'eigos-shopify-payment-pa-'));
const events: any[] = [];
let exitCode: number | null = null;
try {
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--approve-for-me', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
    ...['shell_tool', 'apps', 'plugins', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'image_generation', 'code_mode'].flatMap(name => ['--disable', name]),
    '-c', `mcp_servers.eigos.url=${JSON.stringify(base + '/mcp')}`, '-c', 'mcp_servers.eigos.bearer_token_env_var="EIGOS_TEST_PA_GATEWAY_TOKEN"',
    '-c', 'mcp_servers.eigos.enabled_tools=["list_services","submit_task","get_task","select_payment_route","report_payment_result","reconcile_task"]',
    '-c', `mcp_servers.pa_payments.url=${JSON.stringify(paBase + '/mcp')}`, '-c', 'mcp_servers.pa_payments.bearer_token_env_var="EIGOS_TEST_PA_TOOLS_TOKEN"',
    '--output-schema', join(directory, 'pa-output-schema.json'), '--output-last-message', join(directory, 'pa-result.json'), '--json', '-'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE']) if (process.env[key]) env[key] = process.env[key];
  env.NO_PROXY = [env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(','); env.EIGOS_TEST_PA_GATEWAY_TOKEN = gatewayToken.value; env.EIGOS_TEST_PA_TOOLS_TOKEN = paToolsToken.value;
  exitCode = await new Promise<number | null>((resolveRun, reject) => {
    const child = spawn(config.EIGOS_CODEX_BIN, args, { cwd: temporary, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let buffer = '', bytes = 0; const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(kill, 1800000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > 16000000) { kill(); return; }
      buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) try {
        const event = JSON.parse(safe(line));
        if (['thread.started', 'turn.completed', 'turn.failed', 'error'].includes(event.type) || event.type === 'item.completed' && ['mcp_tool_call', 'agent_message'].includes(event.item?.type)) {
          events.push(event); appendFileSync(join(directory, 'pa-events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
          if (event.item?.type === 'mcp_tool_call') console.log(JSON.stringify({ event: 'pa_tool', tool: event.item.tool, status: event.item.status }));
        }
      } catch {}
    });
    child.stderr.on('data', (chunk: Buffer) => appendFileSync(join(directory, 'pa-stderr.log'), safe(chunk.toString()), { mode: 0o600 }));
    child.stdin.on('error', () => {}); child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('close', code => { clearTimeout(timer); resolveRun(code); }); child.stdin.end(prompt);
  });
  assert.equal(exitCode, 0, 'Personal Agent did not finish its turn');
  const verification = await verifyShopifyPAResult({ directory, base, token: gatewayToken.value, secrets: [source.value, pa.value, gatewayToken.value, paToolsToken.value], gateway, provider, events, toolCalls,
    readA2A: taskId => python(a2aScript, a2aProfile, ['get', '--task-id', taskId]) });
  console.log(JSON.stringify({ status: verification.status, taskId: verification.taskId, evidenceDirectory: directory, realPayment: false }));
} catch (error) {
  save('failure.json', { at: new Date().toISOString(), error: safe(String(error)), exitCode });
  const owner = JSON.stringify(['local-development', 'local', 'developer']); save('tasks-at-stop.json', gateway.store.list(owner, { limit: 100, offset: 0 }));
  throw error;
} finally {
  await worker.close();
  const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  await close(gatewayServer); await gateway.close(); await close(paServer); await provider.close(); rmSync(temporary, { recursive: true, force: true });
  if (existsSync(join(directory, 'pa-result.json'))) chmodSync(join(directory, 'pa-result.json'), 0o600);
  save('run-state.json', { endedAt: new Date().toISOString(), exitCode, servicesStopped: true });
}
