import type { Value } from '../ontology/schema.js';
import type { ActionEffect } from './effects.js';
import type { PublishedOntology } from './metadata.js';

export function evaluate(expression: Value, input: Record<string, unknown>): unknown {
  if ('literal' in expression) return expression.literal;
  let value: unknown = input[expression.parameter];
  for (const field of expression.path ?? []) value = value && typeof value === 'object' ? Reflect.get(value, field) : undefined;
  return value;
}

export function actionEffects(model: PublishedOntology, action: string, input: Record<string, unknown>): ActionEffect[] {
  return (model.action(action).effects ?? []).map(effect => ({
    name: effect.name,
    handler: effect.handler,
    payload: Object.fromEntries(Object.entries(effect.payload).map(([name, expression]) => [name, evaluate(expression, input)])),
  }));
}
