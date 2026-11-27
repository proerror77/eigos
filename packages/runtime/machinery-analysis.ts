import { z } from 'zod';
import { Conflict, PermissionDenied, digest } from '../core/identity.js';
import { processLogTarget, validateMachineryModel, type MachineryModel, type ProcessLogTarget } from '../ontology/process-definition.js';
import { machineryEdgeSchema, machineryModelSchema, objectRefSchema, ontologyName, type ObjectRef } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { Database, Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';
import { ObjectSets } from './object-sets.js';
import { Objects } from './objects.js';
import { processLogTables } from './process-logs.js';

const state = z.string().min(1).max(200);
const milliseconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const machineryAnalysisSchema = z.strictObject({
  type: ontologyName,
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  object: objectRefSchema.optional(),
  setId: z.uuid().optional(),
  externalSource: ontologyName.optional(),
  eventLimit: z.number().int().min(1).max(100000).default(20000),
  focus: z.strictObject({ parent: objectRefSchema, type: ontologyName, link: ontologyName }).optional(),
  reference: machineryModelSchema.optional(),
  candidate: machineryModelSchema.optional(),
  includeIdle: z.boolean().default(true),
  durationClock: z.enum(['recordedAt', 'observedAt']).default('recordedAt'),
  mining: z.strictObject({
    minCases: z.number().int().positive().max(20000).default(1),
    coveragePercent: z.number().int().min(1).max(100).default(100),
    exclude: z.array(machineryEdgeSchema).max(500).default([]),
  }).optional(),
  // One of Palantir's four views: ever or current counts, and historical or current durations, per node and edge.
  view: z.strictObject({ kind: z.enum(['count', 'duration']), scope: z.enum(['historical', 'current']) }).optional(),
  filter: z.strictObject({
    state: state.optional(),
    current: z.boolean().default(false),
    edge: machineryEdgeSchema.optional(),
    // Processes currently in one of these states with `current`, otherwise ever in one of them.
    states: z.array(state).min(1).max(200).optional(),
    // Processes that ever went through one of these transitions, or whose last transition is one of them.
    edges: z.array(machineryEdgeSchema).min(1).max(500).optional(),
    edgeMode: z.enum(['through', 'last']).default('through'),
    path: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    conformance: z.enum(['conforming', 'deviation', 'unknown']).optional(),
    duration: z.strictObject({ state, minMs: milliseconds.default(0), maxExclusiveMs: milliseconds.optional() }).optional(),
  }).optional(),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(100).default(25),
});

type Input = z.output<typeof machineryAnalysisSchema>;
type Event = {
  caseId: string; id: string; from: string | null; to: string | null; recordedAt: string;
  timestamp: string | null; action: string | null; source: string | null; taskId: string | null;
  requestId: string | null; prior: boolean;
};
type Episode = { state: string; durationMs: number | null; open: boolean; clipped: boolean };
type Conformance = 'deviation' | 'conforming' | 'unknown';
type ProcessCase = {
  object: ObjectRef; states: string[]; path: string; partial: boolean;
  current: string | null; conformance: Conformance; episodes: Episode[]; events: Event[];
};
const edgeKey = (from: string | null, to: string | null) => JSON.stringify([from, to]);
const maxWindowMs = 366 * 86400000;

function targetFor(model: PublishedOntology, type: string) {
  const target = processLogTarget(model, type);
  if (!target) throw new Conflict('Select a published concrete ProcessLog type');
  return target;
}

function linkVisible(access: Access, model: PublishedOntology, target: ProcessLogTarget, link: string) {
  const nav = model.navigation(target.objectType, link);
  return access.canDefine(model, 'link', nav.link)
    && access.canSeeModelData(model.links.get(nav.link)?.classification)
    && access.canRead(model, nav.target);
}

function readableModel(access: Access, model: PublishedOntology, target: ProcessLogTarget, reference?: MachineryModel) {
  if (!reference) return null;
  return {
    states: reference.states,
    transitions: reference.transitions.map(({ action, ...edge }) => ({
      ...edge,
      ...(action && access.canDefine(model, 'action', action) && access.canSeeModelData(model.actions.get(action)?.classification) ? { action } : {}),
    })),
    subprocesses: (reference.subprocesses ?? []).filter(child =>
      access.canRead(model, child.process) && linkVisible(access, model, target, child.link)),
  };
}

export function listMachineryProcesses(access: Access, model: PublishedOntology) {
  access.require(model.document.id, 'view_definition', model.document.id);
  return { release: model.release, items: [...model.objects.values()].flatMap(definition => {
    const target = processLogTarget(model, definition.apiName);
    if (!target || !access.canRead(model, target.type) || !access.canRead(model, target.objectType)
        || !access.canSeeModelData(definition.classification)
        || !access.canSeeModelData(model.object(target.objectType).classification)
        || !access.property(model, target.objectType, target.property)
        || !access.canSeeModelData(model.object(target.objectType).properties[target.property]?.classification)) return [];
    access.read(model, target.type);
    access.read(model, target.objectType);
    return [{ type: target.type, objectType: target.objectType, property: target.property,
      name: model.object(target.objectType).displayName, states:model.object(target.objectType).properties[target.property]!.schema.enum,
      reference: readableModel(access, model, target, definition.machinery) }];
  }) };
}

async function readEvents(db: Database, client: Sql, access: Access, model: PublishedOntology,
  target: ProcessLogTarget, input: Input, ids: string[] | undefined): Promise<Event[]> {
  const values: unknown[] = [input.from, input.to, ids ?? null, input.includeIdle];
  const base = { prefix: '', objects: db.schema + '.objects', links: db.schema + '.links' };
  const view = processLogTables(db, model, access.principal.owner, values, base, [target.type], {
    before: '$2', ids: '$3',
  });
  const row = access.rowSql(model, target.type, values, 'o.properties');
  const cell = (field: string) => access.cellSql(model, target.type, field, values, 'o.properties');
  const required = ['id', 'processId', 'oldState', 'newState', 'sequence', 'recordedAt'].map(cell).join(' AND ');
  const optional = (field: string) => `CASE WHEN ${cell(field)} THEN o.properties->>'${field}' END AS "${field}"`;
  const result = await db.query<Event>(`${view.prefix.trimEnd()}, window_events AS (
      SELECT * FROM process_log_rows WHERE recorded_at >= $1::timestamptz
    ), baseline AS (
      SELECT DISTINCT ON (process_id) * FROM process_log_rows
        WHERE recorded_at < $1::timestamptz
        AND ($4::boolean OR EXISTS (SELECT 1 FROM window_events w WHERE w.process_id=process_log_rows.process_id))
      ORDER BY process_id, sequence DESC
    ), history AS (
      SELECT *, false AS prior FROM window_events UNION ALL SELECT *, true FROM baseline
    ), checked AS MATERIALIZED (
      SELECT o.*, (${row} AND ${required}) AS readable,
        ${optional('timestamp')}, ${optional('action')}, ${optional('source')},
        ${access.principal.scopes.includes('tasks:read') ? optional('taskId') : 'NULL AS "taskId"'},
        ${optional('requestId')}
      FROM history o
    ), complete AS (
      SELECT process_id FROM checked GROUP BY process_id HAVING bool_and(COALESCE(readable, false))
    )
    SELECT o.process_id AS "caseId",o.id,o.properties->>'oldState' AS "from",o.properties->>'newState' AS "to",
      o.properties->>'recordedAt' AS "recordedAt",o.timestamp,o.action,o.source,o."taskId",o."requestId",o.prior
    FROM checked o JOIN complete USING (process_id)
    ORDER BY o.process_id,o.sequence LIMIT ${input.eventLimit + 1}`, values, client);
  if (result.rows.length > input.eventLimit)
    throw new Conflict('Process analysis exceeds the event limit. Narrow the date range or focus on a process object.');
  return result.rows;
}

async function readExternalEvents(db:Database,client:Sql,access:Access,model:PublishedOntology,target:ProcessLogTarget,
  input:Input,ids:string[]|undefined):Promise<Event[]>{
  const owner=access.principal.owner;
  access.source(model,input.externalSource!);
  const values:unknown[]=[model.document.id,owner,target.type,input.externalSource,target.objectType,target.property,
    model.projection,input.from,input.to,ids??null,input.includeIdle];
  const visible=(column:string)=>access.rowSql(model,target.objectType,values,column)+' AND '+access.cellSql(model,target.objectType,target.property,values,column);
  const current=visible('o.properties');
  const before=visible("jsonb_set(o.properties, ARRAY[h.property], COALESCE(to_jsonb(h.previous_state),'null'::jsonb))");
  const after=visible("jsonb_set(o.properties, ARRAY[h.property], COALESCE(to_jsonb(h.next_state),'null'::jsonb))");
  const fields=['id','processId','oldState','newState','sequence','recordedAt','source','timestamp'];
  // Imported rows have their own source grants and object snapshot checks. No synthetic ProcessLog
  // row receives contextual access rules written for committed history.
  if(access.hasObjectPolicy(model,target.type)||fields.some(field=>
      !access.property(model,target.type,field)||!access.canSeeModelData(model.object(target.type).properties[field]?.classification)))
    throw new Conflict('External process history requires readable log fields without a log-specific row policy');
  const checked=await db.query<Event>(`WITH events AS (
     SELECT h.*,h.observed_at<$8::timestamptz AS prior,(${before}) AND (${after}) AS visible
     FROM ${db.schema}.machinery_history h
     JOIN ${db.schema}.objects o ON o.projection=$7 AND o.owner=h.owner AND o.type=h.object_type AND o.id=h.object_id
     WHERE h.ontology=$1 AND h.owner=$2 AND h.type=$3 AND h.source=$4 AND h.object_type=$5 AND h.property=$6
       AND h.observed_at<$9::timestamptz AND ($10::text[] IS NULL OR h.object_id=ANY($10)) AND (${current})
   ), history AS (
     SELECT * FROM events WHERE NOT prior
     UNION ALL (SELECT DISTINCT ON(object_id) * FROM events e WHERE prior
       AND ($11::boolean OR EXISTS(SELECT 1 FROM events observed WHERE observed.object_id=e.object_id AND NOT observed.prior))
       ORDER BY object_id,observed_at DESC)
   ), complete AS (SELECT object_id FROM history GROUP BY object_id HAVING bool_and(COALESCE(visible,false)))
   SELECT h.object_id AS "caseId",h.id,h.previous_state AS "from",h.next_state AS "to",
     h.observed_at::text AS "recordedAt",h.observed_at::text AS timestamp,NULL AS action,h.source,NULL AS "taskId",NULL AS "requestId",h.prior
   FROM history h JOIN complete USING(object_id) ORDER BY h.object_id,h.observed_at LIMIT ${input.eventLimit+1}`,values,client);
  if(checked.rows.length>input.eventLimit)throw new Conflict('Narrow the external history window before analyzing');
  return checked.rows;
}

function trace(target: ProcessLogTarget, history: Event[], from: number, to: number,
  reference: MachineryModel | undefined, clock: Input['durationClock']): ProcessCase {
  const allowed = new Set(reference?.transitions.map(edge => edgeKey(edge.from, edge.to)));
  const [first] = history;
  const episodes: Episode[] = [], states: string[] = [];
  let partial = Boolean(first!.prior || first!.from !== null);
  let incomplete = !first!.prior && first!.from !== null;
  let current: string | null = null, openAt: number | null = null;
  const completedDuration = (end: number | null) =>
    end !== null && openAt !== null && end >= openAt ? end - openAt : null;
  let deviates = false;
  for (const event of history) {
    const clockValue = clock === 'observedAt' ? event.timestamp : event.recordedAt;
    const timestamp = clockValue === null ? null : Date.parse(clockValue);
    if (!event.prior && reference && !allowed.has(edgeKey(event.from, event.to))) deviates = true;
    if (!event.prior && current !== event.from) {
      // Historical imports or renamed state contracts can leave an unknown interval.
      partial = true;
      incomplete = true;
      if (event.from !== null) {
        if (states.at(-1) !== event.from) states.push(event.from);
        episodes.push({ state: event.from, durationMs: null, open: false, clipped: true });
      }
    } else if (current !== null) {
      episodes.push({ state: current, durationMs: completedDuration(timestamp),
        open: false, clipped: openAt !== null && openAt < from });
    }
    current = event.to;
    openAt = timestamp;
    if (current !== null) states.push(current);
  }
  if (current !== null) episodes.push({
    state: current, durationMs: completedDuration(to), open: true, clipped: openAt !== null && openAt < from,
  });
  const events = history.filter(event => !event.prior);
  const conformance = deviates ? 'deviation' : !reference || incomplete || !events.length ? 'unknown' : 'conforming';
  return { object: { type: target.objectType, id: first!.caseId }, states, path: digest([partial, states]),
    partial, current, conformance, episodes, events };
}

function matches(item: ProcessCase, filter: Input['filter']) {
  if (!filter) return true;
  if (filter.state && (filter.current ? item.current !== filter.state : !item.states.includes(filter.state))) return false;
  if (filter.edge && !item.events.some(event => event.from === filter.edge!.from && event.to === filter.edge!.to)) return false;
  if (filter.states && !(filter.current ? item.current !== null && filter.states.includes(item.current)
    : item.states.some(name => filter.states!.includes(name)))) return false;
  if (filter.edges) {
    const selected = new Set(filter.edges.map(edge => edgeKey(edge.from, edge.to))), last = item.events.at(-1);
    if (filter.edgeMode === 'last' ? !last || !selected.has(edgeKey(last.from, last.to))
      : !item.events.some(event => selected.has(edgeKey(event.from, event.to)))) return false;
  }
  if (filter.path && item.path !== filter.path) return false;
  if (filter.conformance && item.conformance !== filter.conformance) return false;
  const duration = filter.duration;
  return !duration || item.episodes.some(episode => episode.state === duration.state && episode.durationMs !== null
    && episode.durationMs >= duration.minMs && episode.durationMs < (duration.maxExclusiveMs ?? Infinity));
}

function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  const p = (rank: number) => values[Math.ceil(values.length * rank) - 1] ?? null;
  const ranges = [60000, 300000, 1800000, 3600000, 86400000];
  const buckets = Array<number>(ranges.length + 1).fill(0);
  for (const value of values) {
    const range = ranges.findIndex(upper => value < upper);
    const index = range < 0 ? ranges.length : range;
    buckets[index] = buckets[index]! + 1;
  }
  return { count: values.length, totalMs: values.reduce((sum, value) => sum + value, 0),
    p50Ms: p(.5), p95Ms: p(.95), maxMs: values.at(-1) ?? null,
    distribution: buckets.map((count, index) => ({ fromMs: ranges[index - 1] ?? 0, toMs: ranges[index] ?? null, count })) };
}

function summarize(cases: ProcessCase[], reference: ReturnType<typeof readableModel>) {
  const states = new Map<string, { ever: number; current: number; closed: number[]; open: number[]; unknown: number; clipped: number; breaches: number; target?: number; terminal: boolean }>();
  const transitions = new Map<string, { from: string | null; to: string | null; count: number; cases: number; last: number;
    expected: boolean | null; action?: string; observedActions: Record<string, number>; observedSources: Record<string, number> }>();
  const paths = new Map<string, { id: string; states: string[]; partial: boolean; count: number }>();
  const stateFor = (name: string) => {
    const existing = states.get(name);
    if (existing) return existing;
    const definition = reference?.states.find(state => state.name === name);
    const item = { ever: 0, current: 0, closed: [] as number[], open: [] as number[], unknown: 0, clipped: 0,
      breaches: 0, target: definition?.dwellSeconds, terminal: definition?.terminal ?? false };
    states.set(name, item);
    return item;
  };
  for (const state of reference?.states ?? []) stateFor(state.name);
  for (const edge of reference?.transitions ?? []) transitions.set(edgeKey(edge.from, edge.to), {
    ...edge, count: 0, cases: 0, last: 0, expected: true, observedActions: Object.create(null), observedSources: Object.create(null),
  });
  for (const item of cases) {
    if (item.events.length) {
      if (!paths.has(item.path)) paths.set(item.path, { id: item.path, states: item.states, partial: item.partial, count: 0 });
      paths.get(item.path)!.count++;
    }
    for (const state of new Set(item.states)) stateFor(state).ever++;
    if (item.current !== null) stateFor(item.current).current++;
    for (const episode of item.episodes) {
      const stats = stateFor(episode.state);
      if (episode.durationMs === null) { stats.unknown++; continue; }
      if (episode.clipped) stats.clipped++;
      (episode.open ? stats.open : stats.closed).push(episode.durationMs);
      if (stats.target !== undefined && episode.durationMs > 1000 * stats.target) stats.breaches++;
    }
    const distinctEdges = new Set<string>();
    for (const event of item.events) {
      const key = edgeKey(event.from, event.to);
      if (!transitions.has(key)) transitions.set(key, {
        from: event.from, to: event.to, count: 0, cases: 0, last: 0, expected: reference ? false : null,
        observedActions: Object.create(null), observedSources: Object.create(null),
      });
      const row = transitions.get(key)!;
      row.count++;
      if (event.source) row.observedSources[event.source] = (row.observedSources[event.source] ?? 0) + 1;
      if (event.action) row.observedActions[event.action] = (row.observedActions[event.action] ?? 0) + 1;
      distinctEdges.add(key);
    }
    for (const key of distinctEdges) transitions.get(key)!.cases++;
    const last = item.events.at(-1);
    if (last) transitions.get(edgeKey(last.from, last.to))!.last++;
  }
  const stateRows = [...states].map(([name, item]) => ({
    name, ever: item.ever, current: item.current, historical: distribution(item.closed), currentDuration: distribution(item.open),
    unknownDuration: item.unknown, priorToWindow: item.clipped, dwellSeconds: item.target ?? null, breaches: item.breaches, terminal: item.terminal,
  }));
  const edgeRows = [...transitions.values()].sort((a, b) => b.count - a.count);
  return {
    states: stateRows,
    transitions: edgeRows,
    paths: [...paths.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)).slice(0, 100),
    pathsTotal: paths.size,
    conformance: {
      conforming: cases.filter(item => item.conformance === 'conforming').length,
      deviation: cases.filter(item => item.conformance === 'deviation').length,
      unknown: cases.filter(item => item.conformance === 'unknown').length,
    },
    findings: {
      bottlenecks: stateRows.filter(row => !row.terminal && (row.historical.count || row.currentDuration.count))
        .sort((a, b) => b.historical.totalMs + b.currentDuration.totalMs - a.historical.totalMs - a.currentDuration.totalMs)
        .map(row => ({ state: row.name, totalMs: row.historical.totalMs + row.currentDuration.totalMs,
          completedP95Ms: row.historical.p95Ms, currentMaxMs: row.currentDuration.maxMs, breaches: row.breaches })),
      observedOnly: edgeRows.filter(edge => edge.expected === false),
      expectedOnly: edgeRows.filter(edge => edge.expected === true && !edge.count),
    },
  };
}

/**
 * One of Palantir's four Machinery views. Counts: processes ever in each state and through each transition (historical),
 * or now in each state and whose last transition each edge is (current). Durations: the P50 of finished stays
 * (historical) or of ongoing ones (current), colored against the state's dwell target by the P95 or the longest.
 */
function view(summary: ReturnType<typeof summarize>, input: Input['view']) {
  if (!input) return undefined;
  const current = input.scope === 'current';
  const nodes = summary.states.map(row => {
    if (input.kind === 'count') return { state: row.name, value: current ? row.current : row.ever };
    const stats = current ? row.currentDuration : row.historical, worst = current ? stats.maxMs : stats.p95Ms;
    const color = row.dwellSeconds === null || worst === null ? undefined : worst > row.dwellSeconds * 1000 ? 'red' : 'green';
    return { state: row.name, value: stats.p50Ms, p95Ms: stats.p95Ms, maxMs: stats.maxMs, cases: stats.count, ...(color ? { color } : {}) };
  });
  return { kind: input.kind, scope: input.scope, nodes,
    edges: summary.transitions.map(edge => ({ from: edge.from, to: edge.to, value: current ? edge.last : edge.cases })) };
}

type Metric = NonNullable<NonNullable<MachineryModel['metrics']>['node']>;
/**
 * The model's node and edge metrics, over the tracked objects of conforming processes as in Palantir: a node aggregates
 * the processes now in its state, an edge those that went through it. The aggregation is an Object Set aggregation, so
 * the query kernel answers it when routing allows; a selection over 10,000 objects is not aggregated.
 */
async function customMetrics(db: Database, access: Access, model: PublishedOntology, metrics: MachineryModel['metrics'],
  cases: ProcessCase[], summary: ReturnType<typeof summarize>) {
  if (!metrics?.node && !metrics?.edge) return undefined;
  const conforming = cases.filter(item => item.conformance === 'conforming'), sets = new ObjectSets(db);
  const measure = async (metric: Metric, objects: ObjectRef[]) => {
    if (!objects.length) return { value: null, cases: 0 };
    if (objects.length > 10000) return { value: null, cases: objects.length, truncated: true };
    let value: number | null;
    try {
      const result = await sets.aggregate(access, model, { set: { op: 'refs', objects }, metrics: { value: metric.aggregation } });
      value = (result.items[0]?.metrics.value ?? null) as number | null;
    } catch (error) {
      // A caller who may not read the aggregated property still gets the rest of the analysis.
      if (error instanceof PermissionDenied) return { value: null, cases: objects.length, denied: true };
      throw error;
    }
    const color = value === null ? undefined : [...metric.colors ?? []].sort((a, b) => b.min - a.min).find(rule => value >= rule.min)?.color;
    return { value, cases: objects.length, ...(color ? { color } : {}) };
  };
  const describe = ({ colors: _colors, ...metric }: Metric) => metric;
  const output: { node?: ReturnType<typeof describe> & { values: unknown[] }; edge?: ReturnType<typeof describe> & { values: unknown[] } } = {};
  // One aggregation at a time, so that a model with many states does not take many connections.
  if (metrics.node) {
    const values = [];
    for (const row of summary.states)
      values.push({ state: row.name, ...await measure(metrics.node, conforming.filter(item => item.current === row.name).map(item => item.object)) });
    output.node = { ...describe(metrics.node), values };
  }
  if (metrics.edge) {
    const values = [];
    for (const row of summary.transitions) values.push({ from: row.from, to: row.to, ...await measure(metrics.edge,
      conforming.filter(item => item.events.some(event => event.from === row.from && event.to === row.to)).map(item => item.object)) });
    output.edge = { ...describe(metrics.edge), values };
  }
  return output;
}

type Crosstab = { state: string; with: { state: string | null; count: number }[] }[];
function crosstab(pairs: [string, string | null][]): Crosstab {
  const rows = new Map<string, Map<string | null, number>>();
  for (const [state, other] of pairs) {
    const row = rows.get(state) ?? new Map<string | null, number>();
    row.set(other, (row.get(other) ?? 0) + 1);
    rows.set(state, row);
  }
  return [...rows].map(([state, row]) => ({ state, with: [...row].map(([other, count]) => ({ state: other, count }))
    .sort((a, b) => b.count - a.count || String(a.state).localeCompare(String(b.state))) }));
}
const stateOf = (properties: Record<string, unknown>, property: string) => typeof properties[property] === 'string' ? properties[property] as string : null;

/**
 * One process container: where the same objects now stand in the model's parallel processes, the other tracked state
 * properties of their type, against their current state in this one.
 */
function parallelStates(access: Access, model: PublishedOntology, target: ProcessLogTarget, baseline: MachineryModel | undefined,
  cases: ProcessCase[], current: Map<string, Record<string, unknown>>) {
  const result: { process: string; property: string; states: Crosstab }[] = [];
  for (const process of baseline?.parallel ?? []) {
    const other = processLogTarget(model, process);
    if (!other || !access.canRead(model, process)) continue;
    const pairs: [string, string | null][] = [];
    for (const item of cases) {
      const properties = current.get(item.object.id);
      if (item.current === null || !properties || !access.cell(model, target.objectType, other.property, properties)) continue;
      pairs.push([item.current, stateOf(properties, other.property)]);
    }
    result.push({ process, property: other.property, states: crosstab(pairs) });
  }
  return result;
}

/**
 * Nested containers: for each readable subprocess, the current states of the children its link reaches, against the
 * current state of their parent. Children are read under the caller's row policies.
 */
async function alignSubprocesses(db: Database, client: Sql, access: Access, model: PublishedOntology, target: ProcessLogTarget,
  reference: ReturnType<typeof readableModel>, cases: ProcessCase[]) {
  const result: { link: string; process: string; property: string; states: Crosstab }[] = [];
  const parents = new Map(cases.filter(item => item.current !== null).map(item => [item.object.id, item.current!]));
  if (!parents.size) return result;
  for (const child of reference?.subprocesses ?? []) {
    const childTarget = processLogTarget(model, child.process);
    if (!childTarget) continue;
    const nav = model.navigation(target.objectType, child.link);
    const [from, to] = nav.forward ? ['from', 'to'] : ['to', 'from'];
    const values: unknown[] = [access.principal.owner, model.projection, target.objectType, [...parents.keys()], nav.link, childTarget.objectType];
    const policy = access.rowSql(model, childTarget.objectType, values, 'o.properties');
    const rows = (await db.query<{ parent: string; properties: Record<string, unknown> }>(`SELECT l.${from}_id AS parent,o.properties
      FROM ${db.schema}.links l JOIN ${db.schema}.objects o ON o.projection=l.projection AND o.owner=l.owner AND (o.type,o.id)=(l.${to}_type,l.${to}_id)
      WHERE l.owner=$1 AND l.projection=$2 AND l.type=$5 AND l.${from}_type=$3 AND l.${from}_id=ANY($4::text[]) AND o.type=$6 AND ${policy}`,
      values, client)).rows;
    const pairs: [string, string | null][] = [];
    for (const row of rows) {
      if (!access.cell(model, childTarget.objectType, childTarget.property, row.properties)) continue;
      pairs.push([parents.get(row.parent)!, stateOf(row.properties, childTarget.property)]);
    }
    result.push({ link: child.link, process: child.process, property: childTarget.property, states: crosstab(pairs) });
  }
  return result;
}

function mine(summary: ReturnType<typeof summarize>, reference: MachineryModel | undefined, input: Input['mining']) {
  const excluded = new Set(input?.exclude.map(edge => edgeKey(edge.from, edge.to)));
  const observed = summary.transitions.filter(edge => edge.cases >= (input?.minCases ?? 1) &&
    !excluded.has(edgeKey(edge.from, edge.to)));
  const threshold = observed.reduce((count, edge) => count + edge.count, 0) * (input?.coveragePercent ?? 100) / 100;
  let covered = 0;
  const observedOnly = observed.filter(edge => {
    if (covered >= threshold) return false;
    covered += edge.count;
    return edge.expected !== true;
  });
  const states = new Set(reference?.states.map(state => state.name));
  const observedStates = summary.states.filter(state => state.ever >= (input?.minCases ?? 1) && !states.has(state.name));
  return { states: observedStates.map(state => ({ name: state.name, cases: state.ever })), transitions: observedOnly };
}

export async function analyzeMachinery(db: Database, access: Access, model: PublishedOntology, input: Input, collectMembers = false) {
  const from = Date.parse(input.from), to = Date.parse(input.to);
  if (to <= from || to - from > maxWindowMs) throw new Conflict('Select a positive process analysis window of at most 366 days');
  if ([input.object, input.setId, input.focus].filter(Boolean).length > 1)
    throw new Conflict('Select one object, Object Set or subprocess focus');
  const target = targetFor(model, input.type);
  if (input.object && input.object.type !== target.objectType) throw new Conflict('Object type differs from the process type');
  const analysis = await db.transaction(async client => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], client);
    await db.setOwner(client, access.principal.owner);
    await access.refresh(client);
    const head = await db.query(`SELECT 1 FROM ${db.schema}.ontology WHERE id=$1 AND release=$2`, [model.document.id, model.release], client);
    if (!head.rowCount) throw new Conflict('The process publication changed. Refresh and retry.');
    const now = (await db.query<{ at: Date }>('SELECT transaction_timestamp() AS at', [], client)).rows[0]!.at.getTime();
    if (from >= now) throw new Conflict('Process analysis starts in the future');
    const end = Math.min(to, now);
    const graph = new Objects(db, model, access, client);
    access.read(model, target.type);
    access.read(model, target.objectType);
    for (const specification of [input.reference, input.candidate]) {
      if (!specification) continue;
      if (specification.transitions.some(({ action }) => action &&
          (!model.actions.has(action) || !access.canDefine(model, 'action', action)
            || !access.canSeeModelData(model.actions.get(action)?.classification))))
        throw new Conflict('The process model references an unavailable Action');
      try { validateMachineryModel(model, target.type, specification); }
      catch (error) { throw new Conflict(error instanceof Error ? error.message : 'Invalid Machinery model'); }
    }
    let ids = input.object ? [input.object.id] : undefined;
    if (input.object) await graph.read(input.object);
    if (input.setId) {
      const members = await new ObjectSets(db).members(access, model, { op: 'saved', id: input.setId }, client);
      ids = members.filter(object => object.type === target.objectType).map(object => object.id);
    }
    if (input.focus) {
      const parent = targetFor(model, input.focus.type);
      if (input.focus.parent.type !== parent.objectType || !model.object(parent.type).machinery?.subprocesses?.some(child =>
        child.process === input.type && child.link === input.focus!.link))
        throw new Conflict('Select a subprocess configured on the parent process');
      access.read(model, parent.type);
      const objects = await graph.follow(input.focus.parent, input.focus.link);
      ids = objects.filter(object => object.ref.type === target.objectType).map(object => object.ref.id);
    }
    const baseline = input.reference ?? model.object(target.type).machinery;
    const reference = readableModel(access, model, target, baseline);
    const events = await (input.externalSource ? readExternalEvents : readEvents)(db, client, access, model, target, { ...input, to: new Date(end).toISOString() }, ids);
    const idsInHistory = [...new Set(events.map(event => event.caseId))];
    const current = new Map<string, Record<string, unknown>>();
    if (idsInHistory.length) {
      const snapshots = await db.query<{ id: string; properties: Record<string, unknown> }>(
        `SELECT id,properties FROM ${db.schema}.objects WHERE owner=$1 AND projection=$2 AND type=$3 AND id=ANY($4::text[])`,
        [access.principal.owner, model.projection, target.objectType, idsInHistory], client);
      for (const { id, properties } of snapshots.rows) {
        access.readRow(model, target.objectType, properties, true);
        access.cell(model, target.objectType, target.property, properties);
        current.set(id, properties);
      }
    }
    const groups = new Map<string, Event[]>();
    for (const event of events) {
      const group = groups.get(event.caseId) ?? [];
      group.push(event);
      groups.set(event.caseId, group);
    }
    const traces = [...groups.values()].map(history => ({ history, item: trace(target, history, from, end, baseline, input.durationClock) }))
      .filter(({ item }) => matches(item, input.filter));
    const cases = traces.map(({ item }) => item);
    const { offset, limit } = input;
    const summary = summarize(cases, reference);
    const parallel = parallelStates(access, model, target, baseline, cases, current);
    const alignment = await alignSubprocesses(db, client, access, model, target, reference, cases);
    const comparison = input.candidate ? {
      baseline: summary.conformance,
      candidate: summarize(traces.map(({ history }) => trace(target, history, from, end, input.candidate, input.durationClock)),
        readableModel(access, model, target, input.candidate)).conformance,
      evidence: 'observed-transitions',
    } : undefined;
    const result = { release: model.release, type: target.type, objectType: target.objectType,
      from: new Date(from).toISOString(), to: new Date(end).toISOString(), windowClock: input.externalSource ? 'observedAt' : 'recordedAt', durationClock: input.durationClock,
      ...(collectMembers ? {members:cases.map(item=>item.object)} : {}),
      reference, ...summary, mined: mine(summary, baseline, input.mining), comparison,
      ...(parallel.length ? { parallel } : {}), ...(alignment.length ? { alignment } : {}),
      casesTotal: cases.length, nextOffset: offset + limit < cases.length ? offset + limit : null,
      cases: cases.slice(offset, offset + limit).map(({ events: history, episodes, ...item }) => ({
        ...item, transitions: history.length,
        ...(input.object ? { timeline: history, episodes } : {}),
      })),
    };
    return { result: { ...result, ...(input.view ? { view: view(summary, input.view) } : {}) }, cases, summary, metrics: baseline?.metrics };
  });
  // After the snapshot, so that the aggregations can go through the query kernel.
  const metrics = await customMetrics(db, access, model, analysis.metrics, analysis.cases, analysis.summary);
  return { ...analysis.result, ...(metrics ? { metrics } : {}) };
}
