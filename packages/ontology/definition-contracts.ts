import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { nameSchema, type ActionDefinition, type FunctionDefinition, type InterfaceDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import { actionImplementationSchema, type ActionImplementation } from './action-dsl.js';
import { compositionContractSchema, compositionPortSchema } from './composition-contract.js';
import { mcpReadBindingSchema } from './mcp-read.js';

/** Definition JSON is data. It cannot contain executable code or remote schema references. */
export type JsonSchema = Record<string, unknown>;
export type DefinitionKind = 'object' | 'interface' | 'link' | 'action';
export interface HandlerRef { id: string; version: string; digest: string }
export interface OntologyReleaseRef { ontologyId: string; releaseId: string; digest: string }
export interface DefinitionIdentity { resourceId: string; id: string }
export interface SerializableProperty extends Omit<PropertyDefinition, 'schema' | 'schemaMetadata' | 'sourceBinding'> { schema: JsonSchema; validatorRef?: HandlerRef }
export interface SerializableObjectType extends Omit<ObjectTypeDefinition, 'properties'>, DefinitionIdentity { properties: Record<string, SerializableProperty>; writePolicy: 'managed' | 'source' }
export interface SerializableInterface extends Omit<InterfaceDefinition, 'properties'>, DefinitionIdentity { properties: Record<string, SerializableProperty> }
export interface SerializableLink extends LinkDefinition, DefinitionIdentity { writePolicy: 'managed' | 'source' }
export interface SerializableAction extends ActionDefinition, DefinitionIdentity { implementation?: ActionImplementation }
export interface SerializableFunction extends FunctionDefinition { handlerRef?: HandlerRef }
export interface OntologyDocument {
  formatVersion: 1; id: string; version: string;
  objects: SerializableObjectType[]; interfaces: SerializableInterface[];
  links: SerializableLink[]; actions: SerializableAction[]; functions: SerializableFunction[];
}

export const ontologyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);
export const resourceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/);
export const versionSchema = z.string().min(1).max(100).refine(value => value.trim() === value);
export const handlerRefSchema = z.strictObject({ id: resourceIdSchema, version: versionSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) });
export const ontologyReleaseRefSchema = z.strictObject({ ontologyId: ontologyIdSchema, releaseId: resourceIdSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) });
export const definitionKindSchema = z.enum(['object', 'interface', 'link', 'action']);
const text = z.string().min(1).max(5000);
const schema = z.record(z.string(), z.unknown());
const names = z.array(nameSchema).max(500);
const effects = z.array(z.enum(['local', 'read', 'object_write', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund', 'external_draft'])).min(1).max(10);
const propertySchema = z.strictObject({
  description: text, kind: z.enum(['string', 'integer', 'boolean', 'timestamp', 'decimal', 'struct', 'array']), schema,
  source: text, required: z.boolean().optional(), restricted: z.boolean().optional(), derived: nameSchema.optional(),
  authority: z.enum(['managed', 'source']).optional(), validatorRef: handlerRefSchema.optional(),
});
const properties = z.record(nameSchema, propertySchema).refine(value => Object.keys(value).length <= 300, 'Too many properties');
const inputTypes = z.record(nameSchema, nameSchema).refine(value => Object.keys(value).length <= 100, 'Too many inputs');
const actionMap = z.record(nameSchema, z.strictObject({ actionId: nameSchema, inputMap: z.record(nameSchema, nameSchema), outputMap: z.record(nameSchema, nameSchema).optional() }));
const interfaceImplementation = z.strictObject({ id: nameSchema, propertyMap: z.record(nameSchema, nameSchema).optional(), actionMap: actionMap.optional() });
export const serializableObjectTypeSchema = z.strictObject({
  resourceId: resourceIdSchema, id: nameSchema, version: versionSchema, name: text, aliases: z.array(z.string().min(1).max(500)).max(100), description: text,
  primaryKey: nameSchema, titleKey: nameSchema, properties, interfaces: z.array(interfaceImplementation).max(100).optional(),
  visibility: z.enum(['business', 'technical']).optional(), writePolicy: z.enum(['managed', 'source']),
});
export const serializableInterfaceSchema = z.strictObject({
  resourceId: resourceIdSchema, id: nameSchema, description: text, parents: names.optional(), properties,
  optionalProperties: names.optional(),
  links: z.array(z.strictObject({ name: nameSchema, target: nameSchema, many: z.boolean(), optional: z.boolean().optional() })).max(200).optional(),
  actions: z.array(z.strictObject({ id: nameSchema, inputs: inputTypes, effects, resultTypes: names.optional(), optional: z.boolean().optional(), ports: z.strictObject({ inputs: z.record(nameSchema, compositionPortSchema), outputs: z.record(nameSchema, compositionPortSchema) }).optional() })).max(100).optional(),
});
const endpoint = z.strictObject({ type: nameSchema, name: nameSchema, many: z.boolean(), required: z.boolean().optional() });
export const serializableLinkSchema = z.strictObject({ resourceId: resourceIdSchema, id: nameSchema, description: text, from: endpoint, to: endpoint, writePolicy: z.enum(['managed', 'source']) });
export const serializableActionSchema = z.strictObject({
  resourceId: resourceIdSchema, id: nameSchema, version: versionSchema.optional(), kind: z.enum(['decision', 'source_read', 'business']).optional(),
  effects: effects.optional(), resultTypes: names.optional(), description: text, inputs: inputTypes,
  changes: z.array(z.string().min(1).max(200)).min(1).max(200), submissionCriteria: z.array(z.string().min(1).max(200)).min(1).max(100),
  providerOperation: z.string().min(1).max(200).optional(),
  read: z.strictObject({ version: versionSchema, effect: z.literal('read'), inputSchema: schema, resultType: nameSchema,
    mcp: mcpReadBindingSchema.optional(), module: z.strictObject({ id: ontologyIdSchema, version: versionSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), completion: z.strictObject({ evaluate: nameSchema }) }).optional() }).optional(),
  operation: z.strictObject({ version: versionSchema, effect: z.enum(['local', 'object_write', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund', 'external_draft']), additionalEffects: effects.optional(), environment: z.enum(['sandbox', 'local', 'live']), inputSchema: schema, resultType: nameSchema }).optional(),
  inputSchema: schema.optional(), implementation: actionImplementationSchema.optional(), composition: compositionContractSchema.optional(),
});
export const serializableFunctionSchema = z.strictObject({ id: nameSchema, version: versionSchema, inputTypes: names.min(1), description: text, handlerRef: handlerRefSchema.optional() });
export const ontologyDocumentSchema = z.strictObject({
  formatVersion: z.literal(1), id: ontologyIdSchema, version: versionSchema,
  objects: z.array(serializableObjectTypeSchema).max(2000), interfaces: z.array(serializableInterfaceSchema).max(500),
  links: z.array(serializableLinkSchema).max(10000), actions: z.array(serializableActionSchema).max(2000), functions: z.array(serializableFunctionSchema).max(1000),
});

/** Reject non-JSON/prototype-bearing values before any recursive schema compiler runs. */
export function assertDefinitionJson(input: unknown): void {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 300_000 || depth > 64) throw new DomainError('INVALID_INPUT', 'Ontology definition exceeds its structural bound');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new DomainError('INVALID_INPUT', 'Ontology definitions must contain finite acyclic JSON values');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new DomainError('INVALID_INPUT', 'Ontology definitions must contain plain JSON objects');
    ancestors.add(value);
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new DomainError('INVALID_INPUT', 'Unsafe definition property name');
      visit(item, depth + 1);
    }
    ancestors.delete(value);
  };
  visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(input)) > 8_000_000) throw new DomainError('INVALID_INPUT', 'Ontology definition is too large');
}

export function parseOntologyDocument(input: unknown): OntologyDocument {
  assertDefinitionJson(input);
  const parsed = ontologyDocumentSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('INVALID_INPUT', `Invalid ontology definition: ${parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return parsed.data as OntologyDocument;
}
