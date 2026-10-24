// Opt-in native model acceptance against an isolated loopback Gateway. All data
// is synthetic and temporary; no provider, order, payment or booking is enabled.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { Worker } from '../apps/worker/worker.js';
import { Coordinator, CodexReasoner } from '../packages/coordinator/coordinator.js';
import { CodexExecutor } from '../packages/capabilities/executor.js';
import { digest } from '../packages/core/delegation.js';
import { executionBudgetStatus } from '../packages/core/execution-budget.js';
import type { Job } from '../packages/core/domain.js';
import type { OntologyReleaseRef } from '../packages/ontology/definition-contracts.js';
import { installOfficeManagementFixture, startOntologyManagementFixture } from '../tests/fixtures/ontology-management.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = join(repo, 'docs/evidence/dynamic-ontology-2026-10-21/real-model-runtime.json');
const maximumClaims = 10, maximumWallMs = 590000;
const target = { type: 'OfficeRoom', id: 'model-room' }, action = 'CreateOfficeRoom';
const actionInput = { id: target.id, label: '模型验收会议室' };
const runtimeFiles = [
  'examples/verify-dynamic-ontology.ts', 'apps/worker/worker.ts', 'packages/capabilities/executor.ts',
  'packages/coordinator/coordinator.ts', 'packages/coordinator/reasoning-loop.ts', 'packages/coordinator/agent-runtime.ts',
  'packages/coordinator/planning-session.ts', 'packages/coordinator/task-context.ts', 'packages/core/store.ts',
  'packages/core/tasks.ts', 'packages/core/agent-authorization.ts', 'packages/capabilities/dynamic-ontology.ts',
  'packages/ontology/definition-store.ts', 'packages/ontology/model-compiler.ts', 'packages/ontology/declarative-actions.ts',
  'packages/ontology/object-store.ts', 'tests/fixtures/ontology-management.ts',
];
const sourceHashes = () => Object.fromEntries(runtimeFiles.map(path => [path, createHash('sha256').update(readFileSync(join(repo, path))).digest('hex')]));
const safeError = (error: unknown) => error instanceof Error ? { name: error.name, message: error.message.slice(0, 600).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]') } : { name: 'Error', message: 'Unknown verification error' };

async function verify() {
  const startedAt = new Date().toISOString(), started = Date.now(), manifest = sourceHashes();
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const overall = new AbortController(), timer = setTimeout(() => overall.abort(new Error('Real model verification reached its overall deadline')), maximumWallMs);
  timer.unref();
  const fixture = await startOntologyManagementFixture();
  const coordinator = new Coordinator(fixture.gateway.store, new CodexReasoner(new CodexExecutor()), fixture.gateway.catalog, { maxTaskMs: maximumWallMs });
  let claims = 0, claimLimitReached = false, taskId: string | undefined, job: Job | undefined, release: OntologyReleaseRef | undefined;
  let approvedPlan: string | undefined, failure: ReturnType<typeof safeError> | undefined;
  let worker!: Worker;
  const workerFailures: { claim: number; error: ReturnType<typeof safeError> }[] = [];
  const initialization = { gatewayReadyAt: new Date().toISOString(), coordinatorReadyAt: new Date().toISOString(), workerStartedAt: '', definitionsPublishedAt: '' };
  worker = new Worker(fixture.gateway.store, { coordinator: { run: async (claim, signal) => {
    claims++;
    assert(claims <= maximumClaims, 'The verifier exceeded its claim bound');
    console.log(JSON.stringify({ event: 'worker_claim', number: claims, taskId: claim.job.id }));
    try { await coordinator.run(claim, AbortSignal.any([signal, overall.signal])); }
    catch (error) { workerFailures.push({ claim: claims, error: safeError(error) }); throw error; }
    finally {
      // close() marks stopping synchronously; do not await the currently running
      // Worker promise from inside itself. The outer cleanup drains it later.
      if (claims >= maximumClaims) { claimLimitReached = true; void worker.close(); }
    }
  } }, pollMs: 100, leaseMs: 15000, timeoutMs: maximumWallMs });
  const approvedGrants: string[] = [];
  let queried: unknown;
  try {
    assert.deepEqual(fixture.gateway.catalog.summaries(fixture.owner).map(capability => capability.ref.id), ['brief.prepare']);
    worker.start(); initialization.workerStartedAt = new Date().toISOString();
    await fixture.connect();
    const installed = await installOfficeManagementFixture(fixture);
    release = installed.release; initialization.definitionsPublishedAt = new Date().toISOString();
    console.log(JSON.stringify({ event: 'definitions_published_after_worker_start', ontologyId: installed.namespace.id, release }));
    const submitted = await fixture.mcp('submit_task', {
      service: 'eigos.delegate', ontologyId: installed.namespace.id, requestId: randomUUID(), executionBudget: 'standard',
      goal: '请在 office.operations 中创建下面这条内部会议室数据：对象类型 OfficeRoom，id 为 model-room，label 为「模型验收会议室」。只做这条数据变更，完成前请独立回读确认。此任务不代表真实预订。',
    });
    taskId = submitted.id;
    assert(taskId);
    let lastProgress = '', lastLogAt = 0;
    while (!overall.signal.aborted) {
      job = fixture.gateway.store.get(fixture.owner, taskId);
      const progress = JSON.stringify({ state: job.state, phase: job.delegation?.phase, claims, modelRuns: job.runs?.length ?? 0 });
      if (progress !== lastProgress || Date.now() - lastLogAt > 30000) { console.log(JSON.stringify({ event: 'progress', elapsedSeconds: Math.round((Date.now() - started) / 1000), ...JSON.parse(progress) })); lastProgress = progress; lastLogAt = Date.now(); }
      const intents = fixture.gateway.store.intents(fixture.owner, taskId);
      assert(intents.every(intent => intent.effect === 'object_write'), 'The model selected an effect outside this internal-data exercise');
      if (job.state === 'auth-required') {
        const d = job.delegation!, state = d.agent, plan = state?.plans.find(value => value.id === state.pendingPlanId), authorization = d.authorizationRequest;
        assert(plan && authorization && authorization.environment === 'managed');
        assert(!d.callerAction && !plan.callerDecision && plan.modelRunId && plan.modelDecision, 'This exercise requires an actual model-selected plan');
        assert.equal(plan.steps.length, 1); assert.equal(plan.steps[0]!.action, action); assert.equal(plan.steps[0]!.effect, 'object_write');
        assert.deepEqual(plan.steps[0]!.input, actionInput); assert.deepEqual(plan.steps[0]!.inputRefs, []); assert.deepEqual(plan.steps[0]!.dependsOn, []);
        assert.equal(plan.steps[0]!.cost, undefined); assert(!plan.steps[0]!.additionalEffects?.length);
        assert.equal(authorization.planDigest, plan.digest); assert.deepEqual(authorization.effects, ['object_write']);
        const scope = authorization.objectWrite;
        assert.deepEqual(scope.ontologyRelease, release); assert.equal(scope.actionId, action); assert.equal(scope.inputDigest, digest(actionInput));
        assert.deepEqual(scope.targets, [{ ref: target, revision: null, fields: ['id', 'label'], operation: 'create' }]); assert.deepEqual(scope.links, []);
        assert.equal(scope.actionDigest, digest(fixture.gateway.store.ontologyForJob(fixture.owner, job).model.action(action)));
        assert.equal(authorization.maxAmount, undefined); assert.equal(authorization.payeeIds, undefined);
        assert.equal(approvedPlan, undefined, 'A second authorization is outside this one-operation exercise');
        approvedPlan = plan.digest;
        await fixture.http('/ontology/v1/actions/approve', { taskId, requestId: randomUUID(), planDigest: plan.digest, objectWrite: scope, expiresAt: new Date(Math.min(started + maximumWallMs, Date.now() + 300000)).toISOString() });
        approvedGrants.push(...fixture.gateway.store.grants(fixture.owner, taskId).map(grant => grant.id));
        console.log(JSON.stringify({ event: 'exact_synthetic_data_scope_approved', planDigest: approvedPlan, target }));
      } else if (!['submitted', 'working'].includes(job.state)) break;
      if (claimLimitReached) break;
      await pause(500);
    }
    overall.signal.throwIfAborted();
    job = fixture.gateway.store.get(fixture.owner, taskId);
    assert.equal(job.state, 'completed', `Real model task stopped at ${job.state}`); assert(job.delegation?.acceptance?.accepted);
    assert(job.runs?.length && job.runs.every(run => run.runtime === 'codex-exec' && run.threadId && /^[a-f0-9]{64}$/.test(run.outputSha256)));
    assert(job.delegation.agent?.completion?.modelRunId && !job.delegation.agent.callerCompletion);
    assert.equal(job.delegation.agent.plans.length, 1); assert.equal(fixture.gateway.store.intents(fixture.owner, taskId).length, 1);
    const query = await fixture.post('/ontology/query', { taskId, object: target }); assert.equal(query.status, 200);
    queried = query.value;
    assert.deepEqual(query.value.items.map((item: { ref: unknown; properties: unknown; revision: number }) => ({ ref: item.ref, properties: item.properties, revision: item.revision })), [{ ref: target, properties: actionInput, revision: 1 }]);
    const graph = fixture.gateway.store.ontologyForJob(fixture.owner, job);
    for (const type of ['OfficeRoom', 'OfficeEquipment', 'OfficeRequest', 'Order', 'Payment']) assert.equal(graph.query(fixture.owner, { type }).items.length, type === 'OfficeRoom' ? 1 : 0);
    const expectedSchema = digest(graph.model.action(action).inputSchema);
    assert(job.delegation.ontologyReads?.some(receipt => receipt.status === 'ok' && receipt.tool === 'describe_ontology'), 'No actual action discovery receipt was recorded');
    assert(job.delegation.ontologyReads?.some(receipt => (receipt.definitions?.payload.actions as { id: string; inputSchema?: unknown }[] | undefined)?.some(definition => definition.id === action && definition.inputSchema && digest(definition.inputSchema) === expectedSchema)), 'No actual read of the exact action input schema was recorded');
    assert.deepEqual(sourceHashes(), manifest, 'Runtime sources changed during the model verification');
  } catch (error) { failure = safeError(error); }
  finally {
    clearTimeout(timer); overall.abort(); await worker.close();
    if (taskId) job = fixture.gateway.store.get(fixture.owner, taskId);
    const graph = job ? fixture.gateway.store.ontologyForJob(fixture.owner, job) : undefined;
    const intents = taskId ? fixture.gateway.store.intents(fixture.owner, taskId) : [];
    const grants = taskId ? fixture.gateway.store.grants(fixture.owner, taskId) : [];
    const receipts = job?.delegation?.ontologyReads ?? [];
    const summary = {
      version: 1, verificationDate: '2026-10-21', passed: !failure, startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
      scope: 'Actual native Codex reasoning against an isolated synthetic internal-data Gateway and Worker. No deployment, provider operation, order, payment or real booking.',
      bounds: { maximumWorkerClaims: maximumClaims, actualWorkerClaims: claims, maximumWallMs, claimLimitReached, executionBudget: job ? executionBudgetStatus(job) : undefined },
      initialization: { ...initialization, gatewayAndWorkerCreatedBeforePublication: true, restarted: false },
      code: { revision, runtimeSourceSha256: manifest },
      ontology: { release, model: graph?.model.ref },
      task: job ? { id: job.id, state: job.state, phase: job.delegation?.phase, backendVersion: job.delegation?.backendVersion, requestRevision: job.delegation?.request.revision, goalDigest: digest(job.goal), callerPlan: !!job.delegation?.callerAction, acceptance: job.delegation?.acceptance } : undefined,
      modelSelection: 'Native Codex default without a provider or model override; a null model field means the CLI did not report its exact model name.',
      modelRuns: job?.runs?.map(({ id, runtime, model, threadId, startedAt, completedAt, outputSha256, decisionDigest, purpose }) => ({ id, runtime, model: model ?? null, threadId, startedAt, completedAt, outputSha256, decisionDigest, purpose })),
      groundingChoices: job?.delegation?.groundingDecisions?.map(({ modelRunId, decision }) => {
        let parsed: Record<string, unknown> = {};
        try { const value: unknown = JSON.parse('inputJson' in decision ? decision.inputJson : '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>; } catch { /* Invalid JSON remains a failed input, never reconstructed. */ }
        return { modelRunId, kind: decision.kind, ...('capabilityRef' in decision ? { capabilityRef: decision.capabilityRef } : { criteriaDigest: digest(decision.criteriaJson) }),
          input: { actionIds: Array.isArray(parsed.actionIds) ? parsed.actionIds.filter((value): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value)) : undefined,
            objects: Array.isArray(parsed.objects) ? parsed.objects.flatMap(value => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
              const ref = value as Record<string, unknown>;
              return typeof ref.type === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(ref.type) && typeof ref.id === 'string' && ref.id.length <= 200 ? [{ type: ref.type, id: ref.id }] : [];
            }) : undefined } };
      }),
      groundingFeedback: job?.delegation?.groundingFeedback?.map(({ requestRevision, stage, message, decisionDigest, at }) => ({ requestRevision, stage, messageDigest: digest(message), decisionDigest, at })),
      readReceipts: receipts.map(({ id, at, tool, inputDigest, outputDigest, datasetRevision, status, objects, deliveredObjects, definitions }) => ({ id, at, tool, inputDigest, outputDigest, datasetRevision, status, objects, deliveredObjects,
        ...(definitions ? { definitions: { modelDigest: definitions.modelDigest, bindingDigest: definitions.bindingDigest, payloadDigest: definitions.payloadDigest, originalReceiptId: definitions.originalReceiptId,
          actionSchemas: (definitions.payload.actions as { id: string; inputSchema?: unknown }[] | undefined)?.filter(action => action.inputSchema).map(action => ({ id: action.id, inputSchemaDigest: digest(action.inputSchema) })) } } : {}) })),
      plans: job?.delegation?.agent?.plans.map(plan => ({ id: plan.id, digest: plan.digest, modelRunId: plan.modelRunId, modelDecisionDigest: digest(plan.modelDecision ?? null), planningDigest: plan.ontologyPlanning.digest, receiptIds: plan.ontologyPlanning.reads.map(receipt => receipt.id), steps: plan.steps.map(step => ({ id: step.id, action: step.action, input: step.input, effect: step.effect, definitionDigest: step.definitionDigest, objectWrite: step.objectWrite, intentId: step.intentId })) })),
      actions: intents.map(intent => ({ id: intent.id, stepId: intent.stepId, state: intent.state, effect: intent.effect, planDigest: intent.planDigest, inputDigest: intent.inputDigest, latestObservationId: intent.latestObservationId, acceptedOutput: intent.acceptedOutput,
        attempts: fixture.gateway.store.attempts(fixture.owner, intent.id).map(({ id, kind, startedAt, ordinal, inputDigest, planDigest, authorizationId }) => ({ id, kind, startedAt, ordinal, inputDigest, planDigest, authorizationId })),
        observationCount: fixture.gateway.store.observations(fixture.owner, intent.id).length, verifiedResultDigest: intent.lastVerifiedResult ? digest(intent.lastVerifiedResult) : undefined })),
      grants: grants.map(grant => ({ id: grant.id, kind: grant.kind, planDigest: grant.planDigest, allowedEffects: grant.allowedEffects, environment: grant.environment, revoked: grant.revoked, expiresAt: grant.expiresAt, objectWrite: grant.kind === 'object_write' ? grant.objectWrite : undefined, financialFieldsPresent: grant.maxAmount !== undefined || grant.payeeIds !== undefined })),
      autoApprovedGrantIds: approvedGrants, queryReadback: queried,
      completion: job?.delegation?.agent?.completion ? { modelRunId: job.delegation.agent.completion.modelRunId, modelDecisionDigest: digest(job.delegation.agent.completion.modelDecision), planningDigest: job.delegation.agent.completion.ontologyPlanning.digest, artifactDigest: digest(job.artifact ?? null) } : undefined,
      counts: { modelRuns: job?.runs?.length ?? 0, readReceipts: receipts.length, plans: job?.delegation?.agent?.plans.length ?? 0, actions: intents.length, grants: grants.length },
      workerFailures, failure,
    };
    mkdirSync(dirname(evidencePath), { recursive: true }); writeFileSync(evidencePath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    await fixture.close();
    console.log(JSON.stringify({ event: 'verification_finished', passed: !failure, state: job?.state, claims, modelRuns: job?.runs?.length ?? 0, evidence: evidencePath, ...(failure ? { failure } : {}) }));
  }
  if (failure) process.exitCode = 1;
}

if (process.argv.includes('--run')) await verify();
else console.log('Opt-in native model acceptance: node --import tsx examples/verify-dynamic-ontology.ts --run');
