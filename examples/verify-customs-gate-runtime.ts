// Independent readback of a quote-only actual-model test. This observer never
// creates a task, invokes a model, grants authority or calls a business source.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { digest } from '../packages/core/delegation.js';
import { readConfig } from '../packages/core/config.js';
import type { Job } from '../packages/core/domain.js';
import type { ActionIntent, ExecutionAttempt } from '../packages/ontology/actions.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { businessModel } from '../packages/ontology/business-model.js';
import { CUSTOMS_POLICY_DIGEST, CUSTOMS_RULE_REF, CUSTOMS_REFERENCES, CUSTOMS_REFERENCE_REFS } from '../packages/ontology/customs-policy.js';
import { checkedCommerceObservation, sourcePayloadDigest } from '../packages/ontology/commerce-journey-functions.js';
import { sandboxResponseSchema } from '../packages/capabilities/commerce-sandbox/connector.js';
import { CommerceAgentProgram } from '../packages/capabilities/commerce-agent.js';

assert(process.argv.includes('--observe'));
const index = process.argv.indexOf('--session-dir'); assert(index >= 0 && process.argv[index + 1]);
const directory = resolve(process.argv[index + 1]!), runtime = join(homedir(), '.local/share/eigos/grok-life');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const lines = (path: string, offset: number) => readFileSync(path).subarray(offset).toString().trim().split('\n').filter(Boolean).map(v => JSON.parse(v));
const session = read(join(directory, 'session.json')), baseline = read(join(directory, 'baseline.json')), deployment = read(join(directory, 'deployment-before-run.json')), manifest = read(join(directory, 'source-hashes.json'));
const received = read(join(directory, 'test-driver-received.json')), profile = read(join(runtime, 'profile.json'));
assert.equal(session.origin, 'Codex test driver; actual EIGOS LLM; not a PA end-to-end run'); assert.equal(received.id, session.taskId); assert.equal(received.status.state, 'TASK_STATE_COMPLETED');
assert.equal(sha(readFileSync(session.inputFile)), baseline.inputSha256);
const config = readConfig(parseEnv(readFileSync(join(runtime, 'server.env'), 'utf8'))), token = readFileSync(profile.tokenFile, 'utf8').trim(), signingKey = readFileSync(config.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE!, 'utf8').trim();
assert.equal(config.EIGOS_COMMERCE_SANDBOX_URL, 'http://127.0.0.1:3432'); assert.equal(config.EIGOS_PAOTUI_ORDERS_ENABLED, 'false'); assert.equal(config.EIGOS_EXECUTOR, 'codex');
const program = new CommerceAgentProgram({ endpoint: config.EIGOS_COMMERCE_SANDBOX_URL!, tokenFile: config.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE! });
const client = new Client({ name: 'customs-gate-independent-observer', version: '1' });
const db = new DatabaseSync(join(runtime, 'tasks.sqlite'), { readOnly: true }), memory = new DatabaseSync(':memory:');
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3430/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const response = await client.callTool({ name: 'get_task', arguments: { taskId: session.taskId } }); assert(!response.isError);
  const job = (response.structuredContent as { result: Job }).result, delegation = job.delegation!, state = delegation.agent!, owner = JSON.stringify(['local-development', 'local', 'developer']);
  assert.equal(job.state, 'completed'); assert.equal(delegation.backendVersion, 'ontology-execution-v10'); assert(delegation.acceptance?.accepted); assert.equal(delegation.request.executionEnvironment, 'sandbox');
  assert.deepEqual(state.programRef, program.ref); assert.equal(state.programDigest, program.configurationDigest); assert.equal(job.messages[0]!.id, session.requestId);
  assert.equal(job.messages.filter(m => m.role === 'user').length, 1); assert.equal(delegation.agentHistory?.length ?? 0, 0);
  assert.equal(digest(received.artifacts[0].parts[0].data), digest(job.artifact!.data));
  const persisted = JSON.parse(String(db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(owner, job.id)!.body)) as Job;
  assert.equal(digest(persisted.artifact), digest(job.artifact));
  for (const old of baseline.oldJobs) assert.equal(sha(String(db.prepare('SELECT body FROM jobs WHERE id=?').get(old.id)!.body)), old.sha256);
  assert.equal(db.prepare('SELECT count(*) AS n FROM plan_grants WHERE owner=? AND job_id=?').get(owner, job.id)!.n, 0);
  const intents = db.prepare('SELECT body FROM action_intents WHERE owner=? AND job_id=?').all(owner, job.id).map(r => JSON.parse(String(r.body)) as ActionIntent);
  assert(intents.length && intents.every(i => i.effect === 'read')); assert(intents.every(i => ['effect_confirmed', 'rejected', 'canceled_before_dispatch'].includes(i.state)));
  assert(job.runs!.every(r => r.runtime === 'codex-exec' && r.threadId && /^[a-f0-9]{64}$/.test(r.outputSha256)));
  const run = (id: string) => { const value = job.runs!.find(r => r.id === id); assert(value); return value; };
  new OntologyObjectStore(memory, businessModel);
  for (const table of ['ontology_objects', 'ontology_links', 'ontology_revisions']) for (const row of db.prepare(`SELECT * FROM ${table} WHERE owner=?`).all(owner)) { const values = Object.values(row); memory.prepare(`INSERT INTO ${table} VALUES(${values.map(() => '?').join(',')})`).run(...values); }
  const graphAt = (at: string) => new OntologyObjectStore(memory, businessModel, () => Date.parse(at));
  const gates: unknown[] = [];
  for (const plan of state.plans) {
    const { digest: expected, ...body } = plan; assert.equal(digest(body), expected); assert.equal(run(plan.modelRunId).decisionDigest, digest(plan.modelDecision));
    assert.deepEqual(plan.ontologyPlanning.model, businessModel.ref);
    for (const [n, step] of plan.steps.entries()) {
      const { input, definitionDigest, intentId: _intent, operationKey: _key, effect: _effect, additionalEffects: _extra, cost: _cost, operationScope: _scope, ...choice } = step;
      assert.deepEqual(choice, plan.modelDecision.steps[n]); assert.deepEqual(input, JSON.parse(step.argumentsJson)); assert.equal(definitionDigest, digest(businessModel.action(step.action)));
      if (step.action !== 'QuoteCommerceLandedCost' || intents.find(i => i.id === step.intentId)?.state !== 'effect_confirmed') continue;
      const call = { function: 'customsGateStatus', object: input.customs }, receipt = plan.ontologyPlanning.reads.find(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(call)); assert(receipt);
      const evaluated = graphAt(receipt.at).evaluate(owner, call); assert.equal(digest(evaluated), receipt.outputDigest); assert.equal((evaluated.value as any).status, 'pass_sandbox'); assert.equal((evaluated.value as any).legalApproval, false);
      for (const ref of [CUSTOMS_RULE_REF, ...CUSTOMS_REFERENCE_REFS]) assert(plan.ontologyPlanning.reads.some(r => r.tool === 'query_ontology' && r.status === 'ok' && r.at <= receipt.at && (r.objects.some(o => digest(o.ref) === digest(ref)) || r.inputDigest === digest({ object: ref }) || r.inputDigest === digest({ from: { type: 'ServiceRequest', id: job.id }, link: ref.type === 'CustomsRuleSet' ? 'customsRuleSets' : 'regulatoryReferences' }))), 'Missing actual model policy/reference query');
      gates.push({ planId: plan.id, modelRunId: plan.modelRunId, receipt, evaluated });
    }
  }
  assert(gates.length > 0);
  const rows = lines(join(config.EIGOS_COMMERCE_SANDBOX_AUDIT_DIR!, 'http.jsonl'), baseline.commerceAuditBytes).filter(r => r.requestId === job.id);
  const observations = state.observations.map(ref => ({ ref, snapshot: checkedCommerceObservation(graphAt(job.updatedAt).read(owner, ref).properties.snapshot) }));
  for (const row of rows) {
    const plan = state.plans.find(p => p.id === row.planId)!, step = plan?.steps.find(s => s.intentId === row.intentId); assert(plan && step && step.effect === 'read'); assert.equal(row.action, step.action); assert.equal(row.modelRunId, plan.modelRunId);
    const attempt = JSON.parse(String(db.prepare('SELECT body FROM action_attempts WHERE owner=? AND id=? AND intent_id=?').get(owner, row.attemptId, row.intentId)!.body)) as ExecutionAttempt;
    const input = structuredClone(step.input); for (const link of step.inputRefs) input[link.targetKey] = intents.find(i => i.id === plan.steps.find(s => s.id === link.stepId)!.intentId)!.acceptedOutput!.object;
    assert.equal(attempt.inputDigest, digest(input)); assert.equal(attempt.planDigest, plan.digest); assert.equal(attempt.kind, 'dispatch'); assert(Date.parse(run(plan.modelRunId).completedAt) <= Date.parse(attempt.startedAt)); assert(Date.parse(attempt.startedAt) <= Date.parse(row.startedAt));
    assert.equal(row.operationKey, step.operationKey); assert.equal(row.status, 200); assert.equal(row.path, `/actions/${step.action}`);
    assert.equal(row.inputDigest, digest({ method: row.method, path: row.path, context: row.transportInput.context, payload: row.transportInput.payload }));
    const bytes = readFileSync(join(config.EIGOS_COMMERCE_SANDBOX_AUDIT_DIR!, `${row.id}.json`)); assert.equal(sha(bytes), row.responseSha256); assert.equal(createHmac('sha256', signingKey).update(bytes).digest('hex'), row.signature);
    const source = sandboxResponseSchema.parse(JSON.parse(bytes.toString())), observation = observations.find(o => o.snapshot.receipt.id === row.id); assert(observation); assert.equal(sourcePayloadDigest(source.result), observation.snapshot.receipt.payloadDigest); assert.deepEqual(source.result.data, observation.snapshot.data); assert.deepEqual(source.context, row.transportInput.context);
  }
  const sourceDb = new DatabaseSync(join(homedir(), '.local/share/eigos/commerce-sandbox/sandbox.sqlite'), { readOnly: true });
  let sourceAudit: any[];
  try { sourceAudit = sourceDb.prepare('SELECT body FROM audit WHERE ordinal>?').all(baseline.sourceAuditOrdinal).map(r => JSON.parse(String(r.body))).filter(r => r.requestId === job.id); } finally { sourceDb.close(); }
  assert.equal(sourceAudit.length, rows.length); assert(sourceAudit.every(r => r.effect === 'read' && r.realOperationsAllowed === false && rows.some(o => o.attemptId === r.attemptId && o.operationKey === r.operationKey)));
  const complete = state.completion!; assert(complete); assert.equal(run(complete.modelRunId).decisionDigest, digest(complete.modelDecision)); assert.deepEqual(complete.proposal, JSON.parse(complete.modelDecision.completionJson));
  const selected = (complete.proposal as any).selected, completionCall = { function: 'commerceObservationStatus', object: selected }, completionRead = complete.ontologyPlanning.reads.find(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(completionCall)); assert(completionRead);
  assert.equal(digest(graphAt(completionRead.at).evaluate(owner, completionCall)), completionRead.outputDigest);
  const independent = program.complete({ graph: graphAt(job.updatedAt), owner, request: delegation.request, state, intents }, complete.proposal, complete.ontologyPlanning); assert.equal(digest(independent.artifact), digest(job.artifact));
  const result = job.artifact!.data.result as any; assert.equal(result.target, 'quote'); assert.equal(result.realOperationsAllowed, false); assert.equal(result.customsPolicy.policyDigest, CUSTOMS_POLICY_DIGEST); assert.equal(result.customsPolicy.legalApproval, false); assert.equal(result.quote.buyerTotal.minor, '27000'); assert.equal(result.quote.buyerTotal.currency, 'CNY');
  for (const [file, hash] of Object.entries(baseline.files)) assert.equal(sha(readFileSync(join(runtime, file))), hash);
  for (const [file, hash] of Object.entries(manifest.sha256)) assert.equal(sha(readFileSync(resolve(file))), hash);
  for (const release of [deployment.release, deployment.sandboxRelease]) { const hash = createHash('sha256'); for (const file of release.files) { const bytes = readFileSync(join(release.release, file)); assert(bytes.equals(readFileSync(resolve(file)))); hash.update(file + '\0'); hash.update(bytes); } assert.equal(hash.digest('hex'), release.buildDigest); }
  const proof = { passed: true, recordedAt: new Date().toISOString(), origin: session.origin, taskId: job.id, requestId: session.requestId, createdAt: job.createdAt, completedAt: job.updatedAt, sourceCommit: manifest.sourceCommit, buildDigest: deployment.release.buildDigest, sandboxBuildDigest: deployment.sandboxRelease.buildDigest, backend: delegation.backendVersion, businessModel: businessModel.ref, policyDigest: CUSTOMS_POLICY_DIGEST, references: CUSTOMS_REFERENCES, modelRuns: job.runs, plans: state.plans, ontologyReads: delegation.ontologyReads, gates, completion: complete, observations, sourceCalls: rows, sourceAudit, feedback: state.feedback, acceptance: delegation.acceptance, result, previousJobsUnchanged: baseline.oldJobs.length, connectionFilesUnchanged: true, sourceFilesUnchanged: Object.keys(manifest.sha256).length, artifactDigest: digest(job.artifact!.data), receivedFileSha256: sha(readFileSync(join(directory, 'test-driver-received.json'))), businessWrites: 0, realTransactions: 0 };
  const serialized = JSON.stringify(proof, null, 2) + '\n'; assert(!serialized.includes(token)); assert(!serialized.includes(signingKey)); writeFileSync(join(directory, 'verification.json'), serialized, { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, taskId: job.id, modelCalls: job.runs!.length, sourceCalls: rows.length, gateEvaluations: gates.length, businessWrites: 0, realTransactions: 0 }));
} finally { memory.close(); db.close(); await client.close(); }
