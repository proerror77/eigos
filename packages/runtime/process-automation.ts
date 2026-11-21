import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import { processLogTarget } from '../ontology/process-definition.js';
import { objectRefSchema, ontologyName, type ObjectRef } from '../ontology/schema.js';
import { PermissionDenied } from './access.js';
import type { Objects } from './objects.js';
import { readProcessTransitions } from './process-logs.js';

export const processRuleSchema = z.strictObject({
  type: z.string().min(1).max(80),
  from: z.string().max(200).nullable().optional(),
  to: z.string().max(200).optional(),
  dwellSeconds: z.number().int().min(1).max(31 * 86400).optional(),
}).refine(input => input.dwellSeconds === undefined || input.to !== undefined, 'A dwell rule requires a target state');

export const processStatusSchema = z.strictObject({
  type: z.string().min(1).max(80),
  object: objectRefSchema,
});

export const processRelatedPath = z.array(ontologyName).min(1).max(3);

export const processTriggerSchema = z.strictObject({
  ruleId: z.uuid(),
  revision: z.number().int().positive(),
  sequence: z.string().regex(/^\d{1,19}$/),
  process: processRuleSchema,
  relatedPath: processRelatedPath.optional(),
});

export function processTarget(graph: Objects, rule: z.output<typeof processRuleSchema>) {
  const target = processLogTarget(graph.model, rule.type);
  if (!target) throw new Conflict('A process rule requires a published concrete ProcessLog type');
  graph.access.read(graph.model, target.type);
  graph.access.read(graph.model, target.objectType);
  const values = graph.model.object(target.objectType).properties[target.property]!.schema.enum;
  if (!Array.isArray(values) ||
      (typeof rule.from === 'string' && !values.includes(rule.from)) ||
      (rule.to !== undefined && !values.includes(rule.to)))
    throw new Conflict('The state does not belong to this published process');
  return target;
}

export async function visibleTransition(graph: Objects, type: string, sequence: string) {
  try {
    return await graph.read({ type, id: sequence.padStart(20, '0') });
  } catch (error) {
    if (error instanceof NotFound || error instanceof PermissionDenied) return undefined;
    throw error;
  }
}

export async function matchingTransition(graph: Objects, rule: z.output<typeof processRuleSchema>, sequence: string) {
  const log = await visibleTransition(graph, rule.type, sequence);
  if (!log || typeof log.properties.processId !== 'string' || typeof log.properties.newState !== 'string')
    return undefined;
  if ((rule.to !== undefined && rule.to !== log.properties.newState) ||
      (rule.from !== undefined && rule.from !== log.properties.oldState))
    return undefined;
  if (rule.from === null && !await graph.propertyVisible(log.ref, 'oldState'))
    return undefined;
  return log;
}

export async function relatedProcessObjects(graph: Objects, source: ObjectRef, path: string[]) {
  let layer = [source];
  for (const link of path) {
    const targets = new Map<string, ObjectRef>();
    for (const ref of layer) {
      for (const item of await graph.follow(ref, link, ref.type, 100)) {
        targets.set(digest(item.ref), item.ref);
        if (targets.size > 100) throw new Conflict('A process rule can bind at most 100 related objects');
      }
    }
    layer = [...targets.values()];
  }
  return layer;
}

/** Only show schedules whose entire argument is the authorized process object. */
async function objectSchedules(graph: Objects, object: z.output<typeof objectRefSchema>) {
  if (!graph.access.principal.scopes.includes('tasks:read')) return [];
  const candidates = [...graph.model.actions.values()].flatMap(action => {
    const entries = Object.entries(action.objectParameters);
    if (entries.length !== 1 || entries[0]![1] !== object.type ||
        !graph.access.canDefine(graph.model, 'action', action.apiName) ||
        !graph.access.canSeeModelData(action.classification)) return [];
    return [{action:action.apiName, arguments:{[entries[0]![0]]:object}}];
  });
  if (!candidates.length) return [];
  const { rows } = await graph.db.query(`SELECT s.body->>'action' AS action,
      CASE WHEN s.state='started' THEN t.state ELSE s.state END AS status,
      CASE WHEN s.state='scheduled' THEN s.run_at
        WHEN s.state='started' AND t.state='submitted' THEN coalesce(t.available_at,s.run_at) END AS "nextCheckAt",
      s.deadline
    FROM ${graph.db.schema}.scheduled_actions s
    JOIN ${graph.db.schema}.releases release ON release.digest=s.body->>'plannedRelease'
    JOIN jsonb_to_recordset($3::jsonb) binding(action text,arguments jsonb)
      ON binding.action=s.body->>'action' AND binding.arguments=s.body->'arguments'
    LEFT JOIN ${graph.db.schema}.tasks t ON t.id=s.task_id AND t.owner=s.owner
    WHERE s.owner=$1 AND release.body->>'id'=$2 ORDER BY s.run_at DESC,s.id LIMIT 20`,
    [graph.owner,graph.model.document.id,JSON.stringify(candidates)],graph.client);
  for (const row of rows) graph.access.definition(graph.model,'action',row.action);
  return rows;
}

export async function readProcessStatus(graph: Objects, input: z.output<typeof processStatusSchema>) {
  const target = processTarget(graph, { type: input.type });
  if (target.objectType !== input.object.type) throw new Conflict('Object type differs from the published process');
  const current = await graph.read(input.object);
  const state = current.properties[target.property] ?? null;
  const [latest] = await readProcessTransitions(graph.db, graph.model, graph.owner, target, graph.client, { latestFor: input.object.id });
  const log = latest && state !== null && await visibleTransition(graph, target.type, latest.sequence);
  const asOf: Date = (await graph.db.query('SELECT clock_timestamp() AS now', [], graph.client)).rows[0]!.now;
  const visible = log && log.properties.newState === state && log.properties.processId === input.object.id;
  const recordedAt = visible && typeof log.properties.recordedAt === 'string' ? log.properties.recordedAt : null;
  return {
    object: input.object,
    property: target.property,
    schedules: state === null ? [] : await objectSchedules(graph,input.object),
    state,
    transition: visible ? log.ref : null,
    observedAt: visible ? log.properties.timestamp : null,
    recordedAt,
    asOf: asOf.toISOString(),
    recordedDurationSeconds: recordedAt ? Math.max(0, Math.floor((asOf.getTime() - Date.parse(recordedAt)) / 1000)) : null,
  };
}
