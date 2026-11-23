import { rideWatchClosed, rideWatchFields, rideWatchRef, rideWatchType } from '../ontology/ride-watch.js';
import { Access } from './access.js';
import type { Database, Sql } from './database.js';
import { recordObjectEdit } from './edit-history.js';
import type { PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';

/** Record a scheduler decision on its own watch, even when provider access was revoked. */
export async function closeRideWatchSchedule(db: Database, model: PublishedOntology, client: Sql, owner: string,
  scheduleId: string, call: { action: string; arguments: unknown }, state: 'expired' | 'unavailable', taskId?: string) {
  if (call.action !== 'CheckDidiRideWatch' || !model.objects.has(rideWatchType)) return;
  const input = rideWatchRef.safeParse(call.arguments);
  if (!input.success || input.data.watch.type !== rideWatchType) return;
  await db.withTransactionOwner(client, owner, async () => {
    const ref = input.data.watch;
    const graph = new Objects(db, model, await Access.load(db, { owner, scopes: [] }, client), client, {
      taskId, executor: { kind: 'system', id: 'didi-watch-schedule' },
    });
    await graph.lockWrites();
    const key = [model.projection, owner, ref.type, ref.id];
    const { rows: [row] } = await db.query(`SELECT properties FROM ${db.schema}.objects
      WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 FOR UPDATE`, key, client);
    if (!row) return;
    const prior = rideWatchFields.parse(row.properties);
    if (prior.scheduleId !== scheduleId || rideWatchClosed.has(prior.state)) return;
    const changes = { state, reason: state === 'expired' ? 'expired' : 'source_unavailable',
      nextCheckAt: null, driver: null, distanceKm: null, etaMinutes: null, arrival: null,
      arrivalVersion: prior.arrivalVersion + (prior.arrival ? 1 : 0) };
    const properties = model.parseObject(ref, { ...prior, ...changes });
    await db.query(`UPDATE ${db.schema}.objects SET properties=$5,revision=revision+1
      WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [...key, properties], client);
    await recordObjectEdit(graph, ref, row.properties, properties, changes, 'edit');
  });
}
