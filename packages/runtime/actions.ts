import { digest, Conflict } from '../core/identity.js';
import { validator } from '../ontology/model.js';
import { PublishedOntology } from './metadata.js';
import { Access } from './access.js';
import { objectRefSchema, type ObjectRef, type Value } from '../ontology/schema.js';
import { Database, type Sql } from './database.js';
import { Objects } from './objects.js';
import { Functions, type FunctionContext } from './functions.js';
import { Effects } from './effects.js';
import { Scenarios } from './scenarios.js';
import { JournalObjects, compensate, type ObjectChange, type LinkChange } from './action-journal.js';

const evaluate = (expression: Value, input: Record<string, unknown>): unknown => {
  if ('literal' in expression) return expression.literal;
  let value: unknown = input[expression.parameter];
  for (const field of expression.path ?? []) value = value && typeof value === 'object' ? Reflect.get(value, field) : undefined;
  return value;
};
export class Actions {
  constructor(private readonly db: Database, private readonly functions: Functions, private readonly effects?: Effects) {}
  async apply(access: Access, model: PublishedOntology, actionName: string, raw: Record<string, unknown>, requestId: string, beforeCommit?: (client: Sql) => Promise<void>, execution?: FunctionContext['execution'], signal = AbortSignal.timeout(120000)) {
    const principal = access.principal;
    await access.refresh(); access.action(model, actionName);
    if (model.runtimeId !== this.db.runtimeId) throw new Conflict('Historical Actions are read-only');
    if ((await this.db.query(`SELECT release FROM ${this.db.schema}.ontology WHERE id=$1`, [model.document.id])).rows[0]?.release !== model.release) throw new Conflict('Historical and prepared Actions are read-only');
    const action = model.action(actionName), input = validator(action.parameters).parse(raw) as Record<string, unknown>;
    if (action.effects?.length && !model.scenario) {
      if (!this.effects) throw new Error('Action effects require a configured dispatcher');
      this.effects.check(action.effects.map(effect => effect.handler));
    }
    const fingerprint = digest({ release: model.release, action: actionName, input });
    const journal = model.scenario ? 'scenario_actions' : 'actions';
    const priorResult = (client: Sql = this.db.pool) => this.db.query(`SELECT digest,result FROM ${this.db.schema}.${journal} WHERE owner=$1 AND request_id=$2${model.scenario ? ' AND scenario_id=$3' : ''}`, [principal.owner, requestId, ...(model.scenario ? [model.scenario] : [])], client);
    const commit = (write?: (objects: Objects) => Promise<ObjectRef>) => this.db.transaction(async client => {
      // The request key serializes only duplicate submissions of this action.
      await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([principal.owner, model.scenario ?? 'main', requestId])], client);
      await beforeCommit?.(client);
      const objects = model.scenario ? new Objects(this.db, model, access, client) : new JournalObjects(this.db,model,access,client);
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
        else if(rule.op==='removeLink')await objects.unlink({type:rule.link,from:ref(rule.from),to:ref(rule.to)});
        else if(rule.op==='deleteObject')await objects.remove(objectRefSchema.parse(evaluate(rule.object,input)),Number(evaluate(rule.expectedRevision,input)));
        else if(rule.op==='applyScenario')await new Scenarios(this.db).mergeInto(objects,String(evaluate(rule.scenario,input)),Number(evaluate(rule.expectedRevision,input)),{objects:rule.objectTypes,links:rule.linkTypes});
        else if(rule.op==='editStruct'){
          const target=objectRefSchema.parse(evaluate(rule.object,input)),current=await objects.read(target),before=current.properties[rule.property];
          if(!before||typeof before!=='object'||Array.isArray(before))throw new Conflict('Struct property is unavailable');
          const fields=Object.fromEntries(Object.entries(rule.fields).map(([name,value])=>[name,evaluate(value,input)]));
          await objects.edit(target,Number(evaluate(rule.expectedRevision,input)),{[rule.property]:{...before,...fields}});
        }else {
          const fields = Object.fromEntries(Object.entries(rule.properties).map(([name, value]) => [name, evaluate(value, input)]));
          if (rule.op === 'createObject') await objects.create(ref(rule.object), fields);
          else await objects.edit(objectRefSchema.parse(evaluate(rule.object, input)), Number(evaluate(rule.expectedRevision, input)), fields);
        }
      }
      const result = write ? objectRefSchema.parse(await write(objects)) : ref(action.result!);
      if (model.scenario) await this.db.query(`INSERT INTO ${this.db.schema}.scenario_actions(scenario_id,owner,request_id,digest,action,result,requirements) VALUES($1,$2,$3,$4,$5,$6,$7)`, [model.scenario, principal.owner, requestId, fingerprint, actionName, result, JSON.stringify(access.requirements())], client);
      else await this.db.query(`INSERT INTO ${this.db.schema}.actions(owner,request_id,digest,action,release,result) VALUES($1,$2,$3,$4,$5,$6)`, [principal.owner, requestId, fingerprint, actionName, model.release, result], client);
      if(objects instanceof JournalObjects){
        const changes=await objects.changes();
        await this.db.query(`INSERT INTO ${this.db.schema}.action_changes(owner,request_id,release,action,result,objects,links) VALUES($1,$2,$3,$4,$5,$6,$7)`,[principal.owner,requestId,model.release,actionName,result,JSON.stringify(changes.objects),JSON.stringify(changes.links)],client);
      }
      if (action.effects?.length && !model.scenario) await this.effects!.enqueue(client, access, model, actionName, requestId, action.effects.map(effect => ({
        name: effect.name, handler: effect.handler, payload: Object.fromEntries(Object.entries(effect.payload).map(([name, value]) => [name, evaluate(value, input)])),
      })));
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
      assertCurrent: async (client = this.db.pool) => { signal.throwIfAborted(); await access.refresh(client); await beforeCommit?.(client); },
      edit: (result, write) => {
        if (staged) throw new Error('An edit Function stages one Action');
        staged = { result: objectRefSchema.parse(result), write }; return staged.result;
      },
    });
    if (!staged || digest(result) !== digest(staged.result)) throw new Error('Edit Function did not return its staged Action result');
    const edits = staged;
    return commit(async objects => { await edits.write(objects); return edits.result; });
  }
  async undo(access:Access,model:PublishedOntology,originalRequestId:string,requestId:string){
    if(model.scenario)throw new Conflict('Undo requires the live ontology');
    if(!originalRequestId||!requestId||originalRequestId===requestId)throw new Conflict('Undo needs a distinct request ID');
    return this.db.transaction(async client=>{
      await access.refresh(client);
      await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([access.principal.owner,'main',requestId])],client);
      const graph=new Objects(this.db,model,access,client);await graph.lockWrites();
      const original=(await this.db.query(`SELECT * FROM ${this.db.schema}.action_changes WHERE owner=$1 AND request_id=$2 FOR UPDATE`,[access.principal.owner,originalRequestId],client)).rows[0];
      if(!original)throw new Conflict('The original Action has no reversible edit journal');
      if(original.release!==model.release)throw new Conflict('Undo requires the original publication');
      access.action(model,original.action);
      const previous=(await this.db.query(`SELECT original_request_id,result FROM ${this.db.schema}.action_undo_requests WHERE owner=$1 AND request_id=$2`,[access.principal.owner,requestId],client)).rows[0];
      if(previous){
        if(previous.original_request_id!==originalRequestId)throw new Conflict('Undo request ID has different input');
        return previous.result;
      }
      if(original.undone_by)throw new Conflict('The original Action was already undone');
      if((await this.db.query(`SELECT 1 FROM ${this.db.schema}.actions WHERE owner=$1 AND request_id=$2`,[access.principal.owner,requestId],client)).rowCount)throw new Conflict('Request ID already used by another Action');
      const effects=(await this.db.query(`SELECT id,state FROM ${this.db.schema}.action_effects WHERE owner=$1 AND request_id=$2 ORDER BY id FOR UPDATE`,[access.principal.owner,originalRequestId],client)).rows;
      if(effects.some(effect=>effect.state==='working'))throw new Conflict('An original Action effect is in flight');
      await this.db.query(`UPDATE ${this.db.schema}.action_effects SET state='canceled',token=NULL,lease_until=NULL,error=NULL WHERE owner=$1 AND request_id=$2 AND state='pending'`,[access.principal.owner,originalRequestId],client);
      await compensate(graph,original.objects as ObjectChange[],original.links as LinkChange[]);
      const result={originalRequestId,requestId,result:original.result,externalEffectsReversed:false,pendingEffectsCanceled:effects.filter(effect=>effect.state==='pending').length};
      await this.db.query(`INSERT INTO ${this.db.schema}.actions(owner,request_id,digest,action,release,result) VALUES($1,$2,$3,$4,$5,$6)`,[access.principal.owner,requestId,digest({undo:originalRequestId,release:model.release}),original.action,model.release,original.result],client);
      await this.db.query(`INSERT INTO ${this.db.schema}.action_undo_requests(owner,request_id,original_request_id,result) VALUES($1,$2,$3,$4)`,[access.principal.owner,requestId,originalRequestId,result],client);
      await this.db.query(`UPDATE ${this.db.schema}.action_changes SET undone_by=$3 WHERE owner=$1 AND request_id=$2`,[access.principal.owner,originalRequestId,requestId],client);
      await access.refresh(client);
      return result;
    });
  }
}
