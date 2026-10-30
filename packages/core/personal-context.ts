import { digest } from './delegation.js';
import { DomainError } from './domain.js';
import type { ConfirmedInput, ServiceRequest } from '../ontology/execution.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import { personalContextInputSchema, mergePersonalContext, personalResourceRoles, personalPreferenceValue, personalPreferenceRef, selfPersonRef, type PersonalContextInput } from '../ontology/personal-context.js';
import { objectRefSchema } from '../ontology/model.js';

/** Defaults have their own provenance, never synthetic owner messages. Explicit
 * null is a deliberate clearing operation and suppresses default selection. */
export function selectPersonalContext(graph: OntologyObjectStore, owner: string, request: ServiceRequest, value: PersonalContextInput): void {
  const input = mergePersonalContext(personalContextInputSchema.parse(value), request.personalContext), person = graph.read(owner, selfPersonRef(owner));
  if (person.properties.identityBasis !== 'self_asserted') throw new DomainError('FORBIDDEN', 'Explicit self binding is required');
  const message = (request.revision === 1 ? request.messages[0] : request.messages.at(-1))!, source = { messageId: message.id, messageIndex: request.messages.length - 1, receivedAt: message.receivedAt };
  const previous = request.confirmedInputs?.personal, fields: Record<string, ConfirmedInput> = {};
  let revision = previous?.revision ?? 0;
  const add = (field: string, status: ConfirmedInput['status'], value: unknown, basis?: ConfirmedInput['personalBasis']) => {
    const old = previous?.fields[field];
    if (old && old.status === status && digest({ value: old.value, basis: old.personalBasis }) === digest({ value, basis })) { fields[field] = structuredClone(old); return; }
    fields[field] = { field, status, ...(value !== undefined ? { value } : {}), quote: message.text, source, revision: ++revision, ...(basis ? { personalBasis: basis } : {}) };
  };
  add('subject', 'confirmed', person.ref);
  for (const key of new Set([...input.preferences, ...(input.paDefaults ?? []).map(fact => fact.value.kind), ...Object.keys(input.overrides ?? {})] as ('rideClass' | 'deliveryAddress')[])) {
    if (Object.hasOwn(input.overrides ?? {}, key)) {
      const explicit = input.overrides![key];
      if (explicit && typeof explicit === 'object') graph.read(owner, objectRefSchema.parse(explicit));
      add(key, explicit === null ? 'cleared' : 'confirmed', explicit === null ? undefined : explicit); continue;
    }
    const candidates: { value: unknown; source: NonNullable<ConfirmedInput['personalBasis']>['sources'][number] }[] = [];
    if (input.preferences.includes(key)) {
      let fact;
      try { fact = graph.read(owner, personalPreferenceRef(owner, key)); }
      catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
      if (fact?.properties.status === 'active') {
        if (fact.properties.personId !== person.ref.id || fact.properties.key !== key || fact.properties.authority !== 'eigos') throw new DomainError('FORBIDDEN', 'Personal fact source does not match its subject');
        const content = personalPreferenceValue.parse(fact.properties.value);
        if (content.kind !== key) throw new DomainError('CONFLICT', 'Personal fact semantics changed');
        if (content.kind === 'deliveryAddress') graph.read(owner, content.address);
        candidates.push({ value: content.kind === 'rideClass' ? content.value : content.address, source: { object: { ...fact.ref, type: 'PersonalPreference' }, revision: fact.revision, authority: 'eigos' } });
      }
    }
    const pa = input.paDefaults?.find(fact => fact.value.kind === key);
    if (pa) {
      if (Date.parse(pa.observedAt) > Date.parse(source.receivedAt)) throw new DomainError('INVALID_INPUT', 'Personal source observation is later than the received task input');
      if (pa.value.kind === 'deliveryAddress') graph.read(owner, pa.value.address);
      candidates.push({ value: pa.value.kind === 'rideClass' ? pa.value.value : pa.value.address, source: { authority: 'pa', reference: pa.sourceReference, version: pa.sourceVersion, observedAt: pa.observedAt, confirmation: 'reported_by_authenticated_pa' } });
    }
    if (candidates.length) {
      const conflict = new Set(candidates.map(candidate => digest(candidate.value))).size > 1;
      add(key, conflict ? 'ambiguous' : 'confirmed', conflict ? { candidates } : candidates[0]!.value, { selection: 'confirmed_default', sources: candidates.map(candidate => candidate.source) });
    }

  }
  for (const [index, resource] of input.resources.entries()) {
    const read = graph.query(owner, { object: resource.object, select: resource.fields }).items[0];
    if (!read || read.revision !== resource.revision || !graph.model.implements(resource.object.type, personalResourceRoles[resource.role].target)) throw new DomainError('CONFLICT', 'Personal business reference changed or is not a business entity');
    add(`resource${index}`, 'confirmed', { ...resource });
  }
  if (previous && digest(previous.fields) !== digest(fields) && revision === previous.revision) revision++;
  request.personalContext = input;
  request.confirmedInputs = { ...request.confirmedInputs, personal: { version: '1', revision,
    messageDigest: digest({ selection: input, fields }), fields, history: previous ? [...previous.history, ...Object.values(previous.fields).filter(old => !fields[old.field] || digest(fields[old.field]) !== digest(old))] : [] } };
}

/** Current execution checks are deliberately separate from retained history. */
export function assertPersonalFactsCurrent(graph: OntologyObjectStore, owner: string, request: ServiceRequest): void {
  for (const fact of Object.values(request.confirmedInputs?.personal?.fields ?? {})) {
    const basis = fact.personalBasis;
    for (const source of basis?.sources ?? []) if (source.authority === 'eigos') {
      const current = graph.read(owner, source.object);
      if (current.revision !== source.revision || current.properties.status !== 'active') throw new DomainError('CONFLICT', 'A selected personal default changed; reselect only the affected personal context');
    }
    if (fact.field.startsWith('resource') && fact.value) {
      const resource = fact.value as NonNullable<PersonalContextInput['resources']>[number];
      if (graph.read(owner, resource.object).revision !== resource.revision) throw new DomainError('CONFLICT', 'A selected personal arrangement changed');
    }
  }
}
