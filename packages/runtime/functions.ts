import { requireScope, type Principal } from '../core/identity.js';
import { validator, Ontology } from '../ontology/model.js';
import { Objects } from './objects.js';

export interface FunctionContext { principal: Principal; objects: Objects; signal: AbortSignal; taskId?: string }
export type FunctionHandler = (input: Record<string, unknown>, context: FunctionContext) => unknown | Promise<unknown>;
export class Functions {
  constructor(private readonly handlers: ReadonlyMap<string, FunctionHandler>) {}
  async invoke(model: Ontology, name: string, input: Record<string, unknown>, context: FunctionContext) {
    requireScope(context.principal, 'ontology:read');
    const definition = model.functions.get(name), handler = this.handlers.get(name);
    if (!definition || !handler) throw new Error(`Function is unavailable: ${name}`);
    if (definition.source) requireScope(context.principal, `sources:${definition.source}:read`);
    context.signal.throwIfAborted();
    const parameters = validator(definition.parameters).parse(input) as Record<string, unknown>;
    const output = await handler(parameters, context);
    context.signal.throwIfAborted();
    return validator(definition.returns).parse(output);
  }
}
