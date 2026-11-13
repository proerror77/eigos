import { digest, Conflict, requireScope, type Principal } from '../core/identity.js';
import { validator, Ontology } from '../ontology/model.js';
import { objectRefSchema, type ObjectRef, type Value } from '../ontology/schema.js';
import { Database, type Sql } from './database.js';
import { Objects } from './objects.js';
import { Functions } from './functions.js';

const evaluate = (expression: Value, input: Record<string, unknown>): unknown => {
  if ('literal' in expression) return expression.literal;
  let value: unknown = input[expression.parameter];
  for (const field of expression.path ?? []) value = value && typeof value === 'object' ? Reflect.get(value, field) : undefined;
  return value;
};
export class Actions {
  constructor(private readonly db: Database, private readonly functions: Functions) {}
  async apply(principal: Principal, model: Ontology, actionName: string, raw: Record<string, unknown>, requestId: string, beforeCommit?: (client: Sql) => Promise<void>) {
    requireScope(principal, 'ontology:write');
    const action = model.action(actionName), input = validator(action.parameters).parse(raw) as Record<string, unknown>;
    const fingerprint = digest({ release: model.digest, action: actionName, input });
    return this.db.transaction(async client => {
      // The request key serializes only duplicate submissions of this action.
      await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([principal.owner, requestId])], client);
      const previous = await this.db.query(`SELECT digest,result FROM ${this.db.schema}.actions WHERE owner=$1 AND request_id=$2`, [principal.owner, requestId], client);
      if (previous.rows[0]) {
        if (previous.rows[0].digest !== fingerprint) throw new Conflict('Request ID already used with different action input');
        return objectRefSchema.parse(previous.rows[0].result);
      }
      const objects = new Objects(this.db, model, principal.owner, client);
      for (const [name, type] of Object.entries(action.objectParameters)) {
        const ref = objectRefSchema.parse(input[name]);
        if (!model.implements(ref.type, type)) throw new Error('Action input type does not satisfy its contract');
        await objects.read(ref);
      }
      for (const condition of action.submissionCriteria) {
        if (model.functions.get(condition.function)?.source) throw new Error('Submission criteria require object functions');
        const parameters = Object.fromEntries(Object.entries(condition.arguments).map(([name, value]) => [name, evaluate(value, input)]));
        const allowed = await this.functions.invoke(model, condition.function, parameters, { principal, objects, signal: AbortSignal.timeout(5000) });
        if (allowed !== true) throw new Conflict('Action submission criteria are not satisfied');
      }
      const ref = (value: { type: string; id: Value }): ObjectRef => objectRefSchema.parse({ type: value.type, id: evaluate(value.id, input) });
      for (const rule of action.rules) {
        if (rule.op === 'addLink') await objects.link({ type: rule.link, from: ref(rule.from), to: ref(rule.to) });
        else {
          const fields = Object.fromEntries(Object.entries(rule.properties).map(([name, value]) => [name, evaluate(value, input)]));
          if (rule.op === 'createObject') await objects.create(ref(rule.object), fields);
          else await objects.edit(objectRefSchema.parse(evaluate(rule.object, input)), Number(evaluate(rule.expectedRevision, input)), fields);
        }
      }
      const result = ref(action.result);
      await this.db.query(`INSERT INTO ${this.db.schema}.actions(owner,request_id,digest,action,release,result) VALUES($1,$2,$3,$4,$5,$6)`, [principal.owner, requestId, fingerprint, actionName, model.digest, result], client);
      await beforeCommit?.(client);
      return result;
    });
  }
}
