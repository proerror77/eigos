import { extendPaymentCommerceKernel } from './payment-commerce-kernel.js';
import {extendSemanticRetrievalKernel} from './semantic-retrieval-kernel.js';
import { extendBusinessDescriptions } from './business-descriptions.js';
import { extendPaClassificationKernel } from './pa-classification-kernel.js';
import { extendDomainVocabularyKernel } from './domain-vocabulary-kernel.js';
import { extendContractClosureKernel } from './contract-closure-kernel.js';
import { extendEffectCoverageKernel } from './effect-coverage-kernel.js';
import { extendExecutableContractKernel } from './executable-contract-kernel.js';
import { extendFunctionContractCloseoutKernel } from './function-contract-closeout-kernel.js';
import { extendInterfaceContractsKernel } from './interface-contract-kernel.js';
import { extendPalantirModelKernel } from './palantir-model-kernel.js';
import { EXECUTABLE_CONTRACT_KERNEL_MODEL_REF } from './executable-contract-compatibility.js';
export { EXECUTABLE_CONTRACT_KERNEL_MODEL_REF } from './executable-contract-compatibility.js';
import { FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF } from './function-contract-closeout-compatibility.js';
import { INTERFACE_CONTRACT_MODEL_REF } from './interface-contract-compatibility.js';
export { FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF } from './function-contract-closeout-compatibility.js';
export { INTERFACE_CONTRACT_MODEL_REF } from './interface-contract-compatibility.js';
import { extendRollingGoKernel } from './rollinggo-kernel.js';
import { extendBusinessFactsKernel } from './business-facts-kernel.js';
import { extendPersonalContextKernel } from './personal-context-kernel.js';
import { extendSingleReadKernel } from './single-read-kernel.js';
import { extendTaskClosureKernel } from './task-closure-kernel.js';
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
import { extendProviderReadKernel } from './provider-read-kernel.js';
import { compileOntologyDocument, TrustedDefinitionRegistry } from './model-compiler.js';
import { parseOntologyDocument, type DefinitionKind, type JsonSchema, type OntologyDocument, type SerializableProperty } from './definition-contracts.js';
import type { ActionDefinition, InterfaceDefinition, ModelDefinition, ObjectTypeDefinition, OntologyModel, PropertyDefinition } from './model.js';

export const LEGACY_SEED_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '15', digest: 'efd2ef430b621b1c4f83b8d4e79a794126d24257bfa5022a5c1de8bdd6e48776' });
export const CURRENT_KERNEL_VERSION = '28';
export type ReviewedKernelVersion = '27' | '28' | '29' | '30' | '31' | '32' | '33' | '34' | '35' | '36' | '37';
export const PALANTIR_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '37', digest: '5092c835e2be07542280d1a8d2f845be7a9c46b1176d82adf46dbc84b3d6fd16' });
export const DOMAIN_VOCABULARY_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '31', digest: '2eb7c0911c04c38bb0cc0f8316c12d86318f8612f675506436b41d871ce66f51' });
export const EFFECT_COVERAGE_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '33', digest: '5a721eaa695d262725ad3d515c3ff8e098d0858011e55ca4e3a31e84bc6b08a0' });
export const CONTRACT_CLOSURE_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '32', digest: '53bdaa43dd60980322180e1a9aafa52a8669056aeef245fd9fc983a7a5322e04' });
export const PA_CLASSIFICATION_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '30', digest: '1ef0be3f87514a7916635b3e26eec05a552fccb1df17ab1d09700baf3fe26aaf' });
export const SEMANTIC_RETRIEVAL_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '29', digest: '3061fa84b2606d1726b9673053e5940daa141bfd84a7ba7b877a8b17ca81a8b6' });
export const BUSINESS_DESCRIPTIONS_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '28', digest: '04606f93dc6cfd9045ac6b9a0c3dcfa4c8f330689ecbdd3cdfa7556df15202c5' });
export const PAYMENT_COMMERCE_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '27', digest: '8e5b11eb6b25d873b12f05d67232899f97af6af929b143397aa19e75379fc5e6' });
export const SINGLE_READ_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '26', digest: '78e73e56caaed8c894b716a0ed486dd98442beed1234a7c29e557821ba2f4020' });
export const PA_PAYMENT_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '19', digest: '60287d4b34e950c24e6479812e3a8fd0be6ba19402917a2f3ff9db63798065df' });
export const PROVIDER_READ_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '20', digest: 'ef3a604ace56a5617bfe67b93686ec5a19ac94ba2c06ebc37676e4b1c3efa5a4' });
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
const compiledSeeds = new WeakMap<SeedDefinition, { registry: TrustedDefinitionRegistry; documentDigest: string; model: OntologyModel }>();

/** Reuse only a genuine completion for this exact registry and unchanged document.
 * This is immutable definition metadata, never a database or permission snapshot. */
export function compiledSeedModel(seed: SeedDefinition, registry: TrustedDefinitionRegistry): OntologyModel {
  const compiled = compiledSeeds.get(seed);
  if (!compiled || compiled.registry !== registry || seed.registry !== registry || digest(seed.document) !== compiled.documentDigest
    || digest(seed.audit.model) !== digest(compiled.model.ref)) throw new DomainError('CONFLICT', 'The compiled seed identity or document changed');
  return compiled.model;
}
const resourceId = (kind: DefinitionKind, id: string) => `builtin:eigos.business:${kind}:${id}`;
const hasTrustedActionContract = (value: ActionDefinition) => !!(value.read || value.operation || value.providerOperation && value.kind === 'business' && value.version);

/** Only the known additive kernel effect is accepted as current-code drift from v15. */
function isSupportedKernelWidening(old: unknown, current: unknown, key = '', managedEnvironment = false): boolean {
  if (digest(old) === digest(current)) return true;
  return isSupportedKernelDifference(old, current, key, managedEnvironment);
}

function isSupportedKernelDifference(old: unknown, current: unknown, key = '', managedEnvironment = false): boolean {
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
  if (!isSupportedKernelDifference(schema, currentMetadata, '', type === 'Authorization' && name === 'environment')) throw new DomainError('CONFLICT', `Current validator no longer provides the pinned v15 contract: ${type}.${name}`);
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

/** A published release is immutable by contract: freeze it so an accidental
 * in-place edit fails loudly instead of silently rewriting history, and so its
 * digest can be memoised by identity. */
function freezeRelease<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRelease(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Compare a stage against its reviewed fingerprint. The published model ref is a
 * digest of the compiled projection, so verifying it costs one compilation. That
 * price is paid for the current release on every build, and for every historical
 * stage only when EIGOS_KERNEL_PINS=full (scripts/ontology-integrity.mjs), which
 * is what CI runs: intermediate releases are reviewed there, not on every boot.
 */
const FULL_PINS = process.env.EIGOS_KERNEL_PINS === 'full';
export function assertRelease(seed: SeedDefinition, expected: { id: string; version: string; digest: string }, label: string): void {
  if (!FULL_PINS && expected.version !== CURRENT_KERNEL_VERSION) return;
  if (digest(seed.audit.model) !== digest(expected)) throw new DomainError('CONFLICT', `${label} changed`);
}

function complete(document: OntologyDocument, registry: TrustedDefinitionRegistry, original: boolean, onCompiled?: (model: OntologyModel) => void): SeedDefinition {
  freezeRelease(document);
  registry.protect(document);
  const documentDigest = digest(document);
  // Compiling is only needed when someone asks for the model. The chain publishes
  // sixteen intermediate releases that nobody reads a model from, so compiling
  // them eagerly cost ~85% of the build for fingerprints alone.
  let compiled: OntologyModel | undefined;
  const model = (): OntologyModel => (compiled ??= compileOntologyDocument(document, registry));
  const needsModel = FULL_PINS || original || onCompiled !== undefined;
  if (needsModel) onCompiled?.(model());
  if (original && digest(model().ref) !== digest(LEGACY_SEED_MODEL_REF)) throw new DomainError('CONFLICT', 'Original v15 seed changed its model digest');
  const propertyCount = [...document.objects, ...document.interfaces].reduce((sum, type) => sum + Object.keys(type.properties).length, 0);
  const audit = { counts: { objects: document.objects.length, interfaces: document.interfaces.length, links: document.links.length, actions: document.actions.length, functions: document.functions.length }, propertyCount, trustedValidatorCount: propertyCount, legacyMetadataPreserved: original, get model() { return { ...model().ref }; } };
  const seed: SeedDefinition = { document, registry, audit: audit as SeedDefinition['audit'] };
  compiledSeeds.set(seed, { registry, documentDigest, get model() { return model(); } } as { registry: TrustedDefinitionRegistry; documentDigest: string; model: OntologyModel });
  return seed;
}

/** Always reconstruct the exact original release; it never follows the evolving active model. */
export function createSeedDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  return complete(documentFromDefinition(frozenDefinition, registry, true), registry, true);
}

/** A separate immutable kernel release can add supported engine contracts without relabelling old facts. */
export function createConsolidatedKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  createProviderReadKernelDefinition(registry);
  const composition = createCompositionKernelDefinition(registry);
  const didi = complete(extendDidiKernel(composition.document, registry), registry, false);
  const combined = extendPAPaymentKernel(extendCheckoutKernel(didi.document, registry), registry);
  const predecessor = complete(extendConsolidatedKernel(combined, registry, BUSINESS_MODEL_DEFINITION), registry, false);
  assertRelease(predecessor, { id: 'eigos.business', version: '21', digest: 'fabd8b85eb9e6199140eece8a71bb4b91ef9c0eb0edd2df30df848c035657107' }, 'The original consolidated v21 fingerprint changed');
  return predecessor;
}
export function createCurrentKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  return createBusinessDescriptionsKernelDefinition(registry);
}
export function createSemanticRetrievalKernelDefinition(registry=new TrustedDefinitionRegistry()):SeedDefinition{
  const semantic = complete(extendSemanticRetrievalKernel(createBusinessDescriptionsKernelDefinition(registry).document,registry),registry,false);
  assertRelease(semantic, SEMANTIC_RETRIEVAL_KERNEL_MODEL_REF, 'The reviewed semantic retrieval v29 fingerprint changed');
  return semantic;
}
/** Opt-in PA presentation release. Existing databases keep their active release. */
export function createPaClassificationKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const classified = complete(extendPaClassificationKernel(createBusinessDescriptionsKernelDefinition(registry).document), registry, false);
  assertRelease(classified, PA_CLASSIFICATION_KERNEL_MODEL_REF, 'The reviewed PA classification fingerprint changed');
  return classified;
}
/** Reviewed domain vocabulary release. It republishes the v30 classification
 * with runtime ServiceDomain spellings and keeps v30 byte-identical. */
export function createDomainVocabularyKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const vocabulary = complete(extendDomainVocabularyKernel(createPaClassificationKernelDefinition(registry).document), registry, false);
  assertRelease(vocabulary, DOMAIN_VOCABULARY_KERNEL_MODEL_REF, 'The reviewed domain vocabulary fingerprint changed');
  return vocabulary;
}
/** v32 closes the kinetic contract: approved-write classification, a reviewed
 * submission-criteria vocabulary and a declared result for every function. */
export function createContractClosureKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const closed = complete(extendContractClosureKernel(createDomainVocabularyKernelDefinition(registry).document, registry), registry, false);
  assertRelease(closed, CONTRACT_CLOSURE_KERNEL_MODEL_REF, 'The reviewed contract closure fingerprint changed');
  return closed;
}
/** v33 completes the effect declarations without inventing intent. */
export function createEffectCoverageKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const covered = complete(extendEffectCoverageKernel(createContractClosureKernelDefinition(registry).document, registry), registry, false);
  assertRelease(covered, EFFECT_COVERAGE_KERNEL_MODEL_REF, 'The reviewed effect coverage fingerprint changed');
  return covered;
}
export function createExecutableContractKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const executable = complete(extendExecutableContractKernel(createEffectCoverageKernelDefinition(registry).document, registry), registry, false);
  assertRelease(executable, EXECUTABLE_CONTRACT_KERNEL_MODEL_REF, 'The reviewed executable contract fingerprint changed');
  return executable;
}
export function createFunctionContractCloseoutDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const closed = complete(extendFunctionContractCloseoutKernel(createExecutableContractKernelDefinition(registry).document, registry), registry, false);
  assertRelease(closed, FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF, 'The reviewed complete Function contract fingerprint changed');
  return closed;
}
export function createInterfaceContractDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const contracted = complete(extendInterfaceContractsKernel(createFunctionContractCloseoutDefinition(registry).document).document, registry, false);
  assertRelease(contracted, INTERFACE_CONTRACT_MODEL_REF, 'The reviewed interface contract fingerprint changed');
  return contracted;
}
export function createPalantirModelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const modelled = complete(extendPalantirModelKernel(createInterfaceContractDefinition(registry).document).document, registry, false);
  assertRelease(modelled, PALANTIR_MODEL_REF, 'The reviewed Palantir model metadata fingerprint changed');
  return modelled;
}
export function createBusinessDescriptionsKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const described = complete(extendBusinessDescriptions(createPaymentCommerceKernelDefinition(registry).document), registry, false);
  assertRelease(described, BUSINESS_DESCRIPTIONS_KERNEL_MODEL_REF, 'The original v28 description kernel fingerprint changed');
  return described;
}
export function createPaymentCommerceKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const previous = complete(extendPaymentCommerceKernel(createSingleReadKernelDefinition(registry).document, registry), registry, false);
  assertRelease(previous, PAYMENT_COMMERCE_KERNEL_MODEL_REF, 'The original v27 kernel fingerprint changed');
  return previous;
}
export function createSingleReadKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const previous = complete(extendSingleReadKernel(createPersonalContextKernelDefinition(registry).document, registry), registry, false);
  assertRelease(previous, SINGLE_READ_KERNEL_MODEL_REF, 'The original v26 kernel fingerprint changed');
  return previous;
}

/** Incrementally reconstruct the same trusted registry without persisting a
 * second ontology authority. Each completed stage has performed the same
 * compile/protection and historical fingerprint checks as the normal builder.
 * An interrupted or failed builder must be discarded and restarted. */
export class StagedKernelBuilder {
  #registry = new TrustedDefinitionRegistry();
  #position = 0;
  #failed = false;
  #composition?: SeedDefinition;
  #checkout?: SeedDefinition;
  #payment?: SeedDefinition;
  #didi?: SeedDefinition;
  #combined?: OntologyDocument;
  #current?: SeedDefinition;
  #model?: OntologyModel;
  #documentDigest?: string;
  #base28?: OntologyDocument;
  #forwardInstalled = false;
  static readonly stages = 15;
  readonly #targetVersion: ReviewedKernelVersion;
  readonly #stageCount: number;
  constructor(targetVersion: ReviewedKernelVersion = CURRENT_KERNEL_VERSION) {
    if (!['27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37'].includes(targetVersion)) throw new Error('Unsupported reviewed kernel target');
    this.#targetVersion = targetVersion;
    this.#stageCount = targetVersion === '27' ? 14 : targetVersion === '28' ? 15 : targetVersion === '31' ? 17 : targetVersion === '32' ? 18 : targetVersion === '33' ? 19 : targetVersion === '34' ? 20 : targetVersion === '35' ? 21 : targetVersion === '36' ? 22 : targetVersion === '37' ? 23 : 16;
  }

  step(expected: number): { completed: number; total: number; ready: boolean } {
    if (this.#failed) throw new Error('Failed kernel builder must be discarded');
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > this.#position) throw new Error('Invalid kernel stage');
    if (expected < this.#position || this.#position === this.#stageCount) return this.progress();
    try {
      switch (this.#position) {
        case 0: createSeedDefinition(this.#registry); break;
        case 1: this.#composition = createCompositionKernelDefinition(this.#registry); break;
        case 2: this.#checkout = checkoutKernelFromComposition(this.#composition!.document,this.#registry); break;
        case 3: {
          this.#payment = complete(extendPAPaymentKernel(this.#checkout!.document,this.#registry),this.#registry,false);
          assertRelease(this.#payment, PA_PAYMENT_KERNEL_MODEL_REF, 'The original v19 model fingerprint changed');
          break;
        }
        case 4: {
          const provider = complete(extendProviderReadKernel(this.#payment!.document,this.#registry,historicalImplementation),this.#registry,false);
          assertRelease(provider, PROVIDER_READ_KERNEL_MODEL_REF, 'The original provider-read v20 model fingerprint changed');
          this.#checkout=undefined; this.#payment=undefined;
          break;
        }
        case 5: this.#didi = complete(extendDidiKernel(this.#composition!.document,this.#registry),this.#registry,false); this.#composition=undefined; break;
        case 6: this.#combined = extendPAPaymentKernel(extendCheckoutKernel(this.#didi!.document,this.#registry),this.#registry); this.#didi=undefined; break;
        case 7: {
          this.#current = complete(extendConsolidatedKernel(this.#combined!,this.#registry,BUSINESS_MODEL_DEFINITION),this.#registry,false);
          assertRelease(this.#current, { id: 'eigos.business', version: '21', digest: 'fabd8b85eb9e6199140eece8a71bb4b91ef9c0eb0edd2df30df848c035657107' }, 'The original consolidated v21 fingerprint changed');
          this.#combined=undefined;
          break;
        }
        case 8: {
          this.#current = complete(extendTaskClosureKernel(this.#current!.document,this.#registry,BUSINESS_MODEL_DEFINITION),this.#registry,false);
          assertRelease(this.#current, { id: 'eigos.business', version: '22', digest: 'b800ef526f90c2dfbbb6c82495318bf820145520ce2dd1d63635c8b930c5fca4' }, 'The original v22 kernel fingerprint changed');
          break;
        }
        case 9: this.#current = complete(extendRollingGoKernel(this.#current!.document,this.#registry),this.#registry,false); break;
        case 10: this.#current = complete(extendBusinessFactsKernel(this.#current!.document,this.#registry),this.#registry,false); break;
        case 11: this.#current = complete(extendPersonalContextKernel(this.#current!.document,this.#registry),this.#registry,false); break;
        case 12:
          this.#current = complete(extendSingleReadKernel(this.#current!.document,this.#registry),this.#registry,false);
          assertRelease(this.#current, SINGLE_READ_KERNEL_MODEL_REF, 'The original v26 kernel fingerprint changed');
          break;
        case 13:
          this.#current = complete(extendPaymentCommerceKernel(this.#current!.document,this.#registry),this.#registry,false,model=>{this.#model=model;});
          assertRelease(this.#current, PAYMENT_COMMERCE_KERNEL_MODEL_REF, 'The original v27 kernel fingerprint changed');
          if (this.#targetVersion === '27') { this.#documentDigest=digest(this.#current.document); this.#registry.seal(); }
          break;
        case 14:
          this.#current = complete(extendBusinessDescriptions(this.#current!.document),this.#registry,false,model=>{this.#model=model;});
          this.#base28 = this.#current.document;
          assertRelease(this.#current, BUSINESS_DESCRIPTIONS_KERNEL_MODEL_REF, 'The reviewed v28 description fingerprint changed');
          if(this.#targetVersion==='28'){this.#documentDigest=digest(this.#current.document); this.#registry.seal();}
          break;
        case 15: {
          const classified = Number(this.#targetVersion) >= 30;
          this.#current=complete(classified ? extendPaClassificationKernel(this.#current!.document) : extendSemanticRetrievalKernel(this.#current!.document,this.#registry),this.#registry,false,model=>{this.#model=model;});
          const expected = classified ? PA_CLASSIFICATION_KERNEL_MODEL_REF : SEMANTIC_RETRIEVAL_KERNEL_MODEL_REF;
          assertRelease(this.#current, expected, `The reviewed ${expected.version === '30' ? 'PA classification' : 'semantic retrieval'} fingerprint changed`);
          // The v31 vocabulary stage republishes this release, so sealing waits for stage 16.
          if (Number(this.#targetVersion) < 31) { this.#documentDigest=digest(this.#current.document); this.#registry.seal(); }
          break;
        }
        case 16:
          this.#current=complete(extendDomainVocabularyKernel(this.#current!.document),this.#registry,false,model=>{this.#model=model;});
          assertRelease(this.#current, DOMAIN_VOCABULARY_KERNEL_MODEL_REF, 'The reviewed domain vocabulary fingerprint changed');
          // The v32 contract closure still registers reviewed function contracts,
          // so sealing waits for stage 17 when that release is the target.
          if (Number(this.#targetVersion) < 32) { this.#documentDigest=digest(this.#current.document); this.#registry.seal(); }
          break;
        case 17:
          this.#current=complete(extendContractClosureKernel(this.#current!.document,this.#registry),this.#registry,false,model=>{this.#model=model;});
          assertRelease(this.#current, CONTRACT_CLOSURE_KERNEL_MODEL_REF, 'The reviewed contract closure fingerprint changed');
          if (Number(this.#targetVersion) < 33) { this.#documentDigest=digest(this.#current.document); this.#registry.seal(); }
          break;
        case 18:
          this.#current=complete(extendEffectCoverageKernel(this.#current!.document,this.#registry),this.#registry,false,model=>{this.#model=model;});
          assertRelease(this.#current, EFFECT_COVERAGE_KERNEL_MODEL_REF, 'The reviewed effect coverage fingerprint changed');
          if (this.#targetVersion === '33') { this.#documentDigest=digest(this.#current.document);this.#registry.seal(); }
          break;
        case 19:
          this.#current=complete(extendExecutableContractKernel(this.#current!.document,this.#registry),this.#registry,false,model=>{this.#model=model;});
          assertRelease(this.#current, EXECUTABLE_CONTRACT_KERNEL_MODEL_REF, 'The reviewed executable contract fingerprint changed');
          if (this.#targetVersion === '34') { this.#documentDigest=digest(this.#current.document);this.#registry.seal(); }
          break;
        case 20:
          this.#current=complete(extendFunctionContractCloseoutKernel(this.#current!.document,this.#registry),this.#registry,false,model=>{this.#model=model;});
          assertRelease(this.#current, FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF, 'The reviewed complete Function contract fingerprint changed');
          if (this.#targetVersion === '35') { this.#documentDigest=digest(this.#current.document);this.#registry.seal(); }
          break;
        case 21:
          this.#current=complete(extendInterfaceContractsKernel(this.#current!.document).document,this.#registry,false,model=>{this.#model=model;});
          assertRelease(this.#current, INTERFACE_CONTRACT_MODEL_REF, 'The reviewed interface contract fingerprint changed');
          if (Number(this.#targetVersion) < 37) { this.#documentDigest=digest(this.#current.document);this.#registry.seal(); }
          break;
        case 22:
          this.#current=complete(extendPalantirModelKernel(this.#current!.document,this.#registry as never).document,this.#registry,false,model=>{this.#model=model;});
          assertRelease(this.#current, PALANTIR_MODEL_REF, 'The reviewed Palantir model metadata fingerprint changed');
          this.#documentDigest=digest(this.#current.document);this.#registry.seal();
          break;
        default: throw new Error('Unknown kernel stage');
      }
      this.#position++;
      return this.progress();
    } catch (error) { this.#failed=true; throw error; }
  }

  result(): SeedDefinition {
    if (this.#failed || this.#position !== this.#stageCount || !this.#current) throw new Error('Kernel builder is not ready');
    return {document:structuredClone(this.#current.document),registry:this.#registry,audit:structuredClone(this.#current.audit)};
  }

  /** Install reviewed software contracts separately from the selected field
   * policy model. This performs no publication, activation or permission write.
   * Reuse the prepared v28 node; never rebuild the historical seed chain. */
  installExecutableContracts(): void {
    if (this.#failed || this.#position !== this.#stageCount || !this.#current) throw new Error('Kernel builder is not ready');
    if (this.#forwardInstalled || this.#targetVersion === '35') return;
    const registry = this.#registry.fork();
    const base = this.#base28 ?? complete(extendBusinessDescriptions(this.#current.document), registry, false).document;
    const classified = complete(extendPaClassificationKernel(base), registry, false);
    const vocabulary = complete(extendDomainVocabularyKernel(classified.document), registry, false);
    const closed = complete(extendContractClosureKernel(vocabulary.document, registry), registry, false);
    const covered = complete(extendEffectCoverageKernel(closed.document, registry), registry, false);
    const executable = complete(extendExecutableContractKernel(covered.document, registry), registry, false);
    if (digest(executable.audit.model) !== digest(EXECUTABLE_CONTRACT_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT', 'Installed executable contract fingerprint changed');
    const functionClosed = complete(extendFunctionContractCloseoutKernel(executable.document, registry), registry, false);
    if (digest(functionClosed.audit.model) !== digest(FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF)) throw new DomainError('CONFLICT', 'Installed complete Function contract fingerprint changed');
    registry.seal(); this.#registry = registry; this.#forwardInstalled = true;
  }

  /** Internal immutable model and sealed trusted registry for edge readers. */
  trusted(): {registry:TrustedDefinitionRegistry;model:OntologyModel;documentDigest:string} {
    if (this.#failed || this.#position !== this.#stageCount || !this.#model || !this.#documentDigest) throw new Error('Kernel builder is not ready');
    return {registry:this.#registry,model:this.#model,documentDigest:this.#documentDigest};
  }

  private progress() { return { completed:this.#position,total:this.#stageCount,ready:this.#position===this.#stageCount }; }
}

/** Read only a genuinely completed builder, bypassing overridable methods. */
export function stagedKernelComponents(builder: StagedKernelBuilder) {
  if (!(builder instanceof StagedKernelBuilder)) throw new Error('Invalid staged kernel builder');
  return StagedKernelBuilder.prototype.trusted.call(builder);
}
export function createPersonalContextKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  return complete(extendPersonalContextKernel(createBusinessFactsKernelDefinition(registry).document, registry), registry, false);
}
export function createBusinessFactsKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  return complete(extendBusinessFactsKernel(createRollingGoKernelDefinition(registry).document, registry), registry, false);
}
export function createRollingGoKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  return complete(extendRollingGoKernel(createTaskClosureKernelDefinition(registry).document, registry), registry, false);
}
export function createTaskClosureKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const predecessor = createConsolidatedKernelDefinition(registry);
  const closure = complete(extendTaskClosureKernel(predecessor.document, registry, BUSINESS_MODEL_DEFINITION), registry, false);
  assertRelease(closure, { id: 'eigos.business', version: '22', digest: 'b800ef526f90c2dfbbb6c82495318bf820145520ce2dd1d63635c8b930c5fca4' }, 'The original v22 kernel fingerprint changed');
  return closure;
}
export function createProviderReadKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const payment = createPAPaymentKernelDefinition(registry);
  const provider = complete(extendProviderReadKernel(payment.document, registry, historicalImplementation), registry, false);
  assertRelease(provider, PROVIDER_READ_KERNEL_MODEL_REF, 'The original provider-read v20 model fingerprint changed');
  return provider;
}
export function createPAPaymentKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const payment = complete(extendPAPaymentKernel(createCheckoutKernelDefinition(registry).document, registry), registry, false);
  assertRelease(payment, PA_PAYMENT_KERNEL_MODEL_REF, 'The original v19 model fingerprint changed');
  return payment;
}
export function createCheckoutKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  return checkoutKernelFromComposition(createCompositionKernelDefinition(registry).document, registry);
}
function checkoutKernelFromComposition(document: OntologyDocument, registry: TrustedDefinitionRegistry): SeedDefinition {
  const checkout = complete(extendCheckoutKernel(document, registry), registry, false);
  assertRelease(checkout, CHECKOUT_KERNEL_MODEL_REF, 'The original v18 model fingerprint changed');
  return checkout;
}
export function createCompositionKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const historical = createHistoricalKernelDefinition(registry);
  const composition = complete(extendCompositionKernel(historical.document, registry, historicalImplementation), registry, false);
  assertRelease(composition, COMPOSITION_KERNEL_MODEL_REF, 'The original v17 model fingerprint changed');
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
      const unchanged = digest(schema) === digest(metadata);
      if (!unchanged && !isSupportedKernelDifference(schema, metadata)) throw new DomainError('CONFLICT', `Current validator cannot preserve v16: ${type.id}.${name}`);
      let validator = live.schema;
      if (!unchanged) {
        const guard = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
        validator = live.schema.superRefine((value, context) => { if (!guard.safeParse(value).success) context.addIssue({ code: 'custom', message: 'Value is outside the pinned v16 schema' }); });
      }
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
  assertRelease(historical, frozenV16.model, 'The original v16 model fingerprint changed');
  return historical;
}
