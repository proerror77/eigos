import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest, requireScope, type Principal } from '../core/identity.js';
import { validator } from '../ontology/model.js';
import { Clarification } from './clarification.js';
import { Tasks, type Task } from './tasks.js';

export const paResponseSchema = z.strictObject({ requestId: z.uuid(), response: z.record(z.string(), z.unknown()) });

/** The authenticated original PA supplies requested context; the model cannot impersonate it. */
export class PARequests {
  constructor(private readonly tasks: Tasks) {}
  async request(task: Task, operation: string, capability: string, input: Record<string, unknown>, responseSchema: Record<string, unknown>) {
    const { db } = this.tasks, request = { capability, input, responseSchema }, key = digest({ operation, request });
    const row = await db.transaction(async client => {
      await this.tasks.current(task, client, true);
      await db.query(`INSERT INTO ${db.schema}.pa_requests(id,task_id,owner,request_key,request) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id,request_key) DO NOTHING`, [randomUUID(), task.id, task.owner, key, request], client);
      return (await db.query(`SELECT id,response FROM ${db.schema}.pa_requests WHERE task_id=$1 AND request_key=$2 AND owner=$3`, [task.id, key, task.owner], client)).rows[0]!;
    });
    if (row.response !== null) return validator(responseSchema).parse(row.response);
    throw new Clarification('Please ask the user’s PA to provide the requested authorized information.', {
      kind: 'pa-request', taskId: task.id, requestId: row.id, ...request,
    });
  }
  async respond(principal: Principal, taskId: string, raw: unknown) {
    requireScope(principal, 'tasks:write'); requireScope(principal, 'tasks:read'); z.uuid().parse(taskId);
    const input = paResponseSchema.parse(raw), { db } = this.tasks;
    await db.transaction(async client => {
      const task = (await db.query(`SELECT * FROM ${db.schema}.tasks WHERE owner=$1 AND id=$2 FOR UPDATE`, [principal.owner, taskId], client)).rows[0];
      if (!task) throw new NotFound('Task is unavailable');
      const row = (await db.query(`SELECT * FROM ${db.schema}.pa_requests WHERE owner=$1 AND task_id=$2 AND id=$3 FOR UPDATE`, [principal.owner, taskId, input.requestId], client)).rows[0];
      if (!row) throw new NotFound('PA request is unavailable');
      const response = validator(row.request.responseSchema).parse(input.response), fingerprint = digest(response);
      if (row.response_digest) {
        if (row.response_digest !== fingerprint) throw new Conflict('PA response was already supplied with different content');
        return;
      }
      if (task.state !== 'input-required' || task.result?.kind !== 'pa-request' || task.result?.requestId !== input.requestId) throw new Conflict('The original task is not waiting for this PA response');
      await db.query(`UPDATE ${db.schema}.pa_requests SET response=$2,response_digest=$3 WHERE id=$1`, [input.requestId, response, fingerprint], client);
      await db.query(`UPDATE ${db.schema}.tasks SET state='submitted',result=NULL,error=NULL,updated_at=now() WHERE id=$1`, [taskId], client);
      await db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
    });
    return this.tasks.get(principal, taskId);
  }
}
