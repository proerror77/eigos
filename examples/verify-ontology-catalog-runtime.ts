// Read-only diagnostic observer. No task submission, model call or Shopify call.
// Counterfactual checks modify only an isolated in-memory copy of ontology rows.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { digest, canonical } from '../packages/core/delegation.js';
import { readConfig } from '../packages/core/config.js';
import type { Job } from '../packages/core/domain.js';
import type { AgentProgram } from '../packages/core/agent-program.js';
import type { ActionIntent, ExecutionAttempt } from '../packages/ontology/actions.js';
import { checkedAgentCatalogObservation } from '../packages/ontology/catalog-agent-projection.js';
import { businessModel } from '../packages/ontology/business-model.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { planningSnapshot } from '../packages/ontology/planning-contract.js';
import { validatePlanningSnapshot } from '../packages/coordinator/planning-session.js';
import { SHOPIFY_TEST_PROFILE, SHOPIFY_UCP_VERSION } from '../packages/capabilities/shopify/read-only.js';

assert(process.argv.includes('--live'), 'Use --live to inspect this authorized local runtime');
const index = process.argv.indexOf('--session-dir'); assert(index >= 0 && process.argv[index + 1]);
const directory = resolve(process.argv[index + 1]!), runtime = join(homedir(), '.local/share/eigos/grok-life');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const session = read(join(directory, 'session.json')), baseline = read(join(directory, 'baseline.json')), received = read(join(directory, 'received.json')) as Job;
assert.equal(session.caller, 'Codex diagnostic MCP client, not the user Personal Agent');
const profile = read(join(runtime, 'profile.json')), token = readFileSync(profile.tokenFile, 'utf8').trim(), config = readConfig(parseEnv(readFileSync(join(runtime, 'server.env'), 'utf8')));
const release = baseline.release, build = createHash('sha256');
for (const path of release.files) { build.update(path + '\0'); build.update(readFileSync(join(release.release, path))); }
assert.equal(build.digest('hex'), release.buildDigest);
// Replay the completion verifier from the exact immutable runtime that ran this
// task, including when auditing a historical diagnostic with a known mapping gap.
const module = await import(pathToFileURL(join(release.release, 'dist/packages/capabilities/catalog-agent.js')).href);
const program = new module.CatalogAgentProgram(config.EIGOS_SHOPIFY_CATALOG_MERCHANTS) as AgentProgram;
const client = new Client({ name: 'codex-ontology-independent-verifier', version: '1' });
const owner = JSON.stringify(['local-development', 'local', 'developer']);
const db = new DatabaseSync(join(runtime, 'tasks.sqlite'), { readOnly: true });
const copy = new DatabaseSync(':memory:');
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3430/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const response = await client.callTool({ name: 'get_task', arguments: { taskId: received.id } }); assert(!response.isError);
  const job = (response.structuredContent as { result: Job }).result; assert.deepEqual(job, received);
  assert.equal(job.state, 'completed'); assert.equal(job.goal, session.goal); assert.equal(job.messages[0]!.id, session.requestId);
  const d = job.delegation!, state = d.agent!, completion = state.completion!;
  assert(d.acceptance?.accepted); assert.equal(d.backendVersion, 'ontology-execution-v8'); assert.equal(d.plan, undefined); assert.equal(d.resolution, undefined);
  assert.equal(state.programDigest, program.configurationDigest); assert(completion); assert.deepEqual(completion.ontologyPlanning.model, businessModel.ref);
  const stored = JSON.parse(String(db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(owner, job.id)!.body)) as Job;
  assert.equal(canonical(stored.artifact), canonical(job.artifact));
  for (const old of baseline.oldJobs) assert.equal(sha(String(db.prepare('SELECT body FROM jobs WHERE id=?').get(old.id)!.body)), old.sha256);
  const beforeQuery = readFileSync(join(config.EIGOS_SHOPIFY_AUDIT_DIR!, 'reads.jsonl')).subarray(baseline.sourceAuditBytes).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const sourceReads = beforeQuery.filter(row => row.requestId === job.id);
  const intents = db.prepare('SELECT state,body FROM action_intents WHERE owner=? AND job_id=? ORDER BY id').all(owner, job.id).map(row => ({ ...JSON.parse(String(row.body)), state: String(row.state) }) as ActionIntent);
  assert(intents.every(i => i.effect === 'read' && i.state === 'effect_confirmed'));
  assert.equal(sourceReads.length, intents.length); assert.equal(new Set(sourceReads.map(r => r.intentId)).size, sourceReads.length);
  assert(job.runs!.every(r => r.runtime === 'codex-exec' && r.threadId && /^[a-f0-9]{64}$/.test(r.outputSha256)));
  for (const plan of state.plans) {
    assert(plan.modelRunId && plan.modelDecision && !plan.callerDecision, 'Expected original model-selected source evidence');
    const { digest: hash, ...body } = plan; assert.equal(digest(body), hash);
    const run = job.runs!.find(r => r.id === plan.modelRunId)!; assert.equal(run.decisionDigest, digest(plan.modelDecision));
    assert.equal(plan.steps.length, plan.modelDecision.steps.length);
    assert(plan.ontologyPlanning.reads.some(r => r.tool === 'describe_ontology' && r.status === 'ok'));
    assert(plan.ontologyPlanning.reads.some(r => r.tool === 'query_ontology' && r.status === 'ok' && r.objects.some(o => digest(o.ref) === digest(state.scope))));
    for (const [i, step] of plan.steps.entries()) {
      const { input, definitionDigest, intentId, ...choice } = step; assert.deepEqual(choice, plan.modelDecision.steps[i]); assert.deepEqual(input, JSON.parse(step.argumentsJson));
      assert.equal(definitionDigest, digest(businessModel.action(step.action)));
      const rows = sourceReads.filter(r => r.intentId === intentId); assert.equal(rows.length, 1); const row = rows[0];
      assert.equal(row.planId, plan.id); assert.equal(row.modelRunId, plan.modelRunId); assert.equal(row.action, step.action); assert.equal(row.configurationDigest, state.programDigest);
      const attempts = db.prepare('SELECT body FROM action_attempts WHERE owner=? AND intent_id=?').all(owner, intentId).map(r => JSON.parse(String(r.body)) as ExecutionAttempt); assert.equal(attempts.length, 1);
      const attempt = attempts[0]!, resolved = structuredClone(input);
      for (const ref of step.inputRefs) resolved[ref.targetKey] = intents.find(i => i.id === plan.steps.find(s => s.id === ref.stepId)!.intentId)!.acceptedOutput!.object;
      assert.equal(row.actionInputDigest, digest(resolved)); assert.equal(attempt.inputDigest, digest(resolved)); assert.equal(row.attemptId, attempt.id);
      assert(Date.parse(run.completedAt) <= Date.parse(attempt.startedAt)); assert(Date.parse(attempt.startedAt) <= Date.parse(row.receipt.startedAt));
      assert.equal(row.receipt.authentication, 'anonymous'); assert.equal(row.receipt.httpStatus, 200);
      const raw = readFileSync(join(config.EIGOS_SHOPIFY_AUDIT_DIR!, 'responses', `${row.receipt.id}.json`)); assert.equal(sha(raw), row.receipt.responseSha256); assert.equal(raw.length, row.receipt.responseBytes);
      const body = JSON.parse(raw.toString());
      if (step.action === 'DiscoverMerchantCatalog') { assert.equal(row.receipt.operation, 'discovery'); assert.equal(row.receipt.inputSha256, sha('')); assert.equal(row.receipt.endpoint, `https://${config.EIGOS_SHOPIFY_CATALOG_MERCHANTS![0]!.domain}/.well-known/ucp`); }
      else {
        assert(['SearchPublicCatalog', 'InspectCatalogVariant', 'ReadMerchantVariants'].includes(step.action));
        const merchant = config.EIGOS_SHOPIFY_CATALOG_MERCHANTS![0]!, context = { address_country: 'US' };
        const expected = step.action === 'SearchPublicCatalog' ? { operation: 'search_catalog', endpoint: 'https://catalog.shopify.com/api/ucp/mcp', input: { query: resolved.query, context, pagination: { limit: resolved.limit }, filters: { shops: [merchant.shopId] } } }
          : step.action === 'InspectCatalogVariant' ? { operation: 'get_product', endpoint: 'https://catalog.shopify.com/api/ucp/mcp', input: { id: resolved.variantId, context, filters: { shops: [merchant.shopId] } } }
          : { operation: 'lookup_catalog', endpoint: `https://${merchant.domain}/api/ucp/mcp`, input: { ids: resolved.variantIds, context } };
        assert.equal(row.receipt.operation, expected.operation); assert.equal(row.receipt.endpoint, expected.endpoint); assert.deepEqual(row.transportInput, expected.input);
        const request = { jsonrpc: '2.0', id: body.id, method: 'tools/call', params: { name: expected.operation, arguments: { meta: { 'ucp-agent': { profile: SHOPIFY_TEST_PROFILE } }, catalog: row.transportInput } } };
        assert.equal(sha(JSON.stringify(request)), row.receipt.inputSha256); assert.equal(body.error, undefined); assert(!body.result.isError); assert.equal(body.result.structuredContent.ucp.version, SHOPIFY_UCP_VERSION);
      }
    }
  }
  assert.equal(job.runs!.find(r => r.id === completion.modelRunId)!.decisionDigest, digest(completion.modelDecision));
  const graph = new OntologyObjectStore(db, businessModel, () => Date.parse(job.updatedAt));
  const selection = (job.artifact!.data.result as { catalogAnswer: any }).catalogAnswer.selections[0];
  const subject = selection.observation, observation = checkedAgentCatalogObservation(graph.read(owner, subject).properties.snapshot);
  assert.equal(observation.action, 'ReadMerchantVariants'); assert.equal(observation.evidenceKind, 'live_readonly');
  assert.deepEqual(selection.items, observation.items); assert.equal(observation.items.length, 1); assert.equal(observation.items[0]!.variantId, 'gid://shopify/ProductVariant/36130238136487');
  const source = read(join(config.EIGOS_SHOPIFY_AUDIT_DIR!, 'responses', `${observation.receipt.id}.json`)).result.structuredContent;
  const pairs = source.products.flatMap((p: any) => p.variants.map((v: any) => ({ p, v }))).filter(({ v }: any) => v.id === observation.items[0]!.variantId && v.inputs.some((i: any) => i.id === v.id && i.match === 'exact')); assert.equal(pairs.length, 1);
  const { p, v } = pairs[0], item = observation.items[0]!;
  assert.equal(item.productId, p.id); assert.equal(item.sku, v.sku); assert.deepEqual(item.displayPrice, { minor: String(v.price.amount), currency: v.price.currency }); assert.equal(item.availableReported, v.availability.available);
  const expectedTitle = v.title && v.title !== p.title ? `${p.title} — ${v.title}` : p.title;
  const productNamePreserved = item.title === expectedTitle;
  const evaluate = { function: 'catalogObservationStatus', object: subject };
  const receipt = completion.ontologyPlanning.reads.find(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(evaluate)); assert(receipt);
  const atRead = new OntologyObjectStore(db, businessModel, () => Date.parse(receipt.at)), status = atRead.evaluate(owner, evaluate);
  assert.equal(status.status, 'known'); assert.equal(digest(status), receipt.outputDigest);
  assert(completion.ontologyPlanning.reads.some(r => r.tool === 'query_ontology' && r.status === 'ok' && r.objects.some(o => digest(o.ref) === digest(subject))));
  const ctx = { graph, owner, request: d.request, state };
  assert.deepEqual(program.complete(ctx, completion.proposal, completion.ontologyPlanning).artifact.data, job.artifact!.data);
  const { digest: _digest, ...snapshot } = completion.ontologyPlanning;
  assert.throws(() => validatePlanningSnapshot(graph, owner, d.request, planningSnapshot({ ...snapshot, reads: [] }), true), /actual definition and object reads/);
  assert.throws(() => program.complete(ctx, completion.proposal, planningSnapshot({ ...snapshot, reads: snapshot.reads.filter(r => r.tool !== 'evaluate_ontology') })), /source-status evaluation/);
  const expired = new OntologyObjectStore(db, businessModel, () => Date.parse(observation.expiresAt) + 1).evaluate(owner, evaluate); assert.equal(expired.status, 'unknown'); assert.match(expired.reason!, /expired/);
  const tampered = new OntologyObjectStore(copy, businessModel, () => Date.parse(job.updatedAt));
  for (const row of db.prepare('SELECT * FROM ontology_objects WHERE owner=?').all(owner)) copy.prepare('INSERT INTO ontology_objects VALUES(?,?,?,?,?,?)').run(String(row.owner), String(row.type), String(row.id), Number(row.revision), String(row.definition_digest), String(row.body));
  for (const row of db.prepare('SELECT * FROM ontology_links WHERE owner=?').all(owner)) copy.prepare('INSERT INTO ontology_links VALUES(?,?,?,?,?,?,?)').run(String(row.owner), String(row.type), String(row.from_type), String(row.from_id), String(row.to_type), String(row.to_id), String(row.definition_digest));
  const prior = tampered.read(owner, subject), changed = structuredClone(observation), { contentDigest: _old, ...changedBody } = changed;
  changedBody.items[0]!.displayPrice!.minor = '1';
  tampered.ingest(owner, { objects: [{ ref: subject, expectedRevision: prior.revision, properties: { ...prior.properties, snapshot: { ...changedBody, contentDigest: digest(changedBody) } } }] }, { kind: 'provider', id: 'counterfactual-local-copy', observedAt: job.updatedAt });
  const invalid = tampered.evaluate(owner, evaluate); assert.equal(invalid.status, 'unknown'); assert.match(invalid.reason!, /source evidence/);
  assert.throws(() => program.complete({ ...ctx, graph: tampered }, completion.proposal, completion.ontologyPlanning), /source evidence/);
  assert.equal(canonical(JSON.parse(String(db.prepare('SELECT body FROM jobs WHERE id=?').get(job.id)!.body)).artifact), canonical(job.artifact));
  const evidence = { passed: productNamePreserved, runtimeTracePassed: true, productNamePreserved, recordedAt: new Date().toISOString(), caller: session.caller, taskId: job.id, requestId: session.requestId,
    observedAt: observation.observedAt, completedAt: job.updatedAt, executedSourceCommit: release.sourceCommit, sourceTreeDirtyAtDeployment: release.sourceTreeDirty, executedBuildDigest: release.buildDigest, model: businessModel.ref, modelReceipts: job.runs, ontologyReads: d.ontologyReads,
    actionPlans: state.plans, completion, sourceReads, sourceProductTitle: p.title, sourceVariantTitle: v.title, expectedTitle, actualTitle: item.title, item,
    finalEvaluation: { receipt, status }, counterfactualChecks: { missingOntologyReadRejected: true, missingSourceEvaluationRejected: true, expiredSourceUnknown: true, alteredPriceWithoutMatchingSourceUnknown: true, alteredPriceCompletionRejected: true, mutationsConfinedToMemoryCopy: true },
    acceptance: d.acceptance, artifactDigest: digest(job.artifact!.data), independentMcpAndDatabaseReadback: true, historicalJobsUnchanged: baseline.oldJobs.length, noBusinessWrites: true,
    userPaRoundTripVerified: false, limitations: ['This is a diagnostic MCP caller, not the user Personal Agent', 'No cart, checkout, order, payment or fulfillment', ...(productNamePreserved ? [] : ['The original mapper dropped the product name and returned only the variant option label'])] };
  const serialized = JSON.stringify(evidence, null, 2) + '\n'; assert(!serialized.includes(token)); writeFileSync(join(directory, 'verification.json'), serialized, { mode: 0o600 });
  console.log(JSON.stringify({ passed: evidence.passed, runtimeTracePassed: true, taskId: job.id, modelCalls: job.runs!.length, ontologyReads: d.ontologyReads!.length, actions: state.plans.flatMap(p => p.steps.map(s => s.action)), sourceReads: sourceReads.length, productNamePreserved, title: item.title, counterfactualChecks: evidence.counterfactualChecks }));
  if (!productNamePreserved) process.exitCode = 2;
} finally { copy.close(); db.close(); await client.close(); }
