import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest, requireScope, type Principal } from '../core/identity.js';
import { validator } from '../ontology/model.js';
import { ActionPARequestRequired, PARequestRequired, type ActionInputPurpose } from './clarification.js';
import { recordActionConfirmation } from './action-confirmation.js';
import { Metadata } from './metadata.js';
import { Tasks, type Task } from './tasks.js';
import { Access, type Requirement } from './access.js';
import { observePAResponse } from './decision-evidence.js';
import type { Sql } from './database.js';

export const paDispatchClaimSchema = z.strictObject({ requestId: z.uuid() });
export const paResponseSchema = paDispatchClaimSchema.extend({
  response: z.record(z.string(), z.unknown()), dispatchToken: z.uuid().optional(),
});

export type PADispatch = {
  expiresAt: string;
  operationKey: string;
  responseWithoutDispatch: Record<string, unknown>;
};
type ActionInput = { actionRequestId: string; purpose: ActionInputPurpose; dispatch?: PADispatch };
export const paInboxSchema=z.strictObject({cursor:z.uuid().optional(),limit:z.number().int().min(1).max(50).default(20)});

/** The authenticated original PA supplies requested context; the model cannot impersonate it. */
export class PARequests {
  constructor(private readonly tasks: Tasks) {}
  async pending(principal:Principal,raw:unknown={}){
    requireScope(principal,'tasks:read');const input=paInboxSchema.parse(raw),{db}=this.tasks,access=await Access.load(db,principal);
    let after:{created_at:Date;id:string}|undefined;
    if(input.cursor){after=(await db.query(`SELECT created_at,id FROM ${db.schema}.pa_requests WHERE owner=$1 AND id=$2`,[principal.owner,input.cursor])).rows[0] as typeof after;if(!after)throw new NotFound('PA request cursor is unavailable');}
    const rows=(await db.query(`SELECT r.id,r.created_at,t.id AS task_id,t.result,t.result_permissions,s.id AS schedule_id,s.body->>'sourceTaskId' AS source_task_id
      FROM ${db.schema}.pa_requests r JOIN ${db.schema}.tasks t ON t.id=r.task_id AND t.owner=r.owner
      LEFT JOIN ${db.schema}.scheduled_actions s ON s.task_id=t.id AND s.owner=t.owner
      WHERE r.owner=$1 AND r.response IS NULL AND t.state='input-required' AND t.result->>'requestId'=r.id::text
        AND ($2::timestamptz IS NULL OR (r.created_at,r.id)>($2::timestamptz,$3::uuid)) ORDER BY r.created_at,r.id LIMIT $4`,[principal.owner,after?.created_at??null,after?.id??null,input.limit+1])).rows;
    const page=rows.slice(0,input.limit);
    await access.refresh();
    const items=[];
    for(const row of page)if(Array.isArray(row.result_permissions)&&await access.canReturn(row.result_permissions))items.push({taskId:row.task_id,sourceTaskId:row.source_task_id??null,scheduleId:row.schedule_id??null,request:row.result});
    return {items,cursor:rows.length>input.limit?page.at(-1)!.id:undefined};
  }
  async requestActionInput(
    task: Task, actionRequestId: string, round: string, capability: string, purpose: ActionInputPurpose,
    input: Record<string, unknown>, responseSchema: Record<string, unknown>,
  ) {
    try {
      return (await this.requestWithId(task, digest([actionRequestId, round]), capability, input, responseSchema,
        undefined, undefined, { actionRequestId, purpose })).response;
    } catch (error) {
      if (error instanceof PARequestRequired)
        throw new ActionPARequestRequired(error.message, error.choices, error.permissions, purpose);
      throw error;
    }
  }
  async request(task: Task, operation: string, capability: string, input: Record<string, unknown>, responseSchema: Record<string, unknown>, dataScope?: Record<string, unknown>) {
    return (await this.requestWithId(task, operation, capability, input, responseSchema, dataScope)).response;
  }
  async requestWithId(task: Task, operation: string, capability: string, input: Record<string, unknown>, responseSchema: Record<string, unknown>,
    dataScope?: Record<string, unknown>, beforeDispatch?: (client: Sql) => Promise<void>,
    actionInput?: ActionInput) {
    if (task.cognitive_context && capability !== 'calendar.freebusy')
      throw new Conflict('Workflow proposals may request PA calendar availability only');
    const { db } = this.tasks, request = { capability, input, responseSchema, ...actionInput };
    // Data identity is independent of a model's wording or Action request ID.
    const key = digest(dataScope ? { capability, dataScope, responseSchema } : { operation, request });
    const row = await db.transaction(async client => {
      await this.tasks.current(task, client, true);
      const inserted = await db.query(`INSERT INTO ${db.schema}.pa_requests(id,task_id,owner,request_key,request) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id,request_key) DO NOTHING`, [randomUUID(), task.id, task.owner, key, request], client);
      if (inserted.rowCount) await beforeDispatch?.(client);
      return (await db.query(`SELECT id,response,created_at FROM ${db.schema}.pa_requests WHERE task_id=$1 AND request_key=$2 AND owner=$3`, [task.id, key, task.owner], client)).rows[0]!;
    });
    if (row.response !== null) {
      const response = validator(responseSchema).parse(row.response);
      observePAResponse(db, task, String(row.id), digest(row.response));
      return { requestId: String(row.id), requestedAt: row.created_at as Date, response };
    }
    const { dispatch: _dispatch, ...publicRequest } = request;
    throw new PARequestRequired('Please ask the user’s PA to provide the requested authorized information.', {
      kind: 'pa-request', taskId: task.id, requestId: row.id, ...publicRequest,
    });
  }
  private async lockTask(principal: Principal, taskId: string, client: Sql) {
    const { db } = this.tasks;
    const task = (await db.query<Task>(`SELECT * FROM ${db.schema}.tasks
      WHERE owner=$1 AND id=$2 FOR UPDATE`, [principal.owner, taskId], client)).rows[0];
    if (!task) throw new NotFound('Task is unavailable');
    if (task.input.paClient && principal.clientId !== task.input.paClient)
      throw new NotFound('The PA request belongs to the original client');
    return task;
  }
  private async lockRequest(principal: Principal, taskId: string, requestId: string, client: Sql) {
    const { db } = this.tasks;
    const row = (await db.query(`SELECT * FROM ${db.schema}.pa_requests
      WHERE owner=$1 AND task_id=$2 AND id=$3 FOR UPDATE`, [principal.owner, taskId, requestId], client)).rows[0];
    if (!row) throw new NotFound('PA request is unavailable');
    return row;
  }
  private async responseAccess(principal: Principal, task: Task, client: Sql) {
    const access = await Access.load(this.tasks.db, principal, client);
    if (!task.result_permissions || !await access.canReturn(task.result_permissions, client))
      throw new Conflict('The original PA request is no longer authorized');
    return access;
  }

  /** One successful transaction grants dispatch for one pending authorized request. A lost claim is never reissued. */
  async claimDispatch(principal: Principal, taskId: string, raw: unknown, authorize?: (client: Sql) => Promise<void>) {
    requireScope(principal, 'tasks:write'); requireScope(principal, 'tasks:read'); z.uuid().parse(taskId);
    const { requestId } = paDispatchClaimSchema.parse(raw), { db } = this.tasks;
    return db.transaction(async client => {
      await authorize?.(client);
      const task = await this.lockTask(principal, taskId, client);
      const row = await this.lockRequest(principal, taskId, requestId, client);
      const result = task.result as { kind?: string; requestId?: string } | null;
      const wait = task.input.placeContinuation, dispatch = row.request.dispatch as PADispatch | undefined;
      if (!dispatch || task.state !== 'input-required' || result?.kind !== 'pa-request' ||
          result.requestId !== requestId || row.response_digest ||
          wait?.waitingFor !== 'pa-request' || wait.pending?.id !== requestId ||
          wait.requestId !== row.request.actionRequestId || wait.pending.capability !== row.request.capability ||
          wait.pending.purpose !== 'execution-result' || row.request.purpose !== wait.pending.purpose)
        throw new Conflict('The original Action has no pending dispatch to claim');
      if (row.request.dispatchClaim) throw new Conflict('The original PA dispatch has already been claimed');
      const access = await this.responseAccess(principal, task, client);
      const metadata = new Metadata(db);
      const model = await metadata.get(task.release, client);
      if ((await metadata.active(model.document.id, client)).release !== task.release)
        throw new Conflict('The original Action publication changed');
      access.action(model, wait.action);
      const dispatchToken = randomUUID();
      const claimed = await db.query(`UPDATE ${db.schema}.pa_requests
        SET request=jsonb_set(request,'{dispatchClaim}',jsonb_build_object(
          'tokenHash',$2::text,'claimedAt',clock_timestamp()),true)
        WHERE id=$1 AND NOT(request ? 'dispatchClaim') AND clock_timestamp() < $3::timestamptz
          AND EXISTS (SELECT 1 FROM ${db.schema}.external_operations op
            WHERE op.owner=$4 AND op.task_id=$5 AND op.request_id=$6 AND op.operation_key=$7
              AND op.state='dispatched')`,
        [requestId, digest(dispatchToken), dispatch.expiresAt, principal.owner, taskId, wait.requestId, dispatch.operationKey], client);
      if (!claimed.rowCount) throw new Conflict('The original PA dispatch is no longer available');
      return { dispatchToken };
    });
  }
  async respond(principal: Principal, taskId: string, raw: unknown, conversationId?: string, authorize?: (client: Sql) => Promise<void>) {
    requireScope(principal, 'tasks:write'); requireScope(principal, 'tasks:read'); z.uuid().parse(taskId);
    const input = paResponseSchema.parse(raw), { db } = this.tasks;
    await db.transaction(async client => {
      await authorize?.(client);
      const task = await this.lockTask(principal, taskId, client);
      if (conversationId !== undefined && conversationId !== (task.conversation_id ?? taskId)) throw new Conflict('Conversation does not match the original task');
      const row = await this.lockRequest(principal, taskId, input.requestId, client);
      const response = validator(row.request.responseSchema).parse(input.response), fingerprint = digest(response);
      const dispatch = row.request.dispatch as PADispatch | undefined;
      const claim = row.request.dispatchClaim;
      if (claim ? !input.dispatchToken || digest(input.dispatchToken) !== claim.tokenHash
        : input.dispatchToken || dispatch && !validator(dispatch.responseWithoutDispatch).safeParse(response).success)
        throw new Conflict('The PA response requires the original dispatch claim');
      if (row.response_digest) {
        if (row.response_digest !== fingerprint) throw new Conflict('PA response was already supplied with different content');
        return;
      }
      const wait = task.input.placeContinuation;
      if (row.request.legacy === true) {
        if (task.state !== 'input-required' || wait?.pending?.id !== input.requestId ||
            wait.requestId !== row.request.actionRequestId || wait.pending.capability !== row.request.capability ||
            wait.pending.purpose !== row.request.purpose)
          throw new Conflict('The original Action is not waiting for this input');
        await this.tasks.resumeInput(principal, task, response, client);
        await db.query(`UPDATE ${db.schema}.pa_requests SET response=$2,response_digest=$3 WHERE id=$1`,
          [input.requestId, response, fingerprint], client);
        return;
      }
      const result = task.result as { kind?: string; requestId?: string } | null;
      if (task.state !== 'input-required' || result?.kind !== 'pa-request' || result.requestId !== input.requestId)
        throw new Conflict('The original task is not waiting for this PA response');
      const access = await this.responseAccess(principal, task, client);
      const continuation = task.input.placeContinuation;
      if (continuation?.waitingFor === 'pa-request') {
        if (continuation.pending && (continuation.pending.id !== input.requestId ||
            continuation.pending.capability !== row.request.capability) ||
            row.request.actionRequestId !== undefined && (row.request.actionRequestId !== continuation.requestId ||
              row.request.purpose !== continuation.pending?.purpose))
          throw new Conflict('PA response does not match the original Action and purpose');
        const model = await new Metadata(db).get(task.release, client);
        await recordActionConfirmation(db, model, access, task, client, continuation, 'confirmed');
      }
      await db.query(`UPDATE ${db.schema}.pa_requests SET response=$2,response_digest=$3 WHERE id=$1`, [input.requestId, response, fingerprint], client);
      await db.query(`UPDATE ${db.schema}.tasks SET state='submitted',result=NULL,error=NULL,updated_at=now() WHERE id=$1`, [taskId], client);
      await db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
    });
    return this.tasks.get(principal, taskId);
  }
}
