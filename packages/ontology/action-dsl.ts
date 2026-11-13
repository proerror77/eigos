import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import type { ActionDefinition, OntologyModel } from './model.js';
import { amountRoles, quantityRoles } from './execution.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ActionValue = { literal: JsonValue } | { parameter: string; path?: string[] } | { property: string; object: ActionObjectRef };
export type ActionObjectRef = { parameter: string } | { type: string; id: ActionValue };
export interface ActionCondition { op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'exists'; left: ActionValue; right?: ActionValue }
export type ActionMutation =
  | { op: 'create'; type: string; id: ActionValue; properties: Record<string, ActionValue> }
  | { op: 'update'; object: ActionObjectRef; expectedRevision: ActionValue; properties: Record<string, ActionValue> }
  | { op: 'tombstone'; object: ActionObjectRef; expectedRevision: ActionValue }
  | { op: 'add_link' | 'remove_link'; type: string; from: ActionObjectRef; to: ActionObjectRef };
export type ManagedResultFact =
  | { kind: 'budget'; amountProperty: string; currencyProperty: string; role?: typeof amountRoles[number] }
  | { kind: 'quantity'; amountProperty: string; unit: string; role?: typeof quantityRoles[number] };
export interface DeclarativeActionImplementation { kind: 'declarative'; version: '1'; conditions: ActionCondition[]; mutations: ActionMutation[]; result?: ActionObjectRef; resultFacts?: ManagedResultFact[] }
export interface TrustedActionImplementation { kind: 'trusted'; handlerRef: { id: string; version: string; digest: string } }
export type ActionImplementation = DeclarativeActionImplementation | TrustedActionImplementation;

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/).refine(value => !['constructor', 'prototype', '__proto__'].includes(value));
const segment = z.string().min(1).max(80).refine(value => !['constructor', 'prototype', '__proto__'].includes(value));
const json: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string().max(16000), z.number().finite(), z.boolean(), z.null(), z.array(json).max(200), z.record(segment, json)]));
export const actionValueSchema: z.ZodType<ActionValue> = z.lazy(() => z.union([
  z.strictObject({ literal: json }),
  z.strictObject({ parameter: name, path: z.array(segment).max(8).optional() }),
  z.strictObject({ property: name, object: actionObjectRefSchema }),
]));
export const actionObjectRefSchema: z.ZodType<ActionObjectRef> = z.lazy(() => z.union([
  z.strictObject({ parameter: name }), z.strictObject({ type: name, id: actionValueSchema }),
]));
export const actionConditionSchema: z.ZodType<ActionCondition> = z.strictObject({
  op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'exists']), left: actionValueSchema, right: actionValueSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.op === 'exists' ? value.right !== undefined : value.right === undefined) ctx.addIssue({ code: 'custom', message: 'Comparison requires two operands; exists requires only one' });
});
export const actionMutationSchema: z.ZodType<ActionMutation> = z.union([
  z.strictObject({ op: z.literal('create'), type: name, id: actionValueSchema, properties: z.record(name, actionValueSchema) }),
  z.strictObject({ op: z.literal('update'), object: actionObjectRefSchema, expectedRevision: actionValueSchema, properties: z.record(name, actionValueSchema) }),
  z.strictObject({ op: z.literal('tombstone'), object: actionObjectRefSchema, expectedRevision: actionValueSchema }),
  z.strictObject({ op: z.enum(['add_link', 'remove_link']), type: name, from: actionObjectRefSchema, to: actionObjectRefSchema }),
]);
export const declarativeActionImplementationSchema: z.ZodType<DeclarativeActionImplementation> = z.strictObject({
  kind: z.literal('declarative'), version: z.literal('1'), conditions: z.array(actionConditionSchema).max(32),
  mutations: z.array(actionMutationSchema).min(1).max(64), result: actionObjectRefSchema.optional(),
  resultFacts: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('budget'), amountProperty: name, currencyProperty: name, role: z.enum(amountRoles).optional() }),
    z.strictObject({ kind: z.literal('quantity'), amountProperty: name, unit: z.string().min(1).max(80), role: z.enum(quantityRoles).optional() }),
  ])).min(1).max(16).optional(),
});
export const actionImplementationSchema: z.ZodType<ActionImplementation> = z.union([
  declarativeActionImplementationSchema,
  z.strictObject({ kind: z.literal('trusted'), handlerRef: z.strictObject({ id: z.string().min(1).max(200), version: z.string().min(1).max(80), digest: z.string().regex(/^[a-f0-9]{64}$/) }) }),
]);

function fail(message: string): never { throw new DomainError('INVALID_INPUT', message); }

/** Bound the data tree before recursively parsing it. Definitions never contain executable source. */
export function assertActionDataBounds(value: unknown): void {
  const seen = new Set<object>(); let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 6000 || depth > 24) fail('Action definition exceeds the bounded expression complexity');
    if (!item || typeof item !== 'object') return;
    if (seen.has(item)) fail('Action definition must be an acyclic JSON document');
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (['constructor', 'prototype', '__proto__'].includes(key)) fail('Unsafe action data key');
      visit(child, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 128000) fail('Action definition byte limit exceeded');
}

/** Publication-time validation complements runtime checks on the actual target objects. */
export function validateActionImplementation(implementation: ActionImplementation, model: OntologyModel, action: Pick<ActionDefinition, 'inputs' | 'inputSchema' | 'effects' | 'changes' | 'resultTypes'>): void {
  assertActionDataBounds(implementation); actionImplementationSchema.parse(implementation);
  if (implementation.kind === 'trusted') return;
  if (action.effects?.length !== 1 || action.effects[0] !== 'object_write') fail('Declarative actions require exactly the object_write effect');
  const input = action.inputSchema as { type?: string; properties?: Record<string, unknown> } | undefined;
  if (input?.type !== 'object' || !input.properties) fail('Declarative actions require an object input schema');
  const parameter = (id: string) => { if (!Object.hasOwn(input.properties!, id)) fail(`Unknown action parameter: ${id}`); };
  const schemaKinds = (schema: Record<string, unknown>): string[] => {
    if (Array.isArray(schema.anyOf)) return [...new Set(schema.anyOf.flatMap(item => schemaKinds(item as Record<string, unknown>)))];
    if (typeof schema.type === 'string') return [schema.type === 'integer' ? 'number' : schema.type];
    const literals = Array.isArray(schema.enum) ? schema.enum : Object.hasOwn(schema, 'const') ? [schema.const] : [];
    return [...new Set(literals.map(item => item === null ? 'null' : typeof item))];
  };
  const parameterSchema = (id: string, path: string[] = []): Record<string, unknown> => {
    parameter(id); let schema = input.properties![id] as Record<string, unknown>;
    for (const segment of path) {
      if (schema.type === 'object' && schema.properties && Object.hasOwn(schema.properties as object, segment)) schema = (schema.properties as Record<string, Record<string, unknown>>)[segment]!;
      else if (schema.type === 'array' && /^(0|[1-9][0-9]*)$/.test(segment) && schema.items) schema = schema.items as Record<string, unknown>;
      else fail('Action parameter path is not declared by its input schema');
    }
    return schema;
  };
  const types = (ref: ActionObjectRef): string[] => {
    if ('parameter' in ref) {
      const schema = parameterSchema(ref.parameter), properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      if (schema.type !== 'object' || !properties || !['id', 'type'].every(field => properties[field] && schemaKinds(properties[field]!).every(kind => kind === 'string') && (schema.required as string[] | undefined)?.includes(field))) fail('Object reference parameter schema requires type and id strings');
      const target = action.inputs[ref.parameter]; if (!target) fail('Object reference parameters require a declared input type'); return model.concreteTypes(target);
    }
    model.object(ref.type); if (value(ref.id).some(kind => kind !== 'string')) fail('Action object identities must be strings'); return [ref.type];
  };
  const value = (expression: ActionValue): string[] => {
    if ('parameter' in expression) return schemaKinds(parameterSchema(expression.parameter, expression.path));
    if ('literal' in expression) return [expression.literal === null ? 'null' : Array.isArray(expression.literal) ? 'array' : typeof expression.literal];
    return [...new Set(types(expression.object).flatMap(type => {
      const property = model.properties(type)[expression.property];
      if (!property || property.restricted || property.derived) fail('Action expressions require a visible stored property');
      return schemaKinds(property.schemaMetadata ?? z.toJSONSchema(property.schema) as Record<string, unknown>);
    }))];
  };
  const managed = (target: string[]) => { if (!target.length || target.some(type => model.objectWritePolicy(type) !== 'managed')) fail('Generic actions can only mutate managed object types'); };
  const declares = (type: string, field?: string) => action.changes.includes(type) || !!field && action.changes.includes(`${type}.${field}`);
  const fields = (target: string[], properties: Record<string, ActionValue>) => {
    if (!Object.keys(properties).length || Object.keys(properties).length > 80) fail('A mutation requires bounded explicit fields');
    for (const type of target) for (const [field, expression] of Object.entries(properties)) {
      const property = model.properties(type)[field];
      if (!property || property.derived || property.restricted || model.propertyAuthority(type, field) === 'source') fail('Generic actions cannot write a protected, derived or unknown field');
      if (!declares(type, field)) fail('Action implementation writes outside its declared changes');
      const accepted = schemaKinds(property.schemaMetadata ?? z.toJSONSchema(property.schema) as Record<string, unknown>);
      if (value(expression).some(kind => !accepted.includes(kind))) fail('Action value type is incompatible with its target field');
    }
  };
  for (const condition of implementation.conditions) {
    const left = value(condition.left), right = condition.right ? value(condition.right) : [];
    if (['lt', 'lte', 'gt', 'gte'].includes(condition.op) && [...left, ...right].some(kind => kind !== 'number')) fail('Ordered action comparisons require numeric schema types');
    if (['eq', 'ne'].includes(condition.op) && !left.some(kind => right.includes(kind))) fail('Action comparison has incompatible operand types');
  }
  for (const mutation of implementation.mutations) {
    if (mutation.op === 'create') { model.object(mutation.type); managed([mutation.type]); if (!declares(mutation.type)) fail('Object creation must be declared as a whole-object change'); if (value(mutation.id).some(kind => kind !== 'string')) fail('Created object identity must be a string'); fields([mutation.type], mutation.properties); }
    else if (mutation.op === 'update') { const target = types(mutation.object); managed(target); if (value(mutation.expectedRevision).some(kind => kind !== 'number')) fail('Expected revision must have a numeric schema'); fields(target, mutation.properties); }
    else if (mutation.op === 'tombstone') { const target = types(mutation.object); managed(target); if (target.some(type => !declares(type))) fail('Object tombstone must be declared as a whole-object change'); if (value(mutation.expectedRevision).some(kind => kind !== 'number')) fail('Expected revision must have a numeric schema'); }
    else {
      const link = model.link(mutation.type), from = types(mutation.from), to = types(mutation.to);
      managed(from); managed(to);
      if (model.linkWritePolicy(mutation.type) !== 'managed' || from.some(type => !model.implements(type, link.from.type)) || to.some(type => !model.implements(type, link.to.type))) fail('Unmanaged or incompatible action link');
      if (!from.every(type => declares(type, link.from.name)) && !to.every(type => declares(type, link.to.name))) fail('Action implementation changes an undeclared relationship');
    }
  }
  const firstObject = implementation.mutations.find(mutation => mutation.op === 'create' || mutation.op === 'update');
  const result = implementation.result ? types(implementation.result) : firstObject?.op === 'create' ? [firstObject.type] : firstObject?.op === 'update' ? types(firstObject.object) : [];
  if (result.some(type => !(action.resultTypes ?? []).some(target => model.implements(type, target)))) fail('Action result must match its declared result types');
  if (implementation.resultFacts) {
    if (!result.length) fail('Result facts require a managed result object');
    const slots = implementation.resultFacts.map(fact => `${fact.kind}:${fact.role ?? ''}`);
    if (new Set(slots).size !== slots.length) fail('Result facts must have unique kind and role bindings');
    for (const type of result) for (const fact of implementation.resultFacts) {
      managed([type]);
      for (const [field, kind] of [[fact.amountProperty, 'integer'], ...(fact.kind === 'budget' ? [[fact.currencyProperty, 'string']] : [])]) {
        const property = model.properties(type)[field!];
        if (!property || property.kind !== kind || property.restricted || property.derived || model.propertyAuthority(type, field!) !== 'managed') fail('Result facts require visible stored managed amount and currency properties');
      }
    }
  }
}
