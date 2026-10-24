import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { BUSINESS_MODEL_DEFINITION } from './business-model.js';
import frozen from './history/business-v15.json' with { type: 'json' };
import frozenV16 from './history/business-v16.json' with { type: 'json' };
import { extendCompositionKernel } from './composition-kernel.js';
import { extendDidiKernel } from './didi-kernel.js';
import { extendConsolidatedKernel } from './consolidated-kernel.js';
import { predecessorImplementation } from './history/consolidation-compatibility.js';
import { extendCheckoutKernel } from './checkout-kernel.js';
import { extendPAPaymentKernel } from './pa-payment-kernel.js';
import { compileOntologyDocument, TrustedDefinitionRegistry } from './model-compiler.js';
import { parseOntologyDocument, type DefinitionKind, type JsonSchema, type OntologyDocument, type SerializableProperty } from './definition-contracts.js';
import type { ActionDefinition, InterfaceDefinition, ModelDefinition, ObjectTypeDefinition, PropertyDefinition } from './model.js';

export const LEGACY_SEED_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '15', digest: 'efd2ef430b621b1c4f83b8d4e79a794126d24257bfa5022a5c1de8bdd6e48776' });
export const CURRENT_KERNEL_VERSION = '20';
export const CHECKOUT_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '18', digest: 'da1bfa28f9c3a2635913e93a3c3889702c82c2a82ed3d9c9d9dbf9dc38817ee6' });
export const COMPOSITION_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '17', digest: '67436b02a6f26e5e9d494c14bfdf4953eaaaa5ada723e7369920341f12e8c835' });
const SEMANTICS_VERSION = 'eigos-v15.1';
type FrozenProperty = Omit<PropertyDefinition, 'schema'> & { schema: JsonSchema };
type FrozenDefinition = Omit<ModelDefinition, 'objects' | 'interfaces'> & {
  objects: (Omit<ObjectTypeDefinition, 'properties'> & { properties: Record<string, FrozenProperty> })[];
  interfaces: (Omit<InterfaceDefinition, 'properties'> & { properties: Record<string, FrozenProperty> })[];
};
const frozenDefinition = frozen.definition as unknown as FrozenDefinition;
const historicalImplementation = predecessorImplementation(BUSINESS_MODEL_DEFINITION, frozenDefinition);
if (digest(frozen.model) !== digest(LEGACY_SEED_MODEL_REF)) throw new Error('Unexpected original ontology seed snapshot');

export interface SeedDefinitionAudit {
  model: { id: string; version: string; digest: string };
  counts: { objects: number; interfaces: number; links: number; actions: number; functions: number };
  propertyCount: number; trustedValidatorCount: number; legacyMetadataPreserved: boolean;
}
export interface SeedDefinition { document: OntologyDocument; registry: TrustedDefinitionRegistry; audit: SeedDefinitionAudit }
const resourceId = (kind: DefinitionKind, id: string) => `builtin:eigos.business:${kind}:${id}`;
const hasTrustedActionContract = (value: ActionDefinition) => !!(value.read || value.operation || value.providerOperation && value.kind === 'business' && value.version);

/** Only the known additive kernel effect is accepted as current-code drift from v15. */
function isSupportedKernelWidening(old: unknown, current: unknown, key = '', managedEnvironment = false): boolean {
  if (digest(old) === digest(current)) return true;
  if (Array.isArray(old) && Array.isArray(current)) {
    if (key === 'enum' && old.includes('item_quantity') && current.length === old.length + 1 && current.includes('result_count')) return old.every(value => current.includes(value));
    if (key === 'enum' && old.includes('local') && old.includes('read') && current.length === old.length + 1 && current.includes('object_write')) return old.every(value => current.includes(value));
    if (key === 'enum' && managedEnvironment && old.includes('sandbox') && current.length === old.length + 1 && current.includes('managed')) return old.every(value => current.includes(value));
    return old.length === current.length && old.every((value, index) => isSupportedKernelWidening(value, current[index], key, managedEnvironment));
  }
  if (old && current && typeof old === 'object' && typeof current === 'object') {
    const a = old as Record<string, unknown>, b = current as Record<string, unknown>;
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(name => Object.hasOwn(b, name) && isSupportedKernelWidening(a[name], b[name], name, managedEnvironment));
  }
  return key === 'maxItems' && old === 8 && current === 9;
}

function frozenValidator(type: string, name: string, schema: JsonSchema, current: PropertyDefinition): z.ZodType {
  const currentMetadata = current.schemaMetadata ?? z.toJSONSchema(current.schema);
  if (digest(schema) === digest(currentMetadata)) return current.schema;
  if (!isSupportedKernelWidening(schema, currentMetadata, '', type === 'Authorization' && name === 'environment')) throw new DomainError('CONFLICT', `Current validator no longer provides the pinned v15 contract: ${type}.${name}`);
  const old = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  // Run the original trusted parse first to preserve refinements and normalization.
  // The frozen guard only narrows newly supported effects and never rewrites its result.
  return current.schema.superRefine((value, context) => {
    if (!old.safeParse(value).success) context.addIssue({ code: 'custom', message: 'Value is outside the pinned v15 schema' });
  });
}

function documentFromDefinition(definition: FrozenDefinition | ModelDefinition, registry: TrustedDefinitionRegistry, frozenMode: boolean): OntologyDocument {
  const serializeProperties = (kind: 'object' | 'interface', id: string, properties: Record<string, FrozenProperty | PropertyDefinition>) => {
    const current = (kind === 'object' ? historicalImplementation.objects : historicalImplementation.interfaces).find(value => value.id === id);
    if (frozenMode && !current) throw new DomainError('CONFLICT', `Pinned seed type implementation is unavailable: ${id}`);
    return Object.fromEntries(Object.entries(properties).map(([name, value]) => {
      const { schema: raw, schemaMetadata: _metadata, ...metadata } = value;
      const schema = frozenMode ? raw as JsonSchema : z.toJSONSchema(raw as z.ZodType);
      const live = frozenMode ? current!.properties[name] : value as PropertyDefinition;
      if (!live) throw new DomainError('CONFLICT', `Pinned seed property implementation is unavailable: ${id}.${name}`);
      const validator = frozenMode ? frozenValidator(id, name, schema, live) : live.schema;
      const validatorRef = registry.registerValidator(`eigos.business:${kind}:${id}:${name}`, frozenMode ? SEMANTICS_VERSION : `${SEMANTICS_VERSION}:kernel-${definition.version}`, validator, schema);
      return [name, { ...metadata, schema: structuredClone(schema), validatorRef } satisfies SerializableProperty];
    }));
  };
  const document = {
    formatVersion: 1 as const, id: definition.id, version: definition.version,
    objects: definition.objects.map(value => ({ ...value, resourceId: resourceId('object', value.id), writePolicy: 'source' as const, properties: serializeProperties('object', value.id, value.properties) })),
    interfaces: definition.interfaces.map(value => ({ ...value, resourceId: resourceId('interface', value.id), properties: serializeProperties('interface', value.id, value.properties) })),
    links: definition.links.map(value => ({ ...value, resourceId: resourceId('link', value.id), writePolicy: 'source' as const })),
    actions: definition.actions.map(value => {
      if (frozenMode && hasTrustedActionContract(value) && digest(historicalImplementation.actions.find(action => action.id === value.id) ?? null) !== digest(value)) throw new DomainError('CONFLICT', `Pinned seed action implementation is unavailable: ${value.id}`);
      return { ...value, resourceId: resourceId('action', value.id), ...(hasTrustedActionContract(value) ? { implementation: { kind: 'trusted' as const, handlerRef: registry.registerAction(value) } } : {}) };
    }),
    functions: definition.functions.map(value => {
      if (frozenMode && digest(historicalImplementation.functions.find(fn => fn.id === value.id) ?? null) !== digest(value)) throw new DomainError('CONFLICT', `Pinned seed function implementation is unavailable: ${value.id}`);
      return { ...value, handlerRef: registry.registerFunction(value) };
    }),
  };
  // TypeScript optional fields may contain undefined; only the exact JSON document is persisted.
  return parseOntologyDocument(JSON.parse(JSON.stringify(document)));
}

function complete(document: OntologyDocument, registry: TrustedDefinitionRegistry, original: boolean): SeedDefinition {
  registry.protect(document);
  const model = compileOntologyDocument(document, registry);
  if (original && digest(model.ref) !== digest(LEGACY_SEED_MODEL_REF)) throw new DomainError('CONFLICT', 'Original v15 seed changed its model digest');
  const propertyCount = [...document.objects, ...document.interfaces].reduce((sum, type) => sum + Object.keys(type.properties).length, 0);
  return { document, registry, audit: { model: { ...model.ref }, counts: { objects: document.objects.length, interfaces: document.interfaces.length, links: document.links.length, actions: document.actions.length, functions: document.functions.length }, propertyCount, trustedValidatorCount: propertyCount, legacyMetadataPreserved: original } };
}

/** Always reconstruct the exact original release; it never follows the evolving active model. */
export function createSeedDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  return complete(documentFromDefinition(frozenDefinition, registry, true), registry, true);
}

/** A separate immutable kernel release can add supported engine contracts without relabelling old facts. */
export function createCurrentKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const composition = createCompositionKernelDefinition(registry);
  const didi = complete(extendDidiKernel(composition.document, registry), registry, false);
  const checkout = checkoutKernelFromComposition(composition.document, registry);
  complete(extendPAPaymentKernel(checkout.document, registry), registry, false);
  const combined = extendPAPaymentKernel(extendCheckoutKernel(didi.document, registry), registry);
  return complete(extendConsolidatedKernel(combined, registry, BUSINESS_MODEL_DEFINITION), registry, false);
}
export function createCheckoutKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  return checkoutKernelFromComposition(createCompositionKernelDefinition(registry).document, registry);
}
function checkoutKernelFromComposition(document: OntologyDocument, registry: TrustedDefinitionRegistry): SeedDefinition {
  const checkout = complete(extendCheckoutKernel(document, registry), registry, false);
  if (digest(checkout.audit.model) !== digest(CHECKOUT_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT', 'The original v18 model fingerprint changed');
  return checkout;
}
export function createCompositionKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const historical = createHistoricalKernelDefinition(registry);
  const composition = complete(extendCompositionKernel(historical.document, registry, historicalImplementation), registry, false);
  if (digest(composition.audit.model) !== digest(COMPOSITION_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT', 'The original v17 model fingerprint changed');
  return composition;
}
export function createHistoricalKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const document = parseOntologyDocument(structuredClone(frozenV16.document));
  for (const [kind, types] of [['object', document.objects], ['interface', document.interfaces]] as const) for (const type of types) {
    const current = (kind === 'object' ? historicalImplementation.objects : historicalImplementation.interfaces).find(value => value.id === type.id);
    if (!current) throw new DomainError('CONFLICT', 'Historical v16 type implementation is unavailable');
    for (const [name, property] of Object.entries(type.properties)) {
      if (!property.validatorRef || !current.properties[name]) throw new DomainError('CONFLICT', 'Historical v16 validator is unavailable');
      const schema = property.schema, live = current.properties[name]!, metadata = live.schemaMetadata ?? z.toJSONSchema(live.schema);
      if (!isSupportedKernelWidening(schema, metadata)) throw new DomainError('CONFLICT', `Current validator cannot preserve v16: ${type.id}.${name}`);
      const guard = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
      const validator = digest(schema) === digest(metadata) ? live.schema : live.schema.superRefine((value, context) => { if (!guard.safeParse(value).success) context.addIssue({ code: 'custom', message: 'Value is outside the pinned v16 schema' }); });
      const registered = registry.registerValidator(property.validatorRef.id, property.validatorRef.version, validator, schema);
      if (digest(registered) !== digest(property.validatorRef)) throw new DomainError('CONFLICT', 'Historical v16 validator identity changed');
    }
  }
  for (const { resourceId: _resource, implementation, ...action } of document.actions) {
    if (digest(historicalImplementation.actions.find(value => value.id === action.id)) !== digest(action)) throw new DomainError('CONFLICT', 'Historical v16 action implementation changed');
    if (implementation?.kind === 'trusted' && digest(registry.registerAction(action)) !== digest(implementation.handlerRef)) throw new DomainError('CONFLICT', 'Historical v16 action identity changed');
  }
  for (const { handlerRef, ...fn } of document.functions) if (!handlerRef || digest(registry.registerFunction(fn)) !== digest(handlerRef)) throw new DomainError('CONFLICT', 'Historical v16 function identity changed');
  const historical = complete(document, registry, false);
  if (digest(historical.audit.model) !== digest(frozenV16.model)) throw new DomainError('CONFLICT', 'The original v16 model fingerprint changed');
  return historical;
}
