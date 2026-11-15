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

/** The runtime owns this lifecycle row. Reading its published projection still requires an object grant. */
export async function recordActionConfirmation(
  db: Database, model: PublishedOntology, access: Access, task: Task, client: Sql,
  continuation: PlaceContinuation, state: State,
) {
  if (access.principal.owner !== task.owner || model.release !== task.release || model.scenario) {
    throw new Conflict('Action confirmation belongs to a different task owner or publication');
  }
  const ref = actionConfirmationRef(continuation.requestId);
  const graph = new Objects(db, model, access, client, {
    requestId: continuation.requestId, taskId: task.id,
    ...(state === 'awaiting-input' || state === 'completed' ? { action: continuation.action } : {}),
    executor: { kind: 'system', id: 'ontology-action-confirmation' },
  });
  const key = [model.projection, task.owner, ref.type, ref.id];
  await graph.lockWrites();
  if (!task.input.placeContinuation) {
    if (state !== 'awaiting-input') throw new Conflict('Action confirmation has not been requested');
    const properties = model.parseObject(ref, { id: ref.id, name: continuation.action, taskId: task.id, state });
    await db.query(`INSERT INTO ${db.schema}.objects(projection,owner,type,id,properties) VALUES($1,$2,$3,$4,$5)`,
      [...key, properties], client);
    await recordObjectEdit(graph, ref, null, properties, properties, 'create');
    return;
  }
  if (task.input.placeContinuation.requestId !== continuation.requestId) throw new Conflict('Original Action changed');
  const row = (await db.query<{ properties: Record<string, unknown> }>(
    `SELECT properties FROM ${db.schema}.objects
      WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 AND properties->>'taskId'=$5
        AND properties->>'state'=ANY($6::text[]) AND properties->>'name'=$7 FOR UPDATE`,
    [...key, task.id, allowedFrom[state], continuation.action], client)).rows[0];
  if (!row) throw new Conflict('Action confirmation state changed');
  const next = model.parseObject(ref, { ...row.properties, state });
  await db.query(`UPDATE ${db.schema}.objects SET properties=$5,revision=revision+1
    WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [...key, next], client);
  await recordObjectEdit(graph, ref, row.properties, next, { state });
}

export async function assertActionConfirmed(db: Database, model: PublishedOntology, task: Task, continuation: PlaceContinuation) {
  const ref = actionConfirmationRef(continuation.requestId);
  const proof = await db.query(`SELECT 1 FROM ${db.schema}.objects
    WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 AND properties->>'taskId'=$5
      AND properties->>'state'='confirmed' AND properties->>'name'=$6`,
    [model.projection, task.owner, ref.type, ref.id, task.id, continuation.action]);
  if (!proof.rowCount) throw new Conflict('Original Action confirmation is unavailable');
}
