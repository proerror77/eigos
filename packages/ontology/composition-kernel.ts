import { z } from 'zod';
import { sandboxCompositionActions, sandboxCompositionLinks, sandboxCompositionObjects } from './sandbox-composition.js';
import { ucpCompositionActions, ucpCompositionLinks, ucpCompositionObjects } from './ucp-composition.js';
import type { OntologyDocument, SerializableProperty, JsonSchema } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import type { ActionDefinition, ModelDefinition, ObjectTypeDefinition } from './model.js';
import { objectRefSchema } from './model.js';
import { actionEffects, actionVersion, type CompositionPort } from './composition-contract.js';
import { documentAction, documentLinks, documentObjects, citationPort } from './document-action.js';
import { executionReferenceLinks } from './execution-model.js';
import { goalCriteriaSchema } from '../core/goal-contract.js';
import { digest } from '../core/delegation.js';
import { serviceDomains } from './service-domains.js';
import { geoCompositionAction, geoCompositionLinks, geoCompositionObjects } from './geo-composition.js';
import { localArtifactActions, localArtifactLinks, localArtifactObjects } from './local-artifacts.js';
import { domainAtomicActions, domainPreparedReceiptSchema } from './domain-composition.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(200);
const ref = z.strictObject({ id: text, version: text });
const phases: Record<string, CompositionPort['semantics']['phase']> = {
  RideEstimateTask: 'request', RideEstimateObservation: 'quote', DidiOrderObservation: 'commitment',
  GeoQueryTask: 'request', CatalogTask: 'request', PaotuiTask: 'request', CommerceTask: 'request', BookingTask: 'request', ServiceRequest: 'request', Parcel: 'request', DeliveryRoute: 'request',
  ProductOffer: 'quote', DeliveryQuote: 'quote', ReservationOffer: 'quote', LandedCostQuote: 'quote', CommerceCheckout: 'quote',
  CommerceOrderObservation: 'commitment', BookingObservation: 'commitment', CommercePaymentObservation: 'payment', BookingPaymentObservation: 'payment', StripePaymentObservation: 'payment', PAPaymentRequest: 'request', CommerceDeliveryObservation: 'delivery',
};
for (const domain of serviceDomains) {
  phases[domain.requestType] = 'request'; phases[domain.candidateType] = 'quote';
  phases[domain.resultType] = ['ride', 'food'].includes(domain.id) ? 'delivery' : domain.id === 'itinerary' ? 'artifact' : 'commitment';
}
const objectPort = (type: string, role = type, phase = phases[type] ?? 'fact'): CompositionPort => ({ kind: 'object', type, cardinality: 'one',
  semantics: { role, phase }, evidence: { origins: phase === 'request' ? ['managed', 'user'] : ['provider', 'synthetic'], ...(phase === 'request' ? {} : { maxAgeMs: 300000 }) } });

/** The typed schema identifies all reference arguments, including references
 * that old display-only inputs metadata omitted. It never guesses an entity
 * from a name or joins unrelated source identities. */
export function composable(action: ActionDefinition, evidenceTypes: Set<string>): ActionDefinition {
  const operation = action.read ?? action.operation;
  if (!operation || action.composition) return action;
  const properties = (operation.inputSchema as { properties: Record<string, JsonSchema>; required?: string[] }).properties;
  const inputs = { ...action.inputs }, ports: Record<string, CompositionPort> = {};
  for (const [name, schema] of Object.entries(properties)) {
    const many = schema.type === 'array', item = (many ? schema.items : schema) as JsonSchema;
    const type = (item.properties as Record<string, JsonSchema> | undefined)?.type;
    const objectType = inputs[name] ?? (typeof type?.const === 'string' ? type.const : undefined);
    if (objectType) {
      inputs[name] = objectType;
      ports[name] = { ...objectPort(objectType), ...(many ? { cardinality: 'many' as const } : {}) };
    }
  }
  let output = objectPort(operation.resultType);
  if (action.id === 'ReadSavedAddresses') output = objectPort('PaotuiObservation', 'saved_address_book');
  if (action.id === 'ReadSavedAddressDetail') { output = objectPort('PaotuiObservation', 'saved_address_detail'); ports.book = objectPort('PaotuiObservation', 'saved_address_book'); }
  if (action.id === 'PreviewDeliveryQuote') {
    output = objectPort('PaotuiObservation', 'parcel_delivery_quote', 'quote');
    ports.sender = objectPort('PaotuiObservation', 'sender_address_detail'); ports.sender.semantics.locationRole = 'sender';
    ports.recipient = objectPort('PaotuiObservation', 'recipient_address_detail'); ports.recipient.semantics.locationRole = 'recipient';
  }
  const outputs: Record<string, CompositionPort> = { result: output };
  const identityType = ['DidiOrderObservation', 'Cart', 'CommerceOrderObservation', 'StripePaymentObservation', 'BookingObservation'].includes(operation.resultType) ? operation.resultType : undefined;
  if (identityType) outputs.identity = { kind: 'object', type: identityType, cardinality: 'one', semantics: { role: `original_${identityType}`, phase: 'fact' }, evidence: { origins: ['provider', 'synthetic'] } };
  if (['ReadDidiRide', 'ReadCommerceCart', 'ReadCommerceOrder', 'ReadCommercePayment', 'ReadCommerceDelivery', 'ReadStripePayment', 'ReadProviderBooking', 'ReadProviderPayment'].includes(action.id)) {
    for (const [name, port] of Object.entries(ports)) if (name !== 'scope' && port.kind === 'object') ports[name] = { ...port, semantics: { role: `original_${port.type}`, phase: 'fact' }, evidence: { origins: ['provider', 'synthetic'] } };
  }
  if (['SearchPublicCatalog', 'InspectCatalogVariant', 'ReadMerchantVariants'].includes(action.id)) outputs.citations = citationPort(operation.resultType);
  else if (evidenceTypes.has(operation.resultType)) outputs.citations = { ...citationPort(operation.resultType), optional: true };
  if (action.id === 'ReadSavedAddressDetail') for (const role of ['sender', 'recipient'] as const) {
    const port = objectPort('PaotuiObservation', `${role}_address_detail`); port.semantics.locationRole = role;
    outputs[role] = { ...port, optional: true };
  }
  const effects = actionEffects(action), external = effects.some(effect => !['read', 'local', 'object_write'].includes(effect));
  return { ...action, version: action.version ?? actionVersion(action), inputs,
    composition: { version: '1', inputs: ports, outputs, checks: [], effectScope: { effects, targetInputs: effects.every(effect => ['read', 'local'].includes(effect)) ? [] : Object.keys(ports),
      recovery: external ? { kind: 'original_intent', version: '1', effect: 'read' } : { kind: 'none' }, compensation: [] } } };
}

/** v17 extends a reconstructed, verified v16 document. Old validators and
 * historical documents retain their exact identities and fingerprints. */
export function extendCompositionKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry, current: ModelDefinition): OntologyDocument {
  const document = structuredClone(original); document.version = '17';
  const property = (type: string, name: string, kind: SerializableProperty['kind'], schema: z.ZodType, description: string, required = false): SerializableProperty => {
    const metadata = z.toJSONSchema(schema), validatorRef = registry.registerValidator(`eigos.business:object:${type}:${name}`, 'eigos-composition-v17', schema, metadata);
    return { kind, schema: metadata, validatorRef, description, source: 'Trusted composition runtime and exact durable ledger', required };
  };
  document.interfaces.push({ id: 'CitableObject', resourceId: 'builtin:eigos.business:interface:CitableObject', description: 'A typed object eligible for citation only after its original intent and named output are durably accepted. This marker never grants provider evidence or business completion.', properties: {} });
  const evidence = document.interfaces.find(value => value.id === 'EvidenceBacked')!;
  evidence.parents = [...(evidence.parents ?? []), 'CitableObject'];
  // New user constraint roles are admitted only by the new release. Historical
  // validators keep the old schema guard, including trusted refinements.
  for (const [kind, types] of [['object', document.objects], ['interface', document.interfaces]] as const) for (const type of types) {
    const live = (kind === 'object' ? current.objects : current.interfaces).find(value => value.id === type.id);
    if (!live) continue;
    for (const [name, old] of Object.entries(type.properties)) {
      const next = live.properties[name]!;
      const schema = next.schemaMetadata ?? z.toJSONSchema(next.schema);
      if (digest(schema) === digest(old.schema)) continue;
      const validatorRef = registry.registerValidator(`eigos.business:${kind}:${type.id}:${name}`, 'eigos-composition-v17', next.schema, schema);
      type.properties[name] = { ...old, schema, validatorRef };
    }
  }
  const extend = (type: string, properties: Record<string, SerializableProperty>) => { const object = document.objects.find(value => value.id === type)!; object.properties = { ...object.properties, ...properties }; object.version = `${object.version ?? '1'}.composition1`; };
  extend('RegisteredActionType', { composition: property('RegisteredActionType', 'composition', 'struct', z.record(z.string(), z.unknown()), 'Exact named ports and evidence semantics of this action') });
  extend('RegisteredCapability', { goalOutcomes: property('RegisteredCapability', 'goalOutcomes', 'array', z.array(z.strictObject({ predicate: text, phase: z.enum(['fact', 'quote', 'commitment', 'payment', 'delivery', 'artifact']), description: z.string().min(1).max(2000) })).max(100), 'Registered independently checked outcomes and their business phases') });
  extend('Proposal', { kind: property('Proposal', 'kind', 'string', z.enum(['offer_selection', 'read_scope', 'execution', 'goal']), 'Whole-goal interpretation, offer selection, read scope or exact authorized frontier') });
  extend('Authorization', { budgetImpact: property('Authorization', 'budgetImpact', 'struct', z.record(z.string(), z.unknown()), 'Exact budget exposure distinct from the action charge ceiling') });
  extend('ActionBinding', {
    kind: property('ActionBinding', 'kind', 'string', z.enum(['agent_program', 'fixed_plan', 'action']), 'Program policy, historical plan, or exact per-action implementation', true),
    programRef: property('ActionBinding', 'programRef', 'struct', ref, 'Owning trusted execution component'),
    contextId: property('ActionBinding', 'contextId', 'string', text, 'Explicit immutable component context'),
    contextDigest: property('ActionBinding', 'contextDigest', 'string', sha, 'Sealed context identity'),
    scope: property('ActionBinding', 'scope', 'struct', objectRefSchema, 'Typed component request scope'),
    definitionDigest: property('ActionBinding', 'definitionDigest', 'string', sha, 'Exact registered action definition'),
  });
  extend('ExecutionContext', {
    goal: property('ExecutionContext', 'goal', 'struct', z.strictObject({ digest: sha, criteria: goalCriteriaSchema }), 'Immutable whole-goal conditions, never replaced by component completion'),
    components: property('ExecutionContext', 'components', 'array', z.array(z.strictObject({ id: text, programRef: ref, configurationDigest: sha, scope: objectRefSchema, digest: sha, retired: z.boolean().optional() })).max(16), 'Prepared contexts; source facts remain in their own typed objects'),
    goalAssessment: property('ExecutionContext', 'goalAssessment', 'struct', z.record(z.string(), z.unknown()), 'Current per-criterion status and verification gaps'),
  });
  extend('ExecutionInput', {
    sourceKind: property('ExecutionInput', 'sourceKind', 'string', z.enum(['literal', 'object', 'step_output', 'candidate_context', 'accepted_output']), 'Typed input provenance', true),
    sourcePort: property('ExecutionInput', 'sourcePort', 'string', text, 'Exact named output; never a JSON path'),
    sourceIntentId: property('ExecutionInput', 'sourceIntentId', 'string', text, 'Original accepted producer intent'),
  });
  for (const value of [...documentObjects, ...localArtifactObjects, ...geoCompositionObjects, ...ucpCompositionObjects, ...sandboxCompositionObjects]) document.objects.push({ ...value, resourceId: `builtin:eigos.business:object:${value.id}`, writePolicy: 'source',
    properties: Object.fromEntries(Object.entries(value.properties).map(([name, metadata]) => [name, { ...property(value.id, name, metadata.kind, metadata.schema, metadata.description, !!metadata.required), ...(metadata.restricted ? { restricted: true } : {}) }])) });
  document.links.push(...[...documentLinks, ...localArtifactLinks, ...geoCompositionLinks, ...ucpCompositionLinks, ...sandboxCompositionLinks].map(value => ({ ...value, resourceId: `builtin:eigos.business:link:${value.id}`, writePolicy: 'source' as const })));
  for (const domain of serviceDomains) extend(domain.candidateType, { preparedReceipt: { ...property(domain.candidateType, 'preparedReceipt', 'struct', domainPreparedReceiptSchema, 'Private original source preparation for this exact accepted action'), restricted: true } });
  document.actions.push(...[...domainAtomicActions, ...localArtifactActions, geoCompositionAction, ...ucpCompositionActions, ...sandboxCompositionActions].map(action => ({ ...action, resourceId: `builtin:eigos.business:action:${action.id}` })));
  const evidenceTypes = new Set(document.objects.filter(object => object.interfaces?.some(value => value.id === 'EvidenceBacked')).map(object => object.id));
  document.actions = [...document.actions.map(({ resourceId, implementation: _implementation, ...value }) => {
    const action = composable(value, evidenceTypes);
    return { ...action, resourceId, ...(value.read || value.operation || value.providerOperation && value.kind === 'business' && value.version ? { implementation: { kind: 'trusted' as const, handlerRef: registry.registerAction(action) } } : {}) };
  }), { ...documentAction, resourceId: 'builtin:eigos.business:action:ComposeDocument', implementation: { kind: 'trusted', handlerRef: registry.registerAction(documentAction) } }];
  const knownLinks = new Set(document.links.map(link => link.id));
  const references = executionReferenceLinks(document.objects as Pick<ObjectTypeDefinition, 'id' | 'interfaces'>[], document.actions, document.interfaces);
  for (const link of references) if (!knownLinks.has(link.id)) document.links.push({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' });
  // Whole-goal execution uses the existing ServiceRequest as its root scope.
  if (!document.links.some(link => link.id === 'ExecutionContextScopeServiceRequest')) document.links.push({ resourceId: 'builtin:eigos.business:link:ExecutionContextScopeServiceRequest', id: 'ExecutionContextScopeServiceRequest', writePolicy: 'source', description: 'Whole-goal context is scoped to the immutable request revision', from: { type: 'ExecutionContext', name: 'scopeServiceRequest', many: false }, to: { type: 'ServiceRequest', name: 'executionScopes', many: true } });
  return document;
}
