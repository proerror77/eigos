// Starts only isolated simulation gateways and an actual Codex model client.
// The harness never submits or confirms a business task on behalf of the model.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createLocalApp as createApp } from '../apps/local.js';
import { readConfig } from '../packages/core/config.js';
import { AuditPilot } from '../packages/capabilities/pilot/service.js';
import { SimulatedProvider } from '../packages/capabilities/pilot/providers.js';
import { JobStore } from '../packages/core/store.js';
import { hash } from '../packages/capabilities/pilot/quality.js';
import { loadCsvFile, snapshotBytes, type CsvSnapshot } from '../packages/capabilities/pilot/csv-file.js';
import { acceptFile, independentFindings } from '../packages/capabilities/pilot/file-acceptance.js';
const root = resolve('.'); const output = resolve(process.argv[2] ?? 'output/csv-real-agent');
mkdirSync(output, { recursive: true });
if (readdirSync(output).length) throw new Error('Use a fresh output directory to avoid mixing agent runs');
const temp = mkdtempSync(join(tmpdir(), 'eigos-real-agent-'));
const token = randomBytes(32).toString('hex');
const targets: Record<string, string> = {};
const instances: { scenario: string; gateway: ReturnType<typeof createApp>; server: ReturnType<typeof createServer>; db: string }[] = [];
const events: object[] = []; let diagnostic = '';
const startedAt = new Date().toISOString();
try {
  const fileArgument = process.argv[3]; let fileSnapshot: CsvSnapshot | undefined;
  const inputDirectory = join(temp, 'csv-input');
  if (fileArgument) {
    mkdirSync(inputDirectory);
    if (fileArgument === '--generated-file') {
      const suffix = randomBytes(8).toString('hex');
      const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
      const records = Array.from({ length: 64 }, (_, i) => [
        i % 9 === 0 ? '含逗号, 引号"和多行\r\n第二行 ' + suffix : '备注 ' + i,
        i % 17 === 0 ? '2026-02-30' : '2024-02-29',
        i === 5 || i === 19 ? 'duplicate-' + suffix : suffix + '-' + i,
        i % 7 === 0 ? '-1' : (i + 0.25).toFixed(2),
        i % 13 === 0 ? '' : i % 11 === 0 ? 'invalid-address' : `u${i}@example.test`,
      ]);
      const bytes = Buffer.from('\uFEFFnotes,event_date,record_id,amount_cny,email\r\n' + records.map(row => row.map(quote).join(',')).join('\r\n') + '\r\n');
      fileSnapshot = snapshotBytes('audit-input.csv', bytes);
      writeFileSync(join(output, 'generated-test-input.csv'), bytes);
    } else {
      const input = resolve(fileArgument);
      fileSnapshot = loadCsvFile(dirname(input), basename(input));
    }
    // Only this copied file is visible to the gateway; no model receives its raw contents.
    writeFileSync(join(inputDirectory, 'audit-input.csv'), Buffer.from(fileSnapshot.base64, 'base64'), { mode: 0o600 });
    writeFileSync(join(output, 'input-manifest.json'), JSON.stringify({ source: fileArgument === '--generated-file' ? 'fresh-generated-test-file' : 'user-specified-file',
      sha256: fileSnapshot.sha256, byteLength: fileSnapshot.byteLength, rowCount: fileSnapshot.rowCount, note: 'Real file ingestion; payment and fault provider remain simulated' }, null, 2));
  }
  for (const [scenario, fault] of [['normal', 'none'], ['repair', 'bad-once'], ['refund', 'bad-always']] as const) {
    const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const addr = server.address(); assert(addr && typeof addr !== 'string');
    const base = `http://127.0.0.1:${addr.port}`; targets[scenario] = base;
    const db = join(temp, `${scenario}.sqlite`);
    const gateway = createApp(readConfig({ HOST: '127.0.0.1', PORT: String(addr.port), PUBLIC_URL: base, DATABASE_PATH: db,
      EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, EIGOS_CSV_PILOT: 'true',
      EIGOS_CSV_INPUT_DIR: fileSnapshot ? inputDirectory : undefined,
      EIGOS_AUDIT_PATH: join(output, `${scenario}-http.jsonl`) }), undefined, undefined, undefined,
      store => new AuditPilot(store, new SimulatedProvider(store, fault)));
    server.on('request', gateway.app); instances.push({ scenario, gateway, server, db });
  }
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--approve-for-me',
    '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
    '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'plugins', '--disable', 'hooks', '--disable', 'memories',
    '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--disable', 'computer_use', '--disable', 'browser_use',
    '--disable', 'in_app_browser', '--disable', 'image_generation', '--disable', 'code_mode'];
  for (const [name, base] of Object.entries(targets)) {
    args.push('-c', `mcp_servers.csv_${name}.url=${JSON.stringify(base + '/mcp')}`,
      '-c', `mcp_servers.csv_${name}.bearer_token_env_var="EIGOS_SIM_ACCESS_TOKEN"`);
  }
  args.push('-c', `mcp_servers.a2a_bridge.command=${JSON.stringify(join(root, 'node_modules/.bin/tsx'))}`,
    '-c', `mcp_servers.a2a_bridge.args=[${JSON.stringify(join(root, 'examples/pilot-a2a-bridge.ts'))}]`,
    '-c', 'mcp_servers.a2a_bridge.env_vars=["EIGOS_SIM_ACCESS_TOKEN","EIGOS_SIM_TARGETS"]',
    '--output-last-message', join(output, 'agent-final.md'), '--json', '-');
  let prompt = `你是真实客户端 Agent，执行 EIGOS 本地 CSV 审计用户验收演示。用户已授权三次固定模拟100分CNY的确认，无真钱。只能使用提供的 MCP 工具，不能用 shell/文件/外网。三个网关分别是 normal正常供应商、repair首次错误后补交、refund持续错误后模拟退款；同名场景的 MCP 和 A2A 指向同一网关。\n请自己发现服务和参数并执行：\n1. normal：通过 csv_normal MCP 下单 data.quality.audit.simulated，datasetId=duplicate-and-missing-v1；展示读回报价，再通过 a2a_bridge 的 SendMessage 确认原 quoteId/quoteDigest（action=confirm_simulated_payment），用 MCP 查询至 completed。\n2. repair：通过 a2a_bridge SendMessage 新建同服务同数据集，再通过 csv_repair MCP reply_to_task 确认，从 A2A 查询直到 completed，检查确有拒收、补交和验收通过。\n3. refund：通过 csv_refund MCP 新建和确认，通过 A2A查询至 remediation=refunded且step=done。任务failed但退款pending不是终点，必须继续查询。\n每个场景只建一张订单，请求重试沿用原ID。报价未知不能编造，taskId来自返回。轮询只查，不重复下单。最后用中文总结三条实际结果，列出真实taskId/orderId/付款和验收及补救状态，明确模拟≠支付宝接入。不要请求人类再次确认已授权的模拟付款。`;
  if (fileSnapshot) prompt = prompt.replace('datasetId=duplicate-and-missing-v1', 'fileName=audit-input.csv（不要传datasetId）') +
    '\n本轮必须使用真实磁盘 CSV 文件（由用户授权临时生成测试数据或明确指定文件），不是预置数据集。网关仅返回原始字节摘要和报告，不给模型原始内容。请核实报告schemaVersion=2、规则csv-quality-file-v1及metadata中的input.source=local-file；补交前后行数和问题数可能相同但问题行号不同，必须检查独立验收记录。';
  writeFileSync(join(output, 'agent-task.txt'), prompt);
  await new Promise<void>((resolveRun, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH','HOME','USER','TMPDIR','LANG','CODEX_HOME','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE']) if (process.env[key]) env[key] = process.env[key];
    env.EIGOS_SIM_ACCESS_TOKEN = token; env.EIGOS_SIM_TARGETS = JSON.stringify(targets);
    const child = spawn('codex', args, { cwd: temp, env, stdio: ['pipe','pipe','pipe'] });
    let buffer = ''; const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          // Save calls/results and final receipts only; omit reasoning and hidden context.
          if (['thread.started','turn.completed','turn.failed','error'].includes(event.type) || (event.type === 'item.completed' && ['mcp_tool_call','agent_message'].includes(event.item?.type))) {
            events.push(event); appendFileSync(join(output, 'agent-events.jsonl'), JSON.stringify(event) + '\n');
          }
          if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') console.log('Agent tool:', event.item.server, event.item.tool, event.item.status);
        } catch { /* non-event diagnostics */ }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-20000); });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolveRun() : reject(new Error(`Agent exited ${code}: ${diagnostic.replaceAll(token, '[redacted]')}`)); });
    child.stdin.end(prompt);
  });
  const verified = [];
  for (const { scenario, db } of instances) {
    const store = new JobStore(db);
    try {
      const jobs = store.pilotJobs(); assert.equal(jobs.length, 1, `${scenario}: expected exactly one model-created task`);
      const job = jobs[0]!.job; const state = job.pilot!;
      const ledger = store.pilotRead<{ charges: number; refunds: number }>(`payment:${state.orderId}`)!;
      if (fileSnapshot) {
        assert.equal(state.input?.source, 'local-file'); assert.equal(state.datasetId, undefined);
        assert.equal(state.quote.inputSha256, fileSnapshot.sha256);
        if (state.files) {
          assert(acceptFile(fileSnapshot, state.orderId, state.files.json, state.files.markdown).accepted);
          const parsed = JSON.parse(state.files.json); assert.equal(parsed.schemaVersion, 2);
          assert.deepEqual(parsed.findings, independentFindings(Buffer.from(fileSnapshot.base64, 'base64')).findings);
        }
      }
      assert.equal(ledger.charges, 1); assert.equal(state.step, 'done');
      assert.equal(job.state, scenario === 'refund' ? 'failed' : 'completed');
      assert.equal(state.remediation, scenario === 'refund' ? 'refunded' : 'none');
      if (scenario === 'repair') assert(state.checks.some(c => !c.accepted) && state.checks.some(c => c.accepted));
      writeFileSync(join(output, `${scenario}-readback.json`), JSON.stringify({ environment: 'simulated', job, ledger }, null, 2));
      if (state.files) {
        assert.equal(hash(state.files.json), state.files.jsonSha256); assert.equal(hash(state.files.markdown), state.files.markdownSha256);
        writeFileSync(join(output, `${scenario}-report.json`), state.files.json); writeFileSync(join(output, `${scenario}-report.md`), state.files.markdown);
      }
      verified.push({ scenario, taskId: job.id, orderId: state.orderId, state: job.state, payment: state.payment, acceptance: state.acceptance, remediation: state.remediation, charges: ledger.charges, refunds: ledger.refunds });
    } finally { store.close(); }
  }
  assert(events.some((e: any) => e.type === 'turn.completed'), 'No successful real model turn');
  const calls = events.filter((e: any) => e.item?.type === 'mcp_tool_call'); assert(calls.length > 0);
  const result = { startedAt, completedAt: new Date().toISOString(), environment: 'simulated', input: fileSnapshot ? { source: 'local-file', sha256: fileSnapshot.sha256, rows: fileSnapshot.rowCount } : { source: 'fixed-dataset' }, client: 'real Codex CLI agent', a2aTransport: 'thin MCP bridge forwarding actual A2A JSON-RPC', toolCalls: calls.length, verified };
  writeFileSync(join(output, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const { gateway, server } of instances) { await gateway.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  rmSync(temp, { recursive: true, force: true });
}
