import { requireScope, type Principal } from '../core/identity.js';
import { validator, Ontology } from '../ontology/model.js';
import { Objects } from './objects.js';
import type { Tasks, Task } from './tasks.js';
import type { ObjectRef } from '../ontology/schema.js';

export interface FunctionContext {
  principal: Principal; objects: Pick<Objects, 'model' | 'read' | 'query' | 'follow'>; signal: AbortSignal; taskId?: string;
  execution?: { task: Task; tasks: Tasks };
  operationId?: string;
  edit?: (result: ObjectRef, write: (objects: Objects) => Promise<void>) => ObjectRef;
}
export type FunctionHandler = (input: Record<string, unknown>, context: FunctionContext) => unknown | Promise<unknown>;
export class Functions {
  constructor(private readonly handlers: ReadonlyMap<string, FunctionHandler>) {}
  async invoke(model: Ontology, name: string, input: Record<string, unknown>, context: FunctionContext) {
    requireScope(context.principal, 'ontology:read');
    const definition = model.functions.get(name), handler = this.handlers.get(name);
    if (!definition || !handler) throw new Error(`Function is unavailable: ${name}`);
    if (definition.edits && !context.edit) throw new Error('Ontology edit Functions must be invoked through an Action');
    if (definition.source) requireScope(context.principal, `sources:${definition.source}:read`);
    context.signal.throwIfAborted();
    const parameters = validator(definition.parameters).parse(input) as Record<string, unknown>;
    const output = await handler(parameters, definition.edits ? context : { ...context, edit: undefined });
    context.signal.throwIfAborted();
    return validator(definition.returns).parse(output);
  }
}
