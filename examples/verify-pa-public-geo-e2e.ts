// Read-only observer: the real PA submits the goal. This never starts a business query.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import type { Job } from '../packages/core/domain.js';
import { publicGeoQuerySchema } from '../packages/capabilities/paotui-contracts.js';
import { paotuiPublicPlaceSchema } from '../packages/capabilities/paotui-public-locations.js';
import { ontologyReceiptSchema } from '../packages/capabilities/paotui-mcp-server.js';
import { OntologyMcpPaotuiReader } from '../packages/capabilities/paotui-mcp.js';
import { PaotuiGeoDiscoverySource } from '../packages/capabilities/paotui-geo-discovery.js';

if (!process.argv.includes('--live')) throw new Error('Use --live to inspect an authorized persistent PA test');
const index = process.argv.indexOf('--session-dir');
assert(index >= 0 && process.argv[index + 1], 'Supply --session-dir');
const directory = resolve(process.argv[index + 1]!);
const runtime = join(homedir(), '.local/share/eigos/grok-life');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const session = read(join(directory, 'session.json')), baseline = read(join(directory, 'baseline.json'));
const deployment = read(join(directory, 'deployment-before-pa.json'));
const expected = publicGeoQuerySchema.parse(session.expectedQuery);
assert.deepEqual(expected, { keyword: '天安门', city: '北京市' });
const profile = read(join(runtime, 'profile.json'));
assert.equal(profile.cardUrl, 'http://127.0.0.1:3430/.well-known/agent-card.json');
assert.equal(profile.defaultService, 'eigos.delegate'); assert.deepEqual(profile.allowedServices, ['eigos.delegate']);
const tokenStat = lstatSync(profile.tokenFile);
assert(tokenStat.isFile() && !tokenStat.isSymbolicLink() && (tokenStat.mode & 0o077) === 0);
const token = readFileSync(profile.tokenFile, 'utf8').trim();
for (const [file, key] of [['client-token', 'tokenFileSha256'], ['profile.json', 'profileFileSha256'], ['eigos_a2a.py', 'clientFileSha256'], ['skill-install.md', 'skillFileSha256']] as const) {
  assert.equal(sha(join(runtime, file)), baseline[key], `${file} changed during acceptance`);
}
const env = parseEnv(readFileSync(join(runtime, 'server.env'), 'utf8'));
const config = readConfig(env);
assert.deepEqual(config.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES, [expected]);
assert.deepEqual(readWorkerConfig(env).EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES, [expected]);
assert.equal(config.EIGOS_PAOTUI_ORDERS_ENABLED, 'false'); assert.equal(config.EIGOS_ACTION_SANDBOX, 'false');
assert.equal(config.EIGOS_EXECUTOR, 'codex');
assert.equal(sha(join(config.EIGOS_PAOTUI_SKILL_DIR!, 'paotui.js')), baseline.sourceProgramSha256);
// Constructors only compute configuration digests; never call query/discover/prepare here.
const reader = new OntologyMcpPaotuiReader(config.EIGOS_PAOTUI_SKILL_DIR!, config.EIGOS_ONTOLOGY_AUDIT_PATH);
const source = new PaotuiGeoDiscoverySource(reader, reader.configurationDigest, [expected]);
const peer = read(join(directory, 'pa-received.json'));
const submitted = read(join(directory, 'pa-submit.json'));
const discovered = read(join(directory, 'pa-discovery.json'));
assert(discovered.card.supportedInterfaces.some((i: { protocolBinding: string; url: string }) => i.protocolBinding === 'JSONRPC' && i.url === 'http://127.0.0.1:3430/a2a'));
assert.deepEqual(discovered.card.skills.map((s: { id: string }) => s.id), ['eigos.delegate']);
assert.equal(submitted.id, peer.id); assert.equal(peer.status.state, 'TASK_STATE_COMPLETED');
const client = new Client({ name: 'public-geo-pa-readback-observer', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3430/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const response = await client.callTool({ name: 'get_task', arguments: { taskId: peer.id } }); assert(!response.isError);
  const job = (response.structuredContent as { result: Job }).result;
  assert.equal(job.state, 'completed'); assert.equal(job.messages[0]!.id, session.requestId);
  assert.equal(job.goal, readFileSync(session.goalFile, 'utf8'));
  const d = job.delegation!;
  assert.equal(d.backendVersion, 'ontology-execution-v7'); assert.equal(d.request.revision, 1);
  assert.equal(d.request.messages.length, 1); assert.equal(d.acceptance!.accepted, true);
  assert.deepEqual(d.plan!.capabilityRef, { id: 'geo.search', version: '1' });
  assert.equal(d.plan!.completionTarget, 'artifact'); assert.equal(d.plan!.quote, undefined);
  assert.equal(d.plan!.steps.length, 1); assert.equal(d.plan!.steps[0]!.effect, 'read');
  assert.deepEqual(d.plan!.steps[0]!.input, expected);
  assert.deepEqual(d.businessFacts, []); assert.equal(d.actions!.length, 1);
  assert.equal(d.actions![0]!.state, 'effect_confirmed');
  assert.equal(d.resolution!.scope.realSupply, false); assert.equal(d.resolution!.comparison, undefined);
  assert.equal(d.resolution!.scope.coverage!.length, 1);
  const coverage = d.resolution!.scope.coverage![0]!;
  assert.equal(coverage.sourceId, source.id); assert.equal(coverage.status, 'returned'); assert.equal(coverage.realSupply, false);
  assert.equal(d.resolution!.candidates.length, 1);
  const candidate = d.resolution!.candidates[0]!;
  assert.equal(candidate.binding.discovery!.sourceId, source.id);
  assert.equal(candidate.binding.discovery!.requestId, job.id);
  assert.equal(candidate.binding.configurationDigest, source.configurationDigest);
  assert.equal(candidate.details!.evidenceKind, 'live_public_location_read');
  assert.equal(candidate.details!.discoveryScope, 'public_locations_only');
  assert.equal(candidate.offer, undefined); assert.deepEqual(candidate.facts.searchArea, expected);
  assert(candidate.requirementChecks.every(c => c.result === 'pass'));
  const result = z.object({ source: z.literal('meituan'), readOnly: z.literal(true), places: z.array(paotuiPublicPlaceSchema).min(1).max(100), ontologyReceipt: ontologyReceiptSchema }).strict().parse(job.artifact!.data.result);
  const { ontologyReceipt: receipt, ...business } = result;
  assert.equal(receipt.evidenceKind, 'live_readonly'); assert.equal(receipt.tool, 'ontology_geo_search');
  assert.equal(receipt.inputDigest, digest(expected)); assert.equal(receipt.resultDigest, digest(business));
  assert.deepEqual(receipt.sourceCalls, ['search_poi']);
  const paInputBinding = read(join(directory, 'pa-input-binding.json'));
  assert.equal(paInputBinding.taskId, job.id); assert.deepEqual(paInputBinding.query, expected);
  assert.equal(paInputBinding.planInputMatchesQuery, true); assert.equal(paInputBinding.matches, true);
  assert.equal(paInputBinding.computedInputDigest, digest(expected)); assert.equal(paInputBinding.receiptInputDigest, receipt.inputDigest);
  assert.deepEqual(candidate.details!.ontologyReceipt, receipt);
  assert.equal(candidate.details!.placeCount, result.places.length);
  assert.equal(digest(peer.artifacts[0].parts[0].data), digest(job.artifact!.data));
  assert.equal(job.runs!.length, 2); assert.deepEqual(job.runs!.map(r => r.purpose), ['grounding', 'planning']);
  assert(job.runs!.every(r => r.runtime === 'codex-exec' && r.threadId && r.outputSha256));
  const audit = readFileSync(join(runtime, 'ontology-reads.jsonl'));
  assert(audit.length >= baseline.ontologyAuditBytes);
  const newReceipts = audit.subarray(baseline.ontologyAuditBytes).toString().trim().split('\n').filter(Boolean).map(line => ontologyReceiptSchema.parse(JSON.parse(line)));
  assert.deepEqual(newReceipts, [receipt], 'This PA task must reuse its single discovery read during execution');
  const db = new DatabaseSync(join(runtime, 'tasks.sqlite'), { readOnly: true });
  let previous: Job | undefined;
  let totalSourceReads = newReceipts.length;
  try {
    const jobs = db.prepare('SELECT body FROM jobs WHERE owner=?').all(JSON.stringify(['local-development', 'local', 'developer'])).map(row => JSON.parse(String(row.body)) as Job);
    const matching = jobs.filter(j => j.messages[0]?.id === session.requestId);
    assert.equal(matching.length, 1); assert.deepEqual(matching[0]!.artifact, job.artifact);
    assert.deepEqual(matching[0]!.delegation!.acceptance, d.acceptance);
    if (session.priorTaskId) {
      previous = jobs.find(j => j.id === session.priorTaskId); assert(previous);
      assert.equal(previous.state, 'rejected'); assert.equal(previous.artifact, undefined);
      assert.deepEqual(previous, read(join(session.priorSessionDirectory, 'failed-job.json')), 'Do not rewrite the failed attempt');
      assert.equal(previous.goal, job.goal);
      const priorReceipt = ontologyReceiptSchema.parse(previous.delegation!.resolution!.candidates[0]!.details!.ontologyReceipt);
      assert.equal(priorReceipt.inputDigest, digest(expected)); assert.deepEqual(priorReceipt.sourceCalls, ['search_poi']);
      const priorBaseline = read(join(session.priorSessionDirectory, 'baseline.json'));
      const allReceipts = audit.subarray(priorBaseline.ontologyAuditBytes).toString().trim().split('\n').filter(Boolean).map(line => ontologyReceiptSchema.parse(JSON.parse(line)));
      assert.deepEqual(allReceipts, [priorReceipt, receipt], 'Retain and count the failed read as well as the successful one');
      totalSourceReads = allReceipts.length;
    }
  } finally { db.close(); }
  const release = read(join(runtime, 'release.json')), hash = createHash('sha256');
  for (const path of release.files as string[]) {
    const deployed = readFileSync(join(release.release, path));
    assert(deployed.equals(readFileSync(resolve(path))), `Deployed build differs: ${path}`);
    hash.update(path + '\0'); hash.update(deployed);
  }
  assert.equal(hash.digest('hex'), release.buildDigest); assert.equal(release.buildDigest, deployment.release.buildDigest);
  const health = await fetch('http://127.0.0.1:3430/health').then(r => r.json());
  assert.equal(health.releaseDigest, release.buildDigest); assert.equal(health.backend, 'ontology-execution-v7');
  const evidence = {
    passed: true, recordedAt: new Date().toISOString(), scope: 'Actual Grok/Monk PA via A2A, real Codex interpretation/planning, allowlisted DiscoverySource through Ontology MCP, persisted public location artifact read back by PA',
    taskId: job.id, requestId: session.requestId, query: expected, createdAt: job.createdAt, completedAt: job.updatedAt,
    sourceId: source.id, configurationDigest: source.configurationDigest, buildDigest: release.buildDigest,
    whitelist: config.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES, connectionAndCredentialsUnchanged: true,
    modelReceipts: job.runs, ontologyReceipt: receipt, successfulAttemptSourceReads: newReceipts.length, totalSourceReadsIncludingPreviousAttempt: totalSourceReads,
    coverage, realSupply: false, offerCount: 0, businessFacts: d.businessFacts, completionTarget: d.plan!.completionTarget,
    acceptance: d.acceptance, requirementChecks: candidate.requirementChecks, result: business,
    paArtifactDigest: digest(peer.artifacts[0].parts[0].data), observerArtifactDigest: digest(job.artifact!.data),
    paInputBinding, paReceivedFileSha256: sha(join(directory, 'pa-received.json')), sourceProgramSha256: baseline.sourceProgramSha256,
    previousAttempt: previous ? { taskId: previous.id, state: previous.state, error: previous.error, modelCalls: previous.runs!.length, coverage: previous.delegation!.resolution!.scope.coverage, ontologyReceipt: previous.delegation!.resolution!.candidates[0]!.details!.ontologyReceipt, unchanged: true } : undefined,
  };
  const serialized = JSON.stringify(evidence, null, 2) + '\n'; assert(!serialized.includes(token));
  writeFileSync(join(directory, 'verification.json'), serialized, { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, taskId: job.id, placeCount: result.places.length, sourceId: source.id, modelCalls: job.runs!.length, sourceReads: newReceipts.length, realSupply: false, buildDigest: release.buildDigest }));
} finally { await client.close(); }
