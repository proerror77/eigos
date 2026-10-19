// Independent observer only: the actual PA submits and receives the task.
// This program does not submit tasks, invoke models or call Shopify.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { canonical, digest } from '../packages/core/delegation.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import type { Job } from '../packages/core/domain.js';
import type { ActionIntent, ExecutionAttempt } from '../packages/ontology/actions.js';
import { CatalogAgentProgram, CATALOG_AGENT_REF } from '../packages/capabilities/catalog-agent.js';
import { checkedAgentCatalogObservation } from '../packages/ontology/catalog-agent-projection.js';
import { catalogCompletionSchema, type CatalogObservation } from '../packages/ontology/catalog-agent.js';
import { SHOPIFY_TEST_PROFILE, SHOPIFY_UCP_VERSION } from '../packages/capabilities/shopify/read-only.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { businessModel } from '../packages/ontology/business-model.js';

if (!process.argv.includes('--live')) throw new Error('Use --live for the authorized local PA observation');
const index = process.argv.indexOf('--session-dir'); assert(index >= 0 && process.argv[index + 1]);
const directory = resolve(process.argv[index + 1]!), runtime = join(homedir(), '.local/share/eigos/grok-life');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const fileSha = (path: string) => sha(readFileSync(path));
const session = read(join(directory, 'session.json')), baseline = read(join(directory, 'baseline.json')), deployment = read(join(directory, 'deployment-before-pa.json'));
const profile = read(join(runtime, 'profile.json'));
assert.equal(profile.cardUrl, 'http://127.0.0.1:3430/.well-known/agent-card.json'); assert.equal(profile.defaultService, 'eigos.delegate'); assert.deepEqual(profile.allowedServices, ['eigos.delegate']);
const credentialStat = lstatSync(profile.tokenFile); assert(credentialStat.isFile() && !credentialStat.isSymbolicLink() && (credentialStat.mode & 0o077) === 0);
const token = readFileSync(profile.tokenFile, 'utf8').trim();
for (const [file, hash] of Object.entries(baseline.files)) assert.equal(fileSha(join(runtime, file)), hash, `${file} changed`);
const config = readConfig(parseEnv(readFileSync(join(runtime, 'server.env'), 'utf8'))), worker = readWorkerConfig(parseEnv(readFileSync(join(runtime, 'server.env'), 'utf8')));
assert.deepEqual(config.EIGOS_SHOPIFY_CATALOG_MERCHANTS, [session.expectedMerchant]); assert.deepEqual(worker.EIGOS_SHOPIFY_CATALOG_MERCHANTS, config.EIGOS_SHOPIFY_CATALOG_MERCHANTS);
assert.deepEqual(config.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES, baseline.publicGeoDiscoveryQueries);
assert.equal(config.EIGOS_PAOTUI_ORDERS_ENABLED, 'false'); assert.equal(config.EIGOS_ACTION_SANDBOX, 'false'); assert.equal(config.EIGOS_EXECUTOR, 'codex'); assert.equal(config.EIGOS_COORDINATOR, 'codex');
assert.equal(fileSha(join(config.EIGOS_PAOTUI_SKILL_DIR!, 'paotui.js')), baseline.paotuiSourceSha256);
const program = new CatalogAgentProgram(config.EIGOS_SHOPIFY_CATALOG_MERCHANTS!); // Pure metadata construction.
const discovered = read(join(directory, 'pa-discovery.json')), submitted = read(join(directory, 'pa-submit.json')), peer = read(join(directory, 'pa-received.json')), original = read(join(directory, 'artifact-original.json'));
assert.deepEqual(discovered.card.skills.map((s: { id: string }) => s.id), ['eigos.delegate']);
assert(discovered.card.supportedInterfaces.some((i: { protocolBinding: string; url: string }) => i.protocolBinding === 'JSONRPC' && i.url === 'http://127.0.0.1:3430/a2a'));
assert.equal(submitted.id, peer.id); assert.equal(peer.status.state, 'TASK_STATE_COMPLETED'); assert.deepEqual(original, peer.artifacts[0]);
const client = new Client({ name: 'agent-catalog-pa-independent-observer', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3430/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const response = await client.callTool({ name: 'get_task', arguments: { taskId: peer.id } }); assert(!response.isError);
  const job = (response.structuredContent as { result: Job }).result, d = job.delegation!, state = d.agent!;
  assert.equal(job.id, peer.id); assert.equal(job.state, 'completed'); assert.equal(job.service, 'eigos.delegate'); assert.equal(d.backendVersion, 'ontology-execution-v8');
  assert.equal(job.goal, readFileSync(session.goalFile, 'utf8')); assert.equal(job.messages[0]!.id, session.requestId); assert.equal(job.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(d.request.revision, 1); assert.equal(d.request.messages.length, 1); assert(d.acceptance?.accepted); assert.equal(d.plan, undefined); assert.equal(d.resolution, undefined);
  assert.deepEqual(state.programRef, CATALOG_AGENT_REF); assert.equal(state.programDigest, program.configurationDigest); assert.equal(state.pendingPlanId, undefined);
  assert.deepEqual(state.input, { merchantIds: [session.expectedMerchant.id], country: 'US' }); assert(state.plans.length > 0); assert(state.completion);
  assert(job.runs!.every(r => r.runtime === 'codex-exec' && r.threadId && /^[a-f0-9]{64}$/.test(r.outputSha256)));
  const modelRun = (id: string) => { const run = job.runs!.find(r => r.id === id); assert(run); return run; };
  for (const plan of state.plans) {
    const { digest: hash, ...body } = plan; assert.equal(digest(body), hash);
    assert.deepEqual(plan.programRef, CATALOG_AGENT_REF); assert.equal(plan.programDigest, program.configurationDigest); assert.deepEqual(plan.scope, state.scope);
    assert.equal(plan.requestId, job.id); assert.equal(plan.requestRevision, d.request.revision); assert.deepEqual(plan.ontologyPlanning.model, businessModel.ref);
    assert.equal(modelRun(plan.modelRunId).decisionDigest, digest(plan.modelDecision)); assert.equal(plan.modelDecision.kind, 'execute');
    assert.equal(plan.steps.length, plan.modelDecision.steps.length);
    assert(plan.ontologyPlanning.reads.some(r => r.tool === 'describe_ontology' && r.status === 'ok'));
    assert(plan.ontologyPlanning.reads.some(r => r.tool === 'query_ontology' && r.status === 'ok' && r.objects.some(o => digest(o.ref) === digest(state.scope))));
    for (const [i, step] of plan.steps.entries()) {
      const { input, definitionDigest, intentId: _intent, ...choice } = step;
      assert.deepEqual(choice, plan.modelDecision.steps[i]); assert.deepEqual(input, JSON.parse(step.argumentsJson));
      assert(program.actionIds.includes(step.action as typeof program.actionIds[number])); assert.equal(definitionDigest, digest(businessModel.action(step.action)));
    }
  }
  const completion = state.completion!;
  assert.equal(modelRun(completion.modelRunId).decisionDigest, digest(completion.modelDecision)); assert.equal(completion.modelDecision.kind, 'complete');
  assert.deepEqual(completion.proposal, JSON.parse(completion.modelDecision.completionJson));
  const selection = catalogCompletionSchema.parse(completion.proposal);
  assert.equal(canonical(peer.artifacts[0].parts[0].data), canonical(job.artifact!.data));
  const answer = (job.artifact!.data.result as { catalogAnswer: any }).catalogAnswer;
  assert(answer.noBusinessWrites); assert.equal(answer.stockQuantity, 'unknown'); assert.equal(answer.deliveryCommitment, 'unknown'); assert.equal(answer.partnerTrust, 'unverified'); assert.equal(answer.completeness, 'partial_or_unknown');
  const selectedItems = answer.selections.flatMap((s: any) => s.items);
  assert.equal(selectedItems.length, session.expectedCount);
  for (const name of session.expectedNames as string[]) assert(selectedItems.some((i: any) => String(i.title).toUpperCase().includes(name)), `Missing requested product ${name}`);
  assert.equal(answer.priceComparison.currency, 'USD'); assert.equal(answer.priceComparison.firstMinusSecondMinor, String(BigInt(selectedItems[0].displayPrice.minor) - BigInt(selectedItems[1].displayPrice.minor)));

  const audit = readFileSync(join(config.EIGOS_SHOPIFY_AUDIT_DIR!, 'reads.jsonl'));
  const sourceReads = audit.subarray(baseline.shopifyAuditBytes).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert(sourceReads.length > 0); assert(sourceReads.every(r => r.requestId === job.id));
  const owner = JSON.stringify(['local-development', 'local', 'developer']), db = new DatabaseSync(join(runtime, 'tasks.sqlite'), { readOnly: true });
  const evaluations: unknown[] = [], observations: CatalogObservation[] = [];
  try {
    for (const old of baseline.oldJobs) assert.equal(sha(String(db.prepare('SELECT body FROM jobs WHERE id=?').get(old.id)!.body)), old.sha256, `Historical job ${old.id} changed`);
    const jobs = db.prepare('SELECT body FROM jobs WHERE owner=?').all(owner).map(row => JSON.parse(String(row.body)) as Job), matches = jobs.filter(j => j.messages[0]?.id === session.requestId);
    assert.equal(matches.length, 1);
    const intents = db.prepare('SELECT body,state FROM action_intents WHERE owner=? AND job_id=? ORDER BY id').all(owner, job.id).map(r => ({ ...JSON.parse(String(r.body)), state: String(r.state) }) as ActionIntent);
    assert.equal(intents.length, state.plans.reduce((n, p) => n + p.steps.length, 0)); assert(intents.every(i => i.effect === 'read'));
    assert.deepEqual(d.actions, intents.map(i => ({ id: i.id, stepId: i.stepId, state: i.state, ...(i.remoteRef ? { remoteRef: i.remoteRef } : {}), ...(i.latestObservationId ? { latestObservationId: i.latestObservationId } : {}) })));
    assert.deepEqual(d.businessFacts, []); assert.deepEqual(d.authorizationBudget, []);
    const { actions: _actions, businessFacts: _facts, authorizationBudget: _budget, ...persisted } = d;
    assert.deepEqual(matches[0], { ...job, delegation: persisted });
    assert.equal(db.prepare('SELECT count(*) AS n FROM plan_grants WHERE job_id=?').get(job.id)!.n, 0);
    for (const row of sourceReads) {
      assert.equal(row.requestRevision, 1); assert.equal(row.configurationDigest, program.configurationDigest);
      assert.equal(row.receipt.authentication, 'anonymous'); assert(['discovery', 'search_catalog', 'get_product', 'lookup_catalog'].includes(row.receipt.operation));
      const plan = state.plans.find(p => p.id === row.planId)!; assert(plan);
      const step = plan.steps.find(s => s.intentId === row.intentId)!; assert(step); assert.equal(step.action, row.action); assert.equal(row.modelRunId, plan.modelRunId);
      const intent = intents.find(i => i.id === step.intentId)!; assert.equal(intent.planDigest, plan.digest);
      const attempts = db.prepare('SELECT body FROM action_attempts WHERE owner=? AND intent_id=?').all(owner, intent.id).map(r => JSON.parse(String(r.body)) as ExecutionAttempt);
      assert.equal(attempts.length, 1, 'A connector may not replay a selected action');
      const attempt = attempts[0]!; assert.equal(attempt.id, row.attemptId); assert.equal(attempt.kind, 'dispatch');
      const input = structuredClone(step.input);
      for (const link of step.inputRefs) input[link.targetKey] = intents.find(i => i.id === plan.steps.find(s => s.id === link.stepId)!.intentId)!.acceptedOutput!.object;
      assert.equal(row.actionInputDigest, digest(input)); assert.equal(attempt.inputDigest, digest(input));
      assert(Date.parse(modelRun(plan.modelRunId).completedAt) <= Date.parse(attempt.startedAt)); assert(Date.parse(attempt.startedAt) <= Date.parse(row.receipt.startedAt));
      const context = { address_country: 'US' }, merchant = session.expectedMerchant;
      const expected = step.action === 'SearchPublicCatalog' ? { operation: 'search_catalog', endpoint: 'https://catalog.shopify.com/api/ucp/mcp', input: { query: input.query, context, pagination: { limit: input.limit }, filters: { shops: [merchant.shopId] } } }
        : step.action === 'InspectCatalogVariant' ? { operation: 'get_product', endpoint: 'https://catalog.shopify.com/api/ucp/mcp', input: { id: input.variantId, context, filters: { shops: [merchant.shopId] } } }
        : step.action === 'DiscoverMerchantCatalog' ? { operation: 'discovery', endpoint: `https://${merchant.domain}/.well-known/ucp`, input: null }
        : { operation: 'lookup_catalog', endpoint: `https://${merchant.domain}/api/ucp/mcp`, input: { ids: input.variantIds, context } };
      assert.equal(row.receipt.operation, expected.operation); assert.equal(row.receipt.endpoint, expected.endpoint); assert.deepEqual(row.transportInput, expected.input);
      const path = join(config.EIGOS_SHOPIFY_AUDIT_DIR!, 'responses', `${row.receipt.id}.json`), raw = readFileSync(path), response = JSON.parse(raw.toString());
      assert.equal(lstatSync(path).mode & 0o077, 0); assert.equal(sha(raw), row.receipt.responseSha256); assert.equal(raw.length, row.receipt.responseBytes);
      if (row.receipt.operation === 'discovery') assert.equal(row.receipt.inputSha256, sha(''));
      else {
        const request = { jsonrpc: '2.0', id: response.id, method: 'tools/call', params: { name: row.receipt.operation, arguments: { meta: { 'ucp-agent': { profile: SHOPIFY_TEST_PROFILE } }, catalog: row.transportInput } } };
        assert.equal(sha(JSON.stringify(request)), row.receipt.inputSha256, 'Vendor request differs from the model-selected action arguments');
      }
    }
    const graph = new OntologyObjectStore(db, businessModel, () => Date.parse(job.updatedAt));
    for (const ref of state.observations) {
      const record = graph.read(owner, ref), s = checkedAgentCatalogObservation(record.properties.snapshot); observations.push(s);
      assert.equal(record.source.kind, 'provider'); assert.equal(s.evidenceKind, 'live_readonly'); assert.equal(s.requestId, job.id); assert.equal(s.configurationDigest, program.configurationDigest);
      const row = sourceReads.find(r => r.receipt.id === s.receipt.id); assert(row); assert.deepEqual(row.receipt, s.receipt);
      const raw = read(join(config.EIGOS_SHOPIFY_AUDIT_DIR!, 'responses', `${s.receipt.id}.json`)); assert.equal(s.receipt.httpStatus, 200);
      if (s.action === 'DiscoverMerchantCatalog') {
        assert.equal(raw.ucp.version, SHOPIFY_UCP_VERSION);
        const endpoints = raw.ucp.services['dev.ucp.shopping'].filter((x: any) => x.transport === 'mcp' && x.version === SHOPIFY_UCP_VERSION);
        assert.equal(endpoints.length, 1); assert.equal(endpoints[0].endpoint, `https://${s.merchant.domain}/api/ucp/mcp`); continue;
      }
      assert.equal(raw.error, undefined); assert(!raw.result.isError); const output = raw.result.structuredContent;
      assert.equal(output.ucp.version, SHOPIFY_UCP_VERSION); assert(['success', undefined].includes(output.ucp.status)); assert(!(output.messages ?? []).some((m: any) => m.type === 'error'));
      const products = [...(output.products ?? []), ...(output.product ? [output.product] : [])];
      const pairs = products.flatMap((p: any) => p.variants.map((v: any) => ({ p, v })));
      const belongs = ({ v }: any) => v.seller?.id === s.merchant.shopId && v.seller.domain === s.merchant.domain;
      const expectedPairs = s.action === 'SearchPublicCatalog' ? pairs.filter(belongs) : s.action === 'InspectCatalogVariant' ? pairs.filter((x: any) => belongs(x) && x.v.id === s.actionInput.variantId)
        : (s.actionInput.variantIds as string[]).map(id => { const found = pairs.filter((x: any) => x.v.id === id && x.v.inputs?.some((i: any) => i.id === id && i.match === 'exact')); assert.equal(found.length, 1); if (found[0].v.seller) assert(belongs(found[0])); return found[0]; });
      assert.equal(expectedPairs.length, s.items.length, 'A mapper may not silently select the first variants');
      for (const [i, item] of s.items.entries()) {
        const { p, v } = expectedPairs[i]; assert.equal(item.variantId, v.id); assert.equal(item.productId, p.id); assert.equal(item.title, v.title && v.title !== p.title ? `${p.title} — ${v.title}` : p.title);
        assert.deepEqual(item.displayPrice, v.price ? { minor: String(v.price.amount), currency: v.price.currency } : undefined); assert.equal(item.sku, v.sku); assert.equal(item.availableReported, v.availability?.available); assert.equal(item.nativeCheckoutEligibleReported, v.eligible?.native_checkout);
      }
    }
    assert.equal(new Set(sourceReads.map(r => r.intentId)).size, sourceReads.length, 'One selected action makes at most one HTTP call');
    for (const [i, chosen] of selection.selections.entries()) {
      const s = observations.find(o => o.id === chosen.observation.id)!; assert(s); assert.equal(s.action, 'ReadMerchantVariants', 'This business goal asks for merchant prices');
      const input = { function: 'catalogObservationStatus', object: chosen.observation }, receipt = completion.ontologyPlanning.reads.find(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(input)); assert(receipt);
      const atRead = new OntologyObjectStore(db, businessModel, () => Date.parse(receipt.at)), status = atRead.evaluate(owner, input);
      assert.equal(status.status, 'known'); assert.equal(digest(status), receipt.outputDigest); evaluations.push({ object: chosen.observation, receipt, status });
      assert(completion.ontologyPlanning.reads.some(r => r.tool === 'query_ontology' && r.status === 'ok' && r.objects.some(o => digest(o.ref) === digest(chosen.observation))));
      assert.deepEqual(answer.selections[i].items, chosen.variantIds.map(id => s.items.find(x => x.variantId === id))); assert.deepEqual(answer.selections[i].merchant, s.merchant);
      assert(Date.parse(s.expiresAt) > Date.parse(job.updatedAt)); assert(Date.parse(s.observedAt) < Date.parse(modelRun(completion.modelRunId).completedAt));
    }
    for (const type of ['Order', 'Payment', 'CheckoutSession']) assert(!db.prepare('SELECT id FROM ontology_objects WHERE owner=? AND type=? AND body LIKE ?').all(owner, type, `%${job.id}%`).length);
  } finally { db.close(); }
  const http = readFileSync(join(runtime, 'http.jsonl')).subarray(baseline.httpAuditBytes).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), a2a = http.filter(r => r.path === '/a2a');
  const sends = a2a.filter(r => r.method === 'SendMessage'); assert.equal(sends.length, 1); assert.equal(sends[0].messageId, session.requestId); assert.equal(sends[0].taskId, undefined);
  assert(a2a.some(r => r.method === 'GetTask' && r.taskId === job.id && Date.parse(r.at) >= Date.parse(job.updatedAt)));
  assert(a2a.every(r => r.httpStatus === 200 && (r.method === 'SendMessage' ? r.messageId === session.requestId : r.method === 'GetTask' && r.taskId === job.id)));
  const release = read(join(runtime, 'release.json')), build = createHash('sha256');
  for (const path of release.files as string[]) { const bytes = readFileSync(join(release.release, path)); assert(bytes.equals(readFileSync(resolve(path)))); build.update(path + '\0'); build.update(bytes); }
  assert.equal(build.digest('hex'), release.buildDigest); assert.equal(release.buildDigest, deployment.release.buildDigest);
  const sources = read(join(directory, 'source-hashes.json')); for (const [path, hash] of Object.entries(sources.sha256)) assert.equal(fileSha(resolve(path)), hash, `Source changed since PA submission: ${path}`);
  const health = await fetch('http://127.0.0.1:3430/health').then(r => r.json()); assert.equal(health.backend, 'ontology-execution-v8'); assert.equal(health.releaseDigest, release.buildDigest);
  const evidence = { passed: true, recordedAt: new Date().toISOString(), scope: 'Actual Monk PA -> A2A -> EIGOS Ontology and LLM action selection -> single-operation Shopify connector -> source observations -> LLM completion -> PA readback; independent MCP/database/source-byte verification',
    taskId: job.id, requestId: session.requestId, goal: job.goal, createdAt: job.createdAt, completedAt: job.updatedAt, buildDigest: release.buildDigest, businessModel: businessModel.ref, configurationDigest: program.configurationDigest,
    sourceFrozenAt: sources.capturedBeforeRun, sourceHashManifestSha256: fileSha(join(directory, 'source-hashes.json')), connectionAndCredentialsUnchanged: true, previousJobsUnchanged: baseline.oldJobs.length,
    modelReceipts: job.runs, actionPlans: state.plans, completion, sourceReads, observations, evaluations, acceptance: d.acceptance, answer, a2aTrace: a2a,
    noBusinessWrites: true, paArtifactDigest: digest(peer.artifacts[0].parts[0].data), observerArtifactDigest: digest(job.artifact!.data), paReceivedFileSha256: fileSha(join(directory, 'pa-received.json')), originalArtifactFileSha256: fileSha(join(directory, 'artifact-original.json')) };
  const serialized = JSON.stringify(evidence, null, 2) + '\n'; assert(!serialized.includes(token)); writeFileSync(join(directory, 'verification.json'), serialized, { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, taskId: job.id, items: selectedItems.length, modelRuns: job.runs!.length, plans: state.plans.length, sourceReads: sourceReads.length, buildDigest: release.buildDigest }));
} finally { await client.close(); }
