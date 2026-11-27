import { applyLegacyActionInput, legacyActionInput } from './legacy-action-input.js';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { Conflict, NotFound, SourceReadFailure, digest, requireScope, type Principal } from '../core/identity.js';
import type { Sql } from './database.js';
import { Database } from './database.js';
import { Metadata, type PublishedOntology } from './metadata.js';
import { Access, type Requirement } from './access.js';
import type { ScheduledCall } from './scheduled-actions.js';
import type { CognitiveContext } from './cognitive-workflow.js';
import { Clarification, taskInputAnswerSchema, placeAmendmentSchema, actionContinuationSchema, placeSelectionSchema, type ActionContinuation } from './clarification.js';
import { recordActionConfirmation } from './action-confirmation.js';
export { placeAmendmentSchema, placeSelectionSchema, taskInputAnswerSchema, taskPlaceAmendmentSchema } from './clarification.js';
import { parseSubmission, storedInputSchema, taskActionSchema, taskOptions } from './task-input.js';
export { routeInputSchema, submitSchema, type RouteInput } from './task-input.js';

export interface Task { id: string; owner: string; request_id: string; input: z.infer<typeof storedInputSchema> & {scheduledAction?:ScheduledCall}; release: string; scopes: string[]; state: string; token: string | null; result: unknown; result_permissions?: Requirement[] | null; error: string | null; created_at: Date; available_at?: Date; updated_at: Date; execution_step?:number; conversation_id?: string | null; cognitive_context?: CognitiveContext | null }
type InboxTask = Task & { conversation_batch: string; message_count: number; collecting: boolean };
const batchWindowMs = 2000;
const maxBatchMessages = 16;
const maxBatchLength = 16000;
const claimContended = Symbol('claim contended');
const maxClaimAttempts = 4;
const headOfConversation = (table: string) => `NOT EXISTS (
  SELECT 1 FROM ${table} sibling WHERE sibling.owner=t.owner AND sibling.conversation_id=t.conversation_id
    AND sibling.id<>t.id AND sibling.state IN('submitted','working','input-required')
    AND ((sibling.state='working' AND (
      t.state='submitted' OR sibling.lease_until>=now() OR sibling.conversation_batch<t.conversation_batch
    )) OR (
      t.state='submitted' AND sibling.conversation_batch<t.conversation_batch
      AND (sibling.state='submitted' OR (
        sibling.state='input-required' AND sibling.input#>>'{placeContinuation,waitingFor}' IS DISTINCT FROM 'retry-source'
      ))
    )))`;

export const taskPrincipal = (task: Task): Principal =>
  ({ owner: task.owner, scopes: task.scopes, memberAccess: task.input.memberAccess });
export const currentTaskExecution = new AsyncLocalStorage<{ task: Task; tasks: Tasks }>();
export type TaskResultProjection = (result: unknown) => unknown;
export const publicTask = (task: Task, project: TaskResultProjection) => {
  const wait = task.input.placeContinuation;
  const pending = task.state === 'input-required' && task.result != null ? wait?.pending : undefined;
  const legacy = pending && wait ? legacyActionInput(wait) : undefined;
  return { id: task.id, ...(task.conversation_id ? { conversationId: task.conversation_id } : {}),
    state: task.state, result: project(task.result), error: task.error, createdAt: task.created_at, updatedAt: task.updated_at,
    ...(pending && wait ? { inputRequest: { requestId: pending.id, purpose: pending.purpose,
      ...(legacy ? { responseSchema: legacy.responseSchema } : {}) } } : {}) };
};
export class Tasks {
  /**
   * `ownerSlots` is how many interactive tasks of one owner may run at once across all Workers (runtime budget 06.1), from
   * EIGOS_TASK_OWNER_SLOTS, 2 by default.
   */
  constructor(readonly db: Database, private readonly metadata: Metadata,
    private readonly ownerSlots = Math.max(1, Number(process.env.EIGOS_TASK_OWNER_SLOTS ?? 2) || 2)) {}
  async submit(principal: Principal, raw: unknown, { assignConversation = false, authorize, actionInvocation, expectedRelease, admit }: {
    assignConversation?: boolean; authorize?: (client: Sql) => Promise<void>; actionInvocation?: z.infer<typeof taskActionSchema>;
    expectedRelease?: string; admit?: (client: Sql, model: PublishedOntology) => Promise<void>;
  } = {}): Promise<Task> {
    requireScope(principal, 'tasks:write');
    const input = parseSubmission(raw);
    const invocation = actionInvocation && taskActionSchema.parse(actionInvocation);
    const fingerprint = digest(invocation ? { ...input, actionInvocation: invocation } : input);
    const stored = { ...input, ...(principal.memberAccess ? { memberAccess: true, paClient: principal.clientId } : {}),
      ...(invocation ? { actionInvocation: invocation } : {}) };
    const task = await this.db.transaction(async client => {
      await authorize?.(client);
      const table = `${this.db.schema}.tasks`, events = `${this.db.schema}.task_inbox_events`;
      const { owner } = principal;
      // The same delivery may arrive through any gateway, including from a different process.
      await this.lockInboxKey(client, ['request', owner, input.requestId]);
      const existing = (await this.db.query(`SELECT t.*,e.input_digest AS event_digest FROM ${events} e
        JOIN ${table} t ON t.id=e.task_id AND t.owner=e.owner WHERE e.owner=$1 AND e.request_id=$2`, [owner, input.requestId], client)).rows[0];
      const prior = existing ?? (await this.db.query(`SELECT * FROM ${table} WHERE owner=$1 AND request_id=$2`, [owner, input.requestId], client)).rows[0];
      if (prior) {
        if ((prior.event_digest ?? prior.input_digest) !== fingerprint) throw new Conflict('Request ID already used with different input');
        return prior as Task;
      }
      const model = await this.metadata.active('Eigos', client, true);
      if (expectedRelease !== undefined && model.release !== expectedRelease)
        throw new Conflict('The Eigos publication changed. Rediscover the Action before retrying.');
      await admit?.(client, model);
      const id = randomUUID();
      const conversation = input.conversationId ?? (assignConversation ? id : null);
      const scopes = [...principal.scopes];
      let latest: InboxTask | undefined;
      if (conversation) {
        await this.lockInboxKey(client, ['conversation', owner, conversation]);
        latest = (await this.db.query<InboxTask>(`SELECT *,state='submitted' AND available_at>clock_timestamp() AS collecting FROM ${table}
          WHERE owner=$1 AND conversation_id=$2 ORDER BY conversation_batch DESC LIMIT 1`, [owner, conversation], client)).rows[0];
      }
      let submitted: Task | undefined, position = 1;
      if (!invocation && !latest?.input.actionInvocation && latest?.collecting && latest.message_count < maxBatchMessages && latest.release === model.release
          && digest([...new Set(latest.scopes)].sort()) === digest([...new Set(scopes)].sort())
          && latest.input.message.length + 1 + input.message.length <= maxBatchLength
          && Boolean(latest.input.memberAccess) === Boolean(principal.memberAccess)
          && latest.input.paClient === ('paClient' in stored ? stored.paClient : undefined)
          && digest(taskOptions.parse(latest.input)) === digest(taskOptions.parse(input))) {
        const merged = { ...latest.input, message: `${latest.input.message}\n${input.message}` };
        submitted = (await this.db.query<Task>(`UPDATE ${table} SET input=$2,input_digest=$3,message_count=$4,updated_at=clock_timestamp()
          WHERE id=$1 AND state='submitted' AND available_at>clock_timestamp() RETURNING *`,
          [latest.id, merged, digest(merged), latest.message_count + 1], client)).rows[0];
        if (submitted) position = latest.message_count + 1;
      }
      if (!submitted) {
        const batch = conversation ? (BigInt(latest?.conversation_batch ?? '0') + 1n).toString() : null;
        submitted = (await this.db.query<Task>(`INSERT INTO ${table}(id,owner,request_id,input_digest,input,release,scopes,conversation_id,conversation_batch,available_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+$10::int*interval '1 ms') ON CONFLICT(owner,request_id) DO NOTHING RETURNING *`,
          [id, owner, input.requestId, fingerprint, stored, model.release, JSON.stringify(scopes), conversation, batch, conversation ? batchWindowMs : 0], client)).rows[0];
        if (!submitted) throw new Conflict('Request ID already used with different input');
      }
      if (conversation) await this.db.query(`INSERT INTO ${events}(owner,request_id,input_digest,message,task_id,position) VALUES($1,$2,$3,$4,$5,$6)`,
        [owner, input.requestId, fingerprint, input.message, submitted.id, position], client);
      await this.db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
      return submitted;
    });
    return this.visible(principal, task);
  }
  private async lockInboxKey(client: Sql, key: string[]) {
    await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [this.db.lockKey('task-inbox', ...key)], client);
  }
  async visible(principal: Principal, task: Task): Promise<Task> {
    if (task.owner !== principal.owner) throw new NotFound('Task is unavailable');
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
    const task = await this.db.transaction(async client => {
      const result = await this.db.query<Task>(`UPDATE ${this.db.schema}.tasks SET state='canceled',token=NULL,lease_until=NULL,updated_at=now() WHERE owner=$1 AND id=$2 AND state IN('submitted','working','input-required') RETURNING *`, [principal.owner, id], client);
      const canceled = result.rows[0];
      if (!canceled) throw new Conflict('Task is unavailable or already terminal');
      const continuation = canceled.input.placeContinuation;
      if (continuation) {
        const model = await this.metadata.get(canceled.release, client);
        await recordActionConfirmation(this.db, model, await Access.load(this.db, principal, client), canceled, client, continuation, 'canceled');
      }
      if (canceled.conversation_id) await this.db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
      return canceled;
    });
    return this.visible(principal, task);
  }
  selectPlaces(principal: Principal, id: string, input: unknown): Promise<Task> {
    return this.continueTaskInput(principal, id, { kind: 'select', places: placeSelectionSchema.parse(input) });
  }
  amendPlace(principal: Principal, id: string, input: unknown): Promise<Task> {
    return this.continueTaskInput(principal, id, { kind: 'amend', amendment: placeAmendmentSchema.parse(input) });
  }
  answerInput(principal: Principal, id: string, input: unknown): Promise<Task> {
    return this.continueTaskInput(principal, id, taskInputAnswerSchema.parse(input));
  }
  async resumeInput(principal: Principal, task: Task, response: unknown, client: Sql) {
    if (task.input.paClient && task.input.paClient !== principal.clientId)
      throw new NotFound('The Action input belongs to the original client');
    const access = await Access.load(this.db, principal, client);
    if (!task.result_permissions || !await access.canReturn(task.result_permissions, client))
      throw new Conflict('Task input permissions changed');
    const nextInput = applyLegacyActionInput(task, response);
    const continuation = task.input.placeContinuation;
    if (continuation) {
      const model = await this.metadata.get(task.release, client);
      await recordActionConfirmation(this.db, model, access, task, client, continuation, 'confirmed');
    }
    const changed = await this.db.query<Task>(`UPDATE ${this.db.schema}.tasks SET input=$2::jsonb,
      state='submitted',error=NULL,result=NULL,result_permissions=NULL,execution_step=execution_step+1,
      available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [task.id, JSON.stringify(nextInput)], client);
    await this.db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
    return changed.rows[0]!;
  }
  private async continueTaskInput(
    principal: Principal, id: string, response: unknown,
  ): Promise<Task> {
    requireScope(principal, 'tasks:write'); z.uuid().parse(id);
    return this.db.transaction(async client => {
      const table = `${this.db.schema}.tasks`;
      const task = (await this.db.query<Task>(`SELECT * FROM ${table} WHERE owner=$1 AND id=$2 AND state='input-required' FOR UPDATE`,
        [principal.owner, id], client)).rows[0];
      if (!task) throw new Conflict('The task is not waiting for input');
      const resumed = await this.resumeInput(principal, task, response, client);
      const pending = task.input.placeContinuation?.pending;
      if (pending) await this.db.query(`UPDATE ${this.db.schema}.pa_requests SET response=$2,response_digest=$3
        WHERE id=$1 AND response_digest IS NULL`, [pending.id, response, digest(response)], client);
      return resumed;
    });
  }
  async claim(lane?: 'scheduled' | 'interactive'): Promise<Task | undefined> {
    for (let attempt = 0; attempt < maxClaimAttempts; attempt++) {
      const task = await this.claimOnce(lane);
      if (task !== claimContended) return task;
      // Start a fresh transaction so the rejected task and its owner no longer hold locks.
    }
    return undefined;
  }
  private async claimOnce(lane?: 'scheduled' | 'interactive'): Promise<Task | typeof claimContended | undefined> {
    const scheduled = "t.input ? 'scheduledAction'";
    const kind = lane === 'scheduled' ? ` AND ${scheduled}` : lane === 'interactive' ? ` AND NOT (${scheduled})` : '';
    const table = `${this.db.schema}.tasks`;
    const atHead = `(t.conversation_id IS NULL OR ${headOfConversation(table)})`;
    const running = (owner: string) => `(SELECT count(*) FROM ${table} w WHERE w.owner=${owner} AND w.state='working'
      AND w.lease_until>=clock_timestamp() AND NOT (w.input ? 'scheduledAction'))`;
    const withinShare = lane === 'scheduled' ? '' : ` AND ((${scheduled}) OR ${running('t.owner')}<$1)`;
    return this.db.transaction(async client => {
      // Owners take turns (06.2). Only interactive tasks are subject to the per-owner slot limit (06.1).
      const candidate = (await this.db.query<Pick<Task, 'id' | 'owner' | 'conversation_id'> & { scheduled: boolean; turn_served_at: string | null }>(
        `SELECT t.id,t.owner,t.conversation_id,(${scheduled}) AS scheduled,turn.served_at::text AS turn_served_at
        FROM ${table} t LEFT JOIN ${this.db.schema}.task_turns turn ON turn.owner=t.owner
        WHERE ((t.state='submitted' AND t.available_at<=now()) OR (t.state='working' AND t.lease_until<now()))
          AND ${atHead}${kind}${withinShare}
        ORDER BY coalesce(turn.served_at,'-infinity'::timestamptz),t.available_at,t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT 1`,
        lane === 'scheduled' ? [] : [this.ownerSlots], client)).rows[0];
      if (!candidate) return undefined;
      if (!candidate.scheduled) {
        // Serialize interactive claims for the same owner across Workers, then recheck its share.
        await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [this.db.lockKey('task-owner-claim', candidate.owner)], client);
        const { rows: [current] } = await this.db.query<{ n: string; turn_served_at: string | null }>(
          `SELECT ${running('$1')}::text AS n, (SELECT served_at::text FROM ${this.db.schema}.task_turns
            WHERE owner=$1) AS turn_served_at`, [candidate.owner], client);
        // A concurrent claim may have filled this owner's share or moved it behind other waiting owners.
        if (Number(current!.n) >= this.ownerSlots || current!.turn_served_at !== candidate.turn_served_at) return claimContended;
      }
      if (candidate.conversation_id) {
        // A paused source retry can rejoin while another Worker is selecting a later batch.
        const key = this.db.lockKey('task-inbox-claim', candidate.owner, candidate.conversation_id);
        const lock = await this.db.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [key], client);
        if (!lock.rows[0]!.acquired) return undefined;
      }
      // Recheck in a fresh statement after taking the conversation lock.
      const result = await this.db.query<Task>(`UPDATE ${table} t SET state='working',token=$2,
        lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
        WHERE t.id=$1 AND ${atHead} RETURNING t.*`, [candidate.id, randomUUID()], client);
      if (result.rows[0]) await this.db.query(`INSERT INTO ${this.db.schema}.task_turns(owner,served_at) VALUES($1,clock_timestamp())
        ON CONFLICT (owner) DO UPDATE SET served_at=excluded.served_at`, [candidate.owner], client);
      return result.rows[0];
    });
  }
  async nextInboxDelay() {
    const table = `${this.db.schema}.tasks`;
    const result = await this.db.query<{ delay_ms: number }>(`SELECT GREATEST(10,LEAST(5000,
      COALESCE(CEIL(EXTRACT(EPOCH FROM (MIN(t.available_at)-now()))*1000),5000)))::int AS delay_ms
      FROM ${table} t WHERE t.conversation_id IS NOT NULL AND t.state='submitted' AND ${headOfConversation(table)}`);
    return result.rows[0]!.delay_ms;
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
  /**
   * Puts a task back in the queue until `until`, as when its owner's budget for a provider is used up. It then runs again
   * from the start, as a task whose lease expired does; its Actions are idempotent by request.
   */
  async postpone(task: Task, until: string) {
    if (!Number.isFinite(Date.parse(until))) throw new Conflict('Invalid task retry time');
    await this.db.transaction(async client => {
      await this.current(task, client, true);
      await this.db.query(`UPDATE ${this.db.schema}.tasks SET state='submitted',available_at=$2,token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`,
        [task.id, until], client);
    });
  }
  async finish(task: Task, state: 'completed' | 'failed' | 'input-required', result: unknown,
    error?: string, permissions: Requirement[] = [], pending?: ActionContinuation) {
    await this.db.transaction(async client => {
      await this.current(task, client, true);
      if (pending && !pending.pending) {
        const legacy = legacyActionInput(pending);
        if (legacy) {
          const id = randomUUID();
          const request = { ...legacy, actionRequestId: pending.requestId, legacy: true };
          await this.db.query(`INSERT INTO ${this.db.schema}.pa_requests(id,task_id,owner,request_key,request)
            VALUES($1,$2,$3,$4,$5)`, [id, task.id, task.owner, digest([pending.requestId, id]), request], client);
          pending = { ...pending, pending: { id, capability: legacy.capability, purpose: legacy.purpose } };
        }
      }
      const continuation = pending ?? task.input.placeContinuation;
      const access = result !== null || continuation
        ? await Access.load(this.db, taskPrincipal(task), client) : undefined;
      if (result !== null && !await access!.canReturn(permissions, client)) throw new Conflict('Result permissions changed');
      if (continuation && (state !== 'input-required' || pending)) {
        const model = await this.metadata.get(task.release, client);
        await recordActionConfirmation(this.db, model, access!, task, client, continuation, state === 'input-required' ? 'awaiting-input' : state);
      }
      await this.db.query(`UPDATE ${this.db.schema}.tasks SET state=$2,result=$3,error=$4,result_permissions=$5,token=NULL,
        lease_until=NULL,updated_at=clock_timestamp(),
        input=CASE WHEN $6::jsonb IS NULL THEN input-'placeContinuation'
          ELSE jsonb_set(input,'{placeContinuation}',$6::jsonb) END WHERE id=$1`,
        [task.id, state, result ?? null, error ?? null, JSON.stringify(permissions),
          pending ? JSON.stringify(actionContinuationSchema.parse(pending)) : null], client);
      if (task.conversation_id && (state !== 'input-required' || pending?.waitingFor === 'retry-source')) {
        await this.db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
      }
    });
  }
  async readSource<T>(task: Task, name: string, input: unknown, invoke: () => Promise<T>): Promise<T> {
    const fingerprint = digest(input);
    const prior = await this.db.transaction(async client => {
      await this.current(task, client, true);
      const row = await this.db.query(`SELECT state,input_digest,result,lease_token FROM ${this.db.schema}.source_calls WHERE task_id=$1 AND name=$2`, [task.id, name], client);
      if (row.rows[0]) {
        if (row.rows[0].input_digest !== fingerprint) throw new Conflict('Original source call has different input');
        if(row.rows[0].state==='completed')return { result: row.rows[0].result as T };
        const previous = row.rows[0];
        if (previous.state === 'failed') throw new SourceReadFailure('The original supplier read failed');
        // An interrupted read may be repeated by a new lease. External mutations use their own operation journal.
        const interrupted = previous.state === 'running' && previous.lease_token && previous.lease_token !== task.token;
        if (previous.state !== 'waiting_pa' && !interrupted) throw new Conflict('Original source call has an unresolved result');
        await this.db.query(`UPDATE ${this.db.schema}.source_calls SET state='running',lease_token=$3 WHERE task_id=$1 AND name=$2`, [task.id, name, task.token], client);
        return undefined;
      }
      await this.db.query(`INSERT INTO ${this.db.schema}.source_calls(task_id,name,state,input_digest,lease_token) VALUES($1,$2,'running',$3,$4)`, [task.id, name, fingerprint, task.token], client);
      return undefined;
    });
    if (prior) return prior.result;
    let result:T;
    try { result = await invoke(); }
    catch (error) {
      // PA reads and supplier failures are distinct. An explicit source retry
      // advances the execution step and gets a fresh read journal key.
      const state = error instanceof Clarification ? 'waiting_pa'
        : error instanceof SourceReadFailure ? 'failed' : undefined;
      if (state) await this.db.transaction(async client => {
        await this.current(task, client, true);
        await this.db.query(`UPDATE ${this.db.schema}.source_calls SET state=$4
          WHERE task_id=$1 AND name=$2 AND state='running' AND lease_token=$3`,
          [task.id, name, task.token, state], client);
      });
      throw error;
    }
    await this.db.transaction(async client => {
      await this.current(task, client, true);
      await this.db.query(`UPDATE ${this.db.schema}.source_calls SET state='completed',result=$3 WHERE task_id=$1 AND name=$2`, [task.id, name, result], client);
    });
    return result;
  }
}
