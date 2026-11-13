import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest, requireScope, type Principal } from '../core/identity.js';
import type { Sql } from './database.js';
import { Database } from './database.js';
import { Metadata } from './metadata.js';
import { objectRefSchema } from '../ontology/schema.js';
import { Access, type Requirement } from './access.js';
import type { ScheduledCall } from './scheduled-actions.js';
import { Clarification } from './clarification.js';
import { publicHotelTaskResult, workflowReplaySchema } from './hotel-workflows.js';

export const routeInputSchema = z.strictObject({ city: z.string().min(1).max(100), origin: z.string().min(1).max(500), destination: z.string().min(1).max(500), serviceClass: z.string().min(1).max(100).optional() });
export type RouteInput = z.infer<typeof routeInputSchema>;
export const placeSelectionSchema = z.strictObject({ origin: objectRefSchema, destination: objectRefSchema });
export const submitSchema = z.strictObject({ requestId: z.string().min(1).max(128), message: z.string().min(1).max(4000), route: routeInputSchema.optional(),
  learnHotelWorkflow: z.literal(true).optional(), replayHotelWorkflow: workflowReplaySchema.optional(),
});
const storedInputSchema = submitSchema.extend({ places: placeSelectionSchema.optional() });
export interface Task { id: string; owner: string; request_id: string; input: z.infer<typeof storedInputSchema> & {scheduledAction?:ScheduledCall}; release: string; scopes: string[]; state: string; token: string | null; result: unknown; result_permissions?: Requirement[] | null; error: string | null; created_at: Date; updated_at: Date; execution_step?:number }
export const publicTask = (task: Task) => ({ id: task.id, state: task.state, result: publicHotelTaskResult(task.result), error: task.error, createdAt: task.created_at, updatedAt: task.updated_at });
export class Tasks {
  constructor(readonly db: Database, private readonly metadata: Metadata) {}
  async submit(principal: Principal, raw: unknown): Promise<Task> {
    requireScope(principal, 'tasks:write');
    const input = submitSchema.parse(raw);
    if (input.learnHotelWorkflow && input.replayHotelWorkflow) throw new Conflict('Choose learning or replay for this task');
    const fingerprint = digest(input);
    const task = await this.db.transaction(async client => {
      const model = await this.metadata.active('Eigos', client, true);
      await this.db.query(`INSERT INTO ${this.db.schema}.tasks(id,owner,request_id,input_digest,input,release,scopes) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner,request_id) DO NOTHING`, [randomUUID(), principal.owner, input.requestId, fingerprint, input, model.release, JSON.stringify(principal.scopes)], client);
      const result = await this.db.query(`SELECT * FROM ${this.db.schema}.tasks WHERE owner=$1 AND request_id=$2`, [principal.owner, input.requestId], client);
      if (result.rows[0]!.input_digest !== fingerprint) throw new Conflict('Request ID already used with different input');
      await this.db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
      return result.rows[0] as Task;
    });
    return this.visible(principal, task);
  }
  private async visible(principal: Principal, task: Task): Promise<Task> {
    if (task.result !== null && (!task.result_permissions || !await (await Access.load(this.db, principal)).canReturn(task.result_permissions))) return { ...task, result: null, error: 'Result access is unavailable' };
    return task;
  }
  async get(principal: Principal, id: string): Promise<Task> {
    requireScope(principal, 'tasks:read'); z.uuid().parse(id);
    const result = await this.db.query(`SELECT * FROM ${this.db.schema}.tasks WHERE owner=$1 AND id=$2`, [principal.owner, id]);
    if (!result.rows[0]) throw new NotFound('Task is unavailable');
    return this.visible(principal, result.rows[0] as Task);
  }
  async cancel(principal: Principal, id: string): Promise<Task> {
    requireScope(principal, 'tasks:write'); z.uuid().parse(id);
    const result = await this.db.query(`UPDATE ${this.db.schema}.tasks SET state='canceled',token=NULL,lease_until=NULL,updated_at=now() WHERE owner=$1 AND id=$2 AND state IN('submitted','working','input-required') RETURNING *`, [principal.owner, id]);
    if (!result.rows[0]) throw new Conflict('Task is unavailable or already terminal');
    return this.visible(principal, result.rows[0] as Task);
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
    const result = await this.db.query(`WITH next AS(SELECT id FROM ${this.db.schema}.tasks WHERE (state='submitted' AND available_at<=now()) OR(state='working' AND lease_until<now()) ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
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
  async defer(task:Task,until:string){
    if(!task.input.scheduledAction||Date.parse(until)<=Date.now()||Date.parse(until)>=Date.parse(task.input.scheduledAction.deadline))throw new Conflict('Invalid scheduled continuation');
    await this.db.transaction(async client=>{
      await this.current(task,client,true);
      await this.db.query(`UPDATE ${this.db.schema}.tasks SET state='submitted',available_at=$2,execution_step=execution_step+1,token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`,[task.id,until],client);
      await this.db.query(`UPDATE ${this.db.schema}.scheduled_actions SET continue_at=NULL WHERE owner=$1 AND id=$2 AND task_id=$3`,[task.owner,task.input.scheduledAction!.scheduleId,task.id],client);
    });
  }
  async finish(task: Task, state: 'completed' | 'failed' | 'input-required', result: unknown, error?: string, permissions: Requirement[] = []) {
    await this.db.transaction(async client => {
      await this.current(task, client, true);
      if (result !== null && !await (await Access.load(this.db, { owner: task.owner, scopes: task.scopes }, client)).canReturn(permissions, client)) throw new Conflict('Result permissions changed');
      await this.db.query(`UPDATE ${this.db.schema}.tasks SET state=$2,result=$3,error=$4,result_permissions=$5,token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [task.id, state, result ?? null, error ?? null, JSON.stringify(permissions)], client);
    });
  }
  async source<T>(task: Task, name: string, input: unknown, invoke: () => Promise<T>): Promise<T> {
    const fingerprint = digest(input);
    const prior = await this.db.transaction(async client => {
      await this.current(task, client, true);
      const row = await this.db.query(`SELECT state,input_digest,result FROM ${this.db.schema}.source_calls WHERE task_id=$1 AND name=$2`, [task.id, name], client);
      if (row.rows[0]) {
        if (row.rows[0].input_digest !== fingerprint) throw new Conflict('Original source call has different input');
        if(row.rows[0].state==='completed')return { result: row.rows[0].result as T };
        if(row.rows[0].state!=='waiting_pa')throw new Conflict('Original source call has an unresolved result');
        await this.db.query(`UPDATE ${this.db.schema}.source_calls SET state='running' WHERE task_id=$1 AND name=$2`,[task.id,name],client);
        return undefined;
      }
      await this.db.query(`INSERT INTO ${this.db.schema}.source_calls(task_id,name,state,input_digest) VALUES($1,$2,'running',$3)`, [task.id, name, fingerprint], client);
      return undefined;
    });
    if (prior) return prior.result;
    let result:T;
    try{result=await invoke();}catch(error){
      // An authenticated PA request suspends a read before data is available.
      // Its durable pa_requests row owns continuation; it is not an unknown
      // provider mutation or a completed/empty source read.
      if(error instanceof Clarification)await this.db.query(`UPDATE ${this.db.schema}.source_calls SET state='waiting_pa' WHERE task_id=$1 AND name=$2 AND state='running' AND input_digest=$3`,[task.id,name,fingerprint]);
      throw error;
    }
    await this.db.transaction(async client => {
      await this.current(task, client, true);
      await this.db.query(`UPDATE ${this.db.schema}.source_calls SET state='completed',result=$3 WHERE task_id=$1 AND name=$2`, [task.id, name, result], client);
    });
    return result;
  }
}
