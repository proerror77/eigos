import { digest, Conflict } from '../core/identity.js';
import { validator } from '../ontology/model.js';
import { PublishedOntology } from './metadata.js';
import { Access } from './access.js';
import { objectRefSchema, type ObjectRef, type Value } from '../ontology/schema.js';
import { Database, type Sql } from './database.js';
import { Objects } from './objects.js';
import { Functions, type FunctionContext } from './functions.js';

const evaluate = (expression: Value, input: Record<string, unknown>): unknown => {
  if ('literal' in expression) return expression.literal;
  let value: unknown = input[expression.parameter];
  for (const field of expression.path ?? []) value = value && typeof value === 'object' ? Reflect.get(value, field) : undefined;
  return value;
};
export class Actions {
  constructor(private readonly db: Database, private readonly functions: Functions) {}
  async apply(access: Access, model: PublishedOntology, actionName: string, raw: Record<string, unknown>, requestId: string, beforeCommit?: (client: Sql) => Promise<void>, execution?: FunctionContext['execution'], signal = AbortSignal.timeout(120000)) {
    const principal = access.principal;
    await access.refresh(); access.action(model, actionName);
    if (model.runtimeId !== this.db.runtimeId) throw new Conflict('Historical Actions are read-only');
    if ((await this.db.query(`SELECT release FROM ${this.db.schema}.ontology WHERE id=$1`, [model.document.id])).rows[0]?.release !== model.release) throw new Conflict('Historical and prepared Actions are read-only');
    const action = model.action(actionName), input = validator(action.parameters).parse(raw) as Record<string, unknown>;
    const fingerprint = digest({ release: model.release, action: actionName, input });
    const journal = model.scenario ? 'scenario_actions' : 'actions';
    const priorResult = (client: Sql = this.db.pool) => this.db.query(`SELECT digest,result FROM ${this.db.schema}.${journal} WHERE owner=$1 AND request_id=$2${model.scenario ? ' AND scenario_id=$3' : ''}`, [principal.owner, requestId, ...(model.scenario ? [model.scenario] : [])], client);
    const commit = (write?: (objects: Objects) => Promise<ObjectRef>) => this.db.transaction(async client => {
      // The request key serializes only duplicate submissions of this action.
      await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([principal.owner, model.scenario ?? 'main', requestId])], client);
      await beforeCommit?.(client);
      const objects = new Objects(this.db, model, access, client);
      await objects.lockWrites();
      const previous = await priorResult(client);
      if (previous.rows[0]) {
        if (previous.rows[0].digest !== fingerprint) throw new Conflict('Request ID already used with different action input');
        signal.throwIfAborted(); await access.refresh(client); await beforeCommit?.(client);
        return objectRefSchema.parse(previous.rows[0].result);
      }
      for (const [name, type] of Object.entries(action.objectParameters)) {
        const ref = objectRefSchema.parse(input[name]);
        if (!model.implements(ref.type, type)) throw new Error('Action input type does not satisfy its contract');
        await objects.read(ref);
      }
      for (const condition of action.submissionCriteria) {
        const conditionFunction = model.functions.get(condition.function);
        if (conditionFunction?.source || conditionFunction?.edits) throw new Error('Submission criteria require read-only object functions');
        const parameters = Object.fromEntries(Object.entries(condition.arguments).map(([name, value]) => [name, evaluate(value, input)]));
        const allowed = await this.functions.invoke(model, condition.function, parameters, { principal, objects, signal: AbortSignal.timeout(5000) });
        if (allowed !== true) throw new Conflict('Action submission criteria are not satisfied');
      }
      const ref = (value: { type: string; id: Value }): ObjectRef => objectRefSchema.parse({ type: value.type, id: evaluate(value.id, input) });
      for (const rule of action.rules ?? []) {
        if (rule.op === 'addLink') await objects.link({ type: rule.link, from: ref(rule.from), to: ref(rule.to) });
        else {
          const fields = Object.fromEntries(Object.entries(rule.properties).map(([name, value]) => [name, evaluate(value, input)]));
          if (rule.op === 'createObject') await objects.create(ref(rule.object), fields);
          else await objects.edit(objectRefSchema.parse(evaluate(rule.object, input)), Number(evaluate(rule.expectedRevision, input)), fields);
        }
      }
      const result = write ? objectRefSchema.parse(await write(objects)) : ref(action.result!);
      if (model.scenario) await this.db.query(`INSERT INTO ${this.db.schema}.scenario_actions(scenario_id,owner,request_id,digest,action,result,requirements) VALUES($1,$2,$3,$4,$5,$6,$7)`, [model.scenario, principal.owner, requestId, fingerprint, actionName, result, JSON.stringify(access.requirements())], client);
      else await this.db.query(`INSERT INTO ${this.db.schema}.actions(owner,request_id,digest,action,release,result) VALUES($1,$2,$3,$4,$5,$6)`, [principal.owner, requestId, fingerprint, actionName, model.release, result], client);
      signal.throwIfAborted(); await access.refresh(client); await beforeCommit?.(client);
      return result;
    });
    if (!action.function) return commit();
    const prior = await priorResult();
    if (prior.rows[0]) {
      if (prior.rows[0].digest !== fingerprint) throw new Conflict('Request ID already used with different action input');
      return commit();
    }
    let staged: { result: ObjectRef; write: (objects: Objects) => Promise<void> } | undefined;
    const result = await this.functions.invoke(model, action.function, input, {
      principal, objects: new Objects(this.db, model, access), signal, operationId: requestId, taskId: execution?.task.id, execution,
      edit: (result, write) => {
        if (staged) throw new Error('An edit Function stages one Action');
        staged = { result: objectRefSchema.parse(result), write }; return staged.result;
      },
    });
    if (!staged || digest(result) !== digest(staged.result)) throw new Error('Edit Function did not return its staged Action result');
    const edits = staged;
    return commit(async objects => { await edits.write(objects); return edits.result; });
  }
}
