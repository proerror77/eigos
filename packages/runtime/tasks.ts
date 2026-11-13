import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest, requireScope, type Principal } from '../core/identity.js';
import type { Sql } from './database.js';
import { Database } from './database.js';
import { Metadata } from './metadata.js';
import { objectRefSchema } from '../ontology/schema.js';

export const routeInputSchema = z.strictObject({ city: z.string().min(1).max(100), origin: z.string().min(1).max(500), destination: z.string().min(1).max(500), serviceClass: z.string().min(1).max(100).optional() });
export type RouteInput = z.infer<typeof routeInputSchema>;
export const placeSelectionSchema = z.strictObject({ origin: objectRefSchema, destination: objectRefSchema });
export const submitSchema = z.strictObject({ requestId: z.string().min(1).max(128), message: z.string().min(1).max(4000), route: routeInputSchema.optional() });
const storedInputSchema = submitSchema.extend({ places: placeSelectionSchema.optional() });
export interface Task { id: string; owner: string; request_id: string; input: z.infer<typeof storedInputSchema>; release: string; scopes: string[]; state: string; token: string | null; result: unknown; error: string | null; created_at: Date; updated_at: Date }
export const publicTask = (task: Task) => ({ id: task.id, state: task.state, result: task.result, error: task.error, createdAt: task.created_at, updatedAt: task.updated_at });
export class Tasks {
  constructor(readonly db: Database, private readonly metadata: Metadata) {}
  async submit(principal: Principal, raw: unknown): Promise<Task> {
    requireScope(principal, 'tasks:write');
    const input = submitSchema.parse(raw), model = await this.metadata.active();
    const fingerprint = digest(input);
    return this.db.transaction(async client => {
      await this.db.query(`INSERT INTO ${this.db.schema}.tasks(id,owner,request_id,input_digest,input,release,scopes) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner,request_id) DO NOTHING`, [randomUUID(), principal.owner, input.requestId, fingerprint, input, model.digest, JSON.stringify(principal.scopes)], client);
      const result = await this.db.query(`SELECT * FROM ${this.db.schema}.tasks WHERE owner=$1 AND request_id=$2`, [principal.owner, input.requestId], client);
      if (result.rows[0]!.input_digest !== fingerprint) throw new Conflict('Request ID already used with different input');
      await this.db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
      return result.rows[0] as Task;
    });
  }
  async get(principal: Principal, id: string): Promise<Task> {
    requireScope(principal, 'tasks:read'); z.uuid().parse(id);
    const result = await this.db.query(`SELECT * FROM ${this.db.schema}.tasks WHERE owner=$1 AND id=$2`, [principal.owner, id]);
    if (!result.rows[0]) throw new NotFound('Task is unavailable');
    return result.rows[0] as Task;
  }
  async cancel(principal: Principal, id: string): Promise<Task> {
    requireScope(principal, 'tasks:write'); z.uuid().parse(id);
    const result = await this.db.query(`UPDATE ${this.db.schema}.tasks SET state='canceled',token=NULL,lease_until=NULL,updated_at=now() WHERE owner=$1 AND id=$2 AND state IN('submitted','working','input-required') RETURNING *`, [principal.owner, id]);
    if (!result.rows[0]) throw new Conflict('Task is unavailable or already terminal');
    return result.rows[0] as Task;
  }
  async selectPlaces(principal: Principal, id: string, input: unknown): Promise<Task> {
    requireScope(principal, 'tasks:write'); z.uuid().parse(id);
    const places = placeSelectionSchema.parse(input);
    return this.db.transaction(async client => {
      const result = await this.db.query(`UPDATE ${this.db.schema}.tasks SET input=jsonb_set(input,'{places}',$3::jsonb),state='submitted',error=NULL,result=NULL,updated_at=now()
        WHERE owner=$1 AND id=$2 AND state='input-required' RETURNING *`, [principal.owner, id, JSON.stringify(places)], client);
      if (!result.rows[0]) throw new Conflict('The task is not waiting for place selection');
      await this.db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
      return result.rows[0] as Task;
    });
  }
  async claim(): Promise<Task | undefined> {
    const result = await this.db.query(`WITH next AS(SELECT id FROM ${this.db.schema}.tasks WHERE state='submitted' OR(state='working' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE ${this.db.schema}.tasks t SET state='working',token=$1,lease_until=now()+interval '30 seconds',updated_at=now() FROM next WHERE t.id=next.id RETURNING t.*`, [randomUUID()]);
    return result.rows[0] as Task | undefined;
  }
  async current(task: Task, client: Sql = this.db.pool, lock = false) {
    const result = await this.db.query(`SELECT 1 FROM ${this.db.schema}.tasks WHERE id=$1 AND owner=$2 AND state='working' AND token=$3 AND lease_until>now()${lock ? ' FOR UPDATE' : ''}`, [task.id, task.owner, task.token], client);
    if (!result.rowCount) throw new Conflict('Task was canceled or its execution lease ended');
  }
  async renew(task: Task) {
    const result = await this.db.query(`UPDATE ${this.db.schema}.tasks SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND token=$2 AND state='working' AND lease_until>now()`, [task.id, task.token]);
    if (!result.rowCount) throw new Conflict('Execution lease ended');
  }
  async finish(task: Task, state: 'completed' | 'failed' | 'input-required', result: unknown, error?: string) {
    await this.db.transaction(async client => {
      await this.current(task, client, true);
      await this.db.query(`UPDATE ${this.db.schema}.tasks SET state=$2,result=$3,error=$4,token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [task.id, state, result ?? null, error ?? null], client);
    });
  }
  async source<T>(task: Task, name: string, input: unknown, invoke: () => Promise<T>): Promise<T> {
    const fingerprint = digest(input);
    const prior = await this.db.transaction(async client => {
      await this.current(task, client, true);
      const row = await this.db.query(`SELECT state,input_digest,result FROM ${this.db.schema}.source_calls WHERE task_id=$1 AND name=$2`, [task.id, name], client);
      if (row.rows[0]) {
        if (row.rows[0].input_digest !== fingerprint || row.rows[0].state !== 'completed') throw new Conflict('Original source call has an unresolved result');
        return { result: row.rows[0].result as T };
      }
      await this.db.query(`INSERT INTO ${this.db.schema}.source_calls(task_id,name,state,input_digest) VALUES($1,$2,'running',$3)`, [task.id, name, fingerprint], client);
      return undefined;
    });
    if (prior) return prior.result;
    const result = await invoke();
    await this.db.transaction(async client => {
      await this.current(task, client, true);
      await this.db.query(`UPDATE ${this.db.schema}.source_calls SET state='completed',result=$3 WHERE task_id=$1 AND name=$2`, [task.id, name, result], client);
    });
    return result;
  }
}
