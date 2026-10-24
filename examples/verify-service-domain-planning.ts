// Real model and real local protocol transports; every business provider is synthetic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { readConfig } from '../packages/core/config.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { Coordinator, CodexReasoner } from '../packages/coordinator/coordinator.js';
import { CodexExecutor } from '../packages/capabilities/executor.js';
import { domainNames, serviceDomain, type DomainParameters, type ServiceDomain } from '../packages/ontology/service-domains.js';
import { businessModel } from '../packages/ontology/business-model.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import { domainProvider } from '../tests/fixtures/service-domains.js';
import type { Job } from '../packages/core/domain.js';
import { digest } from '../packages/core/delegation.js';

if (!process.argv.includes('--live')) throw new Error('Pass --live for real model calls; all business operations remain synthetic');
const output = resolve(process.argv.find(a => a.startsWith('--output='))?.slice(9) ?? 'data/service-domain-model-run');
const requestedDomains = process.argv.find(a => a.startsWith('--domains='))?.slice(10).split(',') ?? [...domainNames];
if (requestedDomains.some(d => !domainNames.includes(d as ServiceDomain))) throw new Error('Unknown requested domain');
mkdirSync(output, { recursive: true, mode: 0o700 });
const sources = domainNames.map(d => domainProvider(d));
function goal(domain: ServiceDomain, raw: object): string {
  let text: string;
  if (domain === 'ride') { const p = raw as DomainParameters['ride']; text = `请为${p.passengers}人安排从 ${p.origin} 到 ${p.destination} 的打车服务，车型 ${p.serviceClass}，最晚 ${p.pickupBy} 上车，${p.arriveBy} 前到达，全部费用预算500元。要求终点为乘车服务完成。`; }
  else if (domain === 'appointment') { const p = raw as DomainParameters['appointment']; text = `请为匿名就诊人引用 ${p.patientKey} 挂号：医院院区 ${p.hospitalId}，科室 ${p.departmentId}，医生 ${p.practitionerId}，就诊时刻 ${p.startsAt}，时区 ${p.timeZone}。请在 ${p.registerBy} 前取得有效挂号确认，挂号费预算500元。`; }
  else if (domain === 'food') { const p = raw as DomainParameters['food']; text = `请从商家 ${p.merchantId} 订外卖，商品 SKU ${p.items[0]!.sku}，规格 ${p.items[0]!.specification}，数量${p.items[0]!.quantity}份，明确排除的食材为 ${p.excludedIngredients.join('、')}。送到 ${p.destination}，在 ${p.deliverBy} 前送达，全部费用预算500元。请完成送达，不接受商品替换。`; }
  else if (domain === 'hotel') { const p = raw as DomainParameters['hotel']; text = `请订酒店 ${p.hotelId}，房型 ${p.roomTypeId}，${p.checkIn} 入住，${p.checkOut} 退房，酒店时区 ${p.timeZone}，${p.rooms}间房、${p.guests}人，取消条款引用 ${p.cancellationPolicyRef}，全部费用预算500元。目标是预订已确认，不要求现在已经完成住宿。`; }
  else if (domain === 'itinerary') { const p = raw as DomainParameters['itinerary']; text = `请为${p.travelers}人整理并验证行程方案，行程窗口 ${p.startsAt} 至 ${p.endsAt}，时区 ${p.timeZone}，全部费用预算500元。第一段标识 ${p.legs[0]!.id}：从 ${p.legs[0]!.origin} 到 ${p.legs[0]!.destination}，${p.legs[0]!.startsAt} 出发、${p.legs[0]!.endsAt} 结束，方式 ${p.legs[0]!.mode}，此前缓冲0分钟，需要预订。第二段标识 ${p.legs[1]!.id}：从 ${p.legs[1]!.origin} 到 ${p.legs[1]!.destination}，${p.legs[1]!.startsAt} 出发、${p.legs[1]!.endsAt} 结束，方式 ${p.legs[1]!.mode}，转乘缓冲20分钟，不需要预订。目标是交付可行方案并披露尚未预订的项目，不要求替我完成预订。`; }
  else { const p = raw as DomainParameters['vehicle']; text = `请确认一项自驾租车预订：驾驶人引用 ${p.driverKey}，车型 ${p.vehicleClass}，${p.passengers}人，取车地点 ${p.pickup}，还车地点 ${p.returnLocation}，租期从 ${p.startsAt} 到 ${p.endsAt}，时区 ${p.timeZone}。服务全部费用预算500元，另有押金上限2000元。目标仅为租车预订确认，不要求现在已取车、还车或押金结清。`; }
  return `这是明确获准的本地合成业务演练，所给标识和记录都是合成数据。只使用沙箱，不实际下单、付款或预约。${text}`;
}
const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`, token = randomUUID();
const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, EIGOS_ACTION_SANDBOX: 'true', PUBLIC_URL: base, DATABASE_PATH: ':memory:' }), undefined, () => createExecutionCatalog({ domainSandboxProviders: sources.map(s => s.provider) }));
server.on('request', gateway.app);
const model = new CodexExecutor(process.env.EIGOS_CODEX_BIN ?? 'codex', 120000);
let activeDomain = ''; const responses: unknown[] = [], failures: unknown[] = [], tasks: unknown[] = [];
const persist = () => writeFileSync(join(output, 'verification.json'), JSON.stringify({ scope: 'Actual Codex reasoning, synthetic domain sources, local A2A/MCP observer; not actual user PA or real business execution', backendVersion: BACKEND_VERSION, model: businessModel.ref, requestedDomains, tasks, responses, failures }, null, 2), { mode: 0o600 });
const coordinator = new Coordinator(gateway.store, new CodexReasoner({ runStructured: async (prompt, schema, signal, options) => {
  const response = await model.runStructured(prompt, schema, signal, options); responses.push({ domain: activeDomain, evidence: response.evidence, output: response.output });
  appendFileSync(join(output, 'model-turns.jsonl'), JSON.stringify({ domain: activeDomain, evidence: response.evidence, output: response.output }) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ domain: activeDomain, modelTurn: responses.length, receiptId: response.evidence.id })); return response;
} }), gateway.catalog, { allowSandbox: true });
const worker = new Worker(gateway.store, { coordinator: { run: async (claim, signal) => { try { await coordinator.run(claim, signal); } catch (error) { failures.push({ domain: activeDomain, taskId: claim.job.id, message: error instanceof Error ? error.message : String(error) }); throw error; } } }, pollMs: 100, leaseMs: 15000, timeoutMs: 600000 }); worker.start();
const client = new Client({ name: 'domain-protocol-observer', version: '1' });
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
async function rpc(method: string, params: object) {
  const response = await fetch(base + '/a2a', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
  const body = await response.json(); assert(response.ok && !body.error, JSON.stringify(body)); return body.result.task ?? body.result;
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  for (const requested of requestedDomains) {
    const domain = requested as ServiceDomain, f = sources.find(s => s.provider.domain === domain)!; activeDomain = domain;
    const initial = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', executionEnvironment: 'sandbox', goal: goal(domain, f.parameters) } }] } });
    console.log(JSON.stringify({ domain, taskId: initial.id, state: initial.status.state }));
    const deadline = Date.now() + 590000; let task = initial, approved = false;
    do {
      task = await rpc('GetTask', { id: initial.id });
      if (task.status.state === 'TASK_STATE_AUTH_REQUIRED' && !approved) {
        const authorization = task.metadata.delegation.authorizationRequest;
        assert.equal(authorization.environment, 'sandbox'); assert.equal(authorization.realOperationsAllowed, false); assert.equal(authorization.maxAmount.minor, '0'); assert.deepEqual(authorization.effects, [serviceDomain(domain).effect]);
        const response = await fetch(base + `/tasks/${initial.id}/authorize`, { method: 'POST', headers, body: JSON.stringify({ action: 'approve_plan', requestId: randomUUID(), planDigest: authorization.planDigest, allowedEffects: authorization.effects, maxAmount: authorization.maxAmount, payeeIds: authorization.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }) });
        assert.equal(response.status, 200); approved = true; continue;
      }
      if (!['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(task.status.state)) break;
      await pause(1000);
    } while (Date.now() < deadline);
    const response = await client.callTool({ name: 'get_task', arguments: { taskId: initial.id } }); assert(!response.isError);
    const readback = (response.structuredContent as { result: Job }).result;
    const actualReads = readback.delegation?.ontologyReads ?? [];
    const semantic = (v: unknown): unknown => Array.isArray(v) ? v.map(semantic) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, semantic(x)])) : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : v;
    const parametersMatch = digest(semantic(readback.delegation?.plan?.steps[0]?.input ?? null)) === digest(semantic(f.parameters));
    const domainReadProven = responses.some(value => {
      const r = value as { domain: string; output: { calls?: { tool: string; argumentsJson: string }[] } };
      return r.domain === domain && r.output.calls?.some(c => {
        let args; try { args = JSON.parse(c.argumentsJson); } catch { return false; }
        return c.tool === 'evaluate_ontology' && args.function === serviceDomain(domain).eligibleFunction && args.object?.type === serviceDomain(domain).candidateType && actualReads.some(receipt => receipt.tool === c.tool && receipt.status === 'ok' && receipt.inputDigest === digest(args));
      });
    });
    const modelReceiptsProven = (readback.runs?.length ?? 0) >= 4 && readback.runs!.every(r => r.runtime === 'codex-exec' && r.threadId && r.outputSha256);
    const status = { domain, taskId: readback.id, state: readback.state, modelRuns: readback.runs?.length ?? 0, ontologyReads: actualReads.length, sourceCalls: f.counters(), approved, parametersMatch, domainReadProven, modelReceiptsProven, protocolMatch: task.id === readback.id && (readback.artifact ? task.artifacts?.[0]?.artifactId === readback.artifact.id && digest(task.artifacts[0].parts[0].data) === digest(readback.artifact.data) : true) };
    tasks.push({ ...status, task, readback }); persist(); console.log(JSON.stringify(status));
    if (['working', 'submitted'].includes(readback.state)) { failures.push({ domain, message: 'Verification deadline exceeded; preserve this operation identity' }); break; }
  }
} finally {
  persist();
  await client.close(); await worker.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await gateway.close();
}
if (tasks.length !== requestedDomains.length || tasks.some(value => { const t = value as { state: string; parametersMatch: boolean; domainReadProven: boolean; modelReceiptsProven: boolean; protocolMatch: boolean }; return t.state !== 'completed' || !t.parametersMatch || !t.domainReadProven || !t.modelReceiptsProven || !t.protocolMatch; })) process.exitCode = 1;
