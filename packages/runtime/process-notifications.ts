import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, PermissionDenied } from '../core/identity.js';
import { processLogTarget } from '../ontology/process-definition.js';
import { objectRefSchema, type ObjectRef } from '../ontology/schema.js';
import { Access } from './access.js';
import type { Database, Sql } from './database.js';
import type { Metadata } from './metadata.js';
import { Objects } from './objects.js';
import { processTriggerSchema } from './process-automation.js';
import { readProcessTransitions } from './process-logs.js';

/**
 * Notifications of process rules (Machinery plan, "状态与停留超时通知"). A notification rule is a process rule whose
 * reaction is a message to its owner instead of a workflow or an Action. Its scan queues one notification per committed
 * transition, due when the transition happens or, for a dwell rule, once the dwell has passed. The Indexer delivers due
 * notifications to the owner's inbox, which the workbench and the owner's PA read, if the instance is still where the
 * transition left it; otherwise it drops them. A transition never notifies twice: the queue is unique per rule, revision
 * and transition, like workflow runs.
 */
export const notifySchema = z.strictObject({ message: z.string().min(1).max(500).optional() });
export const notificationsSchema = z.strictObject({
  unread: z.boolean().default(false),
  cursor: z.string().regex(/^[0-9]+\|[0-9a-f-]{36}$/).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const readNotificationSchema = z.strictObject({ id: z.uuid() });

export async function initializeProcessNotifications(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.process_notifications (
      id uuid PRIMARY KEY, owner text NOT NULL, ontology text NOT NULL, rule_id uuid NOT NULL, request_id text NOT NULL,
      object_ref jsonb NOT NULL, trigger jsonb NOT NULL, scopes jsonb NOT NULL, message text,
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','dropped')), reason text,
      available_at timestamptz NOT NULL, delivered_at timestamptz, read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (owner, request_id));
    CREATE INDEX IF NOT EXISTS process_notifications_due ON ${db.schema}.process_notifications(available_at) WHERE state='pending';
    CREATE INDEX IF NOT EXISTS process_notifications_inbox ON ${db.schema}.process_notifications(owner, delivered_at DESC, id)
      WHERE state='delivered';`);
}

export type QueuedNotification = {
  owner: string; ontology: string; ruleId: string; requestId: string; object: ObjectRef;
  trigger: z.output<typeof processTriggerSchema>; scopes: readonly string[]; message: string | undefined; availableAt: Date;
};

/** Queues a notification in the transaction of the rule scan that found its transition. */
export async function queueNotification(db: Database, client: Sql, item: QueuedNotification) {
  await db.query(`INSERT INTO ${db.schema}.process_notifications(id,owner,ontology,rule_id,request_id,object_ref,trigger,scopes,message,available_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (owner,request_id) DO NOTHING`,
  [randomUUID(), item.owner, item.ontology, item.ruleId, item.requestId, item.object, item.trigger, JSON.stringify(item.scopes),
    item.message ?? null, item.availableAt], client);
}

type Row = { id: string; owner: string; ontology: string; rule_id: string; object_ref: unknown; trigger: unknown; scopes: unknown;
  message: string | null; available_at: Date; delivered_at: Date | null; read_at: Date | null; delivered_us?: string };
/** Delivery time in microseconds, exact, which orders the inbox with the id. */
const deliveredUs = '(extract(epoch FROM delivered_at)*1000000)::bigint';

export class ProcessNotifications {
  constructor(private readonly db: Database, private readonly metadata: Metadata) {}

  /**
   * Delivers one due notification, or drops it: when the rule's owner can no longer read the instance, or a dwell rule's
   * instance left the state before the dwell passed. Returns whether there was one.
   */
  async deliverOne(): Promise<boolean> {
    return this.db.transaction(async client => {
      const row = (await this.db.query<Row>(`SELECT * FROM ${this.db.schema}.process_notifications
        WHERE state='pending' AND available_at<=now() ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [], client)).rows[0];
      if (!row) return false;
      const settle = async (state: 'delivered' | 'dropped', reason?: string) => this.db.query(`UPDATE ${this.db.schema}.process_notifications
        SET state=$2, reason=$3, delivered_at=CASE WHEN $2='delivered' THEN now() END WHERE id=$1`, [row.id, state, reason ?? null], client);
      await this.db.query('SAVEPOINT notification', [], client);
      try {
        await this.db.setOwner(client, row.owner);
        const model = await this.metadata.active(row.ontology, client, true);
        const access = await Access.load(this.db, { owner: row.owner, scopes: z.array(z.string()).parse(row.scopes) }, client);
        const trigger = processTriggerSchema.parse(row.trigger), object = objectRefSchema.parse(row.object_ref);
        const target = processLogTarget(model, trigger.process.type);
        if (!target) throw new NotFound('The process of this rule is unavailable');
        const current = await new Objects(this.db, model, access, client).read(object);
        if (trigger.process.dwellSeconds) {
          const [latest] = await readProcessTransitions(this.db, model, row.owner, target, client, { latestFor: object.id });
          if (latest?.sequence !== trigger.sequence || current.properties[target.property] !== trigger.process.to)
            throw new Conflict('The instance left the state before the dwell passed');
        }
        await this.db.query('RELEASE SAVEPOINT notification', [], client);
        await settle('delivered');
      } catch (error) {
        if (!(error instanceof NotFound || error instanceof PermissionDenied || error instanceof Conflict)) throw error;
        await this.db.query('ROLLBACK TO SAVEPOINT notification', [], client);
        await settle('dropped', error.message);
      }
      return true;
    });
  }

  /** The caller's delivered notifications, newest first. */
  async list(access: Access, raw: unknown) {
    const input = notificationsSchema.parse(raw);
    const [at, id] = input.cursor ? input.cursor.split('|') as [string, string] : [];
    const rows = (await this.db.query<Row>(`SELECT *, ${deliveredUs}::text AS delivered_us FROM ${this.db.schema}.process_notifications
      WHERE owner=$1 AND state='delivered' AND ($2::boolean IS FALSE OR read_at IS NULL)
        AND ($3::bigint IS NULL OR (${deliveredUs},id) < ($3::bigint,$4::uuid))
      ORDER BY ${deliveredUs} DESC, id DESC LIMIT $5`,
    [access.principal.owner, input.unread, at ?? null, id ?? null, input.limit + 1])).rows;
    const items = rows.slice(0, input.limit).map(row => {
      const trigger = processTriggerSchema.parse(row.trigger);
      return { id: row.id, rule: row.rule_id, object: objectRefSchema.parse(row.object_ref), process: trigger.process,
        sequence: trigger.sequence, message: row.message, dueAt: row.available_at, deliveredAt: row.delivered_at, readAt: row.read_at };
    });
    const last = rows.length > input.limit ? rows[input.limit - 1]! : undefined;
    return { items, cursor: last ? `${last.delivered_us}|${last.id}` : null };
  }

  /** Marks one of the caller's notifications as read. */
  async read(access: Access, raw: unknown) {
    const { id } = readNotificationSchema.parse(raw);
    const { rowCount } = await this.db.query(`UPDATE ${this.db.schema}.process_notifications SET read_at=coalesce(read_at,now())
      WHERE id=$1 AND owner=$2 AND state='delivered'`, [id, access.principal.owner]);
    if (!rowCount) throw new NotFound('Notification is unavailable');
    return { id, read: true };
  }
}
