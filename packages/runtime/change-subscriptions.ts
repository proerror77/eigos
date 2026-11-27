import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical, Conflict, NotFound, requireScope, type Principal } from '../core/identity.js';
import { ontologyName } from '../ontology/schema.js';
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
    CREATE INDEX IF NOT EXISTS change_subscriptions_due ON ${db.schema}.change_subscriptions(last_scan NULLS FIRST) WHERE cancelled_at IS NULL;`);
}

export const subscribeSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  /** The conversation the wake tasks join, as a task's conversation. */
  conversationId: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u),
  types: z.array(ontologyName).max(50).default([]),
  links: z.array(ontologyName).max(50).default([]),
  /** An Object Set query whose answer the subscriber keeps: its types, and the links and types its derived properties read. */
  query: querySchema.pick({ type: true, where: true, filter: true, orderBy: true, select: true, from: true }).partial({ where: true }).optional(),
}).refine(input => input.types.length || input.links.length || input.query, 'A subscription watches at least one type, link or query');

/** The wake a subscriber receives: the commits after `after` through `through`, and what in its footprint they touched. */
export type ChangeWake = { event: 'ontology_changes'; subscription: string; commits: { after: string; through: string }; types: string[]; links: string[] };

const storedPrincipal = z.object({ owner: z.string(), scopes: z.array(z.string()), clientId: z.string().optional(), memberAccess: z.literal(true).optional() });
type Row = { ontology: string; id: string; owner: string; request_id: string; conversation_id: string; principal: unknown; footprint: ChangeFootprint; position: string };

export class ChangeSubscriptions {
  constructor(private readonly db: Database, private readonly tasks: Tasks) {}

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
    for (const type of footprint.types) { model.object(type); access.read(model, type); }
    for (const link of footprint.links) access.definition(model, 'link', link);
    const owner = access.principal.owner;
    const principal: Principal = { owner, scopes: [...access.principal.scopes], clientId: access.principal.clientId, ...(access.principal.memberAccess ? { memberAccess: true } : {}) };
    return this.db.withOwner(owner, () => this.db.transaction(async client => {
      const position = await latestCommit(this.db, owner, client);
      const row = (await this.db.query<{ id: string; position: string }>(`INSERT INTO ${this.db.schema}.change_subscriptions
          (id, owner, request_id, ontology, conversation_id, principal, footprint, position) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(owner, request_id) DO NOTHING RETURNING id, position::text`,
        [randomUUID(), owner, input.requestId, model.document.id, input.conversationId, principal, footprint, position], client)).rows[0];
      if (row) return { id: row.id, position: row.position, footprint };
      const prior = (await this.db.query<{ id: string; ontology: string; position: string; footprint: ChangeFootprint; conversation_id: string }>(
        `SELECT id, ontology, position::text, footprint, conversation_id FROM ${this.db.schema}.change_subscriptions WHERE owner=$1 AND request_id=$2`,
        [owner, input.requestId], client)).rows[0]!;
      // jsonb reorders keys, so the footprints are compared canonically.
      if (prior.ontology !== model.document.id || canonical(prior.footprint) !== canonical(footprint) || prior.conversation_id !== input.conversationId)
        throw new Conflict('Request ID already used with a different subscription');
      return { id: prior.id, position: prior.position, footprint: prior.footprint };
    }));
  }

  async cancel(access: Access, id: string) {
    z.uuid().parse(id);
    const { rowCount } = await this.db.query(`UPDATE ${this.db.schema}.change_subscriptions SET cancelled_at=now()
      WHERE id=$1 AND owner=$2 AND cancelled_at IS NULL`, [id, access.principal.owner]);
    if (!rowCount) throw new NotFound('Subscription is unavailable');
  }

  async list(access: Access) {
    return (await this.db.query(`SELECT id, request_id AS "requestId", conversation_id AS "conversationId", footprint, position::text, created_at AS "createdAt"
      FROM ${this.db.schema}.change_subscriptions WHERE owner=$1 AND cancelled_at IS NULL ORDER BY created_at, id`, [access.principal.owner])).rows;
  }

  /**
   * Checks one due subscription, at most once a second each, and reports whether it claimed one. Commits that touch the
   * footprint wake the subscriber with their window; other commits only advance its position. The position moves only
   * from the value read, in the transaction that submits the wake, so concurrent dispatchers deliver each window once.
   */
  async scanOne(): Promise<boolean> {
    const s = this.db.schema;
    const claimed = await this.db.transaction(async client => {
      const row = (await this.db.query<Row>(`SELECT id, ontology, owner, request_id, conversation_id, principal, footprint, position::text
        FROM ${s}.change_subscriptions WHERE cancelled_at IS NULL AND (last_scan IS NULL OR last_scan<=now()-interval '1 second')
        ORDER BY last_scan NULLS FIRST, id FOR UPDATE SKIP LOCKED LIMIT 1`, [], client)).rows[0];
      if (row) await this.db.query(`UPDATE ${s}.change_subscriptions SET last_scan=now() WHERE id=$1`, [row.id], client);
      return row;
    });
    if (!claimed) return false;
    const { owner } = claimed, after = claimed.position;
    await this.db.withOwner(owner, async () => {
      const changes = await this.db.transaction(async client => {
        const through = await latestCommit(this.db, owner, client);
        return BigInt(through) > BigInt(after) ? footprintChanges(this.db, owner, claimed.footprint, client, after, through, claimed.ontology) : undefined;
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
          { ontologyId: claimed.ontology, admit: client => advance(client) });
      } catch (error) { if (!(error instanceof Conflict)) throw error; }
    });
    return true;
  }
}
