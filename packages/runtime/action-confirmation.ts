import { Conflict } from '../core/identity.js';
import type { Access } from './access.js';
import type { PlaceContinuation } from './clarification.js';
import type { Database, Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';
import { recordObjectEdit } from './edit-history.js';
import type { Task } from './tasks.js';

export const actionConfirmationRef = (requestId: string) => ({ type: 'ActionConfirmation', id: requestId });
type State = 'awaiting-input' | 'confirmed' | 'completed' | 'failed' | 'canceled';

const allowedFrom: Record<State, readonly State[]> = {
  'awaiting-input': ['confirmed'],
  confirmed: ['awaiting-input'],
  completed: ['confirmed'],
  failed: ['confirmed'],
  canceled: ['awaiting-input', 'confirmed'],
};

/** Use the published process object and its existing edit history, under the task's transition lock. */
export async function recordActionConfirmation(
  db: Database, model: PublishedOntology, access: Access, task: Task, client: Sql,
  continuation: PlaceContinuation, state: State,
) {
  const ref = actionConfirmationRef(continuation.requestId);
  const graph = new Objects(db, model, access, client, {
    requestId: continuation.requestId, taskId: task.id,
    ...(state === 'awaiting-input' || state === 'completed' ? { action: continuation.action } : {}),
    executor: { kind: 'system', id: 'ontology-action-confirmation' },
  });
  if (!task.input.placeContinuation) {
    if (state !== 'awaiting-input') throw new Conflict('Action confirmation has not been requested');
    await graph.create(ref, { id: ref.id, name: continuation.action, taskId: task.id, state });
    return;
  }
  if (task.input.placeContinuation.requestId !== continuation.requestId) throw new Conflict('Original Action changed');
  if (state === 'failed' || state === 'canceled') {
    // The task engine must be able to close its own process even when its
    // business grants are revoked. Keep this update scoped to its original row.
    await graph.lockWrites();
    const key = [model.projection, task.owner, ref.type, ref.id, task.id, allowedFrom[state]];
    const row = (await db.query<{ properties: Record<string, unknown> }>(
      `SELECT properties FROM ${db.schema}.objects
        WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 AND properties->>'taskId'=$5
          AND properties->>'state'=ANY($6::text[]) FOR UPDATE`, key, client)).rows[0];
    if (!row) throw new Conflict('Action confirmation cannot be closed');
    const next = model.parseObject(ref, { ...row.properties, state });
    await db.query(`UPDATE ${db.schema}.objects SET properties=$5,revision=revision+1
      WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [...key.slice(0, 4), next], client);
    await recordObjectEdit(graph, ref, row.properties, next, { state });
    return;
  }
  const current = await graph.read(ref);
  if (current.properties.taskId !== task.id || !allowedFrom[state].some(prior => prior === current.properties.state)) {
    throw new Conflict('Action confirmation state changed');
  }
  await graph.edit(ref, current.revision, { state });
}
