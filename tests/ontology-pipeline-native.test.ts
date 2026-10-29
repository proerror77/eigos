// Synthetic model/provider only. Uses the production native MCP Reasoner and
// Worker factory; live-shaped DiDi receipts prove contracts, never a real ride.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as waitForPoll } from 'node:timers/promises';
import { z } from 'zod';
import { createWorker } from '../apps/worker/runtime.js';
import { CodexReasoner } from '../packages/coordinator/coordinator.js';
import { readWorkerConfig } from '../packages/core/config.js';
import { digest } from '../packages/core/delegation.js';
import { DefinitionService } from '../packages/ontology/definition-service.js';
import { parsePipelineIntake, verificationCoversAction } from '../packages/ontology/pipeline/contracts.js';
import type { Job } from '../packages/core/domain.js';
import type { ActionIntent } from '../packages/ontology/actions.js';
import type { AcceptedPortValue } from '../packages/ontology/composition-contract.js';
import { DidiAgentProgram } from '../packages/capabilities/didi/program.js';
import { DidiMcpConnector } from '../packages/capabilities/didi/connector.js';
import { didiEndpoint } from '../packages/capabilities/didi/contracts.js';
import { securityFixture } from './fixtures/security.js';
import { securedProgramFixture } from './fixtures/secured-program.js';
import { scriptedMcpModel } from './fixtures/native-ontology-model.js';
import { didiFixture, input } from './fixtures/didi.js';
import { evidence, syntheticGoalReview } from './backend-fixture.js';

const goal = '查询北京市北京西站到西二旗地铁站的车型估价，不下单不付款';
const until = () => new Date(Date.now() + 300000).toISOString();

test('Foundation native Pipeline preparation and ordinary task reuse retain original component evidence', { timeout: 300000 }, async t => {
  // This functional fixture controls Date only: synchronous CI work must not
  // consume the Gateway eligibility lease. Worker timers/heartbeat/ACL remain
  // real; this is not evidence of production heartbeat timing or latency.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(300000)]);
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const source = didiFixture(), originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    if (String(url).startsWith(didiEndpoint('production'))) return source.fetcher(url, options);
    assert(['127.0.0.1', 'localhost'].includes(new URL(String(url)).hostname), 'No external network in this fixture');
    return originalFetch(url, options);
  });
  const f = securedProgramFixture(() => new DidiAgentProgram(source.binding, { connector: new DidiMcpConnector(source.binding, source.fetcher, false) }),
    input, () => { throw Error('The legacy fixture Reasoner must not run'); }, securityFixture(now, { unified: true }), { nativeTaskContext: true });
  const definitions = new DefinitionService(f.jobs, f.tasks, f.catalog);
  let groundCalls = 0;
  const model = Object.assign(scriptedMcpModel({ runStructured: async prompt => {
    const packet = JSON.parse(prompt.split('\n\n').at(-1)!);
    const conversation = packet.conversation as { call: { tool: string; argumentsJson: string }; result: any; receipt: { id: string } }[];
    const context = conversation.find(row => row.call.tool === 'read_task_context')?.result.data;
    const read = (calls: { tool: string; argumentsJson: string }[]) => ({ output: { kind: 'read', calls, receiptIds: [], finalJson: '' }, evidence: evidence() });
    const final = (decision: unknown) => ({ output: { kind: 'final', calls: [], receiptIds: conversation.map(row => row.receipt.id), finalJson: JSON.stringify(decision) }, evidence: evidence() });
    if (!context) return read([{ tool: 'read_task_context', argumentsJson: '{}' }]);
    if (packet.finalSchema.properties.criteriaJson) {
      groundCalls++;
      return final({ kind: 'compose', requestRevision: context.request.revision, message: 'Synthetic model preserves the estimate-only goal', requirementsJson: '[]', conditionsJson: '[]',
        criteriaJson: JSON.stringify([{ id: 'estimate', predicate: 'ride.estimate_observed', phase: 'quote', description: 'Actual source estimate only', messageId: context.request.messages[0].id, quote: context.request.originalGoal, requirementIds: [] }]) });
    }
    const discovery = conversation.filter(row => row.call.tool === 'discover_actions');
    if (!discovery.length) return read(['SearchDidiPlaces', 'EstimateDidiRide'].map(actionId => ({ tool: 'discover_actions', argumentsJson: JSON.stringify({ actionId }) })));
    const pin = (action: string) => discovery.flatMap(row => row.result.items).find(row => row.action.id === action).bindings[0].pin;
    const component = context.execution?.composition?.components[0];
    const base = { requestRevision: context.request.revision, message: 'Synthetic model selects exact original source evidence', steps: [], completionJson: '' };
    if (!component) return final({ ...base, kind: 'prepare', contexts: [{ id: 'ride', bindingDigest: pin('SearchDidiPlaces').digest, inputJson: JSON.stringify(input) }] });
    const observations = context.graph.objects.filter((object: any) => ['DidiPlaceObservation', 'RideEstimateObservation'].includes(object.ref.type));
    if (observations.length && !conversation.some(row => row.call.tool === 'evaluate_ontology')) return read(observations.map((object: any) => ({ tool: 'evaluate_ontology', argumentsJson: JSON.stringify({ function: 'rideEstimateStatus', object: object.ref }) })));
    const quote = observations.find((object: any) => object.ref.type === 'RideEstimateObservation');
    if (quote) return final({ ...base, kind: 'complete', completionJson: JSON.stringify({ components: [{ contextId: 'ride', proposalJson: JSON.stringify({ observation: quote.ref, rationale: 'Original source estimate' }) }], criteria: [{ id: 'estimate', contextIds: ['ride'] }], conditions: [] }) });
    const step = (id: string, action: string, args: object) => ({ id, action, contextId: 'ride', bindingDigest: pin(action).digest, argumentsJson: JSON.stringify(args), dependsOn: [], inputRefs: [], contributesTo: ['estimate'] });
    if (!observations.length) return final({ ...base, kind: 'execute', steps: ['origin', 'destination'].map(role => step(role, 'SearchDidiPlaces', { scope: component.scope, role, keywords: input[role as 'origin' | 'destination'] })) });
    const from = observations.find((object: any) => object.properties.observedData.data.places.some((place: any) => place.name === input.origin));
    const to = observations.find((object: any) => object.properties.observedData.data.places.some((place: any) => place.name === input.destination));
    return final({ ...base, kind: 'execute', steps: [step('estimate', 'EstimateDidiRide', { scope: component.scope,
      originObservation: from.ref, originPlaceId: from.properties.observedData.data.places.find((place: any) => place.name === input.origin).id,
      destinationObservation: to.ref, destinationPlaceId: to.properties.observedData.data.places.find((place: any) => place.name === input.destination).id })] });
  } }), { securityChannelId: 's5-synthetic' });
  const reasoner = Object.assign(new CodexReasoner(model), { reviewGoal: syntheticGoalReview });
  const config = { ...readWorkerConfig({ DATABASE_PATH: f.database, EIGOS_SECURITY_MODE: 'foundation', EIGOS_AUTH_MODE: 'jwt', HOST: '127.0.0.1', PUBLIC_URL: 'https://primary.example',
    EIGOS_PERSONAL_SOURCE_OWNER: f.owner, EIGOS_DIDI_KEY_FILE: source.keyFile, EIGOS_DIDI_KEY_SHA256: source.binding.keySha256, EIGOS_DIDI_BINDING_ID: source.binding.bindingId,
    EIGOS_DIDI_ENVIRONMENT: 'production', EIGOS_DIDI_AUDIT_DIR: source.binding.auditDirectory }), authority: f.authority };
  let runtime: ReturnType<typeof createWorker> | undefined;
  try {
    const intake = parsePipelineIntake({ format: 'eigos.ontology.pipeline.v1', serviceId: 'didi.native-fixture',
      source: { id: 'didi.native-fixture', revision: '1', digest: digest('synthetic-source-contract'), observedAt: new Date(Date.now() - 60000).toISOString(), reference: 'urn:eigos:synthetic:native-pipeline' },
      programRef: f.program.ref, configurationDigest: f.program.configurationDigest, environment: 'live', vocabulary: [], mappings: [], fixtures: [],
      actions: f.program.actionIds.map(actionId => ({ actionId, definitionDigest: digest(f.jobs.ontology.model.action(actionId)), requiredEvidence: 'live_readonly' })),
      conditions: { regions: ['CN'], payment: 'not_required', operatorRequired: false } });
    const namespace = f.jobs.definitions.namespace('eigos.business');
    let draft = f.jobs.definitions.createDraft(f.owner, namespace.id, 'Native fixture intake', true);
    draft = f.jobs.definitions.putPipeline(f.owner, draft.id, draft.revision, intake, true);
    f.jobs.definitions.validatePipeline(f.owner, draft.id, draft.revision, intake.serviceId, new Date(now() + 3600000).toISOString(), true);
    const release = f.jobs.definitions.publish(f.owner, draft.id, draft.revision, true).release;
    f.jobs.definitions.activate(f.owner, release, namespace.generation, true);
    const prepared = z.object({ task: z.object({ id: z.uuid() }), validationOnly: z.literal(true) }).parse(definitions.command(f.p,
      { operation: 'prepare_pipeline_validation', ontologyId: namespace.id, release, serviceId: intake.serviceId, goal, requestId: randomUUID(), expiresAt: until() }).result);
    runtime = createWorker(config, { store: f.jobs, reasoner, timing: { pollMs: 25, leaseMs: 30000 } });
    const finish = async (id: string) => {
      while (true) {
        signal.throwIfAborted();
        const job = f.jobs.get(f.owner, id);
        if (!['submitted', 'working'].includes(job.state)) return job;
        await waitForPoll(20, undefined, { signal });
        t.mock.timers.tick(20);
      }
    };
    const done = await finish(prepared.task.id);
    assert.equal(done.state, 'completed', JSON.stringify({ error: done.error, feedback: done.delegation?.agent?.feedback, recovery: done.delegation?.recovery }));
    assert.equal(done.delegation!.agent!.programRef.id, 'eigos.goal');
    assert(done.delegation!.agent!.composition!.assessment!.accepted);
    assert.equal(done.delegation!.acceptance!.accepted, true);
    assert(done.runs!.filter(run => run.purpose !== 'goal_coverage').every(run => run.ontologyMcp?.decisionSubmitted));
    assert.deepEqual(source.calls.filter(call => call.name).map(call => call.name), ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    const review = f.jobs.definitions.createDraft(f.owner, namespace.id, 'Register original native evidence', true);
    const verify = (taskId: string) => definitions.command(f.p, { operation: 'verify_pipeline_task', ontologyId: namespace.id, draftId: review.id,
      expectedRevision: review.revision, serviceId: intake.serviceId, taskId, expiresAt: until() }).result;
    const proof = z.object({ actionIds: z.array(z.string()), level: z.string(), verifiedAt: z.string() }).parse(verify(done.id));
    assert.deepEqual(proof.actionIds.sort(), [...f.program.actionIds].sort());
    assert.equal(proof.level, 'live_readonly');
    assert.equal(proof.verifiedAt, done.delegation!.outcome!.assessedAt);
    const ordinary = f.tasks.submit(f.p, { service: 'eigos.delegate', requestId: randomUUID(), goal, capabilityRef: f.program.ref, executionEnvironment: 'live' });
    const ordinaryDone = await finish(ordinary.id);
    assert.equal(ordinaryDone.state, 'completed');
    assert.equal(ordinaryDone.delegation!.pipelineValidation, undefined);
    assert.equal(z.object({ verifiedAt: z.string() }).parse(verify(ordinaryDone.id)).verifiedAt, ordinaryDone.delegation!.outcome!.assessedAt);
    assert.equal(groundCalls, 2);
    await runtime.close(); runtime = undefined;
    const selected = f.jobs.definitions.pipelineDraft(f.owner, review.id, review.revision, intake.serviceId, true);
    const readIntent = (id: string) => f.jobs.intent(f.owner, id);
    const direct = (job: Job, read = readIntent, owner = f.owner) => f.jobs.definitions.pipeline.verifyTask(namespace.id, owner, selected.ref, selected.model, job, read, new Date(now() + 60000).toISOString());
    const alteredJob = (change: (job: Job) => void) => { const copy = structuredClone(done); change(copy); return copy; };
    const invalidJobs: Record<string, (job: Job) => void> = {
      'unaccepted whole goal': job => { job.delegation!.acceptance!.accepted = false; },
      'assessment changed without its sealed artifact': job => { job.delegation!.agent!.composition!.assessment!.criteria[0]!.reason = 'Unsealed replacement'; },
      'unverified component': job => { job.delegation!.agent!.composition!.assessment!.components[0]!.status = 'unverified'; },
      'wrong target program': job => { job.delegation!.agent!.composition!.contexts[0]!.programRef.id = 'other.program'; },
      'wrong target configuration': job => { job.delegation!.agent!.composition!.contexts[0]!.programDigest = '0'.repeat(64); },
      'wrong request revision': job => { job.delegation!.request.revision++; },
      'ambiguous context before success filtering': job => { const context = structuredClone(job.delegation!.agent!.composition!.contexts[0]!); context.id = 'unverified-second'; job.delegation!.agent!.composition!.contexts.push(context); },
      'retired context': job => { const composition = job.delegation!.agent!.composition!; composition.retiredContexts = [{ id: composition.contexts[0]!.id, at: new Date().toISOString(), reason: 'source_authorization_renewed' }]; },
      'wrong context digest': job => { job.delegation!.agent!.composition!.contexts[0]!.digest = '0'.repeat(64); },
      'changed executable plan body': job => { job.delegation!.agent!.plans[0]!.reasoning = 'Tampered after acceptance'; },
      'duplicate plan id with a different body': job => { const plan = structuredClone(job.delegation!.agent!.plans[0]!); plan.reasoning = 'Another body under the same plan id'; job.delegation!.agent!.plans.push(plan); },
      'same action from another context': job => { for (const plan of job.delegation!.agent!.plans) for (const step of plan.steps) step.contextId = 'another-context'; },
      'wrong validation release': job => { job.delegation!.pipelineValidation!.release.digest = '0'.repeat(64); },
      'wrong validation intake': job => { job.delegation!.pipelineValidation!.intakeDigest = '0'.repeat(64); },
      'wrong validation mapping': job => { job.delegation!.pipelineValidation!.mappingDigest = '0'.repeat(64); },
      'wrong validation owner': job => { job.delegation!.pipelineValidation!.ownerDigest = '0'.repeat(64); },
      'expired validation at acceptance': job => { job.delegation!.pipelineValidation!.expiresAt = new Date(Date.parse(job.delegation!.outcome!.assessedAt) - 1).toISOString(); },
    };
    for (const [name, change] of Object.entries(invalidJobs)) await t.test(`rejects ${name}`, () => assert.throws(() => direct(alteredJob(change)), { code: 'CONFLICT' }));
    const alteredIntents = (change: (intent: ActionIntent) => void) => (id: string) => { const value = structuredClone(readIntent(id)); change(value); return value; };
    const invalidIntents: Record<string, (intent: ActionIntent) => void> = {
      'missing original receipt': value => { delete value.acceptedOutput; },
      'broken receipt seal': value => { for (const port of value.acceptedOutput!.ports as AcceptedPortValue[]) port.digest = '0'.repeat(64); },
      'wrong owner': value => { value.owner = 'foreign-owner'; },
      'wrong task': value => { value.jobId = randomUUID(); },
      'wrong original plan': value => { value.planDigest = '0'.repeat(64); },
      'wrong accepted observation': value => { value.latestObservationId = randomUUID(); },
      'failed action': value => { value.state = 'rejected'; },
      'unconfirmed result': value => { value.lastVerifiedResult!.kind = 'pending'; },
      'unrelated source references': value => { value.lastVerifiedResult!.evidenceRefs = ['unrelated:receipt']; },
    };
    for (const [name, change] of Object.entries(invalidIntents)) await t.test(`rejects ${name}`, () => assert.throws(() => direct(done, alteredIntents(change)), /original accepted|verified matching/));
    const invalidPorts: Record<string, (port: AcceptedPortValue) => void> = {
      owner: port => { port.owner = 'foreign-owner'; },
      request: port => { port.requestRevision++; },
      release: port => { port.ontologyRelease.digest = '0'.repeat(64); },
      action: port => { port.actionId = 'OtherRead'; },
      binding: port => { port.binding.configurationDigest = '0'.repeat(64); },
      intent: port => { port.intentId = randomUUID(); },
      observation: port => { port.observationId = randomUUID(); },
      evidence: port => { port.evidence.refs = ['forged:receipt']; },
      'expired at acceptance': port => { port.evidence.expiresAt = new Date(Date.parse(done.delegation!.outcome!.assessedAt) - 1).toISOString(); },
    };
    for (const [name, change] of Object.entries(invalidPorts)) await t.test(`rejects resealed receipt with wrong ${name}`, () => {
      const changed = alteredIntents(value => { for (const port of value.acceptedOutput!.ports as AcceptedPortValue[]) { change(port); const { digest: _old, ...body } = port; port.digest = digest(body); } });
      assert.throws(() => direct(done, changed), /original accepted/);
    });
    for (const alteration of ['seal', 'model_run', 'decision'] as const) await t.test(`rejects paired plan/intent forgery: ${alteration}`, () => {
      const copy = structuredClone(done), plan = copy.delegation!.agent!.plans[0]!, originalDigest = plan.digest;
      if (alteration === 'seal') plan.digest = 'f'.repeat(64);
      else {
        if (alteration === 'model_run') plan.modelRunId = randomUUID();
        else plan.modelDecision!.message = 'Forged model decision';
        const { digest: _old, ...body } = plan; plan.digest = digest(body);
      }
      assert.throws(() => direct(copy, alteredIntents(value => { if (value.planDigest === originalDigest) value.planDigest = plan.digest; })), { code: 'CONFLICT' });
    });
    await t.test('a legitimate quote is part of the native executable plan seal', () => {
      // Historical metadata compatibility only: no order, payment or new Worker run.
      const copy = structuredClone(done), plan = copy.delegation!.agent!.plans[0]!, oldDigest = plan.digest, step = plan.steps[0]!;
      const quote = { id: randomUUID(), amount: { minor: '0', currency: 'CNY' }, expiresAt: until(), environment: 'local_simulation' as const,
        requestDigest: digest(copy.delegation!.request), bindingRef: step.binding!.ref, bindingDigest: step.binding!.digest,
        inputDigest: readIntent(step.intentId).inputDigest, detailsDigest: digest({ synthetic: true }) };
      plan.quote = { ...quote, digest: digest(quote) };
      const { digest: _old, ...body } = plan; plan.digest = digest(body);
      const matching = alteredIntents(value => { if (value.planDigest === oldDigest) value.planDigest = plan.digest; });
      assert.deepEqual(direct(copy, matching).actionIds, direct(done).actionIds);
      plan.quote.amount.minor = '1';
      assert.throws(() => direct(copy, matching), { code: 'CONFLICT' }, 'Changing the sealed quote cannot keep its old plan digest');
    });
    await t.test('retired history does not make the sole current target ambiguous', () => {
      const copy = alteredJob(job => {
        const composition = job.delegation!.agent!.composition!, historical = structuredClone(composition.contexts[0]!);
        historical.id = 'retired-history'; composition.contexts.push(historical);
        composition.retiredContexts = [{ id: historical.id, at: new Date().toISOString(), reason: 'source_authorization_renewed' }];
      });
      assert.deepEqual(direct(copy).evidenceRefs, direct(done).evidenceRefs);
    });
    await t.test('a shared accepted criterion does not import another program delivery into the target proof', () => {
      // Unit variation of a persisted independent assessment; the target's real
      // native plans and receipts remain unchanged, and foreign evidence cannot enter its proof.
      const copy = alteredJob(job => {
        const composition = job.delegation!.agent!.composition!, assessment = composition.assessment!, other = structuredClone(composition.contexts[0]!);
        other.id = 'other-program'; other.programRef = { id: 'other.program', version: '1' }; composition.contexts.push(other);
        assessment.criteria[0]!.contextIds.push(other.id);
        assessment.criteria[0]!.evidenceRefs.push('other:receipt');
        assessment.components.push({ contextId: other.id, status: 'verified', delivery: { ...structuredClone(assessment.components[0]!.delivery!), evidenceRefs: ['other:receipt'] } });
        job.delegation!.outcome!.evidenceRefs.push('other:receipt'); job.delegation!.acceptance!.evidenceRefs.push('other:receipt');
        job.artifact!.id = digest({ goal: composition.goal.digest, assessment });
      });
      assert(!direct(copy).evidenceRefs.includes('other:receipt'));
      assert.deepEqual(direct(copy).actionIds, direct(done).actionIds);
    });
    await t.test('missing action evidence remains uncovered without discarding a valid action subset', () => {
      const searches = new Set(done.delegation!.agent!.plans.flatMap(plan => plan.steps).filter(step => step.action === 'SearchDidiPlaces').map(step => step.intentId));
      const partial = direct(done, alteredIntents(value => { if (searches.has(value.id)) delete value.acceptedOutput; }));
      assert.deepEqual(partial.actionIds, ['EstimateDidiRide']);
      assert.equal(verificationCoversAction(intake.actions.find(action => action.actionId === 'SearchDidiPlaces')!, intake.actions, partial), false);
    });
    await t.test('public verification keeps owner and installation isolation', () => {
      const command = { operation: 'verify_pipeline_task', ontologyId: namespace.id, draftId: review.id, expectedRevision: review.revision, serviceId: intake.serviceId, taskId: ordinaryDone.id, expiresAt: until() };
      assert.throws(() => definitions.command({ ...f.p, subject: 'another-owner' }, command), /AUTHORIZATION_REQUIRED|FORBIDDEN|not found/);
      const other = f.installation('Other installation'); f.approve(other.id);
      assert.throws(() => definitions.command({ ...f.principal, access: f.coordinator.authenticate(f.principal, other.token) }, command), /AUTHORIZATION_REQUIRED|FORBIDDEN|not available/);
    });
    await t.test('expired quotes can prove historical execution without refreshing observation or acceptance time', () => {
      const before = now();
      f.coordinator.close(); clockOffset = 6 * 60000; f.coordinator.start();
      assert.equal(now() - before, 6 * 60000, 'The historical-expiry case explicitly advances its logical clock');
      const result = z.object({ verifiedAt: z.string(), actionEvidence: z.record(z.string(), z.object({ observedAt: z.string() })) }).parse(definitions.command(f.p,
        { operation: 'verify_pipeline_task', ontologyId: namespace.id, draftId: review.id, expectedRevision: review.revision, serviceId: intake.serviceId, taskId: ordinaryDone.id, expiresAt: new Date(now() + 60000).toISOString() }).result);
      assert.equal(result.verifiedAt, ordinaryDone.delegation!.outcome!.assessedAt);
      for (const [actionId, record] of Object.entries(result.actionEvidence)) {
        const step = ordinaryDone.delegation!.agent!.plans.flatMap(plan => plan.steps).filter(step => step.action === actionId).at(-1)!;
        const original = readIntent(step.intentId).lastVerifiedResult!.output!.source as { observedAt: string };
        assert.equal(record.observedAt, original.observedAt);
        assert(Date.parse(record.observedAt) + 300000 < now());
      }
      assert.equal(source.calls.filter(call => call.name).length, 6, 'Historical verification performs no source refresh');
    });
    await t.test('public verification rejects revoked source access', () => {
      const sourceGrant = f.policy.sources(f.owner, f.a.id)[0]!;
      f.policy.revokeSource(f.owner, f.a.id, sourceGrant.bindingId, f.policy.revision());
      assert.throws(() => definitions.command(f.p, { operation: 'verify_pipeline_task', ontologyId: namespace.id, draftId: review.id, expectedRevision: review.revision,
        serviceId: intake.serviceId, taskId: ordinaryDone.id, expiresAt: new Date(now() + 60000).toISOString() }).result, /AUTHORIZATION_REQUIRED|SOURCE_NOT_AUTHORIZED|OUTPUT_NOT_ALLOWED|currently authorized|not available/);
    });
  } finally { await runtime?.close(); f.close(); source.close(); }
});
