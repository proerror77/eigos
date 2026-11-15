import { z } from 'zod';
import { Conflict } from '../packages/core/identity.js';
import { activityInputSchema, planResultSchema } from '../packages/capabilities/scheduling/contracts.js';
import { actionCallSchema } from '../packages/ontology/invocation.js';
import { objectRefSchema } from '../packages/ontology/schema.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import type { AgentDriver } from '../packages/runtime/agent.js';
import { fixture, principal, route } from './fixture.js';
import { calendarAnswer, planningInput } from './planning-fixture.js';

export const agentEvaluationCases = [
  'didi-ambiguous-place',
  'didi-quote-retry',
  'pa-stale-calendar',
  'pa-scenario-review',
] as const;
export type AgentEvaluationCase = typeof agentEvaluationCases[number];
export type EvaluationInput = { route: typeof route } | { plan: ReturnType<typeof planningInput> };
type Fixture = Awaited<ReturnType<typeof fixture>>;
type ToolCall = { name: string; input: unknown; failed: boolean };
type Check = (id: string, passed: boolean) => void;

const choices = z.object({
  origin: z.array(z.object({ ref: objectRefSchema })).min(2),
  destination: z.array(z.object({ ref: objectRefSchema })).min(2),
});
const paRequest = z.object({
  kind: z.literal('pa-request'),
  capability: z.literal('calendar.freebusy'),
  taskId: z.uuid(),
  requestId: z.uuid(),
  input: z.object({ start: z.string(), end: z.string(), timeZone: z.string() }),
});
const scheduleResult = z.object(planResultSchema.shape);

function captureToolCalls(driver: AgentDriver, calls: ToolCall[]): AgentDriver {
  return {
    model: driver.model,
    run(prompt, tools, signal) {
      return driver.run(prompt, new Map([...tools].map(([name, tool]) => [name, {
        ...tool,
        async invoke(input) {
          const call = { name, input, failed: false };
          calls.push(call);
          try { return await tool.invoke(input); }
          catch (error) { call.failed = true; throw error; }
        },
      }])), signal);
    },
  };
}

function actionsCalled(f: Fixture, calls: ToolCall[]) {
  return calls.flatMap(({ name, input, failed }) => {
    if (name !== 'apply_action' && name !== 'complete_with_action') return [];
    const raw = name === 'apply_action' ? input : (input as { action?: unknown } | null)?.action;
    const call = actionCallSchema.safeParse(raw);
    if (!call.success) return [];
    try {
      const action = f.capabilities.actions.resolve(f.access, f.model, call.data);
      return [{ ...action, scenarioId: call.data.scenarioId, failed }];
    } catch { return []; }
  });
}

async function journal(f: Fixture) {
  const rows = await f.db.query<{ action: string }>(`SELECT action FROM ${f.db.schema}.actions ORDER BY action`);
  return rows.rows.map(row => row.action);
}

async function tableCounts(f: Fixture) {
  const schema = f.db.schema;
  const result = await f.db.query<{ external: number; effects: number; workflows: number; scenarios: number }>(`SELECT
    (SELECT count(*)::int FROM ${schema}.external_operations) AS external,
    (SELECT count(*)::int FROM ${schema}.action_effects) AS effects,
    (SELECT count(*)::int FROM ${schema}.workflows) AS workflows,
    (SELECT count(*)::int FROM ${schema}.scenarios) AS scenarios`);
  return result.rows[0]!;
}

async function ride(f: Fixture, mode: 'ambiguous' | 'retry', calls: ToolCall[], check: Check) {
  f.provider.flags.ambiguous = mode === 'ambiguous';
  const input = { requestId: 'eval-ride', message: `帮我估一下从${route.origin}到${route.destination}在${route.city}打车大概多少钱。只询价。` };
  const task = await f.tasks.submit(principal, input);
  check('worker-executed-task', await f.worker.runOne());
  const done = await f.tasks.get(principal, task.id);
  const graph = new Objects(f.db, f.model, f.access);
  const actionCalls = actionsCalled(f, calls);
  check('published-action-and-route-parameters', actionCalls.some(call => call.action === 'EstimateRide'
    && !call.scenarioId && call.input.city === route.city && call.input.origin === route.origin && call.input.destination === route.destination));
  check('source-lookups-match-both-places', [route.origin, route.destination].every(place =>
    f.provider.calls.some((call, index) => call === 'maps_textsearch'
      && f.provider.inputs[index]?.keywords === place && f.provider.inputs[index]?.city === route.city)));
  const counts = await tableCounts(f);
  check('simple-query-skips-scenario-and-workflow', counts.scenarios === 0 && counts.workflows === 0);
  const requests = (await graph.query({ type: 'RideRequest' })).items;
  const actions = await journal(f);

  if (mode === 'ambiguous') {
    const result = choices.safeParse(done.result);
    check('stopped-for-place-selection', done.state === 'input-required' && result.success);
    if (result.success) {
      const genuine = await Promise.all((['origin', 'destination'] as const).map(async side => {
        const places = await graph.query({ type: 'Location', where: { name: route[side] } });
        const references = new Set(result.data[side].map(item => `${item.ref.type}/${item.ref.id}`));
        return references.size >= 2 && [...references].every(ref => places.items.some(item => `${item.ref.type}/${item.ref.id}` === ref));
      }));
      check('choices-reference-distinct-source-backed-places', genuine.every(Boolean));
    } else check('choices-reference-distinct-source-backed-places', false);
    check('no-quote-or-business-edits', !f.provider.calls.includes('taxi_estimate') && !requests.length
      && !(await graph.query({ type: 'PriceEstimate' })).items.length && !actions.length);
    return done.state;
  }

  const estimates = z.object({ estimates: z.array(z.object({ properties: z.object({ amount: z.string().nullable() }) })) }).safeParse(done.result);
  check('returned-authoritative-price', done.state === 'completed' && estimates.success
    && estimates.data.estimates.some(estimate => estimate.properties.amount === '73.05'));
  check('one-committed-estimate-action', actions.length === 1 && actions[0] === 'EstimateRide' && requests.length === 1);
  const request = requests[0];
  const routes = request ? await graph.follow(request.ref, 'route') : [];
  const routeObject = routes[0];
  const origin = routeObject ? await graph.follow(routeObject.ref, 'origin') : [];
  const destination = routeObject ? await graph.follow(routeObject.ref, 'destination') : [];
  const prices = request ? (await graph.query({ type: 'PriceEstimate', from: { object: request.ref, link: 'estimates' } })).items : [];
  const receipts = await Promise.all(prices.map(price => graph.follow(price.ref, 'source', 'PriceEstimate')));
  check('ride-objects-and-links-match-authoritative-result', routes.length === 1
    && origin.length === 1 && origin[0]?.properties.name === route.origin
    && destination.length === 1 && destination[0]?.properties.name === route.destination
    && prices.length === 2 && prices.some(price => price.properties.amount === '73.05')
    && receipts.every(source => source.length === 1 && source[0]?.ref.type === 'SourceReceipt'));
  const replay = await f.tasks.submit(principal, input);
  check('same-request-reuses-one-task-action-and-quote', replay.id === done.id && replay.state === 'completed'
    && !await f.worker.runOne() && f.provider.calls.filter(call => call === 'taxi_estimate').length === 1
    && (await journal(f)).length === 1);
  return done.state;
}

async function calendar(f: Fixture, input: ReturnType<typeof planningInput>, stale: boolean, calls: ToolCall[], check: Check) {
  const task = await f.tasks.submit(principal, { requestId: 'eval-calendar',
    message: `请为“${input.title}”拟议一个 ${input.durationMinutes} 分钟的会议。只用我个人日历的忙闲时间，窗口从 ${input.start} 到 ${input.end}，时区 ${input.timeZone}。生成可审核的方案给我确认，不要确认或写入日历。` });
  check('worker-executed-task', await f.worker.runOne());
  const waiting = await f.tasks.get(principal, task.id);
  const request = paRequest.safeParse(waiting.result);
  const matchingRequest = waiting.state === 'input-required' && request.success && request.data.taskId === task.id
    && Date.parse(request.data.input.start) === Date.parse(input.start) && Date.parse(request.data.input.end) === Date.parse(input.end)
    && request.data.input.timeZone === input.timeZone;
  check('original-pa-request-with-correct-window', matchingRequest);
  check('plan-action-matches-the-user-window', actionsCalled(f, calls).some(action => action.action === 'PrepareSchedulePlan'
    && action.input.durationMinutes === input.durationMinutes && action.input.timeZone === input.timeZone
    && Date.parse(String(action.input.start)) === Date.parse(input.start) && Date.parse(String(action.input.end)) === Date.parse(input.end)));
  if (!matchingRequest) return waiting.state;

  const base = calendarAnswer({ ...input, ...request.data.input });
  const response = stale ? {
    ...base, observedAt: new Date(Date.now() - 180_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString(),
  } : base;
  const callCount = calls.length;
  await new PARequests(f.tasks).respond(principal, task.id, { requestId: request.data.requestId, response });
  check('worker-resumed-original-task', await f.worker.runOne());
  const done = await f.tasks.get(principal, task.id);
  const graph = new Objects(f.db, f.model, f.access);
  const plans = (await graph.query({ type: 'SchedulePlan' })).items;
  const activities = (await graph.query({ type: 'ScheduledActivity' })).items;
  const actions = await journal(f);
  if (stale) {
    check('planning-action-rejected-stale-data', actionsCalled(f, calls.slice(callCount))
      .some(action => action.action === 'PrepareSchedulePlan' && action.failed));
    check('expired-data-cannot-produce-a-plan', ['failed', 'input-required'].includes(done.state)
      && !plans.length && !activities.length && !(await graph.query({ type: 'CalendarAvailability' })).items.length
      && !actions.length && (await tableCounts(f)).scenarios === 0);
    return done.state;
  }

  const result = scheduleResult.safeParse(done.result);
  const plan = plans[0];
  check('prepared-plan-stops-before-formal-commit', done.state === 'completed' && plans.length === 1
    && plan?.properties.state === 'prepared' && !activities.length && actions.length === 1 && actions[0] === 'PrepareSchedulePlan');
  check('verified-result-points-to-an-open-proposal', result.success && Boolean(result.data.scenarioId) && result.data.validation.valid
    && result.data.validation.calendarEvidence.length === 1 && result.data.validation.calendarEvidence[0]?.evidence === 'synthetic'
    && result.data.plan.ref.id === plan?.ref.id && !result.data.externalCalendarUpdated);
  if (!result.success || !result.data.scenarioId || !plan) return done.state;

  const scenarios = new Scenarios(f.db);
  const proposal = await scenarios.inspect(f.access, f.model, result.data.scenarioId);
  const proposedActivities = proposal.objects.filter(item => item.ref.type === 'ScheduledActivity' && item.after);
  const activity = proposedActivities[0];
  const start = Date.parse(String(activity?.after?.start)), end = Date.parse(String(activity?.after?.end));
  const resource = (await graph.follow(plan.ref, 'resources'))[0];
  check('proposed-activity-and-plan-resource-links', proposal.state === 'open' && proposedActivities.length === 1
    && result.data.activities.length === 1 && activity?.ref.id === result.data.activities[0]?.ref.id
    && proposal.links.some(link => !link.removed && link.type === 'ActivityPlan' && link.from.id === activity?.ref.id && link.to.id === plan.ref.id)
    && proposal.links.some(link => !link.removed && link.type === 'ActivityResource' && link.from.id === activity?.ref.id && link.to.id === resource?.ref.id));
  check('proposal-fits-calendar-and-user-duration', start >= Date.parse(input.start) && end <= Date.parse(input.end)
    && end - start === input.durationMinutes * 60_000
    && response.busy.every(span => end <= Date.parse(span.start) || start >= Date.parse(span.end)));
  check('staged-action-parameters-match-the-reviewed-delta', actionsCalled(f, calls).some(call => {
    if (call.failed || call.action !== 'SaveScheduleActivity' || call.scenarioId !== proposal.id) return false;
    const args = activityInputSchema.safeParse(call.input);
    return args.success && args.data.plan.id === plan.ref.id && Date.parse(args.data.start) === start && Date.parse(args.data.end) === end;
  }));

  const snapshot = (await graph.query({ type: 'CalendarAvailability' })).items[0];
  if (!snapshot) check('expired-calendar-blocks-later-merge', false);
  else {
    // Simulate expiry after the reviewed proposal without changing the process clock.
    await graph.edit(snapshot.ref, snapshot.revision, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const rejected = await f.capabilities.actions.apply(f.access, f.model, 'CommitSchedulePlan',
      { plan: plan.ref, scenarioId: proposal.id, revision: proposal.revision }, 'eval-late-approval')
      .then(() => false, (error: unknown) => error instanceof Conflict && /calendar.*stale/i.test(error.message));
    check('expired-calendar-blocks-later-merge', rejected && (await scenarios.inspect(f.access, f.model, proposal.id)).state === 'open'
      && !(await graph.query({ type: 'ScheduledActivity' })).items.length && !(await journal(f)).includes('CommitSchedulePlan'));
  }
  return done.state;
}

export async function evaluateAgentCase(name: AgentEvaluationCase, driverFor: (input: EvaluationInput) => AgentDriver) {
  const input = name === 'didi-ambiguous-place' || name === 'didi-quote-retry' ? { route } : { plan: planningInput() };
  const driver = driverFor(input);
  const calls: ToolCall[] = [];
  const f = await fixture(captureToolCalls(driver, calls), undefined, async () => { throw new Error('Stripe is unavailable in Agent evaluations'); });
  const checks: { id: string; passed: boolean }[] = [];
  const check: Check = (id, passed) => { checks.push({ id, passed }); };
  try {
    const state = 'route' in input
      ? await ride(f, name === 'didi-ambiguous-place' ? 'ambiguous' : 'retry', calls, check)
      : await calendar(f, input.plan, name === 'pa-stale-calendar', calls, check);
    const counts = await tableCounts(f);
    check('no-external-mutations-or-side-effects', counts.external === 0 && counts.effects === 0 && f.provider.flags.orderCreates === 0
      && ('route' in input || !f.provider.calls.length));
    return { case: name, model: driver.model, definition: f.model.digest, release: f.model.release, state,
      checks, passed: checks.every(item => item.passed) };
  } finally { await f.close(); }
}
