import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { JobStore } from '../../packages/core/store.js';
import { digest } from '../../packages/core/delegation.js';
import type { AgentPlanningContext, PlanningAccess, Reasoner } from '../../packages/coordinator/coordinator.js';
import type { AgentDecision, AgentStep } from '../../packages/ontology/agent-actions.js';
import type { CompositionInput } from '../../packages/ontology/composition.js';
import type { EventOccurrenceData } from '../../packages/ontology/event-occurrence.js';
import type { Job } from '../../packages/core/domain.js';
import { backend, evidence, interpretation, owner, principal, syntheticGoalReview } from '../backend-fixture.js';
import { participantFixture } from './free-booking.js';
import { didiFixture } from './didi.js';
import { CalendarSandboxSource } from '../../packages/capabilities/calendar/sandbox.js';

const step = (action: string, args: object): AgentStep => ({ id: `step_${action}`, action, argumentsJson: JSON.stringify(args), dependsOn: [], inputRefs: [] });
export function chooseSituation(ctx: AgentPlanningContext, access: PlanningAccess): AgentDecision {
  access.session.call('describe_ontology', { actions: ['ActivateServiceComponent', 'CompleteServiceComponent', 'RepairServiceComponent', 'StartObservationWatch'] });
  access.session.call('query_ontology', { object: ctx.state.scope });
  const execute = (action: string, args: object): AgentDecision => ({ kind: 'execute', requestRevision: ctx.request.revision, message: 'Synthetic explicit situation decision', steps: [step(action, args)], completionJson: '' });
  const nodes = (ctx.state.input as unknown as CompositionInput).components, states = ctx.state.components!;
  for (const node of nodes) {
    const state = states[node.id]!;
    if (!state.scope) return execute('ActivateServiceComponent', { scope: ctx.state.scope, componentId: node.id });
    access.session.call('query_ontology', { object: state.scope });
    const types = node.id === 'registration' ? ['RegistrationOffer', 'RegistrationRecord'] : node.id === 'calendar' ? ['CalendarObservation'] : ['DidiPlaceObservation'];
    const observed = Object.fromEntries(types.map(type => {
      const ref = state.observations.filter(o => o.type === type).at(-1);
      if (!ref) return [type, undefined];
      const read = access.session.call('query_ontology', { object: ref }) as { items: { properties: Record<string, any> }[] };
      const evaluation = access.session.call('evaluate_ontology', { function: node.id === 'registration' ? 'registrationStatus' : node.id === 'calendar' ? 'calendarStatus' : 'rideEstimateStatus', object: ref }) as { status: string; value?: any };
      return [type, { ref, properties: read.items[0]!.properties, evaluation }];
    }));
    if (state.validity === 'stale') return execute('RepairServiceComponent', { scope: ctx.state.scope, componentId: node.id, expectedGeneration: state.generation });
    const latest = observed[node.id === 'registration' ? 'RegistrationRecord' : node.id === 'calendar' ? 'CalendarObservation' : 'DidiPlaceObservation'];
    if (!state.result) {
      if (node.id === 'registration') {
        const offer = observed.RegistrationOffer;
        if (!offer) return execute('InspectRegistrationPage', { scope: state.scope });
        if (!latest) return execute('SubmitFreeRegistrationSandbox', { scope: state.scope, offer: offer.ref });
        if (!latest.properties.data.independentRead || latest.evaluation.status !== 'known') return execute('ReadParticipantRegistration', { scope: state.scope, previous: latest.ref });
        if (!latest.evaluation.value?.confirmed) return { kind: 'no_feasible_plan', requestRevision: ctx.request.revision, message: 'The independently read source cannot confirm this registration', steps: [], completionJson: '', componentId: node.id };
      } else if (node.id === 'calendar') {
        if (!latest || !latest.properties.data.independentRead || latest.evaluation.status !== 'known') return execute('ReadCalendarEntry', { scope: state.scope });
        if (!latest.evaluation.value?.matches) return execute(latest.properties.data.state === 'missing' ? 'CreateCalendarEntrySandbox' : 'UpdateCalendarEntrySandbox', { scope: state.scope, previous: latest.ref });
      } else if (!latest || latest.evaluation.status !== 'known') return execute('SearchDidiPlaces', { scope: state.scope, role: 'search', keywords: state.input!.keywords });
      return execute('CompleteServiceComponent', { scope: ctx.state.scope, componentId: node.id, completionJson: JSON.stringify({ [node.id === 'registration' ? 'registration' : node.id === 'calendar' ? 'entry' : 'observation']: latest!.ref, rationale: 'Current synthetic source independently verified' }) });
    }
    if (ctx.request.monitoring && Date.now() < Date.parse(ctx.request.monitoring.until) && !ctx.situation?.watches.some(w => w.componentId === node.id && w.status === 'active')) {
      const action = node.id === 'registration' ? 'ReadParticipantRegistration' : node.id === 'calendar' ? 'ReadCalendarEntry' : 'SearchDidiPlaces';
      const args = node.id === 'registration' ? { scope: state.scope, previous: latest!.ref } : node.id === 'calendar' ? { scope: state.scope } : { scope: state.scope, role: 'search', keywords: state.input!.keywords };
      return execute('StartObservationWatch', { scope: ctx.state.scope, componentId: node.id, observation: latest!.ref, action, argumentsJson: JSON.stringify(args), policy: { intervalMs: 60_000, maxAgeMs: 300_000 }, refreshCompletion: true });
    }
  }
  return { kind: 'complete', requestRevision: ctx.request.revision, message: 'All current component results satisfy the synthetic ongoing goal', steps: [], completionJson: '{"rationale":"Independent current sources for every component"}' };
}

export function situationFixture(options: { durationMs?: number; path?: string; choice?: typeof chooseSituation; maxQueries?: number; calendar?: boolean; calendarPath?: string; registrationFreshnessMs?: number } = {}) {
  const startsAt = new Date(Date.now() + 86400000).toISOString();
  const event: EventOccurrenceData = { sourceId: 'synthetic-event', identityBasis: 'provider_id', canonicalUrl: 'https://luma.com/eigos-synthetic-free', title: 'Synthetic exhibition', startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3600000).toISOString(), admissionClosesAt: startsAt, timeZone: 'Asia/Shanghai', venueName: '场馆 A', venueAddress: '北京市场馆 A', venueCity: '北京市', state: 'scheduled' };
  const registration = participantFixture({ event, freshnessMs: options.registrationFreshnessMs }), didi = didiFixture('mock'), store = new JobStore(options.path ?? ':memory:');
  const calendar = new CalendarSandboxSource({ databasePath: options.calendarPath ?? ':memory:', owner, accountRef: 'synthetic-calendar-account', calendarId: 'synthetic-personal-calendar' });
  const calendarCalls: string[] = [], calendarCall = calendar.call.bind(calendar);
  calendar.call = async (...args) => { calendarCalls.push(args[1]); return calendarCall(...args); };
  const catalog = createExecutionCatalog({ store, participantBookingSource: registration.source, didi: { ...didi.binding, connector: didi.connector }, ...(options.calendar ? { calendarSource: calendar } : {}) });
  const input: CompositionInput = { components: [
    { id: 'registration', capabilityRef: { id: 'booking.participant.free', version: '1' }, goal: '合成免费报名并持续读取活动地点', input: registration.input, dependsOn: [], bindings: [], requirementIds: [], conditionIds: [] },
    { id: 'didi', capabilityRef: { id: 'ride.estimate.query', version: '1' }, goal: '用当前活动地址查询滴滴地点', input: { mode: 'places', city: '北京市' }, dependsOn: ['registration'], bindings: [{ from: 'registration', targetKey: 'keywords', path: ['registration', 'event', 'venueAddress'] }], requirementIds: [], conditionIds: [] },
  ] };
  if (options.calendar) input.components.splice(1, 0, { id: 'calendar', capabilityRef: { id: 'calendar.event.manage', version: '1' }, goal: '维护原日历事项的活动时间和地点', input: {}, dependsOn: ['registration'],
    bindings: [['sourceId', 'eventKey'], ['title', 'title'], ['startsAt', 'startsAt'], ['endsAt', 'endsAt'], ['timeZone', 'timeZone'], ['venueAddress', 'location']].map(([field, target]) => ({ from: 'registration', targetKey: target!, path: ['registration', 'event', field!] })), requirementIds: [], conditionIds: [] });
  let modelCalls = 0;
  const model: Reasoner = { reviewGoal: syntheticGoalReview, ground: async request => ({ decision: { ...interpretation(request, 'services.compose.sandbox', input), capabilityRef: { id: 'services.compose.sandbox', version: '2' } }, evidence: evidence() }),
    plan: async () => { throw new Error('No fixed situation recipe'); }, act: async (ctx, _signal, access) => { modelCalls++; const selected = (options.choice ?? chooseSituation)(ctx, access); return { decision: selected, evidence: { ...evidence(), decisionDigest: digest(selected) } }; } };
  const b = backend(catalog, model, store, { allowSandbox: true });
  const until = async (id: string, predicate: (job: Job) => boolean, max = 60) => {
    for (let i = 0; i < max; i++) {
      const current = store.get(owner, id); if (predicate(current)) return current;
      if (current.state === 'auth-required') {
        const a = current.delegation!.authorizationRequest!;
        b.tasks.authorize(principal, id, { action: 'approve_plan', requestId: randomUUID(), planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60_000).toISOString(), environment: 'sandbox' });
      } else if (['submitted', 'working'].includes(current.state)) {
        const wait = Math.max(0, (current.delegation!.nextAt ?? 0) - Date.now()); if (wait) await delay(wait + 5);
        await b.run();
      } else throw new Error(JSON.stringify({ state: current.state, question: current.question, error: current.error, feedback: current.delegation!.agent?.feedback }));
    }
    throw new Error(JSON.stringify(store.get(owner, id).delegation?.agent?.feedback));
  };
  const notify = (id: string, eventId = randomUUID()) => {
    const watch = store.situations.watches(owner, id).find(w => w.selection.componentId === 'registration' && w.status === 'active')!;
    return store.situations.receive(owner, watch.selection.source, { eventId, contentDigest: digest(event), kind: 'provider_hint' });
  };
  return { ...b, catalog, model, event, registration, didi, calendar, calendarCalls, until, notify, modelCalls: () => modelCalls,
    submit: () => b.submit({ goal: '合成验证：报名后在约定期限内维护活动地点与交通查询。禁止真实下单和付款。', executionEnvironment: 'sandbox', monitoring: { until: new Date(Date.now() + (options.durationMs ?? 60_000)).toISOString(), maxQueries: options.maxQueries ?? 32 } }),
    close: () => { store.close(); registration.store.close(); didi.close(); calendar.close(); } };
}
