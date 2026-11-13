import { digest, type Principal } from '../core/identity.js';
import { validator, Ontology } from '../ontology/model.js';
import { Objects } from './objects.js';
import type { Tasks, Task } from './tasks.js';
import type { ObjectRef, OntologyDocument } from '../ontology/schema.js';
import type { PublishedOntology } from './metadata.js';
import type { Sql } from './database.js';

export interface FunctionContext {
  principal: Principal; objects: Pick<Objects, 'model' | 'access' | 'read' | 'query' | 'follow' | 'matchesSource'>; signal: AbortSignal; taskId?: string;
  execution?: { task: Task; tasks: Tasks };
  operationId?: string;
  assertCurrent?: (client?: Sql) => Promise<void>;
  edit?: (result: ObjectRef, write: (objects: Objects) => Promise<void>) => ObjectRef;
}
export type FunctionHandler = (input: Record<string, unknown>, context: FunctionContext) => unknown | Promise<unknown>;
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
  private readonly registered = new Map<string, { contract: string; binding: string; handler: FunctionHandler }>();
  constructor(handlers: ReadonlyMap<string, FunctionHandler>, definitions: OntologyDocument['functionTypes'], versions: readonly VersionedFunction[] = []) {
    for (const definition of definitions) {
      if (definition.version) continue;
      const handler = handlers.get(definition.apiName);
      if (handler) this.registered.set(key(definition), { contract: contract(definition), binding: contract(definition), handler });
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
      if (!entry || entry.contract !== contract(fn)) throw new Error(`Function implementation is unavailable or incompatible: ${fn.apiName}`);
      return [fn.apiName, entry.binding];
    }));
  }
  async invoke(model: PublishedOntology, name: string, input: Record<string, unknown>, context: FunctionContext) {
    const access = context.objects.access;
    access.function(model, name);
    const definition = model.functions.get(name), entry = definition && this.registered.get(key(definition));
    if (!definition || !entry) throw new Error(`Function is unavailable: ${name}`);
    if ((!definition.version && model.runtimeId !== access.runtimeId) || model.bindings.functions[name] !== entry.binding || contract(definition) !== entry.contract) throw new Error('Historical Function implementation is unavailable in this runtime');
    if (model.scenario && definition.source) throw new Error('Read external sources before opening a scenario; scenario Functions only use Ontology data');
    if (definition.edits && !context.edit) throw new Error('Ontology edit Functions must be invoked through an Action');
    if (definition.source) { await access.refresh(); access.source(model, definition.source); }
    context.signal.throwIfAborted();
    const parameters = validator(definition.parameters).parse(input) as Record<string, unknown>;
    const output = await entry.handler(parameters, definition.edits ? context : { ...context, edit: undefined });
    context.signal.throwIfAborted();
    await access.refresh();
    return validator(definition.returns).parse(output);
  }
}
