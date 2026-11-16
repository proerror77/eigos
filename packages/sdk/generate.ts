import type { OntologyDocument } from '../ontology/schema.js';

type Schema = Record<string, unknown>;
type Field = { type: string; required: boolean };
const record = (value: unknown): value is Schema =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const literal = (value: unknown) =>
  value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'
    ? JSON.stringify(value) : 'unknown';
const joined = (parts: string[], operator: ' | ' | ' & ') =>
  parts.length === 1 ? parts[0]! : '(' + parts.join(operator) + ')';

function fields(entries: Record<string, Field>) {
  return Object.entries(entries).map(([key, field]) =>
    `${JSON.stringify(key)}${field.required ? '' : '?'}: ${field.type};`).join(' ');
}

function shape(schema: Schema): string {
  const properties = record(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const members = Object.fromEntries(Object.entries(properties).map(([key, value]) =>
    [key, { type: schemaType(value), required: required.has(key) }]));
  if (!Object.keys(members).length)
    return `Record<string, ${schema.additionalProperties === false ? 'never' : schemaType(schema.additionalProperties)}>`;
  const extra = schema.additionalProperties === false ? '' : ' [key: string]: unknown;';
  return `{ ${fields(members)}${extra} }`;
}

function schemaType(raw: unknown): string {
  if (raw === false) return 'never';
  if (!record(raw)) return 'unknown';
  if (Object.hasOwn(raw, 'const')) return literal(raw.const);
  if (Array.isArray(raw.enum) && raw.enum.length) return joined(raw.enum.map(literal), ' | ');
  if (Array.isArray(raw.type) && raw.type.length)
    return joined(raw.type.map(type => schemaType({ ...raw, type })), ' | ');
  const alternatives = Array.isArray(raw.oneOf) ? raw.oneOf : raw.anyOf;
  if (Array.isArray(alternatives) && alternatives.length) return joined(alternatives.map(schemaType), ' | ');
  if (Array.isArray(raw.allOf) && raw.allOf.length) return joined(raw.allOf.map(schemaType), ' & ');
  switch (raw.type) {
    case 'string': case 'boolean': case 'null': return raw.type;
    case 'number': case 'integer': return 'number';
    case 'array': return `Array<${schemaType(raw.items)}>`;
    case 'object': return shape(raw);
    default: return 'unknown';
  }
}

function inputType(schema: Schema) {
  // The invocation transports always require an argument object.
  return `Arguments<${schemaType(schema)}>`;
}

/** Emit TypeScript from describe()'s permission-filtered published definition. */
export function generateOntologyTypes(document: OntologyDocument): string {
  const { id, version, objectTypes, actionTypes, functionTypes } = document;
  const objects = objectTypes.map(type => {
    const members = Object.fromEntries(Object.entries(type.properties).map(([key, value]) =>
      [key, { type: schemaType(value.schema), required: value.required }]));
    return `${JSON.stringify(type.apiName)}: { ${fields(members)} };`;
  });
  const actions = actionTypes.map(action =>
    `${JSON.stringify(action.apiName)}: ${inputType(action.parameters)};`);
  const functions = functionTypes.filter(fn => !fn.edits).map(fn =>
    `${JSON.stringify(fn.apiName)}: { input: ${inputType(fn.parameters)}; result: ${schemaType(fn.returns)} };`);
  const group = (name: string, entries: string[]) =>
    [`  ${name}: {`, ...entries.sort().map(entry => `    ${entry}`), '  };'];
  return [
    '// Generated from a published Ontology definition.',
    `export const publication = ${JSON.stringify({ id, version })} as const;`,
    'type Arguments<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;',
    'export type Bindings = {',
    ...group('objects', objects),
    ...group('actions', actions),
    ...group('functions', functions),
    '};',
    '',
  ].join('\n');
}
