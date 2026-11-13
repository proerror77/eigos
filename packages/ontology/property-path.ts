import { z } from 'zod';

type Schema = Record<string, unknown>;
const schemaObject = (value: unknown): Schema | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Schema : undefined;

export const propertyPathSchema = z.string().min(1).max(500).regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/);

/** Resolve a declared field from the compiled property contract, including reusable and nullable types. */
export function fieldSchema(schema: Schema, field: string): Schema | undefined {
  const properties = schemaObject(schema.properties);
  const direct = properties && Object.hasOwn(properties, field) ? schemaObject(properties[field]) : undefined;
  if (direct) return direct;
  if (properties && Object.hasOwn(properties, field)) return undefined;

  if (schema.type === 'array' || Array.isArray(schema.type) && schema.type.includes('array')) {
    if (!/^(0|[1-9]\d*)$/.test(field)) return undefined;
    const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems[Number(field)] : undefined;
    const item = tuple ?? schema.items;
    const element = schemaObject(item) ?? (item === true ? {} : undefined);
    if (element) return element;
  }

  for (const operator of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[operator];
    if (!Array.isArray(branches)) continue;
    const fields = branches.flatMap(branch => {
      const definition = schemaObject(branch);
      const found = definition && fieldSchema(definition, field);
      return found ? [found] : [];
    });
    if (fields.length) return fields.length === 1 ? fields[0] : { [operator]: fields };
  }

  if (schema.type === 'object' || Array.isArray(schema.type) && schema.type.includes('object')) {
    return schemaObject(schema.additionalProperties) ?? (schema.additionalProperties === true ? {} : undefined);
  }
  return undefined;
}

const jsonTypes = ['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'];

/** The possible JSON value kinds, ignoring refinements that do not change the kind. */
export function valueKinds(schema: Schema): string[] {
  const kindOf = (value: unknown): string => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (Number.isInteger(value)) return 'integer';
    return typeof value;
  };
  let kinds = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : jsonTypes;
  kinds = kinds.flatMap(kind => kind === 'number' ? ['number', 'integer'] : [kind]);
  const literals = Object.hasOwn(schema, 'const') ? [schema.const] : schema.enum;
  if (Array.isArray(literals)) kinds = kinds.filter(kind => literals.some(value => kindOf(value) === kind));
  for (const operator of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[operator];
    if (!Array.isArray(branches)) continue;
    const possibilities = branches.map(branch => branch === false ? [] : valueKinds(schemaObject(branch) ?? {}));
    kinds = kinds.filter(kind => operator === 'allOf' ? possibilities.every(branch => branch.includes(kind))
      : possibilities.some(branch => branch.includes(kind)));
  }
  return [...new Set<string>(kinds)].sort();
}
