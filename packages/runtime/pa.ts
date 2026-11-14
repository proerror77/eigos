import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest, requireScope, type Principal } from '../core/identity.js';
import { validator } from '../ontology/model.js';
import { Clarification } from './clarification.js';
import { Tasks, type Task } from './tasks.js';
import { Access, type Requirement } from './access.js';

export const paResponseSchema = z.strictObject({ requestId: z.uuid(), response: z.record(z.string(), z.unknown()) });
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
  async request(task: Task, operation: string, capability: string, input: Record<string, unknown>, responseSchema: Record<string, unknown>, dataScope?: Record<string, unknown>) {
    return (await this.requestWithId(task, operation, capability, input, responseSchema, dataScope)).response;
  }
  async requestWithId(task: Task, operation: string, capability: string, input: Record<string, unknown>, responseSchema: Record<string, unknown>, dataScope?: Record<string, unknown>) {
    const { db } = this.tasks, request = { capability, input, responseSchema };
    // Data identity is independent of a model's wording or Action request ID.
    const key = digest(dataScope ? { capability, dataScope, responseSchema } : { operation, request });
    const row = await db.transaction(async client => {
      await this.tasks.current(task, client, true);
      await db.query(`INSERT INTO ${db.schema}.pa_requests(id,task_id,owner,request_key,request) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id,request_key) DO NOTHING`, [randomUUID(), task.id, task.owner, key, request], client);
      return (await db.query(`SELECT id,response,created_at FROM ${db.schema}.pa_requests WHERE task_id=$1 AND request_key=$2 AND owner=$3`, [task.id, key, task.owner], client)).rows[0]!;
    });
    if (row.response !== null) return { requestId: String(row.id), requestedAt: row.created_at as Date, response: validator(responseSchema).parse(row.response) };
    throw new Clarification('Please ask the user’s PA to provide the requested authorized information.', {
      kind: 'pa-request', taskId: task.id, requestId: row.id, ...request,
    });
  }
  async respond(principal: Principal, taskId: string, raw: unknown, conversationId?: string) {
    requireScope(principal, 'tasks:write'); requireScope(principal, 'tasks:read'); z.uuid().parse(taskId);
    const input = paResponseSchema.parse(raw), { db } = this.tasks;
    await db.transaction(async client => {
      const task = (await db.query(`SELECT * FROM ${db.schema}.tasks WHERE owner=$1 AND id=$2 FOR UPDATE`, [principal.owner, taskId], client)).rows[0];
      if (!task) throw new NotFound('Task is unavailable');
      if (conversationId !== undefined && conversationId !== (task.conversation_id ?? taskId)) throw new Conflict('Conversation does not match the original task');
      const row = (await db.query(`SELECT * FROM ${db.schema}.pa_requests WHERE owner=$1 AND task_id=$2 AND id=$3 FOR UPDATE`, [principal.owner, taskId, input.requestId], client)).rows[0];
      if (!row) throw new NotFound('PA request is unavailable');
      const response = validator(row.request.responseSchema).parse(input.response), fingerprint = digest(response);
      if (row.response_digest) {
        if (row.response_digest !== fingerprint) throw new Conflict('PA response was already supplied with different content');
        return;
      }
      if (task.state !== 'input-required' || task.result?.kind !== 'pa-request' || task.result?.requestId !== input.requestId) throw new Conflict('The original task is not waiting for this PA response');
      const permissions = task.result_permissions as Requirement[] | null;
      if (!permissions || !await (await Access.load(db, principal, client)).canReturn(permissions, client))
        throw new Conflict('The original PA request is no longer authorized');
      await db.query(`UPDATE ${db.schema}.pa_requests SET response=$2,response_digest=$3 WHERE id=$1`, [input.requestId, response, fingerprint], client);
      await db.query(`UPDATE ${db.schema}.tasks SET state='submitted',result=NULL,error=NULL,updated_at=now() WHERE id=$1`, [taskId], client);
      await db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
    });
    return this.tasks.get(principal, taskId);
  }
}
