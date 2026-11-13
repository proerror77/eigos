import { z } from 'zod';
import { Conflict, NotFound, digest, requireScope, type Principal } from '../core/identity.js';
import { objectRefSchema, type ObjectRef } from '../ontology/schema.js';
import { hotelSearchInput } from '../ontology/service-contracts.js';
import { activityInputSchema, planInputSchema, planResultSchema } from '../capabilities/scheduling/contracts.js';
import { Access, type Requirement } from './access.js';
import type { AgentTool } from './agent.js';
import type { Database, Sql } from './database.js';
import type { Functions } from './functions.js';
import type { Metadata, PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';
import { Scenarios } from './scenarios.js';
import { lockEdits } from './scenario-store.js';

const objects = z.object({
  ref: objectRefSchema,
  revision: z.number().int().positive(),
  properties: z.record(z.string(), z.unknown()),
});
const positiveSeconds = z.number().int().positive();
const routeSchema = z.object({
  travel: objects.extend({
    properties: z.object({ durationSeconds: positiveSeconds, distanceMeters: z.number().nonnegative() }).passthrough(),
  }),
  origin: objects,
  destination: objects,
});
const hotelSchema = objects.extend({
  properties: z
    .object({
      nativeId: z.string().min(1),
      name: z.string(),
      address: z.string(),
      checkIn: z.iso.date(),
      amount: z.number().nonnegative().nullable(),
      currency: z.string(),
      bindingId: z.string(),
    })
    .passthrough(),
});
const placeRead = z.object({ city: z.string().min(1).max(100), keywords: z.string().min(1).max(500) });
const source = z.object({ source: z.literal('DidiPlaces'), input: placeRead });
const windowOffsets = z
  .strictObject({
    startOffset: z.number().int().min(0).max(1439),
    endOffset: z.number().int().min(1).max(1440),
  })
  .refine((window) => window.endOffset > window.startOffset, 'Planning window must have positive length');
const pathSchema = z.array(z.union([z.string().max(100), z.number().int().min(0).max(1000)])).max(20);
const valueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('literal'), value: z.unknown() }),
  z.strictObject({ kind: z.literal('checkIn') }),
  z.strictObject({ kind: z.literal('datedText'), template: z.string().max(2000) }),
  z.strictObject({ kind: z.literal('dateTime'), offsetMinutes: z.number().int().min(0).max(1440) }),
  z.strictObject({ kind: z.literal('result'), step: z.number().int().min(0).max(39), path: pathSchema }),
  z.strictObject({
    kind: z.literal('objectResult'),
    step: z.number().int().min(0).max(39),
    path: pathSchema,
    type: z.string(),
    identity: z.union([z.strictObject({ nativeId: z.string() }), z.strictObject({ id: z.string() })]),
  }),
  z.strictObject({ kind: z.literal('record'), entries: z.record(z.string(), z.unknown()) }),
  z.strictObject({ kind: z.literal('array'), items: z.array(z.unknown()) }),
  z.strictObject({
    kind: z.literal('slotTime'),
    step: z.number().int().min(0).max(39),
    offsetMinutes: z.number().int().min(0).max(1440),
  }),
]);
type ReplayValue = z.infer<typeof valueSchema>;
const replayStepSchema = z.strictObject({
  tool: z.enum([
    'apply_action',
    'query_ontology',
    'follow_links',
    'refresh_sources',
    'evaluate_function',
    'create_scenario',
    'inspect_scenario',
    'complete_with_function',
    'complete_with_action',
  ]),
  input: valueSchema,
});
const recipeSchema = z.strictObject({
  kind: z.literal('learned-hotel-itinerary'),
  version: z.literal(1),
  definition: z.string(),
  hotelNativeId: z.string().min(1).max(500),
  bindingId: z.string().min(1).max(200),
  window: windowOffsets,
  steps: z.array(replayStepSchema).min(6).max(40),
});
type Recipe = z.infer<typeof recipeSchema>;
const reviewSchema = z.strictObject({
  kind: z.literal('hotel-itinerary-simulation'),
  status: z.enum(['awaiting_approval', 'simulated']),
  scenarioId: z.uuid(),
  revision: z.number().int().positive(),
  plan: objectRefSchema,
  hotel: objectRefSchema,
  travel: objectRefSchema,
  snapshot: z.string(),
  recipe: recipeSchema,
  workflowId: z.uuid().nullable(),
  checkIn: z.iso.date(),
  receipt: z
    .object({
      approvedBy: z.string(),
      approvedAt: z.iso.datetime(),
      mode: z.literal('synthetic'),
      executed: z.literal(false),
      bookable: z.literal(false),
      estimatedArrival: z.iso.datetime(),
      slackSeconds: z.number().int().nonnegative(),
    })
    .optional(),
});
export const workflowReplaySchema = z.strictObject({ workflowId: z.uuid(), checkIn: z.iso.date() });
export const hotelApprovalSchema = z.strictObject({
  taskId: z.uuid(),
  scenarioId: z.uuid(),
  revision: z.number().int().positive(),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.literal('approve-simulation'),
});

const actionBindings = {
  PrepareSchedulePlan: { type: 'SchedulablePlan', action: 'prepare', implementation: 'SchedulePlan' },
  SearchRollingGoHotels: { type: 'HotelSearch', action: 'search', implementation: 'RollingGoHotelSearch' },
  ObserveDidiDrivingTime: { type: 'DrivingEstimate', action: 'observe', implementation: 'DidiDrivingEstimate' },
  AttachPlanService: { type: 'HotelOffer', action: 'select' },
};
const safeActions = new Set([...Object.keys(actionBindings), 'SaveScheduleActivity']);
const safeFunctions = new Set([
  'findScheduleSlots',
  'validateSchedule',
  'readSchedulePlan',
  'readServiceSearch',
  'readServiceOffering',
  'evaluateServiceOffering',
  'readDrivingEstimate',
]);
export function checkHotelWorkflowTool(tool: string, input: unknown) {
  if (tool === 'evaluate_function' || tool === 'complete_with_function' || tool === 'complete_with_action') {
    const read = z
      .object({ function: z.string() })
      .parse(tool === 'complete_with_action' ? z.object({ read: z.unknown() }).parse(input).read : input);
    if (!safeFunctions.has(read.function)) throw new Conflict('Hotel workflow only permits itinerary reads');
  }
  if (tool === 'refresh_sources') z.object({ sources: z.array(source) }).parse(input);
  if (tool === 'save_object_set' || tool === 'discard_scenario')
    throw new Conflict('This task only creates an itinerary proposal');
  if (tool === 'create_scenario' && z.object({ kind: z.string() }).parse(input).kind !== 'persisted') {
    throw new Conflict('This task requires a persisted Scenario');
  }
}
export function checkHotelWorkflowAction(action: string, model: PublishedOntology, scenario?: string) {
  if (
    !safeActions.has(action) ||
    model.action(action).effects?.length ||
    Boolean(scenario) !== ['AttachPlanService', 'SaveScheduleActivity'].includes(action)
  ) {
    throw new Conflict('This task only permits itinerary proposal actions');
  }
}

export interface HotelWorkflowTrace {
  events: Array<{ tool: string; input: unknown; output: unknown }>;
  actions: Array<{ action: string; input: Record<string, unknown>; scenarioId?: string; output: ObjectRef }>;
  locations: Array<{ input: unknown; output: unknown }>;
  reads: Array<{ function: string; output: unknown }>;
}
const minute = 60_000;
const midnight = (day: string) => Date.parse(day + 'T00:00:00+08:00');

function atPath(output: unknown, path: Array<string | number>) {
  let value = output;
  for (const key of path) {
    if (typeof key === 'string' && ['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Conflict('Workflow path is unavailable');
    }
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      throw new Conflict('A prior workflow result is unavailable');
    }
    value = Reflect.get(value, key);
  }
  return value;
}

function dateText(text: string, day: string) {
  const [year, month, date] = day.split('-').map(Number);
  return text
    .replaceAll(day, '{{checkIn}}')
    .replaceAll(year + '年' + month + '月' + date + '日', '{{year}}年{{month}}月{{day}}日')
    .replaceAll(month + '月' + date + '日', '{{month}}月{{day}}日');
}

function renderDateText(text: string, day: string) {
  const [year, month, date] = day.split('-').map(Number);
  return text
    .replaceAll('{{checkIn}}', day)
    .replaceAll('{{year}}', String(year))
    .replaceAll('{{month}}', String(month))
    .replaceAll('{{day}}', String(date));
}

function compileSteps(events: HotelWorkflowTrace['events'], checkIn: string, title: string) {
  const relevant = events.filter((event) => replayStepSchema.shape.tool.safeParse(event.tool).success);
  const steps: z.infer<typeof replayStepSchema>[] = [];
  const prior: Array<{ step: number; path: Array<string | number>; value: unknown }> = [];
  const walk = (value: unknown, step: number, path: Array<string | number>) => {
    prior.push({ value, step, path });
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        walk(child, step, [...path, Array.isArray(value) ? Number(key) : key]);
      }
    }
  };
  const bind = (value: unknown): ReplayValue => {
    const ref = objectRefSchema.safeParse(value);
    if (ref.success) {
      for (const previous of [...prior].reverse()) {
        const parsed = objectRefSchema.safeParse(previous.value);
        if (!parsed.success || digest(parsed.data) !== digest(ref.data)) continue;
        const last = previous.path.at(-1);
        const objectPath = last === 'ref' ? previous.path.slice(0, -1) : previous.path;
        const entry = prior.find((item) => item.step === previous.step && digest(item.path) === digest(objectPath));
        const observed = objects.safeParse(entry?.value);
        if (last === 'ref' && observed.success) {
          const pageIndex = objectPath.at(-1);
          if (typeof pageIndex === 'number') {
            return {
              kind: 'objectResult',
              step: previous.step,
              path: objectPath.slice(0, -1),
              type: ref.data.type,
              identity:
                typeof observed.data.properties.nativeId === 'string'
                  ? { nativeId: observed.data.properties.nativeId }
                  : { id: ref.data.id },
            };
          }
        }
        if (typeof last === 'number') {
          return {
            kind: 'objectResult',
            step: previous.step,
            path: previous.path.slice(0, -1),
            type: ref.data.type,
            identity: { id: ref.data.id },
          };
        }
        return { kind: 'result', step: previous.step, path: previous.path };
      }
      throw new Conflict('Reusable workflows must obtain object references from their own successful steps');
    }
    if (typeof value === 'string') {
      const previous = [...prior]
        .reverse()
        .find((item) => item.value === value && (item.path.at(-1) === 'id' || item.path.includes('slots')));
      if (previous) return { kind: 'result', step: previous.step, path: previous.path };
      if (value === checkIn) return { kind: 'checkIn' };
      if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return valueSchema.parse({ kind: 'dateTime', offsetMinutes: (Date.parse(value) - midnight(checkIn)) / minute });
      }
      const template = dateText(value, checkIn);
      if (template !== value) return { kind: 'datedText', template };
    }
    if (Array.isArray(value)) return { kind: 'array', items: value.map(bind) };
    if (value && typeof value === 'object') {
      return {
        kind: 'record',
        entries: Object.fromEntries(
          Object.entries(value)
            .filter(([, child]) => child !== undefined)
            .map(([key, child]) => [key, bind(child)]),
        ),
      };
    }
    return { kind: 'literal', value };
  };
  for (const event of relevant) {
    const action = z
      .object({ action: z.string().optional(), input: z.record(z.string(), z.unknown()).optional() })
      .safeParse(event.input);
    const binding = bind(event.input);
    if (event.tool === 'apply_action' && action.success && action.data.action === 'SaveScheduleActivity') {
      const data = activityInputSchema.parse(action.data.input);
      const slot = [...prior]
        .reverse()
        .find(
          (item) =>
            item.path.at(-1) === 'slots' && z.array(z.object({ start: z.string() })).safeParse(item.value).success,
        );
      const slots = slot ? z.array(z.object({ start: z.string() })).parse(slot.value) : [];
      if (!slot || !slots[0] || Date.parse(slots[0].start) !== Date.parse(data.start) || binding.kind !== 'record') {
        throw new Conflict('Reusable travel timing must come from the first validated available slot');
      }
      const input = valueSchema.parse(binding.entries.input);
      if (input.kind !== 'record') throw new Conflict('Expected activity input bindings');
      input.entries.name = { kind: 'datedText', template: dateText(title, checkIn) };
      input.entries.start = { kind: 'slotTime', step: slot.step, offsetMinutes: 0 };
      input.entries.end = {
        kind: 'slotTime',
        step: slot.step,
        offsetMinutes: (Date.parse(data.end) - Date.parse(data.start)) / minute,
      };
      binding.entries.input = input;
    }
    steps.push(replayStepSchema.parse({ tool: event.tool, input: binding }));
    walk(event.output, steps.length - 1, []);
  }
  return steps;
}

function compile(
  model: PublishedOntology,
  trace: HotelWorkflowTrace,
  result: z.infer<typeof planResultSchema>,
  hotel: z.infer<typeof hotelSchema>,
  sourcePageId: string,
) {
  const findAction = (name: string, matches: (item: HotelWorkflowTrace['actions'][number]) => boolean) =>
    trace.actions.find((item) => item.action === name && matches(item));
  const plan = findAction('PrepareSchedulePlan', (item) => item.output.id === result.plan.ref.id);
  const selection = findAction(
    'AttachPlanService',
    (item) =>
      item.scenarioId === result.scenarioId &&
      digest(item.input.service) === digest(hotel.ref) &&
      digest(item.input.plan) === digest(result.plan.ref),
  );
  const activity = findAction(
    'SaveScheduleActivity',
    (item) => item.scenarioId === result.scenarioId && digest(item.output) === digest(result.activities[0]?.ref),
  );
  const search = findAction('SearchRollingGoHotels', (item) => item.output.id === sourcePageId);
  const driving = [
    ...new Map(
      trace.reads
        .filter((item) => item.function === 'readDrivingEstimate')
        .map((item) => routeSchema.parse(item.output))
        .map((item) => [item.travel.ref.id, item]),
    ).values(),
  ];
  if (
    !plan ||
    !selection ||
    !activity ||
    !search ||
    driving.length !== 1 ||
    result.activities.length !== 1 ||
    !findAction('ObserveDidiDrivingTime', (item) => item.output.id === driving[0]!.travel.ref.id)
  ) {
    throw new Conflict('A reusable workflow needs a verified hotel, route, calendar and one travel activity');
  }
  const route = driving[0]!;
  const placeFor = (ref: ObjectRef) => {
    const found = trace.locations.find((item) =>
      z
        .object({ objects: z.array(objectRefSchema) })
        .parse(item.output)
        .objects.some((candidate) => digest(candidate) === digest(ref)),
    );
    if (!found) throw new Conflict('Route endpoints must come from this task’s location lookup');
    placeRead.parse(found.input);
  };
  placeFor(route.origin.ref);
  placeFor(route.destination.ref);
  const input = planInputSchema.parse(plan.input);
  const { checkIn } = hotelSearchInput.parse(search.input);
  const travel = activityInputSchema.parse(activity.input);
  if (
    digest(travel.plan) !== digest(result.plan.ref) ||
    travel.predecessors.length ||
    travel.activity ||
    input.durationMinutes < (Date.parse(travel.end) - Date.parse(travel.start)) / minute
  ) {
    throw new Conflict('Only a single independent travel slot can be learned');
  }
  if (
    input.timeZone !== 'Asia/Shanghai' ||
    input.plan ||
    input.scenarioId ||
    checkIn !== hotel.properties.checkIn ||
    Date.parse(input.start) < midnight(checkIn) ||
    Date.parse(input.end) > midnight(checkIn) + 86_400_000
  ) {
    throw new Conflict('Workflow learning currently supports one Shanghai planning window on the check-in date');
  }
  return recipeSchema.parse({
    kind: 'learned-hotel-itinerary',
    version: 1,
    definition: model.digest,
    hotelNativeId: hotel.properties.nativeId,
    bindingId: hotel.properties.bindingId,
    window: {
      startOffset: (Date.parse(input.start) - midnight(checkIn)) / minute,
      endOffset: (Date.parse(input.end) - midnight(checkIn)) / minute,
    },
    steps: compileSteps(trace.events, checkIn, input.title),
  });
}

export async function replayHotelWorkflow(tools: ReadonlyMap<string, AgentTool>, recipe: Recipe, checkIn: string) {
  if (midnight(checkIn) + recipe.window.startOffset * minute <= Date.now())
    throw new Conflict('Choose a future itinerary date');
  const results: unknown[] = [];
  const resolve = (raw: unknown): unknown => {
    const value = valueSchema.parse(raw);
    if (value.kind === 'literal') return value.value;
    if (value.kind === 'checkIn') return checkIn;
    if (value.kind === 'datedText') return renderDateText(value.template, checkIn);
    if (value.kind === 'dateTime') return new Date(midnight(checkIn) + value.offsetMinutes * minute).toISOString();
    if (value.kind === 'array') return value.items.map(resolve);
    if (value.kind === 'record')
      return Object.fromEntries(Object.entries(value.entries).map(([key, item]) => [key, resolve(item)]));
    if (value.step >= results.length)
      throw new Conflict('Workflow result binding must reference a completed prior step');
    const output = results[value.step];
    if (value.kind === 'result') return atPath(output, value.path);
    if (value.kind === 'slotTime') {
      const slots = z
        .object({ slots: z.array(z.object({ start: z.iso.datetime({ offset: true }) })) })
        .parse(output).slots;
      if (!slots[0]) throw new Conflict('No available travel slot for the new date');
      return new Date(Date.parse(slots[0].start) + value.offsetMinutes * minute).toISOString();
    }
    const candidates = z.array(z.unknown()).parse(atPath(output, value.path));
    const matches = candidates.flatMap((candidate) => {
      const full = objects.safeParse(candidate);
      const reference = full.success ? full.data.ref : objectRefSchema.parse(candidate);
      const identity =
        'nativeId' in value.identity
          ? full.success && full.data.properties.nativeId === value.identity.nativeId
          : reference.id === value.identity.id;
      return identity && reference.type === value.type ? [reference] : [];
    });
    if (matches.length !== 1) throw new Conflict('A saved workflow object could not be uniquely refreshed');
    return matches[0]!;
  };
  for (const step of recipe.steps) {
    const tool = tools.get(step.tool);
    if (!tool) throw new Conflict('A learned workflow tool is unavailable');
    const output = await tool.invoke(resolve(step.input));
    results.push(output);
    if (z.object({ waitingForPA: z.literal(true) }).safeParse(output).success) return;
  }
}

export class HotelWorkflows {
  constructor(
    private readonly db: Database,
    private readonly metadata: Metadata,
    private readonly functions: Functions,
  ) {}

  async load(model: PublishedOntology, owner: string, id: string, client?: Sql) {
    const row = (
      await this.db.query(
        `SELECT body FROM ${this.db.schema}.workflows WHERE id=$1 AND owner=$2 AND ontology=$3 AND body->>'kind'='learned-hotel-itinerary'`,
        [id, owner, model.document.id],
        client,
      )
    ).rows[0];
    if (!row) throw new NotFound('Learned workflow is unavailable');
    const recipe = recipeSchema.parse(row.body);
    if (recipe.definition !== model.digest) throw new Conflict('Ontology changed; learn this workflow again');
    return recipe;
  }

  private async readInputs(
    model: PublishedOntology,
    access: Access,
    plan: ObjectRef,
    hotel: ObjectRef,
    travel: ObjectRef,
    signal: AbortSignal,
    client?: Sql,
  ) {
    const objects = new Objects(this.db, model, access, client);
    const context = { objects, principal: access.principal, signal };
    const result = planResultSchema.parse(await this.functions.invoke(model, 'readSchedulePlan', { plan }, context));
    const offer = hotelSchema.parse(
      await this.functions.invoke(model, 'readServiceOffering', { service: hotel }, context),
    );
    const route = routeSchema.parse(await this.functions.invoke(model, 'readDrivingEstimate', { travel }, context));
    const linked = await objects.query({
      type: 'SchedulePlan',
      from: { object: hotel, as: 'HotelOffer', link: 'plans' },
    });
    if (
      !result.validation.valid ||
      !model.implements(offer.ref.type, 'HotelOffer') ||
      result.activities.length !== 1 ||
      !linked.items.some((item) => digest(item.ref) === digest(plan))
    ) {
      throw new Conflict('The hotel itinerary proposal does not pass validation');
    }
    const activity = activityInputSchema.pick({ start: true, end: true }).parse({
      start: result.activities[0]!.properties.start,
      end: result.activities[0]!.properties.end,
    });
    if (
      Date.parse(activity.start) < Date.now() ||
      Date.parse(activity.end) - Date.parse(activity.start) < route.travel.properties.durationSeconds * 1000
    ) {
      throw new Conflict('The proposed travel slot does not fit the current route');
    }
    const snapshot = digest([result.plan, result.activities, result.validation.calendarEvidence, offer, route]);
    return { result, offer, route, snapshot, activity };
  }

  async prepare(
    model: PublishedOntology,
    access: Access,
    trace: HotelWorkflowTrace,
    output: unknown,
    signal: AbortSignal,
    replay?: { id: string; recipe: Recipe; checkIn: string },
  ) {
    const result = planResultSchema.parse(output);
    if (!result.scenarioId) throw new Conflict('A hotel itinerary must be a Scenario before approval');
    const selections = [...new Map(trace.actions.filter(
      step => step.action === 'AttachPlanService' &&
        step.scenarioId === result.scenarioId && step.output.id === result.plan.ref.id,
    ).map(step => [digest([step.scenarioId, step.input, step.output]), step])).values()];
    const reads = [
      ...new Map(
        trace.reads
          .filter((step) => step.function === 'readDrivingEstimate')
          .map((step) => [routeSchema.parse(step.output).travel.ref.id, step]),
      ).values(),
    ];
    if (selections.length !== 1 || reads.length !== 1)
      throw new Conflict('Review requires one hotel and one verified driving route');
    const hotel = objectRefSchema.parse(selections[0]!.input.service);
    const travel = routeSchema.parse(reads[0]!.output).travel.ref;
    const scenarios = new Scenarios(this.db);
    const view = await scenarios.view(access, model, result.scenarioId);
    const current = await this.readInputs(view, access, result.plan.ref, hotel, travel, signal);
    const source = await new Objects(this.db, view, access).follow(hotel, 'source', 'ServiceOffering');
    const sourcePageId = source.length === 1 ? source[0]!.ref.id : undefined;
    if (!sourcePageId) throw new Conflict('The hotel source is unavailable');
    const recipe = replay?.recipe ?? compile(model, trace, current.result, current.offer, sourcePageId);
    if (
      recipe.hotelNativeId !== current.offer.properties.nativeId ||
      recipe.bindingId !== current.offer.properties.bindingId ||
      (replay && replay.checkIn !== current.offer.properties.checkIn)
    ) {
      throw new Conflict('The hotel identity or date differs from the workflow');
    }
    const inspected = await scenarios.inspect(access, model, result.scenarioId);
    await new Objects(this.db, model, access).read({ type: 'OntologyScenario', id: result.scenarioId });
    const hotelLinks = inspected.links.filter((item) => model.implements(item.from.type, 'HotelOffer'));
    if (
      [...inspected.objects, ...inspected.links].some((item) => item.conflict) ||
      hotelLinks.length !== 1 ||
      hotelLinks[0]!.removed ||
      digest(hotelLinks[0]!.from) !== digest(hotel) ||
      digest(hotelLinks[0]!.to) !== digest(result.plan.ref)
    ) {
      throw new Conflict('The proposal must contain one conflict-free hotel selection');
    }
    return {
      ...current.result,
      hotel: current.offer,
      route: current.route,
      hotelWorkflow: reviewSchema.parse({
        kind: 'hotel-itinerary-simulation',
        status: 'awaiting_approval',
        scenarioId: result.scenarioId,
        revision: inspected.revision,
        plan: result.plan.ref,
        hotel,
        travel,
        snapshot: current.snapshot,
        recipe,
        workflowId: replay?.id ?? null,
        checkIn: current.offer.properties.checkIn,
      }),
    };
  }

  async approve(principal: Principal, raw: unknown) {
    requireScope(principal, 'tasks:read');
    requireScope(principal, 'ontology:write');
    const input = hotelApprovalSchema.parse(raw),
      signal = AbortSignal.timeout(20_000);
    return this.db.transaction(async (client) => {
      const row = (
        await this.db.query(
          `SELECT release,result,result_permissions FROM ${this.db.schema}.tasks
        WHERE id=$1 AND owner=$2 AND state='completed' FOR UPDATE`,
          [input.taskId, principal.owner],
          client,
        )
      ).rows[0];
      const parsed = reviewSchema.safeParse(row?.result?.hotelWorkflow);
      if (!parsed.success) throw new NotFound('This task has no hotel itinerary to approve');
      const review = parsed.data;
      const access = await Access.load(this.db, principal, client);
      const permissions = row!.result_permissions as Requirement[] | null;
      if (!permissions || !(await access.canReturn(permissions, client)))
        throw new Conflict('Task result access changed');
      if (
        review.scenarioId !== input.scenarioId ||
        review.revision !== input.revision ||
        review.snapshot !== input.snapshot
      ) {
        throw new Conflict('Approval must reference the reviewed Scenario revision and snapshot');
      }
      const model = await this.metadata.active('Eigos', client);
      await lockEdits(this.db, model, principal.owner, client);
      access.action(model, 'CommitSchedulePlan');
      if (model.release !== row!.release) throw new Conflict('The active Ontology changed since review');
      if (review.status === 'simulated') return publicHotelReview(review);
      const view = await new Scenarios(this.db).view(access, model, review.scenarioId, client);
      const scenario = (
        await this.db.query(
          `SELECT revision,kind FROM ${this.db.schema}.scenarios WHERE id=$1 AND owner=$2 FOR UPDATE`,
          [review.scenarioId, principal.owner],
          client,
        )
      ).rows[0];
      if (Number(scenario?.revision) !== review.revision || scenario?.kind !== 'persisted')
        throw new Conflict('Scenario changed since review');
      const current = await this.readInputs(view, access, review.plan, review.hotel, review.travel, signal, client);
      if (current.snapshot !== review.snapshot)
        throw new Conflict('Hotel, route or calendar evidence changed since review');
      const workflowId = review.workflowId ?? input.taskId;
      if (review.workflowId) await this.load(model, principal.owner, review.workflowId, client);
      else
        await this.db.query(
          `INSERT INTO ${this.db.schema}.workflows(id,owner,ontology,name,body,revision)
        VALUES($1,$2,$3,$4,$5,1)`,
          [workflowId, principal.owner, model.document.id, '酒店行程 · ' + current.offer.properties.name, review.recipe],
          client,
        );
      const estimatedArrival =
        Date.parse(current.activity.start) + current.route.travel.properties.durationSeconds * 1000;
      const approved = reviewSchema.parse({
        ...review,
        workflowId,
        status: 'simulated',
        receipt: {
          approvedBy: principal.owner,
          approvedAt: new Date().toISOString(),
          mode: 'synthetic',
          executed: false,
          bookable: false,
          estimatedArrival: new Date(estimatedArrival).toISOString(),
          slackSeconds: Math.floor((Date.parse(current.activity.end) - estimatedArrival) / 1000),
        },
      });
      signal.throwIfAborted();
      await access.refresh(client);
      await this.db.query(
        `UPDATE ${this.db.schema}.tasks SET result=jsonb_set(result,'{hotelWorkflow}',$2::jsonb),updated_at=now()
        WHERE id=$1`,
        [input.taskId, JSON.stringify(approved)],
        client,
      );
      return publicHotelReview(approved);
    });
  }

  async list(principal: Principal) {
    requireScope(principal, 'tasks:read');
    const model = await this.metadata.active('Eigos');
    const access = await Access.load(this.db, principal);
    access.require(model.document.id, 'view_definition', model.document.id);
    access.source(model, 'RollingGo');
    const { rows } = await this.db.query(
      `SELECT id,name FROM ${this.db.schema}.workflows
      WHERE owner=$1 AND ontology=$2 AND body->>'kind'='learned-hotel-itinerary' AND body->>'definition'=$3
      ORDER BY id LIMIT 100`,
      [principal.owner, model.document.id, model.digest],
    );
    return { items: rows };
  }
}

function publicHotelReview(review: z.infer<typeof reviewSchema>) {
  const { recipe: _recipe, ...publicReview } = review;
  return publicReview;
}

export function publicHotelTaskResult(result: unknown): unknown {
  if (result && typeof result === 'object' && 'hotelWorkflow' in result) {
    const review = reviewSchema.safeParse(result.hotelWorkflow);
    if (review.success) return { ...result, hotelWorkflow: publicHotelReview(review.data) };
  }
  return result;
}
