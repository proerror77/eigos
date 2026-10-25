import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../../core/agent-program.js';
import type { Delivery } from '../../core/catalog.js';
import { paPaymentRequestSchema, verifyPAPaymentSelection, type PAPaymentTerms } from '../../core/pa-payment.js';
import type { OntologyObjectStore } from '../../ontology/object-store.js';
import { objectRefSchema, type ObjectRef } from '../../ontology/model.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import type { AgentDecision } from '../../ontology/agent-actions.js';
import type { ServiceCapability, ServiceRequest } from '../../ontology/execution.js';
import { bookingActionMetadata, bookingActionSchemas, bookingInputSchema, bookingDataSchema, bookingEntitySchemas, bookingPaymentDataSchema, type BookingAction, type BookingSourceResult } from '../../ontology/booking.js';
import { readBookingObservation, projectBookingObservation } from '../../ontology/booking-functions.js';
import { BookingSandboxConnector, type BookingSandboxOptions } from './connector.js';

function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const completion = z.strictObject({ booking: objectRefSchema.extend({ type: z.literal('BookingObservation') }), payment: objectRefSchema.extend({ type: z.literal('BookingPaymentObservation') }).optional(), rationale: z.string().min(1).max(2000) });
export class BookingAgentProgram implements AgentProgram {
  readonly ref = { id: 'booking.pa-payment.sandbox', version: '3' };
  readonly actionIds = Object.keys(bookingActionSchemas);
  readonly limits = { modelTurns: 48, plans: 20, actions: 36 };
  readonly completionSchema = z.toJSONSchema(completion);
  readonly handoffFields = ['venue', 'startsAt', 'endsAt', 'title'].map(key => ({ path: ['booking', 'offer', key], kind: 'string' as const }));
  readonly connector: BookingSandboxConnector;
  readonly configurationDigest: string;
  readonly guidance = [
    'You select atomic booking actions from independently read Ontology facts. This program is an isolated synthetic booking provider; no real booking or money movement is supported. There is no EIGOS payment action or customer wallet credential.',
    'Payment is optional: when the exact offer explicitly says paymentRequirement=not_required, has zero total and complete fees, create once, read the provider booking independently, and complete with booking only after confirmation. Do not request PA payment or invent a paid observation for a free booking. Missing paymentRequirement preserves the existing required-payment path; zero alone is insufficient.',
    'Discover offers and choose a source offer satisfying the user service, time, participants, venue and complete price constraints. Evaluate bookingObservationStatus on the exact source before reserving. CreatePendingBooking only holds an unpaid booking, with a separate exact zero-payment reservation permit.',
    'Read the original provider booking and separate unpaid payment state independently before RequestPAPayment. This action publishes exact immutable payment terms and pauses so the PA can use its own wallet directly with the provider. Evaluate both observations in this decision; an already paid or processing payment must not produce a new payment request. Never ask the PA for card details, Stripe keys or payment tokens.',
    'Keep both source-provided Link routes. The PA checks its own wallet and calls select_payment_route: prefer Link Agent Wallet when available and supported by the provider; otherwise give the user the original provider Link checkout URL for confirmation. Unknown availability is not unavailability. An issued route may already be in use: never switch routes after selection, a payment submission, a decline or an unknown outcome. A checkout page or redirect is not payment proof.',
    'The same paPayment.request ID and digest survive all responses, retries and restarts. A PA notification is unverified and only wakes you to query the provider. After a handoff, only ReadProviderBooking, ReadProviderPayment and local waiting are available. Never create a replacement booking or payment to resolve uncertainty.',
    'After a notification or an explicit reconcile request, read both the original booking and its separate payment. Obtain fresh receipts after the latest notification. If payment or booking is unresolved, evaluate both and call WaitForPAPayment to pause on the original identity. A repeated handoff never means permission to pay again. If the provider says the booking expired/canceled or the payment was refunded, report that bounded outcome rather than claiming success.',
    'Complete only with separately read and evaluated booking/payment refs. The provider must confirm the original booking AND exact paid amount, currency, payee and original terms. PA submitted/approved/paid text, wallet approval, payment alone or booking alone is insufficient. Booking confirmation proves reservation, not attendance or delivery of the underlying service.',
  ].join('\n');
  constructor(options: BookingSandboxOptions) { this.connector = new BookingSandboxConnector(options); this.configurationDigest = digest({ source: this.connector.configurationDigest, semantics: 'optional-payment-booking-link-routes-v3' }); }
  permitted(owner: string) { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  capability(): ServiceCapability {
    const predicates = ['booking.sandbox_only', 'booking.confirmed', 'booking.payment_confirmed', 'booking.payment_not_required'];
    return { ref: this.ref, ontologyRef: { id: 'eigos.booking.pa-payment', version: '3' }, name: '可选付款预约与独立回读', description: '在隔离服务商沙箱查询和建立预约。明确无需付款且完整费用为零时，只独立核验原预约确认；需要付款时保留 PA 的 Link Agent Wallet／普通 Link 付款和双重回读。无真实预约、扣款或服务履约。', tags: ['booking', 'pa-payment', 'sandbox'], environment: 'sandbox', inputSchema: z.toJSONSchema(bookingInputSchema), constraintEvaluation: 'staged', actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: bookingActionMetadata[id as BookingAction].effect })), predicates: predicates.map(id => ({ id, description: id === 'booking.payment_confirmed' ? 'Independent provider receipt confirms exact PA-funded synthetic payment' : id === 'booking.confirmed' ? 'Independent provider receipt confirms the original booking' : 'All provider and wallet operations stay in the isolated sandbox' })), outcomePredicates: predicates, completion: 'domain', verifierRef: { id: 'booking.pa-payment.independent', version: '3' }, requirementRoles: [{ kind: 'quantity', role: 'participant_count', description: 'Number of participants in the service booking, in person units' }, { kind: 'budget', role: 'service_total', description: 'Complete fixed booking price including every mandatory fee' }, { kind: 'deadline', role: 'completion', description: 'Deadline for obtaining confirmed booking and payment, not service attendance' }, { kind: 'location', role: 'venue', description: 'Exact source venue reference' }], ontology: { objects: ['BookingTask', 'BookingOffers', 'BookingObservation', 'BookingPaymentObservation', 'PAPaymentRequest'], functions: ['bookingObservationStatus'], execution: 'agent_selected_atomic_actions', paymentAuthority: 'pa_owned', realSourceConnected: false } };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown) {
    if (!this.permitted(owner) || request.executionEnvironment !== 'sandbox') throw new DomainError('FORBIDDEN', 'Booking PA-payment program is local sandbox only');
    const input = bookingInputSchema.parse(raw), scope = { type: 'BookingTask', id: `${request.id}:r${request.revision}` };
    for (const r of request.requirements) if (r.strength === 'hard' && r.kind === 'quantity' && (!r.role || r.role === 'participant_count') && (r.expected.unit !== 'person' || r.expected.amount !== String(input.participants))) fail('Booking participants must match the explicit user quantity');
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: 'PA 自主付款预约范围', requestRevision: request.revision, input, configurationDigest: this.configurationDigest, allowedActions: this.actionIds } }], links: [{ type: 'BookingTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  schema(action: string) { if (!Object.hasOwn(bookingActionSchemas, action)) throw new DomainError('FORBIDDEN', 'Unknown booking action; EIGOS cannot pay for the PA'); return bookingActionSchemas[action as BookingAction]; }
  definition(graph: OntologyObjectStore, action: string) {
    const definition = graph.model.action(action), op = definition.read ?? definition.operation;
    if (!op || !same(op.inputSchema, z.toJSONSchema(this.schema(action)))) fail('Booking action differs from its published definition');
    return definition;
  }
  private scope(ctx: AgentProgramContext) {
    const scope = ctx.graph.read(ctx.owner, ctx.state.scope);
    if (!this.permitted(ctx.owner) || ctx.request.executionEnvironment !== 'sandbox' || ctx.state.programDigest !== this.configurationDigest || scope.properties.configurationDigest !== this.configurationDigest || scope.properties.requestRevision !== ctx.request.revision || ctx.state.requestRevision !== ctx.request.revision) throw new DomainError('FORBIDDEN', 'Booking owner, request or source configuration changed');
    if (ctx.state.paPayment) {
      const { digest: expected, ...request } = paPaymentRequestSchema.parse(ctx.state.paPayment.request);
      const stored = ctx.graph.read(ctx.owner, { type: 'PAPaymentRequest', id: request.id });
      if (digest(request) !== expected || request.ownerDigest !== digest(ctx.owner) || request.taskId !== ctx.request.id || request.requestRevision !== ctx.request.revision || request.configurationDigest !== (ctx.executionConfigurationDigest ?? this.configurationDigest) || !same(stored.properties.terms, request.terms) || stored.properties.configurationDigest !== this.configurationDigest) fail('Original PA payment handoff integrity changed');
      verifyPAPaymentSelection(ctx.state.paPayment);
    }
    return bookingInputSchema.parse(scope.properties.input);
  }
  private observation(ctx: AgentProgramContext, raw: unknown, historical = false) {
    const ref = objectRefSchema.parse(raw), s = readBookingObservation(ctx.graph, ctx.owner, ref, { historical });
    if (!same(s.scope, ctx.state.scope) || s.configurationDigest !== ctx.state.programDigest || s.receipt.requestId !== ctx.request.id || s.receipt.requestRevision !== ctx.request.revision) fail('Booking evidence belongs to another task');
    return s;
  }
  private booking(ctx: AgentProgramContext, raw: unknown, historical = false) {
    const s = this.observation(ctx, raw, historical);
    if (s.payload.type !== 'BookingObservation') fail('Expected the original provider booking');
    const data = bookingDataSchema.parse(s.payload.data);
    if (data.paymentHandler.endpoint !== this.connector.origin + '/pa/payments' || data.paymentHandler.payeeId !== data.providerId) fail('Provider payment handler is outside the configured source');
    if (data.checkout.bookingId !== data.bookingId || data.checkout.payeeId !== data.providerId || data.checkout.url !== `${this.connector.origin}/checkout/${encodeURIComponent(data.checkout.id)}`) fail('Provider Link checkout is not bound to the original booking and configured source');
    return { s, data };
  }
  private checkOffer(ctx: AgentProgramContext, offer: z.infer<typeof bookingEntitySchemas.BookingOffers>['offers'][number], fresh: boolean) {
    const scope = this.scope(ctx);
    if (!offer.feesComplete || offer.participants !== scope.participants || scope.startsAt && offer.startsAt !== scope.startsAt || Date.parse(offer.endsAt) <= Date.parse(offer.startsAt) || fresh && (offer.availability !== 'available' || Date.parse(offer.expiresAt) <= Date.now())) fail('Booking offer does not satisfy the requested time, participants or complete current price');
    for (const r of ctx.request.requirements.filter(r => r.strength === 'hard')) {
      if (r.kind === 'budget' && (!r.role || r.role === 'service_total') && (r.expected.currency !== offer.total.currency || BigInt(offer.total.minor) > BigInt(r.expected.minor))) fail('Complete booking price exceeds the user budget');
      if (r.kind === 'location' && (!r.role || r.role === 'venue') && r.expected.ref !== offer.venue) fail('Booking venue differs from the required source venue');
      if (fresh && r.kind === 'deadline' && (!r.role || r.role === 'completion') && Date.parse(r.expected.at) <= Date.now()) fail('The requested booking completion deadline expired');
    }
  }
  private evaluation(ctx: AgentProgramContext, ref: unknown, reads: PlanningSnapshot) {
    const call = { function: 'bookingObservationStatus', object: objectRefSchema.parse(ref) }, current = ctx.graph.evaluate(ctx.owner, call);
    if (current.status !== 'known' || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(call) && r.outputDigest === digest(current))) fail('The Agent must actually evaluate these exact current booking facts');
    return current.value as Record<string, unknown>;
  }
  validate(ctx: AgentProgramContext, action: string, raw: Record<string, unknown>) {
    this.scope(ctx); const input = this.schema(action).parse(raw) as Record<string, unknown>;
    if (!same(input.scope, ctx.state.scope)) fail('Booking action belongs to another scope');
    if (action === 'CreatePendingBooking') {
      if (ctx.state.paPayment) fail('Preserve the original booking after handing payment to the PA');
      const offers = this.observation(ctx, input.offers), data = bookingEntitySchemas.BookingOffers.parse(offers.payload.data);
      const offer = data.offers.find(o => o.id === input.offerId) ?? fail('Choose an offer from the observed source list'); this.checkOffer(ctx, offer, true);
    } else if (action !== 'SearchBookingOffers') {
      const { data, s } = this.booking(ctx, input.booking, ['ReadProviderBooking', 'ReadProviderPayment'].includes(action));
      if (ctx.state.paPayment && (data.bookingId !== ctx.state.paPayment.request.terms.bookingId || data.termsDigest !== ctx.state.paPayment.request.terms.bookingTermsDigest)) fail('Only the original PA-funded booking may be read');
      if (action === 'RequestPAPayment') {
        if (data.offer.paymentRequirement === 'not_required') fail('A free booking must not publish a payment request');
        if (data.offer.paymentRequirement === 'unknown') fail('Resolve the payment requirement from the provider before a payment handoff');
        if (ctx.state.paPayment || s.receipt.action !== 'ReadProviderBooking' || !data.independentRead || data.state !== 'awaiting_payment' || Date.parse(data.holdExpiresAt) <= Date.now()) fail('Payment handoff requires an independently read current unpaid booking, exactly once');
        this.checkOffer(ctx, data.offer, false);
        const payment = this.observation(ctx, input.payment), unpaid = bookingPaymentDataSchema.parse(payment.payload.data);
        if (payment.receipt.action !== 'ReadProviderPayment' || unpaid.bookingId !== data.bookingId || unpaid.bookingTermsDigest !== data.termsDigest || unpaid.state !== 'unpaid' || unpaid.paidAmount.minor !== '0' || unpaid.paymentId || unpaid.capturedAt) fail('PA payment request requires independent proof that the original booking has not been paid or submitted');
      }
      if (action === 'WaitForPAPayment') {
        if (!ctx.state.paPayment) fail('Wait requires the original payment handoff');
        const payment = this.observation(ctx, input.payment);
        if (s.receipt.readbackSequence !== ctx.state.paPayment.readbackSequence || payment.receipt.readbackSequence !== ctx.state.paPayment.readbackSequence) fail('Read both provider states for the current payment notification before waiting');
        if (payment.payload.type !== 'BookingPaymentObservation' || payment.payload.data.bookingId !== data.bookingId || ['expired', 'canceled'].includes(data.state) || data.state === 'confirmed' && payment.payload.data.state === 'paid') fail('Select the evidenced terminal outcome instead of waiting or replacing this booking');
      }
    }
  }
  validatePlanning(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot) {
    if (action === 'CreatePendingBooking') this.evaluation(ctx, input.offers, reads);
    if (action === 'RequestPAPayment' || action === 'WaitForPAPayment') this.evaluation(ctx, input.booking, reads);
    if (action === 'RequestPAPayment' || action === 'WaitForPAPayment') this.evaluation(ctx, input.payment, reads);
  }
  validatePause(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot) {
    if (decision.kind === 'clarify' && ctx.state.paPayment) fail('Use WaitForPAPayment to preserve the original payment handoff');
    if (decision.kind === 'no_feasible_plan' && !ctx.state.observations.some(ref => ['BookingOffers', 'BookingObservation', 'BookingPaymentObservation'].includes(ref.type) && reads.objects.some(o => same(o.ref, ref)))) fail('Read provider facts before rejecting the booking outcome');
  }
  authority(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    this.validate(ctx, action, input);
    if (action !== 'CreatePendingBooking') fail('Only unpaid booking reservation has a provider write');
    const s = this.observation(ctx, input.offers), data = bookingEntitySchemas.BookingOffers.parse(s.payload.data), offer = data.offers.find(o => o.id === input.offerId)!;
    return { cost: { minor: '0', currency: offer.total.currency, payeeId: offer.providerId }, operationScope: `booking:${digest({ owner: ctx.owner, request: ctx.request.id, revision: ctx.request.revision, provider: offer.providerId })}` };
  }
  private paymentTerms(ctx: AgentProgramContext, booking: ObjectRef, payment: ObjectRef): PAPaymentTerms {
    const { data } = this.booking(ctx, booking);
    return { providerId: data.providerId, bookingId: data.bookingId, bookingTermsDigest: data.termsDigest, booking: { type: 'BookingObservation', id: booking.id }, unpaidObservation: { type: 'BookingPaymentObservation', id: payment.id }, description: `${data.offer.title}; ${data.offer.startsAt}; ${data.offer.participants} participant(s)`, amount: data.offer.total, handler: data.paymentHandler, checkout: data.checkout, routePolicy: 'prefer_link_agent_wallet', expiresAt: data.holdExpiresAt, environment: 'sandbox', evidenceLevel: 'synthetic' };
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    if (action === 'RequestPAPayment' || action === 'WaitForPAPayment') {
      const terms = action === 'RequestPAPayment' ? this.paymentTerms(ctx, objectRefSchema.parse(input.booking), objectRefSchema.parse(input.payment)) : ctx.state.paPayment!.request.terms;
      return { value: { terms }, evidenceRefs: [], paPayment: { mode: action === 'RequestPAPayment' ? 'request' : 'wait', terms } };
    }
    let payload: Record<string, unknown>;
    if (action === 'SearchBookingOffers') payload = { ...this.scope(ctx), query: input.query };
    else if (action === 'CreatePendingBooking') { const s = this.observation(ctx, input.offers), offer = bookingEntitySchemas.BookingOffers.parse(s.payload.data).offers.find(o => o.id === input.offerId)!; payload = { searchId: s.payload.sourceId, offerId: offer.id, offerDigest: digest(offer) }; }
    else payload = { bookingId: this.booking(ctx, input.booking, true).data.bookingId };
    const result = (await this.connector.call(ctx, action, payload, signal))!;
    if (result.payload.type !== bookingActionMetadata[action as BookingAction].type) fail('Provider returned another booking object type');
    return { value: result, evidenceRefs: [result.receipt.id] };
  }
  async recover(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal) {
    if (action === 'RequestPAPayment' || action === 'WaitForPAPayment') return this.invoke(ctx, action, input, signal);
    if (action !== 'CreatePendingBooking') return;
    const result = await this.connector.call(ctx, action, {}, signal, true);
    if (result) return { value: result, evidenceRefs: [result.receipt.id] };
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult) {
    if (!result.paPayment) return projectBookingObservation(ctx, action, input, result.value as BookingSourceResult);
    const terms = result.paPayment.terms, ref = { type: 'PAPaymentRequest', id: digest({ request: ctx.request.id, revision: ctx.request.revision, configuration: ctx.state.programDigest, booking: terms.bookingId, termsDigest: terms.bookingTermsDigest }) };
    if (action === 'WaitForPAPayment') { const existing = ctx.graph.read(ctx.owner, ref); if (!same(existing.properties.terms, terms)) fail('Original payment request changed'); return ref; }
    if (!same(terms, this.paymentTerms(ctx, objectRefSchema.parse(input.booking), objectRefSchema.parse(input.payment)))) fail('Payment handoff terms differ from the independently observed booking');
    ctx.graph.ingest(ctx.owner, { objects: [{ ref, properties: { id: ref.id, displayTitle: 'PA 自有支付能力付款请求', requestRevision: ctx.request.revision, terms, configurationDigest: ctx.state.programDigest } }], links: [{ type: 'PAPaymentRequestRequest', from: ref, to: { type: 'ServiceRequest', id: ctx.request.id } }, { type: 'PAPaymentRequestScope', from: ref, to: ctx.state.scope }, { type: 'PAPaymentBooking', from: ref, to: terms.booking }, { type: 'PAPaymentUnpaidProof', from: ref, to: terms.unpaidObservation }] }, { kind: 'task', id: ctx.request.id, observedAt: new Date().toISOString() });
    return ref;
  }
  private matchPayment(ctx: AgentProgramContext, booking: z.infer<typeof bookingDataSchema>, payment: z.infer<typeof bookingPaymentDataSchema>) {
    const terms = ctx.state.paPayment?.request.terms ?? fail('Completion requires the original PA payment handoff');
    if (booking.termsDigest !== digest({ offer: booking.offer, paymentHandler: booking.paymentHandler, checkout: booking.checkout }) || !same(booking.paymentHandler, terms.handler) || !same(booking.checkout, terms.checkout) || booking.holdExpiresAt !== terms.expiresAt) return false;
    return booking.bookingId === terms.bookingId && booking.providerId === terms.providerId && booking.termsDigest === terms.bookingTermsDigest && payment.bookingId === booking.bookingId && payment.providerId === booking.providerId && payment.payeeId === terms.handler.payeeId && payment.bookingTermsDigest === terms.bookingTermsDigest && same(booking.offer.total, terms.amount) && same(payment.amount, terms.amount) && same(payment.paidAmount, terms.amount) && payment.state === 'paid' && !!payment.paymentId && !!payment.capturedAt && Date.parse(payment.capturedAt) <= Date.now() && Date.parse(payment.capturedAt) <= Date.parse(terms.expiresAt) && booking.state === 'confirmed' && !!booking.confirmedAt && Date.parse(booking.confirmedAt) <= Date.now();
  }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    const selected = completion.parse(raw); this.scope(ctx);
    this.evaluation(ctx, selected.booking, reads);
    const booking = this.booking(ctx, selected.booking);
    if (booking.data.offer.paymentRequirement === 'not_required') {
      const b = booking.data;
      if (selected.payment || ctx.state.paPayment || b.offer.total.minor !== '0' || !b.offer.feesComplete || b.state !== 'confirmed' || !b.confirmedAt || Date.parse(b.confirmedAt) > Date.now() || !b.independentRead || booking.s.receipt.action !== 'ReadProviderBooking') fail('Free booking completion requires a separately read, confirmed zero-price booking without a payment handoff');
      this.checkOffer(ctx, b.offer, false);
      const result = { environment: 'sandbox', evidenceLevel: 'synthetic', realPayment: false, paymentRequired: false, booking: b, sourceRefs: [selected.booking], receiptIds: [booking.s.receipt.id] };
      return { evidenceLevel: 'synthetic', artifact: { id: digest(result), name: 'free-booking-result.json', data: { goal: ctx.request.originalGoal, deliverable: '已独立核验无需付款的沙箱预约确认；这不是实际服务履约。', execution: 'completed', result } }, facts: { conditions: ['booking.sandbox_only', 'booking.confirmed', 'booking.payment_not_required'], totalPrice: b.offer.total, amounts: { service_total: b.offer.total }, quantity: { amount: String(b.offer.participants), unit: 'person' }, quantities: { participant_count: { amount: String(b.offer.participants), unit: 'person' } }, deliveryBy: b.confirmedAt, deadlines: { completion: b.confirmedAt }, locationRef: b.offer.venue, locations: { venue: b.offer.venue } }, evidenceRefs: [booking.s.receipt.id] };
    }
    if (!selected.payment) fail('A required payment must be independently confirmed');
    this.evaluation(ctx, selected.payment, reads);
    const payment = this.observation(ctx, selected.payment), paid = bookingPaymentDataSchema.parse(payment.payload.data);
    const handoff = ctx.state.paPayment ?? fail('No PA payment handoff was recorded');
    const after = Date.parse(handoff.reports.at(-1)?.receivedAt ?? handoff.request.createdAt);
    if (handoff.readbackSequence < 1 || booking.s.receipt.readbackSequence !== handoff.readbackSequence || payment.receipt.readbackSequence !== handoff.readbackSequence || booking.s.receipt.action !== 'ReadProviderBooking' || !booking.data.independentRead || payment.receipt.action !== 'ReadProviderPayment' || Date.parse(booking.s.receipt.startedAt) < after || Date.parse(payment.receipt.startedAt) < after || !this.matchPayment(ctx, booking.data, paid)) fail('Independent fresh provider payment AND booking confirmation must match the original handoff; PA claims are insufficient');
    this.checkOffer(ctx, booking.data.offer, false);
    const evidenceRefs = [booking.s.receipt.id, payment.receipt.id], result = { environment: 'sandbox', evidenceLevel: 'synthetic', realPayment: false, paymentAuthority: 'pa_owned', paymentRoute: handoff.selection?.route ?? 'unreported', handoffId: handoff.request.id, booking: booking.data, payment: paid, sourceRefs: selected, receiptIds: evidenceRefs };
    return { evidenceLevel: 'synthetic', artifact: { id: digest(result), name: 'pa-booking-result.json', data: { goal: ctx.request.originalGoal, deliverable: '已独立核验原预约与 PA 模拟付款均获服务商确认；这是沙箱预约确认，不是实际服务履约。', execution: 'completed', result } }, facts: { conditions: ['booking.sandbox_only', 'booking.confirmed', 'booking.payment_confirmed'], totalPrice: booking.data.offer.total, amounts: { service_total: booking.data.offer.total }, quantity: { amount: String(booking.data.offer.participants), unit: 'person' }, quantities: { participant_count: { amount: String(booking.data.offer.participants), unit: 'person' } }, deliveryBy: booking.data.confirmedAt, deadlines: { completion: booking.data.confirmedAt }, locationRef: booking.data.offer.venue, locations: { venue: booking.data.offer.venue } }, evidenceRefs };
  }
  async reconcilePAPayment(ctx: AgentProgramContext, signal: AbortSignal) {
    this.scope(ctx); const payment = ctx.state.paPayment ?? fail('Original PA handoff is missing');
    const step = ctx.state.plans.flatMap(p => p.steps.map(s => ({ p, s }))).find(x => x.s.action === 'RequestPAPayment') ?? fail('Original handoff plan is missing');
    const context: AgentActionContext = { ...ctx, planId: step.p.id, intentId: step.s.intentId, attemptId: randomUUID(), modelRunId: step.p.modelRunId, operationKey: `terminal-pa-read:${payment.request.id}` };
    const [b, p] = await Promise.all(['ReadProviderBooking', 'ReadProviderPayment'].map(action => this.connector.call({ ...context, attemptId: randomUUID() }, action, { bookingId: payment.request.terms.bookingId }, signal)));
    const booking = bookingDataSchema.parse(b!.payload.data), paid = bookingPaymentDataSchema.parse(p!.payload.data);
    if (b!.receipt.sourceIdentity !== payment.request.terms.providerId || p!.receipt.sourceIdentity !== payment.request.terms.providerId || booking.bookingId !== payment.request.terms.bookingId || paid.bookingId !== booking.bookingId || booking.termsDigest !== payment.request.terms.bookingTermsDigest || paid.bookingTermsDigest !== booking.termsDigest) fail('Terminal readback returned another provider booking');
    return { observedAt: new Date().toISOString(), result: this.matchPayment(ctx, booking, paid) ? 'confirmed' as const : ['awaiting_payment', 'unknown'].includes(booking.state) ? 'pending' as const : 'mismatch' as const, evidenceRefs: [b!.receipt.id, p!.receipt.id] };
  }
}
