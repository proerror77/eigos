// Read-only verification of an existing live participant task. Never submits or retries a reservation.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Job } from '../packages/core/domain.js';
import { registrationRecordSchema } from '../packages/ontology/free-booking.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import type { ActionIntent } from '../packages/ontology/actions.js';

const [directory, taskId] = process.argv.slice(2);
assert(directory && isAbsolute(directory) && taskId, 'Supply the existing private session directory and original task ID');
const env = parseEnv(readFileSync(join(directory, 'gateway.env'), 'utf8')), base = env.PUBLIC_URL!, token = env.EIGOS_DEV_TOKEN!;
const client = new Client({ name: 'eigos-participant-readback', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const read = await client.callTool({ name: 'get_task', arguments: { taskId } }); assert(!read.isError);
  const job = (read.structuredContent as { result: Job }).result;
  assert.equal(job.id, taskId); assert.equal(job.state, 'completed'); assert.equal(job.delegation!.backendVersion, BACKEND_VERSION); assert.equal(job.delegation!.acceptance!.accepted, true);
  assert.equal(job.delegation!.agent!.paPayment, undefined);
  assert(job.runs!.length && job.runs!.every(run => ['codex-exec', 'codex-app-server'].includes(run.runtime) && run.threadId && run.outputSha256 && (run.runtime !== 'codex-app-server' || run.turnId)));
  const proposal = job.delegation!.agent!.completion!.proposal as { registration: object };
  const queried = await client.callTool({ name: 'query_ontology', arguments: { object: proposal.registration } }); assert(!queried.isError);
  const current = (queried.structuredContent as { result: { items: { properties: { data: unknown } }[] } }).result.items[0]!;
  const registration = registrationRecordSchema.parse(current.properties.data);
  assert.equal(registration.state, 'confirmed'); assert(registration.confirmationReference); assert.equal(registration.independentRead, true); assert.equal(registration.payment.requirement, 'not_required'); assert.equal(registration.payment.total.minor, '0');
  const evaluated = await client.callTool({ name: 'evaluate_ontology', arguments: { function: 'registrationStatus', object: proposal.registration } }); assert(!evaluated.isError);
  const assessment = (evaluated.structuredContent as { result: { status: string; value: { confirmed: boolean }; evidenceLevels: string[] } }).result;
  assert.equal(assessment.status, 'known'); assert.equal(assessment.value.confirmed, true); assert.deepEqual(assessment.evidenceLevels, ['live_readonly']);
  const response = await fetch(base + '/a2a', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'GetTask', params: { id: taskId } }) }); assert(response.ok);
  const a2a = (await response.json()).result;
  assert.equal(a2a.id, taskId); assert.equal(a2a.status.state, 'TASK_STATE_COMPLETED'); assert.deepEqual(a2a.artifacts[0].parts[0].data, job.artifact!.data);
  const database = new DatabaseSync(env.DATABASE_PATH!, { readOnly: true });
  let writes: ActionIntent[];
  try {
    const stored = JSON.parse(String(database.prepare('SELECT body FROM jobs WHERE id=?').get(taskId)!.body)) as Job; assert.deepEqual(stored.artifact, job.artifact);
    const intents = database.prepare('SELECT body FROM action_intents WHERE job_id=?').all(taskId).map(row => JSON.parse(String(row.body)) as ActionIntent);
    writes = intents.filter(intent => !['read', 'local'].includes(intent.effect)); assert.equal(writes.length, 1); assert.equal(writes[0]!.effect, 'reserve'); assert.equal(writes[0]!.state, 'effect_confirmed');
  } finally { database.close(); }
  const result = job.artifact!.data.result as { browserEvidence: object; source: string };
  assert.equal(result.source, 'operator_assisted_browser');
  const verification = { checkedAt: new Date().toISOString(), taskId, backendVersion: BACKEND_VERSION, state: job.state, serviceUrl: registration.serviceUrl, serviceTitle: registration.title, startsAt: registration.startsAt, endsAt: registration.endsAt, timeZone: registration.timeZone, participants: registration.participants, paymentRequired: false, realPayment: false, completeTotal: registration.payment.total, source: result.source, confirmationObserved: true, workerModelCalls: job.runs!.length, providerWrites: writes.length, mcpReadback: true, a2aReadback: true, databaseReadback: true, artifactSha256: createHash('sha256').update(JSON.stringify(job.artifact!.data)).digest('hex'), browserEvidence: result.browserEvidence, limitations: ['Local browser operator required', 'Browser-observed source, not a Luma-signed API receipt', 'Registration confirmation does not prove attendance', 'No public deployment or payment'] };
  writeFileSync(join(directory, 'verification.json'), JSON.stringify(verification, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(verification, null, 2));
} finally { await client.close(); }
