import { digest } from '../core/identity.js';

type Schema = Record<string, unknown>;
const types = (schema: Schema): string[] => typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type as string[] : [];
const object = (value: unknown): Schema => value && typeof value === 'object' && !Array.isArray(value) ? value as Schema : {};

/** Conservative JSON Schema inclusion. Unproved constraints fail publication rather than narrowing an Interface silently. */
export function schemaSubset(supplied: Schema, accepted: Schema): boolean {
  if (digest(supplied) === digest(accepted) || Object.keys(accepted).length === 0) return true;
  const suppliedChoices = supplied.anyOf ?? supplied.oneOf;
  if (Array.isArray(suppliedChoices)) return suppliedChoices.every(choice => schemaSubset(object(choice), accepted));
  const acceptedChoices = accepted.anyOf ?? accepted.oneOf;
  if (Array.isArray(acceptedChoices)) return acceptedChoices.some(choice => schemaSubset(supplied, object(choice)));
  const actualTypes = types(supplied), allowedTypes = types(accepted);
  if (allowedTypes.length && (!actualTypes.length || actualTypes.some(type => !allowedTypes.includes(type) && !(type === 'integer' && allowedTypes.includes('number'))))) return false;
  const values = Object.hasOwn(supplied, 'const') ? [supplied.const] : supplied.enum;
  const permitted = Object.hasOwn(accepted, 'const') ? [accepted.const] : accepted.enum;
  if (Array.isArray(permitted) && (!Array.isArray(values) || values.some(value => !permitted.some(option => digest(option) === digest(value))))) return false;
  for (const keyword of ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']) {
    if (typeof accepted[keyword] === 'number' && (typeof supplied[keyword] !== 'number' || supplied[keyword] < accepted[keyword])) return false;
  }
  for (const keyword of ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']) {
    if (typeof accepted[keyword] === 'number' && (typeof supplied[keyword] !== 'number' || supplied[keyword] > accepted[keyword])) return false;
  }
  for (const keyword of ['pattern', 'format', 'multipleOf', 'uniqueItems', 'allOf', 'not', '$ref']) {
    if (accepted[keyword] !== undefined && digest({value:supplied[keyword]}) !== digest({value:accepted[keyword]})) return false;
  }
  if (allowedTypes.includes('object') || accepted.properties) {
    const offered = object(supplied.properties), wanted = object(accepted.properties);
    const required = new Set(Array.isArray(supplied.required) ? supplied.required : []);
    if ((Array.isArray(accepted.required) ? accepted.required : []).some(name => !required.has(name))) return false;
    for (const [name, contract] of Object.entries(wanted)) if (offered[name] && !schemaSubset(object(offered[name]), object(contract))) return false;
    if (accepted.additionalProperties === false && (supplied.additionalProperties !== false || Object.keys(offered).some(name => !Object.hasOwn(wanted, name)))) return false;
    if (accepted.additionalProperties && typeof accepted.additionalProperties === 'object') {
      if (supplied.additionalProperties !== false && !schemaSubset(object(supplied.additionalProperties), object(accepted.additionalProperties))) return false;
      for (const [name, contract] of Object.entries(offered)) if (!Object.hasOwn(wanted, name) && !schemaSubset(object(contract), object(accepted.additionalProperties))) return false;
    }
  }
  if (accepted.items && !schemaSubset(object(supplied.items), object(accepted.items))) return false;
  const known = new Set(['type','properties','required','additionalProperties','items','enum','const','anyOf','oneOf','minimum','exclusiveMinimum','minLength','minItems','minProperties','maximum','exclusiveMaximum','maxLength','maxItems','maxProperties','pattern','format','multipleOf','uniqueItems','allOf','not','$ref','title','description','default','$schema','examples','readOnly','writeOnly']);
  for (const [name,value] of Object.entries(accepted)) if (!known.has(name) && digest({value:supplied[name]}) !== digest({value})) return false;
  return true;
}
