// Read-only verification of actual PA handoffs. This script never submits tasks.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ownerKey, SCOPES, type Job } from '../packages/core/domain.js';
import type { LifeRequest } from '../packages/capabilities/life-intake.js';

interface ReceiptTask { status: { state: string }; metadata: { intake: LifeRequest }; artifacts: { parts: { data: object }[] }[] }

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Pass the private manifest of expected PA task IDs and original goals');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { requests: { taskId: string; goal: string; domain: string }[] };
assert(manifest.requests.length > 0);
const profile = JSON.parse(readFileSync('data/grok-life/profile.json', 'utf8'));
const location = JSON.parse(readFileSync('data/grok-life/runtime-location.json', 'utf8'));
const token = readFileSync(profile.tokenFile, 'utf8').trim();
const base = new URL(profile.cardUrl).origin;
assert.equal(base, 'http://127.0.0.1:3430');
const db = new DatabaseSync(location.database, { readOnly: true });
const client = new Client({ name: 'life-handoff-independent-readback', version: '1.0.0' });
const p = { issuer: 'local-development', tenant: 'local', subject: 'developer', clientId: 'eigos-local-dev', scopes: [...SCOPES] };
const results: object[] = [];
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  for (const request of manifest.requests) {
    const response: Response = await fetch(`${base}/a2a`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `readback-${request.taskId}`, method: 'GetTask', params: { id: request.taskId } }) });
    const json: { error?: unknown; result: ReceiptTask | { task: ReceiptTask } } = await response.json(); assert(response.ok && !json.error);
    const task: ReceiptTask = 'task' in json.result ? json.result.task : json.result;
    const tool = await client.callTool({ name: 'get_task', arguments: { taskId: request.taskId } }); assert(!tool.isError);
    const mcp = (tool.structuredContent as { result: Job }).result;
    const row = db.prepare('SELECT body FROM jobs WHERE id=? AND owner=?').get(request.taskId, ownerKey(p)); assert(row);
    const stored = JSON.parse(String(row.body)) as Job;
    assert.equal(stored.goal, request.goal); assert.equal(stored.service, 'life.request');
    assert.equal(stored.state, 'submitted'); assert.equal(stored.executionMode, 'intake');
    assert.equal(task.status.state, 'TASK_STATE_SUBMITTED');
    assert.deepEqual(task.metadata.intake, stored.intake); assert.deepEqual(mcp, stored);
    assert.equal(stored.intake?.acceptedFor, 'intake_only'); assert.equal(stored.intake?.businessCompleted, false);
    assert.equal(stored.intake?.status, 'waiting_provider'); assert.equal(stored.intake?.automaticExecution, false);
    assert.equal(stored.artifact?.data.execution, 'not_started');
    assert.deepEqual(task.artifacts[0]?.parts[0]?.data, stored.artifact?.data);
    assert.equal(db.prepare('SELECT count(*) AS n FROM jobs WHERE json_extract(body,\'$.goal\')=?').get(request.goal)!.n, 1);
    results.push({ ...request, state: task.status.state, intakeStatus: stored.intake.status, execution: 'not_started', businessCompleted: false,
      a2aReadback: true, mcpReadback: true, independentDatabaseReadback: true, duplicateTasks: 0 });
  }
  assert.equal(new Set(manifest.requests.map(request => request.taskId)).size, manifest.requests.length);
  const output = resolve(dirname(manifestPath), 'independent-verification.json');
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify({ verifiedAt: new Date().toISOString(), verifier: 'read-only A2A + official MCP client + SQLite', requests: results,
    boundary: 'Actual Personal Agent handoffs must be independently established from peer evidence. This verifier does not create requests or prove provider execution.' }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ verifiedRequests: results.length, output, businessCompleted: false }));
} finally { await client.close(); db.close(); }
