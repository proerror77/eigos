import { z } from 'zod';
import { Conflict, NotFound, digest, requireScope, type Principal } from '../../core/identity.js';
import { placeDetailResult } from '../../ontology/maps.js';
import { Access } from '../../runtime/access.js';
import { amapPlaceAmendmentSchema, unresolvedMapPlace } from '../../runtime/clarification.js';
import type { Sql } from '../../runtime/database.js';
import { appendTrace } from '../../runtime/execution-trace.js';
import type { Functions } from '../../runtime/functions.js';
import type { Metadata } from '../../runtime/metadata.js';
import { Objects } from '../../runtime/objects.js';
import type { Task, Tasks } from '../../runtime/tasks.js';
import type { AgentTaskPrompt } from '../../runtime/agent-task.js';

export async function amendMapPlace(tasks: Tasks, metadata: Metadata, functions: Functions, principal: Principal, id: string, raw: unknown): Promise<Task> {
  requireScope(principal, 'tasks:read'); requireScope(principal, 'tasks:write'); z.uuid().parse(id);
  const input = amapPlaceAmendmentSchema.parse(raw), fingerprint = digest(input);
  const { owner } = principal, { db } = tasks, schema = db.schema;
  const load = async (client?: Sql) => {
    const task = (await db.query<Task>(`SELECT * FROM ${schema}.tasks WHERE owner=$1 AND id=$2${client ? ' FOR UPDATE' : ''}`,
      [owner, id], client)).rows[0];
    if (!task) throw new NotFound('Task is unavailable');
    return task;
  };
  const alreadyApplied = (task: Task) => {
    const previous = Object.values(task.input.mapPlaceCorrections ?? {}).find(place => place?.requestId === input.requestId);
    if (previous && previous.fingerprint !== fingerprint) throw new Conflict('Place correction ID was already used');
    return Boolean(previous);
  };
  const check = async (task: Task, access: Access, client?: Sql) => {
    const waiting = task.state === 'input-required' || task.state === 'canceled' && input.restoreCanceled === true;
    if (!waiting || task.result !== null || task.error !== unresolvedMapPlace ||
        task.updated_at.getTime() !== Date.parse(input.expectedUpdatedAt) || task.input.placeContinuation ||
        task.input.scheduledAction || task.input.learnHotelWorkflow || task.input.replayHotelWorkflow) {
      throw new Conflict('The original task is not waiting for this map correction');
    }
    if (!task.result_permissions || !await access.canReturn(task.result_permissions, client)) {
      throw new Conflict('Task input permissions changed');
    }
    const used = (await db.query(`SELECT 1 WHERE
      EXISTS(SELECT 1 FROM ${schema}.actions WHERE owner=$1 AND task_id=$2::uuid)
      OR EXISTS(SELECT 1 FROM ${schema}.scenario_actions WHERE owner=$1 AND task_id=$2::uuid)
      OR EXISTS(SELECT 1 FROM ${schema}.edit_history WHERE owner=$1 AND task_id=$2::text)
      OR EXISTS(SELECT 1 FROM ${schema}.external_operations WHERE owner=$1 AND task_id=$2::uuid)
      OR EXISTS(SELECT 1 FROM ${schema}.scheduled_actions WHERE owner=$1 AND (task_id=$2::uuid OR body->>'sourceTaskId'=$2::text))
      OR EXISTS(SELECT 1 FROM ${schema}.execution_trace WHERE owner=$1 AND task_id=$2::uuid AND event->>'kind' IN ('proposal','approval','merge'))`,
      [owner, id], client)).rowCount;
    if (used) throw new Conflict('A task with prior business Actions cannot use map recovery');
  };

  const task = await load();
  if (alreadyApplied(task)) return tasks.visible(principal, task);
  const access = await Access.load(db, principal);
  await check(task, access);
  const model = await metadata.active('Eigos');
  const { place } = placeDetailResult.parse(await functions.invoke(model, 'readMapPlace', { id: input.placeId }, {
    principal, objects: new Objects(db, model, access), signal: AbortSignal.timeout(15000),
  }));
  if (place.id !== input.placeId || !place.point) throw new Conflict('The selected Amap place has no verified point');

  const resumed = await db.transaction(async client => {
    const active = await metadata.active('Eigos', client, true);
    const current = await load(client);
    if (alreadyApplied(current)) return current;
    if (active.release !== model.release || (await metadata.get(current.release, client)).document.id !== active.document.id) {
      throw new Conflict('The publication changed during map correction');
    }
    await access.refresh(client);
    await check(current, access, client);
    const nextInput = { ...current.input, mapPlaceCorrections: { ...current.input.mapPlaceCorrections,
      [input.side]: { requestId: input.requestId, fingerprint, placeId: place.id, name: place.name, city: place.city } } };
    const result = (await db.query<Task>(`UPDATE ${schema}.tasks
      SET input=$2,release=$3,state='submitted',error=NULL,result=NULL,result_permissions=NULL,execution_step=execution_step+1,
        available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [id, nextInput, active.release], client)).rows[0]!;
    await appendTrace(db, { owner, taskId: id, release: active.release, projection: active.projection }, {
      kind: 'map-place-correction', side: input.side, previousRelease: current.release,
      previousState: current.state === 'canceled' ? 'canceled' : 'input-required',
    }, client, access.dataRequirements());
    await db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
    return result;
  });
  return tasks.visible(principal, resumed);
}

export const prepareMapCorrectionPrompt: AgentTaskPrompt = (model, access, request) => {
  const { mapPlaceCorrections, ...userRequest } = request;
  if (!mapPlaceCorrections) return undefined;
  access.function(model, 'readMapPlace');
  access.source(model, 'Amap');
  const confirmedMapPlaces = Object.fromEntries(Object.entries(mapPlaceCorrections)
    .flatMap(([side, place]) => place ? [[side, { placeId: place.placeId, name: place.name, city: place.city }]] : []));
  return {
    userRequest,
    context: { confirmedMapPlaces, executionAt: new Date().toISOString() },
    instructions: [
      'Use the authenticated caller’s confirmedMapPlaces values. Read the exact placeId for each corrected endpoint and preserve it across dependent legs. Use the current execution date for planning.',
    ],
  };
};
