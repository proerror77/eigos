import { digest } from '../core/identity.js';
import type { LinkData, ObjectRef, Value } from '../ontology/schema.js';
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

type Properties = Record<string, unknown>;

export function changeDigest(
  objects: readonly { ref: ObjectRef; before: Properties | null; after: Properties | null }[],
  links: readonly { edge: LinkData; removed: boolean }[],
) {
  const net = objects.flatMap(({ ref, before, after }) => {
    if (!before || !after) return [{ ref, before, after }];
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      field => digest({ value: before[field] }) !== digest({ value: after[field] }),
    );
    if (fields.length === 0) return [];
    const select = (value: Properties) => Object.fromEntries(
      fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]),
    );
    return [{ ref, before: select(before), after: select(after) }];
  });
  return digest({ objects: net.map(digest).sort(), links: links.map(digest).sort() });
}
