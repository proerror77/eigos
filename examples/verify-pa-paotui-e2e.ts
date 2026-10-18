// Read-only acceptance observer for the actual persistent PA workflow. Never submits the business goal.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { digest } from '../packages/core/delegation.js';
import type { Job } from '../packages/core/domain.js';
import { ontologyReceiptSchema } from '../packages/capabilities/paotui-mcp-server.js';

if (!process.argv.includes('--live')) throw new Error('Use --live to inspect the authorized persistent PA test');
const argument = (key: string) => { const i = process.argv.indexOf(key); if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${key}`); return resolve(process.argv[i + 1]!); };
const directory = argument('--session-dir'), expectedPath = argument('--expected-query');
const runtime = join(homedir(), '.local/share/eigos/grok-life');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const session = read(join(directory, 'session.json'));
const profile = read(join(runtime, 'profile.json'));
assert.equal(profile.cardUrl, 'http://127.0.0.1:3430/.well-known/agent-card.json'); assert.equal(profile.defaultService, 'eigos.delegate'); assert.deepEqual(profile.allowedServices, ['eigos.delegate']);
const stat = lstatSync(profile.tokenFile); assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
const token = readFileSync(profile.tokenFile, 'utf8').trim();
const received = read(join(directory, 'pa-received.json')); const peer = received.task ?? received;
const asked = read(join(directory, 'pa-address-question.json')); const question = asked.task ?? asked;
const client = new Client({ name: 'persistent-pa-e2e-observer', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3430/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const response = await client.callTool({ name: 'get_task', arguments: { taskId: peer.id } }); assert(!response.isError);
  const job = (response.structuredContent as { result: Job }).result;
  assert.equal(job.id, question.id); assert.equal(question.status.state, 'TASK_STATE_INPUT_REQUIRED'); assert.equal(question.artifacts?.length ?? 0, 0);
  assert.equal(job.state, 'completed'); assert.equal(peer.status.state, 'TASK_STATE_COMPLETED'); assert.equal(job.delegation!.acceptance!.accepted, true);
  assert.equal(job.messages[0]!.id, session.requestId); assert.equal(job.goal, readFileSync(session.goalFile, 'utf8'));
  assert.equal(job.delegation!.request.revision, 2); assert.equal(job.delegation!.request.messages.length, 2);
  assert.deepEqual(job.delegation!.plan!.capabilityRef, { id: 'delivery.quote', version: '2' });
  assert.equal(digest(peer.artifacts[0].parts[0].data), digest(job.artifact!.data));
  const result = job.artifact!.data.result as Record<string, any>;
  assert.equal(result.previewOnly, true); assert.equal(result.orderCreated, false); assert.equal(result.source, 'meituan');
  assert.equal(result.goods.weightKg, 1); assert.equal(result.service, 'ordinary');
  assert((job.runs?.length ?? 0) >= 3 && job.runs!.every(r => r.runtime === 'codex-exec' && r.threadId));
  const db = new DatabaseSync(join(runtime, 'tasks.sqlite'), { readOnly: true });
  let context: any; let sameRequestTasks: number;
  try {
    const owner = JSON.stringify(['local-development', 'local', 'developer']);
    const row = db.prepare('SELECT body FROM preparation_contexts WHERE owner=? AND job_id=?').get(owner, job.id); assert(row); context = JSON.parse(String(row.body));
    sameRequestTasks = db.prepare('SELECT body FROM jobs WHERE owner=?').all(owner).map(r => JSON.parse(String(r.body))).filter(j => j.messages[0]?.id === session.requestId).length;
  } finally { db.close(); }
  assert.equal(sameRequestTasks, 1);
  const expected = read(expectedPath);
  const sender = context.addresses.find((a: any) => a.addressId === expected.senderAddressId); const recipient = context.addresses.find((a: any) => a.addressId === expected.recipientAddressId);
  assert(sender && recipient); assert.equal(result.route.sender, sender.address); assert.equal(result.route.recipient, recipient.address);
  const modelInputs = JSON.stringify([job.delegation!.request, job.delegation!.plan!.steps.map(s => s.input)]);
  assert(!modelInputs.includes(expected.senderAddressId) && !modelInputs.includes(expected.recipientAddressId));
  const prepared = job.delegation!.resolution!.candidates[0]!.details!;
  const receipts = [context.receipt, prepared.addressReadReceipt, prepared.ontologyReceipt, result.ontologyReceipt].map(r => ontologyReceiptSchema.parse(r));
  const audit = readFileSync(join(runtime, 'ontology-reads.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(new Set(receipts.map(r => r.id)).size, 4); assert(receipts.every(r => r.evidenceKind === 'live_readonly' && audit.some(a => digest(a) === digest(r))));
  assert.deepEqual(receipts.map(r => r.tool), ['ontology_address_book_read', 'ontology_address_book_read', 'ontology_delivery_quote', 'ontology_delivery_quote']);
  assert(receipts.every(r => r.sourceCalls.every(c => ['get_address_list', 'get_address_info', 'delivery_preview'].includes(c))));
  const before = read(join(directory, 'restart-before.json')), after = read(join(directory, 'restart-after.json'));
  assert.equal(before.taskId, job.id); assert.equal(after.taskId, job.id); assert.equal(after.questionSha256, before.questionSha256); assert.equal(after.contextSha256, before.contextSha256); assert.equal(after.state, 'input-required');
  const release = read(join(runtime, 'release.json')); const hash = createHash('sha256');
  for (const path of release.files as string[]) { const deployed = readFileSync(join(release.release, path)); assert(deployed.equals(readFileSync(resolve(path))), `Deployed build differs: ${path}`); hash.update(path + '\0'); hash.update(deployed); }
  assert.equal(hash.digest('hex'), release.buildDigest);
  const health = await fetch('http://127.0.0.1:3430/health').then(r => r.json()); assert.equal(health.releaseDigest, release.buildDigest);
  const card = await fetch(profile.cardUrl).then(r => r.json()); assert.deepEqual(card.skills.map((s: any) => s.id), ['eigos.delegate']);
  const retired = ['brief.prepare', 'agent.execute', 'life.request', 'meituan.paotui.read', 'meituan.paotui.order', 'data.quality.audit.simulated'];
  for (const service of retired) {
    const rejected = await client.callTool({ name: 'submit_task', arguments: { service, goal: 'retired-entry-rejection-check', requestId: randomUUID() } }); assert.equal(rejected.isError, true, `${service} must be rejected`);
  }
  const evidence = { passed: true, recordedAt: new Date().toISOString(), scope: 'Actual Grok PA on the persistent loopback service, natural goal, real owned address choices, same-task continuation after restart, actual Codex and real Meituan reads only',
    taskId: job.id, requestId: session.requestId, capabilityRef: job.delegation!.plan!.capabilityRef, originalGoalHadNoAddressIds: true, sameTaskAfterReply: true, onlyOneBusinessTask: true,
    restart: { questionUnchanged: true, privateChoicesUnchanged: true, priorReleaseDigest: before.release, activeReleaseDigest: release.buildDigest },
    modelReceipts: job.runs, ontologyReceipts: receipts, quote: result.quote, weightKg: result.goods.weightKg, service: result.service,
    acceptance: job.delegation!.acceptance, paArtifactDigest: digest(peer.artifacts[0].parts[0].data), mcpArtifactDigest: digest(job.artifact!.data),
    selectedRouteMatchesPreviousAuthorizedTest: true, orderCreated: false, paymentsMade: false, retiredEntriesRejected: retired,
    paClientSha256: createHash('sha256').update(readFileSync(join(runtime, 'eigos_a2a.py'))).digest('hex'),
    paReceivedFileSha256: createHash('sha256').update(readFileSync(join(directory, 'pa-received.json'))).digest('hex'),
    sourceProgramSha256: createHash('sha256').update(readFileSync(join(process.env.EIGOS_PAOTUI_SKILL_DIR ?? join(homedir(), '.codex/skills/meituan-paotui'), 'paotui.js'))).digest('hex'),
    runtime: { origin: 'http://127.0.0.1:3430', defaultService: 'eigos.delegate', buildDigest: release.buildDigest, active: true },
  };
  const serialized = JSON.stringify(evidence, null, 2) + '\n';
  assert(![token, expected.senderAddressId, expected.recipientAddressId, sender.address, recipient.address].some(v => v && serialized.includes(v)));
  writeFileSync(join(directory, 'verification.json'), serialized, { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, taskId: job.id, quote: result.quote, modelCalls: job.runs!.length, ontologyReads: receipts.length, buildDigest: release.buildDigest }));
} finally { await client.close(); }
