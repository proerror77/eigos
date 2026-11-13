import { randomUUID } from 'node:crypto';
import { Conflict, digest, type Principal } from '../core/identity.js';
import { objectRefSchema } from '../ontology/schema.js';
import { validator } from '../ontology/model.js';
import { Database, type Sql } from './database.js';
import { Metadata, type PublishedOntology } from './metadata.js';
import { Access, TaskResult } from './access.js';
import { Actions } from './actions.js';
import { Objects } from './objects.js';
import { Tasks, type Task } from './tasks.js';
import { Clarification } from './clarification.js';

export type ScheduledCall = {
  scheduleId: string;
  action: string;
  arguments: Record<string, unknown>;
  deadline: string;
  contract: string;
};
export class DeferredExecution extends Error {
  constructor(readonly until: string) {
    super('Scheduled check will resume');
  }
}
const actionContract = (model: PublishedOntology, name: string) => {
  const action = model.action(name);
  return digest({
    action,
    functions: [action.function, ...action.submissionCriteria.map((c) => c.function)]
      .filter((n): n is string => !!n)
      .map((n) => ({ definition: model.functions.get(n), binding: model.bindings.functions[n] })),
  });
};
/** Future business work does not pin an old runtime for days. Admission checks
 * the exact action contract against the active release when the due task starts. */
export class ScheduledActions {
  constructor(
    private readonly db: Database,
    private readonly metadata = new Metadata(db),
  ) {}
  async enqueue(
    graph: Objects,
    job: {
      id: string;
      action: string;
      arguments: Record<string, unknown>;
      runAt: string;
      deadline: string;
      sourceTaskId?: string;
    },
  ) {
    if (graph.model.scenario) throw new Conflict('Scenarios cannot schedule external execution');
    const start = Date.parse(job.runAt),
      end = Date.parse(job.deadline);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= Date.now() ||
      end <= start ||
      end > Date.now() + 31 * 86400000
    )
      throw new Conflict('Use a bounded future execution window');
    graph.access.action(graph.model, job.action);
    validator(graph.model.action(job.action).parameters).parse(job.arguments);
    if (job.sourceTaskId) {
      const original = await this.db.query(
        `SELECT 1 FROM ${this.db.schema}.tasks WHERE id=$1 AND owner=$2`,
        [job.sourceTaskId, graph.owner],
        graph.client,
      );
      if (!original.rowCount) throw new Conflict('Original task owner mismatch');
    }
    const body = {
      action: job.action,
      arguments: job.arguments,
      contract: actionContract(graph.model, job.action),
      sourceTaskId: job.sourceTaskId ?? null,
      plannedRelease: graph.model.release,
    };
    const prior = (
      await this.db.query(
        `SELECT body,run_at,deadline FROM ${this.db.schema}.scheduled_actions WHERE owner=$1 AND id=$2`,
        [graph.owner, job.id],
        graph.client,
      )
    ).rows[0];
    if (prior) {
      if (
        digest(prior.body) !== digest(body) ||
        new Date(prior.run_at).getTime() !== start ||
        new Date(prior.deadline).getTime() !== end
      )
        throw new Conflict('Scheduled operation already has different input');
      return;
    }
    await this.db.query(
      `INSERT INTO ${this.db.schema}.scheduled_actions(id,owner,body,scopes,run_at,deadline) VALUES($1,$2,$3,$4,$5,$6)`,
      [job.id, graph.owner, body, JSON.stringify(graph.access.principal.scopes), job.runAt, job.deadline],
      graph.client,
    );
    await this.db.query("SELECT pg_notify('eigos_tasks','scheduled')", [], graph.client);
  }
  async promoteOne(): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const model = await this.metadata.active('Eigos', client, true);
      const expired = await this.db.query(
        `WITH due AS(SELECT t.id FROM ${this.db.schema}.tasks t JOIN ${this.db.schema}.scheduled_actions s ON s.task_id=t.id AND s.owner=t.owner
        WHERE s.state='started' AND s.deadline<=now() AND t.state IN('submitted','working','input-required') FOR UPDATE OF t SKIP LOCKED LIMIT 100)
        UPDATE ${this.db.schema}.tasks t SET state='canceled',error='Scheduled execution window expired',token=NULL,lease_until=NULL,updated_at=now() FROM due WHERE t.id=due.id RETURNING t.id`,
        [],
        client,
      );
      if (expired.rows.length)
        await this.db.query(
          `UPDATE ${this.db.schema}.scheduled_actions SET state='expired',error='Execution window expired; inspect the original external operation' WHERE task_id=ANY($1::uuid[])`,
          [expired.rows.map((row) => row.id)],
          client,
        );
      await this.db.query(
        `UPDATE ${this.db.schema}.scheduled_actions SET state='expired',error='Execution window expired before dispatch' WHERE state='scheduled' AND deadline<=now()`,
        [],
        client,
      );
      const row = (
        await this.db.query(
          `SELECT * FROM ${this.db.schema}.scheduled_actions WHERE state='scheduled' AND run_at<=now() ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1`,
          [],
          client,
        )
      ).rows[0];
      if (!row) return false;
      const fail = async (reason: string) => {
        await this.db.query(
          `UPDATE ${this.db.schema}.scheduled_actions SET state='blocked',error=$2 WHERE id=$1 AND owner=$3`,
          [row.id, reason, row.owner],
          client,
        );
        return true;
      };
      if (new Date(row.deadline).getTime() <= Date.now()) return fail('Execution window expired');
      const principal = { owner: row.owner, scopes: row.scopes } as Principal;
      try {
        const access = await Access.load(this.db, principal, client);
        access.action(model, row.body.action);
        if (actionContract(model, row.body.action) !== row.body.contract)
          return fail('Published action contract changed; review and authorize a new plan');
      } catch {
        return fail('Current action or permissions are unavailable');
      }
      const taskId = randomUUID(),
        requestId = `schedule:${row.id}`;
      const input = {
        requestId,
        message: `Execute scheduled Action ${row.body.action}`,
        scheduledAction: {
          scheduleId: row.id,
          action: row.body.action,
          arguments: row.body.arguments,
          deadline: new Date(row.deadline).toISOString(),
          contract: row.body.contract,
        },
      };
      await this.db.query(
        `INSERT INTO ${this.db.schema}.tasks(id,owner,request_id,input_digest,input,release,scopes) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [taskId, row.owner, requestId, digest(input), input, model.release, JSON.stringify(row.scopes)],
        client,
      );
      await this.db.query(
        `UPDATE ${this.db.schema}.scheduled_actions SET state='started',task_id=$2 WHERE id=$1 AND owner=$3`,
        [row.id, taskId, row.owner],
        client,
      );
      await this.db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
      return true;
    });
  }
  async current(task: Task, client: Sql = this.db.pool) {
    const call = task.input.scheduledAction;
    if (!call) throw new Conflict('Not a scheduled Action task');
    const row = (
      await this.db.query(
        `SELECT 1 FROM ${this.db.schema}.scheduled_actions WHERE id=$1 AND owner=$2 AND task_id=$3 AND state='started' AND deadline>now()`,
        [call.scheduleId, task.owner, task.id],
        client,
      )
    ).rows[0];
    if (!row) throw new Conflict('Scheduled Action was canceled or expired');
  }
  async continueAt(graph: Objects, task: Task, until: string) {
    await this.current(task, graph.client);
    const end = Date.parse(task.input.scheduledAction!.deadline),
      when = Date.parse(until);
    if (!Number.isFinite(when) || when <= Date.now() || when >= end)
      throw new Conflict('Continuation is outside the authorized execution window');
    await this.db.query(
      `UPDATE ${this.db.schema}.scheduled_actions SET continue_at=$3 WHERE owner=$1 AND id=$2 AND task_id=$4`,
      [graph.owner, task.input.scheduledAction!.scheduleId, until, task.id],
      graph.client,
    );
  }
  async inspect(principal: Principal, id: string) {
    const row = (
      await this.db.query(
        `SELECT s.id,s.state,s.run_at,s.deadline,s.task_id,coalesce(s.error,t.error) AS error,s.body,t.state AS task_state FROM ${this.db.schema}.scheduled_actions s LEFT JOIN ${this.db.schema}.tasks t ON t.id=s.task_id AND t.owner=s.owner WHERE s.owner=$1 AND s.id=$2`,
        [principal.owner, id],
      )
    ).rows[0];
    if (!row) throw new Conflict('Scheduled operation unavailable');
    return {
      id: row.id,
      state: row.state === 'started' ? row.task_state : row.state,
      runAt: row.run_at,
      deadline: row.deadline,
      taskId: row.task_id,
      sourceTaskId: row.body.sourceTaskId,
      error: row.error,
    };
  }
  async cancel(graph: Objects, id: string) {
    if (graph.model.scenario) throw new Conflict('Cancel execution on the live plan');
    const row = (
      await this.db.query(
        `SELECT task_id FROM ${this.db.schema}.scheduled_actions WHERE id=$1 AND owner=$2 AND state IN('scheduled','started','blocked')`,
        [id, graph.owner],
        graph.client,
      )
    ).rows[0];
    if (!row) throw new Conflict('Scheduled operation unavailable');
    if (row.task_id)
      await this.db.query(
        `UPDATE ${this.db.schema}.tasks SET state='canceled',token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND owner=$2 AND state IN('submitted','working','input-required')`,
        [row.task_id, graph.owner],
        graph.client,
      );
    await this.db.query(
      `UPDATE ${this.db.schema}.scheduled_actions SET state='canceled',continue_at=NULL WHERE id=$1 AND owner=$2`,
      [id, graph.owner],
      graph.client,
    );
    const effect = (
      await this.db.query(
        `SELECT state FROM ${this.db.schema}.external_operations WHERE owner=$1 AND operation_key=$2`,
        [graph.owner, id],
        graph.client,
      )
    ).rows[0];
    return { externalEffect: effect?.state ?? 'not_dispatched' };
  }
}

export class ScheduledActionRunner {
  constructor(
    private readonly db: Database,
    private readonly metadata: Metadata,
    private readonly tasks: Tasks,
    private readonly actions: Actions,
  ) {}
  async run(task: Task, signal: AbortSignal) {
    const call = task.input.scheduledAction;
    if (!call) throw new Conflict('Scheduled Action is required');
    const schedules = new ScheduledActions(this.db, this.metadata),
      model = await this.metadata.get(task.release),
      access = await Access.load(this.db, { owner: task.owner, scopes: task.scopes });
    if (actionContract(model, call.action) !== call.contract) throw new Conflict('Scheduled Action contract changed');
    const guard = async (client: Sql) => {
      await this.tasks.current(task, client);
      await schedules.current(task, client);
    };
    await guard(this.db.pool);
    let ref;
    try {
      ref = objectRefSchema.parse(
        await this.actions.apply(
          access,
          model,
          call.action,
          call.arguments,
          `${call.scheduleId}:step:${task.execution_step ?? 0}`,
          guard,
          { task, tasks: this.tasks },
          signal,
        ),
      );
    } catch (error) {
      if (error instanceof Clarification)
        throw new Clarification(error.message, error.choices, access.dataRequirements());
      throw error;
    }
    const continuation = (
      await this.db.query(`SELECT continue_at FROM ${this.db.schema}.scheduled_actions WHERE owner=$1 AND id=$2`, [
        task.owner,
        call.scheduleId,
      ])
    ).rows[0]?.continue_at;
    if (continuation)
      throw new DeferredExecution(
        new Date(Math.max(Date.now() + 1000, new Date(continuation).getTime())).toISOString(),
      );
    return new TaskResult({ operation: ref, scheduleId: call.scheduleId }, access.dataRequirements());
  }
}
