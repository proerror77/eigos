import { Conflict, InvalidInput, NotFound, SourceReadFailure, digest, type Principal, type ExecutionActor } from '../core/identity.js';
import { validator, Ontology } from '../ontology/model.js';
import { Objects } from './objects.js';
import type { Tasks, Task } from './tasks.js';
import type { ObjectRef, OntologyDocument } from '../ontology/schema.js';
import { legacySourceEvidence } from '../ontology/source-evidence.js';
import type { PublishedOntology } from './metadata.js';
import type { Sql } from './database.js';
import type { ActionEffect } from './effects.js';

export type ScenarioEvaluation = { client: Sql; evaluatedAt: number };

export interface FunctionContext {
  scenarioEvaluation?: ScenarioEvaluation;
  principal: Principal; objects: Pick<Objects, 'model' | 'access' | 'read' | 'query' | 'follow' | 'matchesSource'>; signal: AbortSignal; taskId?: string;
  execution?: { task: Task; tasks: Tasks; executor?: ExecutionActor };
  operationId?: string;
  directAction?: boolean;
  validateScenarioAction?: (live: Objects, action: string, input: Record<string, unknown>) => Promise<void>;
  assertCurrent?: (client?: Sql) => Promise<void>;
  /** An existing provider operation must persist its dispatch claim in this transaction. */
  assertDispatch?: (client: Sql) => Promise<void>;
  /** Queue a declared effect with the Action's eventual atomic commit. */
  deferEffect?: (effect: ActionEffect) => void;
  edit?: (result: ObjectRef, write: (objects: Objects) => Promise<void>) => ObjectRef;
}
export type FunctionHandler = ((input: Record<string, unknown>, context: FunctionContext) => unknown | Promise<unknown>)
  & { scenarioPARead?: true; scenarioEvaluation?: true };
export const withScenarioPARead = (handler: FunctionHandler): FunctionHandler =>
  Object.assign(handler, { scenarioPARead: true as const });
export const withScenarioEvaluation = (handler: FunctionHandler): FunctionHandler =>
  Object.assign(handler, { scenarioEvaluation: true as const });
type Definition = OntologyDocument['functionTypes'][number];
export interface VersionedFunction {
  definition: Definition & { version: string };
  /** Immutable build/artifact identity. A changed implementation requires a new version. */
  implementationId: string;
  handler: FunctionHandler;
}
const contract = ({ parameters, returns, source, edits, dependencies }: Definition) => digest({ parameters, returns, source, edits, ...(dependencies?{dependencies}:{}) });
const key = (definition: Definition) => JSON.stringify([definition.apiName, definition.version ?? null]);
export class Functions {
  private readonly registered = new Map<string, { contract: string; binding: string; handler: FunctionHandler; legacy?: string }>();
  constructor(handlers: ReadonlyMap<string, FunctionHandler>, definitions: OntologyDocument['functionTypes'], versions: readonly VersionedFunction[] = []) {
    for (const definition of definitions) {
      if (definition.version) continue;
      const handler = handlers.get(definition.apiName);
      if (handler) {
        const current = contract(definition), legacyReturns = legacySourceEvidence(definition.returns);
        this.registered.set(key(definition), { contract: current, binding: current, handler,
          ...(legacyReturns !== definition.returns ? { legacy: contract({ ...definition, returns: legacyReturns }) } : {}) });
      }
    }
    for (const entry of versions) {
      const identity = key(entry.definition);
      if (!entry.implementationId || this.registered.has(identity)) throw new Error('Function versions require unique immutable implementation identities');
      this.registered.set(identity, { contract: contract(entry.definition), binding: digest({ contract: contract(entry.definition), version: entry.definition.version, implementation: entry.implementationId }), handler: entry.handler });
    }
  }
  versions() {
    return [...this.registered].map(([identity, entry]) => {
      const [name, version] = JSON.parse(identity) as [string, string | null];
      return { name, version, binding: entry.binding };
    });
  }
  bindings(model: Ontology): Record<string, string> {
    return Object.fromEntries(model.resolvedDocument.functionTypes.map(fn => {
      const entry = this.registered.get(key(fn));
      const reply = contract(fn);
      if (!entry || entry.contract !== reply && entry.legacy !== reply) throw new Error(`Function implementation is unavailable or incompatible: ${fn.apiName}`);
      return [fn.apiName, entry.legacy === reply ? reply : entry.binding];
    }));
  }
  supportsScenarioEvaluation(model: PublishedOntology, name: string) {
    const definition = model.functions.get(name);
    return Boolean(definition && !definition.source && this.registered.get(key(definition))?.handler.scenarioEvaluation);
  }
  requireScenarioEvaluation(model: PublishedOntology, name: string) {
    if (!this.supportsScenarioEvaluation(model, name))
      throw new Conflict(`Function is unavailable for offline Scenario evaluation: ${name}`);
  }
  async invoke(model: PublishedOntology, name: string, input: Record<string, unknown>, context: FunctionContext) {
    const access = context.objects.access;
    access.function(model, name);
    const definition = model.functions.get(name), entry = definition && this.registered.get(key(definition));
    if (!definition) throw new NotFound(`Function is unavailable: ${name}`);
    if (!entry) throw new Error(`Published Function implementation is unavailable: ${name}`);
    const reply = contract(definition), binding = entry.legacy === reply ? reply : entry.binding;
    if ((!definition.version && model.runtimeId !== access.runtimeId) || model.bindings.functions[name] !== binding ||
        reply !== entry.contract && reply !== entry.legacy) throw new Conflict('Historical Function implementation is unavailable in this runtime');
    if (context.scenarioEvaluation) this.requireScenarioEvaluation(model, name);
    if (model.scenario && definition.source && !(entry.handler.scenarioPARead && definition.edits && context.edit &&
      context.execution?.task.cognitive_context?.scenarioId === model.scenario))
      throw new Conflict('Read external sources before opening a scenario; scenario Functions only use Ontology data');
    if (definition.edits && !context.edit) throw new InvalidInput('Ontology edit Functions must be invoked through an Action');
    if (definition.source) { await access.refresh(); access.source(model, definition.source); }
    context.signal.throwIfAborted();
    const parameters = validator(definition.parameters).parse(input) as Record<string, unknown>;
    const output = await entry.handler(parameters, definition.edits ? context : {
      ...context, edit: undefined, validateScenarioAction: undefined, assertDispatch: undefined, deferEffect: undefined,
    });
    context.signal.throwIfAborted();
    await access.refresh(context.scenarioEvaluation?.client);
    const result = validator(definition.returns).safeParse(output);
    if (result.success) return result.data;
    if (definition.source) throw new SourceReadFailure('Source result does not match its published contract', { cause: result.error });
    throw new Error('Function result does not match its published contract', { cause: result.error });
  }
}
