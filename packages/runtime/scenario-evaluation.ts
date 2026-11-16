import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import { objectRefSchema, type ObjectRef } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { Actions } from './actions.js';
import type { Database, Sql } from './database.js';
import type { Functions } from './functions.js';
import type { PublishedOntology } from './metadata.js';
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

  private snapshot<T>(access: Access, model: PublishedOntology, evaluate: (client: Sql, at: Date, signal: AbortSignal) => Promise<T>) {
    if (model.scenario) throw new Conflict('Select the current Ontology publication');
    access.require(model.document.id, 'view_definition', model.document.id);
    return this.db.withOwner(access.principal.owner, () => this.db.transaction(async client => {
      await lockEdits(this.db, model, access.principal.owner, client);
      await access.refresh(client);
      const at = (await this.db.query<{ at: Date }>('SELECT clock_timestamp() AS at', [], client)).rows[0]!.at;
      const signal = AbortSignal.timeout(15_000);
      const result = await evaluate(client, at, signal);
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

  async trial(access: Access, model: PublishedOntology, input: TrialInput) {
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
    return this.snapshot(access, model, async (client, at, signal) => {
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
    });
  }

  private async runVariant(access: Access, model: PublishedOntology, facts: Facts, variant: z.output<typeof trialVariant>,
    metrics: TrialInput['metrics'], client: Sql, at: Date, signal: AbortSignal) {
    const session = await this.scenarios.openSession(access, 60, client);
    const trial = await this.scenarios.create(access, model, {
      requestId: randomUUID(), name: variant.name, kind: 'temporary', sessionId: session.id,
    }, undefined, { client });
    const view = await this.scenarios.view(access, model, trial.id, client);
    const objects = new Objects(this.db, view, access, client);
    const results = new Map<string, unknown>(), steps: EvaluationStep[] = [];
    const reject = (reason: string) => ({ name: variant.name, status: 'rejected' as const, reason, steps });
    for (const step of variant.steps) {
      const operation = step.kind === 'action' ? step.action : step.function;
      const input = bind(step.input, facts, results);
      try {
        const value = step.kind === 'action'
          ? await this.actions.apply(access, view, step.action, input, randomUUID(), undefined, undefined, signal,
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
    return { name: variant.name, status: 'completed' as const, steps, metrics: Object.fromEntries(values), changes: changes(diff) };
  }
}

export type ScenarioComparisonInput = z.input<typeof compareScenariosSchema>;
export type ScenarioComparison = Awaited<ReturnType<ScenarioEvaluations['compare']>>;
export type ScenarioTrialInput = z.input<typeof trialScenariosSchema>;
export type ScenarioTrial = Awaited<ReturnType<ScenarioEvaluations['trial']>>;
