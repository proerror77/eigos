import { z } from 'zod';
import { Conflict, digest } from '../core/identity.js';
import { objectRefSchema } from '../ontology/schema.js';
import type { Objects } from './objects.js';
import type { Database, Sql } from './database.js';

const key = z.string().min(1).max(1000);
const allocationFields = z.strictObject({
  allocation: key,
  resource: key,
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
});
const allocationSchema = allocationFields.refine(value => Date.parse(value.start) < Date.parse(value.end), 'A reservation needs a non-empty interval');
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
    );
    CREATE TABLE IF NOT EXISTS ${db.schema}.reservation_dispatches (
      owner text NOT NULL, holder text NOT NULL, operation text NOT NULL, intent text NOT NULL,
      PRIMARY KEY(owner,holder)
    );`);
}

/** One authority for occupied resource intervals. Call from the Action's existing transaction. */
export class ResourceReservations {
  constructor(private readonly db: Database) {}

  /** All mutations use the same holder lock, including changes to a supplier operation's outstanding claim. */
  private async lock(owner: string, holder: string, client: Sql) {
    if (client === this.db.pool || client === this.db.queryPool) throw new Conflict('Reserving a resource requires a transaction');
    key.parse(owner); key.parse(holder);
    await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [this.db.lockKey('resource-reservation-holder',owner,holder)],client);
    return (await this.db.query<{operation:string;intent:string}>(`SELECT operation,intent FROM ${this.db.schema}.reservation_dispatches
      WHERE owner=$1 AND holder=$2`,[owner,holder],client)).rows[0];
  }

  private allocations(raw: readonly ResourceAllocation[]) {
    const allocations = z.array(allocationSchema).max(10_000).parse(raw);
    if (new Set(allocations.map(item => JSON.stringify([item.resource, item.allocation]))).size !== allocations.length)
      throw new Conflict('Duplicate resource allocations');
    return allocations;
  }

  async replace(owner: string, holder: string, raw: readonly ResourceAllocation[], state: 'held' | 'committed', client: Sql) {
    const allocations = this.allocations(raw);
    z.enum(['held', 'committed']).parse(state);
    if (await this.lock(owner,holder,client)) throw new Conflict('A supplier operation still holds this reservation');
    await this.write(owner,holder,allocations,state,client);
  }

  /** Replace at Action commit; before irreversible dispatch retain both the old and proposed occupied intervals. */
  async forAction(graph: Objects, name: string, input: Record<string,unknown>, requestId: string, phase: 'dispatch' | 'commit') {
    const policy = graph.model.action(name).reservation;
    if (!policy) return;
    const object = objectRefSchema.parse(input[policy.holderParameter]);
    await graph.read(object);
    if (policy.sharedSource) graph.access.dispatchSource(graph.model,policy.sharedSource);
    const declared = z.array(allocationFields.extend({ resource:objectRefSchema })).max(10_000)
      .parse(input[policy.allocationsParameter]);
    if (policy.state==='released' && declared.length) throw new Conflict('Releasing a reservation takes no allocations');
    if (policy.state!=='released' && !declared.length) throw new Conflict('A reservation requires an allocation');
    const resources = new Map(declared.map(item=>[JSON.stringify(item.resource),item.resource]));
    for (const ref of resources.values()) await graph.read(ref);
    const raw = declared.map(({resource:ref,...interval})=>({...interval,resource:policy.sharedSource
      ? JSON.stringify(['source',graph.model.document.id,policy.sharedSource,ref.type,ref.id])
      : JSON.stringify([graph.owner,graph.model.document.id,ref.type,ref.id])}));
    const allocations = this.allocations(raw);
    if (graph.model.scenario) return;
    const holder = JSON.stringify([graph.model.document.id,object.type,object.id]);
    const operation = JSON.stringify([graph.model.release,name,requestId]);
    const intent = digest({allocations,state:policy.state});
    const pending = await this.lock(graph.owner,holder,graph.client);
    if (pending && (pending.operation!==operation || pending.intent!==intent)) throw new Conflict('A supplier operation still holds this reservation');
    if (phase==='commit') {
      await this.write(graph.owner,holder,allocations,policy.state==='held'?'held':'committed',graph.client);
      if (pending) await this.db.query(`DELETE FROM ${this.db.schema}.reservation_dispatches WHERE owner=$1 AND holder=$2`,[graph.owner,holder],graph.client);
      return;
    }
    if (pending) return;
    const values = JSON.stringify(allocations.map(item=>({resource:item.resource,start:item.start,finish:item.end})));
    const rows = await this.db.query<ResourceAllocation & {overlapping:boolean}>(`WITH proposed AS (
      SELECT resource,tstzrange(start,finish,'[)') AS span FROM jsonb_to_recordset($3::jsonb) AS x(resource text,start timestamptz,finish timestamptz)
    ), ordered AS (
      SELECT span, max(upper(span)) OVER(PARTITION BY resource ORDER BY lower(span),upper(span) ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior FROM proposed
    ), occupied AS (
      SELECT resource,occupied_at AS span FROM ${this.db.schema}.resource_reservations WHERE owner=$1 AND holder=$2 AND state IN ('held','committed')
      UNION ALL SELECT resource,span FROM proposed
    ), spans AS (SELECT resource,unnest(range_agg(span)) AS span FROM occupied GROUP BY resource)
    SELECT resource,lower(span)::text AS start,upper(span)::text AS "end",'pending-'||row_number() OVER(PARTITION BY resource ORDER BY lower(span)) AS allocation,
      EXISTS(SELECT 1 FROM ordered WHERE lower(span)<prior) AS overlapping FROM spans`,[graph.owner,holder,values],graph.client);
    if (rows.rows.some(row=>row.overlapping)) throw new Conflict('Requested resource intervals overlap');
    await this.write(graph.owner,holder,rows.rows,'held',graph.client);
    await this.db.query(`INSERT INTO ${this.db.schema}.reservation_dispatches(owner,holder,operation,intent) VALUES($1,$2,$3,$4)`,
      [graph.owner,holder,operation,intent],graph.client);
  }

  private async write(owner: string, holder: string, allocations: readonly ResourceAllocation[], state:'held'|'committed', client:Sql) {
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
