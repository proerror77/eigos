// Real source/model validation through the existing local Gateway and Worker.
// This observer does not receive a DiDi Key or call its business tools directly.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readConfig } from '../packages/core/config.js';
import { DIDI_PROGRAM_REF } from '../packages/capabilities/didi/program.js';
import { checkedRideEstimate } from '../packages/ontology/ride-estimate-projection.js';
import type { Job } from '../packages/core/domain.js';

if (!process.argv.includes('--live')) throw new Error('Use --live only for authorized, public-place read validation');
const argument = (name: string) => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${name}`); return resolve(process.argv[i + 1]!); };
const configPath = argument('--config'), output = argument('--output');
const modeIndex = process.argv.indexOf('--mode'), selectedMode = modeIndex < 0 ? undefined : process.argv[modeIndex + 1];
assert(selectedMode === undefined || ['places', 'estimate'].includes(selectedMode), 'Invalid --mode');
assert(isAbsolute(configPath) && isAbsolute(output)); mkdirSync(output, { recursive: true, mode: 0o700 });
const config = readConfig(parseEnv(readFileSync(configPath, 'utf8')));
assert.equal(config.EIGOS_AUTH_MODE, 'development'); assert.equal(config.EIGOS_DIDI_ENVIRONMENT, 'production'); assert(config.EIGOS_DIDI_KEY_FILE); assert.equal(config.EIGOS_DIDI_ORDERS_ENABLED, 'false');
const headers = { Authorization: `Bearer ${config.EIGOS_DEV_TOKEN}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
const rpc = async (method: string, params: object) => {
  const response = await fetch(config.PUBLIC_URL + '/a2a', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); const body = await response.json(); assert(!body.error, 'A2A request failed'); return body.result;
};
const client = new Client({ name: 'didi-live-read-observer', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(config.PUBLIC_URL + '/mcp'), { requestInit: { headers: { Authorization: headers.Authorization } } }));
  for (const [mode, goal] of [
    ['places', '请只搜索北京市的“北京西站”地点，列出来源候选，不查询估价。这是公共地点的接入验证，不是我的当前位置或真实出行请求，不下单不付款。'],
    ['estimate', '请只查询北京市“北京西站”到“天安门”的滴滴车型预估价。使用与这两个名称唯一精确匹配的搜索结果，返回全部来源车型的原始价格文字。这是公共地点的只读接入验证，不是真实出行请求；不下单、不付款、不查询已有订单，完整费用和接驾承诺保持未知。'],
  ] as const) {
    if (selectedMode && selectedMode !== mode) continue;
    const requestId = randomUUID(), submitted = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: requestId, role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', goal } }] } });
    const id: string = submitted.task.id; console.log(JSON.stringify({ mode, taskId: id, state: 'submitted' }));
    let job: Job | undefined;
    const until = Date.now() + 600000;
    while (Date.now() < until) {
      const result = await client.callTool({ name: 'get_task', arguments: { taskId: id } }, { timeout: 10000 }); assert(!result.isError);
      job = (result.structuredContent as { result: Job }).result;
      if (!['submitted', 'working'].includes(job.state)) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    assert(job); writeFileSync(join(output, `${mode}-task.json`), JSON.stringify(job, null, 2), { mode: 0o600 });
    assert.equal(job.state, 'completed', 'Read task did not complete; inspect its private record'); assert(job.delegation!.acceptance?.accepted);
    assert.deepEqual(job.delegation!.agent!.programRef, DIDI_PROGRAM_REF);
    const expectedType = mode === 'places' ? 'DidiPlaceObservation' : 'RideEstimateObservation';
    const ref = job.delegation!.agent!.observations.find(ref => ref.type === expectedType); assert(ref);
    const queried = await client.callTool({ name: 'query_ontology', arguments: { object: ref } }); assert(!queried.isError);
    const s = checkedRideEstimate((queried.structuredContent as { result: { items: { properties: { snapshot: unknown } }[] } }).result.items[0]!.properties.snapshot);
    assert.equal(s.evidenceKind, 'live_readonly'); assert.equal(s.receipt.environment, 'production'); assert(s.noBusinessWrites);
    const evaluated = await client.callTool({ name: 'evaluate_ontology', arguments: { function: 'rideEstimateStatus', object: ref } }); assert(!evaluated.isError);
    assert.equal((evaluated.structuredContent as { result: { status: string } }).result.status, 'known');
    const a2a = await rpc('GetTask', { id }); assert.equal(a2a.status.state, 'TASK_STATE_COMPLETED'); assert.deepEqual(a2a.artifacts[0].parts[0].data, job.artifact!.data);
    assert(job.runs!.some(r => r.runtime === 'codex-exec')); assert(job.delegation!.actions!.every(a => a.state === 'effect_confirmed'));
    const summary = { mode, taskId: id, requestId, state: job.state, accepted: true, modelRuns: job.runs!.length, sourceObservations: job.delegation!.agent!.observations.length, evidenceKind: s.evidenceKind, sourceTool: s.receipt.tool, result: s.data, noBusinessWrites: true, a2aMcpReadbackEqual: true };
    writeFileSync(join(output, `${mode}-summary.json`), JSON.stringify(summary, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ mode, taskId: id, state: job.state, accepted: true, modelRuns: job.runs!.length, sourceObservations: job.delegation!.agent!.observations.length, resultCount: s.data.kind === 'places' ? s.data.places.length : s.data.items.length, a2aMcpReadbackEqual: true }));
  }
} finally { await client.close(); }
