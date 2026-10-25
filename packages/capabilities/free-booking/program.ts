import {permitsPersonalSource} from '../../core/source-owner.js';
import { readRegistration, projectRegistration, registrationStatus, isFreeRegistration } from '../../ontology/free-booking-functions.js';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../../core/agent-program.js';
import type { Delivery } from '../../core/catalog.js';
import type { ServiceCapability, ServiceRequest } from '../../ontology/execution.js';
import type { OntologyObjectStore } from '../../ontology/object-store.js';
import { objectRefSchema, type ObjectRef } from '../../ontology/model.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import { registrationActionSchemas, registrationInputSchema, registrationOfferSchema, registrationRecordSchema, registrationResultSchema, type RegistrationAction } from '../../ontology/free-booking.js';
import type { AgentDecision } from '../../ontology/agent-actions.js';

export interface ParticipantBookingSource {
  readonly environment: 'live' | 'sandbox'; readonly configurationDigest: string; readonly identity: string; readonly attendeeRef: string;
  call(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal, recovery?: boolean): Promise<AgentActionResult | undefined>;
  observeOriginal?:AgentProgram['observeOriginal'];
}
const completion = z.strictObject({ registration: objectRefSchema.extend({ type: z.literal('RegistrationRecord') }), rationale: z.string().min(1).max(2000) });
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
export class ParticipantBookingProgram implements AgentProgram {
  readonly projectionTypes=['RegistrationTask','RegistrationOffer','RegistrationRecord','SourceReceipt'];
  readonly ref = { id: 'booking.participant.free', version: '1' };
  readonly liveFreeReservation: true | undefined;
  readonly configurationDigest: string;
  readonly observeOriginal?:AgentProgram['observeOriginal'];
  readonly actionIds: string[];
  readonly completionSchema = z.toJSONSchema(completion);
  readonly limits = { modelTurns: 80, plans: 24, actions: 64 };
  readonly guidance = [
    'Fulfill the participant goal using the published registration Ontology. Select InspectRegistrationPage, the bound SubmitFreeRegistration action, ReadParticipantRegistration, WaitForRegistration and completion based on independently evaluated source facts. There is no fixed recipe.',
    'A free service must explicitly prove payment not_required, zero total, complete mandatory fees and no new agreement. Missing price is unknown. Never use an organizer Add Guests API to impersonate participant registration. No paid tickets, deposits, upgrades, guest invitations or payment actions are available.',
    'Inspect the source page to obtain actual availability, event times, terms and the signed-in participant identity. Submission needs those exact current offer facts and a zero-charge reservation grant. Preserve the original intent on an uncertain response; the source is asynchronous and must be read by its original key, never submitted twice.',
    'After submission, select a fresh ReadParticipantRegistration that reopens the original source page. A submit button, HTTP success, queued operation, submitted application, pending approval, invitation or waitlist does not prove confirmed participation. Match the original registration identity, event, participant and requested time.',
    'An existing registration can be independently read and confirmed without submitting anything. For a read-only goal, select ReadParticipantRegistration directly or inspect the current page first; never select a Submit action. completionTarget still names the existing submitted or confirmed endpoint that must be proven.',
    'For completionTarget=submitted, an independent source read of the accepted submission receipt can complete even while approval is pending. For confirmed, require source state confirmed, its confirmation reference and confirmedAt; pending_approval and waitlisted remain in progress. Select WaitForRegistration to persist a bounded delay, then read the same registration again. An unchanged healthy state is not a failed attempt.',
    'The live Luma source uses a local browser operator bridge. It runs only while an authorized operator is connected to the signed-in browser; it is not a public Luma attendee API or unattended account integration. Source evidence is browser observed, not a Luma-signed API receipt.',
  ].join('\n');
  constructor(readonly source: ParticipantBookingSource) {
    this.observeOriginal=source.observeOriginal?.bind(source);
    this.liveFreeReservation = source.environment === 'live' ? true : undefined;
    this.configurationDigest = digest({ source: source.configurationDigest, semantics: 'participant-free-booking-v1' });
    this.actionIds = ['InspectRegistrationPage', source.environment === 'live' ? 'SubmitFreeRegistration' : 'SubmitFreeRegistrationSandbox', 'ReadParticipantRegistration', 'WaitForRegistration'];
  }
  permitted(owner: string) { return permitsPersonalSource(this,owner); }
  capability(): ServiceCapability {
    const predicates = ['registration.free', 'registration.submitted', 'registration.confirmed'];
    return { ref: this.ref, ontologyRef: { id: 'eigos.registration', version: '1' }, name: '免费活动报名与通用预约', description: `普通参与者的免费报名／预约、审核与候补跟踪、独立确认回读；也可只读核对既有报名或预约的提交／确认状态，无需新提交。支付不是必需步骤。${this.source.environment === 'live' ? '通过本机已登录 Luma 浏览器操作，需要在线操作代理。' : '仅合成来源验证。'}`, tags: ['registration', 'booking', 'free', 'participant', this.source.environment], environment: this.source.environment, inputSchema: z.toJSONSchema(registrationInputSchema), constraintEvaluation: 'staged', actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: id.startsWith('Submit') ? 'reserve' : id === 'WaitForRegistration' ? 'local' : 'read' })), predicates: predicates.map(id => ({ id, description: id })), outcomePredicates: predicates, completion: 'domain', verifierRef: { id: 'registration.independent', version: '1' }, requirementRoles: [{ kind: 'quantity', role: 'participant_count', description: 'Number of registered participants; this initial participant connector supports one signed-in person' }, { kind: 'budget', role: 'service_total', description: 'Complete mandatory service charges, including zero' }, { kind: 'deadline', role: 'completion', description: 'Deadline for the requested submission or confirmation endpoint' }], ontology: { objects: ['RegistrationTask', 'RegistrationOffer', 'RegistrationRecord'], functions: ['registrationStatus'], payment: 'optional', livePaymentsEnabled: false, provider: this.source.identity, execution: 'agent_selected_atomic_actions', source: 'operator_assisted_browser' } };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown) {
    if (!this.permitted(owner) || (request.executionEnvironment ?? 'live') !== this.source.environment) throw new DomainError('FORBIDDEN', 'Participant source is unavailable in this request environment');
    const input = registrationInputSchema.parse(raw), scope = { type: 'RegistrationTask', id: `${request.id}:r${request.revision}` };
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: input.kind === 'event_registration' ? '免费活动报名' : '免费通用预约', requestRevision: request.revision, input, bindingDigest: this.configurationDigest } }], links: [{ type: 'RegistrationTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  schema(action: string) {
    if (!this.actionIds.includes(action)) throw new DomainError('FORBIDDEN', 'Only bound participant actions are available');
    return registrationActionSchemas[action as RegistrationAction];
  }
  definition(graph: OntologyObjectStore, action: string) {
    const definition = graph.model.action(action), operation = definition.read ?? definition.operation;
    if (!operation || !same(operation.inputSchema, z.toJSONSchema(this.schema(action)))) fail('Participant action definition changed');
    return definition;
  }
  private scope(ctx: AgentProgramContext) {
    const record = ctx.graph.read(ctx.owner, ctx.state.scope);
    if (!this.permitted(ctx.owner) || ctx.state.programDigest !== this.configurationDigest || record.properties.bindingDigest !== this.configurationDigest || record.properties.requestRevision !== ctx.request.revision || (ctx.request.executionEnvironment ?? 'live') !== this.source.environment) fail('Participant owner, binding or request changed');
    return registrationInputSchema.parse(record.properties.input);
  }
  private observed(ctx: AgentProgramContext, raw: unknown, historical = false) {
    const s = readRegistration(ctx.graph, ctx.owner, objectRefSchema.parse(raw), undefined, { historical });
    if (!same(s.scope, ctx.state.scope) || s.configurationDigest !== this.configurationDigest || s.receipt.sourceIdentity !== this.source.identity || s.payload.data.attendeeRef !== this.source.attendeeRef || (this.source.environment === 'sandbox') !== (s.evidenceLevel === 'synthetic')) fail('Registration source belongs to another participant or environment');
    return s;
  }
  private evaluate(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot) {
    const ref = objectRefSchema.parse(raw), call = { function: 'registrationStatus', object: ref }, current = ctx.graph.evaluate(ctx.owner, call);
    if (current.status !== 'known' || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(call) && r.outputDigest === digest(current))) fail('Actually evaluate the current participant source facts before deciding');
    return current.value as ReturnType<typeof registrationStatus>;
  }
  private checkSubmissionRequirements(ctx: AgentProgramContext, offer: z.infer<typeof registrationOfferSchema>) {
    for (const requirement of [...ctx.request.requirements, ...(ctx.request.successCriteria ?? [])].filter(r => r.strength === 'hard')) {
      if (requirement.kind === 'quantity') {
        if (requirement.role && requirement.role !== 'participant_count' || requirement.expected.unit !== 'person' || requirement.expected.amount !== String(offer.participants)) fail('The source cannot register the exact requested participant count');
      } else if (requirement.kind === 'budget') {
        if (requirement.role && requirement.role !== 'service_total' || requirement.expected.currency !== offer.payment.total.currency || BigInt(offer.payment.total.minor) > BigInt(requirement.expected.minor)) fail('The complete source price does not satisfy the exact requested budget');
      } else if (requirement.kind === 'deadline') {
        if (requirement.role && requirement.role !== 'completion' || Date.parse(requirement.expected.at) <= Date.now()) fail('The requested endpoint deadline is unsupported or already expired');
      } else if (requirement.kind === 'location' || !['registration.free', 'registration.submitted', 'registration.confirmed'].includes(requirement.expected.predicate)) {
        fail('A hard requested condition is not supported by this participant source; do not create a partial registration');
      }
    }
  }
  validate(ctx: AgentProgramContext, action: string, raw: Record<string, unknown>) {
    this.scope(ctx); const input = this.schema(action).parse(raw) as Record<string, unknown>;
    if (!same(input.scope, ctx.state.scope)) fail('Participant action belongs to another task');
    if (action.startsWith('SubmitFreeRegistration')) {
      const s = this.observed(ctx, input.offer), offer = registrationOfferSchema.parse(s.payload.data);
      if (s.payload.type !== 'RegistrationOffer' || !isFreeRegistration(offer) || offer.availability !== 'available' || offer.alreadyRegistered || offer.requiresAdditionalConsent || Date.parse(offer.expiresAt) <= Date.now()) fail('Submission requires an available, proven free offer without additional consent');
      this.checkSubmissionRequirements(ctx, offer);
      if (ctx.intents?.some(i => i.effect === 'reserve' && i.state === 'effect_confirmed')) fail('Preserve the original participant submission; read its status instead of submitting again');
    } else if (action === 'ReadParticipantRegistration' && input.previous) {
      const s = this.observed(ctx, input.previous, true);
      if (s.payload.type !== 'RegistrationRecord') fail('Read the original registration identity');
    } else if (action === 'WaitForRegistration') {
      const s = this.observed(ctx, input.record), data = registrationRecordSchema.parse(s.payload.data);
      if (s.payload.type !== 'RegistrationRecord' || s.receipt.action !== 'ReadParticipantRegistration' || !data.independentRead || !['submitted', 'pending_approval', 'waitlisted', 'unknown'].includes(data.state)) fail('Wait only on the independently read original unresolved registration');
    }
  }
  validatePlanning(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot) {
    if (action.startsWith('SubmitFreeRegistration')) this.evaluate(ctx, input.offer, reads);
    if (action === 'WaitForRegistration') this.evaluate(ctx, input.record, reads);
  }
  validatePause(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot) {
    if (decision.kind === 'no_feasible_plan' && !ctx.state.observations.some(ref => reads.objects.some(o => same(o.ref, ref)))) fail('Inspect the participant source before rejecting this target');
  }
  authority(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    this.validate(ctx, action, input);
    if (!action.startsWith('SubmitFreeRegistration')) fail('Only participant reservation has a business effect');
    const offer = registrationOfferSchema.parse(this.observed(ctx, input.offer).payload.data);
    return { cost: { minor: '0', currency: offer.payment.total.currency, payeeId: this.source.identity }, operationScope: `registration:${digest({ source: this.source.configurationDigest, participant: offer.attendeeRef, service: offer.serviceUrl, startsAt: offer.startsAt })}` };
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    if (action === 'WaitForRegistration') return { value: { record: input.record }, evidenceRefs: [], waitUntil: new Date(Date.now() + Number(input.seconds) * 1000).toISOString() };
    return (await this.source.call(ctx, action, { scope: this.scope(ctx), ...(input.offer ? { offer: this.observed(ctx, input.offer).payload.data } : {}), ...(input.previous ? { previous: this.observed(ctx, input.previous, true).payload.data } : {}) }, signal))!;
  }
  recover(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal) {
    if (action === 'WaitForRegistration') return this.invoke(ctx, action, input, signal);
    // Only read the already accepted operation. Do not revalidate expired offer facts or replay the write.
    this.scope(ctx);
    return this.source.call(ctx, action, {}, signal, true);
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    if (action === 'WaitForRegistration') return objectRefSchema.parse(input.record);
    const source = registrationResultSchema.parse(result.value);
    if (source.receipt.sourceIdentity !== this.source.identity || source.payload.data.attendeeRef !== this.source.attendeeRef || (this.source.environment === 'sandbox') !== (source.evidenceLevel === 'synthetic')) fail('Participant source or evidence environment changed');
    if (action === 'InspectRegistrationPage' ? source.payload.type !== 'RegistrationOffer' : source.payload.type !== 'RegistrationRecord') fail('Unexpected participant source result');
    if (action.startsWith('SubmitFreeRegistration') && input.offer) {
      const offered = registrationOfferSchema.parse(this.observed(ctx, input.offer, true).payload.data), actual = registrationRecordSchema.parse(source.payload.data);
      for (const key of ['serviceUrl', 'startsAt', 'endsAt', 'participants', 'attendeeRef', 'termsRef', 'payment'] as const) if (!same(offered[key], actual[key])) fail('Submitted registration changed the selected terms');
    }
    if (action === 'ReadParticipantRegistration' && input.previous) {
      const original = registrationRecordSchema.parse(this.observed(ctx, input.previous, true).payload.data), actual = registrationRecordSchema.parse(source.payload.data);
      for (const key of ['registrationId', 'serviceUrl', 'attendeeRef', 'startsAt', 'endsAt', 'timeZone', 'participants', 'kind', 'termsRef', 'payment'] as const) if (!same(original[key], actual[key])) fail('Readback changed the original participant registration');
    }
    return projectRegistration(ctx, action, source);
  }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    const input = this.scope(ctx), proposal = completion.parse(raw), s = this.observed(ctx, proposal.registration), result = this.evaluate(ctx, proposal.registration, reads), data = registrationRecordSchema.parse(s.payload.data);
    if (!isFreeRegistration(data) || !data.independentRead || s.receipt.action !== 'ReadParticipantRegistration' || !('submitted' in result) || (input.completionTarget === 'confirmed' ? !result.confirmed : !result.submitted)) fail('The requested participant endpoint is not independently confirmed');
    const verifiedAt = new Date().toISOString(), predicates = ['registration.free', ...(result.submitted ? ['registration.submitted'] : []), ...(result.confirmed ? ['registration.confirmed'] : [])];
    const resultData = { environment: this.source.environment, evidenceLevel: s.evidenceLevel, source: 'operator_assisted_browser', paymentRequired: false, realPayment: false, completionTarget: input.completionTarget, registration: data, browserEvidence: s.browserEvidence, verifiedAt };
    return { artifact: { id: digest(resultData), name: 'participant-registration.json', data: { goal: ctx.request.originalGoal, deliverable: input.completionTarget === 'confirmed' ? '已独立回读并确认免费报名或预约资格；这不证明实际到场。' : `已独立回读报名或预约提交回执；当前状态：${data.state}。`, execution: 'completed', result: resultData } }, facts: { conditions: predicates, totalPrice: data.payment.total, amounts: { service_total: data.payment.total }, quantity: { amount: '1', unit: 'person' }, quantities: { participant_count: { amount: '1', unit: 'person' } }, deliveryBy: verifiedAt, deadlines: { completion: verifiedAt } }, evidenceRefs: [s.receipt.id] };
  }
}
