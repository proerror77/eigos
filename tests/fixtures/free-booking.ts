import { syntheticGoalReview } from '../backend-fixture.js';
// Synthetic participant source and model. No Luma account or public event is contacted.
import { randomUUID } from 'node:crypto';
import { digest } from '../../packages/core/delegation.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import type { ParticipantBookingSource } from '../../packages/capabilities/free-booking/program.js';
import { AgentOperationRejected, type AgentActionContext, type AgentActionResult } from '../../packages/core/agent-program.js';
import { registrationOfferSchema, registrationRecordSchema, registrationResultSchema, type RegistrationData } from '../../packages/ontology/free-booking.js';
import type { AgentPlanningContext, PlanningAccess, Reasoner } from '../../packages/coordinator/coordinator.js';
import { commerceDecision as decision, commerceStep as step } from './commerce-agent.js';
import { backend, evidence, interpretation, owner, principal, observeTaskContext, acknowledgeReads } from '../backend-fixture.js';
import type { Job } from '../../packages/core/domain.js';
import type { ObjectRef } from '../../packages/ontology/model.js';

export function participantChoice(ctx: AgentPlanningContext, access: PlanningAccess) {
  access.session.call('describe_ontology', { search: 'RegistrationTask', limit: 1 });
  access.session.call('query_ontology', { object: ctx.state.scope });
  const last = (type: string) => {
    const ref = ctx.state.observations.filter(r => r.type === type).at(-1); if (!ref) return;
    const read = access.session.call('query_ontology', { object: ref }) as { items: { properties: { data: Record<string, any> } }[] };
    const result = access.session.call('evaluate_ontology', { function: 'registrationStatus', object: ref }) as { status: string; value?: Record<string, any> };
    return { ref, data: read.items[0]!.properties.data, status: result.value };
  };
  const offer = last('RegistrationOffer'), record = last('RegistrationRecord'), scope = ctx.state.scope;
  if (!offer) return decision(ctx, [step('inspect', 'InspectRegistrationPage', { scope })]);
  if (!record) {
    if (offer.data.alreadyRegistered) return decision(ctx, [step('read_existing', 'ReadParticipantRegistration', { scope })]);
    if (!offer.status?.canSubmit) return { ...decision(ctx), kind: 'no_feasible_plan' as const, message: 'The synthetic source has no proven free offer without additional consent.' };
    return decision(ctx, [step('submit', ctx.actionIds.find(id => id.startsWith('SubmitFreeRegistration'))!, { scope, offer: offer.ref })]);
  }
  if (!record.data.independentRead || ctx.state.plans.at(-1)?.steps[0]?.action === 'WaitForRegistration') return decision(ctx, [step('read', 'ReadParticipantRegistration', { scope, previous: record.ref })]);
  const target = (ctx.state.input as { completionTarget: string }).completionTarget;
  if (target === 'submitted' ? record.status?.submitted : record.status?.confirmed) return decision(ctx, [], { registration: record.ref, rationale: 'Independently read the exact requested synthetic participant endpoint' });
  if (['rejected', 'canceled', 'expired'].includes(record.data.state)) return { ...decision(ctx), kind: 'no_feasible_plan' as const, message: 'The original source registration cannot reach its target.' };
  return decision(ctx, [step('wait', 'WaitForRegistration', { scope, record: record.ref, seconds: 1 })]);
}

export function participantFixture(options: { target?: 'submitted' | 'confirmed'; kind?: 'event_registration' | 'appointment'; state?: RegistrationData['state']; asyncSubmit?: boolean; choice?: typeof participantChoice } = {}) {
  const attendeeRef = digest('synthetic-participant'), identity = 'synthetic-participant-source', at = new Date(Date.now() + 86400000).toISOString();
  const input = { kind: options.kind ?? 'event_registration', serviceUrl: 'https://luma.com/eigos-synthetic-free', completionTarget: options.target ?? 'confirmed', participants: 1 as const, startsAt: null };
  const terms = { serviceUrl: input.serviceUrl, title: 'Synthetic free participant event', kind: input.kind, startsAt: at, endsAt: new Date(Date.parse(at) + 3600000).toISOString(), timeZone: 'Asia/Shanghai', participants: 1 as const, attendeeRef, payment: { requirement: 'not_required' as const, total: { minor: '0', currency: 'CNY' }, feesComplete: true }, termsRef: 'synthetic-free-terms' };
  let state: RegistrationData['state'] = options.state ?? 'confirmed', submits = 0, version = 0, pending = options.asyncSubmit ?? false, recoveries = 0;
  const flags = { alreadyRegistered: false, paid: false, missingFees: false, consent: false, wrongParticipant: false, changedReference: false, noConfirmation: false, rejectSubmit: false };
  const accepted = new Set<string>();
  const result = (ctx: AgentActionContext, action: string): AgentActionResult => {
    const observedAt = new Date().toISOString();
    const values = { ...terms, ...(flags.wrongParticipant ? { attendeeRef: digest('other-participant') } : {}), payment: { ...terms.payment, ...(flags.paid ? { requirement: 'required' as const, total: { minor: '100', currency: 'CNY' } } : {}), feesComplete: !flags.missingFees } };
    const data = action === 'InspectRegistrationPage' ? registrationOfferSchema.parse({ ...values, availability: 'available', alreadyRegistered: flags.alreadyRegistered, requiresApproval: state === 'pending_approval', requiresAdditionalConsent: flags.consent, observedAt, expiresAt: new Date(Date.now() + 300000).toISOString() }) : registrationRecordSchema.parse({ ...values, registrationId: flags.changedReference && action === 'ReadParticipantRegistration' ? 'different-registration' : 'synthetic-registration', state, submittedAt: observedAt, ...(state === 'confirmed' ? { confirmedAt: observedAt, ...(!flags.noConfirmation ? { confirmationReference: 'synthetic-confirmation' } : {}) } : {}), observedAt, independentRead: action === 'ReadParticipantRegistration' });
    const payload = { type: action === 'InspectRegistrationPage' ? 'RegistrationOffer' as const : 'RegistrationRecord' as const, data, sourceId: action === 'InspectRegistrationPage' ? input.serviceUrl : 'synthetic-registration', sourceVersion: ++version, expiresAt: new Date(Date.now() + 300000).toISOString() };
    const receipt = { id: digest(randomUUID()), ownerDigest: digest(ctx.owner), requestId: ctx.request.id, requestRevision: ctx.request.revision, action, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, operationKey: ctx.operationKey!, readbackSequence: 0, sourceIdentity: identity, method: 'GET' as const, path: '/synthetic', status: 200 as const, responseSha256: digest(payload), payloadDigest: digest(payload), signature: 'a'.repeat(64), startedAt: observedAt, receivedAt: observedAt };
    const value = registrationResultSchema.parse({ payload, receipt, evidenceLevel: 'synthetic', browserEvidence: { pageUrl: input.serviceUrl, snapshotSha256: 'b'.repeat(64), screenshotSha256: 'c'.repeat(64), observedAt } });
    return { value, evidenceRefs: [receipt.id] };
  };
  const source: ParticipantBookingSource = { environment: 'sandbox', configurationDigest: digest({ fixture: 'participant-v1' }), identity, attendeeRef,
    call: async (ctx, action, _input, _signal, recovery) => {
      if (action.startsWith('SubmitFreeRegistration')) {
        if (recovery) recoveries++;
        else { ctx.assertDispatchAllowed!(); if (accepted.has(ctx.operationKey!)) throw new Error('Duplicate synthetic source write'); accepted.add(ctx.operationKey!); submits++; }
        if (pending) return { value: { queued: true }, evidenceRefs: [], pending: { retryAfterMs: 100 } };
        if (flags.rejectSubmit && recovery) throw new AgentOperationRejected('Synthetic source confirms that the original submission was rejected without creating a registration', [digest(ctx.operationKey)]);
      }
      return result(ctx, action);
    } };
  const catalog = createExecutionCatalog({ participantBookingSource: source });
  const model: Reasoner = { reviewGoal: syntheticGoalReview, ground: async (request, _caps, _signal, access) => ({ decision: { ...interpretation(observeTaskContext(access) ?? request, 'booking.participant.free', input), capabilityRef: { id: 'booking.participant.free', version: '1' } }, evidence: evidence() }), plan: async () => { throw new Error('Participant registration must use the business Agent'); }, act: async (ctx, _signal, access) => { observeTaskContext(access); const selected = (options.choice ?? participantChoice)(ctx, access); acknowledgeReads(access); return { decision: selected, evidence: { ...evidence(), decisionDigest: digest(selected) } }; } };
  const b = backend(catalog, model, undefined, { allowSandbox: true });
  const approve = (job: Job) => { const a = job.delegation!.authorizationRequest!; return b.tasks.authorize(principal, job.id, { action: 'approve_plan', requestId: randomUUID(), planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }); };
  const until = async (predicate: (job: Job) => boolean, max = 80) => {
    for (let i = 0; i < max; i++) {
      const job = b.store.list(owner, { limit: 1, offset: 0 }).jobs[0]!;
      if (predicate(job)) return job;
      if (job.state === 'auth-required') approve(job);
      else if (job.state === 'working' || job.state === 'submitted') {
        const wait = Math.max(0, (job.delegation!.nextAt ?? 0) - Date.now()); if (wait) await new Promise(done => setTimeout(done, wait + 5));
        await b.run();
      } else throw new Error(`Unexpected synthetic participant state: ${job.state}: ${job.question ?? job.error}`);
    }
    throw new Error('Synthetic participant budget exceeded');
  };
  return { ...b, catalog, model, source, flags, input, approve, until, counters: () => ({ submits, recoveries }), release: () => { pending = false; }, setState: (next: RegistrationData['state']) => { state = next; }, submit: (extra: object = {}) => b.submit({ goal: '合成验证：免费报名并独立确认参加资格，不付款。', executionEnvironment: 'sandbox', ...extra }), last: (job: Job, type: string): ObjectRef => job.delegation!.agent!.observations.filter(ref => ref.type === type).at(-1)! };
}
