import { ResourceReservations } from './resource-reservations.js';
import { requireMachineryTransition } from './machinery-execution.js';
import { digest, Conflict, InvalidInput, PermissionDenied, NotFound, type ExecutionActor } from '../core/identity.js';
import { timeOperation } from '../core/operation-timing.js';
import { validator } from '../ontology/model.js';
import { actionBatchSchema, type ActionCall, type ActionResultRead } from '../ontology/invocation.js';
import { PublishedOntology } from './metadata.js';
import { Access } from './access.js';
import { objectRefSchema, type ObjectRef, type Value } from '../ontology/schema.js';
import { Database, type Sql } from './database.js';
import { Objects } from './objects.js';
import { Functions, type FunctionContext, type ScenarioEvaluation } from './functions.js';
import { Effects, type ActionEffect } from './effects.js';
import { Scenarios } from './scenarios.js';
import { checkScenario, recordScenarioAction, type ScenarioMutation } from './scenario-store.js';
import { JournalObjects, compensate, type ObjectChange, type LinkChange } from './action-journal.js';

import { actionEffects, changeDigest, evaluate } from './action-values.js';
import { effectHandlerName, webhookApprovalCapability, webhookApprovalDigest } from './action-webhooks.js';
import { PARequests } from './pa.js';
import { validateCognitive } from './cognitive-workflow.js';
import { ActionInputRequired, Clarification, actionContinuationSchema } from './clarification.js';
import { assertActionConfirmed } from './action-confirmation.js';
import { appendTrace } from './execution-trace.js';
import { capturingDecisionReads } from './decision-evidence.js';

type TaskExecution = NonNullable<FunctionContext['execution']>;

export type CommittedEffects = (model: PublishedOntology, owner: string, changes: readonly ObjectChange[]) => Promise<ActionEffect[]>;
export class Actions {
  constructor(private readonly db: Database, private readonly functions: Functions, private readonly effects?: Effects,
    private readonly committedEffects?: CommittedEffects) {}
  /**
   * `context` is where the Action takes effect: in a Scenario, or on the live data. A merge replays a Scenario's Actions
   * inside the Scenario's view, but their edits take effect on the live data, so it checks them as live.
   */
  private async checkSubmission(objects: Objects, actionName: string, input: Record<string, unknown>, signal: AbortSignal, scenarioEvaluation?: ScenarioEvaluation,
    context: 'scenario' | 'live' = objects.model.scenario ? 'scenario' : 'live') {
    const { model, access } = objects;
    for (const condition of model.action(actionName).submissionCriteria) {
      if (condition.executionContext && condition.executionContext !== context) continue;
      const conditionFunction = model.functions.get(condition.function);
      if (conditionFunction?.source || conditionFunction?.edits) throw new Error('Submission criteria require read-only object functions');
      const parameters = Object.fromEntries(Object.entries(condition.arguments).map(([name, value]) => [name, evaluate(value, input)]));
      const allowed = await this.functions.invoke(model, condition.function, parameters, {
        principal: access.principal, objects, scenarioEvaluation, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      if (allowed !== true) throw new Conflict(condition.message ?? 'Action submission criteria are not satisfied');
    }
  }
  private async checkInput(objects: Objects, name: string, input: Record<string, unknown>, signal: AbortSignal, scenarioEvaluation?: ScenarioEvaluation,
    context?: 'scenario' | 'live') {
    const { model } = objects;
    signal.throwIfAborted();
    for (const [parameter, type] of Object.entries(model.action(name).objectParameters)) {
      const ref = objectRefSchema.parse(input[parameter]);
      if (!model.implements(ref.type, type)) throw new InvalidInput('Action input type does not satisfy its contract');
      await objects.read(ref);
    }
    await requireMachineryTransition(objects, name, input);
    await this.checkSubmission(objects, name, input, signal, scenarioEvaluation, context);
  }
  resolve(access: Access, model: PublishedOntology, call: ActionCall) {
    const target = call.interface;
    if (!target) return { action: call.action!, input: call.input };
    access.definition(model, 'interface', target.type);
    access.definition(model, 'object', target.implementation ?? target.object!.type);
    return target.object
      ? model.resolveAction(target.object, target.type, target.action, call.input)
      : model.resolveTypeAction(target.implementation!, target.type, target.action, call.input);
  }
  private async requireActive(model: PublishedOntology, client?: Sql) {
    if (model.runtimeId !== this.db.runtimeId) throw new Conflict('Historical Actions are read-only');
    if ((await this.db.query(`SELECT release FROM ${this.db.schema}.ontology WHERE id=$1`,
      [model.document.id], client)).rows[0]?.release !== model.release)
      throw new Conflict('Historical and prepared Actions are read-only');
  }
  private lockRequest(client: Sql, model: PublishedOntology, owner: string, requestId: string) {
    return this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [this.db.lockKey('action', owner, model.scenario ?? 'main', requestId)], client);
  }
  async validateSubmission(access: Access, model: PublishedOntology, call: ActionCall, client: Sql, signal: AbortSignal) {
    await access.refresh(client);
    await this.requireActive(model, client);
    await checkScenario(this.db, model, access.principal.owner, client);
    const { action, input } = this.resolve(access, model, call);
    access.action(model, action);
    if (!model.actions.has(action)) throw new NotFound('Action is unavailable');
    const parameters = validator(model.action(action).parameters).parse(input) as Record<string, unknown>;
    await this.checkInput(new Objects(this.db, model, access, client), action, parameters, signal);
    return action;
  }
  async validate(access: Access, model: PublishedOntology, call: ActionCall, signal = AbortSignal.timeout(30_000)) {
    const selected = await this.db.transaction(async client => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], client);
      return this.validateSubmission(access, model, call, client, signal);
    });
    await access.refresh();
    if (!(await access.canReturn(access.dataRequirements()))) throw new PermissionDenied('Result permissions changed');
    return { valid: true as const, phase: 'submission' as const, action: selected, release: model.release };
  }
  async applyBatch(access: Access, model: PublishedOntology, raw: unknown, signal = AbortSignal.timeout(120_000)) {
    const { actions } = actionBatchSchema.parse(raw);
    if (model.scenario) throw new Conflict('Action batches require the live Ontology');
    const items = await this.db.transaction(async client => {
      await access.refresh(client);
      await this.requireActive(model, client);
      const submissions = actions.map(({ requestId, ...call }) => {
        const { action, input } = this.resolve(access, model, call);
        access.action(model, action);
        if (!model.actions.has(action)) throw new NotFound('Action is unavailable');
        const definition = model.action(action);
        if (definition.function || definition.effects?.length || definition.rules?.some(rule => rule.op === 'applyScenario'))
          throw new Conflict('Action batches require declarative rules without declared effects or Scenario merges');
        return { requestId, action, input };
      });
      // Lock every request before taking the owner write lock, including when single Actions run in parallel.
      for (const requestId of submissions.map(item => item.requestId).sort()) {
        signal.throwIfAborted();
        await this.lockRequest(client, model, access.principal.owner, requestId);
      }
      const committed = [];
      for (const { action, input, requestId } of submissions)
        committed.push({ requestId, result: await this.execute(access, model, action, input, requestId,
          undefined, undefined, signal, undefined, undefined, client) });
      return committed;
    });
    return { release: model.release, items };
  }
  apply(access: Access, model: PublishedOntology, actionName: string, raw: Record<string, unknown>, requestId: string, beforeCommit?: (client: Sql) => Promise<void>, execution?: FunctionContext['execution'], signal = AbortSignal.timeout(120000), executor?: ExecutionActor, scenarioEvaluation?: ScenarioEvaluation) {
    return timeOperation('action_apply',
      () => this.execute(access, model, actionName, raw, requestId, beforeCommit, execution, signal, executor, scenarioEvaluation), actionName);
  }
  private async execute(access: Access, model: PublishedOntology, actionName: string, raw: Record<string, unknown>,
    requestId: string, beforeCommit: ((client: Sql) => Promise<void>) | undefined, execution: FunctionContext['execution'],
    signal: AbortSignal, executor: ExecutionActor | undefined, scenarioEvaluation: ScenarioEvaluation | undefined,
    batchClient?: Sql) {
    const principal = access.principal;
    const actor: ExecutionActor = executor ?? execution?.executor ?? (execution
      ? { kind: 'agent', id: 'eigos-ontology-agent' }
      : { kind: 'client', id: principal.clientId ?? principal.owner });
    const suppliedClient = scenarioEvaluation?.client ?? batchClient;
    const transaction = <T>(run: (client: Sql) => Promise<T>) =>
      suppliedClient ? run(suppliedClient) : this.db.transaction(run);
    await access.refresh(suppliedClient); access.action(model, actionName);
    if (model.evaluation) {
      if (model.runtimeId !== this.db.runtimeId) throw new Conflict('Historical Actions are read-only');
      if (!model.scenario || scenarioEvaluation?.client !== model.evaluation.client)
        throw new Conflict('Prepared Actions require a temporary Scenario evaluation');
    } else await this.requireActive(model, suppliedClient);
    const action = model.action(actionName), input = validator(action.parameters).parse(raw) as Record<string, unknown>;
    if (scenarioEvaluation && (!model.scenario || execution || action.rules?.some(rule => rule.op === 'applyScenario')))
      throw new Conflict('Scenario evaluation requires a staged Action');
    const agentWebhook = !model.scenario && action.effects?.some(effect => 'webhook' in effect) &&
      (execution || actor.kind !== 'client');
    const approvedWebhook = agentWebhook ? actionContinuationSchema.safeParse(execution?.task.input.placeContinuation) : undefined;
    if (agentWebhook && (!approvedWebhook?.success || !execution || !model.objects.has('ActionConfirmation') ||
        approvedWebhook.data.pending?.capability !== webhookApprovalCapability ||
        approvedWebhook.data.pending.purpose !== 'authorization' ||
        approvedWebhook.data.action !== actionName || approvedWebhook.data.requestId !== requestId ||
        digest(validator(action.parameters).parse(approvedWebhook.data.input)) !== digest(input)))
      throw new PermissionDenied('A Source webhook requires explicit approval for this Action request');
    if (action.effects?.length && !model.scenario) {
      if (!this.effects) throw new Error('Action effects require a configured dispatcher');
      this.effects.check(action.effects.map(effectHandlerName));
    }
    const fingerprint = digest({ release: model.release, action: actionName, input });
    const declaredEffects: ActionEffect[] = [];
    const validateAction = (prefix: Objects, name: string, stagedInput: Record<string, unknown>) => {
      const staged = prefix.model.action(name);
      const parameters = validator(staged.parameters).parse(stagedInput) as Record<string, unknown>;
      // A merge's replay runs in the Scenario's view, but its edits take effect on the live data.
      return this.checkInput(prefix, name, parameters, signal, undefined, 'live');
    };
    const journal = model.scenario ? 'scenario_actions' : 'actions';
    const priorResult = (client: Sql = scenarioEvaluation?.client ?? this.db.pool) => this.db.query(`SELECT digest,result FROM ${this.db.schema}.${journal} WHERE owner=$1 AND request_id=$2${model.scenario ? ' AND scenario_id=$3' : ''}`, [principal.owner, requestId, ...(model.scenario ? [model.scenario] : [])], client);
    // Live commits lock only the objects they touch; one whose conflicts objects cannot bound reruns exclusively.
    // Scenario edits, merges, batches and evidence-recording reads keep the exclusive lock.
    const shared = !suppliedClient && !model.scenario && !capturingDecisionReads() && !action.rules?.some(rule => rule.op === 'applyScenario');
    // A commit waiting behind a long edit lock retries within its deadline; a supplied transaction cannot rerun.
    const commitTransaction = <T>(run: (client: Sql) => Promise<T>) => suppliedClient ? transaction(run)
      : this.db.waitForLocks(() => shared ? this.db.objectScopedTransaction(run, actionName) : transaction(run), signal);
    const commit = (write?: (objects: Objects) => Promise<ObjectRef>) => commitTransaction(async client => {
      // The request key serializes only duplicate submissions of this action.
      if (!batchClient) await this.lockRequest(client, model, principal.owner, requestId);
      await beforeCommit?.(client);
      const change: NonNullable<Objects['change']> = {
        action: actionName, requestId, inputDigest: fingerprint, taskId: execution?.task.id, executor: actor,
        validateWorkflow: (objects, validation, object) =>
          validateCognitive(this.functions, { objects, principal: access.principal, signal }, validation, object),
        scenarioEdits: model.scenario ? [] as ScenarioMutation[] : undefined };
      const objects = model.scenario ? new Objects(this.db, model, access, client,change) : new JournalObjects(this.db,model,access,client,change);
      await objects.lockWrites();
      const previous = await priorResult(client);
      if (previous.rows[0]) {
        if (previous.rows[0].digest !== fingerprint) throw new Conflict('Request ID already used with different action input');
        signal.throwIfAborted(); await access.refresh(client); await beforeCommit?.(client);
        return objectRefSchema.parse(previous.rows[0].result);
      }
      if (approvedWebhook?.success && execution) {
        const proof = webhookApprovalDigest(model, actionName, requestId, input);
        const approval = await this.db.query(`SELECT 1 FROM ${this.db.schema}.pa_requests
          WHERE id=$1 AND task_id=$2 AND owner=$3 AND request->>'capability'=$4
            AND request->>'actionRequestId'=$5 AND request->>'purpose'='authorization'
            AND request#>>'{input,digest}'=$6 AND response->>'digest'=$6 AND response->'approved'='true'::jsonb`,
        [approvedWebhook.data.pending!.id, execution.task.id, principal.owner, webhookApprovalCapability, requestId, proof], client);
        if (!approval.rowCount) throw new PermissionDenied('The original Action webhook was not approved');
        await assertActionConfirmed(this.db, model, execution.task, approvedWebhook.data, client);
      }
      await this.checkInput(objects, actionName, input, signal, scenarioEvaluation);
      if (action.reservation) await new ResourceReservations(this.db).forAction(objects,actionName,input,requestId,'commit');
      const ref = (value: { type: string; id: Value }): ObjectRef => objectRefSchema.parse({ type: value.type, id: evaluate(value.id, input) });
      for (const rule of action.rules ?? []) {
        if (rule.op === 'addLink') await objects.link({ type: rule.link, from: ref(rule.from), to: ref(rule.to) });
        else if(rule.op==='removeLink')await objects.unlink({type:rule.link,from:ref(rule.from),to:ref(rule.to)});
        else if(rule.op==='deleteObject')await objects.remove(objectRefSchema.parse(evaluate(rule.object,input)),Number(evaluate(rule.expectedRevision,input)));
        else if(rule.op==='applyScenario')await new Scenarios(this.db).mergeInto(objects,String(evaluate(rule.scenario,input)),Number(evaluate(rule.expectedRevision,input)),{objects:rule.objectTypes,links:rule.linkTypes,validateAction});
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
      if (model.scenario) await recordScenarioAction(objects, actionName, input, result, requestId);
      else await this.db.query(
        `INSERT INTO ${this.db.schema}.actions(owner,request_id,digest,action,release,result,executor_kind,executor_id,task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [principal.owner, requestId, fingerprint, actionName, model.release, result, actor.kind, actor.id, change.taskId ?? null], client);
      const pendingEffects = [...declaredEffects];
      if(objects instanceof JournalObjects){
        const changes=await objects.changes();
        if (change.reviewedChangeDigest && change.reviewedChangeDigest !== changeDigest(
          changes.objects.map(({ ref, before, after }) => ({ ref, before: before?.properties ?? null, after: after?.properties ?? null })),
          changes.links.map(({ edge, after }) => ({ edge, removed: !after })),
        )) throw new Conflict('The committed changes differ from the reviewed Scenario delta');
        await this.db.query(`INSERT INTO ${this.db.schema}.action_changes(owner,request_id,release,action,result,objects,links) VALUES($1,$2,$3,$4,$5,$6,$7)`,[principal.owner,requestId,model.release,actionName,result,JSON.stringify(changes.objects),JSON.stringify(changes.links)],client);
        if(this.committedEffects) pendingEffects.push(...await this.committedEffects(model, principal.owner, changes.objects));
      }
      if (!model.scenario) {
        if (change.reviewedChangeDigest && pendingEffects.length)
          throw new Conflict('Workflow merge cannot dispatch effects outside the reviewed declaration');
        pendingEffects.push(...actionEffects(model, actionName, input));
        if (pendingEffects.length) {
          if (!this.effects) throw new Error('Action effects require a configured dispatcher');
          await this.effects.enqueue(client, access, model, actionName, requestId, pendingEffects);
        }
      }
      signal.throwIfAborted(); await access.refresh(client); await beforeCommit?.(client);
      return result;
    });
    if (!action.function) return commit();
    const prior = await priorResult();
    if (prior.rows[0]) {
      if (prior.rows[0].digest !== fingerprint) throw new Conflict('Request ID already used with different action input');
      return commit();
    }
    // Function preparation can perform authorized source reads. Check business
    // admission before invoking it, and recheck under the eventual write lock.
    if (action.submissionCriteria.length || Object.keys(action.objectParameters).length) {
      await transaction(async client => {
        if (!scenarioEvaluation) await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], client);
        await access.refresh(client);
        await this.checkInput(new Objects(this.db, model, access, client), actionName, input, signal, scenarioEvaluation);
      });
    }
    let staged: { result: ObjectRef; write: (objects: Objects) => Promise<void | ObjectRef> } | undefined;
    const result = await this.functions.invoke(model, action.function, input, {
      principal, objects: new Objects(this.db, model, access, scenarioEvaluation?.client), signal, scenarioEvaluation, operationId: requestId, taskId: execution?.task.id, execution,
      directAction: !beforeCommit && !execution,
      validateScenarioAction: validateAction,
      assertCurrent: async (client = scenarioEvaluation?.client ?? this.db.pool) => { signal.throwIfAborted(); await access.refresh(client); await beforeCommit?.(client); },
      assertDispatch: async client => {
        if (model.scenario) throw new Conflict('External dispatch requires a formal Action');
        const objects = new Objects(this.db, model, access, client);
        await beforeCommit?.(client);
        await objects.lockWrites();
        await access.refresh(client);
        await this.checkInput(objects, actionName, input, signal);
        if (action.reservation) await new ResourceReservations(this.db).forAction(objects,actionName,input,requestId,'dispatch');
      },
      deferEffect: effect => {
        if (model.scenario) throw new Conflict('External effects require a formal Action');
        if (!this.effects) throw new Conflict('Action effects require a configured dispatcher');
        if (declaredEffects.length >= 20 || declaredEffects.some(item => item.name === effect.name)) {
          throw new Conflict('Action effect intents require distinct names and a bounded count');
        }
        this.effects.check([effect.handler]);
        declaredEffects.push(structuredClone(effect));
      },
      edit: (result, write) => {
        if (staged) throw new Error('An edit Function stages one Action');
        staged = { result: objectRefSchema.parse(result), write }; return staged.result;
      },
    });
    if (!staged || digest(result) !== digest(staged.result)) throw new Error('Edit Function did not return its staged Action result');
    const edits = staged;
    return commit(async objects => (await edits.write(objects)) ?? edits.result);
  }
  /** Complete an MCP invocation, with a durable pause only for task execution. */
  async complete(access: Access, model: PublishedOntology, selected: { action: string; input: Record<string, unknown> },
    requestId: string, read: ActionResultRead | undefined, execution: TaskExecution | undefined, signal: AbortSignal,
    options: { allowPause?: boolean; applied?: (reference: ObjectRef) => void; authorize?: (client: Sql) => Promise<void> } = {},
  ) {
    if (read) {
      access.function(model, read.function);
      const definition = model.functions.get(read.function);
      if (!definition || definition.edits || !Object.hasOwn(definition.parameters.properties ?? {}, read.resultParameter))
        throw new Conflict('Action completion requires a declared result parameter on a read Function');
      if (definition.source) access.source(model, definition.source);
    }
    const guard = execution || options.authorize ? async (client: Sql) => {
      signal.throwIfAborted();
      if (execution) await execution.tasks.current(execution.task, client, true);
      await options.authorize?.(client);
    } : undefined;
    let reference: ObjectRef;
    try {
      const action = execution && !model.scenario ? model.actions.get(selected.action) : undefined;
      const webhooks = action?.effects?.flatMap(effect => 'webhook' in effect ? [effect.webhook] : []) ?? [];
      if (execution && action && webhooks.length) {
        await access.refresh();
        access.action(model, selected.action);
        await this.requireActive(model);
        for (const webhook of webhooks) access.dispatchSource(model, webhook.source);
        const input = validator(action.parameters).parse(selected.input) as Record<string, unknown>;
        const proof = webhookApprovalDigest(model, selected.action, requestId, input);
        const response = await new PARequests(execution.tasks).requestActionInput(execution.task, requestId, proof,
          webhookApprovalCapability, 'authorization', { action: selected.action, requestId, input, digest: proof },
          { type: 'object', properties: { approved: { type: 'boolean' }, digest: { const: proof } },
            required: ['approved', 'digest'], additionalProperties: false }) as { approved: boolean };
        if (!response.approved) throw new PermissionDenied('The original Action webhook was declined');
      }
      reference = await this.apply(access, model, selected.action, selected.input, requestId, guard, execution, signal);
    } catch (error) {
      if (!execution || !options.allowPause || model.scenario) throw error;
      if (error instanceof ActionInputRequired) {
        const permissions = error.wait.pending?.capability === webhookApprovalCapability ? access.requirements() : error.permissions;
        throw new Clarification(error.message, error.choices, permissions,
          { ...selected, requestId, read, ...error.wait });
      }
      throw error;
    }
    options.applied?.(reference);
    if (!read) return reference;
    const result = await timeOperation('result_read', () => this.functions.invoke(model, read.function, { ...read.input, [read.resultParameter]: reference }, {
      principal: access.principal, objects: new Objects(this.db, model, access), signal, taskId: execution?.task.id, execution,
    }), read.function);
    signal.throwIfAborted();
    if (model.scenario) {
      if (execution) await execution.tasks.current(execution.task);
    } else {
      await this.db.transaction(async client => {
        await guard?.(client);
        await access.refresh(client);
        await appendTrace(this.db, {
          owner: access.principal.owner, release: model.release, projection: model.projection,
          taskId: execution?.task.id, requestId,
        }, { kind: 'action-read', function: read.function }, client, access.requirements());
        signal.throwIfAborted();
      });
    }
    return result;
  }

  async resume(access: Access, model: PublishedOntology, execution: TaskExecution, signal: AbortSignal) {
    const { task, tasks } = execution;
    await tasks.current(task);
    const pending = actionContinuationSchema.parse(task.input.placeContinuation);
    await assertActionConfirmed(this.db, model, task, pending);
    return this.complete(access, model, { action: pending.action, input: pending.input },
      pending.requestId, pending.read, execution, signal, { allowPause: true });
  }

  async undo(access:Access,model:PublishedOntology,originalRequestId:string,requestId:string){
    if(model.scenario)throw new Conflict('Undo requires the live ontology');
    if(!originalRequestId||!requestId||originalRequestId===requestId)throw new Conflict('Undo needs a distinct request ID');
    return this.db.transaction(async client=>{
      await access.refresh(client);
      await this.lockRequest(client, model, access.principal.owner, requestId);
      const executor = { kind: 'client' as const, id: access.principal.clientId ?? access.principal.owner };
      const graph=new Objects(this.db,model,access,client,{requestId,executor});await graph.lockWrites();
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
      await new ResourceReservations(this.db).undo(access.principal.owner,originalRequestId,client);
      await compensate(graph,original.objects as ObjectChange[],original.links as LinkChange[]);
      const result={originalRequestId,requestId,result:original.result,externalEffectsReversed:false,pendingEffectsCanceled:effects.filter(effect=>effect.state==='pending').length};
      await this.db.query(`INSERT INTO ${this.db.schema}.actions(owner,request_id,digest,action,release,result,executor_kind,executor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[access.principal.owner,requestId,digest({undo:originalRequestId,release:model.release}),original.action,model.release,original.result,executor.kind,executor.id],client);
      await this.db.query(`INSERT INTO ${this.db.schema}.action_undo_requests(owner,request_id,original_request_id,result) VALUES($1,$2,$3,$4)`,[access.principal.owner,requestId,originalRequestId,result],client);
      await this.db.query(`UPDATE ${this.db.schema}.action_changes SET undone_by=$3 WHERE owner=$1 AND request_id=$2`,[access.principal.owner,originalRequestId,requestId],client);
      await access.refresh(client);
      return result;
    });
  }
}
