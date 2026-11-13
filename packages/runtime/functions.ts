import { digest, type Principal } from '../core/identity.js';
import { validator, Ontology } from '../ontology/model.js';
import { Objects } from './objects.js';
import type { Tasks, Task } from './tasks.js';
import type { ObjectRef } from '../ontology/schema.js';
import type { OntologyDocument } from '../ontology/schema.js';
import type { PublishedOntology } from './metadata.js';

export interface FunctionContext {
  principal: Principal; objects: Pick<Objects, 'model' | 'access' | 'read' | 'query' | 'follow'>; signal: AbortSignal; taskId?: string;
  execution?: { task: Task; tasks: Tasks };
  operationId?: string;
  edit?: (result: ObjectRef, write: (objects: Objects) => Promise<void>) => ObjectRef;
}
export type FunctionHandler = (input: Record<string, unknown>, context: FunctionContext) => unknown | Promise<unknown>;
const contract = ({ parameters, returns, source, edits }: OntologyDocument['functionTypes'][number]) => digest({ parameters, returns, source, edits });
export class Functions {
  private readonly contracts: Map<string, string>;
  constructor(private readonly handlers: ReadonlyMap<string, FunctionHandler>, definitions: OntologyDocument['functionTypes']) {
    this.contracts = new Map(definitions.map(fn => [fn.apiName, contract(fn)]));
  }
  bindings(model: Ontology): Record<string, string> {
    return Object.fromEntries(model.document.functionTypes.map(fn => {
      if (!this.handlers.has(fn.apiName) || this.contracts.get(fn.apiName) !== contract(fn)) throw new Error(`Function implementation is unavailable or incompatible: ${fn.apiName}`);
      return [fn.apiName, contract(fn)];
    }));
  }
  async invoke(model: PublishedOntology, name: string, input: Record<string, unknown>, context: FunctionContext) {
    const access = context.objects.access;
    access.function(model, name);
    if (model.runtimeId !== access.runtimeId || model.bindings.functions[name] !== this.contracts.get(name)) throw new Error('Historical Function implementation is unavailable in this runtime');
    const definition = model.functions.get(name), handler = this.handlers.get(name);
    if (!definition || !handler) throw new Error(`Function is unavailable: ${name}`);
    if (definition.edits && !context.edit) throw new Error('Ontology edit Functions must be invoked through an Action');
    if (definition.source) { await access.refresh(); access.source(model, definition.source); }
    context.signal.throwIfAborted();
    const parameters = validator(definition.parameters).parse(input) as Record<string, unknown>;
    const output = await handler(parameters, definition.edits ? context : { ...context, edit: undefined });
    context.signal.throwIfAborted();
    await access.refresh();
    return validator(definition.returns).parse(output);
  }
}
