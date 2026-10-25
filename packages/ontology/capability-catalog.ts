import { authorizationScope } from '../security/context.js';
import { capabilityVerificationHistorySchema, sanitizeCapabilityVerificationHistory, type CapabilityVerificationHistory } from './capability-feedback.js';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import { objectRefSchema, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import type { LinkWrite, ObjectWrite, OntologyObjectStore } from './object-store.js';
import { moneySchema, type ProviderBinding, type ResolvedCandidate, type ServiceCapability, type ServiceRequest } from './execution.js';
import type { Resolution } from '../coordinator/resolver.js';

type CapabilitySummary = ReturnType<ExecutionCatalog['summaries']>[number];
export type CapabilityContextSummary = CapabilitySummary & { verificationHistory?: CapabilityVerificationHistory };
type CapabilityProjectionSummary = CapabilitySummary & { verificationHistory?: unknown };
const contextualCapabilityId = (definitionDigest: string, requestId: string, verificationHistory: CapabilityVerificationHistory) => `capability-context:${digest({definitionDigest, requestId, verificationHistory})}`;
const ref = z.object({ id: z.string().min(1).max(200), version: z.string().min(1).max(80) }).strict();
const jsonObject = z.record(z.string(), z.unknown());
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, required = true): PropertyDefinition => ({ kind, schema, description, required, source: 'Configured capability registry filtered for this authenticated task' });
export const capabilityCatalogObjects: ObjectTypeDefinition[] = [{
  id: 'RegisteredCapability', version: '1', name: '已登记服务能力', aliases: ['RegisteredCapability'], description: 'An immutable configured capability description available to a request. Registration and visibility never grant execution or source authority.', primaryKey: 'id', titleKey: 'name', visibility: 'technical',
  properties: {
    id: p('string', z.string().min(1).max(200), 'Definition snapshot identity'), name: p('string', z.string().min(1).max(500), 'Registered capability name'),
    capabilityRef: p('struct', ref, 'Exact capability identity and version'), description: p('string', z.string().max(10000), 'Registered purpose and supported outcome'),
    tags: p('array', z.array(z.string().max(100)).max(50), 'Discovery labels'), inputSchema: p('struct', jsonObject, 'Typed input contract'),
    predicates: p('array', z.array(jsonObject).max(100), 'Declared business predicates'), outcomePredicates: p('array', z.array(z.string()).max(100), 'Declared result predicates'),
    requirementRoles: p('array', z.array(jsonObject).max(100), 'Distinct semantic roles for request constraints'),
    constraintEvaluation: p('string', z.enum(['staged']), 'Evaluate source facts at the appropriate business stage', false),
    locationSemantics: p('string', z.string().max(100), 'Meaning of requested location', false),
    definitionDigest: p('string', z.string().regex(/^[a-f0-9]{64}$/), 'Exact metadata snapshot digest'),
  },
}];
export const capabilityCatalogLinks: LinkDefinition[] = [{ id: 'CapabilityRequest', description: 'A capability description retrieved for this request; reverse navigation does not grant access to other requests', from: { type: 'RegisteredCapability', name: 'requests', many: true }, to: { type: 'ServiceRequest', name: 'capabilities', many: true } }];

const canonical = (s: CapabilitySummary): CapabilitySummary => ({ ref: s.ref, name: s.name, description: s.description, tags: s.tags, inputSchema: s.inputSchema,
  predicates: s.predicates, outcomePredicates: s.outcomePredicates, requirementRoles: s.requirementRoles,
  ...(s.goalOutcomes ? { goalOutcomes: s.goalOutcomes } : {}),
  // Source readiness is mutable owner state, never part of a definition's identity.
  locationSemantics: s.locationSemantics, constraintEvaluation: s.constraintEvaluation, scopeReviewMode: s.scopeReviewMode, sourceAuthorization: undefined });

/** Called under the same fenced transaction as interpretation, never by a model. */
export function projectCapabilityCatalog(graph: OntologyObjectStore, owner: string, requestId: string, summaries: CapabilityProjectionSummary[]) {
  if (summaries.length > 16) throw new DomainError('CONFLICT', 'Narrow the capability discovery scope');
  if (summaries.some(item => item.verificationHistory !== undefined) && (graph.security || authorizationScope())) throw new DomainError('FORBIDDEN', 'Task-scoped authority does not grant cross-task feedback history');
  const supportsHistory = Object.hasOwn(graph.model.properties('RegisteredCapability'), 'verificationHistory') && Object.hasOwn(graph.model.properties('RegisteredCapability'), 'contextRequestId');
  const request = { type: 'ServiceRequest', id: requestId }, objects: ObjectWrite[] = [], links: LinkWrite[] = [];
  graph.read(owner, request);
  for (const item of summaries) {
    const history = item.verificationHistory === undefined || !supportsHistory ? undefined : sanitizeCapabilityVerificationHistory(item.verificationHistory);
    const s = canonical(item), hash = digest(s), object = { type: 'RegisteredCapability', id: history ? contextualCapabilityId(hash, requestId, history) : `capability:${hash}` };
    const properties = { id: object.id, capabilityRef: s.ref, name: s.name, description: s.description, tags: s.tags, inputSchema: s.inputSchema,
      predicates: s.predicates, outcomePredicates: s.outcomePredicates, requirementRoles: s.requirementRoles,
      ...(s.goalOutcomes ? { goalOutcomes: s.goalOutcomes } : {}),
      ...(s.constraintEvaluation ? { constraintEvaluation: s.constraintEvaluation } : {}),
      ...(s.scopeReviewMode ? { scopeReviewMode: s.scopeReviewMode } : {}),
      ...(s.locationSemantics ? { locationSemantics: s.locationSemantics } : {}), definitionDigest: hash, ...(history ? {contextRequestId:requestId, verificationHistory:history} : {}) };
    try { if (digest(graph.read(owner, object).properties) !== digest(properties)) throw new DomainError('CONFLICT', 'Registered capability snapshot changed'); }
    catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; objects.push({ ref: object, properties }); }
    links.push({ type: 'CapabilityRequest', from: object, to: request });
  }
  const removeLinks = (graph.related(owner, request, 'capabilities', { remaining: 1000 }) ?? []).filter(old => !links.some(l => l.from.id === old.ref.id)).map(old => ({ type: 'CapabilityRequest', from: old.ref, to: request }));
  graph.ingest(owner, { objects, links, removeLinks }, { kind: 'task', id: requestId, observedAt: new Date().toISOString() });
}

export function readCapabilityCatalog(graph: OntologyObjectStore, owner: string, requestId: string): CapabilityContextSummary[] {
  const objects = graph.related(owner, { type: 'ServiceRequest', id: requestId }, 'capabilities', { remaining: 1000 }) ?? [];
  if (objects.length > 16) throw new DomainError('CONFLICT', 'Capability context exceeds its retrieval bound');
  return objects.map(object => {
    const p = object.properties;
    const value = canonical({ ref: p.capabilityRef, name: p.name, description: p.description, tags: p.tags, inputSchema: p.inputSchema, predicates: p.predicates,
      outcomePredicates: p.outcomePredicates, ...(p.goalOutcomes ? { goalOutcomes: p.goalOutcomes } : {}), requirementRoles: p.requirementRoles, locationSemantics: p.locationSemantics, constraintEvaluation: p.constraintEvaluation, scopeReviewMode: p.scopeReviewMode, sourceAuthorization: undefined } as CapabilitySummary);
    const contextual = p.contextRequestId !== undefined || p.verificationHistory !== undefined;
    if (contextual && (graph.security || authorizationScope())) throw new DomainError('FORBIDDEN', 'Task-scoped authority does not grant cross-task feedback history');
    if (contextual && (p.contextRequestId !== requestId || p.verificationHistory === undefined)) throw new DomainError('CONFLICT', 'Capability feedback belongs to another request');
    const history = contextual ? capabilityVerificationHistorySchema.parse(p.verificationHistory) : undefined;
    const expectedId = history ? contextualCapabilityId(String(p.definitionDigest), requestId, history) : `capability:${p.definitionDigest}`;
    if (digest(value) !== p.definitionDigest || object.ref.id !== expectedId || history && digest(history) !== digest(p.verificationHistory)) throw new DomainError('CONFLICT', 'Registered capability evidence changed');
    return {...value, ...(history ? {verificationHistory:history} : {})};
  });
}

export type PreparedResolution = Omit<Resolution, 'privateData'>;
export type PreparedCapability = Pick<ServiceCapability, 'ref' | 'ontologyRef' | 'actions' | 'verifierRef' | 'completion' | 'environment'>;
const text = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/), timestamp = z.iso.datetime({ offset: true });
const strings = z.array(z.string().min(1).max(2000)).max(100);
const bindingSchema = z.strictObject({
  ref, capabilityRef: ref, providerId: text, channelId: text, adapterId: text, merchantId: text.optional(), configurationDigest: z.string().min(1).max(2000).optional(),
  protocol: z.enum(['local', 'http', 'mcp', 'a2a', 'browser']), enabled: z.boolean(),
  verification: z.strictObject({ level: z.enum(['local_test', 'read_only_probe', 'simulated', 'live_fulfillment']), evidenceRefs: strings }),
  recovery: z.strictObject({ idempotency: z.enum(['none', 'provider_key', 'provider_reference']), lookup: z.boolean() }),
  discovery: z.strictObject({ sourceId: text, requestId: text, requestRevision: z.number().int().positive(), observedAt: timestamp, evidenceRefs: strings }).optional(),
});
const checkSchema = z.strictObject({ requirementId: text, result: z.enum(['pass', 'fail', 'unknown']), reason: z.string().max(10000), evidenceRefs: strings });
const coverageSchema = z.strictObject({ sourceId: text, status: z.enum(['returned', 'empty', 'timeout', 'needs_input', 'needs_authorization', 'unavailable']), queriedAt: timestamp,
  returnedStores: z.number().int().nonnegative(), queriedStores: z.number().int().nonnegative(), hasMore: z.boolean(), realSupply: z.boolean(), note: z.string().max(10000).optional() });
const preparedStepSchema = z.strictObject({
  id: text, operationId: text, actionTypeRef: ref, bindingRef: ref.optional(), capabilityRef: ref.optional(), operationScope: text.optional(),
  input: jsonObject, inputRefs: z.array(z.strictObject({ stepId: text, path: z.string().max(1000), targetKey: text })).max(8), dependsOn: z.array(text).max(8),
  cost: z.strictObject({ minor: moneySchema.shape.minor, currency: moneySchema.shape.currency, payeeId: text, purpose: z.enum(['service_total', 'deposit']).optional() }).optional(),
});
const quoteSchema = z.strictObject({ id: text, digest: sha, amount: moneySchema, expiresAt: timestamp, environment: z.literal('local_simulation'),
  requestDigest: sha, bindingRef: ref, bindingDigest: sha, inputDigest: sha, detailsDigest: sha });
const effect = z.enum(['local', 'read', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund', 'object_write']);
const capabilityActionsSchema = z.array(z.strictObject({ ref, effect, additionalEffects: z.array(effect).max(8).optional() })).min(1).max(32);
const candidateSchema = z.strictObject({
  id: text, binding: bindingSchema, status: z.enum(['ready', 'needs_input', 'unavailable']), question: z.string().max(10000).optional(),
  input: jsonObject.optional(), details: jsonObject.optional(), facts: jsonObject, evidenceRefs: strings,
  requirementChecks: z.array(checkSchema).max(40), observedAt: timestamp, expiresAt: timestamp,
  quote: quoteSchema.optional(), offer: jsonObject.optional(), ontologySubject: objectRefSchema.optional(), recipe: z.array(preparedStepSchema).min(1).max(8).optional(),
});
const commonProperties = { id: p('string', text, 'Task-local projection identity'), name: p('string', z.string().min(1).max(500), 'Safe business record label'),
  requestRevision: p('integer', z.number().int().positive(), 'Owning request revision') };
capabilityCatalogObjects.push({
  id: 'ResolutionContext', version: '1', name: '当前候选方案范围', aliases: ['ResolutionContext'], description: 'Bounded prepared candidates and discovery coverage for the current request revision; it provides no execution grant.', primaryKey: 'id', titleKey: 'name', visibility: 'technical',
  properties: { ...commonProperties,
    capabilityRef: p('struct', ref, 'Exact selected capability'), searchedBindingRefs: p('array', z.array(ref).max(8), 'Bindings actually considered'),
    observedAt: p('timestamp', timestamp, 'Preparation scope recording time'), realSupply: p('boolean', z.boolean(), 'Observed real-supply evidence, not execution completion'),
    coverage: p('array', z.array(coverageSchema).max(16), 'Explicit discovery coverage and uncertainty', false),
    comparison: p('struct', jsonObject, 'Public comparison for this exact request, including source evidence and unknowns', false),
    capabilityActions: p('array', capabilityActionsSchema, 'Exact registered action identities and permitted effect classes for this prepared capability', false),
    capabilityOntologyRef: p('struct', ref, 'Registered capability ontology identity', false), capabilityVerifierRef: p('struct', ref, 'Independent verifier contract', false),
    capabilityCompletion: p('string', z.enum(['artifact', 'delivery', 'order', 'refund', 'domain']), 'Registered completion meaning', false),
    capabilityEnvironment: p('string', z.enum(['live', 'sandbox']), 'Configured execution environment, not authorization', false),
    capabilityDefinitionDigest: p('string', sha, 'Digest of the selected public capability action contract', false),
    candidateCount: p('integer', z.number().int().min(0).max(8), 'Exact number of linked prepared candidates'), resolutionDigest: p('string', sha, 'Digest of the complete public prepared resolution'),
  },
}, {
  id: 'PreparedCandidate', version: '1', name: '已准备候选方案', aliases: ['PreparedCandidate'], description: 'One registered adapter result with explicit binding, public inputs, observed facts and requirement checks; private execution payloads are excluded.', primaryKey: 'id', titleKey: 'name', visibility: 'technical',
  properties: { ...commonProperties,
    candidateId: p('string', text, 'Candidate identity used in the model decision'), sequence: p('integer', z.number().int().min(0).max(7), 'Original order within this prepared scope'), candidateDigest: p('string', sha, 'Exact public candidate digest'),
    binding: p('struct', bindingSchema, 'Pinned public implementation metadata; not current source authorization'),
    status: p('string', candidateSchema.shape.status, 'Whether this candidate is ready, requires owner input or is unavailable'),
    question: p('string', z.string().max(10000), 'Safe business question or unavailability reason', false),
    input: p('struct', jsonObject, 'Public prepared action arguments validated separately by the registered adapter', false),
    details: p('struct', jsonObject, 'Public preparation details; never the private adapter payload', false),
    facts: p('struct', jsonObject, 'Observed business facts used by requirement checks'),
    evidenceRefs: p('array', strings, 'Source evidence identities'), requirementChecks: p('array', z.array(checkSchema).max(40), 'Explicit pass/fail/unknown checks'),
    observedAt: p('timestamp', timestamp, 'Original source observation time'), expiresAt: p('timestamp', timestamp, 'Source fact expiry'),
    quote: p('struct', quoteSchema, 'Exact local simulation authorization pricing; never a real payment', false),
    offer: p('struct', jsonObject, 'Public offer snapshot with provenance and uncertainty', false),
    ontologySubject: p('struct', objectRefSchema, 'Exact owned business object associated with this candidate', false),
    recipe: p('array', z.array(preparedStepSchema).min(1).max(8), 'Trusted prepared steps with explicit action versions, inputs and output dependencies', false),
  },
});
capabilityCatalogLinks.push(
  { id: 'ResolutionRequest', description: 'Prepared discovery scope belongs to one request', from: { type: 'ResolutionContext', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'preparedResolutions', many: true } },
  { id: 'CandidateRequest', description: 'Candidate belongs to one request revision', from: { type: 'PreparedCandidate', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'preparedCandidates', many: true } },
  { id: 'CandidateResolution', description: 'Candidate was prepared within this exact bounded resolution', from: { type: 'PreparedCandidate', name: 'resolution', many: false, required: true }, to: { type: 'ResolutionContext', name: 'candidates', many: true } },
  { id: 'CurrentPreparedResolution', description: 'Only this prepared resolution is current; historical candidate records remain auditable', from: { type: 'ServiceRequest', name: 'currentResolution', many: false }, to: { type: 'ResolutionContext', name: 'currentForRequest', many: false } },
  { id: 'PreparedCandidateEvidenceSubject', description: 'The source-backed business object represented by this prepared candidate', from: { type: 'PreparedCandidate', name: 'subject', many: false }, to: { type: 'EvidenceBacked', name: 'preparedCandidates', many: true } },
  { id: 'PreparedCandidateCheckoutRequirements', description: 'The current checkout request whose preparation is represented by this candidate', from: { type: 'PreparedCandidate', name: 'checkoutRequirements', many: false }, to: { type: 'CheckoutRequest', name: 'preparedCandidates', many: true } },
);
function subjectRelationship(graph: OntologyObjectStore, subject: { type: string; id: string }) {
  if (graph.model.implements(subject.type, 'EvidenceBacked')) return { type: 'PreparedCandidateEvidenceSubject', name: 'subject' };
  if (subject.type === 'CheckoutRequest') return { type: 'PreparedCandidateCheckoutRequirements', name: 'checkoutRequirements' };
  throw new DomainError('INVALID_INPUT', 'Prepared candidate subject has no registered business relationship');
}
function verifySubjectRelationship(graph: OntologyObjectStore, owner: string, candidate: { type: string; id: string }, subject?: { type: string; id: string }) {
  const expected = subject ? subjectRelationship(graph, subject) : undefined;
  for (const name of ['subject', 'checkoutRequirements']) {
    const values = graph.related(owner, candidate, name, { remaining: 1000 });
    if (!values || (name === expected?.name ? values.length !== 1 || digest(values[0]!.ref) !== digest(subject) : values.length !== 0)) throw new DomainError('CONFLICT', 'Prepared candidate business relationship changed');
  }
}

function publicBinding(binding: ProviderBinding): ProviderBinding {
  return bindingSchema.parse({ ref: binding.ref, capabilityRef: binding.capabilityRef, providerId: binding.providerId, channelId: binding.channelId,
    adapterId: binding.adapterId, merchantId: binding.merchantId, configurationDigest: binding.configurationDigest, protocol: binding.protocol,
    enabled: binding.enabled, verification: binding.verification, recovery: binding.recovery, discovery: binding.discovery });
}
function publicCandidate(candidate: ResolvedCandidate): ResolvedCandidate {
  const value = candidateSchema.parse({ id: candidate.id, binding: publicBinding(candidate.binding), status: candidate.status, question: candidate.question,
    input: candidate.input, details: candidate.details, facts: candidate.facts, evidenceRefs: candidate.evidenceRefs, requirementChecks: candidate.requirementChecks,
    observedAt: candidate.observedAt, expiresAt: candidate.expiresAt, quote: candidate.quote, offer: candidate.offer, ontologySubject: candidate.ontologySubject, recipe: candidate.recipe });
  return value as unknown as ResolvedCandidate;
}
function canonicalResolution(resolution: PreparedResolution): PreparedResolution {
  return { candidates: resolution.candidates.map(publicCandidate), scope: { capabilityRef: ref.parse(resolution.scope.capabilityRef),
    searchedBindingRefs: z.array(ref).max(8).parse(resolution.scope.searchedBindingRefs), observedAt: timestamp.parse(resolution.scope.observedAt), realSupply: z.boolean().parse(resolution.scope.realSupply),
    ...(resolution.scope.coverage ? { coverage: z.array(coverageSchema).max(16).parse(resolution.scope.coverage) } : {}) },
    ...(resolution.comparison ? { comparison: structuredClone({ requestId: resolution.comparison.requestId, requestRevision: resolution.comparison.requestRevision,
      offers: resolution.comparison.offers, merchantGroups: resolution.comparison.merchantGroups, productMatches: resolution.comparison.productMatches, coverage: resolution.comparison.coverage }) } : {}) };
}
function checkOwnedReferences(graph: OntologyObjectStore, owner: string, request: Pick<ServiceRequest, 'id' | 'revision'>, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const reference = objectRefSchema.safeParse(value);
  if (reference.success) {
    const object = graph.read(owner, reference.data);
    const navigation = graph.model.sides(object.ref.type).find(side => side.side.name === 'request' && side.other.type === 'ServiceRequest');
    const roots = navigation ? graph.related(owner, object.ref, 'request', { remaining: 1000 }) : undefined;
    if (object.ref.type === 'ServiceRequest' && object.ref.id !== request.id || object.properties.requestRevision !== undefined && object.properties.requestRevision !== request.revision || navigation && (roots?.length !== 1 || roots[0]!.ref.id !== request.id)) throw new DomainError('FORBIDDEN', 'Prepared candidate references another task or revision');
    return;
  }
  for (const child of Object.values(value)) checkOwnedReferences(graph, owner, request, child);
}
/** Persist a public, typed preparation projection under the caller's existing
 * task transaction. No provider operation, model selection or private payload is accepted. */
export function projectPreparedResolution(graph: OntologyObjectStore, owner: string, request: ServiceRequest, resolution: PreparedResolution, capability?: ServiceCapability): void {
  if (resolution.candidates.length > 8) throw new DomainError('CONFLICT', 'Prepared candidate limit exceeded');
  const root = { type: 'ServiceRequest', id: request.id };
  if (graph.read(owner, root).properties.revision !== request.revision) throw new DomainError('CONFLICT', 'Preparation belongs to another request revision');
  const value = canonicalResolution(resolution);
  const contract: PreparedCapability | undefined = capability ? { ref: ref.parse(capability.ref), ontologyRef: ref.parse(capability.ontologyRef), verifierRef: ref.parse(capability.verifierRef),
    actions: capabilityActionsSchema.parse(capability.actions), ...(capability.completion ? { completion: capability.completion } : {}), ...(capability.environment ? { environment: capability.environment } : {}) } : undefined;
  if (contract && digest(contract.ref) !== digest(value.scope.capabilityRef)) throw new DomainError('CONFLICT', 'Prepared capability contract differs from its resolution');
  if (value.comparison && (value.comparison.requestId !== request.id || value.comparison.requestRevision !== request.revision)) throw new DomainError('FORBIDDEN', 'Prepared comparison belongs to another task');
  if (new Set(value.candidates.map(candidate => candidate.id)).size !== value.candidates.length) throw new DomainError('CONFLICT', 'Duplicate prepared candidate');
  for (const candidate of value.candidates) {
    if (digest(candidate.binding.capabilityRef) !== digest(value.scope.capabilityRef)) throw new DomainError('CONFLICT', 'Prepared candidate belongs to another capability');
    if (candidate.binding.discovery && (candidate.binding.discovery.requestId !== request.id || candidate.binding.discovery.requestRevision !== request.revision)) throw new DomainError('FORBIDDEN', 'Discovered candidate binding belongs to another task');
    checkOwnedReferences(graph, owner, request, candidate);
  }
  const resolutionDigest = digest(value), capabilityDefinitionDigest = contract ? digest(contract) : undefined;
  const resolutionRef = { type: 'ResolutionContext', id: digest({ requestId: request.id, requestRevision: request.revision, resolutionDigest, capabilityDefinitionDigest }) };
  const objects: ObjectWrite[] = [{ ref: resolutionRef, properties: { id: resolutionRef.id, name: 'Current prepared resolution', requestRevision: request.revision,
    ...value.scope, ...(value.comparison ? { comparison: value.comparison } : {}), candidateCount: value.candidates.length, resolutionDigest,
    ...(contract ? { capabilityActions: contract.actions, capabilityOntologyRef: contract.ontologyRef, capabilityVerifierRef: contract.verifierRef,
      ...(contract.completion ? { capabilityCompletion: contract.completion } : {}), ...(contract.environment ? { capabilityEnvironment: contract.environment } : {}), capabilityDefinitionDigest } : {}) } }];
  const links: LinkWrite[] = [{ type: 'ResolutionRequest', from: resolutionRef, to: root }, { type: 'CurrentPreparedResolution', from: root, to: resolutionRef }];
  for (const [sequence, candidate] of value.candidates.entries()) {
    const candidateRef = { type: 'PreparedCandidate', id: digest({ resolution: resolutionRef.id, candidateId: candidate.id }) }, { id: candidateId, ...fields } = candidate;
    objects.push({ ref: candidateRef, properties: { id: candidateRef.id, name: `Prepared ${candidate.status} candidate`, requestRevision: request.revision, candidateId, sequence, candidateDigest: digest(candidate), ...fields } });
    links.push({ type: 'CandidateRequest', from: candidateRef, to: root }, { type: 'CandidateResolution', from: candidateRef, to: resolutionRef });
    if (candidate.ontologySubject) links.push({ type: subjectRelationship(graph, candidate.ontologySubject).type, from: candidateRef, to: candidate.ontologySubject });
  }
  const upserts = objects.flatMap(object => {
    try {
      const old = graph.read(owner, object.ref);
      if (digest(old.properties) !== digest(object.properties)) throw new DomainError('CONFLICT', 'Prepared resolution snapshot changed');
      if (object.ref.type === 'PreparedCandidate') verifySubjectRelationship(graph, owner, object.ref, object.properties.ontologySubject as ResolvedCandidate['ontologySubject']);
      return [];
    } catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; return [object]; }
  });
  const removeLinks = (graph.related(owner, root, 'currentResolution', { remaining: 1000 }) ?? []).filter(old => old.ref.id !== resolutionRef.id).map(old => ({ type: 'CurrentPreparedResolution', from: root, to: old.ref }));
  graph.ingest(owner, { objects: upserts, links, removeLinks }, { kind: 'task', id: request.id, observedAt: request.messages.at(-1)!.receivedAt });
}
export function readPreparedResolution(graph: OntologyObjectStore, owner: string, requestId: string): PreparedResolution | undefined {
  const root = { type: 'ServiceRequest', id: requestId }, requestRevision = graph.read(owner, root).properties.revision;
  const contexts = graph.query(owner, { from: root, link: 'currentResolution', where: [{ property: 'requestRevision', op: 'eq', value: Number(requestRevision) }], limit: 50 });
  if (!contexts.items.length) return;
  if (contexts.page.hasMore || contexts.items.length !== 1) throw new DomainError('CONFLICT', 'Current prepared resolution is ambiguous');
  const context = contexts.items[0]!, p = context.properties, rows = graph.related(owner, context.ref, 'candidates', { remaining: 1000 });
  if (!rows || rows.length !== p.candidateCount) throw new DomainError('CONFLICT', 'Prepared candidate graph is incomplete');
  const candidates = rows.sort((a, b) => Number(a.properties.sequence) - Number(b.properties.sequence)).map((object, sequence) => {
    const fields = object.properties, { id: _id, name: _name, candidateId, requestRevision: revision, sequence: order, candidateDigest, ...body } = fields;
    const roots = graph.related(owner, object.ref, 'request', { remaining: 1000 });
    if (revision !== requestRevision || roots?.length !== 1 || roots[0]!.ref.id !== requestId) throw new DomainError('FORBIDDEN', 'Prepared candidate belongs to another task');
    if (order !== sequence) throw new DomainError('CONFLICT', 'Prepared candidate sequence is incomplete');
    const candidate = publicCandidate({ ...body, id: candidateId } as unknown as ResolvedCandidate);
    if (digest(candidate) !== candidateDigest) throw new DomainError('CONFLICT', 'Prepared candidate evidence changed');
    checkOwnedReferences(graph, owner, { id: requestId, revision: Number(requestRevision) }, candidate.ontologySubject);
    verifySubjectRelationship(graph, owner, object.ref, candidate.ontologySubject);
    return candidate;
  });
  const value = canonicalResolution({ candidates, scope: { capabilityRef: p.capabilityRef, searchedBindingRefs: p.searchedBindingRefs, observedAt: p.observedAt, realSupply: p.realSupply,
    ...(p.coverage ? { coverage: p.coverage } : {}) }, ...(p.comparison ? { comparison: p.comparison } : {}) } as PreparedResolution);
  if (digest(value) !== p.resolutionDigest || context.ref.id !== digest({ requestId, requestRevision, resolutionDigest: p.resolutionDigest, capabilityDefinitionDigest: p.capabilityDefinitionDigest })) throw new DomainError('CONFLICT', 'Prepared resolution evidence changed');
  return value;
}

export function readPreparedCapability(graph: OntologyObjectStore, owner: string, requestId: string): PreparedCapability | undefined {
  const request = { type: 'ServiceRequest', id: requestId }, revision = graph.read(owner, request).properties.revision;
  const contexts = graph.related(owner, request, 'currentResolution', { remaining: 1000 });
  if (!contexts?.length || contexts[0]!.properties.requestRevision !== revision) return;
  if (contexts.length !== 1) throw new DomainError('CONFLICT', 'Current prepared capability is ambiguous');
  const p = contexts[0]!.properties;
  if (!p.capabilityDefinitionDigest) return;
  const contract: PreparedCapability = { ref: ref.parse(p.capabilityRef), ontologyRef: ref.parse(p.capabilityOntologyRef), verifierRef: ref.parse(p.capabilityVerifierRef),
    actions: capabilityActionsSchema.parse(p.capabilityActions), ...(p.capabilityCompletion ? { completion: p.capabilityCompletion as ServiceCapability['completion'] } : {}),
    ...(p.capabilityEnvironment ? { environment: p.capabilityEnvironment as ServiceCapability['environment'] } : {}) };
  if (digest(contract) !== p.capabilityDefinitionDigest) throw new DomainError('CONFLICT', 'Prepared capability action definition changed');
  return contract;
}
