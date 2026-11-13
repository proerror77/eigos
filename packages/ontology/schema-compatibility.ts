import { digest } from '../core/identity.js';

type Schema = Record<string, unknown>;
const types = (schema: Schema): string[] =>
  typeof schema.type === 'string'
    ? [schema.type]
    : Array.isArray(schema.type)
      ? (schema.type as string[])
      : [];
const object = (value: unknown): Schema =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Schema) : {};

function choicesDisjoint(left: Schema, right: Schema): boolean {
  const leftTypes = types(left), rightTypes = types(right);
  const overlap = (a: string, b: string) => a === b || [a, b].every(type => type === 'number' || type === 'integer');
  if (leftTypes.length && rightTypes.length && leftTypes.every(a => rightTypes.every(b => !overlap(a, b)))) return true;
  const leftValues = Object.hasOwn(left, 'const') ? [left.const] : left.enum;
  const rightValues = Object.hasOwn(right, 'const') ? [right.const] : right.enum;
  return Array.isArray(leftValues) && Array.isArray(rightValues)
    && leftValues.every(value => rightValues.every(other => digest(value) !== digest(other)));
}

/** Conservative JSON Schema inclusion. Unproved constraints fail publication rather than narrowing an Interface silently. */
export function schemaSubset(supplied: Schema, accepted: Schema): boolean {
  if (digest(supplied) === digest(accepted) || Object.keys(accepted).length === 0) return true;
  if (Array.isArray(accepted.allOf)) {
    const { allOf, ...siblings } = accepted;
    return schemaSubset(supplied, siblings)
      && allOf.every(constraint => constraint === true || constraint !== false && schemaSubset(supplied, object(constraint)));
  }
  if (Array.isArray(supplied.allOf)) {
    const { allOf, ...siblings } = supplied;
    // Every intersection member contains the complete input set; one stronger member is sufficient proof.
    return schemaSubset(siblings, accepted)
      || allOf.some(constraint => constraint === false || schemaSubset(object(constraint), accepted));
  }
  const suppliedChoices = supplied.anyOf ?? supplied.oneOf;
  if (Array.isArray(suppliedChoices)) {
    // Ignoring supplied siblings over-approximates the inputs and keeps an unproved inclusion closed.
    return suppliedChoices.every(choice => choice === false || schemaSubset(object(choice), accepted));
  }
  if (Array.isArray(accepted.anyOf) || Array.isArray(accepted.oneOf)) {
    const { anyOf, oneOf, ...siblings } = accepted;
    if (!schemaSubset(supplied, siblings)) return false;
    if (Array.isArray(anyOf) && !anyOf.some(choice => choice === true || choice !== false && schemaSubset(supplied, object(choice)))) return false;
    if (Array.isArray(oneOf)) {
      return oneOf.some((choice, index) => choice !== false
        && (choice === true || schemaSubset(supplied, object(choice)))
        && oneOf.every((other, otherIndex) => otherIndex === index || other === false || other !== true && choicesDisjoint(supplied, object(other))));
    }
    return true;
  }
  const actualTypes = types(supplied),
    allowedTypes = types(accepted);
  if (
    allowedTypes.length &&
    (!actualTypes.length ||
      actualTypes.some(
        (type) => !allowedTypes.includes(type) && !(type === 'integer' && allowedTypes.includes('number')),
      ))
  )
    return false;
  const values = Object.hasOwn(supplied, 'const') ? [supplied.const] : supplied.enum;
  const permitted = Object.hasOwn(accepted, 'const') ? [accepted.const] : accepted.enum;
  if (
    Array.isArray(permitted) &&
    (!Array.isArray(values) ||
      values.some((value) => !permitted.some((option) => digest(option) === digest(value))))
  )
    return false;
  for (const keyword of ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']) {
    if (
      typeof accepted[keyword] === 'number' &&
      (typeof supplied[keyword] !== 'number' || supplied[keyword] < accepted[keyword])
    )
      return false;
  }
  for (const keyword of ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']) {
    if (
      typeof accepted[keyword] === 'number' &&
      (typeof supplied[keyword] !== 'number' || supplied[keyword] > accepted[keyword])
    )
      return false;
  }
  for (const keyword of ['pattern', 'format', 'multipleOf', 'uniqueItems', 'allOf', 'not', '$ref']) {
    if (
      accepted[keyword] !== undefined &&
      digest({ value: supplied[keyword] }) !== digest({ value: accepted[keyword] })
    )
      return false;
  }
  if (allowedTypes.includes('object') || accepted.properties) {
    const offered = object(supplied.properties),
      wanted = object(accepted.properties);
    const required = new Set(Array.isArray(supplied.required) ? supplied.required : []);
    if ((Array.isArray(accepted.required) ? accepted.required : []).some((name) => !required.has(name)))
      return false;
    const patterns = object(supplied.patternProperties);
    for (const [name, contract] of Object.entries(wanted)) {
      const offeredSchema = Object.hasOwn(offered, name) ? offered[name] : supplied.additionalProperties;
      if (offeredSchema !== false && (contract === false || !schemaSubset(object(offeredSchema), object(contract)))) return false;
      if (!Object.hasOwn(offered, name) && Object.values(patterns).some(pattern => pattern !== false && (contract === false || !schemaSubset(object(pattern), object(contract))))) return false;
    }
    if (
      accepted.additionalProperties === false &&
      (supplied.additionalProperties !== false ||
        Object.keys(offered).some((name) => !Object.hasOwn(wanted, name)) ||
        digest(patterns) !== digest(object(accepted.patternProperties)))
    )
      return false;
    if (accepted.additionalProperties && typeof accepted.additionalProperties === 'object') {
      if (
        supplied.additionalProperties !== false &&
        !schemaSubset(object(supplied.additionalProperties), object(accepted.additionalProperties))
      )
        return false;
      for (const [name, contract] of Object.entries(offered))
        if (
          !Object.hasOwn(wanted, name) &&
          !schemaSubset(object(contract), object(accepted.additionalProperties))
        )
          return false;
    }
  }
  if (accepted.items && !schemaSubset(object(supplied.items), object(accepted.items))) return false;
  const known = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'anyOf',
    'oneOf',
    'minimum',
    'exclusiveMinimum',
    'minLength',
    'minItems',
    'minProperties',
    'maximum',
    'exclusiveMaximum',
    'maxLength',
    'maxItems',
    'maxProperties',
    'pattern',
    'format',
    'multipleOf',
    'uniqueItems',
    'allOf',
    'not',
    '$ref',
    'title',
    'description',
    'default',
    '$schema',
    'examples',
    'readOnly',
    'writeOnly',
  ]);
  for (const [name, value] of Object.entries(accepted))
    if (!known.has(name) && digest({ value: supplied[name] }) !== digest({ value })) return false;
  return true;
}
