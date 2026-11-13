import { schemaSubset } from './schema-compatibility.js';

type Schema = Record<string, unknown>;
const simpleObjectKeys = new Set([
  '$schema', 'type', 'title', 'description', 'examples', 'default', 'properties', 'required', 'additionalProperties',
]);
const compositions = new Set(['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else']);

/** Compare the full parameter object after projecting it through the Interface mapping. */
export function actionParametersCompatible(supplied: Schema, accepted: Schema, mapping: Record<string, string>) {
  const fields = supplied.properties as Record<string, Schema> ?? {};
  const actionFields = accepted.properties as Record<string, Schema> ?? {};
  const complete = Object.keys(fields).every(name => Object.hasOwn(mapping, name));
  const renamed = Object.entries(mapping).some(([name, target]) => name !== target);
  const defaults = Object.entries(mapping).filter(([name]) => Object.hasOwn(fields[name] ?? {}, 'default'));
  const actionDefaults = Object.values(actionFields).some(field => Object.hasOwn(field, 'default'));
  const projectedShape = !complete || supplied.additionalProperties !== false || defaults.length > 0;

  // When projection can change the set of keys, a complex object-level condition
  // cannot safely be proven by comparing only the declared fields.
  if (projectedShape && Object.keys(supplied).some(key => !simpleObjectKeys.has(key))) return false;
  if ((!complete || actionDefaults || defaults.length > 0) &&
      Object.keys(accepted).some(key => !simpleObjectKeys.has(key))) return false;

  function project(schema: Schema): Schema | undefined {
    const result = { ...schema };
    for (const [key, value] of Object.entries(schema)) {
      if (compositions.has(key)) {
        const transform = (branch: unknown) => typeof branch === 'boolean' ? branch : project(branch as Schema);
        const changed = Array.isArray(value) ? value.map(transform) : transform(value);
        if (changed === undefined || Array.isArray(changed) && changed.includes(undefined)) return undefined;
        result[key] = changed;
      } else if (renamed && !simpleObjectKeys.has(key) && key !== 'minProperties' && key !== 'maxProperties') {
        // Rewriting an arbitrary name-sensitive assertion would need a stronger proof.
        return undefined;
      }
    }
    if (schema.properties) {
      result.properties = Object.fromEntries(Object.entries(schema.properties as Record<string, Schema>)
        .filter(([name]) => Object.hasOwn(mapping, name))
        .map(([name, property]) => [mapping[name]!, property]));
    }
    if (Array.isArray(schema.required)) {
      if (schema.required.some(name => !Object.hasOwn(mapping, name))) return undefined;
      result.required = schema.required.map(name => mapping[name]!);
    }
    return result;
  }

  const mapped = project(supplied);
  if (!mapped) return false;
  const guaranteed = new Set([...(mapped.required as string[] ?? []), ...defaults.map(([, target]) => target)]);
  const required = (accepted.required as string[] ?? []).filter(name => !Object.hasOwn(actionFields[name] ?? {}, 'default'));
  const input = { ...mapped, additionalProperties: false,
    ...(mapped.required !== undefined || guaranteed.size ? { required: [...guaranteed] } : {}) };
  const output = { ...accepted, ...(accepted.required !== undefined ? { required } : {}) };
  return schemaSubset(input, output);
}
