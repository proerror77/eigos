import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, digest, type Principal } from '../core/identity.js';
import { Access, type Requirement } from './access.js';
import type { Database, Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';

export async function initializeEffects(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.action_effects (
    id text PRIMARY KEY, owner text NOT NULL, request_id text NOT NULL, release text NOT NULL REFERENCES ${db.schema}.releases(digest),
    ontology text NOT NULL, action text NOT NULL, name text NOT NULL, handler text NOT NULL, payload jsonb NOT NULL,
    requirements jsonb NOT NULL, scopes jsonb NOT NULL, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
    token uuid, lease_until timestamptz, available_at timestamptz NOT NULL DEFAULT now(), error text,
    created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
    UNIQUE(owner,request_id,name));
    CREATE INDEX IF NOT EXISTS action_effects_queue ON ${db.schema}.action_effects(state,available_at);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='${db.schema}.action_effects'::regclass
        AND conname='action_effects_committed_action_fkey') THEN
        ALTER TABLE ${db.schema}.action_effects ADD CONSTRAINT action_effects_committed_action_fkey
          FOREIGN KEY(owner,request_id) REFERENCES ${db.schema}.actions(owner,request_id) NOT VALID;
      END IF;
    END $$;`);
}
export interface EffectContext { idempotencyKey: string; principal: Principal; signal: AbortSignal }
export type EffectHandler = (payload: Record<string, unknown>, context: EffectContext) => Promise<void | 'canceled'>;
export interface ActionEffect { name: string; handler: string; payload: Record<string, unknown> }
export class Effects {
  constructor(private readonly db: Database, private readonly handlers: ReadonlyMap<string, EffectHandler>) {}
  check(names: readonly string[]) {
    for (const name of names) if (!this.handlers.has(name)) throw new Error(`Action effect handler is unavailable: ${name}`);
  }
  async enqueue(client: Sql, access: Access, model: PublishedOntology, action: string, requestId: string, effects: ActionEffect[]) {
    if (model.scenario || !effects.length) return;
    this.check(effects.map(effect => effect.handler));
    const requirements=await access.finalRequirements(client);
    for (const effect of effects) {
      const id = digest([access.principal.owner, requestId, effect.name]);
      await this.db.query(`INSERT INTO ${this.db.schema}.action_effects(id,owner,request_id,release,ontology,action,name,handler,payload,requirements,scopes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, access.principal.owner, requestId, model.release, model.document.id, action, effect.name, effect.handler, effect.payload, JSON.stringify(requirements),
        JSON.stringify(access.principal.memberAccess ? { scopes: access.principal.scopes, memberAccess: true } : access.principal.scopes)], client);
    }
  }
  async status(access: Access, requestId: string) {
    z.string().min(1).max(128).parse(requestId);
    const rows = (await this.db.query(`SELECT id,ontology,action,name,handler,state,attempts,error,created_at,completed_at FROM ${this.db.schema}.action_effects WHERE owner=$1 AND request_id=$2 ORDER BY name`, [access.principal.owner, requestId])).rows;
    for (const row of rows) access.require(row.ontology, 'apply_action', `${row.ontology}/action/${row.action}`);
    await access.refresh(); return rows;
  }
  async retry(access: Access, id: string) {
    z.string().regex(/^[a-f0-9]{64}$/).parse(id);
    return this.db.transaction(async client => {
      const row = (await this.db.query(`SELECT * FROM ${this.db.schema}.action_effects WHERE id=$1 AND owner=$2 FOR UPDATE`, [id, access.principal.owner], client)).rows[0];
      if (!row || row.state !== 'failed') throw new Conflict('Only a failed owned effect can be retried');
      access.require(row.ontology, 'apply_action', `${row.ontology}/action/${row.action}`);
      if (!await access.canReturn(row.requirements,client)) throw new Error('Effect data permissions changed');
      for (const requirement of row.requirements as Requirement[]) access.require(requirement.ontology, requirement.permission, requirement.resource);
      await access.refresh(client);
      await this.db.query(`UPDATE ${this.db.schema}.action_effects SET state='pending',available_at=now(),error=NULL WHERE id=$1`, [id], client);
      return { id, state: 'pending' };
    });
  }
  async runOne(signal = AbortSignal.timeout(30000)): Promise<boolean> {
    signal.throwIfAborted();
    const token = randomUUID();
    const claim = await this.db.transaction(async client => {
      const selected = (await this.db.query<{ id: string; owner: string }>(`SELECT id,owner FROM ${this.db.schema}.action_effects
        WHERE (state='pending' AND available_at<=now()) OR (state='working' AND lease_until<now())
        ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [], client)).rows[0];
      if (!selected) return undefined;
      await this.db.query(`UPDATE ${this.db.schema}.action_effects SET state='working',token=$3,lease_until=now()+interval '60 seconds',attempts=attempts+1
        WHERE id=$1 AND owner=$2`, [selected.id, selected.owner, token], client);
      return selected;
    });
    if (!claim) return false;
    const lease = [claim.id, claim.owner, token];
    const controller = new AbortController();
    const executionSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(45000)]);
    let renew: Promise<unknown> | undefined;
    const timer = setInterval(() => {
      if (renew) return;
      renew = this.db.query(`UPDATE ${this.db.schema}.action_effects SET lease_until=now()+interval '60 seconds'
        WHERE id=$1 AND owner=$2 AND token=$3 AND state='working' RETURNING id`, lease)
        .then(result => { if (!result.rowCount) controller.abort(); }).catch(() => controller.abort()).finally(() => { renew = undefined; });
    }, 15000);
    timer.unref();
    try {
      await this.db.withOwner(claim.owner, async () => {
        const row = (await this.db.query(`SELECT effect.scopes,effect.requirements,effect.handler,effect.payload
          FROM ${this.db.schema}.action_effects effect
          JOIN ${this.db.schema}.actions committed
            ON committed.owner=effect.owner AND committed.request_id=effect.request_id
            AND committed.action=effect.action AND committed.release=effect.release
          WHERE effect.id=$1 AND effect.owner=$2 AND effect.token=$3 AND effect.state='working' AND effect.lease_until>now()`, lease)).rows[0];
        if (!row) throw new Conflict('Effect lease is unavailable');
        const identity = z.object({ scopes: z.array(z.string()), memberAccess: z.literal(true).optional() })
          .parse(Array.isArray(row.scopes) ? { scopes: row.scopes } : row.scopes);
        const principal = { owner: claim.owner, ...identity };
        const access = await Access.load(this.db, principal);
        if (!await access.canReturn(row.requirements)) throw new Error('Effect data permissions changed');
        for (const requirement of row.requirements as Requirement[]) access.require(requirement.ontology, requirement.permission, requirement.resource);
        this.check([row.handler]);
        executionSignal.throwIfAborted();
        const outcome = await this.handlers.get(row.handler)!(row.payload, { idempotencyKey: claim.id, principal, signal: executionSignal });
        executionSignal.throwIfAborted();
        await this.db.query(`UPDATE ${this.db.schema}.action_effects SET state=$4,completed_at=now(),lease_until=NULL,token=NULL,error=NULL
          WHERE id=$1 AND owner=$2 AND token=$3`, [...lease, outcome === 'canceled' ? 'canceled' : 'completed']);
      });
    } catch {
      // A handler can have completed remotely before a local failure. Retries always retain its idempotency key.
      await this.db.query(`UPDATE ${this.db.schema}.action_effects SET state='failed',lease_until=NULL,token=NULL,error='Effect delivery failed; inspect the configured handler before retrying'
        WHERE id=$1 AND owner=$2 AND token=$3`, lease);
    } finally { clearInterval(timer); await renew; }
    return true;
  }
}
