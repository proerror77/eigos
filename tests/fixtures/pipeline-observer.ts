// Synthetic source and model only. No participant account or calendar is used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ParticipantBookingProgram } from '../../packages/capabilities/free-booking/program.js';
import type { AgentActionContext, AgentActionResult, AgentProgramContext } from '../../packages/core/agent-program.js';
import { ExecutionCatalog } from '../../packages/core/catalog.js';
import { JobStore } from '../../packages/core/store.js';
import { TaskService } from '../../packages/core/tasks.js';
import type { Principal } from '../../packages/core/domain.js';
import { Coordinator, type AgentPlanningContext, type PlanningAccess, type Reasoner } from '../../packages/coordinator/coordinator.js';
import type { TaskContextRead } from '../../packages/coordinator/task-context.js';
import { digest } from '../../packages/core/delegation.js';
import { bindPersonalSourceOwner } from '../../packages/core/source-owner.js';
import { registrationResultSchema } from '../../packages/ontology/free-booking.js';
import { parsePipelineIntake, type PipelineIntake } from '../../packages/ontology/pipeline/contracts.js';
import type { AgentDecision } from '../../packages/ontology/agent-actions.js';
import type { ObjectRef } from '../../packages/ontology/model.js';
import { observationControlSchema } from '../../packages/ontology/pipeline/observation.js';
import { withAuthorization } from '../../packages/security/context.js';
import { participantFixture } from './free-booking.js';
import { securityFixture } from './security.js';
import { securedProgramFixture } from './secured-program.js';
import { evidence, interpretation, syntheticGoalReview, owner, principal, acknowledgeReads, observeTaskContext } from '../backend-fixture.js';

const venueSchema = z.strictObject({ nativeId: z.string(), title: z.string(), address: z.strictObject({ text: z.string(), city: z.string() }), secret: z.string() });
const bundleSchema = z.strictObject({ primary: registrationResultSchema, venue: venueSchema, at: z.iso.datetime({ offset: true }), evidenceLevel: z.literal('synthetic'), receipt: z.record(z.string(), z.unknown()) });
export class ObserverFixtureProgram extends ParticipantBookingProgram {
  override readonly projectionTypes = ['RegistrationTask', 'RegistrationOffer', 'RegistrationRecord', 'SourceReceipt', 'SavedAddress'];
  intake?: PipelineIntake;
  calls = 0; failReads = false; pendingReads = false;
  beforeReturn?: () => Promise<void>;
  readonly venue = { nativeId: 'saved-venue-1', title: '合成会场地址', address: { text: '北京市合成会场 1 号', city: '北京市' }, secret: 'PRIVATE_OBSERVATION_SOURCE_ONLY' };
  constructor(source: ConstructorParameters<typeof ParticipantBookingProgram>[0], readonly now: () => number, readonly variant: 'a' | 'b') { super(source); }
  override async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.calls++;
    if (this.failReads) throw new Error('PRIVATE_SOURCE_ERROR_NOT_FOR_MODEL');
    if (this.pendingReads) return { value: { pending: true }, evidenceRefs: [], pending: { retryAfterMs: 1000 } };
    const result = await super.invoke(ctx, action, input, signal), primary = registrationResultSchema.parse(result.value);
    const value = { primary, venue: structuredClone(this.venue), at: new Date(this.now()).toISOString(), evidenceLevel: 'synthetic' as const, receipt: primary.receipt };
    await this.beforeReturn?.();
    return { ...result, value };
  }
  override project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    return super.project(ctx, action, input, { ...result, value: bundleSchema.parse(result.value).primary });
  }
  pipelineTarget(_ctx: AgentProgramContext, action: string) {
    if (!this.intake || action !== 'ReadParticipantRegistration') return;
    return { serviceId: this.intake.serviceId, mappingId: 'saved-venue', sourceAccount: `synthetic-account-${this.variant}`, nativeId: this.venue.nativeId };
  }
  pipelineSample(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, result: AgentActionResult) {
    const b = bundleSchema.parse(result.value), r = b.primary.receipt;
    assert.equal(r.ownerDigest, digest(ctx.owner)); assert.equal(r.requestId, ctx.request.id); assert.equal(r.action, action);
    assert.equal(r.planId, ctx.planId); assert.equal(r.intentId, ctx.intentId); assert.equal(r.attemptId, ctx.attemptId);
    assert.equal(r.payloadDigest, digest(b.primary.payload)); assert.equal(r.sourceIdentity, this.source.identity);
    assert.equal(b.primary.payload.data.attendeeRef, this.source.attendeeRef); assert.equal(b.primary.payload.data.independentRead, true);
    return { eventId: ctx.attemptId, sourceAccount: `synthetic-account-${this.variant}`, sourceRevision: this.intake!.source.revision, sourceDigest: this.intake!.source.digest,
      observedAt: b.at, receivedAt: new Date(this.now()).toISOString(), independentRead: true, evidenceRefs: result.evidenceRefs, evidenceLevel: 'synthetic' as const,
      payload: this.variant === 'a' ? { key: b.venue.nativeId, title: b.venue.title, postal: b.venue.address, memo: b.venue.secret }
        : { address_key: b.venue.nativeId, caption: b.venue.title, location: b.venue.address, note: b.venue.secret } };
  }
}

export function observerFixture(secured = false, variant: 'a' | 'b' = 'a') {
  let offset = 0, modelCalls = 0;
  const handledFeedback = new Set<string>();
  const now = () => Date.now() + offset, source = participantFixture();
  const base = secured ? securityFixture(now, { unified: true }) : undefined;
  const program = new ObserverFixtureProgram(source.source, now, variant);
  const choice = (ctx: AgentPlanningContext, access: PlanningAccess): AgentDecision => {
    modelCalls++; observeTaskContext(access);
    const context = access.session.call('read_task_context', {}) as TaskContextRead;
    const observation = context.data.observation, last = ctx.state.observations.filter(ref => ref.type === 'RegistrationRecord').at(-1);
    const common = { requestRevision: ctx.request.revision, message: 'Synthetic observation decision', steps: [], completionJson: '' };
    const superseded = (context.data.execution?.feedback ?? ctx.state.feedback).find(item => item.message.includes('superseded') && !handledFeedback.has(item.at));
    if (!last || superseded) {
      if (superseded) handledFeedback.add(superseded.at);
      return { ...common, kind: 'execute', steps: [{ id: `read${ctx.state.plans.length}`, action: 'ReadParticipantRegistration', argumentsJson: JSON.stringify({ scope: ctx.state.scope }), dependsOn: [], inputRefs: [] }] };
    }
    access.session.call('query_ontology', { object: last });
    access.session.call('evaluate_ontology', { function: 'registrationStatus', object: last });
    if (observation && !observation.stopped && Date.parse(observation.until) > now()) {
      const candidate = observation.eligibleReads?.find(read => read.action === 'ReadParticipantRegistration');
      assert(candidate?.facts.length, JSON.stringify(observation));
      const fact = candidate.facts[0]!;
      access.session.call('query_ontology', { object: candidate.step });
      access.session.call('query_ontology', { object: fact.object });
      return { ...common, kind: 'observe', observation: { step: candidate.step as { type: 'ExecutionStep'; id: string }, object: fact.object, fields: ['label', 'address'], intervalMs: 1000 } };
    }
    return { ...common, kind: 'complete', completionJson: JSON.stringify({ registration: last, rationale: 'Independent synthetic registration read' }) };
  };
  let foundation: ReturnType<typeof securedProgramFixture> | undefined;
  let store: JobStore, tasks: TaskService, catalog: ExecutionCatalog, coordinator: Coordinator, currentOwner: string, actor: Principal;
  if (base) {
    foundation = securedProgramFixture(() => program, source.input, choice, base, { nativeTaskContext: true });
    store = foundation.jobs; tasks = foundation.tasks; catalog = foundation.catalog; coordinator = new Coordinator(store, foundation.reasoner, catalog, { allowSandbox: true }); currentOwner = foundation.owner; actor = foundation.p;
  } else {
    store = new JobStore(':memory:', { securityNow: now }); bindPersonalSourceOwner(program, owner);
    catalog = new ExecutionCatalog([program.capability()], [], [], [], [program]);
    const reasoner: Reasoner = { ontologyContextMode: 'task', reviewGoal: syntheticGoalReview,
      ground: async (request, _caps, _signal, access) => { request = observeTaskContext(access) ?? request; acknowledgeReads(access); return { decision: { ...interpretation(request, program.ref.id, source.input), capabilityRef: program.ref }, evidence: evidence() }; },
      plan: async () => { throw new Error('No legacy adapter plan'); }, act: async (ctx, _signal, access) => { const decision = choice(ctx, access); acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } }; } };
    tasks = new TaskService(store, { catalog, allowSandboxActions: true }); coordinator = new Coordinator(store, reasoner, catalog, { allowSandbox: true }); currentOwner = owner; actor = principal;
  }
  const tick = async () => {
    // Each test advances time without the real Gateway event loop. Renew its
    // existing lease explicitly, exactly as the live eligibility timer does.
    foundation?.coordinator.refresh();
    const claim = store.claim(['eigos.delegate'], 30000, now()); assert(claim, 'A bounded observation read must be due');
    try {
      if (secured) await withAuthorization(store.security.workerScope(currentOwner, claim.job.id, claim.securityAuthorityId!, claim.token), () => coordinator.run(claim, new AbortController().signal));
      else await coordinator.run(claim, new AbortController().signal);
    } finally { store.release(claim); await coordinator.releaseModelContext(claim); }
    return store.get(currentOwner, claim.job.id);
  };
  const until = async (id: string, predicate: (job: ReturnType<JobStore['get']>) => boolean, max = 20) => {
    for (let turn = 0; turn < max; turn++) { const job = store.get(currentOwner, id); if (predicate(job)) return job;
      if (!['working', 'submitted'].includes(job.state)) assert.fail(JSON.stringify({ state: job.state, phase: job.delegation?.phase, grounding: job.delegation?.groundingFeedback, feedback: job.delegation?.agent?.feedback, recovery: job.delegation?.recovery }));
      await tick(); }
    const job = store.get(currentOwner, id); assert.fail(JSON.stringify({ state: job.state, phase: job.delegation?.phase, feedback: job.delegation?.agent?.feedback }));
  };
  const install = async () => {
    const target = tasks.submit(actor, { service: 'eigos.delegate', goal: '独立读取合成报名记录，不提交、不付款', requestId: randomUUID(), executionEnvironment: 'sandbox' });
    const proof = await until(target.id, job => job.state === 'completed');
    const columns = variant === 'a' ? ['key', 'title', 'postal', 'memo'] : ['address_key', 'caption', 'location', 'note'];
    const raw = { [columns[0]!]: program.venue.nativeId, [columns[1]!]: program.venue.title, [columns[2]!]: program.venue.address, [columns[3]!]: program.venue.secret };
    const intake = parsePipelineIntake({ format: 'eigos.ontology.pipeline.v1', serviceId: `observer-fixture.${variant}`, source: { id: `observer-fixture.${variant}`, revision: '1', digest: digest(columns), observedAt: new Date(now() - 60000).toISOString(), reference: `urn:eigos:synthetic:observer-${variant}` },
      programRef: program.ref, configurationDigest: program.configurationDigest, environment: 'sandbox', vocabulary: [{ term: '来源保存的会场地址', aliases: [], objectType: 'SavedAddress' }],
      actions: [{ actionId: 'ReadParticipantRegistration', definitionDigest: digest(store.ontology.model.action('ReadParticipantRegistration')), requiredEvidence: 'synthetic' }],
      mappings: [{ id: 'saved-venue', objectType: 'SavedAddress', nativeId: [columns[0]!], maxAgeMs: 60000,
        fields: [{ from: [columns[1]!], to: ['displayTitle'] }, { from: [columns[1]!], to: ['label'] }, { from: [columns[2]!], to: ['address'] }, { from: [columns[3]!], to: ['contactInstructions'] }] }],
      fixtures: [{ mappingId: 'saved-venue', input: raw, expected: { displayTitle: program.venue.title, label: program.venue.title, address: program.venue.address, contactInstructions: program.venue.secret } }],
      conditions: { regions: ['CN'], payment: 'not_required', operatorRequired: false } });
    const ns = store.definitions.namespace('eigos.business'); let draft = store.definitions.createDraft(currentOwner, ns.id, 'Synthetic observer source', true);
    draft = store.definitions.putPipeline(currentOwner, draft.id, draft.revision, intake, true);
    const expiresAt = new Date(now() + 3600000).toISOString(); store.definitions.validatePipeline(currentOwner, draft.id, draft.revision, intake.serviceId, expiresAt, true);
    const entry = store.definitions.pipelineDraft(currentOwner, draft.id, draft.revision, intake.serviceId, true);
    store.definitions.pipeline.verifyTask(ns.id, currentOwner, entry.ref, entry.model, proof, id => store.intent(currentOwner, id), expiresAt);
    const release = store.definitions.publish(currentOwner, draft.id, draft.revision, true).release; store.definitions.activate(currentOwner, release, ns.generation, true);
    program.intake = intake; return { intake, release };
  };
  const submit = (budget: { maxReads?: number; maxActiveMs?: number; until?: string } = {}) => tasks.submit(actor, { service: 'eigos.delegate', requestId: randomUUID(), goal: '独立读取合成报名记录，不提交、不付款', executionEnvironment: 'sandbox',
    observationBudget: { until: budget.until ?? new Date(now() + 180000).toISOString(), maxReads: budget.maxReads ?? 20, maxActiveMs: budget.maxActiveMs ?? 60000 } });
  const control = (id: string, action: 'stop_observation' | 'resume_observation' | 'report_observation_change', watchId?: string) => tasks.controlObservation(actor, observationControlSchema.parse({ action, taskId: id, watchId,
    expectedRevision: store.get(currentOwner, id).revision, requestId: randomUUID(), ...(action === 'report_observation_change' ? { eventId: randomUUID(), contentDigest: digest('hint') } : {}) }));
  return { store, tasks, program, catalog, actor, owner: currentOwner, foundation, now, tick, until, install, submit, control,
    modelCalls: () => modelCalls, elapse: (ms: number) => { offset += ms; }, close: () => { if (foundation) foundation.close(); else store.close(); source.store.close(); } };
}
