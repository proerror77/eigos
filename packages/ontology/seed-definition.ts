import { extendPaymentCommerceKernel } from './payment-commerce-kernel.js';
import {extendSemanticRetrievalKernel} from './semantic-retrieval-kernel.js';
import { extendBusinessDescriptions } from './business-descriptions.js';
import { extendPaClassificationKernel } from './pa-classification-kernel.js';
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
export const SEMANTIC_RETRIEVAL_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '29', digest: '3061fa84b2606d1726b9673053e5940daa141bfd84a7ba7b877a8b17ca81a8b6' });
export const PA_CLASSIFICATION_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '30', digest: '1ef0be3f87514a7916635b3e26eec05a552fccb1df17ab1d09700baf3fe26aaf' });
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

function complete(document: OntologyDocument, registry: TrustedDefinitionRegistry, original: boolean, onCompiled?: (model: OntologyModel) => void): SeedDefinition {
  registry.protect(document);
  const model = compileOntologyDocument(document, registry);
  onCompiled?.(model);
  if (original && digest(model.ref) !== digest(LEGACY_SEED_MODEL_REF)) throw new DomainError('CONFLICT', 'Original v15 seed changed its model digest');
  const propertyCount = [...document.objects, ...document.interfaces].reduce((sum, type) => sum + Object.keys(type.properties).length, 0);
  const seed: SeedDefinition = { document, registry, audit: { model: { ...model.ref }, counts: { objects: document.objects.length, interfaces: document.interfaces.length, links: document.links.length, actions: document.actions.length, functions: document.functions.length }, propertyCount, trustedValidatorCount: propertyCount, legacyMetadataPreserved: original } };
  compiledSeeds.set(seed, { registry, documentDigest: digest(document), model });
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
  if (predecessor.audit.model.digest !== 'fabd8b85eb9e6199140eece8a71bb4b91ef9c0eb0edd2df30df848c035657107') throw new DomainError('CONFLICT', 'The original consolidated v21 fingerprint changed');
  return predecessor;
}
export function createCurrentKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  return createBusinessDescriptionsKernelDefinition(registry);
}
export function createSemanticRetrievalKernelDefinition(registry=new TrustedDefinitionRegistry()):SeedDefinition{
  const semantic = complete(extendSemanticRetrievalKernel(createBusinessDescriptionsKernelDefinition(registry).document,registry),registry,false);
  if (digest(semantic.audit.model) !== digest(SEMANTIC_RETRIEVAL_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT', 'The reviewed semantic retrieval fingerprint changed');
  return semantic;
}
/** Opt-in PA presentation release. Existing databases keep their active release. */
export function createPaClassificationKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const classified = complete(extendPaClassificationKernel(createBusinessDescriptionsKernelDefinition(registry).document), registry, false);
  if (digest(classified.audit.model) !== digest(PA_CLASSIFICATION_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT', 'The reviewed PA classification fingerprint changed');
  return classified;
}
export function createBusinessDescriptionsKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const described = complete(extendBusinessDescriptions(createPaymentCommerceKernelDefinition(registry).document), registry, false);
  if (digest(described.audit.model) !== digest(BUSINESS_DESCRIPTIONS_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT', 'The original v28 description kernel fingerprint changed');
  return described;
}
export function createPaymentCommerceKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const previous = complete(extendPaymentCommerceKernel(createSingleReadKernelDefinition(registry).document, registry), registry, false);
  if (digest(previous.audit.model) !== digest(PAYMENT_COMMERCE_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT', 'The original v27 kernel fingerprint changed');
  return previous;
}
export function createSingleReadKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const previous = complete(extendSingleReadKernel(createPersonalContextKernelDefinition(registry).document, registry), registry, false);
  if (digest(previous.audit.model) !== digest(SINGLE_READ_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT', 'The original v26 kernel fingerprint changed');
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
  static readonly stages = 15;
  readonly #targetVersion: '27' | '28' | '29' | '30';
  readonly #stageCount: number;
  constructor(targetVersion: '27' | '28' | '29' | '30' = CURRENT_KERNEL_VERSION) {
    if (!['27', '28', '29', '30'].includes(targetVersion)) throw new Error('Unsupported reviewed kernel target');
    this.#targetVersion = targetVersion; this.#stageCount = targetVersion === '27' ? 14 : targetVersion==='28'?15:16;
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
          if (digest(this.#payment.audit.model) !== digest(PA_PAYMENT_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT','The original v19 model fingerprint changed');
          break;
        }
        case 4: {
          const provider = complete(extendProviderReadKernel(this.#payment!.document,this.#registry,historicalImplementation),this.#registry,false);
          if (digest(provider.audit.model) !== digest(PROVIDER_READ_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT','The original provider-read v20 model fingerprint changed');
          this.#checkout=undefined; this.#payment=undefined;
          break;
        }
        case 5: this.#didi = complete(extendDidiKernel(this.#composition!.document,this.#registry),this.#registry,false); this.#composition=undefined; break;
        case 6: this.#combined = extendPAPaymentKernel(extendCheckoutKernel(this.#didi!.document,this.#registry),this.#registry); this.#didi=undefined; break;
        case 7: {
          this.#current = complete(extendConsolidatedKernel(this.#combined!,this.#registry,BUSINESS_MODEL_DEFINITION),this.#registry,false);
          if (this.#current.audit.model.digest !== 'fabd8b85eb9e6199140eece8a71bb4b91ef9c0eb0edd2df30df848c035657107') throw new DomainError('CONFLICT','The original consolidated v21 fingerprint changed');
          this.#combined=undefined;
          break;
        }
        case 8: {
          this.#current = complete(extendTaskClosureKernel(this.#current!.document,this.#registry,BUSINESS_MODEL_DEFINITION),this.#registry,false);
          if (this.#current.audit.model.digest !== 'b800ef526f90c2dfbbb6c82495318bf820145520ce2dd1d63635c8b930c5fca4') throw new DomainError('CONFLICT','The original v22 kernel fingerprint changed');
          break;
        }
        case 9: this.#current = complete(extendRollingGoKernel(this.#current!.document,this.#registry),this.#registry,false); break;
        case 10: this.#current = complete(extendBusinessFactsKernel(this.#current!.document,this.#registry),this.#registry,false); break;
        case 11: this.#current = complete(extendPersonalContextKernel(this.#current!.document,this.#registry),this.#registry,false); break;
        case 12:
          this.#current = complete(extendSingleReadKernel(this.#current!.document,this.#registry),this.#registry,false);
          if (digest(this.#current.audit.model) !== digest(SINGLE_READ_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT','The original v26 kernel fingerprint changed');
          break;
        case 13:
          this.#current = complete(extendPaymentCommerceKernel(this.#current!.document,this.#registry),this.#registry,false,model=>{this.#model=model;});
          if (digest(this.#current.audit.model) !== digest(PAYMENT_COMMERCE_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT','The original v27 kernel fingerprint changed');
          if (this.#targetVersion === '27') { this.#documentDigest=digest(this.#current.document); this.#registry.seal(); }
          break;
        case 14:
          this.#current = complete(extendBusinessDescriptions(this.#current!.document),this.#registry,false,model=>{this.#model=model;});
          if (digest(this.#current.audit.model) !== digest(BUSINESS_DESCRIPTIONS_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT','The reviewed v28 description fingerprint changed');
          if(this.#targetVersion==='28'){this.#documentDigest=digest(this.#current.document); this.#registry.seal();}
          break;
        case 15: {
          const classification = this.#targetVersion === '30';
          const expected = classification ? PA_CLASSIFICATION_KERNEL_MODEL_REF : SEMANTIC_RETRIEVAL_KERNEL_MODEL_REF;
          this.#current=complete(classification ? extendPaClassificationKernel(this.#current!.document) : extendSemanticRetrievalKernel(this.#current!.document,this.#registry),this.#registry,false,model=>{this.#model=model;});
          if (digest(this.#current.audit.model) !== digest(expected)) throw new DomainError('CONFLICT', `The reviewed v${expected.version} kernel fingerprint changed`);
          this.#documentDigest=digest(this.#current.document);this.#registry.seal();
          break;
        }
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
  if (closure.audit.model.digest !== 'b800ef526f90c2dfbbb6c82495318bf820145520ce2dd1d63635c8b930c5fca4') throw new DomainError('CONFLICT', 'The original v22 kernel fingerprint changed');
  return closure;
}
export function createProviderReadKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const payment = createPAPaymentKernelDefinition(registry);
  const provider = complete(extendProviderReadKernel(payment.document, registry, historicalImplementation), registry, false);
  if (digest(provider.audit.model) !== digest(PROVIDER_READ_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT', 'The original provider-read v20 model fingerprint changed');
  return provider;
}
export function createPAPaymentKernelDefinition(registry = new TrustedDefinitionRegistry()): SeedDefinition {
  const payment = complete(extendPAPaymentKernel(createCheckoutKernelDefinition(registry).document, registry), registry, false);
  if (digest(payment.audit.model) !== digest(PA_PAYMENT_KERNEL_MODEL_REF)) throw new DomainError('CONFLICT', 'The original v19 model fingerprint changed');
  return payment;
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
  if (digest(historical.audit.model) !== digest(frozenV16.model)) throw new DomainError('CONFLICT', 'The original v16 model fingerprint changed');
  return historical;
}
