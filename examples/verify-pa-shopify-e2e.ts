// Historical v7/capability@1 observer. Reproduce against checkout fc00061 and its
// recorded runtime. The current v8 Agent path has a separate observer.
// Independent read-only observer. The actual PA submits the goal and receives its artifact.
// This program never invokes Shopify, submits a task, or runs a model.
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
import { checkedCatalogSnapshot, catalogReceiptSchema, type CatalogSnapshot } from '../packages/capabilities/shopify/contracts.js';
import { SHOPIFY_TEST_PROFILE, SHOPIFY_UCP_VERSION } from '../packages/capabilities/shopify/read-only.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { businessModel } from '../packages/ontology/business-model.js';

if (!process.argv.includes('--live')) throw new Error('Use --live for the authorized persistent PA observation');
const index = process.argv.indexOf('--session-dir');
assert(index >= 0 && process.argv[index + 1], 'Supply --session-dir');
const directory = resolve(process.argv[index + 1]!);
const runtime = join(homedir(), '.local/share/eigos/grok-life');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const fileSha = (path: string) => sha(readFileSync(path));
const session = read(join(directory, 'session.json')), baseline = read(join(directory, 'baseline.json'));
const priorSessions: { taskId: string; directory: string }[] = session.priorAttempts ?? (session.priorTaskId ? [{ taskId: session.priorTaskId, directory: session.priorSessionDirectory }] : []);
const deployment = read(join(directory, 'deployment-before-pa.json'));
const profile = read(join(runtime, 'profile.json'));
assert.equal(profile.cardUrl, 'http://127.0.0.1:3430/.well-known/agent-card.json');
assert.equal(profile.defaultService, 'eigos.delegate');
assert.deepEqual(profile.allowedServices, ['eigos.delegate']);
const credentialStat = lstatSync(profile.tokenFile);
assert(credentialStat.isFile() && !credentialStat.isSymbolicLink() && (credentialStat.mode & 0o077) === 0);
const token = readFileSync(profile.tokenFile, 'utf8').trim();
for (const [file, hash] of Object.entries(baseline.files)) assert.equal(fileSha(join(runtime, file)), hash, `${file} changed`);
const config = readConfig(parseEnv(readFileSync(join(runtime, 'server.env'), 'utf8')));
const worker = readWorkerConfig(parseEnv(readFileSync(join(runtime, 'server.env'), 'utf8')));
assert.deepEqual(config.EIGOS_SHOPIFY_CATALOG_MERCHANTS, [session.expectedMerchant]);
assert.deepEqual(worker.EIGOS_SHOPIFY_CATALOG_MERCHANTS, config.EIGOS_SHOPIFY_CATALOG_MERCHANTS);
assert.deepEqual(config.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES, baseline.publicGeoDiscoveryQueries);
assert.equal(config.EIGOS_PAOTUI_ORDERS_ENABLED, 'false'); assert.equal(config.EIGOS_ACTION_SANDBOX, 'false');
assert.equal(config.EIGOS_EXECUTOR, 'codex'); assert.equal(config.EIGOS_COORDINATOR, 'codex');
assert.equal(fileSha(join(config.EIGOS_PAOTUI_SKILL_DIR!, 'paotui.js')), baseline.paotuiSourceSha256);
// Historical metadata only; the preset workflow implementation was removed.
const adapter = { id: 'shopify:anonymous-catalog', configurationDigest: digest({ merchants: config.EIGOS_SHOPIFY_CATALOG_MERCHANTS, profile: SHOPIFY_TEST_PROFILE, protocol: SHOPIFY_UCP_VERSION, evidenceKind: 'live_readonly', mapping: 'catalog-read-v1' }) };
const discovered = read(join(directory, 'pa-discovery.json')), submitted = read(join(directory, 'pa-submit.json'));
const peer = read(join(directory, 'pa-received.json')), original = read(join(directory, 'artifact-original.json'));
assert.deepEqual(discovered.card.skills.map((s: { id: string }) => s.id), ['eigos.delegate']);
assert(discovered.card.supportedInterfaces.some((i: { protocolBinding: string; url: string }) => i.protocolBinding === 'JSONRPC' && i.url === 'http://127.0.0.1:3430/a2a'));
assert.equal(submitted.id, peer.id); assert.equal(peer.status.state, 'TASK_STATE_COMPLETED');
assert.deepEqual(original, peer.artifacts[0]);
const client = new Client({ name: 'shopify-pa-independent-observer', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3430/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const response = await client.callTool({ name: 'get_task', arguments: { taskId: peer.id } }); assert(!response.isError);
  const job = (response.structuredContent as { result: Job }).result, d = job.delegation!;
  assert.equal(job.id, peer.id); assert.equal(job.state, 'completed'); assert.equal(job.service, 'eigos.delegate');
  assert.equal(job.messages[0]!.id, session.requestId); assert.equal(job.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(d.request.messages.length, 1);
  assert.equal(job.goal, readFileSync(session.goalFile, 'utf8'));
  assert.equal(d.backendVersion, 'ontology-execution-v7'); assert.equal(d.request.revision, 1); assert.equal(d.acceptance!.accepted, true);
  const plan = d.plan!;
  assert.deepEqual(plan.capabilityRef, { id: 'commerce.catalog.query', version: '1' });
  assert.equal(plan.bindingRef.id, adapter.id); assert.equal(plan.completionTarget, 'artifact'); assert.equal(plan.quote, undefined);
  assert.equal(plan.steps.length, 1); assert.equal(plan.steps[0]!.effect, 'read');
  assert(!plan.steps[0]!.additionalEffects?.length); assert.deepEqual(plan.steps[0]!.input, session.expectedInput);
  assert.deepEqual(d.businessFacts, []); assert.equal(d.actions!.length, 1); assert.equal(d.actions![0]!.state, 'effect_confirmed');
  assert.equal(plan.ontologyPlanning.mode, 'model_queries'); assert.deepEqual(plan.ontologyPlanning.model, businessModel.ref);
  assert(job.runs!.length >= 2); assert(job.runs!.some(r => r.purpose === 'grounding')); assert(job.runs!.some(r => r.purpose === 'planning'));
  assert(job.runs!.every(r => r.runtime === 'codex-exec' && r.threadId && /^[a-f0-9]{64}$/.test(r.outputSha256)));
  const snapshot = checkedCatalogSnapshot((job.artifact!.data.result as { catalogSnapshot: unknown }).catalogSnapshot);
  assert.equal(snapshot.requestId, job.id); assert.equal(snapshot.requestRevision, d.request.revision);
  assert.equal(snapshot.configurationDigest, adapter.configurationDigest); assert.equal(snapshot.phase, 'verified');
  assert.equal(snapshot.evidenceKind, 'live_readonly'); assert.equal(snapshot.authentication, 'anonymous');
  assert.deepEqual(snapshot.query, session.expectedInput); assert.deepEqual(snapshot.merchant, session.expectedMerchant);
  assert(snapshot.items.length > 0, 'This acceptance run must return real products');
  assert(Date.parse(snapshot.expiresAt) > Date.parse(job.updatedAt), 'The accepted observations were already expired');
  assert.equal(snapshot.stockQuantity, 'unknown'); assert.equal(snapshot.deliveryCommitment, 'unknown');
  assert.equal(snapshot.partnerTrust, 'unverified'); assert.equal(snapshot.noBusinessWrites, true);
  assert.equal(canonical(peer.artifacts[0].parts[0].data), canonical(job.artifact!.data));
  const previousAttempts = priorSessions.map(prior => {
    const failed = read(join(prior.directory, 'failed-job.json')) as Job, priorPeer = read(join(prior.directory, 'pa-received.json'));
    assert.equal(failed.id, prior.taskId); assert(['rejected', 'failed'].includes(failed.state)); assert.equal(failed.artifact, undefined);
    assert.equal(failed.goal, job.goal); assert.equal(priorPeer.id, failed.id); assert.equal(priorPeer.status.state, `TASK_STATE_${failed.state.toUpperCase()}`);
    return { taskId: failed.id, state: failed.state, error: failed.error, modelReceipts: failed.runs, failure: read(join(prior.directory, 'failure-analysis.json')), unchanged: true };
  });

  const auditFile = join(config.EIGOS_SHOPIFY_AUDIT_DIR!, 'reads.jsonl'), audit = readFileSync(auditFile);
  const sourceReads = audit.subarray(baseline.shopifyAuditBytes).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(sourceReads.length, snapshot.receipts.length);
  for (const row of sourceReads) {
    assert.equal(row.requestId, job.id); assert.equal(row.requestRevision, 1); assert.equal(row.configurationDigest, adapter.configurationDigest);
    catalogReceiptSchema.parse(row.receipt);
  }
  assert.deepEqual(sourceReads.map(r => r.receipt), snapshot.receipts);
  let totalSourceReads = sourceReads.length;
  if (priorSessions.length) {
    const priorBaseline = read(join(priorSessions[0]!.directory, 'baseline.json'));
    const all = audit.subarray(priorBaseline.shopifyAuditBytes).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const priorRows = previousAttempts.flatMap(p => p.failure.sourceReads);
    assert.deepEqual(all, [...priorRows, ...sourceReads]); totalSourceReads = all.length;
    for (const row of priorRows as { receipt: CatalogSnapshot['receipts'][number] }[]) {
      const raw = readFileSync(join(config.EIGOS_SHOPIFY_AUDIT_DIR!, 'responses', `${row.receipt.id}.json`));
      assert.equal(sha(raw), row.receipt.responseSha256); assert.equal(raw.length, row.receipt.responseBytes);
    }
  }
  assert.deepEqual(snapshot.receipts.map(r => r.operation), ['search_catalog', ...snapshot.items.map(() => 'get_product'), 'discovery', 'lookup_catalog', 'discovery', 'lookup_catalog']);
  const rawResponses = new Map<string, any>();
  for (const receipt of snapshot.receipts) {
    const path = join(config.EIGOS_SHOPIFY_AUDIT_DIR!, 'responses', `${receipt.id}.json`), raw = readFileSync(path), body = JSON.parse(raw.toString());
    assert.equal(lstatSync(path).mode & 0o077, 0); assert.equal(sha(raw), receipt.responseSha256); assert.equal(raw.length, receipt.responseBytes);
    if (receipt.operation === 'discovery') {
      assert.equal(receipt.inputSha256, sha(''));
      assert.equal(body.ucp.version, SHOPIFY_UCP_VERSION);
      const bindings = body.ucp.services['dev.ucp.shopping'].filter((s: any) => s.transport === 'mcp' && s.version === SHOPIFY_UCP_VERSION);
      assert.equal(bindings.length, 1); assert.equal(bindings[0].endpoint, `https://${snapshot.merchant.domain}/api/ucp/mcp`);
    } else {
      assert.equal(body.jsonrpc, '2.0'); assert.equal(typeof body.id, 'string'); assert.equal(body.error, undefined); assert(!body.result.isError);
      const output = body.result.structuredContent;
      assert.equal(output.ucp.version, SHOPIFY_UCP_VERSION); assert(['success', undefined].includes(output.ucp.status));
      assert(!(output.messages ?? []).some((m: any) => m.type === 'error'));
      const capability = receipt.operation === 'search_catalog' ? 'search' : 'lookup';
      const extension = receipt.operation === 'lookup_catalog' ? 'dev.shopify.catalog' : 'dev.shopify.catalog.global';
      for (const name of [`dev.ucp.shopping.catalog.${capability}`, extension]) assert(output.ucp.capabilities[name].some((c: any) => c.version === SHOPIFY_UCP_VERSION));
      const context = { address_country: snapshot.query.country };
      const catalog = receipt.operation === 'search_catalog' ? { query: snapshot.query.query, context, pagination: { limit: 3 }, filters: { shops: [snapshot.merchant.shopId] } }
        : receipt.operation === 'get_product' ? { id: snapshot.items.find(i => i.globalReceiptId === receipt.id)!.variantId, context, filters: { shops: [snapshot.merchant.shopId] } }
          : { ids: snapshot.items.map(i => i.variantId), context };
      const request = { jsonrpc: '2.0', id: body.id, method: 'tools/call', params: { name: receipt.operation, arguments: { meta: { 'ucp-agent': { profile: SHOPIFY_TEST_PROFILE } }, catalog } } };
      assert.equal(sha(JSON.stringify(request)), receipt.inputSha256, 'Source request differs from the exact planned public query');
    }
    rawResponses.set(receipt.id, body);
  }
  const search = rawResponses.get(snapshot.receipts[0]!.id).result.structuredContent;
  for (const item of snapshot.items) {
    const products = search.products.filter((p: any) => p.id === item.globalProductId);
    assert.equal(products.length, 1);
    const matches = products[0].variants.filter((v: any) => v.id === item.variantId && v.seller?.id === snapshot.merchant.shopId && v.seller.domain === snapshot.merchant.domain);
    assert.equal(matches.length, 1); assert.equal(item.title, (matches[0].title ?? products[0].title).slice(0, 500));
    const global = rawResponses.get(item.globalReceiptId).result.structuredContent;
    const variants = [...(global.products ?? []), ...(global.product ? [global.product] : [])].flatMap((p: any) => p.variants);
    const exact = variants.filter((v: any) => v.id === item.variantId && v.seller?.id === snapshot.merchant.shopId && v.seller.domain === snapshot.merchant.domain);
    assert.equal(exact.length, 1); assert.equal(String(exact[0].price.amount), item.displayPrice.minor); assert.equal(exact[0].price.currency, item.displayPrice.currency);
    assert.equal(exact[0].availability?.available, item.availableReported);
    for (const receipt of snapshot.receipts.filter(r => r.operation === 'lookup_catalog')) {
      const output = rawResponses.get(receipt.id).result.structuredContent;
      const variants = output.products.flatMap((p: any) => p.variants).filter((v: any) => v.id === item.variantId && v.inputs?.some((i: any) => i.id === item.variantId && i.match === 'exact'));
      assert.equal(variants.length, 1); const variant = variants[0];
      if (variant.seller) { assert.equal(variant.seller.id, snapshot.merchant.shopId); assert.equal(variant.seller.domain, snapshot.merchant.domain); }
      assert.equal(String(variant.price.amount), item.displayPrice.minor); assert.equal(variant.price.currency, item.displayPrice.currency);
      assert.equal(variant.availability?.available, item.availableReported); assert.equal(variant.sku, item.sku);
    }
  }

  const owner = JSON.stringify(['local-development', 'local', 'developer']);
  const db = new DatabaseSync(join(runtime, 'tasks.sqlite'), { readOnly: true });
  let planningEvaluation;
  try {
    for (const old of baseline.oldJobs) assert.equal(sha(String(db.prepare('SELECT body FROM jobs WHERE id=?').get(old.id)!.body)), old.sha256);
    const jobs = db.prepare('SELECT body FROM jobs WHERE owner=?').all(owner).map(row => JSON.parse(String(row.body)) as Job);
    const matching = jobs.filter(j => j.messages[0]?.id === session.requestId);
    assert.equal(matching.length, 1);
    // TaskService adds the current budget view to the stored delegation at read time.
    const { authorizationBudget, ...persistedDelegation } = d;
    assert.deepEqual(authorizationBudget, []);
    assert.deepEqual(matching[0], { ...job, delegation: persistedDelegation });
    for (const prior of priorSessions) assert.deepEqual(jobs.find(j => j.id === prior.taskId), read(join(prior.directory, 'failed-job.json')));
    const subject = { type: 'CatalogRead', id: String(plan.details.catalogReadId) };
    const input = { function: 'catalogReadStatus', object: subject };
    const receipt = plan.ontologyPlanning.reads.find(r => r.tool === 'evaluate_ontology' && r.inputDigest === digest(input) && r.status === 'ok');
    assert(receipt, 'No actual model catalogReadStatus evaluation');
    assert(plan.ontologyPlanning.reads.some(r => r.tool === 'query_ontology' && r.status === 'ok' && r.objects.some(o => digest(o.ref) === digest(subject))), 'No actual model read of CatalogRead');
    // Immutable observations are evaluated at the recorded read time, without extending their TTL.
    const graph = new OntologyObjectStore(db, businessModel, () => Date.parse(receipt.at));
    planningEvaluation = graph.evaluate(owner, input);
    assert.equal(planningEvaluation.status, 'known'); assert.equal(digest(planningEvaluation), receipt.outputDigest);
    const value = planningEvaluation.value as { phase: string; itemCount: number; grantsAuthority: boolean };
    assert.equal(value.phase, 'prepared'); assert.equal(value.itemCount, snapshot.items.length); assert.equal(value.grantsAuthority, false);
    const prepared = checkedCatalogSnapshot(graph.read(owner, subject).properties.snapshot);
    assert.equal(prepared.phase, 'prepared'); assert.equal(prepared.contentDigest, plan.details.snapshotDigest);
    assert.equal(prepared.startedAt, snapshot.startedAt); assert.equal(prepared.expiresAt, snapshot.expiresAt);
    for (const ref of [subject, { type: 'CatalogRead', id: snapshot.id }]) {
      const view = graph.read(owner, ref); assert.equal(view.source.kind, 'provider');
      assert.equal(checkedCatalogSnapshot(view.properties.snapshot).evidenceKind, 'live_readonly');
      const offers = graph.related(owner, ref, 'offers', { remaining: 1000 })!; assert.equal(offers.length, snapshot.items.length);
      for (const offer of offers) { assert.equal(offer.properties.priceKind, 'display_price'); assert.equal(offer.properties.pricingCompleteness, 'partial'); assert.equal(offer.properties.capacity, 'unknown'); }
    }
  } finally { db.close(); }
  const http = readFileSync(join(runtime, 'http.jsonl')).subarray(baseline.httpAuditBytes).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const a2a = http.filter(r => r.path === '/a2a');
  const sends = a2a.filter(r => r.method === 'SendMessage');
  assert.equal(sends.length, 1); assert.equal(sends[0].messageId, session.requestId);
  assert.equal(sends[0].taskId, undefined, 'The PA submitted one new task');
  assert(a2a.some(r => r.method === 'GetTask' && r.taskId === job.id && Date.parse(r.at) >= Date.parse(job.updatedAt)));
  assert(a2a.every(r => r.httpStatus === 200 && (r.method === 'SendMessage' ? r.messageId === session.requestId : r.method === 'GetTask' && r.taskId === job.id)));
  const release = read(join(runtime, 'release.json')), build = createHash('sha256');
  for (const path of release.files as string[]) { const bytes = readFileSync(join(release.release, path)); assert(bytes.equals(readFileSync(resolve(path)))); build.update(path + '\0'); build.update(bytes); }
  assert.equal(build.digest('hex'), release.buildDigest); assert.equal(release.buildDigest, deployment.release.buildDigest);
  const sources = read(join(directory, 'source-hashes.json'));
  for (const [path, hash] of Object.entries(sources.sha256)) assert.equal(fileSha(resolve(path)), hash, `Source changed since PA submission: ${path}`);
  const health = await fetch('http://127.0.0.1:3430/health').then(r => r.json());
  assert.equal(health.releaseDigest, release.buildDigest); assert.equal(health.backend, 'ontology-execution-v7');
  const evidence = {
    passed: true, recordedAt: new Date().toISOString(), scope: 'Actual Monk PA on connected Mac -> A2A -> Codex grounding and Ontology planning -> anonymous Shopify catalog and independent merchant lookup -> accepted artifact -> PA GetTask -> independent MCP and database readback',
    taskId: job.id, requestId: session.requestId, createdAt: job.createdAt, completedAt: job.updatedAt,
    buildDigest: release.buildDigest, businessModel: businessModel.ref, configurationDigest: adapter.configurationDigest,
    sourceFrozenAt: sources.capturedBeforeRun, sourceHashManifestSha256: fileSha(join(directory, 'source-hashes.json')),
    connectionAndCredentialsUnchanged: true, previousJobsUnchanged: baseline.oldJobs.length,
    query: snapshot.query, merchant: snapshot.merchant, items: snapshot.items, sourceReads: snapshot.receipts, totalSourceReadsIncludingPreviousAttempts: totalSourceReads, previousAttempts,
    modelReceipts: job.runs, ontologyPlanning: plan.ontologyPlanning, planningEvaluation,
    acceptance: d.acceptance, businessFacts: d.businessFacts, completionTarget: plan.completionTarget,
    stockQuantity: snapshot.stockQuantity, deliveryCommitment: snapshot.deliveryCommitment, partnerTrust: snapshot.partnerTrust,
    noBusinessWrites: true, paArtifactDigest: digest(peer.artifacts[0].parts[0].data), observerArtifactDigest: digest(job.artifact!.data),
    paReceivedFileSha256: fileSha(join(directory, 'pa-received.json')), originalArtifactFileSha256: fileSha(join(directory, 'artifact-original.json')),
    a2aTrace: a2a, snapshot,
  };
  const serialized = JSON.stringify(evidence, null, 2) + '\n'; assert(!serialized.includes(token));
  writeFileSync(join(directory, 'verification.json'), serialized, { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, taskId: job.id, items: snapshot.items.length, sourceReads: snapshot.receipts.length, modelRuns: job.runs!.length, buildDigest: release.buildDigest }));
} finally { await client.close(); }
