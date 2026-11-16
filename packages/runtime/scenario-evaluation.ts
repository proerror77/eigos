import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import { objectRefSchema, type ObjectRef } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { Actions } from './actions.js';
import type { Database, Sql } from './database.js';
import type { Functions } from './functions.js';
import { PublishedOntology } from './metadata.js';
import { ObjectSets, aggregateSetSchema } from './object-sets.js';
import { Objects } from './objects.js';
import { lockEdits } from './scenario-store.js';
import { Scenarios } from './scenarios.js';

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/);
const revision = z.number().int().positive();
const scenarioRef = z.strictObject({ id: z.uuid(), revision });
const objectVersion = z.strictObject({ object: objectRefSchema, revision });
const propertyPath = z.array(z.union([name, z.number().int().nonnegative()])).max(8);
const scalar = z.union([z.number().finite(), z.boolean(), z.string().max(500), z.null()]);
const binding = z.union([
  z.strictObject({ value: z.unknown() }),
  z.strictObject({ input: name }),
  z.strictObject({ result: name }),
]);
const boundInput = z.record(name, binding);
const resultFunction = z.strictObject({ function: name, path: propertyPath });
const metric = resultFunction.extend({ name, input: boundInput });
const distinct = (values: string[]) => new Set(values).size === values.length;

export const compareScenariosSchema = z.strictObject({
  scenarios: z.array(scenarioRef).min(2).max(6).refine(items => distinct(items.map(item => item.id)), 'Select distinct Scenarios'),
  aggregates: z.array(aggregateSetSchema).max(4).default([]),
  metrics: z.array(resultFunction.extend({ name, input: z.record(name, z.unknown()) })).max(12).default([])
    .refine(items => distinct(items.map(item => item.name)), 'Metric names must be distinct'),
});

const step = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('action'), name, action: name, input: boundInput }),
  resultFunction.extend({ kind: z.literal('check'), name, input: boundInput, equals: scalar }),
]);
const trialVariant = z.strictObject({
  name,
  steps: z.array(step).max(10).refine(items => distinct(items.map(item => item.name)), 'Step names must be distinct'),
});
export const trialScenariosSchema = z.strictObject({
  cases: z.array(z.strictObject({
    name,
    inputs: z.record(name, z.unknown()),
    evaluatedAt: z.iso.datetime({ offset: true }).optional(),
    evidence: z.array(objectVersion).min(1).max(20)
      .refine(items => distinct(items.map(item => digest(item.object))), 'Evidence objects must be distinct'),
  })).min(1).max(8).refine(items => distinct(items.map(item => item.name)), 'Case names must be distinct'),
  variants: z.array(trialVariant).min(2).max(4).refine(items => distinct(items.map(item => item.name)), 'Variant names must be distinct'),
  metrics: z.array(metric).min(1).max(12).refine(items => distinct(items.map(item => item.name)), 'Metric names must be distinct'),
}).refine(input => input.cases.length * input.variants.reduce((sum, item) => sum + item.steps.length + input.metrics.length, 0) <= 120,
  'The trial exceeds its step budget');

const suiteRef = z.strictObject({id:z.uuid(), revision});
export const saveEvaluationSuiteSchema = z.strictObject({
  id:z.uuid().optional(), revision:revision.optional(), requestId:z.string().min(1).max(128),
  name:z.string().min(1).max(200), trial:trialScenariosSchema, machinerySet:z.uuid().optional(),
}).refine(input=>Boolean(input.id)===Boolean(input.revision),'Updating a suite requires its revision');
export const runEvaluationSuiteSchema = suiteRef;
export const evaluationCasesFromSetSchema = z.strictObject({
  set:z.uuid(), parameter:name, limit:z.number().int().min(1).max(8).default(4),
});
export const promoteEvaluationSchema = z.strictObject({
  run:z.uuid(), case:name, variant:name, requestId:z.string().min(1).max(128),
  reviewers:z.array(z.string().min(1).max(200)).min(1).max(20),
});

export async function initializeScenarioEvaluations(db:Database){
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.scenario_evaluation_suites(
    id uuid PRIMARY KEY, owner text NOT NULL, ontology text NOT NULL, request_id text NOT NULL, revision integer NOT NULL,
    name text NOT NULL, body jsonb NOT NULL, machinery_set uuid, UNIQUE(owner,ontology,request_id));
    CREATE TABLE IF NOT EXISTS ${db.schema}.scenario_evaluation_runs(
    id uuid PRIMARY KEY, owner text NOT NULL, ontology text NOT NULL, suite_id uuid NOT NULL, suite_revision integer NOT NULL,
    release text NOT NULL, result jsonb NOT NULL, created_at timestamptz DEFAULT now());
    CREATE INDEX IF NOT EXISTS scenario_evaluation_runs_owner ON ${db.schema}.scenario_evaluation_runs(owner,ontology,created_at)`);
}
const trialReceiptSchema=z.array(z.strictObject({
  name, evaluatedAt:z.iso.datetime({offset:true}), inputDigest:z.string(),
  variants:z.array(z.strictObject({name, status:z.enum(['completed','rejected']), outcome:z.string()})),
}));
type CompareInput = z.output<typeof compareScenariosSchema>;
type TrialInput = z.output<typeof trialScenariosSchema>;
type EvaluationStep = { name: string; operation: string; status: 'completed' | 'rejected'; value?: z.output<typeof scalar> | ObjectRef };
type Facts = Record<string, unknown>;

function bind(input: z.output<typeof boundInput>, facts: Facts, results: Map<string, unknown>) {
  return Object.fromEntries(Object.entries(input).map(([parameter, binding]) => {
    if ('input' in binding) {
      if (!Object.hasOwn(facts, binding.input)) throw new Conflict(`Missing trial input: ${binding.input}`);
      return [parameter, facts[binding.input]];
    }
    if ('result' in binding) {
      if (!results.has(binding.result)) throw new Conflict(`Trial result is unavailable: ${binding.result}`);
      return [parameter, results.get(binding.result)];
    }
    return [parameter, binding.value];
  }));
}

function changes(diff: Awaited<ReturnType<Scenarios['inspect']>>) {
  return {
    objectsCreated: diff.objects.filter(item => !item.before).length,
    objectsEdited: diff.objects.filter(item => item.before && item.after).length,
    objectsDeleted: diff.objects.filter(item => !item.after).length,
    linksAdded: diff.links.filter(item => !item.removed).length,
    linksRemoved: diff.links.filter(item => item.removed).length,
    conflicts: diff.conflicts,
  };
}

export class ScenarioEvaluations {
  private readonly scenarios: Scenarios;
  private readonly sets: ObjectSets;
  constructor(private readonly db: Database, private readonly actions: Actions, private readonly functions: Functions) {
    this.scenarios = new Scenarios(db);
    this.sets = new ObjectSets(db);
  }

  options(access: Access, model: PublishedOntology) {
    access.require(model.document.id, 'view_definition', model.document.id);
    const definition = access.describe(model, true);
    const eligible = definition.functionTypes.filter(fn => this.functions.supportsScenarioEvaluation(model, fn.apiName));
    const supported = new Set(eligible.map(fn => fn.apiName));
    const functions = eligible.filter(fn => !fn.edits).map(fn => fn.apiName);
    const checks = new Set(functions);
    const actions = definition.actionTypes.filter(action =>
      !action.rules?.some(rule => rule.op === 'applyScenario')
      && (!action.function || supported.has(action.function))
      && action.submissionCriteria.every(criterion => checks.has(criterion.function))
    ).map(action => action.apiName);
    return { actions, functions };
  }

  private snapshot<T>(access: Access, model: PublishedOntology, evaluate: (client: Sql, at: Date, signal: AbortSignal, model:PublishedOntology) => Promise<T>,candidateBase?:string) {
    if (model.scenario) throw new Conflict('Select the current Ontology publication');
    access.require(model.document.id, 'view_definition', model.document.id);
    return this.db.withOwner(access.principal.owner, () => this.db.transaction(async client => {
      const scoped=candidateBase?new PublishedOntology(model.document,model.release,model.projection,model.runtimeId,
        model.bindings,undefined,{base:candidateBase,client}):model;
      await lockEdits(this.db, scoped, access.principal.owner, client);
      await access.refresh(client);
      const at = (await this.db.query<{ at: Date }>('SELECT clock_timestamp() AS at', [], client)).rows[0]!.at;
      const signal = AbortSignal.timeout(15_000);
      const result = await evaluate(client,at,signal,scoped);
      signal.throwIfAborted();
      await access.refresh(client);
      return result;
    }));
  }

  private requireMetric(model: PublishedOntology, functionName: string) {
    if (model.functions.get(functionName)?.edits) throw new Conflict('Scenario metrics must use a read-only Function');
    this.functions.requireScenarioEvaluation(model, functionName);
  }

  private async scalar(objects: Objects, metric: z.output<typeof resultFunction>, input: Facts, at: Date, signal: AbortSignal) {
    let value = await this.functions.invoke(objects.model, metric.function, input, {
      objects, principal: objects.access.principal, signal,
      scenarioEvaluation: { client: objects.client, evaluatedAt: at.getTime() },
    });
    for (const field of metric.path) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, field))
        throw new Conflict(`Metric path is unavailable for ${metric.function}`);
      value = (value as Record<string, unknown>)[field];
    }
    return scalar.parse(value);
  }

  async compare(access: Access, model: PublishedOntology, input: CompareInput) {
    for (const item of input.metrics) this.requireMetric(model, item.function);
    return this.snapshot(access, model, async (client, at, signal) => {
      const read = async (view: PublishedOntology) => {
        const metrics = [];
        for (const item of input.metrics)
          metrics.push([item.name, await this.scalar(new Objects(this.db, view, access, client), item, item.input, at, signal)] as const);
        const aggregates = [];
        for (const query of input.aggregates) {
          signal.throwIfAborted();
          aggregates.push(await this.sets.aggregate(access, view, query, client));
        }
        return { metrics: Object.fromEntries(metrics), aggregates };
      };
      const baseline = await read(model);
      const scenarios = [];
      for (const selected of input.scenarios) {
        const view = await this.scenarios.view(access, model, selected.id, client);
        access.recordScenarioRead(view, selected.id, model.release);
        const diff = await this.scenarios.inspect(access, model, selected.id, client);
        if (diff.revision !== selected.revision) throw new Conflict('Scenario revision changed; reload the selection');
        scenarios.push({ id: diff.id, name: diff.name, revision: diff.revision, changes: changes(diff), preview: { objects: diff.objects.slice(0, 50), links: diff.links.slice(0, 50) }, ...(await read(view)) });
      }
      return { release: model.release, evaluatedAt: at.toISOString(), baseline, scenarios };
    });
  }

  async trial(access: Access, model: PublishedOntology, input: TrialInput, candidateBase?:string) {
    return this.publicTrial(await this.trialReport(access,model,input,candidateBase));
  }

  private publicTrial(report:Awaited<ReturnType<ScenarioEvaluations['trialReport']>>){
    return {...report,cases:report.cases.map(item=>({...item,variants:item.variants.map(variant=>{
      if(variant.status==='rejected')return variant;
      const {footprint:_footprint,...visible}=variant;
      return visible;
    })}))};
  }

  private async trialReport(access: Access, model: PublishedOntology, input: TrialInput, candidateBase?:string) {
    for (const metric of input.metrics) this.requireMetric(model, metric.function);
    for (const variant of input.variants) {
      for (const step of variant.steps) {
        if (step.kind === 'check') {
          this.requireMetric(model, step.function);
          continue;
        }
        access.action(model, step.action);
        const action = model.action(step.action);
        if (action.rules?.some(rule => rule.op === 'applyScenario')) throw new Conflict('Merge Actions are unavailable in a trial');
        if (action.function) this.functions.requireScenarioEvaluation(model, action.function);
        for (const criterion of action.submissionCriteria) this.requireMetric(model, criterion.function);
      }
    }
    return this.snapshot(access, model, async (client, at, signal, model) => {
      const cases: {
        name: string; evidence: z.output<typeof objectVersion>[]; evaluatedAt: string; inputDigest: string;
        variants: Awaited<ReturnType<ScenarioEvaluations['runVariant']>>[];
      }[] = [];
      for (const item of input.cases) {
        const caseTime = item.evaluatedAt ? new Date(item.evaluatedAt) : at;
        if (caseTime > at) throw new Conflict('Trial evaluation time cannot be in the future');
        const readers = new Objects(this.db, model, access, client);
        const evidence = [];
        for (const expected of item.evidence) {
          const object = await readers.read(expected.object);
          if (object.revision !== expected.revision) throw new Conflict('Trial evidence changed; refresh the case');
          evidence.push(object);
        }
        const variants = [];
        for (const variant of input.variants) {
          signal.throwIfAborted();
          await this.db.query('SAVEPOINT scenario_variant', [], client);
          try {
            const branch = await access.fork(client);
            const result = await this.runVariant(branch, model, item.inputs, variant, input.metrics, client, caseTime, signal);
            access.adoptReads(branch);
            variants.push(result);
          } finally {
            await this.db.query('ROLLBACK TO SAVEPOINT scenario_variant', [], client);
            await this.db.query('RELEASE SAVEPOINT scenario_variant', [], client);
          }
        }
        cases.push({ name: item.name, evidence: item.evidence, evaluatedAt: caseTime.toISOString(),
          inputDigest: digest({ evidence, inputs: item.inputs, evaluatedAt: caseTime.toISOString() }), variants });
      }
      return {
        mode: 'offline' as const, release: model.release, evaluatedAt: at.toISOString(),
        experimentDigest: digest(input), cases,
        summary: input.variants.map(({ name }, index) => {
          const results = cases.map(item => item.variants[index]!);
          return { name, completed: results.filter(item => item.status === 'completed').length,
            rejected: results.filter(item => item.status === 'rejected').length,
            attemptedSteps: results.reduce((count, item) => count + item.steps.length, 0) };
        }),
      };
    },candidateBase);
  }

  async saveSuite(access:Access,model:PublishedOntology,raw:unknown){
    const input=saveEvaluationSuiteSchema.parse(raw),owner=access.principal.owner;
    return this.snapshot(access,model,async client=>{
      if(input.machinerySet)await this.requireCaseSet(access,model,input.trial,input.machinerySet,client);
      if(!input.id){
        const existing=(await this.db.query(`SELECT id,revision,name,body,machinery_set FROM ${this.db.schema}.scenario_evaluation_suites
          WHERE owner=$1 AND ontology=$2 AND request_id=$3`,[owner,model.document.id,input.requestId],client)).rows[0];
        if(existing){
          if(existing.name!==input.name||digest(existing.body)!==digest(input.trial)||existing.machinery_set!==(input.machinerySet??null))
            throw new Conflict('Evaluation suite request ID has different content');
          return {id:existing.id,revision:Number(existing.revision)};
        }
        const id=randomUUID();
        await this.db.query(`INSERT INTO ${this.db.schema}.scenario_evaluation_suites
          (id,owner,ontology,request_id,revision,name,body,machinery_set) VALUES($1,$2,$3,$4,1,$5,$6,$7)`,
          [id,owner,model.document.id,input.requestId,input.name,input.trial,input.machinerySet??null],client);
        return {id,revision:1};
      }
      const updated=(await this.db.query(`UPDATE ${this.db.schema}.scenario_evaluation_suites SET revision=revision+1,name=$5,body=$6,machinery_set=$7
        WHERE id=$1 AND owner=$2 AND ontology=$3 AND revision=$4 RETURNING revision`,
        [input.id,owner,model.document.id,input.revision,input.name,input.trial,input.machinerySet??null],client)).rows[0];
      if(!updated)throw new Conflict('Evaluation suite revision changed or is unavailable');
      return {id:input.id,revision:Number(updated.revision)};
    });
  }

  async casesFromSet(access:Access,model:PublishedOntology,raw:unknown){
    const input=evaluationCasesFromSetSchema.parse(raw);
    return this.snapshot(access,model,async client=>{
      const refs=await this.sets.members(access,model,{op:'saved',id:input.set},client);
      refs.sort((a,b)=>a.type.localeCompare(b.type)||a.id.localeCompare(b.id));
      const graph=new Objects(this.db,model,access,client);
      const cases=[];
      for(const [index,ref] of refs.slice(0,input.limit).entries()){
        const object=await graph.read(ref);
        cases.push({name:'Case'+(index+1),inputs:{[input.parameter]:ref},evidence:[{object:ref,revision:object.revision}]});
      }
      if(!await access.canReturn(access.dataRequirements(),client))throw new Conflict('Trial evidence permissions changed');
      return {cases,total:refs.length};
    });
  }

  private async requireCaseSet(access:Access,model:PublishedOntology,trial:TrialInput,set:string,client:Sql){
    const refs=new Set((await this.sets.members(access,model,{op:'saved',id:set},client)).map(item=>digest(item)));
    if(!trial.cases.every(item=>item.evidence.some(evidence=>refs.has(digest(evidence.object)))))
      throw new Conflict('Each evaluation case must reference an object in the selected Machinery Object Set');
  }

  async listSuites(access:Access,model:PublishedOntology){
    access.require(model.document.id,'view_definition',model.document.id);
    return this.db.withOwner(access.principal.owner,()=>this.db.transaction(async client=>{
      const args=[access.principal.owner,model.document.id];
      const suites=(await this.db.query(`SELECT id,revision,name,machinery_set AS "machinerySet"
        FROM ${this.db.schema}.scenario_evaluation_suites WHERE owner=$1 AND ontology=$2 ORDER BY name,id LIMIT 100`,args,client)).rows;
      const runs=(await this.db.query(`SELECT id,suite_id AS "suite",suite_revision AS "revision",release,created_at AS "createdAt"
        FROM ${this.db.schema}.scenario_evaluation_runs WHERE owner=$1 AND ontology=$2 ORDER BY created_at DESC,id LIMIT 100`,args,client)).rows;
      return {suites,runs};
    }));
  }

  private async loadSuite(access:Access,model:PublishedOntology,id:string,revision:number,client?:Sql){
    const row=(await this.db.query(`SELECT body,machinery_set FROM ${this.db.schema}.scenario_evaluation_suites
      WHERE id=$1 AND owner=$2 AND ontology=$3 AND revision=$4`,
      [id,access.principal.owner,model.document.id,revision],client)).rows[0];
    if(!row)throw new Conflict('Evaluation suite revision changed or is unavailable');
    return {trial:trialScenariosSchema.parse(row.body),set:row.machinery_set as string|null};
  }

  private outcome(result:Awaited<ReturnType<ScenarioEvaluations['runVariant']>>){
    return digest(result.status==='completed'?{metrics:result.metrics,footprint:result.footprint}:
      {status:result.status,reason:result.reason});
  }

  async runSuite(access:Access,model:PublishedOntology,raw:unknown){
    const input=runEvaluationSuiteSchema.parse(raw);
    const {trial,set}=await this.db.withOwner(access.principal.owner,
      ()=>this.loadSuite(access,model,input.id,input.revision));
    const report=await this.trialReport(access,model,trial);
    const id=randomUUID();
    const receipt=report.cases.map(item=>({
      name:item.name,evaluatedAt:item.evaluatedAt,inputDigest:item.inputDigest,
      variants:item.variants.map(variant=>({name:variant.name,status:variant.status,outcome:this.outcome(variant)})),
    }));
    await this.snapshot(access,model,async client=>{
      await this.loadSuite(access,model,input.id,input.revision,client);
      if(set)await this.requireCaseSet(access,model,trial,set,client);
      await this.db.query(`INSERT INTO ${this.db.schema}.scenario_evaluation_runs
        (id,owner,ontology,suite_id,suite_revision,release,result) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [id,access.principal.owner,model.document.id,input.id,input.revision,report.release,JSON.stringify(receipt)],client);
    });
    return {...this.publicTrial(report),run:id,suite:input.id,suiteRevision:input.revision};
  }

  async promote(access:Access,model:PublishedOntology,raw:unknown){
    const input=promoteEvaluationSchema.parse(raw),owner=access.principal.owner;
    return this.snapshot(access,model,async(client,at,signal)=>{
      const run=(await this.db.query(`SELECT suite_id,suite_revision,release,result FROM ${this.db.schema}.scenario_evaluation_runs
        WHERE id=$1 AND owner=$2 AND ontology=$3`,[input.run,owner,model.document.id],client)).rows[0];
      if(!run||run.release!==model.release)throw new Conflict('Run the evaluation on the current publication before promoting');
      const receipt=trialReceiptSchema.parse(run.result).find(item=>item.name===input.case);
      const verdict=receipt?.variants.find(item=>item.name===input.variant);
      if(verdict?.status!=='completed')throw new Conflict('Only a completed candidate can be proposed');
      const {trial,set}=await this.loadSuite(access,model,run.suite_id,Number(run.suite_revision),client);
      if(set)await this.requireCaseSet(access,model,trial,set,client);
      const item=trial.cases.find(item=>item.name===input.case)!;
      const variant=trial.variants.find(item=>item.name===input.variant)!;
      const readers=new Objects(this.db,model,access,client), evidence=[];
      for(const expected of item.evidence){
        const current=await readers.read(expected.object);
        if(current.revision!==expected.revision)throw new Conflict('Trial evidence changed; run the evaluation again');
        evidence.push(current);
      }
      if(digest({evidence,inputs:item.inputs,evaluatedAt:receipt!.evaluatedAt})!==receipt!.inputDigest)
        throw new Conflict('Trial evidence changed; run the evaluation again');
      const draft=await this.scenarios.create(access,model,{requestId:input.requestId,name:variant.name,
        description:`Evaluation run ${input.run}, case ${input.case}, candidate ${input.variant}, outcome ${verdict.outcome}, reviewers ${digest([...new Set(input.reviewers)].sort())}`},undefined,{client});
      // Re-evaluate for the current business clock. Historical evidence is useful for
      // comparison only; expired facts cannot become an actionable recommendation.
      if(draft.revision>1)return {id:draft.id,revision:draft.revision,run:input.run};
      const result=await this.runVariant(access,model,item.inputs,variant,trial.metrics,client,at,signal,draft);
      if(result.status!=='completed'||result.changes.conflicts||this.outcome(result)!==verdict.outcome)
        throw new Conflict('The chosen outcome changed; refresh evidence and rerun before proposing');
      const diff=await this.scenarios.inspect(access,model,draft.id,client);
      const review=await this.scenarios.inviteReviewers(access,model,draft.id,diff.revision,input.reviewers,client);
      return {id:draft.id,revision:review.revision,run:input.run,reviewers:review.reviewers};
    });
  }

  private async runVariant(access: Access, model: PublishedOntology, facts: Facts, variant: z.output<typeof trialVariant>,
    metrics: TrialInput['metrics'], client: Sql, at: Date, signal: AbortSignal, existing?:{id:string}) {
    const trial=existing??await this.scenarios.create(access,model,{
      requestId:randomUUID(),name:variant.name,kind:'temporary',sessionId:(await this.scenarios.openSession(access,60,client)).id,
    },undefined,{client});
    const view = await this.scenarios.view(access, model, trial.id, client);
    const objects = new Objects(this.db, view, access, client);
    const results = new Map<string, unknown>(), steps: EvaluationStep[] = [];
    const reject = (reason: string) => ({ name: variant.name, status: 'rejected' as const, reason, steps });
    for (const step of variant.steps) {
      const operation = step.kind === 'action' ? step.action : step.function;
      const input = bind(step.input, facts, results);
      try {
        const value = step.kind === 'action'
          ? await this.actions.apply(access, view, step.action, input, digest(['evaluation',variant.name,step.name,facts]), undefined, undefined, signal,
              undefined, { client, evaluatedAt: at.getTime() })
          : await this.scalar(objects, step, input, at, signal);
        if (step.kind === 'check' && value !== step.equals) {
          steps.push({ name: step.name, operation, status: 'rejected', value });
          return reject('Business check did not match its expected value');
        }
        results.set(step.name, value);
        steps.push({ name: step.name, operation, status: 'completed', value });
      } catch (error) {
        if (!(error instanceof Conflict || error instanceof NotFound)) throw error;
        steps.push({ name: step.name, operation, status: 'rejected' });
        return reject(error.message);
      }
    }
    const values = [];
    for (const metric of metrics) {
      const input = bind(metric.input, facts, results);
      try { values.push([metric.name, await this.scalar(objects, metric, input, at, signal)] as const); }
      catch (error) {
        if (!(error instanceof Conflict || error instanceof NotFound)) throw error;
        return reject(error.message);
      }
    }
    const diff = await this.scenarios.inspect(access, model, trial.id, client);
    return { name: variant.name, status: 'completed' as const, steps, metrics: Object.fromEntries(values), changes: changes(diff),
      footprint:await this.scenarios.evaluationFootprint(access.principal.owner,trial.id,client) };
  }
}

export type ScenarioComparisonInput = z.input<typeof compareScenariosSchema>;
export type ScenarioComparison = Awaited<ReturnType<ScenarioEvaluations['compare']>>;
export type ScenarioTrialInput = z.input<typeof trialScenariosSchema>;
export type ScenarioTrial = Awaited<ReturnType<ScenarioEvaluations['trial']>>;
