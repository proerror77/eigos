import { z } from 'zod';
import { Conflict } from '../core/identity.js';
import type { Database, Sql } from './database.js';

const key = z.string().min(1).max(1000);
const allocationSchema = z.strictObject({
  allocation: key,
  resource: key,
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
}).refine(value => Date.parse(value.start) < Date.parse(value.end), 'A reservation needs a non-empty interval');
export type ResourceAllocation = z.infer<typeof allocationSchema>;

export async function initializeResourceReservations(db: Database) {
  await db.transaction(async client => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('eigos:extension:btree_gist',0))", [], client);
    await db.query('CREATE EXTENSION IF NOT EXISTS btree_gist', [], client);
  });
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.resource_reservations (
      owner text NOT NULL, holder text NOT NULL, resource text NOT NULL, allocation text NOT NULL,
      occupied_at tstzrange NOT NULL, state text NOT NULL CHECK (state IN ('held','committed','released')),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(owner,holder,resource,allocation),
      CONSTRAINT resource_reservation_no_overlap EXCLUDE USING gist (resource WITH =, occupied_at WITH &&)
        WHERE (state IN ('held','committed'))
    );`);
}

/** One authority for occupied resource intervals. Call from the Action's existing transaction. */
export class ResourceReservations {
  constructor(private readonly db: Database) {}

  async replace(owner: string, holder: string, raw: readonly ResourceAllocation[], state: 'held' | 'committed', client: Sql) {
    if (client === this.db.pool) throw new Conflict('Reserving a resource requires a transaction');
    key.parse(owner); key.parse(holder);
    const allocations = z.array(allocationSchema).max(10_000).parse(raw);
    if (new Set(allocations.map(item => JSON.stringify([item.resource, item.allocation]))).size !== allocations.length)
      throw new Conflict('Duplicate resource allocations');
    z.enum(['held', 'committed']).parse(state);
    await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [this.db.lockKey('resource-reservation-holder',owner,holder)],client);
    const args = [owner,holder];
    await this.db.query(`UPDATE ${this.db.schema}.resource_reservations SET state='released',updated_at=clock_timestamp()
      WHERE owner=$1 AND holder=$2 AND state IN ('held','committed')`, args, client);
    if (!allocations.length) return;
    try {
      await this.db.query(`INSERT INTO ${this.db.schema}.resource_reservations
        (owner,holder,resource,allocation,occupied_at,state)
        SELECT $1,$2,v.resource,v.allocation,tstzrange(v.start,v.finish,'[)'),$4
        FROM jsonb_to_recordset($3::jsonb) v(resource text,allocation text,start timestamptz,finish timestamptz)
        ORDER BY v.resource,v.allocation
        ON CONFLICT(owner,holder,resource,allocation) DO UPDATE SET
          occupied_at=excluded.occupied_at,state=excluded.state,updated_at=clock_timestamp()`,
      [...args,JSON.stringify(allocations.map(({ end, ...values }) => ({ ...values, finish: end }))),state], client);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23P01') throw new Conflict('A resource is reserved in that interval');
      throw error;
    }
  }
}
