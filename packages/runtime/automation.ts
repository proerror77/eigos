import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest, requireScope } from '../core/identity.js';
import { validator } from '../ontology/model.js';
import { objectRefSchema, type ObjectRef } from '../ontology/schema.js';
import { Access, PermissionDenied, type Requirement } from './access.js';
import { Database, type Sql } from './database.js';
import { Metadata, type PublishedOntology } from './metadata.js';
import type { Actions } from './actions.js';
import { Objects, querySchema } from './objects.js';

const binding = z.union([
  z.strictObject({ literal: z.unknown() }),
  z.strictObject({ property: z.string().min(1).max(500) }),
  z.strictObject({ object: z.literal(true) }),
  z.strictObject({ step: z.string().min(1).max(80) }),
]);
const step = z.strictObject({
  name: z.string().min(1).max(80),
  action: z.string().min(1).max(80),
  input: z.record(z.string(), binding),
});
export const workflowSchema = z.strictObject({
  id: z.uuid().optional(),
  revision: z.number().int().min(0).default(0),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  steps: z.array(step).min(1).max(20),
}).superRefine((workflow, context) => {
  const previous = new Set<string>();
  workflow.steps.forEach((item, index) => {
    if (previous.has(item.name)) {
      context.addIssue({ code: 'custom', message: 'Workflow step names must be unique', path: ['steps', index, 'name'] });
    }
    for (const [parameter, binding] of Object.entries(item.input)) {
      if ('step' in binding && !previous.has(binding.step)) {
        context.addIssue({
          code: 'custom', message: 'Step bindings must reference a prior named step',
          path: ['steps', index, 'input', parameter],
        });
      }
    }
    previous.add(item.name);
  });
});
export const ruleSchema = z.strictObject({
  id: z.uuid().optional(),
  revision: z.number().int().min(0).default(0),
  name: z.string().min(1).max(200),
  query: querySchema.omit({ cursor: true, limit: true, select: true }),
  workflow: z.uuid(),
  enabled: z.boolean().default(false),
});
export const runWorkflowSchema = z.strictObject({
  workflow: z.uuid(),
  object: objectRefSchema,
  requestId: z.string().min(1).max(128),
});

export async function initializeAutomation(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.workflows(id uuid PRIMARY KEY,owner text NOT NULL,ontology text NOT NULL,name text NOT NULL,body jsonb NOT NULL,revision integer NOT NULL);
    CREATE TABLE IF NOT EXISTS ${db.schema}.object_rules(id uuid PRIMARY KEY,owner text NOT NULL,ontology text NOT NULL,name text NOT NULL,body jsonb NOT NULL,revision integer NOT NULL,enabled boolean NOT NULL DEFAULT false,last_scan timestamptz,error text);
    ALTER TABLE ${db.schema}.object_rules ADD COLUMN IF NOT EXISTS scopes jsonb;
    UPDATE ${db.schema}.object_rules SET enabled=false,error='Re-save the rule to record its original authorization scopes' WHERE scopes IS NULL AND enabled;
    CREATE TABLE IF NOT EXISTS ${db.schema}.rule_matches(rule_id uuid NOT NULL REFERENCES ${db.schema}.object_rules(id),type text NOT NULL,id text NOT NULL,matched boolean NOT NULL,revision bigint NOT NULL,PRIMARY KEY(rule_id,type,id));
    ALTER TABLE ${db.schema}.rule_matches ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS ${db.schema}.workflow_runs(id uuid PRIMARY KEY,owner text NOT NULL,ontology text NOT NULL,release text NOT NULL REFERENCES ${db.schema}.releases(digest),request_id text NOT NULL,digest text NOT NULL,workflow_id uuid NOT NULL REFERENCES ${db.schema}.workflows(id),body jsonb NOT NULL,object_ref jsonb NOT NULL,scopes jsonb NOT NULL,step integer NOT NULL DEFAULT 0,state text NOT NULL DEFAULT 'pending',error text,token uuid,lease_until timestamptz,results jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner,request_id));
    CREATE TABLE IF NOT EXISTS ${db.schema}.workflow_steps(run_id uuid NOT NULL REFERENCES ${db.schema}.workflow_runs(id),position integer NOT NULL,
      action text NOT NULL,input jsonb NOT NULL,requirements jsonb NOT NULL,request_id text NOT NULL,result jsonb,completed_at timestamptz,
      PRIMARY KEY(run_id,position));
    ALTER TABLE ${db.schema}.workflow_steps ADD COLUMN IF NOT EXISTS read_markings jsonb;
    CREATE INDEX IF NOT EXISTS workflow_runs_queue ON ${db.schema}.workflow_runs(state,created_at);`);
}
const failureMessage =
  'Workflow execution failed; check current permissions, publication and Action input before retrying';
class MissingFrozenSecurityContext extends Conflict {}
const missingSecurityContextMessage =
  'Frozen input security context is unavailable; submit a new workflow run';
const revisionMatches = (id: string | undefined, revision: number) => {
  if (id ? revision < 1 : revision !== 0)
    throw new Conflict('Updates require the current revision; creates use revision zero');
};
export class Automation {
  constructor(
    private readonly db: Database,
    private readonly metadata: Metadata,
    private readonly actions: Actions,
  ) {}
  private authorize(access: Access, model: PublishedOntology, steps: z.infer<typeof step>[]) {
    for (const item of steps) {
      model.action(item.action);
      access.action(model, item.action);
    }
  }
  private async active(model: PublishedOntology, client: Sql) {
    if (
      model.scenario ||
      (await this.metadata.active(model.document.id, client, true)).release !== model.release
    )
      throw new Conflict('Automation requires the current live publication');
  }
  async workflow(access: Access, model: PublishedOntology, raw: unknown) {
    requireScope(access.principal, 'ontology:write');
    const input = workflowSchema.parse(raw);
    revisionMatches(input.id, input.revision);
    await access.refresh();
    access.require(model.document.id, 'view_definition', model.document.id);
    this.authorize(access, model, input.steps);
    if (new Set(input.steps.map((item) => item.name)).size !== input.steps.length)
      throw new Conflict('Workflow step names must be unique');
    const id = input.id ?? randomUUID();
    return this.db.transaction(async (client) => {
      await this.active(model, client);
      const result = input.id
        ? await this.db.query(
            `UPDATE ${this.db.schema}.workflows SET name=$3,body=$4,revision=revision+1 WHERE id=$1 AND owner=$2 AND revision=$5 AND ontology=$6 AND body->>'kind' IS NULL RETURNING revision`,
            [id, access.principal.owner, input.name, input, input.revision, model.document.id],
            client,
          )
        : await this.db.query(
            `INSERT INTO ${this.db.schema}.workflows(id,owner,ontology,name,body,revision) VALUES($1,$2,$3,$4,$5,1) RETURNING revision`,
            [id, access.principal.owner, model.document.id, input.name, input],
            client,
          );
      if (!result.rowCount) throw new Conflict('Workflow changed or is unavailable');
      await access.refresh(client);
      return { ...input, id, revision: Number(result.rows[0]!.revision) };
    });
  }
  async rule(access: Access, model: PublishedOntology, raw: unknown) {
    requireScope(access.principal, 'ontology:write');
    const input = ruleSchema.parse(raw);
    revisionMatches(input.id, input.revision);
    await access.refresh();
    access.require(model.document.id, 'view_definition', model.document.id);
    const id = input.id ?? randomUUID();
    return this.db.transaction(async (client) => {
      await this.active(model, client);
      const workflow = (
        await this.db.query(
          `SELECT body FROM ${this.db.schema}.workflows WHERE id=$1 AND owner=$2 AND ontology=$3 AND body->>'kind' IS NULL`,
          [input.workflow, access.principal.owner, model.document.id],
          client,
        )
      ).rows[0];
      if (!workflow) throw new NotFound('Workflow is unavailable');
      this.authorize(access, model, workflowSchema.parse(workflow.body).steps);
      for (const type of model.concreteTypes(input.query.type)) access.read(model, type);
      const result = input.id
        ? await this.db.query(
            `UPDATE ${this.db.schema}.object_rules SET name=$3,body=$4,enabled=$5,revision=revision+1,error=NULL,scopes=$8,last_scan=NULL WHERE id=$1 AND owner=$2 AND revision=$6 AND ontology=$7 RETURNING revision`,
            [
              id,
              access.principal.owner,
              input.name,
              input,
              input.enabled,
              input.revision,
              model.document.id,
              JSON.stringify(access.principal.scopes),
            ],
            client,
          )
        : await this.db.query(
            `INSERT INTO ${this.db.schema}.object_rules(id,owner,ontology,name,body,revision,enabled,scopes) VALUES($1,$2,$3,$4,$5,1,$6,$7) RETURNING revision`,
            [
              id,
              access.principal.owner,
              model.document.id,
              input.name,
              input,
              input.enabled,
              JSON.stringify(access.principal.scopes),
            ],
            client,
          );
      if (!result.rowCount) throw new Conflict('Rule changed or is unavailable');
      if (input.id)
        await this.db.query(`DELETE FROM ${this.db.schema}.rule_matches WHERE rule_id=$1`, [id], client);
      await access.refresh(client);
      return { ...input, id, revision: Number(result.rows[0]!.revision) };
    });
  }
  async list(access: Access, model: PublishedOntology, kind: 'workflows' | 'object_rules' | 'workflow_runs') {
    requireScope(access.principal, 'ontology:read');
    z.enum(['workflows', 'object_rules', 'workflow_runs']).parse(kind);
    await access.refresh();
    access.require(model.document.id, 'view_definition', model.document.id);
    const rows = (
      await this.db.query(
        `SELECT * FROM ${this.db.schema}.${kind} WHERE owner=$1 AND ontology=$2 ORDER BY id DESC LIMIT 101`,
        [access.principal.owner, model.document.id],
      )
    ).rows;
    const graph = new Objects(this.db, model, access),
      items = [];
    const visible = async (raw: unknown) => {
      try {
        const ref = objectRefSchema.parse(raw);
        await graph.read(ref);
        return ref;
      } catch (error) {
        if (error instanceof PermissionDenied || error instanceof NotFound) return null;
        throw error;
      }
    };
    for (const row of rows.slice(0, 100)) {
      if (kind === 'workflow_runs') {
        const object = await visible(row.object_ref),
          results = [];
        const receipts = (
          await this.db.query(
            `SELECT position,requirements,result FROM ${this.db.schema}.workflow_steps WHERE run_id=$1 AND result IS NOT NULL ORDER BY position`,
            [row.id],
          )
        ).rows;
        for (const receipt of receipts) {
          const allowed = await (
            await Access.load(this.db, access.principal)
          ).canReturn(receipt.requirements as Requirement[]);
          results.push({
            step: row.body.steps[receipt.position]?.name,
            object: allowed ? await visible(receipt.result) : null,
          });
        }
        items.push({
          id: row.id,
          name: row.body.name,
          object,
          state: row.state,
          step: row.step,
          stepCount: row.body.steps.length,
          error: row.error,
          results,
          createdAt: row.created_at,
        });
      } else
        items.push({
          ...row.body,
          name: row.name,
          id: row.id,
          revision: row.revision,
          enabled: row.enabled,
          lastScan: row.last_scan,
          error: row.error,
        });
    }
    await access.refresh();
    return { items, hasMore: rows.length > 100 };
  }
  async run(access: Access, model: PublishedOntology, raw: unknown) {
    requireScope(access.principal, 'ontology:write');
    const input = runWorkflowSchema.parse(raw);
    await access.refresh();
    return this.db.transaction(async (client) => {
      await this.active(model, client);
      const workflow = (
        await this.db.query(
          `SELECT body,revision FROM ${this.db.schema}.workflows WHERE id=$1 AND owner=$2 AND ontology=$3 AND body->>'kind' IS NULL`,
          [input.workflow, access.principal.owner, model.document.id],
          client,
        )
      ).rows[0];
      if (!workflow) throw new NotFound('Workflow is unavailable');
      this.authorize(access, model, workflowSchema.parse(workflow.body).steps);
      await new Objects(this.db, model, access, client).read(input.object);
      const fingerprint = digest({
        input,
        body: workflow.body,
        revision: workflow.revision,
        release: model.release,
      });
      await this.db.query(
        `INSERT INTO ${this.db.schema}.workflow_runs(id,owner,ontology,release,request_id,digest,workflow_id,body,object_ref,scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(owner,request_id) DO NOTHING`,
        [
          randomUUID(),
          access.principal.owner,
          model.document.id,
          model.release,
          input.requestId,
          fingerprint,
          input.workflow,
          workflow.body,
          input.object,
          JSON.stringify(access.principal.scopes),
        ],
        client,
      );
      const row = (
        await this.db.query(
          `SELECT id,state,digest FROM ${this.db.schema}.workflow_runs WHERE owner=$1 AND request_id=$2`,
          [access.principal.owner, input.requestId],
          client,
        )
      ).rows[0]!;
      if (row.digest !== fingerprint) throw new Conflict('Workflow request ID has different input');
      await access.refresh(client);
      return { id: String(row.id), state: String(row.state) };
    });
  }
  async scanOne(): Promise<boolean> {
    return this.db.transaction(async (client) => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], client);
      const rule = (
        await this.db.query(
          `SELECT * FROM ${this.db.schema}.object_rules WHERE enabled AND (last_scan IS NULL OR last_scan<now()-interval '30 seconds') ORDER BY last_scan NULLS FIRST FOR UPDATE SKIP LOCKED LIMIT 1`,
          [],
          client,
        )
      ).rows[0];
      if (!rule) return false;
      await this.db.query(
        `UPDATE ${this.db.schema}.object_rules SET last_scan=now() WHERE id=$1`,
        [rule.id],
        client,
      );
      await this.db.query('SAVEPOINT rule_scan', [], client);
      try {
        const scopes = z.array(z.string()).parse(rule.scopes),
          principal = { owner: String(rule.owner), scopes };
        requireScope(principal, 'ontology:write');
        const model = await this.metadata.active(rule.ontology, client, true),
          access = await Access.load(this.db, principal, client);
        const input = ruleSchema.parse(rule.body),
          workflow = (
            await this.db.query(
              `SELECT * FROM ${this.db.schema}.workflows WHERE id=$1 AND owner=$2 AND ontology=$3`,
              [input.workflow, rule.owner, rule.ontology],
              client,
            )
          ).rows[0];
        if (!workflow) throw new NotFound('Rule workflow is unavailable');
        this.authorize(access, model, workflowSchema.parse(workflow.body).steps);
        for (const type of model.concreteTypes(input.query.type)) access.read(model, type);
        const graph = new Objects(this.db, model, access, client),
          matched = new Map<string, { ref: ObjectRef; revision: number }>();
        let cursor: string | undefined;
        do {
          const page = await graph.query({ ...input.query, limit: 100, cursor });
          cursor = page.cursor;
          for (const item of page.items) {
            matched.set(digest(item.ref), item);
            if (matched.size > 10000) throw new Conflict('Rule matches more than 10000 objects');
          }
        } while (cursor);
        const previous = (
          await this.db.query(
            `SELECT * FROM ${this.db.schema}.rule_matches WHERE rule_id=$1`,
            [rule.id],
            client,
          )
        ).rows;
        const prior = new Map(previous.map((item) => [digest({ type: item.type, id: item.id }), item]));
        for (const [key, item] of matched) {
          const before = prior.get(key),
            entered = !before?.matched,
            generation = Number(before?.generation ?? 0) + (entered ? 1 : 0);
          if (entered) {
            const requestId = 'rule:' + digest([rule.id, rule.revision, item.ref, generation]);
            await this.db.query(
              `INSERT INTO ${this.db.schema}.workflow_runs(id,owner,ontology,release,request_id,digest,workflow_id,body,object_ref,scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(owner,request_id) DO NOTHING`,
              [
                randomUUID(),
                rule.owner,
                rule.ontology,
                model.release,
                requestId,
                digest([rule.id, rule.revision, item.ref, generation]),
                input.workflow,
                workflow.body,
                item.ref,
                JSON.stringify(scopes),
              ],
              client,
            );
          }
          await this.db.query(
            `INSERT INTO ${this.db.schema}.rule_matches(rule_id,type,id,matched,revision,generation) VALUES($1,$2,$3,true,$4,$5) ON CONFLICT(rule_id,type,id) DO UPDATE SET matched=true,revision=excluded.revision,generation=excluded.generation`,
            [rule.id, item.ref.type, item.ref.id, item.revision, generation],
            client,
          );
        }
        for (const [key, item] of prior)
          if (!matched.has(key))
            await this.db.query(
              `UPDATE ${this.db.schema}.rule_matches SET matched=false WHERE rule_id=$1 AND type=$2 AND id=$3`,
              [rule.id, item.type, item.id],
              client,
            );
        await access.refresh(client);
        await this.db.query('RELEASE SAVEPOINT rule_scan', [], client);
      } catch {
        await this.db.query('ROLLBACK TO SAVEPOINT rule_scan', [], client);
        await this.db.query(
          `UPDATE ${this.db.schema}.object_rules SET enabled=false,error='Rule scan failed; review permissions, publication and query before enabling it again' WHERE id=$1`,
          [rule.id],
          client,
        );
      }
      return true;
    });
  }
  async runOne(signal = AbortSignal.timeout(120000)): Promise<boolean> {
    signal.throwIfAborted();
    const token = randomUUID();
    const row = await this.db.transaction(async (client) => {
      const found = (
        await this.db.query(
          `SELECT * FROM ${this.db.schema}.workflow_runs WHERE state='pending' OR(state='working' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
          [],
          client,
        )
      ).rows[0];
      if (!found) return undefined;
      await this.db.query(
        `UPDATE ${this.db.schema}.workflow_runs SET state='working',token=$2,lease_until=now()+interval '150 seconds',updated_at=now() WHERE id=$1`,
        [found.id, token],
        client,
      );
      return found;
    });
    if (!row) return false;
    const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    const guard = async (client: Sql) => {
      executionSignal.throwIfAborted();
      if (
        !(
          await this.db.query(
            `SELECT 1 FROM ${this.db.schema}.workflow_runs WHERE id=$1 AND token=$2 AND state='working' AND lease_until>now() FOR UPDATE`,
            [row.id, token],
            client,
          )
        ).rowCount
      )
        throw new Conflict('Workflow execution lease ended');
    };
    try {
      const model = await this.metadata.get(row.release),
        access = await Access.load(this.db, { owner: row.owner, scopes: row.scopes });
      requireScope(access.principal, 'ontology:write');
      const steps = workflowSchema.parse(row.body).steps;
      for (let position = Number(row.step); position < steps.length; position++) {
        const item = steps[position]!,
          requestId = 'workflow:' + row.id + ':' + position;
        const frozen = await this.db.transaction(async (client) => {
          await guard(client);
          await this.active(model, client);
          await access.refresh(client);
          const prior = (
            await this.db.query(
              `SELECT * FROM ${this.db.schema}.workflow_steps WHERE run_id=$1 AND position=$2`,
              [row.id, position],
              client,
            )
          ).rows[0];
          if (prior) return prior;
          const graph = new Objects(this.db, model, access, client);
          const object = await graph.read(objectRefSchema.parse(row.object_ref));
          this.authorize(access, model, [item]);
          const previousResults = new Map<string, ObjectRef>();
          for (const binding of Object.values(item.input)) {
            if (!('step' in binding) || previousResults.has(binding.step)) continue;
            const previousPosition = steps.findIndex(candidate => candidate.name === binding.step);
            if (previousPosition < 0 || previousPosition >= position) {
              throw new Conflict('Step binding must reference a prior step');
            }
            const receipt = (await this.db.query(
              `SELECT s.action,s.input,s.result,s.request_id,a.digest,a.result AS committed_result FROM ${this.db.schema}.workflow_steps s
               JOIN ${this.db.schema}.actions a ON a.owner=$3 AND a.request_id=s.request_id
               WHERE s.run_id=$1 AND s.position=$2 AND s.result IS NOT NULL AND s.completed_at IS NOT NULL`,
              [row.id, previousPosition, row.owner], client,
            )).rows[0];
            if (!receipt || receipt.digest !== digest({ release: model.release, action: receipt.action, input: receipt.input })) {
              throw new Conflict('Prior workflow step has no committed result');
            }
            if (digest(receipt.result) !== digest(receipt.committed_result)) {
              throw new Conflict('Prior workflow step result differs from its Action receipt');
            }
            const reference = objectRefSchema.parse(receipt.committed_result);
            await graph.read(reference);
            previousResults.set(binding.step, reference);
          }
          const input = Object.fromEntries(
            Object.entries(item.input).map(([key, binding]) => {
              if ('literal' in binding) return [key, binding.literal];
              if ('object' in binding) return [key, object.ref];
              if ('step' in binding) return [key, previousResults.get(binding.step)!];
              let value: unknown = object.properties;
              if (binding.property === '$revision') return [key, object.revision];
              for (const field of binding.property.split('.'))
                value =
                  value && typeof value === 'object' && Object.hasOwn(value, field)
                    ? Reflect.get(value, field)
                    : undefined;
              return [key, value];
            }),
          );
          const validated = validator(model.action(item.action).parameters).parse(input) as Record<
            string,
            unknown
          >;
          if (JSON.stringify(validated).length > 64000)
            throw new Conflict('Workflow step input exceeds 64000 characters');
          await access.refresh(client);
          return (
            await this.db.query(
              `INSERT INTO ${this.db.schema}.workflow_steps(run_id,position,action,input,requirements,request_id,read_markings) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
              [
                row.id,
                position,
                item.action,
                validated,
                JSON.stringify(await access.finalDataRequirements(client)),
                requestId,
                JSON.stringify(access.readMarkingsSnapshot()),
              ],
              client,
            )
          ).rows[0]!;
        });
        const committed = (
          await this.db.query(
            `SELECT digest,result FROM ${this.db.schema}.actions WHERE owner=$1 AND request_id=$2`,
            [row.owner, requestId],
          )
        ).rows[0];
        let result: ObjectRef;
        if (committed) {
          if (
            committed.digest !==
            digest({ release: model.release, action: frozen.action, input: frozen.input })
          )
            throw new Conflict('Workflow Action receipt has different input');
          result = objectRefSchema.parse(committed.result);
        } else {
          if (frozen.read_markings === null || frozen.read_markings === undefined) {
            throw new MissingFrozenSecurityContext(missingSecurityContextMessage);
          }
          const markings = z.array(z.string()).parse(frozen.read_markings);
          await access.restoreReads(frozen.requirements as Requirement[], markings);
          const boundResults = Object.entries(item.input)
            .filter(([, binding]) => 'step' in binding)
            .map(([parameter]) => objectRefSchema.parse(frozen.input[parameter]));
          for (const reference of boundResults) await new Objects(this.db, model, access).read(reference);
          let checkedInputs = false;
          const commitGuard = async (client: Sql) => {
            await guard(client);
            // Authorize before edits under the write lock; a valid Action may subsequently delete its input.
            if (!checkedInputs) {
              const graph = new Objects(this.db, model, access, client);
              await graph.lockWrites();
              await access.restoreReads(frozen.requirements as Requirement[], markings, client);
              for (const reference of boundResults) await graph.read(reference);
              checkedInputs = true;
            }
            await this.db.query(
              `UPDATE ${this.db.schema}.workflow_steps SET requirements=$3,read_markings=$4 WHERE run_id=$1 AND position=$2`,
              [
                row.id,
                position,
                JSON.stringify(await access.finalDataRequirements(client)),
                JSON.stringify(access.readMarkingsSnapshot()),
              ],
              client,
            );
          };
          result = await this.actions.apply(
            access,
            model,
            frozen.action,
            frozen.input,
            requestId,
            commitGuard,
            undefined,
            executionSignal,
          );
        }
        await this.db.transaction(async (client) => {
          await guard(client);
          await this.active(model, client);
          await this.db.query(
            `UPDATE ${this.db.schema}.workflow_steps SET result=$3,completed_at=now() WHERE run_id=$1 AND position=$2`,
            [row.id, position, result],
            client,
          );
          await this.db.query(
            `UPDATE ${this.db.schema}.workflow_runs SET step=$3,results=results||$4::jsonb,updated_at=now() WHERE id=$1 AND token=$2 AND state='working'`,
            [row.id, token, position + 1, JSON.stringify([{ step: item.name, object: result }])],
            client,
          );
        });
      }
      await this.db.transaction(async (client) => {
        await guard(client);
        await this.active(model, client);
        await this.db.query(
          `UPDATE ${this.db.schema}.workflow_runs SET state='completed',token=NULL,lease_until=NULL,error=NULL,updated_at=now() WHERE id=$1 AND token=$2`,
          [row.id, token],
          client,
        );
      });
    } catch (error) {
      await this.db.query(
        `UPDATE ${this.db.schema}.workflow_runs SET state='failed',error=$3,token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND token=$2 AND state='working'`,
        [row.id, token, error instanceof MissingFrozenSecurityContext ? missingSecurityContextMessage : failureMessage],
      );
    }
    return true;
  }
  async retry(access: Access, model: PublishedOntology, id: string) {
    requireScope(access.principal, 'ontology:write');
    z.uuid().parse(id);
    await access.refresh();
    return this.db.transaction(async (client) => {
      await this.active(model, client);
      const row = (
        await this.db.query(
          `SELECT * FROM ${this.db.schema}.workflow_runs WHERE id=$1 AND owner=$2 AND ontology=$3 AND state='failed' FOR UPDATE`,
          [id, access.principal.owner, model.document.id],
          client,
        )
      ).rows[0];
      if (!row) throw new NotFound('Failed workflow is unavailable');
      if (row.release !== model.release)
        throw new Conflict('Workflow retry requires its original active publication');
      this.authorize(access, model, workflowSchema.parse(row.body).steps.slice(Number(row.step)));
      await access.refresh(client);
      await this.db.query(
        `UPDATE ${this.db.schema}.workflow_runs SET state='pending',error=NULL,token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`,
        [id],
        client,
      );
      return { id, state: 'pending' };
    });
  }
  async cancel(access: Access, model: PublishedOntology, id: string) {
    requireScope(access.principal, 'ontology:write');
    z.uuid().parse(id);
    await access.refresh();
    return this.db.transaction(async (client) => {
      const row = (
        await this.db.query(
          `SELECT * FROM ${this.db.schema}.workflow_runs WHERE id=$1 AND owner=$2 AND ontology=$3 FOR UPDATE`,
          [id, access.principal.owner, model.document.id],
          client,
        )
      ).rows[0];
      if (!row) throw new NotFound('Workflow run is unavailable');
      if (row.state === 'completed') throw new Conflict('Completed workflow cannot be canceled');
      let completed = Number(row.step);
      const results = row.results as { step: string; object: ObjectRef }[];
      const receipts = (
        await this.db.query(
          `SELECT s.position,s.action,s.input,a.digest,a.result FROM ${this.db.schema}.workflow_steps s
        JOIN ${this.db.schema}.actions a ON a.owner=$2 AND a.request_id=s.request_id
        WHERE s.run_id=$1 AND s.position>=$3 ORDER BY s.position`,
          [id, access.principal.owner, completed],
          client,
        )
      ).rows;
      for (const receipt of receipts) {
        if (
          Number(receipt.position) !== completed ||
          receipt.digest !== digest({ release: row.release, action: receipt.action, input: receipt.input })
        )
          break;
        const result = objectRefSchema.parse(receipt.result);
        await this.db.query(
          `UPDATE ${this.db.schema}.workflow_steps SET result=$3,completed_at=coalesce(completed_at,now()) WHERE run_id=$1 AND position=$2`,
          [id, completed, result],
          client,
        );
        results.push({ step: row.body.steps[completed].name, object: result });
        completed++;
      }
      await this.db.query(
        `UPDATE ${this.db.schema}.workflow_runs SET state='canceled',step=$2,results=$3,token=NULL,lease_until=NULL,error=NULL,updated_at=now() WHERE id=$1`,
        [id, completed, JSON.stringify(results)],
        client,
      );
      await access.refresh(client);
      return { id, state: 'canceled', step: completed };
    });
  }
}
