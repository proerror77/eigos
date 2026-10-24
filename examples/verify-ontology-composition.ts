// Opt-in real PA + Worker model acceptance. Fresh loopback Gateway/database and
// explicit synthetic catalog per case; no production process or credential is read.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { Coordinator, CodexReasoner } from '../packages/coordinator/coordinator.js';
import { CodexExecutor, type Executor } from '../packages/capabilities/executor.js';
import { AgentReadError } from '../packages/core/agent-program.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { CatalogAgentProgram } from '../packages/capabilities/catalog-agent.js';
import { DocumentAgentProgram } from '../packages/capabilities/document-agent.js';
import { GeoAgentProgram } from '../packages/capabilities/geo-agent.js';
import { OntologyMcpPaotuiReader } from '../packages/capabilities/paotui-mcp.js';
import { PaotuiGeoDiscoverySource } from '../packages/capabilities/paotui-geo-discovery.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { AnonymousShopifyConnector, type CatalogConnector } from '../packages/capabilities/shopify/connector.js';
import { readConfig } from '../packages/core/config.js';
import { JobStore } from '../packages/core/store.js';
import { digest } from '../packages/core/delegation.js';
import { ownerKey, type Job } from '../packages/core/domain.js';
import { executionBudgetStatus } from '../packages/core/execution-budget.js';
import { catalogObservationSchema } from '../packages/ontology/catalog-agent.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { scenario: { type: 'string', default: 'all' }, output: { type: 'string' }, resume: { type: 'boolean', default: false } } });
const cases = ['normal', 'changed_facts', 'second_service_failure', 'real_sources'] as const;
type Scenario = typeof cases[number];
const selected = values.scenario === 'all' ? cases.filter(value => value !== 'real_sources') : cases.filter(value => value === values.scenario);
assert(selected.length, 'Choose normal, changed_facts, second_service_failure, real_sources or all');
const root = resolve(values.output ?? join(repo, 'data/ontology-composition-verification/native', new Date().toISOString().replaceAll(':', '-')));
mkdirSync(root, { recursive: true, mode: 0o700 });
const syntheticGoal = '请在已配置的 Coffee Lab 隔离测试商家中查到两款不同的咖啡候选，并交付一份基于这两款已核验来源信息的中文 Markdown 比较文档。每款列出名称、变体 ID、当前显示价格、币种和来源，注明库存数量、配送承诺和商家合作状态中尚未核验的部分。目录可能只返回部分候选。只做只读查询与文档生成，不创建购物车、不预订、不下单、不付款。';
const merchant = { id: 'coffee-lab', name: 'Coffee Lab', shopId: 'gid://shopify/Shop/9012', domain: 'eigos-coffee-fixture.myshopify.com' };
const variantIds = [9034, 9035, 9036, 9037].map(value => `gid://shopify/ProductVariant/${value}`);
const capabilities = Object.fromEntries(['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.catalog.lookup', 'dev.shopify.catalog', 'dev.shopify.catalog.global'].map(id => [id, [{ version: '2026-08-25' }]]));
const sourceHashes = () => Object.fromEntries(execFileSync('rg', ['--no-index', '--files', '--', 'apps', 'packages'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').sort().map(path => [path, createHash('sha256').update(readFileSync(join(repo, path))).digest('hex')]));
const safeError = (error: unknown) => ({ name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message.slice(0, 2000).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]') : 'Unknown failure' });
async function body(req: IncomingMessage) { let input = ''; for await (const chunk of req) { input += String(chunk); if (input.length > 65536) throw new Error('Fixture request exceeds bound'); } return input ? JSON.parse(input) : {}; }

async function verify(scenario: Scenario) {
  const live = scenario === 'real_sources', goal = live ? '请查询已配置的 Purity Coffee 商家的公开咖啡商品信息，并读取北京市天安门的公开地点查询结果，交付一份中文 Markdown 只读信息报告。两部分分别注明来源、观察范围和未知事项，不能把商品商家与公开地点自动视为同一实体，也不能断言该商品可向该地点配送。只读取已准入的公开来源，不读取私人地址簿，不创建购物车、不预订、不下单、不付款。' : syntheticGoal;
  const generatorSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  const directory = join(root, scenario); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const priorPath = join(directory, 'verification.json'), prior = values.resume && existsSync(priorPath) ? JSON.parse(readFileSync(priorPath, 'utf8')) : undefined;
  if (prior) { const archive = join(directory, 'attempts', new Date().toISOString().replaceAll(':', '-')); mkdirSync(archive, { recursive: true, mode: 0o700 }); for (const name of ['verification.json', 'pa-events.json', 'pa-final.md', 'private-task.json']) if (existsSync(join(directory, name))) copyFileSync(join(directory, name), join(archive, name)); }
  const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const token = `native-fixture-${randomUUID()}-${randomUUID()}`, database = join(directory, 'gateway.sqlite'), startedAt = new Date().toISOString(), started = Date.now(), manifest = sourceHashes();
  const sourceRequests: Record<string, unknown>[] = prior?.sourceRequests ?? [], connectorCalls: Record<string, unknown>[] = prior?.connectorCalls ?? [], documentCalls: Record<string, unknown>[] = prior?.documentCalls ?? [], workerErrors: unknown[] = [], events: any[] = [];
  let searches = sourceRequests.filter(value => value.operation === 'search_catalog').length, claims = 0, taskId: string | undefined, job: Job | undefined, failure: ReturnType<typeof safeError> | undefined;
  const source = createServer((req, res) => { void (async () => {
    const wire = await body(req), request = wire.body ? JSON.parse(wire.body) : undefined, operation = request?.params?.name ?? 'discovery', args = request?.params?.arguments?.catalog;
    assert(['discovery', 'search_catalog', 'get_product', 'lookup_catalog'].includes(operation), 'Fixture never accepts a business write');
    let ids = operation === 'get_product' ? [String(args.id)] : operation === 'lookup_catalog' ? args.ids as string[] : [...variantIds];
    if (operation === 'search_catalog') { searches++; if (scenario === 'changed_facts') ids = searches === 1 ? variantIds.slice(0, 1) : variantIds.slice(1); }
    assert(ids.every(id => variantIds.includes(id)), 'Only observed synthetic product IDs exist');
    sourceRequests.push({ ordinal: sourceRequests.length + 1, at: new Date().toISOString(), logicalEndpoint: wire.endpoint, transport: 'actual_loopback_http', operation, arguments: args ?? null, returnedVariantIds: operation === 'discovery' ? [] : ids });
    const result = operation === 'discovery' ? { ucp: { version: '2026-08-25', capabilities, services: { 'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp', endpoint: `https://${merchant.domain}/api/ucp/mcp` }] } } }
      : { jsonrpc: '2.0', id: request.id, result: { structuredContent: { ucp: { version: '2026-08-25', status: 'success', capabilities }, [operation === 'get_product' ? 'product' : 'products']: operation === 'get_product' ? product(ids) : [product(ids)], messages: [] } } };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
  })().catch(error => { sourceRequests.push({ at: new Date().toISOString(), rejected: safeError(error) }); res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'fixture_request_rejected' })); }); });
  function product(ids: string[]) { return { id: 'gid://shopify/Product/9001', title: 'Synthetic coffee', variants: ids.map(id => ({ id, title: ['Light roast', 'Medium roast', 'Dark roast', 'Espresso roast'][variantIds.indexOf(id)], sku: `FIXTURE-${variantIds.indexOf(id)}`, price: { amount: (variantIds.indexOf(id) + 1) * 1000, currency: 'USD' }, seller: { id: merchant.shopId, name: merchant.name, domain: merchant.domain }, availability: { available: true }, eligible: { native_checkout: false }, inputs: [{ id, match: 'exact' }] })) }; }
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  const sourceAddress = source.address(); assert(sourceAddress && typeof sourceAddress !== 'string'); const sourceUrl = `http://127.0.0.1:${sourceAddress.port}`;
  const fetcher: typeof fetch = async (endpoint, init = {}) => fetch(sourceUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: String(endpoint), method: init.method ?? 'GET', body: init.body ? String(init.body) : null }), signal: init.signal });
  const transport = new AnonymousShopifyConnector(join(directory, 'catalog-http'), live ? undefined : fetcher), connector: CatalogConnector = { evidenceKind: live ? 'live_readonly' : 'fixture', invoke: async (context, call, signal) => { const value = await transport.invoke(context, call, signal); connectorCalls.push({ ...context, call, receipt: value.receipt }); return value; } };
  const native = new CodexExecutor(process.env.EIGOS_CODEX_BIN ?? 'codex', 120000);
  const executor: Executor = { run: async (input, signal) => {
    const call: Record<string, unknown> = { taskId: input.id, at: new Date().toISOString(), suppliedInputDigest: digest(input.messages), outcome: 'running' }; documentCalls.push(call);
    if (scenario === 'second_service_failure') { call.outcome = 'injected_outage'; throw new AgentReadError('The isolated document service is unavailable in this fault-injection case; no document was generated. Preserve the accepted source result and report this service failure.'); }
    const result = await native.run(input, signal); call.outcome = result.output.decision; call.run = result.evidence; return result;
  } };
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, PUBLIC_URL: base, DATABASE_PATH: database, EIGOS_AUDIT_PATH: join(directory, 'gateway-http.jsonl'), EIGOS_EXECUTOR: 'codex' }), undefined,
    store => {
      if (!live) return createExecutionCatalog({ store, documentEnabled: true, documentExecutor: executor, shopifyCatalog: { merchants: [merchant], connector } });
      const reader = new OntologyMcpPaotuiReader('/Users/proerror/.codex/skills/meituan-paotui', join(directory, 'public-geo-audit.jsonl'));
      const source = new PaotuiGeoDiscoverySource(reader, reader.configurationDigest, [{ city: '北京市', keyword: '天安门' }]);
      const programs = [new CatalogAgentProgram([{ id: 'purity-coffee', name: 'Purity Coffee', shopId: 'gid://shopify/Shop/40613871783', domain: 'purity-coffee.myshopify.com' }], { connector }), new GeoAgentProgram(source.adapter, source.configurationDigest), new DocumentAgentProgram(executor)];
      return new ExecutionCatalog(programs.map(program => program.capability()), [], [], [], programs);
    });
  server.on('request', gateway.app);
  const owner = ownerKey({ issuer: 'local-development', tenant: 'local', subject: 'developer', clientId: '', scopes: [] });
  const coordinator = new Coordinator(gateway.store, new CodexReasoner(native), gateway.catalog, { maxTaskMs: 1200000 });
  const overall = new AbortController(), timer = setTimeout(() => overall.abort(new Error('Native acceptance reached its 20 minute bound')), 1200000);
  const worker = new Worker(gateway.store, { pollMs: 100, leaseMs: 15000, timeoutMs: 300000, coordinator: { run: async (claim, signal) => {
    claims++; assert(claims <= 50, 'Native exercise exceeded its Worker claim bound');
    console.log(JSON.stringify({ scenario, event: 'worker_claim', claim: claims, phase: claim.job.delegation?.phase, taskId: claim.job.id }));
    try { await coordinator.run(claim, AbortSignal.any([signal, overall.signal])); }
    catch (error) { workerErrors.push({ claim: claims, ...safeError(error) }); throw error; }
  } } });
  const cwd = mkdtempSync(join(tmpdir(), 'eigos-composition-pa-'));
  try {
    const previousJobs = gateway.store.list(owner, { limit: 100, offset: 0 }).jobs;
    if (values.resume) { assert.equal(previousJobs.length, 1); assert.equal(previousJobs[0]!.goal, goal); taskId = previousJobs[0]!.id; } else assert.equal(previousJobs.length, 0, 'Use --resume for an existing original task');
    worker.start();
    let prompt = `你是独立的 Personal Agent。本次已授权调用本地隔离验收 Gateway 中已准入的来源（真实性以绑定元数据为准），完成下面这个业务目标。只使用 eigos MCP 工具，不使用其他执行工具。先发现服务，再提交且只提交一个 eigos.delegate 任务；executionEnvironment=${live ? 'live' : 'sandbox'}，executionBudget=extended。goal 必须逐字使用下文，requestId 保持稳定。无需也不得授予订单、付款或任何外部写操作许可。\n\n${goal}\n\n用实际返回的 taskId 读取原任务；submitted/working 时以 get_task 的 waitMs=30000 等待，最多 40 次。正在运行不是失败，不创建替代任务。若需要业务信息，只使用上述已知事实作答；技术 paused、auth-required 或服务失败应如实报告而不编造信息。最终再次读取原任务，报告原 taskId、真实状态以及交付物中的完整比较文档。若只有部分成果，保留并报告它，明确哪个目标没有完成。`;
    if (values.resume) prompt = `你是独立的 Personal Agent，继续本地 EIGOS 的原任务 ${taskId}。该任务的运行校验问题已修复。本次已授权技术恢复；不要提交新任务，不改变原始业务目标或已确认事实，不授予任何业务写入许可。只使用 eigos MCP。先 get_task 读取原状态与 revision；若 paused，使用 resume_task 和该 expectedRevision 恢复原任务，executionBudget=extended。submitted/working 时用 get_task(waitMs=30000) 继续等待，最多 40 次。最终再次读取同一 taskId，输出真实状态和完整比较文档；若服务失败，仅报告已有成果和未完成条件。原始业务目标仍为：${goal}`;
    const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--approve-for-me', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
      ...['shell_tool', 'apps', 'plugins', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'image_generation', 'code_mode'].flatMap(feature => ['--disable', feature]),
      '-c', `mcp_servers.eigos.url=${JSON.stringify(base + '/mcp')}`, '-c', 'mcp_servers.eigos.bearer_token_env_var="EIGOS_ACCEPTANCE_TOKEN"', '--output-last-message', join(directory, 'pa-final.md'), '--json', '-'];
    await new Promise<void>((resolveRun, rejectRun) => {
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE']) if (process.env[key]) env[key] = process.env[key];
      env.EIGOS_ACCEPTANCE_TOKEN = token; env.NO_PROXY = [env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
      const child = spawn(process.env.EIGOS_CODEX_BIN ?? 'codex', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      const kill = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
      overall.signal.addEventListener('abort', kill, { once: true });
      let buffer = '', size = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length; if (size > 8_000_000) { kill(); return; }
        buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
        for (const line of lines) try {
          const event = JSON.parse(line.replaceAll(token, '[redacted]'));
          if (['thread.started', 'turn.completed', 'turn.failed', 'error'].includes(event.type) || event.type === 'item.completed' && ['mcp_tool_call', 'agent_message'].includes(event.item?.type)) events.push(event);
          if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') console.log(JSON.stringify({ scenario, event: 'pa_tool', tool: event.item.tool, status: event.item.status }));
        } catch {}
      });
      child.stderr.on('data', () => {}); child.stdin.on('error', () => {}); child.on('error', rejectRun);
      child.on('close', code => { overall.signal.removeEventListener('abort', kill); code === 0 ? resolveRun() : rejectRun(new Error(`Native PA exited ${code}; preserve the original task`)); });
      child.stdin.end(prompt);
    });
    overall.signal.throwIfAborted();
    const jobs = gateway.store.list(owner, { limit: 100, offset: 0 }).jobs;
    assert.equal(jobs.length, 1, 'The PA must create exactly one original task'); job = jobs[0]!; taskId = job.id;
    assert.equal(job.goal, goal, 'The PA changed the assigned business goal');
    const calls = events.filter(event => event.item?.type === 'mcp_tool_call' && event.item.server === 'eigos');
    assert(events.some(event => event.type === 'turn.completed')); assert(calls.some(event => event.item.tool === (values.resume ? 'resume_task' : 'submit_task')));
    const callerThread = events.find(event => event.type === 'thread.started')?.thread_id;
    assert(callerThread && job.runs?.length && job.runs.every(run => run.runtime === 'codex-exec' && run.threadId && run.threadId !== callerThread));
    const state = job.delegation!.agent!; assert(state?.composition && state.programRef.id === 'eigos.goal'); assert.equal(job.delegation!.plan, undefined);
    assert.equal(gateway.store.grants(owner, taskId).length, 0); assert(gateway.store.intents(owner, taskId).every(intent => ['read', 'local'].includes(intent.effect)));
    const steps = state.plans.flatMap(plan => plan.steps); assert(steps.some(step => step.binding?.programRef.id === 'commerce.catalog.query')); assert(steps.some(step => step.binding?.programRef.id === 'document.compose'));
    assert(steps.every(step => step.binding && state.plans.find(plan => plan.steps.includes(step))!.modelRunId));
    assert(connectorCalls.length && documentCalls.length, 'Both independent components must actually be invoked');
    if (live) { assert(steps.some(step => step.binding?.programRef.id === 'geo.search.atomic')); assert.equal(sourceRequests.length, 0, 'Real-source verification must not use the synthetic HTTP fixture'); assert(gateway.store.intents(owner, taskId).some(intent => intent.state === 'effect_confirmed' && (intent.acceptedOutput?.ports as { evidence: { origin: string } }[] | undefined)?.some(port => port.evidence.origin === 'provider') && steps.find(step => step.intentId === intent.id)?.binding?.programRef.id === 'geo.search.atomic')); }
    assert(job.artifact, 'The original task must retain its available artifact');
    const readbacks = calls.filter(event => event.item.tool === 'get_task').flatMap(event => {
      const value = event.item.result; const structured = value?.structured_content ?? value?.structuredContent;
      if (structured?.result) return [structured.result];
      return (value?.content ?? []).flatMap((part: { type: string; text?: string }) => { try { return part.type === 'text' && part.text ? [JSON.parse(part.text)] : []; } catch { return []; } });
    });
    assert(readbacks.some(read => read.id === taskId && read.state === job!.state && digest(read.artifact) === digest(job!.artifact)), 'The PA did not independently read the identical original task artifact');
    const response = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'A2A-Version': '1.0', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'GetTask', params: { id: taskId } }) });
    assert(response.ok); const wire = await response.json() as { result: { id: string; artifacts?: { parts: { data?: unknown; text?: string }[] }[] } };
    assert.equal(wire.result.id, taskId); assert.equal(digest(wire.result.artifacts?.[0]?.parts[0]?.data), digest(job.artifact.data));
    const independent = new JobStore(database); try { assert.equal(digest(independent.get(owner, taskId).artifact), digest(job.artifact)); } finally { independent.close(); }
    if (scenario === 'second_service_failure') {
      assert.notEqual(job.state, 'completed'); assert.equal(job.artifact.data.execution, 'partial'); assert(!job.delegation!.acceptance?.accepted);
      assert(gateway.store.intents(owner, taskId).some(intent => intent.state === 'effect_confirmed' && steps.find(step => step.intentId === intent.id)?.binding?.programRef.id === 'commerce.catalog.query'));
      assert(documentCalls.every(call => call.outcome === 'injected_outage'));
    } else {
      assert.equal(job.state, 'completed', 'The native composed goal did not finish'); assert(state.composition.assessment?.accepted); assert(state.composition.assessment.criteria.every(value => value.result === 'pass'));
      const components = (job.artifact.data.result as { components: { artifact?: Job['artifact'] }[] }).components, document = components.find(value => value.artifact?.data.markdown)?.artifact;
      assert(document?.data.markdown); writeFileSync(join(directory, 'deliverable.md'), document.data.markdown, { mode: 0o600 });
      if (scenario === 'changed_facts') {
        const sourceIntents = gateway.store.intents(owner, taskId).filter(intent => intent.state === 'effect_confirmed').flatMap(intent => { const parsed = catalogObservationSchema.safeParse(intent.lastVerifiedResult?.output?.source); return parsed.success && parsed.data.action === 'SearchPublicCatalog' ? [{ intentId: intent.id, snapshot: parsed.data }] : []; });
        assert(sourceIntents.length >= 2 && sourceIntents.some(value => value.snapshot.items.length === 1), 'Changed facts did not produce a new model-selected source query');
      }
    }
    assert.deepEqual(sourceHashes(), manifest, 'Runtime sources changed during the native verification');
    assert.equal(createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), generatorSha256, 'The acceptance driver changed during this run');
    save('a2a-readback.json', wire); save('original-artifact.json', job.artifact);
  } catch (error) { failure = safeError(error); }
  finally {
    clearTimeout(timer); overall.abort(); await worker.close();
    const jobs = gateway.store.list(owner, { limit: 100, offset: 0 }).jobs; job ??= jobs.find(value => value.goal === goal); taskId ??= job?.id;
    if (job) { job = gateway.store.get(owner, job.id); save('private-task.json', job); }
    const intents = taskId ? gateway.store.intents(owner, taskId) : [], state = job?.delegation?.agent;
    const result = { version: 1, passed: !failure, scenario, resumedOriginalTask: values.resume, priorAttempt: prior ? { startedAt: prior.startedAt, taskId: prior.taskId, passed: prior.passed, failure: prior.failure, runtimeManifestDigest: digest(prior.runtimeSourceSha256) } : undefined, startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started, goal, taskId, taskState: job?.state, wholeGoalAccepted: state?.composition?.assessment?.accepted ?? false,
      boundary: live ? 'Actual native Codex PA and Worker with two existing configured public read-only sources: anonymous Shopify catalog and the allowlisted Meituan public POI query. Private development Gateway only; merchant relationship, supply, delivery and business authorization remain unverified. No private address reads, order, payment or deployment.' : 'Actual native Codex PA and Worker, private loopback MCP/A2A, synthetic catalog transported over HTTP and a separate bounded document model. No real merchant integration, live orders, payment or deployment.',
      generatorSha256,
      modelSelection: 'Native Codex default; no model/provider override. Absent reported model IDs remain unknown.', claims, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), runtimeSourceSha256: manifest,
      callerThreadId: events.find(event => event.type === 'thread.started')?.thread_id, modelRuns: job?.runs, executionBudget: job ? executionBudgetStatus(job) : undefined,
      goalContract: state?.composition?.goal, assessment: state?.composition?.assessment, decisions: state?.plans.map(plan => ({ id: plan.id, digest: plan.digest, modelRunId: plan.modelRunId, modelDecision: plan.modelDecision, steps: plan.steps, ontologyPlanning: plan.ontologyPlanning })),
      sourceRequests, connectorCalls, documentCalls, workerErrors, intents: intents.map(intent => ({ id: intent.id, state: intent.state, effect: intent.effect, planDigest: intent.planDigest, bindingRef: intent.bindingRef, observationId: intent.latestObservationId, acceptedPorts: intent.acceptedOutput?.ports })),
      artifactDigest: job?.artifact ? digest(job.artifact) : undefined, noBusinessWrites: intents.every(intent => ['read', 'local'].includes(intent.effect)), failure };
    save('verification.json', result); save('pa-events.json', events);
    if (existsSync(join(directory, 'pa-final.md'))) writeFileSync(join(directory, 'pa-final.md'), readFileSync(join(directory, 'pa-final.md'), 'utf8').replaceAll(token, '[redacted]'), { mode: 0o600 });
    await gateway.close(); server.closeAllConnections(); source.closeAllConnections();
    await Promise.all([new Promise<void>(resolveClose => server.close(() => resolveClose())), new Promise<void>(resolveClose => source.close(() => resolveClose()))]); rmSync(cwd, { recursive: true, force: true });
    console.log(JSON.stringify({ scenario, passed: !failure, taskId, state: job?.state, output: directory, failure }));
    if (failure) throw new Error(`${scenario}: ${failure.message}`);
  }
}

for (const scenario of selected) await verify(scenario);
