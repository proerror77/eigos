import { Conflict } from '../core/identity.js';
import type { Access } from './access.js';
import type { PlaceContinuation } from './clarification.js';
import type { Database, Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';
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
  const current = await graph.read(ref);
  if (current.properties.taskId !== task.id || !allowedFrom[state].some(prior => prior === current.properties.state)) {
    throw new Conflict('Action confirmation state changed');
  }
  await graph.edit(ref, current.revision, { state });
}
