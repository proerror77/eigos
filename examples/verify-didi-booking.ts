// Explicit official-mock rehearsal with a real Worker, Luna and native Ontology
// MCP. The observer approves only the one printed synthetic vehicle/estimate.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { createWorker } from '../apps/worker/runtime.js';
import { readConfig } from '../packages/core/config.js';
import type { Job } from '../packages/core/domain.js';

assert(process.argv.includes('--official-mock'), 'Explicit --official-mock required; this verifier never targets production.');
const output = resolve(process.env.EIGOS_MOCK_VERIFY_OUTPUT ?? `data/didi-booking-verification/${randomUUID()}`);
mkdirSync(output, { recursive: true, mode: 0o700 });
const save = (name: string, value: unknown) => writeFileSync(join(output, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`, token = randomBytes(32).toString('hex');
const config = readConfig({ NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(address.port), PUBLIC_URL: base, DATABASE_PATH: join(output, 'tasks.sqlite'),
  EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, EIGOS_ACTION_SANDBOX: 'true', EIGOS_EXECUTOR: 'codex', EIGOS_CODEX_BIN: process.env.EIGOS_CODEX_BIN ?? 'codex',
  EIGOS_CODEX_MODEL: 'gpt-6-luna', EIGOS_CODEX_REASONING_EFFORT: 'medium', EIGOS_CODEX_SERVICE_TIER: 'priority',
  EIGOS_DIDI_KEY_FILE: process.env.EIGOS_DIDI_KEY_FILE, EIGOS_DIDI_KEY_SHA256: process.env.EIGOS_DIDI_KEY_SHA256, EIGOS_DIDI_BINDING_ID: process.env.EIGOS_DIDI_BINDING_ID,
  EIGOS_DIDI_ENVIRONMENT: 'mock', EIGOS_DIDI_ORDERS_ENABLED: 'mock', EIGOS_DIDI_AUDIT_DIR: join(output, 'provider') });
let gateway: ReturnType<typeof createApp> | undefined, worker: ReturnType<typeof createWorker> | undefined;
const client = new Client({ name: 'eigos-official-mock-observer', version: '1' });
const started = Date.now();
try {
  gateway = createApp(config); server.on('request', gateway.app); worker = createWorker(config);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
  const rpc = async (method: string, params: object) => { const response = await fetch(base + '/a2a', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), signal: AbortSignal.timeout(10000) }); const body = await response.json(); assert.equal(response.status, 200); assert(!body.error); return body.result; };
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: headers.Authorization } } }));
  const goal = '这是滴滴官方 Mock 模拟验证，不是真实出行。请查询北京市从“西二旗-地铁站”到“龙泽-地铁站”的“快车”估价，用来源中唯一精确同名地点。展示车型和预估价并等待准确计划授权，然后创建一个模拟订单，独立查询原订单号和当前司机状态即完成。不要真实叫车、付款、取消；不要把模拟状态当作真实行程完成。';
  const resumeTask = process.env.EIGOS_MOCK_VERIFY_TASK_ID;
  const submitted = await client.callTool(resumeTask ? { name: 'get_task', arguments: { taskId: resumeTask } } : { name: 'submit_task', arguments: { service: 'eigos.delegate', goal, requirements: [{ id: 'origin', kind: 'location', role: 'origin', strength: 'hard', expected: { ref: '西二旗-地铁站' } }, { id: 'destination', kind: 'location', role: 'destination', strength: 'hard', expected: { ref: '龙泽-地铁站' } }], executionEnvironment: 'sandbox', executionBudget: 'extended', requestId: randomUUID() } });
  // The public MCP tool is discovered by this verifier's normal client.
  assert(!submitted.isError, 'MCP submission rejected');
  let job = (submitted.structuredContent as { result: Job }).result;
  if (resumeTask && job.state === 'paused') {
    const resumed = await client.callTool({ name: 'resume_task', arguments: { taskId: job.id, expectedRevision: job.revision, executionBudget: 'extended', requestId: randomUUID() } });
    assert(!resumed.isError, 'Technical resume rejected'); job = (resumed.structuredContent as { result: Job }).result;
  }
  assert(job?.id); console.log(JSON.stringify({ taskId: job.id, phase: 'submitted' })); save('submission.json', job);
  let approvals = gateway.store.grants(JSON.stringify(['local-development', 'local', 'developer']), job.id).length;
  while (Date.now() - started < 600000) {
    const response = await client.callTool({ name: 'get_task', arguments: { taskId: job.id, waitMs: 30000 } }, { timeout: 40000 }); assert(!response.isError);
    const publicTask = (response.structuredContent as { result: Job }).result; save('public-task.json', publicTask);
    job = gateway.store.get(JSON.stringify(['local-development', 'local', 'developer']), publicTask.id); save('task.json', job);
    console.log(JSON.stringify({ taskId: job.id, state: job.state, phase: job.delegation?.phase, modelRuns: job.runs?.length ?? 0, elapsedSeconds: (Date.now() - started) / 1000 }));
    if (job.state === 'auth-required') {
      const approval = job.delegation?.authorizationRequest; assert(approval && approval.environment === 'sandbox' && approval.realOperationsAllowed === false);
      assert.equal(approvals, 0, 'Never automatically approve a replacement order');
      const plan = job.delegation!.agent!.plans.find(p => p.digest === approval.planDigest)!;
      assert.equal(plan.steps.length, 1); const step = plan.steps[0]!; assert.equal(step.action, 'CreateDidiRide'); assert.equal(step.input.productName, '快车'); assert.equal(step.input.fareBasis, 'estimate_not_final_fare');
      console.log(JSON.stringify({ phase: 'confirm_mock_vehicle_and_estimate', productName: step.input.productName, priceText: step.input.priceText, planDigest: approval.planDigest }));
      assert(approval.confirmation && approval.confirmation.details.some(line => line.includes(String(step.input.priceText))), 'Public confirmation must display the approved estimate');
      save('approved-mock-plan.json', { approval, plan });
      const response = await fetch(`${base}/tasks/${job.id}/authorize`, { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), action: 'approve_plan', planDigest: approval.planDigest, allowedEffects: approval.effects, maxAmount: approval.maxAmount, payeeIds: approval.payeeIds, expiresAt: new Date(Date.now() + 120000).toISOString(), environment: 'sandbox' }) });
      assert.equal(response.status, 200); approvals++; continue;
    }
    if (!['submitted', 'working'].includes(job.state)) break;
  }
  assert.equal(job.state, 'completed', `Inspect private task.json: ${job.state}`); assert(job.delegation?.acceptance?.accepted);
  assert.equal(approvals, 1);
  const a2a = await rpc('GetTask', { id: job.id }); save('a2a-readback.json', a2a);
  assert.deepEqual(a2a.artifacts[0].parts[0].data, job.artifact!.data);
  assert(job.runs?.length && job.runs.every(run => run.modelConfiguration?.model === 'gpt-6-luna' && run.modelConfiguration.serviceTier === 'priority'));
  const sessions = job.runs.filter(run => run.ontologyMcp); assert(sessions.length && sessions.every(run => run.ontologyMcp!.taskId === job.id));
  const acceptedRunIds = new Set([
    ...job.delegation!.agent!.plans.map(plan => plan.modelRunId),
    ...job.delegation!.agent!.composition!.contexts.map(context => context.initializedBy.modelRunId),
    job.delegation!.agent!.completion?.modelRunId,
  ].filter(Boolean));
  assert(acceptedRunIds.size && [...acceptedRunIds].every(id => sessions.some(run => run.id === id && run.ontologyMcp!.decisionSubmitted)), 'Every accepted execution decision needs its original successful native session');
  const summary = { taskId: job.id, completed: true, accepted: true, environment: 'provider_mock', explicitCallerRouteRequirements: true, realOperationsAllowed: false, protocolReadbacksEqual: true,
    elapsedSeconds: (Date.parse(job.updatedAt) - Date.parse(job.createdAt)) / 1000, observerSeconds: (Date.now() - started) / 1000, modelRuns: job.runs.length, modelSeconds: job.runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0) / 1000,
    modelConfiguration: job.runs[0]!.modelConfiguration, nativeOntologySessions: sessions.length, acceptedDecisionSessions: acceptedRunIds.size, unsuccessfulNativeSessions: sessions.filter(run => !run.ontologyMcp!.decisionSubmitted).length, nativeOntologyToolCalls: sessions.reduce((sum, run) => sum + (run.nativeMcpCalls?.length ?? 0), 0) };
  save('summary.json', summary); console.log(JSON.stringify(summary));
} finally {
  await client.close().catch(() => {}); await worker?.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await gateway?.close();
}
