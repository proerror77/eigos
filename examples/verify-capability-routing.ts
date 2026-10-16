// Explicit live-model probe. Never part of npm test. Uses the configured local server.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../packages/core/config.js';

const config = readConfig();
assert.equal(config.EIGOS_AUTH_MODE, 'development');
assert.equal(config.EIGOS_COORDINATOR, 'codex');
assert.equal(config.EIGOS_CSV_PILOT, 'true');
const fileName = 'oag-review-20261015.csv';
assert(config.EIGOS_CSV_INPUT_DIR);
readFileSync(join(config.EIGOS_CSV_INPUT_DIR, fileName));
const output = resolve('data/registry-routing', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(output, { recursive: true, mode: 0o700 });
const headers = { Authorization: `Bearer ${config.EIGOS_DEV_TOKEN}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
const transcript: unknown[] = [];
async function rpc(method: string, params: object) {
  const request = { jsonrpc: '2.0', id: randomUUID(), method, params };
  const response = await fetch(config.PUBLIC_URL + '/a2a', { method: 'POST', headers, body: JSON.stringify(request) });
  const body = await response.json(); transcript.push({ request, response: body, httpStatus: response.status });
  assert(response.ok && !body.error, JSON.stringify(body));
  return body.result.task ?? body.result;
}
async function settle(id: string) {
  for (let i = 0; i < 150; i++) {
    const task = await rpc('GetTask', { id });
    if (!['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(task.status.state)) return task;
    await delay(2000);
  }
  throw new Error('Live probe deadline exceeded; inspect the original task before retrying');
}
const cases = [
  { name: 'brief', capability: 'brief.prepare', goal: '请用 EIGOS 为一项 CSV 数据质量审计整理任务说明。目标是将来检查重复编号和缺失字段；任务说明的交付标准是列出输入要求、两类检查及验收条件，输出一份 JSON 任务说明。这里只编写任务说明，不读取文件、不实际审计，也不付款。' },
  { name: 'csv', capability: 'data.quality.audit.simulated', goal: `请用 EIGOS 实际审计 ${fileName}，检查已注册的五项规则，交付 JSON 和 Markdown 报告，不是只写审计任务说明。我授权本次这个合成数据文件、上述检查范围以及上限 1.00 CNY 的本地模拟流程，无真实资金。` },
  { name: 'unsupported', capability: null, goal: '请用 EIGOS 实际购买一杯咖啡并配送给我。我要真实购买，不是写一份任务说明、建议或计划。' },
];
const summary: unknown[] = [];
try {
  const card = await (await fetch(config.PUBLIC_URL + '/.well-known/agent-card.json')).json();
  writeFileSync(join(output, 'agent-card.json'), JSON.stringify(card, null, 2));
  for (const scenario of cases) {
    const task = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: scenario.goal }] } });
    console.log(`${scenario.name}: submitted ${task.id}`);
    let result = await settle(task.id);
    if (scenario.name === 'csv') {
      assert.equal(result.status.state, 'TASK_STATE_AUTH_REQUIRED');
      assert.equal(result.metadata.delegation.capabilityId, scenario.capability);
      const pilot = result.metadata.pilot;
      assert.equal(pilot.environment, 'simulated'); assert.equal(pilot.quote.amountMinor, 100); assert.equal(pilot.quote.currency, 'CNY');
      const approval = { requestId: randomUUID(), action: 'confirm_simulated_payment', quoteId: pilot.quote.id, quoteDigest: pilot.quoteDigest };
      const response = await fetch(config.PUBLIC_URL + `/tasks/${task.id}/authorize`, { method: 'POST', headers, body: JSON.stringify(approval) });
      const body = await response.json(); transcript.push({ authorizationTaskId: task.id, request: approval, response: body, httpStatus: response.status });
      assert(response.ok, JSON.stringify(body)); result = await settle(task.id);
      assert.equal(result.metadata.pilot.acceptance, 'accepted');
    }
    if (scenario.capability) {
      assert.equal(result.status.state, 'TASK_STATE_COMPLETED');
      assert.equal(result.metadata.delegation.capabilityId, scenario.capability);
      assert.equal(result.metadata.delegation.acceptance.accepted, true);
    } else {
      assert.equal(result.status.state, 'TASK_STATE_REJECTED'); assert.equal(result.metadata.pilot, undefined);
      assert.equal(result.artifacts?.length ?? 0, 0);
    }
    if (scenario.name === 'brief') {
      assert.equal(result.metadata.pilot, undefined);
      assert.equal(result.artifacts[0].parts[0].data.execution, 'not_started');
    }
    assert(result.metadata.runs.every((r: { runtime: string; threadId?: string }) => r.runtime === 'codex-exec' && r.threadId));
    writeFileSync(join(output, scenario.name + '.json'), JSON.stringify({ goal: scenario.goal, result }, null, 2));
    const row = { scenario: scenario.name, taskId: result.id, state: result.status.state, capabilityId: result.metadata.delegation.capabilityId ?? null, modelRuns: result.metadata.runs.length };
    summary.push(row); console.log(JSON.stringify(row));
  }
} finally {
  const text = JSON.stringify({ summary, transcript }, null, 2);
  assert(!text.includes(config.EIGOS_DEV_TOKEN!));
  writeFileSync(join(output, 'verification.json'), text, { mode: 0o600 });
  console.log('Evidence directory:', output);
}
