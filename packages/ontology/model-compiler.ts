import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { validateActionImplementation, type ActionImplementation } from './action-dsl.js';
import { parseOntologyDocument, type DefinitionKind, type HandlerRef, type JsonSchema, type OntologyDocument, type SerializableObjectType, type SerializableProperty } from './definition-contracts.js';
import { OntologyModel, type ActionDefinition, type FunctionDefinition, type ModelDefinition, type PropertyDefinition } from './model.js';
import { executionReferenceLinks } from './execution-model.js';
import { isVirtualRef } from './network-model.js';
import { bindCompositionCompiler, validateCompositionContract } from './composition-contract.js';
import { managedComposition } from './managed-composition.js';

function fail(message: string): never { throw new DomainError('INVALID_INPUT', message); }
const refKey = (ref: HandlerRef) => JSON.stringify([ref.id, ref.version, ref.digest]);
const resources = (document: OntologyDocument) => [
  ...document.objects.map(value => ({ kind: 'object' as const, value })),
  ...document.interfaces.map(value => ({ kind: 'interface' as const, value })),
  ...document.links.map(value => ({ kind: 'link' as const, value })),
  ...document.actions.map(value => ({ kind: 'action' as const, value })),
];
const coreType = (id: string) => /^(?:Execution|Registered|Network)/.test(id) || ['Authorization', 'SourceReceipt', 'ServiceRequest', 'RequestInstruction', 'RequestConstraint', 'OutcomeAssessment', 'EntityIdentityAssertion', 'TransactionPartyRole'].includes(id);
function compatibleBusinessObject(original: SerializableObjectType, candidate: SerializableObjectType, document: OntologyDocument): boolean {
  if (coreType(original.id)) return false;
  const { name: _name, description: _description, aliases: _aliases, properties, interfaces: previousViews = [], ...identity } = original;
  const { name: _newName, description: _newDescription, aliases: _newAliases, properties: next, interfaces: nextViews = [], ...nextIdentity } = candidate;
  if (digest(identity) !== digest(nextIdentity)) return false;
  if (previousViews.some(view => !nextViews.some(next => digest(view) === digest(next)))) return false;
  if (nextViews.filter(view => !previousViews.some(old => old.id === view.id)).some(view => !document.interfaces.find(iface => iface.id === view.id)?.projectionOnly)) return false;
  if (Object.entries(properties).some(([name, value]) => !next[name] || digest(value) !== digest(next[name]))) return false;
  return Object.entries(next).filter(([name]) => !Object.hasOwn(properties, name)).every(([, property]) => !property.required && !property.derived && !property.validatorRef && property.authority !== 'managed');
}

/** Compatible business additions have no data-source binding until a trusted adapter supplies one. */
export function validateBusinessDefinitionExtensions(original: OntologyDocument, candidate: OntologyDocument): { unboundSourceFields: { type: string; property: string }[] } {
  const unboundSourceFields: { type: string; property: string }[] = [];
  for (const type of original.objects.filter(type => type.writePolicy === 'source')) {
    const next = candidate.objects.find(value => value.resourceId === type.resourceId);
    // The store decides whether an ordinary source type has remaining facts,
    // dependencies or in-flight users. Kernel identities remain protected here
    // and independently by the trusted registry's complete-kernel check.
    if (!next && !type.resourceId.startsWith('builtin:')) continue;
    if (!next || digest(type) !== digest(next) && !compatibleBusinessObject(type, next, candidate)) fail(`Incompatible source definition extension: ${type.id}`);
    for (const [name, property] of Object.entries(next.properties)) if (!Object.hasOwn(type.properties, name)) { compileJsonSchema(property.schema); unboundSourceFields.push({ type: type.id, property: name }); }
  }
  return { unboundSourceFields };
}

/** Explicit software contracts, supplied by trusted application code, never by definition JSON. */
export class TrustedDefinitionRegistry {
  private validators = new Map<string, { ref: HandlerRef; schema: z.ZodType; schemaDigest: string }>();
  private functions = new Map<string, { ref: HandlerRef; definition: FunctionDefinition }>();
  private actions = new Map<string, { ref: HandlerRef; definition: ActionDefinition }>();
  private protectedResources = new Set<string>();
  private protectedKernels: { resources: Map<string, { kind: DefinitionKind; id: string; digest: string; value: unknown }>; functions: Map<string, string> }[] = [];
  private protectedKernelDigests = new Set<string>();

  registerValidator(id: string, version: string, schema: z.ZodType, metadata: JsonSchema = z.toJSONSchema(schema)): HandlerRef {
    const schemaDigest = digest(metadata);
    const ref = { id, version, digest: digest({ id, version, schemaDigest }) };
    const key = refKey(ref), previous = this.validators.get(key);
    if (previous) return { ...previous.ref };
    this.validators.set(key, { ref, schema, schemaDigest });
    return { ...ref };
  }
  resolveValidator(ref: HandlerRef, schema: JsonSchema): z.ZodType {
    const available = this.validators.get(refKey(ref));
    if (!available) fail('The exact trusted validator version is unavailable');
    if (digest(schema) !== available.schemaDigest) fail('A trusted validator does not match the declared schema');
    return available.schema;
  }
  registerFunction(definition: FunctionDefinition): HandlerRef {
    const ref = { id: definition.id, version: definition.version, digest: digest(definition) };
    this.functions.set(refKey(ref), { ref, definition: structuredClone(definition) });
    return { ...ref };
  }
  resolveFunction(ref: HandlerRef, definition: FunctionDefinition): void {
    const available = this.functions.get(refKey(ref));
    if (!available || digest(available.definition) !== digest(definition)) fail('The exact trusted function contract is unavailable');
  }
  registerAction(definition: ActionDefinition): HandlerRef {
    const version = definition.operation?.version ?? definition.read?.version ?? definition.version;
    if (!version) fail('An executable trusted action requires an explicit version');
    const ref = { id: definition.id, version, digest: digest(definition) };
    this.actions.set(refKey(ref), { ref, definition: structuredClone(definition) });
    return { ...ref };
  }
  resolveAction(ref: HandlerRef, definition: ActionDefinition): void {
    const available = this.actions.get(refKey(ref));
    if (!available || digest(available.definition) !== digest(definition)) fail('The exact trusted action contract is unavailable');
  }
  actionBindingStatus(ref: HandlerRef): { state: 'available' | 'unavailable'; handlerRef: HandlerRef } { return { state: this.actions.has(refKey(ref)) ? 'available' : 'unavailable', handlerRef: { ...ref } }; }
  /** The trusted kernel is present in every namespace and cannot be replaced by a same-name resource. */
  protect(document: OntologyDocument): void {
    const kernelDigest = digest({ objects: document.objects, interfaces: document.interfaces, links: document.links, actions: document.actions, functions: document.functions });
    if (this.protectedKernelDigests.has(kernelDigest)) return;
    const kernel = { resources: new Map<string, { kind: DefinitionKind; id: string; digest: string; value: unknown }>(), functions: new Map<string, string>() };
    for (const { kind, value } of resources(document)) { this.protectedResources.add(value.resourceId); kernel.resources.set(value.resourceId, { kind, id: value.id, digest: digest(value), value: structuredClone(value) }); }
    for (const fn of document.functions) kernel.functions.set(fn.id, digest(fn));
    this.protectedKernels.push(kernel);
    this.protectedKernelDigests.add(kernelDigest);
  }
  isProtected(resourceId: string): boolean { return this.protectedResources.has(resourceId); }
  assertProtected(document: OntologyDocument): void {
    const actual = resources(document);
    if (actual.some(resource => resource.value.resourceId.startsWith('builtin:') && !this.protectedResources.has(resource.value.resourceId))) fail('Reserved trusted resource identity');
    if (!this.protectedKernels.length) return;
    const byResource = new Map(actual.map(resource => [resource.value.resourceId, resource]));
    const byFunction = new Map(document.functions.map(fn => [fn.id, fn]));
    const match = this.protectedKernels.some(kernel => [...kernel.resources].every(([resourceId, expected]) => {
      const value = byResource.get(resourceId);
      return value && value.kind === expected.kind && value.value.id === expected.id && (digest(value.value) === expected.digest || value.kind === 'object' && compatibleBusinessObject(expected.value as SerializableObjectType, value.value as SerializableObjectType, document));
    }) && [...kernel.functions].every(([id, expected]) => { const fn = byFunction.get(id); return !!fn && digest(fn) === expected; }));
    if (!match) fail('Trusted ontology kernel resources cannot be changed, mixed or removed');
  }
}

const schemaKeys = new Set(['$schema', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'format', 'pattern', 'anyOf', 'description', 'title']);
const jsonTypes = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']);
export const MANAGED_DECIMAL_PATTERN = '^(0|[1-9]\\d{0,14})(?:\\.\\d{1,6})?$';

/** Supported JSON Schema subset is deliberately closed: unknown assertions never silently disappear. */
export function validateJsonSchema(schema: JsonSchema): void {
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 2000 || depth > 20 || !value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid or excessive JSON Schema');
    const s = value as Record<string, unknown>;
    for (const key of Object.keys(s)) if (!schemaKeys.has(key)) fail(`Unsupported JSON Schema keyword: ${key}`);
    if (s.$schema !== undefined && s.$schema !== 'https://json-schema.org/draft/2020-12/schema') fail('Only the local 2020-12 JSON Schema dialect is supported');
    if (s.type !== undefined && (typeof s.type !== 'string' || !jsonTypes.has(s.type))) fail('Unsupported JSON Schema type');
    if (s.description !== undefined && typeof s.description !== 'string' || s.title !== undefined && typeof s.title !== 'string') fail('Invalid schema annotation');
    if (s.anyOf !== undefined) {
      if (!Array.isArray(s.anyOf) || !s.anyOf.length || s.anyOf.length > 16 || s.type !== undefined) fail('Invalid schema union');
      for (const item of s.anyOf) visit(item, depth + 1);
    }
    if (s.type === undefined && s.anyOf === undefined && s.enum === undefined && s.const === undefined) fail('Schema needs an explicit supported type, enum or union');
    const scalar = (item: unknown) => item === null || ['string', 'boolean'].includes(typeof item) || typeof item === 'number' && Number.isFinite(item);
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length || s.enum.length > 200 || s.enum.some(item => !scalar(item)) || new Set(s.enum.map(item => JSON.stringify(item))).size !== s.enum.length)) fail('Enums require unique bounded scalar values');
    if (s.const !== undefined && !scalar(s.const)) fail('Const requires a scalar value');
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (s[key] !== undefined && (!Number.isSafeInteger(s[key]) || Number(s[key]) < 0 || Number(s[key]) > (key.endsWith('Length') ? 16000 : 1000))) fail('Invalid schema size bound');
    for (const [min, max] of [['minLength', 'maxLength'], ['minItems', 'maxItems']]) if (s[min!] !== undefined && s[max!] !== undefined && Number(s[min!]) > Number(s[max!])) fail('Schema size bounds are reversed');
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isFinite(s[key]))) fail('Invalid numeric schema bound');
    if (s.minimum !== undefined && s.maximum !== undefined && Number(s.minimum) > Number(s.maximum)) fail('Numeric schema bounds are reversed');
    if (s.format !== undefined && (s.type !== 'string' || !['date-time', 'date', 'email', 'uuid'].includes(String(s.format)))) fail('Unsupported string format');
    if (s.pattern !== undefined) {
      // Bounded strings and patterns without groups/backreferences avoid introducing an expression engine.
      if (s.type !== 'string' || typeof s.pattern !== 'string' || s.pattern.length > 200 || s.maxLength === undefined || Number(s.maxLength) > 500 || s.pattern !== MANAGED_DECIMAL_PATTERN && (/[()|]|\\[1-9]/.test(s.pattern) || (s.pattern.match(/[+*?{]/g)?.length ?? 0) > 1)) fail('Patterns require a bounded string and a simple expression with at most one quantifier');
      try { new RegExp(s.pattern); } catch { fail('Invalid schema pattern'); }
    }
    if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined) {
      if (s.type !== 'object' || !s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) fail('Object schema fields require explicit object properties');
      const properties = s.properties as Record<string, unknown>;
      if (Object.keys(properties).length > 100) fail('Too many nested object properties');
      for (const [key, property] of Object.entries(properties)) { if (!/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) fail('Invalid nested schema property'); visit(property, depth + 1); }
      if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key)) || new Set(s.required).size !== s.required.length)) fail('Invalid required property list');
      if (s.additionalProperties !== false) fail('Managed object schemas must reject undeclared fields');
    } else if (s.type === 'object') fail('Managed object schemas require explicit properties and additionalProperties:false');
    if (s.type === 'array') { if (!s.items || s.maxItems === undefined) fail('Array schemas require items and maxItems'); visit(s.items, depth + 1); }
    else if (s.items !== undefined || s.minItems !== undefined || s.maxItems !== undefined) fail('Array constraints require an array type');
    if ((s.minLength !== undefined || s.maxLength !== undefined || s.pattern !== undefined) && s.type !== 'string') fail('String constraints require a string type');
    if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].some(key => s[key] !== undefined) && s.type !== 'number' && s.type !== 'integer') fail('Numeric constraints require a numeric type');
  };
  visit(schema, 0);
}

export function compileJsonSchema(schema: JsonSchema): z.ZodType {
  validateJsonSchema(schema);
  const compile = (s: JsonSchema): z.ZodType => {
    let result: z.ZodType;
    if (s.anyOf) result = z.union((s.anyOf as JsonSchema[]).map(compile));
    else if (s.type === 'string') {
      let string = z.string();
      if (s.minLength !== undefined) string = string.min(Number(s.minLength));
      if (s.maxLength !== undefined) string = string.max(Number(s.maxLength));
      if (s.pattern !== undefined) string = string.regex(new RegExp(String(s.pattern)));
      result = string;
      if (s.format !== undefined) {
        const formatted = { 'date-time': z.iso.datetime({ offset: true }), date: z.iso.date(), email: z.email(), uuid: z.uuid() }[String(s.format)];
        result = string.pipe(formatted!);
      }
    } else if (s.type === 'number' || s.type === 'integer') {
      let number = s.type === 'integer' ? z.number().int() : z.number().finite();
      if (s.minimum !== undefined) number = number.min(Number(s.minimum));
      if (s.maximum !== undefined) number = number.max(Number(s.maximum));
      if (s.exclusiveMinimum !== undefined) number = number.gt(Number(s.exclusiveMinimum));
      if (s.exclusiveMaximum !== undefined) number = number.lt(Number(s.exclusiveMaximum));
      result = number;
    } else if (s.type === 'boolean') result = z.boolean();
    else if (s.type === 'null') result = z.null();
    else if (s.type === 'array') {
      let array = z.array(compile(s.items as JsonSchema)).max(Number(s.maxItems));
      if (s.minItems !== undefined) array = array.min(Number(s.minItems));
      result = array;
    } else if (s.type === 'object') {
      const required = new Set(s.required as string[] | undefined);
      result = z.strictObject(Object.fromEntries(Object.entries(s.properties as Record<string, JsonSchema>).map(([name, property]) => { const compiled = compile(property); return [name, required.has(name) ? compiled : compiled.optional()]; })));
    } else result = z.unknown();
    // Enum/const are conjunctive assertions. Zod's generic JSON importer prioritizes
    // them and drops sibling type/length/format assertions, so compile all explicitly.
    if (s.enum) { const values = s.enum as unknown[]; result = result.refine(value => values.some(item => Object.is(item, value)), 'Value is outside the declared enum'); }
    if (Object.hasOwn(s, 'const')) result = result.refine(value => Object.is(value, s.const), 'Value differs from the declared constant');
    return result;
  };
  return compile(schema);
}

function property(input: SerializableProperty, registry: TrustedDefinitionRegistry, policy?: 'managed' | 'source'): PropertyDefinition {
  const { schema, validatorRef, authority, ...metadata } = input;
  const compiled = validatorRef ? registry.resolveValidator(validatorRef, schema) : compileJsonSchema(schema);
  if (!validatorRef) {
    const kinds = (value: JsonSchema): string[] => typeof value.type === 'string' ? [value.type] : Array.isArray(value.anyOf) ? (value.anyOf as JsonSchema[]).flatMap(kinds) : (Object.hasOwn(value, 'const') ? [value.const] : value.enum as unknown[]).map(item => item === null ? 'null' : typeof item === 'number' && Number.isInteger(item) ? 'integer' : typeof item);
    const expected = { string: 'string', integer: 'integer', boolean: 'boolean', timestamp: 'string', decimal: 'string', struct: 'object', array: 'array' }[metadata.kind];
    if (kinds(schema).some(kind => kind !== expected && !(kind === 'null' && ['struct', 'array'].includes(metadata.kind)))) fail('Declared property kind conflicts with its schema');
    if (metadata.kind === 'timestamp' && schema.format !== 'date-time') fail('Timestamp properties require an explicit date-time schema');
    if (metadata.kind === 'decimal' && schema.pattern !== MANAGED_DECIMAL_PATTERN) fail('Decimal properties require the supported canonical decimal pattern');
  }
  if (policy === 'managed' && metadata.derived) fail('Managed objects need an explicitly approved function mapping for source-derived properties');
  return { ...metadata, schema: compiled, schemaMetadata: structuredClone(schema), ...(authority ? { authority } : {}), ...(!validatorRef && (authority === 'source' || policy === 'source') ? { sourceBinding: 'unbound' as const } : {}) };
}

export const GENERATED_EXECUTION_RESOURCE_PREFIX = 'generated:execution-link:';
/** Materialized system relationships are reviewable release data, never hidden runtime mutations. */
export function normalizeOntologyDocument(input: OntologyDocument | unknown): OntologyDocument {
  const document = parseOntologyDocument(input);
  // Only namespaces that carry the new protected kernel opt into these derived
  // contracts. Historical v15/v16 releases compile to their original digests.
  if (document.objects.some(type => type.id === 'RegisteredActionType' && type.properties.composition)) document.actions = document.actions.map(managedComposition);
  const completed = new Set<string>();
  const visitInterface = (id: string, active = new Set<string>()): void => {
    if (completed.has(id)) return;
    const value = document.interfaces.find(value => value.id === id);
    if (!value || active.has(id)) fail('Unresolved or cyclic interface');
    for (const parent of value.parents ?? []) visitInterface(parent, new Set(active).add(id));
    completed.add(id);
  };
  for (const iface of document.interfaces) visitInterface(iface.id);
  const kernelTypes = ['ExecutionInput', 'ExecutionResult', 'ExecutionContext'];
  const hasKernel = kernelTypes.every(type => document.objects.some(value => value.id === type));
  const actionContracts: ActionDefinition[] = [...document.actions];
  if (hasKernel && document.actions.some(action => action.implementation?.kind === 'declarative')) actionContracts.push({ id: 'DynamicExecutionContext', description: 'Internal managed-action scope and result receipt relationships', inputs: { scope: 'RequestSpecification' }, resultTypes: ['ServiceRequest'], changes: ['ServiceRequest'], submissionCriteria: ['exact_request_specification'] });
  const generated = hasKernel ? executionReferenceLinks(document.objects.filter(type => type.visibility !== 'technical' && !isVirtualRef({ type: type.id })), actionContracts, document.interfaces) : [];
  const expected = new Map(generated.map(link => [link.id, link]));
  const staleGenerated = new Set<string>();
  for (const resource of resources(document)) if (resource.value.resourceId.startsWith('generated:') && (resource.kind !== 'link' || !resource.value.resourceId.startsWith(GENERATED_EXECUTION_RESOURCE_PREFIX))) fail('Reserved generated resource identity');
  for (const link of document.links) {
    const generatedIdentity = `${GENERATED_EXECUTION_RESOURCE_PREFIX}${link.id}`;
    const target = expected.get(link.id);
    if (link.resourceId.startsWith(GENERATED_EXECUTION_RESOURCE_PREFIX)) {
      if (link.resourceId !== generatedIdentity) fail('Unknown generated execution relationship');
      if (!target) {
        const canonical = executionReferenceLinks([{ id: link.to.type }], [{ id: 'ReferenceShape', description: 'Canonical generated relationship', inputs: { scope: link.to.type }, resultTypes: [link.to.type], changes: [link.to.type], submissionCriteria: ['canonical_shape'] }]).find(value => value.id === link.id);
        const { resourceId: _resourceId, writePolicy, ...definition } = link;
        if (!canonical || writePolicy !== 'source' || digest(definition) !== digest(canonical)) fail('Unknown or modified generated execution relationship');
        staleGenerated.add(link.resourceId);
      }
    }
    if (target) {
      const { resourceId: _resourceId, writePolicy, ...definition } = link;
      if (writePolicy !== 'source' || digest(definition) !== digest(target)) fail('Generated execution relationships cannot be altered');
    }
  }
  document.links = document.links.filter(link => !staleGenerated.has(link.resourceId));
  const knownLinks = new Set(document.links.map(link => link.id));
  for (const link of generated) if (!knownLinks.has(link.id)) document.links.push({ ...link, resourceId: `${GENERATED_EXECUTION_RESOURCE_PREFIX}${link.id}`, writePolicy: 'source' });
  return document;
}

export function compileOntologyDocument(input: OntologyDocument | unknown, registry: TrustedDefinitionRegistry): OntologyModel {
  const document = normalizeOntologyDocument(input);
  const resourceIds = new Set<string>(), apiNames = new Set<string>();
  for (const { kind, value } of resources(document)) {
    if (resourceIds.has(value.resourceId)) fail('Duplicate stable definition resource ID');
    resourceIds.add(value.resourceId);
    const key = `${kind === 'object' || kind === 'interface' ? 'type' : kind}:${value.id}`;
    if (apiNames.has(key)) fail('Duplicate definition API name');
    apiNames.add(key);
  }
  registry.assertProtected(document);
  const mapProperties = (properties: Record<string, SerializableProperty>, policy?: 'managed' | 'source') => Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, property(value, registry, policy)]));
  const trustedActionImplementations: Record<string, ActionImplementation> = {};
  const definition: ModelDefinition = {
    id: document.id, version: document.version,
    objects: document.objects.map(({ resourceId: _resourceId, writePolicy, properties, ...rest }) => ({ ...rest, properties: mapProperties(properties, writePolicy), ...(writePolicy === 'managed' ? { writePolicy } : {}) })),
    interfaces: document.interfaces.map(({ resourceId: _resourceId, properties, ...rest }) => ({ ...rest, properties: mapProperties(properties) })),
    links: document.links.map(({ resourceId: _resourceId, writePolicy, ...rest }) => ({ ...rest, ...(writePolicy === 'managed' ? { writePolicy } : {}) })),
    actions: document.actions.map(({ resourceId, implementation, ...rest }) => {
      if (implementation?.kind === 'declarative' && !rest.version) fail('A declarative action requires an explicit version');
      if (implementation?.kind === 'trusted') {
        registry.resolveAction(implementation.handlerRef, rest);
        if (registry.isProtected(resourceId)) { trustedActionImplementations[rest.id] = implementation; return rest; }
      }
      if (rest.inputSchema) compileJsonSchema(rest.inputSchema);
      if (!registry.isProtected(resourceId) && (rest.read || rest.operation || rest.providerOperation) && implementation?.kind !== 'trusted') fail('External action contracts require an exact trusted implementation');
      return { ...rest, ...(implementation ? { implementation } : {}) };
    }),
    functions: document.functions.map(({ handlerRef, ...rest }) => { if (!handlerRef) fail('Functions require an exact trusted handler reference'); registry.resolveFunction(handlerRef, rest); return rest; }),
  };
  const model = new OntologyModel(definition, { trustedActionImplementations });
  bindCompositionCompiler(model, { schema: compileJsonSchema, validator: (ref, schema) => registry.resolveValidator(ref, schema) });
  for (const action of model.actionDefinitions()) {
    const implementation = model.actionImplementation(action.id);
    if (implementation) validateActionImplementation(implementation, model, action);
    validateCompositionContract(model, action, { schema: compileJsonSchema, validator: (ref, schema) => registry.resolveValidator(ref, schema) });
  }
  for (const link of document.links.filter(link => link.writePolicy === 'managed')) {
    const endpoints = [...model.concreteTypes(link.from.type), ...model.concreteTypes(link.to.type)];
    const personalAddress = link.resourceId === 'builtin:eigos.business:link:PreferenceAddress' && link.id === 'PreferenceAddress' && link.from.type === 'PersonalPreference' && link.to.type === 'SavedAddress' && model.hasType('Person');
    if (!endpoints.length || !personalAddress && endpoints.some(type => model.objectWritePolicy(type) !== 'managed')) fail('Managed links require managed concrete endpoints');
  }
  return model;
}
