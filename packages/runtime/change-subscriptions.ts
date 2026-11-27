import { MachineryWatchPlanner, processFootprint, type SubscriptionFootprint } from './machinery-watch.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical, Conflict, NotFound, requireScope } from '../core/identity.js';
import { objectRefSchema, ontologyName } from '../ontology/schema.js';
import type { Access } from './access.js';
import { footprintChanges, latestCommit, queryFootprint, type ChangeFootprint } from './change-feed.js';
import type { Database, Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';
import { querySchema } from './objects.js';
import type { Tasks } from './tasks.js';

/**
 * Funnel 05.4: change subscriptions. A subscription is a footprint (the object types and link types whose committed
 * changes matter to its subscriber) and a position (the owner's last commit it has been woken for). After commits that
 * touch the footprint, the subscriber is woken once with the commits it has not seen: a task in its conversation that
 * carries the commit window and the types and links it touched. The window and the new position are committed in one
 * transaction, so no commit is missed and none is delivered twice. Wake tasks run as the subscription's principal, which
 * reads the changes again under its current permissions; a subscription keeps no data.
 */
export async function initializeChangeSubscriptions(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.change_subscriptions (
      id uuid PRIMARY KEY, owner text NOT NULL, request_id text NOT NULL, ontology text NOT NULL, conversation_id text NOT NULL,
      principal jsonb NOT NULL, footprint jsonb NOT NULL, position bigint NOT NULL, last_scan timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), cancelled_at timestamptz, UNIQUE(owner, request_id));
    ALTER TABLE ${db.schema}.change_subscriptions ADD COLUMN IF NOT EXISTS plan_digest text;
    CREATE INDEX IF NOT EXISTS change_subscriptions_due ON ${db.schema}.change_subscriptions(last_scan NULLS FIRST) WHERE cancelled_at IS NULL;`);
}

const subscriptionIdentity = z.strictObject({
  requestId: z.string().min(1).max(128),
  /** The conversation the wake tasks join, as a task's conversation. */
  conversationId: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u),
});
export const watchMachinerySchema = subscriptionIdentity.extend({ object: objectRefSchema });
export const subscribeSchema = subscriptionIdentity.extend({
  types: z.array(ontologyName).max(50).default([]),
  links: z.array(ontologyName).max(50).default([]),
  /** An Object Set query whose answer the subscriber keeps: its types, and the links and types its derived properties read. */
  query: querySchema.pick({ type: true, where: true, filter: true, orderBy: true, select: true, from: true }).partial({ where: true }).optional(),
}).refine(input => input.types.length || input.links.length || input.query, 'A subscription watches at least one type, link or query');

/** The wake a subscriber receives: the commits after `after` through `through`, and what in its footprint they touched. */
export type ChangeWake = { event: 'ontology_changes'; subscription: string; commits: { after: string; through: string }; types: string[]; links: string[] };

const storedPrincipal = z.object({ owner: z.string(), scopes: z.array(z.string()), memberAccess: z.literal(true).optional(), memberAudience: z.literal(true).optional(), clientId: z.string().optional(), issuedAt: z.number().optional() });
type Row = { id: string; owner: string; request_id: string; conversation_id: string; principal: unknown; footprint: SubscriptionFootprint; position: string; plan_digest: string | null };

export class ChangeSubscriptions {
  constructor(private readonly db: Database, private readonly tasks: Tasks, private readonly planner?: MachineryWatchPlanner) {}

  /**
   * Subscribes the principal to commits that touch the footprint, from the owner's latest commit on. The principal must
   * be able to read every watched type and see every watched link, and to submit tasks, as each wake is one.
   */
  async subscribe(access: Access, model: PublishedOntology, raw: unknown) {
    const input = subscribeSchema.parse(raw);
    requireScope(access.principal, 'tasks:write');
    const fromQuery = input.query ? queryFootprint(model, { where: {}, ...input.query }) : { types: [], links: [], local: false };
    const footprint: ChangeFootprint = { types: [...new Set([...input.types, ...fromQuery.types])].sort(),
      links: [...new Set([...input.links, ...fromQuery.links])].sort(), local: false };
    return this.save(access, model, input, footprint);
  }

  async watchMachinery(access: Access, model: PublishedOntology, raw: unknown) {
    const input = watchMachinerySchema.parse(raw);
    requireScope(access.principal, 'tasks:write');
    if (!this.planner || model.scenario || model.document.id !== 'Eigos')
      throw new Conflict('Machinery watches require the live scheduled Ontology');
    return this.save(access, model, input, processFootprint(model,input.object));
  }

  private async save(access: Access, model: PublishedOntology, input: z.infer<typeof subscriptionIdentity>, footprint: SubscriptionFootprint) {
    for (const type of footprint.types) { model.object(type); access.read(model, type); }
    for (const link of footprint.links) access.definition(model, 'link', link);
    const owner = access.principal.owner;
    const principal = storedPrincipal.parse(access.principal);
    const persist = () => this.db.withOwner(owner, () => this.db.transaction(async client => {
      if (footprint.machinery) await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], client);
      const signature = footprint.machinery && await this.planner!.signature(model,access,footprint.machinery.object,client);
      const position = await latestCommit(this.db, owner, client);
      const row = (await this.db.query<{ id: string; position: string }>(`INSERT INTO ${this.db.schema}.change_subscriptions
          (id, owner, request_id, ontology, conversation_id, principal, footprint, position, plan_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(owner, request_id) DO NOTHING RETURNING id, position::text`,
        [randomUUID(), owner, input.requestId, model.document.id, input.conversationId, principal, footprint, position, signature ?? null], client)).rows[0];
      if (row) return { id: row.id, position: row.position, footprint };
      const prior = (await this.db.query<{ id: string; position: string; footprint: ChangeFootprint; conversation_id: string }>(
        `SELECT id, position::text, footprint, conversation_id FROM ${this.db.schema}.change_subscriptions WHERE owner=$1 AND request_id=$2`,
        [owner, input.requestId], client)).rows[0]!;
      // jsonb reorders keys, so the footprints are compared canonically.
      if (canonical(prior.footprint) !== canonical(footprint) || prior.conversation_id !== input.conversationId)
        throw new Conflict('Request ID already used with a different subscription');
      return { id: prior.id, position: prior.position, footprint: prior.footprint };
    }));
    try { return await persist(); }
    catch (error) {
      // A concurrent insertion under the watch's repeatable-read snapshot can serialize first.
      if (!footprint.machinery || (error as {code?:string}).code !== '40001') throw error;
      return persist();
    }
  }

  async cancel(access: Access, id: string, machineryOnly = false) {
    z.uuid().parse(id);
    const { rowCount } = await this.db.query(`UPDATE ${this.db.schema}.change_subscriptions SET cancelled_at=now()
      WHERE id=$1 AND owner=$2 AND cancelled_at IS NULL AND (NOT $3 OR footprint ? 'machinery')`, [id, access.principal.owner, machineryOnly]);
    if (!rowCount) throw new NotFound('Subscription is unavailable');
  }

  async list(access: Access) {
    return (await this.db.query(`SELECT id, request_id AS "requestId", conversation_id AS "conversationId", footprint, position::text, created_at AS "createdAt"
      FROM ${this.db.schema}.change_subscriptions WHERE owner=$1 AND cancelled_at IS NULL ORDER BY created_at, id`, [access.principal.owner])).rows;
  }

  private async scanMachinery(row: Row, watch: NonNullable<SubscriptionFootprint['machinery']>) {
    const principal = storedPrincipal.parse(row.principal), s = this.db.schema;
    await this.db.transaction(async client => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], client);
      const locked = await this.db.query(`SELECT 1 FROM ${s}.change_subscriptions
        WHERE id=$1 AND owner=$2 AND position=$3 AND cancelled_at IS NULL FOR UPDATE SKIP LOCKED`,
        [row.id, row.owner, row.position], client);
      if (!locked.rowCount) return;
      const through = await latestCommit(this.db, row.owner, client);
      const change = await this.planner!.inspect(principal, watch, row.position, through, client);
      if (!change) return;
      if ('stopped' in change) {
        await this.db.query(`UPDATE ${s}.change_subscriptions SET cancelled_at=now() WHERE id=$1`, [row.id], client);
        return;
      }
      if (change.signature) {
        await this.planner!.replanSchedules(row.owner, watch, client);
        // The original observation planner owns schedule changes and rechecks its stored authority.
        await this.db.query(`UPDATE ${s}.observation_interests SET next_scan=least(next_scan,now())
          WHERE owner=$1 AND release=$2 AND state='watching' AND ((plan->'object')::text=($3::jsonb)::text OR attached=$3::jsonb)`,
          [row.owner, watch.release, watch.object], client);
        if (change.signature !== row.plan_digest) {
          const message = JSON.stringify({ event: 'machinery_replanned', subscription: row.id, object: watch.object,
            release: watch.release, commits: { after: row.position, through: change.end } });
          await this.tasks.submit(principal, { requestId: `subscription:${row.id}:${row.position}`, conversationId: row.conversation_id,
            message }, { expectedRelease: watch.release, transaction: client });
        }
      }
      await this.db.query(`UPDATE ${s}.change_subscriptions SET position=$2,plan_digest=coalesce($3,plan_digest) WHERE id=$1`,
        [row.id, change.end, change.signature ?? null], client);
    });
  }

  /**
   * Checks one due subscription, at most once a second each, and reports whether it claimed one. Commits that touch the
   * footprint wake the subscriber with their window; other commits only advance its position. The position moves only
   * from the value read, in the transaction that submits the wake, so concurrent dispatchers deliver each window once.
   */
  async scanOne(): Promise<boolean> {
    const s = this.db.schema;
    const claimed = await this.db.transaction(async client => {
      const row = (await this.db.query<Row>(`SELECT id, owner, request_id, conversation_id, principal, footprint, position::text, plan_digest
        FROM ${s}.change_subscriptions WHERE cancelled_at IS NULL AND ($1 OR NOT (footprint ? 'machinery')) AND (last_scan IS NULL OR last_scan<=now()-interval '1 second')
        ORDER BY last_scan NULLS FIRST, id FOR UPDATE SKIP LOCKED LIMIT 1`, [Boolean(this.planner)], client)).rows[0];
      if (row) await this.db.query(`UPDATE ${s}.change_subscriptions SET last_scan=now() WHERE id=$1`, [row.id], client);
      return row;
    });
    if (!claimed) return false;
    const { owner } = claimed, after = claimed.position;
    await this.db.withOwner(owner, async () => {
      if (claimed.footprint.machinery) {
        try { await this.scanMachinery(claimed, claimed.footprint.machinery); }
        catch (error) {
          // Concurrent schedule or publication changes can require a fresh snapshot. The cursor has not moved.
          if (!(error instanceof Conflict) && !['40001','40P01','55P03'].includes((error as {code?:string}).code ?? '')) throw error;
        }
        return;
      }
      const changes = await this.db.transaction(async client => {
        const through = await latestCommit(this.db, owner, client);
        return BigInt(through) > BigInt(after) ? footprintChanges(this.db, owner, claimed.footprint, client, after, through) : undefined;
      });
      if (!changes) return;
      const advance = async (client: Sql) => {
        const moved = await this.db.query(`UPDATE ${s}.change_subscriptions SET position=$3 WHERE id=$1 AND position=$2 AND cancelled_at IS NULL`,
          [claimed.id, after, changes.end], client);
        if (!moved.rowCount) throw new Conflict('The subscription moved or was cancelled');
      };
      if (!changes.types.length && !changes.links.length) {
        await this.db.transaction(advance).catch(error => { if (!(error instanceof Conflict)) throw error; });
        return;
      }
      const wake: ChangeWake = { event: 'ontology_changes', subscription: claimed.id, commits: { after, through: changes.end }, types: changes.types, links: changes.links };
      const principal = storedPrincipal.parse(claimed.principal);
      try {
        // The request ID names the window's start, so a retried or concurrent dispatch of the same window is the same task.
        await this.tasks.submit(principal, { requestId: `subscription:${claimed.id}:${after}`, message: JSON.stringify(wake), conversationId: claimed.conversation_id },
          { admit: client => advance(client) });
      } catch (error) { if (!(error instanceof Conflict)) throw error; }
    });
    return true;
  }
}
