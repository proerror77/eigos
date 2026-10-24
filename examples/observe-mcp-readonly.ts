// Readback only: never submits a goal, invokes a provider, or advances a task.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { digest } from '../packages/core/delegation.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import type { Job } from '../packages/core/domain.js';
import type { ActionIntent } from '../packages/ontology/actions.js';

const argument = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
assert(process.argv.includes('--live'), 'Use --live only to inspect an authorized existing test');
assert(argument('--session-dir'), 'Supply --session-dir with saved submit/final receipts');
const directory = resolve(argument('--session-dir')!), runtime = resolve(argument('--runtime-dir') ?? join(homedir(), '.local/share/eigos/grok-life'));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const finalFile = ['get-final.json', 'pa-received.json'].map(name => join(directory, name)).find(existsSync);
assert(finalFile, 'Save an actual caller GetTask receipt first');
const caller = read(finalFile), id = caller.id;
assert.equal(caller.status.state, 'TASK_STATE_COMPLETED');
const profile = read(join(runtime, 'profile.json')), origin = new URL(profile.cardUrl);
assert(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname), 'Only the existing local personal runtime is supported');
const file = lstatSync(profile.tokenFile); assert(file.isFile() && !file.isSymbolicLink() && !(file.mode & 0o077));
const token = readFileSync(profile.tokenFile, 'utf8').trim();
const client = new Client({ name: 'ontology-mcp-readback-observer', version: '2' });
let job: Job;
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const result = await client.callTool({ name: 'get_task', arguments: { taskId: id } }); assert(!result.isError);
  job = (result.structuredContent as { result: Job }).result;
} finally { await client.close(); }
assert.equal(job.id, id); assert.equal(job.state, 'completed');
const delegation = job.delegation!;
assert.equal(delegation.backendVersion, BACKEND_VERSION, 'Use a matching archived observer for historical backend evidence; never reinterpret it');
assert(delegation.acceptance?.accepted && delegation.agent);
assert(job.runs?.length && job.runs.every(run => run.threadId && (run.runtime === 'codex-exec' || run.runtime === 'codex-app-server' && run.turnId)), 'This observer requires actual Worker model turns, not a synthetic reasoner');
assert(caller.artifacts.flatMap((a: { parts: { data?: unknown }[] }) => a.parts).some((part: { data?: unknown }) => part.data && digest(part.data) === digest(job.artifact!.data)), 'Caller and MCP readback differ');
const db = new DatabaseSync(join(runtime, 'tasks.sqlite'), { readOnly: true });
const owner = JSON.stringify(['local-development', 'local', 'developer']);
try {
  const saved = db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(owner, id); assert(saved);
  const stored = JSON.parse(String(saved.body)) as Job;
  // GetTask adds current ledger views without changing the stored task body.
  const { actions, businessFacts, authorizationBudget, ...baseDelegation } = delegation;
  const { actions: _actions, businessFacts: _facts, authorizationBudget: _budget, ...storedDelegation } = stored.delegation!;
  assert.equal(digest({ ...stored, delegation: storedDelegation }), digest({ ...job, delegation: baseDelegation }));
  // Quote freshness may have elapsed while CI was running: this is explicitly a replay at acceptance.
  const intents = db.prepare('SELECT body FROM action_intents WHERE owner=? AND job_id=? ORDER BY id').all(owner, id).map(r => JSON.parse(String(r.body)) as ActionIntent);
  assert(intents.length && intents.every(i => i.effect === 'read'), 'A prior task revision contains a business effect');
  assert.equal(digest(actions), digest(intents.map(i => ({ id: i.id, stepId: i.stepId, state: i.state, remoteRef: i.remoteRef, latestObservationId: i.latestObservationId }))));
  assert.equal(digest(businessFacts), digest(intents.flatMap(i => i.businessSnapshot ? [{ intentId: i.id, snapshot: i.businessSnapshot.value, sourceVersion: i.businessSnapshot.sourceVersion, evidenceRefs: i.businessSnapshot.evidenceRefs }] : [])));
  assert.deepEqual(authorizationBudget, []);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM budget_reservations b JOIN action_intents i ON i.id=b.intent_id WHERE b.owner=? AND i.job_id=?').get(owner, id)!.count), 0);
  const at = Date.parse(delegation.acceptance.at), graph = new OntologyObjectStore(db, undefined, () => at);
  const readById = new Map((delegation.ontologyReads ?? []).map(read => [read.id, read]));
  const contextEvidence = job.runs!.flatMap(run => {
    const context = run.ontologyContext;
    if (!context) return [];
    assert.equal(digest(context.model), digest(graph.model.ref));
    const reads = context.receiptIds.map(id => { const read = readById.get(id); assert(read && read.origin === 'worker_context'); return read; });
    assert.equal(new Set(context.receiptIds).size, reads.length);
    assert(reads.length && reads.length <= 10);
    assert(reads.every(read => read.at >= context.startedAt && read.at <= context.preparedAt));
    assert(context.preparedAt <= (run.requestSentAt ?? run.startedAt));
    assert.equal(context.digest, digest({ model: context.model, requestRevision: context.requestRevision, reads }));
    return [{ modelRunId: run.id, digest: context.digest, reads: reads.length, preparedBeforeModel: true }];
  });
  const bindings = delegation.agent.plans.flatMap(plan => {
    assert(plan.modelDecision, 'This model-read observer requires a recorded model decision');
    assert.equal(digest(plan.ontologyPlanning.model), digest(graph.model.ref), 'Independent ontology definition changed');
    const run = job.runs!.find(r => r.id === plan.modelRunId); assert(run);
    if (plan.initialSelection) {
      const proof = plan.initialSelection, original = delegation.groundingDecisions?.find(selected => selected.modelRunId === plan.modelRunId)?.decision;
      assert(original?.kind === 'resolve' && original.initialSteps?.length);
      assert.equal(plan.sequence, 1); assert.equal(proof.modelRunId, plan.modelRunId);
      assert.equal(run.decisionDigest, digest(original));
      assert.equal(digest(original.capabilityRef), digest(plan.programRef));
      assert.equal(plan.modelDecision.message, original.message);
      assert.equal(plan.modelDecision.kind, 'execute'); assert.equal(plan.modelDecision.requestRevision, original.requestRevision);
      assert.equal(plan.modelDecision.steps.length, original.initialSteps.length);
      assert.equal(plan.modelDecision.completionJson, '');
      for (const [index, draft] of original.initialSteps.entries()) {
        const definition = graph.model.action(draft.action); assert(definition.read?.mcp && !definition.read.mcp.requires.length);
        assert(proof.definitionActions.includes(draft.action));
        const args = JSON.parse(draft.argumentsJson); assert(draft.scopeInputs.length && new Set(draft.scopeInputs).size === draft.scopeInputs.length);
        for (const key of draft.scopeInputs) { assert(!Object.hasOwn(args, key)); assert(Object.hasOwn(definition.inputs, key)); assert(graph.model.implements(plan.scope.type, definition.inputs[key]!)); args[key] = plan.scope; }
        assert.equal(digest(plan.modelDecision.steps[index]), digest({ id: draft.id, action: draft.action, argumentsJson: JSON.stringify(args), dependsOn: [], inputRefs: [] }));
      }
      const { digest: expected, ...source } = proof.groundingPlanning; assert.equal(digest(source), expected);
      assert(proof.definitionActions.length <= 8);
      const functions = [...new Set(proof.definitionActions.flatMap(id => {
        const read = graph.model.action(id).read; assert(read?.mcp);
        return [...read.mcp.requires.map(dependency => dependency.evaluate), ...(read.module ? [read.module.completion.evaluate] : [])];
      }))];
      const definitionInput = { search: 'ServiceRequest', limit: 1, actions: proof.definitionActions, functions: functions.slice(0, 20), includeLinks: false };
      assert(source.reads.some(read => read.tool === 'describe_ontology' && read.status === 'ok' && read.inputDigest === digest(definitionInput)));
      assert(source.reads.every(read => read.at <= (run.requestSentAt ?? run.startedAt)));
      assert(plan.ontologyPlanning.reads.every(read => read.at >= run.completedAt && read.at <= plan.createdAt));
      const combined = [...source.reads, ...plan.ontologyPlanning.reads];
      assert(combined.length <= 20 && new Set(combined.map(read => read.id)).size === combined.length);
      assert(combined.every(read => read.outputBytes !== undefined && digest(read) === digest(readById.get(read.id))));
      assert(combined.reduce((sum, read) => sum + read.outputBytes!, 0) <= 200000);
      if (run.ontologyContext) assert(run.ontologyContext.receiptIds.every(id => source.reads.some(read => read.id === id)));
    } else assert.equal(run.decisionDigest, digest(plan.modelDecision));
    if (run.ontologyContext && !plan.initialSelection) {
      assert.equal(run.ontologyContext.requestRevision, plan.requestRevision);
      assert(run.ontologyContext.receiptIds.every(id => plan.ontologyPlanning.reads.some(read => read.id === id)));
    }
    return plan.steps.map(step => {
      assert.equal(step.effect, 'read');
      const definition = graph.model.action(step.action); assert(definition.read?.mcp && definition.read.module);
      assert.equal(step.definitionDigest, digest(definition));
      const intent = db.prepare('SELECT body FROM action_intents WHERE owner=? AND id=?').get(owner, step.intentId); assert(intent);
      const accepted = JSON.parse(String(intent.body)); assert.equal(accepted.effect, 'read'); assert.equal(accepted.state, 'effect_confirmed');
      const ref = accepted.acceptedOutput.object;
      const snapshot = graph.read(owner, ref).properties.snapshot as { receipt: { tool?: string; operation?: string }; observedAt: string };
      assert.equal(snapshot.receipt.tool ?? snapshot.receipt.operation, definition.read.mcp.tool);
      assert.equal(graph.evaluate(owner, { function: definition.read.module.completion.evaluate, object: ref }).status, 'known');
      return { action: step.action, tool: definition.read.mcp.tool, transport: definition.read.mcp.transport ?? 'mcp', module: definition.read.module, observation: ref, observedAt: snapshot.observedAt };
    });
  });
  const completion = delegation.agent.completion; assert(completion);
  const completionRun = job.runs!.find(run => run.id === completion.modelRunId); assert(completionRun);
  assert.equal(completion.modelDecision.kind, 'complete');
  assert.equal(completionRun.decisionDigest, digest(completion.modelDecision));
  assert.equal(digest(JSON.parse(completion.modelDecision.completionJson)), digest(completion.proposal));
  assert(bindings.every(binding => binding.observedAt <= (completionRun.requestSentAt ?? completionRun.startedAt)), 'The completion model response must follow actual source results');
  if (completionRun.ontologyContext) assert(completionRun.ontologyContext.receiptIds.every(id => completion.ontologyPlanning.reads.some(read => read.id === id)));
  const initialSelections = delegation.agent.plans.filter(plan => plan.initialSelection).map(plan => ({ modelRunId: plan.modelRunId, actualGroundingAndInitialChoiceOneResponse: true, beforeModelReads: plan.initialSelection!.groundingPlanning.reads.length, postModelScopeBindingReads: plan.ontologyPlanning.reads.length, scopeActuallyReadBeforeDispatch: true }));
  const report = { taskId: id, backend: BACKEND_VERSION, accepted: true, callerArtifactMatches: true, allEffectsReadOnly: true, evaluationTime: 'acceptance_time_replay', acceptedAt: delegation.acceptance.at, bindings, contextEvidence, initialSelections, noOrderOrPayment: true };
  writeFileSync(join(directory, 'ontology-mcp-observer.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ taskId: id, accepted: true, callerArtifactMatches: true, readActions: bindings.length, evaluationTime: report.evaluationTime }));
} finally { db.close(); }
