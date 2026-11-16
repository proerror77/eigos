import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { Conflict, NotFound, digest, requireScope } from '../core/identity.js';
import { validator } from '../ontology/model.js';
import { objectRefSchema, type ObjectData, type ObjectRef } from '../ontology/schema.js';
import { Access, PermissionDenied, type Requirement } from './access.js';
import { Database, type Sql } from './database.js';
import { Metadata, type PublishedOntology } from './metadata.js';
import type { Actions } from './actions.js';
import { Objects, querySchema } from './objects.js';
import { matchingTransition, processRuleSchema, processStatusSchema, processTarget, processTriggerSchema, readProcessStatus } from './process-automation.js';
import { readProcessTransitions } from './process-logs.js';
import { authorizeCognitive, cognitiveContextSchema, cognitiveResultSchema, cognitiveStepSchema, workflowMerge, type CognitiveStep } from './cognitive-workflow.js';
import { lockEdits } from './scenario-store.js';
import { Scenarios } from './scenarios.js';
import { appendTrace } from './execution-trace.js';
import { insertWorkflowRecord, readWorkflowRecord } from './workflow-records.js';

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
  steps: z.array(step).max(20),
  proposal: cognitiveStepSchema.optional(),
}).superRefine((workflow, context) => {
  if (!workflow.steps.length && !workflow.proposal)
    context.addIssue({ code: 'custom', message: 'Workflow requires at least one step', path: ['steps'] });
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
const baseRule = z.strictObject({
  id: z.uuid().optional(),
  revision: z.number().int().min(0).default(0),
  name: z.string().min(1).max(200),
  workflow: z.uuid(),
  enabled: z.boolean().default(false),
});
const ruleQuerySchema = querySchema.omit({ cursor: true, limit: true, select: true });
const objectRule = baseRule.extend({ query: ruleQuerySchema });
const processRule = baseRule.extend({ process: processRuleSchema });
const ruleSchema = z.union([objectRule, processRule]);
export const saveRuleSchema = baseRule.extend({
  query: ruleQuerySchema.optional(),
  process: processRuleSchema.optional(),
}).refine(rule => Boolean(rule.query) !== Boolean(rule.process), 'Select one object query or process transition condition');
export const runWorkflowSchema = z.strictObject({
  workflow: z.uuid(),
  object: objectRefSchema,
  requestId: z.string().min(1).max(128),
});

export const automationPreviewSchema = z.strictObject({
  rule: z.uuid(), revision: z.number().int().positive(),
  scenarios: z.array(z.strictObject({id:z.uuid(), revision:z.number().int().positive()})).min(1).max(6),
  elapsedSeconds: z.number().int().min(0).max(31*86400).default(0),
}).refine(input=>new Set(input.scenarios.map(item=>item.id)).size===input.scenarios.length, 'Select distinct Scenarios');

function bindWorkflowInput(item: z.output<typeof step>, object: ObjectData, previousResults: Map<string,ObjectRef>) {
  return Object.fromEntries(Object.entries(item.input).map(([key,binding]) => {
    if ('literal' in binding) return [key,binding.literal];
    if ('object' in binding) return [key,object.ref];
    if ('step' in binding) return [key,previousResults.get(binding.step)!];
    if (binding.property === '$revision') return [key,object.revision];
    let value: unknown = object.properties;
    for (const field of binding.property.split('.'))
      value=value&&typeof value==='object'&&Object.hasOwn(value,field)?Reflect.get(value,field):undefined;
    return [key,value];
  }));
}

export async function initializeAutomation(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.workflows(id uuid PRIMARY KEY,owner text NOT NULL,ontology text NOT NULL,name text NOT NULL,body jsonb NOT NULL,revision integer NOT NULL);
    CREATE TABLE IF NOT EXISTS ${db.schema}.object_rules(id uuid PRIMARY KEY,owner text NOT NULL,ontology text NOT NULL,name text NOT NULL,body jsonb NOT NULL,revision integer NOT NULL,enabled boolean NOT NULL DEFAULT false,last_scan timestamptz,error text);
    ALTER TABLE ${db.schema}.object_rules ADD COLUMN IF NOT EXISTS scopes jsonb;
    ALTER TABLE ${db.schema}.object_rules ADD COLUMN IF NOT EXISTS process_cursor bigint;
    UPDATE ${db.schema}.object_rules SET enabled=false,error='Re-save the rule to record its original authorization scopes' WHERE scopes IS NULL AND enabled;
    CREATE TABLE IF NOT EXISTS ${db.schema}.rule_matches(rule_id uuid NOT NULL REFERENCES ${db.schema}.object_rules(id),type text NOT NULL,id text NOT NULL,matched boolean NOT NULL,revision bigint NOT NULL,PRIMARY KEY(rule_id,type,id));
    ALTER TABLE ${db.schema}.rule_matches ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS ${db.schema}.workflow_runs(id uuid PRIMARY KEY,owner text NOT NULL,ontology text NOT NULL,release text NOT NULL REFERENCES ${db.schema}.releases(digest),request_id text NOT NULL,digest text NOT NULL,workflow_id uuid NOT NULL REFERENCES ${db.schema}.workflows(id),body jsonb NOT NULL,object_ref jsonb NOT NULL,scopes jsonb NOT NULL,step integer NOT NULL DEFAULT 0,state text NOT NULL DEFAULT 'pending',error text,token uuid,lease_until timestamptz,results jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner,request_id));
    ALTER TABLE ${db.schema}.workflow_runs ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE ${db.schema}.workflow_runs ADD COLUMN IF NOT EXISTS process_trigger jsonb;
    ALTER TABLE ${db.schema}.workflow_runs ADD COLUMN IF NOT EXISTS proposal_task uuid;
    ALTER TABLE ${db.schema}.workflow_runs ADD COLUMN IF NOT EXISTS proposal_scenario uuid;
    ALTER TABLE ${db.schema}.workflow_runs ADD COLUMN IF NOT EXISTS proposal_deadline timestamptz;
    ALTER TABLE ${db.schema}.tasks ADD COLUMN IF NOT EXISTS cognitive_context jsonb;
    ALTER TABLE ${db.schema}.tasks ADD COLUMN IF NOT EXISTS cognitive_evidence jsonb;
    ALTER TABLE ${db.schema}.tasks ADD COLUMN IF NOT EXISTS cognitive_tool_calls integer NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS ${db.schema}.workflow_steps(run_id uuid NOT NULL REFERENCES ${db.schema}.workflow_runs(id),position integer NOT NULL,
      action text NOT NULL,input jsonb NOT NULL,requirements jsonb NOT NULL,request_id text NOT NULL,result jsonb,completed_at timestamptz,
      PRIMARY KEY(run_id,position));
    ALTER TABLE ${db.schema}.workflow_steps ADD COLUMN IF NOT EXISTS read_markings jsonb;
    CREATE INDEX IF NOT EXISTS workflow_runs_queue ON ${db.schema}.workflow_runs(state,created_at);
    CREATE INDEX IF NOT EXISTS workflow_runs_due ON ${db.schema}.workflow_runs(available_at) WHERE state='pending';`);
}
const failureMessage =
  'Workflow execution failed; check current permissions, publication and Action input before retrying';
class MissingFrozenSecurityContext extends Conflict {}
class ProcessTriggerInactive extends Conflict {}
const missingSecurityContextMessage =
  'Frozen input security context is unavailable; submit a new workflow run';
const revisionMatches = (id: string | undefined, revision: number) => {
  if (id ? revision < 1 : revision !== 0)
    throw new Conflict('Updates require the current revision; creates use revision zero');
};
type ProcessTrigger = z.output<typeof processTriggerSchema>;
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
    if (input.proposal) authorizeCognitive(access, model, input.proposal);
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
        : await insertWorkflowRecord(this.db, client, {
            id, owner: access.principal.owner, ontology: model.document.id, name: input.name, body: input,
          });
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
      if (input.id && !(await this.db.query(
        `SELECT 1 FROM ${this.db.schema}.object_rules WHERE id=$1 AND owner=$2 AND revision=$3 AND ontology=$4 FOR UPDATE`,
        [id, access.principal.owner, input.revision, model.document.id], client)).rowCount)
        throw new Conflict('Rule changed or is unavailable');
      await this.active(model, client);
      const workflow = await readWorkflowRecord(this.db, {
        id: input.workflow, owner: access.principal.owner, ontology: model.document.id,
      }, client);
      if (!workflow) throw new NotFound('Workflow is unavailable');
      const definition = workflowSchema.parse(workflow.body);
      this.authorize(access, model, definition.steps);
      if (definition.proposal) authorizeCognitive(access, model, definition.proposal);
      const graph = new Objects(this.db, model, access, client);
      const target = 'process' in input ? processTarget(graph, input.process) : undefined;
      if ('query' in input)
        for (const type of model.concreteTypes(input.query.type)) access.read(model, type);
      const result = input.id
        ? await this.db.query(
            `UPDATE ${this.db.schema}.object_rules SET name=$3,body=$4,enabled=$5,revision=revision+1,error=NULL,scopes=$8,last_scan=NULL,process_cursor=NULL WHERE id=$1 AND owner=$2 AND revision=$6 AND ontology=$7 AND NOT (body ? 'machineryReview') RETURNING revision`,
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
      if (target) {
        await this.db.setOwner(client, graph.owner);
        await graph.lockWrites();
        const [latest] = await readProcessTransitions(this.db, model, graph.owner, target, client, {});
        await this.db.query(`UPDATE ${this.db.schema}.object_rules SET process_cursor=$2 WHERE id=$1`,
          [id, latest?.sequence ?? '0'], client);
      }
      await access.refresh(client);
      return { ...input, id, revision: Number(result.rows[0]!.revision) };
    });
  }
  async processStatus(access: Access, model: PublishedOntology, raw: unknown) {
    requireScope(access.principal, 'ontology:read');
    const input = processStatusSchema.parse(raw);
    return this.db.transaction(async (client) => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], client);
      await this.db.setOwner(client, access.principal.owner);
      await this.active(model, client);
      await access.refresh(client);
      return readProcessStatus(new Objects(this.db, model, access, client), input);
    });
  }
  async list(access: Access, model: PublishedOntology, kind: 'workflows' | 'object_rules' | 'workflow_runs') {
    requireScope(access.principal, 'ontology:read');
    z.enum(['workflows', 'object_rules', 'workflow_runs']).parse(kind);
    await access.refresh();
    access.require(model.document.id, 'view_definition', model.document.id);
    const rows = (
      await this.db.query(
        `SELECT * FROM ${this.db.schema}.${kind} WHERE owner=$1 AND ontology=$2 ${kind === 'object_rules' ? "AND NOT (body ? 'machineryReview')" : ''} ORDER BY id DESC LIMIT 101`,
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
    for (const row of rows) {
      if (kind === 'workflow_runs') {
        const trigger = row.process_trigger && processTriggerSchema.parse(row.process_trigger);
        if (trigger && (!model.objects.has(trigger.process.type) ||
            !await matchingTransition(graph, trigger.process, trigger.sequence))) continue;
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
          stepCount: row.body.steps.length + Number(Boolean(row.body.proposal)),
          ...(object && row.proposal_task && access.principal.scopes.includes('tasks:read') ? {
            proposal: {
              taskId: row.proposal_task, scenarioId: row.proposal_scenario, deadline: row.proposal_deadline,
              mergeAction: row.body.proposal.mergeAction, mergeObjectParameter: row.body.proposal.mergeObjectParameter,
            },
          } : {}),
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
    return { items: items.slice(0, 100), hasMore: items.length > 100 };
  }
  async preview(access: Access, model: PublishedOntology, raw: unknown) {
    const input=automationPreviewSchema.parse(raw), owner=access.principal.owner;
    requireScope(access.principal,'ontology:read');
    requireScope(access.principal,'ontology:write');
    return this.db.withOwner(owner,()=>this.db.transaction(async client=>{
      const rule=(await this.db.query(`SELECT body,scopes,enabled,revision FROM ${this.db.schema}.object_rules
        WHERE id=$1 AND owner=$2 AND ontology=$3 FOR SHARE`,[input.rule,owner,model.document.id],client)).rows[0];
      if(!rule||Number(rule.revision)!==input.revision)throw new Conflict('Automation revision changed or is unavailable');
      const savedScopes = z.array(z.string()).parse(rule.scopes??[]);
      if(!savedScopes.includes('ontology:write'))throw new PermissionDenied('Save the rule with current write permission before previewing');
      const configuration=ruleSchema.parse(rule.body);
      const workflow = await readWorkflowRecord(this.db, {
        id: configuration.workflow, owner, ontology: model.document.id,
      }, client, null, true);
      if(!workflow)throw new NotFound('Automation workflow is unavailable');
      const definition=workflowSchema.parse(workflow.body);
      await lockEdits(this.db,model,owner,client);
      await access.refresh(client);
      this.authorize(access,model,definition.steps);
      const runnerPrincipal={...access.principal,scopes:access.principal.scopes.filter(scope=>savedScopes.includes(scope))};
      const evaluatedAt=Date.now()+input.elapsedSeconds*1000, signal=AbortSignal.timeout(15_000);
      const scenarios=new Scenarios(this.db), reports=[];
      const live=new Objects(this.db,model,access,client);
      const match=async(graph:Objects,query:z.output<typeof ruleQuerySchema>)=>{
        const page=await graph.query({...query,limit:100});
        if(page.cursor||page.items.length>100)throw new Conflict('Narrow conditions to at most 100 matching objects before previewing');
        return page.items;
      };
      const baseline='query' in configuration?new Set((await match(live,configuration.query)).map(item=>digest(item.ref))):undefined;
      for(const selected of input.scenarios){
        signal.throwIfAborted();
        const view=await scenarios.view(access,model,selected.id,client);
        const diff=await scenarios.inspect(access,model,selected.id,client);
        if(diff.revision!==selected.revision)throw new Conflict('Scenario revision changed; reload the selection');
        if(diff.conflicts)throw new Conflict('Resolve Scenario conflicts before previewing automations');
        const branch=await Access.load(this.db,runnerPrincipal,client), graph=new Objects(this.db,view,branch,client);
        const waiting:ObjectRef[]=[];
        let entered:ObjectRef[];
        if('query' in configuration){
          entered=(await match(graph,configuration.query)).filter(item=>!baseline!.has(digest(item.ref))).map(item=>item.ref);
        }else{
          const target=processTarget(graph,configuration.process);
          entered=diff.objects.filter(item=>{
            if(item.ref.type!==target.objectType||!item.after||typeof item.after[target.property]!=='string')return false;
            if(item.before&&!Object.hasOwn(item.before,target.property))return false;
            const prev=item.before?.[target.property]??null,next=item.after[target.property];
            return prev!==next&&(configuration.process.from===undefined||configuration.process.from===prev)
              &&(configuration.process.to===undefined||configuration.process.to===next);
          }).map(item=>item.ref);
          if((configuration.process.dwellSeconds??0)>input.elapsedSeconds)waiting.push(...entered.splice(0));
        }
        if(entered.length>20||entered.length*Math.max(1,definition.steps.length)>60)
          throw new Conflict('Automation preview exceeds its execution budget; narrow the condition');
        const results=[];
        for(const ref of entered){
          const steps:{name:string;action:string;status:'completed'|'rejected'}[]=[];
          let status:'completed'|'rejected'|'proposal_required'='completed', reason:string|undefined;
          await this.db.query('SAVEPOINT automation_preview',[],client);
          try{
            const bindings=new Map<string,ObjectRef>();
            for(const item of definition.steps){
              try{
                const object=await graph.read(ref);
                const result=await this.actions.apply(branch,view,item.action,bindWorkflowInput(item,object,bindings),
                  randomUUID(),undefined,undefined,signal,undefined,{client,evaluatedAt});
                bindings.set(item.name,result);
                steps.push({name:item.name,action:item.action,status:'completed'});
              }catch(error){
                if(!(error instanceof Conflict||error instanceof NotFound))throw error;
                steps.push({name:item.name,action:item.action,status:'rejected'});
                status='rejected';reason=error.message;break;
              }
            }
            if(status==='completed'&&definition.proposal)status='proposal_required';
            await branch.refresh(client);
          }finally{
            await this.db.query('ROLLBACK TO SAVEPOINT automation_preview',[],client);
            await this.db.query('RELEASE SAVEPOINT automation_preview',[],client);
          }
          results.push({object:ref,status,reason,steps});
        }
        await branch.refresh(client);
        access.adoptReads(branch);
        reports.push({id:selected.id,revision:selected.revision,name:diff.name,waiting,results});
      }
      await access.refresh(client);
      return {rule:input.rule,revision:input.revision,enabled:rule.enabled,workflowRevision:Number(workflow.revision),
        release:model.release,mode:'scenario_preview',scenarios:reports};
    }));
  }

  async run(access: Access, model: PublishedOntology, raw: unknown) {
    requireScope(access.principal, 'ontology:write');
    const input = runWorkflowSchema.parse(raw);
    await access.refresh();
    return this.db.transaction(async (client) => {
      await this.active(model, client);
      const workflow = await readWorkflowRecord(this.db, {
        id: input.workflow, owner: access.principal.owner, ontology: model.document.id,
      }, client);
      if (!workflow) throw new NotFound('Workflow is unavailable');
      const definition = workflowSchema.parse(workflow.body);
      this.authorize(access, model, definition.steps);
      if (definition.proposal) authorizeCognitive(access, model, definition.proposal);
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
    const object = await this.scanRule(false);
    const process = await this.scanRule(true);
    return object || process;
  }
  private async scanRule(process: boolean): Promise<boolean> {
    return this.db.transaction(async (client) => {
      if (!process) await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], client);
      const rule = (
        await this.db.query(
          `SELECT * FROM ${this.db.schema}.object_rules WHERE enabled AND NOT (body ? 'machineryReview') AND (process_cursor IS NOT NULL)=$1
            AND (last_scan IS NULL OR last_scan<=now()-$2*interval '1 second') ORDER BY last_scan NULLS FIRST FOR UPDATE SKIP LOCKED LIMIT 1`,
          [process, process ? 1 : 30],
          client,
        )
      ).rows[0];
      if (!rule) return false;
      await this.db.setOwner(client, String(rule.owner));
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
          workflow = await readWorkflowRecord(this.db, {
            id: input.workflow, owner: String(rule.owner), ontology: String(rule.ontology),
          }, client);
        if (!workflow) throw new NotFound('Rule workflow is unavailable');
        const body = workflowSchema.parse(workflow.body);
        this.authorize(access, model, body.steps);
        const graph = new Objects(this.db, model, access, client);
        if ('process' in input) {
          await this.scanProcess(graph, String(rule.id), Number(rule.revision), String(rule.process_cursor), input, body);
        } else {
          await this.scanMatches(graph, String(rule.id), Number(rule.revision), input, body);
        }
        await access.refresh(client);
        await this.db.query('RELEASE SAVEPOINT rule_scan', [], client);
      } catch (error) {
        await this.db.query('ROLLBACK TO SAVEPOINT rule_scan', [], client);
        const code = (error as {code?: string})?.code;
        if (process && (code === '55P03' || code === '40001' || code === '40P01')) return true;
        await this.db.query(
          `UPDATE ${this.db.schema}.object_rules SET enabled=false,error='Rule scan failed; review permissions, publication and trigger before enabling it again' WHERE id=$1`,
          [rule.id],
          client,
        );
      }
      return true;
    });
  }
  private async scanMatches(graph: Objects, ruleId: string, revision: number,
    input: z.output<typeof objectRule>, body: z.output<typeof workflowSchema>) {
    const { access, client, model, owner } = graph;
    for (const type of model.concreteTypes(input.query.type)) access.read(model, type);
    const matched = new Map<string, { ref: ObjectRef; revision: number }>();
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
        [ruleId],
        client,
      )
    ).rows;
    const prior = new Map(previous.map((item) => [digest({ type: item.type, id: item.id }), item]));
    for (const [key, item] of matched) {
      const before = prior.get(key),
        entered = !before?.matched,
        generation = Number(before?.generation ?? 0) + (entered ? 1 : 0);
      if (entered) {
        const fingerprint = digest([ruleId, revision, item.ref, generation]);
        const requestId = 'rule:' + fingerprint;
        await this.db.query(
          `INSERT INTO ${this.db.schema}.workflow_runs(id,owner,ontology,release,request_id,digest,workflow_id,body,object_ref,scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(owner,request_id) DO NOTHING`,
          [
            randomUUID(),
            owner,
            model.document.id,
            model.release,
            requestId,
            fingerprint,
            input.workflow,
            body,
            item.ref,
            JSON.stringify(access.principal.scopes),
          ],
          client,
        );
      }
      await this.db.query(
        `INSERT INTO ${this.db.schema}.rule_matches(rule_id,type,id,matched,revision,generation) VALUES($1,$2,$3,true,$4,$5) ON CONFLICT(rule_id,type,id) DO UPDATE SET matched=true,revision=excluded.revision,generation=excluded.generation`,
        [ruleId, item.ref.type, item.ref.id, item.revision, generation],
        client,
      );
    }
    for (const [key, item] of prior)
      if (!matched.has(key))
        await this.db.query(
          `UPDATE ${this.db.schema}.rule_matches SET matched=false WHERE rule_id=$1 AND type=$2 AND id=$3`,
          [ruleId, item.type, item.id],
          client,
        );
  }
  private async scanProcess(graph: Objects, ruleId: string, revision: number, cursor: string,
    input: z.output<typeof processRule>, body: z.output<typeof workflowSchema>) {
    const { access, client, model, owner } = graph;
    const target = processTarget(graph, input.process);
    // A writer cannot allocate a journal sequence for this owner/release until the checkpoint commits.
    await graph.lockWrites();
    const page = await readProcessTransitions(this.db, model, owner, target, client, { after: cursor, limit: 100 });
    for (const item of page) {
      if (!await matchingTransition(graph, input.process, item.sequence)) continue;
      const trigger: ProcessTrigger = { ruleId, revision, sequence: item.sequence, process: input.process };
      const fingerprint = digest(trigger);
      const object = { type: target.objectType, id: item.objectId };
      const availableAt = new Date(item.recordedAt.getTime() + (input.process.dwellSeconds ?? 0) * 1000);
      await this.db.query(
        `INSERT INTO ${this.db.schema}.workflow_runs(id,owner,ontology,release,request_id,digest,workflow_id,body,object_ref,scopes,available_at,process_trigger)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(owner,request_id) DO NOTHING`,
        [randomUUID(), owner, model.document.id, model.release, 'process-rule:' + fingerprint, fingerprint, input.workflow,
          body, object, JSON.stringify(access.principal.scopes), availableAt, trigger], client);
    }
    if (page.length) await this.db.query(`UPDATE ${this.db.schema}.object_rules SET process_cursor=$2 WHERE id=$1`,
      [ruleId, page.at(-1)!.sequence], client);
  }
  private async verifyProcessTrigger(graph: Objects, object: ObjectRef, trigger: ProcessTrigger, firstStep: boolean) {
    const { access, client, model, owner } = graph;
    await this.db.setOwner(client, owner);
    const current = await this.db.query(
      `SELECT 1 FROM ${this.db.schema}.object_rules WHERE id=$1 AND owner=$2 AND ontology=$3 AND revision=$4 AND enabled FOR SHARE`,
      [trigger.ruleId, owner, model.document.id, trigger.revision], client);
    if (!current.rowCount) throw new ProcessTriggerInactive('Process rule changed or was disabled');
    const target = processTarget(graph, trigger.process);
    // Acquire the rule lock before the owner write lock, as in scanProcess and rule updates.
    await graph.lockWrites();
    const log = await matchingTransition(graph, trigger.process, trigger.sequence);
    if (!log || target.objectType !== object.type || log.properties.processId !== object.id)
      throw new PermissionDenied('The triggering process transition is unavailable');
    if (firstStep && trigger.process.dwellSeconds) {
      const [latest] = await readProcessTransitions(this.db, model, owner, target, client, { latestFor: object.id });
      const current = await graph.read(object);
      if (latest?.sequence !== trigger.sequence || current.properties[target.property] !== trigger.process.to)
        throw new ProcessTriggerInactive('A later transition ended the state before the workflow could start');
    }
    // A trigger can depend on a historically marked state even after the live object has been cleared.
    const history = (await this.db.query(
      `SELECT before_values,after_values FROM ${this.db.schema}.edit_history WHERE owner=$1 AND sequence=$2 AND type=$3 AND id=$4`,
      [owner, trigger.sequence, object.type, object.id], client)).rows[0]!;
    for (const snapshot of [history.before_values, history.after_values])
      if (snapshot) access.readRow(model, object.type, snapshot);
  }
  async runOne(signal = AbortSignal.timeout(120000)): Promise<boolean> {
    signal.throwIfAborted();
    const token = randomUUID();
    const row = await this.db.transaction(async (client) => {
      const found = (
        await this.db.query(
          `SELECT * FROM ${this.db.schema}.workflow_runs WHERE (state='pending' AND available_at<=now()) OR(state='working' AND lease_until<now())
            OR (state='waiting-proposal' AND EXISTS (
              SELECT 1 FROM ${this.db.schema}.tasks task WHERE task.id=proposal_task
              AND task.state IN ('completed','failed','canceled')))
            OR (state IN ('waiting-proposal','waiting-approval') AND proposal_deadline<=now())
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
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
    await this.db.withOwner(String(row.owner), () => this.executeRun(row, token, signal));
    return true;
  }
  private async executeRun(row: QueryResultRow, token: string, signal: AbortSignal) {
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
      const { steps, proposal } = workflowSchema.parse(row.body);
      const trigger = row.process_trigger ? processTriggerSchema.parse(row.process_trigger) : undefined;
      const triggeringObject = objectRefSchema.parse(row.object_ref);
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
          const object = await graph.read(triggeringObject);
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
          const input = bindWorkflowInput(item,object,previousResults);
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
          if (trigger) await this.db.transaction(async client => {
            await guard(client);
            await this.verifyProcessTrigger(new Objects(this.db, model, access, client), triggeringObject, trigger, position === 0);
          });
          const boundResults = Object.entries(item.input)
            .filter(([, binding]) => 'step' in binding)
            .map(([parameter]) => objectRefSchema.parse(frozen.input[parameter]));
          for (const reference of boundResults) await new Objects(this.db, model, access).read(reference);
          let checkedInputs = false;
          let checkedTransaction: string | undefined;
          const checkCommit = async (client: Sql) => {
            await guard(client);
            const transaction = trigger ? String((await this.db.query(
              'SELECT pg_current_xact_id()::text AS id', [], client)).rows[0]!.id) : undefined;
            // Authorize before edits under the write lock; a valid Action may subsequently delete its input.
            if (!checkedInputs || checkedTransaction !== transaction) {
              const graph = new Objects(this.db, model, access, client);
              if (trigger) await this.verifyProcessTrigger(graph, triggeringObject, trigger, position === 0);
              else await graph.lockWrites();
              await access.restoreReads(frozen.requirements as Requirement[], markings, client);
              for (const reference of boundResults) await graph.read(reference);
              checkedInputs = true;
              checkedTransaction = transaction;
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
          const commitGuard = (client: Sql) =>
            trigger && client === this.db.pool ? this.db.transaction(checkCommit) : checkCommit(client);
          result = await this.actions.apply(
            access,
            model,
            frozen.action,
            frozen.input,
            requestId,
            commitGuard,
            undefined,
            executionSignal,
            { kind: 'workflow', id: String(row.id) },
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
      if (proposal) {
        await this.runProposal(row, token, model, access, proposal, triggeringObject, trigger, guard);
        return;
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
      await this.db.transaction(async client => {
        const ended = (await this.db.query<{ owner: string; proposal_task: string | null }>(
          `UPDATE ${this.db.schema}.workflow_runs SET state=$3,error=$4,token=NULL,lease_until=NULL,updated_at=now()
            WHERE id=$1 AND token=$2 AND state='working' RETURNING owner,proposal_task`,
          [row.id, token, error instanceof ProcessTriggerInactive ? 'canceled' : 'failed',
            error instanceof ProcessTriggerInactive || error instanceof MissingFrozenSecurityContext ? error.message : failureMessage],
          client,
        )).rows[0];
        if (ended?.proposal_task) await this.cancelProposalTask(client, ended.owner, ended.proposal_task);
      });
    }
  }
  private async runProposal(row: QueryResultRow, token: string, model: PublishedOntology, access: Access,
    proposal: CognitiveStep, object: ObjectRef, trigger: ProcessTrigger | undefined, guard: (client: Sql) => Promise<void>) {
    await this.db.transaction(async client => {
      await guard(client);
      const status = row.proposal_task ? (await this.db.query(
        `SELECT task.state,task.result,task.result_permissions,run.proposal_deadline<=clock_timestamp() AS expired,
            scenario.revision,scenario.state AS scenario_state
          FROM ${this.db.schema}.workflow_runs run JOIN ${this.db.schema}.tasks task ON task.id=run.proposal_task AND task.owner=run.owner
          LEFT JOIN ${this.db.schema}.scenarios scenario ON scenario.id=run.proposal_scenario AND scenario.owner=run.owner
          WHERE run.id=$1 AND run.token=$2`, [row.id, token], client,
      )).rows[0] : undefined;
      if (row.proposal_task && !status) throw new Conflict('Workflow proposal task is unavailable');
      // Closing an expired proposal is lifecycle work. It must survive revoked execution access.
      if (status && (status.expired || !status.scenario_state)) {
        await this.finishProposal(client, row, token, model, 'expired');
        return;
      }
      await this.active(model, client);
      await access.refresh(client);
      authorizeCognitive(access, model, proposal);
      const owner = access.principal.owner;
      const graph = new Objects(this.db, model, access, client);
      if (!status) {
        if (trigger) await this.verifyProcessTrigger(graph, object, trigger, row.body.steps.length === 0);
        const taskId = randomUUID(), requestId = 'workflow-proposal:' + row.id;
        const { reviewers, timeoutSeconds, mergeAction: _mergeAction, mergeObjectParameter: _mergeObjectParameter, ...manifest } = proposal;
        const scenario = await new Scenarios(this.db).create(access, model, {
          requestId, name: proposal.name, ttlSeconds: timeoutSeconds,
        }, undefined, { client, runId: row.id, reviewers });
        workflowMerge(model, proposal, object, scenario.id, scenario.revision);
        const input = await graph.read(object);
        const context = cognitiveContextSchema.parse({
          ...manifest, runId: row.id, scenarioId: scenario.id, object, revision: input.revision,
        });
        const taskInput = { requestId, message: proposal.goal };
        await this.db.query(
          `INSERT INTO ${this.db.schema}.tasks(id,owner,request_id,input_digest,input,release,scopes,cognitive_context,cognitive_evidence)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'[]'::jsonb)`,
          [taskId, owner, requestId, digest(taskInput), taskInput, model.release, JSON.stringify(access.principal.scopes), context], client,
        );
        await this.db.query(
          `UPDATE ${this.db.schema}.workflow_runs SET state='waiting-proposal',proposal_task=$2,proposal_scenario=$3,
            proposal_deadline=$4,token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`,
          [row.id, taskId, scenario.id, scenario.expiresAt], client,
        );
        await appendTrace(this.db, { owner, taskId, scenarioId: scenario.id, release: model.release, projection: model.projection },
          { kind: 'proposal' }, client, await access.finalDataRequirements(client));
        await this.db.query("SELECT pg_notify('eigos_tasks','ready')", [], client);
        return;
      }

      const result = cognitiveResultSchema.safeParse(status.result?.proposal);
      const ready = status.scenario_state === 'open' && status.state === 'completed'
        && result.success && result.data.scenarioId === row.proposal_scenario && result.data.revision === Number(status.revision)
        && status.result_permissions && await access.canReturn(status.result_permissions, client);
      await this.finishProposal(client, row, token, model, ready ? 'waiting-approval' : 'failed',
        await access.finalDataRequirements(client));
    });
  }

  private async finishProposal(client: Sql, row: QueryResultRow, token: string, model: PublishedOntology,
    state: 'expired' | 'waiting-approval' | 'failed', requirements: Requirement[] = []) {
    if (state !== 'waiting-approval') await this.cancelProposalTask(client, row.owner, row.proposal_task);
    await appendTrace(this.db, { owner: row.owner, taskId: row.proposal_task, release: model.release, projection: model.projection },
      { kind: 'workflow', runId: row.id, state }, client, requirements);
    await this.db.query(
      `UPDATE ${this.db.schema}.workflow_runs SET state=$3,error=$4,token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND token=$2`,
      [row.id, token, state, state === 'expired' ? 'Workflow proposal expired'
        : state === 'failed' ? 'Workflow proposal did not complete with a valid Scenario' : null], client,
    );
  }

  private async cancelProposalTask(client: Sql, owner: string, taskId: string) {
    await this.db.query(
      `UPDATE ${this.db.schema}.tasks SET state='canceled',token=NULL,lease_until=NULL,updated_at=now()
        WHERE owner=$1 AND id=$2 AND state IN ('submitted','working','input-required')`,
      [owner, taskId], client,
    );
  }
  async retry(access: Access, model: PublishedOntology, id: string) {
    requireScope(access.principal, 'ontology:write');
    z.uuid().parse(id);
    await access.refresh();
    return this.db.transaction(async (client) => {
      await this.active(model, client);
      const row = (
        await this.db.query(
          `SELECT * FROM ${this.db.schema}.workflow_runs WHERE id=$1 AND owner=$2 AND ontology=$3 AND state='failed' AND proposal_task IS NULL FOR UPDATE`,
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
      if (row.proposal_task) await this.cancelProposalTask(client, access.principal.owner, row.proposal_task);
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
