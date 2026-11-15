import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, SourceReadFailure, digest, requireScope, type Principal } from '../core/identity.js';
import type { Sql } from './database.js';
import { Database } from './database.js';
import { Metadata } from './metadata.js';
import { classificationSchema } from '../ontology/classification.js';
import { placeDetailResult } from '../ontology/maps.js';
import { Access, type Requirement } from './access.js';
import { appendTrace } from './execution-trace.js';
import type { Functions } from './functions.js';
import { Objects } from './objects.js';
import type { ScheduledCall } from './scheduled-actions.js';
import type { CognitiveContext } from './cognitive-workflow.js';
import { Clarification, amapPlaceAmendmentSchema, cityInputSchema, mapPlaceCorrectionsSchema, rideEndpointSchema, taskInputAnswerSchema, placeAmendmentSchema, placeAmendmentsSchema, placeChoicesSchema, placeContinuationSchema, placeSelectionSchema, unresolvedMapPlace, type PlaceContinuation } from './clarification.js';
import { recordActionConfirmation } from './action-confirmation.js';
export { placeAmendmentSchema, placeSelectionSchema, taskInputAnswerSchema, taskPlaceAmendmentSchema } from './clarification.js';
import { publicHotelTaskResult, workflowReplaySchema } from './hotel-workflows.js';

export const routeInputSchema = z.strictObject({ city: z.string().min(1).max(100), origin: z.string().min(1).max(500), destination: z.string().min(1).max(500), serviceClass: z.string().min(1).max(100).optional() });
export type RouteInput = z.infer<typeof routeInputSchema>;
export const submitSchema = z.strictObject({ requestId: z.string().min(1).max(128), message: z.string().min(1).max(4000), route: routeInputSchema.optional(),
  classification: classificationSchema.optional(),
  learnHotelWorkflow: z.literal(true).optional(), replayHotelWorkflow: workflowReplaySchema.optional(),
  conversationId: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u).optional(),
});
const storedInputSchema = submitSchema.extend({
  places: placeSelectionSchema.partial().optional(),
  placeAmendments: placeAmendmentsSchema.optional(),
  mapPlaceCorrections: mapPlaceCorrectionsSchema.optional(),
  rideCity: cityInputSchema.optional(),
  rideOrigin: rideEndpointSchema.optional(),
  rideDestination: rideEndpointSchema.optional(),
  placeContinuation: placeContinuationSchema.optional(),
});
export interface Task { id: string; owner: string; request_id: string; input: z.infer<typeof storedInputSchema> & {scheduledAction?:ScheduledCall}; release: string; scopes: string[]; state: string; token: string | null; result: unknown; result_permissions?: Requirement[] | null; error: string | null; created_at: Date; updated_at: Date; execution_step?:number; conversation_id?: string | null; cognitive_context?: CognitiveContext | null }
type InboxTask = Task & { conversation_batch: string; message_count: number; collecting: boolean };
const batchWindowMs = 2000;
const maxBatchMessages = 16;
const maxBatchLength = 16000;
const headOfConversation = (table: string) => `NOT EXISTS (
  SELECT 1 FROM ${table} earlier WHERE earlier.owner=t.owner AND earlier.conversation_id=t.conversation_id
    AND earlier.conversation_batch<t.conversation_batch AND earlier.state IN('submitted','working','input-required'))`;

export const publicTask = (task: Task) => ({ id: task.id, ...(task.conversation_id ? { conversationId: task.conversation_id } : {}), state: task.state, result: publicHotelTaskResult(task.result), error: task.error, createdAt: task.created_at, updatedAt: task.updated_at });
export class Tasks {
  constructor(readonly db: Database, private readonly metadata: Metadata) {}
  async submit(principal: Principal, raw: unknown, { assignConversation = false } = {}): Promise<Task> {
    requireScope(principal, 'tasks:write');
    const input = submitSchema.parse(raw);
    if (input.learnHotelWorkflow && input.replayHotelWorkflow) throw new Conflict('Choose learning or replay for this task');
    const fingerprint = digest(input);
    const task = await this.db.transaction(async client => {
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
      if (latest?.collecting && latest.message_count < maxBatchMessages && latest.release === model.release
          && digest([...new Set(latest.scopes)].sort()) === digest([...new Set(scopes)].sort())
          && latest.input.message.length + 1 + input.message.length <= maxBatchLength
          && digest(taskOptions(latest.input)) === digest(taskOptions(input))) {
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
          [id, owner, input.requestId, fingerprint, input, model.release, JSON.stringify(scopes), conversation, batch, conversation ? batchWindowMs : 0], client)).rows[0];
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
    await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([this.db.schema, 'task-inbox', ...key])], client);
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
    const places = placeSelectionSchema.parse(input);
    return this.continueTaskInput(principal, id, task => {
      const choices = this.placeChoices(task);
      for (const side of ['origin', 'destination'] as const) {
        if (!choices[side].some(({ ref }) => ref.type === places[side].type && ref.id === places[side].id)) {
          throw new Conflict('Select places from the original task’s current candidates');
        }
      }
      return { ...task.input, places };
    });
  }
  amendPlace(principal: Principal, id: string, input: unknown): Promise<Task> {
    const { side, keep, ...amendment } = placeAmendmentSchema.parse(input);
    return this.continueTaskInput(principal, id, task => {
      const choices = this.placeChoices(task);
      if (!task.input.placeContinuation?.receipts) throw new Conflict('There is no original Action waiting for place details');
      const other = side === 'origin' ? 'destination' : 'origin';
      const selected = keep
        ? choices[other].find(({ ref }) => ref.type === keep.type && ref.id === keep.id)?.ref
        : choices[other].length === 1 ? choices[other][0]!.ref : undefined;
      if (!selected && (keep || choices[other].length)) {
        throw new Conflict('Identify the unchanged endpoint from the original task’s current candidates');
      }
      return {
        ...task.input,
        places: selected ? { [other]: selected } : {},
        placeAmendments: { ...task.input.placeAmendments, [side]: amendment },
      };
    });
  }
  async amendMapPlace(principal: Principal, id: string, raw: unknown, functions: Functions): Promise<Task> {
    requireScope(principal, 'tasks:read'); requireScope(principal, 'tasks:write'); z.uuid().parse(id);
    const input = amapPlaceAmendmentSchema.parse(raw), fingerprint = digest(input);
    const { owner } = principal, { db } = this, schema = db.schema;
    const load = async (client?: Sql) => {
      const task = (await db.query<Task>(`SELECT * FROM ${schema}.tasks WHERE owner=$1 AND id=$2${client ? ' FOR UPDATE' : ''}`,
        [owner, id], client)).rows[0];
      if (!task) throw new NotFound('Task is unavailable');
      return task;
    };
    const alreadyApplied = (task: Task) => {
      const previous = Object.values(task.input.mapPlaceCorrections ?? {}).find(place => place?.requestId === input.requestId);
      if (previous && previous.fingerprint !== fingerprint) throw new Conflict('Place correction ID was already used');
      return Boolean(previous);
    };
    const check = async (task: Task, access: Access, client?: Sql) => {
      const waiting = task.state === 'input-required' || task.state === 'canceled' && input.restoreCanceled === true;
      if (!waiting || task.result !== null || task.error !== unresolvedMapPlace ||
          task.updated_at.getTime() !== Date.parse(input.expectedUpdatedAt) || task.input.placeContinuation ||
          task.input.scheduledAction || task.input.learnHotelWorkflow || task.input.replayHotelWorkflow) {
        throw new Conflict('The original task is not waiting for this map correction');
      }
      if (!task.result_permissions || !await access.canReturn(task.result_permissions, client)) {
        throw new Conflict('Task input permissions changed');
      }
      const used = (await db.query(`SELECT 1 WHERE
        EXISTS(SELECT 1 FROM ${schema}.actions WHERE owner=$1 AND task_id=$2::uuid)
        OR EXISTS(SELECT 1 FROM ${schema}.scenario_actions WHERE owner=$1 AND task_id=$2::uuid)
        OR EXISTS(SELECT 1 FROM ${schema}.edit_history WHERE owner=$1 AND task_id=$2::text)
        OR EXISTS(SELECT 1 FROM ${schema}.external_operations WHERE owner=$1 AND task_id=$2::uuid)
        OR EXISTS(SELECT 1 FROM ${schema}.scheduled_actions WHERE owner=$1 AND (task_id=$2::uuid OR body->>'sourceTaskId'=$2::text))
        OR EXISTS(SELECT 1 FROM ${schema}.execution_trace WHERE owner=$1 AND task_id=$2::uuid AND event->>'kind' IN ('proposal','approval','merge'))`,
        [owner, id], client)).rowCount;
      if (used) throw new Conflict('A task with prior business Actions cannot use map recovery');
    };

    const task = await load();
    if (alreadyApplied(task)) return this.visible(principal, task);
    const access = await Access.load(db, principal);
    await check(task, access);
    const model = await this.metadata.active('Eigos');
    const { place } = placeDetailResult.parse(await functions.invoke(model, 'readMapPlace', { id: input.placeId }, {
      principal, objects: new Objects(db, model, access), signal: AbortSignal.timeout(15000),
    }));
    if (place.id !== input.placeId || !place.point) throw new Conflict('The selected Amap place has no verified point');

    const resumed = await db.transaction(async client => {
      const active = await this.metadata.active('Eigos', client, true);
      const current = await load(client);
      if (alreadyApplied(current)) return current;
      if (active.release !== model.release || (await this.metadata.get(current.release, client)).document.id !== active.document.id) {
        throw new Conflict('The publication changed during map correction');
      }
      await access.refresh(client);
      await check(current, access, client);
      const nextInput = { ...current.input, mapPlaceCorrections: { ...current.input.mapPlaceCorrections,
        [input.side]: { requestId: input.requestId, fingerprint, placeId: place.id, name: place.name, city: place.city } } };
      const result = (await db.query<Task>(`UPDATE ${schema}.tasks
        SET input=$2,release=$3,state='submitted',error=NULL,result=NULL,result_permissions=NULL,execution_step=execution_step+1,
          available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [id, nextInput, active.release], client)).rows[0]!;
      await appendTrace(db, { owner, taskId: id, release: active.release, projection: active.projection }, {
        kind: 'map-place-correction', side: input.side, previousRelease: current.release,
        previousState: current.state === 'canceled' ? 'canceled' : 'input-required',
      }, client, access.dataRequirements());
      await db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
      return result;
    });
    return this.visible(principal, resumed);
  }
  answerInput(principal: Principal, id: string, input: unknown): Promise<Task> {
    const answer = taskInputAnswerSchema.parse(input);
    return this.continueTaskInput(principal, id, task => {
      const waiting = z.object({ kind: z.enum(['city', 'origin', 'destination', 'retry-source']) }).safeParse(task.result);
      if (!waiting.success || waiting.data.kind !== answer.kind ||
          task.input.placeContinuation?.waitingFor !== answer.kind) {
        throw new Conflict('The original Action is not waiting for this input');
      }
      if (answer.kind === 'city') return { ...task.input, rideCity: answer.city };
      if (answer.kind === 'origin') return { ...task.input, rideOrigin: answer.place };
      if (answer.kind === 'destination') return { ...task.input, rideDestination: answer.place };
      return task.input;
    });
  }
  private placeChoices(task: Task) {
    const choices = placeChoicesSchema.safeParse(task.result);
    if (!choices.success) throw new Conflict('The original task has no place candidates');
    return choices.data;
  }
  private async continueTaskInput(
    principal: Principal, id: string, update: (task: Task) => Task['input'],
  ): Promise<Task> {
    requireScope(principal, 'tasks:write'); z.uuid().parse(id);
    return this.db.transaction(async client => {
      const table = `${this.db.schema}.tasks`;
      const task = (await this.db.query<Task>(`SELECT * FROM ${table} WHERE owner=$1 AND id=$2 AND state='input-required' FOR UPDATE`,
        [principal.owner, id], client)).rows[0];
      if (!task) throw new Conflict('The task is not waiting for input');
      const caller = await Access.load(this.db, principal, client);
      if (!task.result_permissions || !await caller.canReturn(task.result_permissions, client)) {
        throw new Conflict('Task input permissions changed');
      }
      const nextInput = update(task);
      const continuation = task.input.placeContinuation;
      if (continuation) {
        const model = await this.metadata.get(task.release, client);
        await recordActionConfirmation(this.db, model, caller, task, client, continuation, 'confirmed');
      }
      const result = await this.db.query<Task>(`UPDATE ${table} SET input=$2::jsonb,
        state='submitted',error=NULL,result=NULL,result_permissions=NULL,execution_step=execution_step+1,
        available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [task.id, JSON.stringify(nextInput)], client);
      await this.db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
      return result.rows[0]!;
    });
  }
  async claim(lane?: 'scheduled' | 'interactive'): Promise<Task | undefined> {
    const kind = lane === 'scheduled' ? " AND t.input ? 'scheduledAction'" :
      lane === 'interactive' ? " AND NOT (t.input ? 'scheduledAction')" : '';
    const table = `${this.db.schema}.tasks`;
    const result = await this.db.query<Task>(`WITH next AS(SELECT t.id FROM ${table} t
      WHERE ((t.state='submitted' AND t.available_at<=now()) OR (t.state='working' AND t.lease_until<now()))
        AND (t.conversation_id IS NULL OR ${headOfConversation(table)})${kind}
      ORDER BY t.available_at,t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT 1)
      UPDATE ${table} t SET state='working',token=$1,lease_until=now()+interval '30 seconds',updated_at=now() FROM next WHERE t.id=next.id RETURNING t.*`, [randomUUID()]);
    return result.rows[0];
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
  async finish(task: Task, state: 'completed' | 'failed' | 'input-required', result: unknown,
    error?: string, permissions: Requirement[] = [], pending?: PlaceContinuation) {
    await this.db.transaction(async client => {
      await this.current(task, client, true);
      const continuation = pending ?? task.input.placeContinuation;
      const access = result !== null || continuation
        ? await Access.load(this.db, { owner: task.owner, scopes: task.scopes }, client) : undefined;
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
          pending ? JSON.stringify(placeContinuationSchema.parse(pending)) : null], client);
      if (task.conversation_id && state !== 'input-required') await this.db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
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

function taskOptions(input: z.infer<typeof submitSchema>) {
  return { route: input.route, classification: input.classification, learnHotelWorkflow: input.learnHotelWorkflow, replayHotelWorkflow: input.replayHotelWorkflow };
}
