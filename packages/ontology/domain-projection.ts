import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { domainCommitmentsSchema, domainNames, domainObjects, domainBusinessLinksFor, domainEntityObservationType, domainEvidenceScopes, domainResultSchemas, parseDomainParameters, serviceDomain, type ServiceDomain } from './service-domains.js';
import { transportAssignmentSchema } from './domain-schemas.js';
import type { DomainResultResources } from './domain-detail-rules.js';
import { linkSnapshotDigest, type ObjectBatch, type ObjectWrite, type OntologyObjectStore } from './object-store.js';
import type { ObjectRef } from './model.js';

export const domainOptionSchema = z.object({ id: z.string().min(1).max(200), providerId: z.string().min(1).max(200), parametersDigest: z.string().regex(/^[a-f0-9]{64}$/), offeredParameters: z.record(z.string(), z.unknown()), commitments: domainCommitmentsSchema.optional(), deposit: z.object({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.enum(['CNY', 'USD', 'EUR']) }).strict().optional(), availability: z.enum(['available', 'unavailable', 'unknown']), eligibility: z.enum(['verified', 'ineligible', 'unknown']), observedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }), total: z.object({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.enum(['CNY', 'USD', 'EUR']) }).strict(), feesComplete: z.boolean(), commitmentBy: z.iso.datetime({ offset: true }).optional(), termsMatch: z.boolean() }).strict();
export const domainSourceEntitySchema = z.object({ type: z.string().min(1).max(80), id: z.string().min(1).max(200), title: z.string().min(1).max(500), properties: z.record(z.string(), z.unknown()), observedAt: z.iso.datetime({ offset: true }).optional() }).strict();
export const domainSourceRelationshipSchema = z.object({ type: z.string().min(1).max(80), fromId: z.string().min(1).max(200), toId: z.string().min(1).max(200) }).strict();
export const domainSnapshotSchema = z.object({ domain: z.enum(domainNames), environment: z.literal('sandbox'), requestId: z.string().min(1).max(200), requestRevision: z.number().int().positive(), parameters: z.record(z.string(), z.unknown()), option: domainOptionSchema, observation: z.record(z.string(), z.unknown()).optional(), sourceId: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200), sourceVersion: z.number().int().positive(), entities: z.array(domainSourceEntitySchema).max(40).default([]), relationships: z.array(domainSourceRelationshipSchema).max(60).default([]), resultEntities: z.array(domainSourceEntitySchema).max(40).optional(), resultRelationships: z.array(domainSourceRelationshipSchema).max(60).optional(), preparedSource: z.object({ eventId: z.string().min(1).max(200), version: z.number().int().positive() }).strict().optional() }).strict();
export type DomainSnapshot = z.infer<typeof domainSnapshotSchema>;
export const domainCapabilityId = (domain: ServiceDomain) => `service.${domain}.sandbox`;
export const domainEntityRef = (source: string, provider: string, type: string, nativeId: string): ObjectRef =>
  ({ type, id: digest({ namespace: 'domain_entity', source, provider, type, nativeId }) });
export function parseDomainResultResources(domain: ServiceDomain, observation: Record<string, unknown>, rawEntities: unknown, rawRelationships: unknown): DomainResultResources {
  const entities = z.array(domainSourceEntitySchema).max(40).parse(rawEntities ?? []), relationships = z.array(domainSourceRelationshipSchema).max(60).parse(rawRelationships ?? []), definition = serviceDomain(domain);
  if (new Set(entities.map(entity => `${entity.type}:${entity.id}`)).size !== entities.length) throw new Error('Result resource identities must be unique');
  for (const entity of entities) {
    if (!definition.resultObjects.includes(entity.type) || entity.properties.sourceId !== entity.id) throw new Error('Result resource is outside the domain/source identity contract');
    const object = domainObjects.find(object => object.id === entity.type)!;
    const shape = Object.fromEntries(Object.entries(object.properties).filter(([name]) => !['objectId', 'displayTitle'].includes(name)).map(([name, field]) => [name, field.schema.optional()]));
    z.object(shape).strict().parse(entity.properties);
    z.string().min(1).max(500).parse(entity.properties.sourceRevision);
    if (entity.type === 'TransportAssignment') {
      transportAssignmentSchema.parse(Object.fromEntries(Object.keys(transportAssignmentSchema.shape).filter(name => entity.properties[name] !== undefined).map(name => [name, entity.properties[name]])));
      if (entity.properties.providerReference !== observation.providerReference || entity.id !== observation.assignmentId) throw new Error('An assignment must be the named assignment of the observed business operation');
    }
    if (entity.type === 'VehicleInspection' && (entity.properties.providerReference !== observation.providerReference || entity.id !== observation[`${entity.properties.stage}InspectionId`])) throw new Error('An inspection must be the named handover inspection of the observed rental');
  }
  for (const relation of relationships) {
    const type = domainBusinessLinksFor(domain).find(type => type.id === relation.type);
    const from = type && entities.find(entity => entity.type === type.from && entity.id === relation.fromId);
    if (!type || !from || !entities.some(entity => entity.type === type.to && entity.id === relation.toId) || type.identityProperty && from.properties[type.identityProperty] !== relation.toId) throw new Error('Result relationship contradicts its typed source identities');
  }
  return { entities, relationships };
}
export function publicDomainEntities(entities: DomainSnapshot['entities']): DomainSnapshot['entities'] {
  return entities.map(e => {
    const definition = domainObjects.find(d => d.id === e.type);
    return { ...e, properties: Object.fromEntries(Object.entries(e.properties).filter(([name]) => definition?.properties[name] && !definition.properties[name]!.restricted)) };
  });
}

/** Called only after the active task checkpoint and adapter validation, never by a public import tool. */
export function projectDomainSnapshot(graph: OntologyObjectStore, owner: string, capabilityId: string, request: { id: string; revision: number }, input: Record<string, unknown>, raw: unknown): { state: 'typed_result' | 'invalid_source'; subject?: ObjectRef } {
  const parsed = domainSnapshotSchema.safeParse(raw);
  if (!parsed.success) return { state: 'invalid_source' };
  const snapshot = parsed.data, definition = serviceDomain(snapshot.domain);
  if (capabilityId !== domainCapabilityId(snapshot.domain) || snapshot.requestId !== request.id || snapshot.requestRevision !== request.revision) return { state: 'invalid_source' };
  try {
    const parameters = parseDomainParameters(snapshot.domain, snapshot.parameters), requested = parseDomainParameters(snapshot.domain, input);
    if (digest(parameters) !== digest(requested) || snapshot.option.parametersDigest !== digest(parameters) || digest(parseDomainParameters(snapshot.domain, snapshot.option.offeredParameters)) !== digest(parameters)) return { state: 'invalid_source' };
    if (!snapshot.observation && (snapshot.resultEntities?.length || snapshot.resultRelationships?.length || snapshot.preparedSource)) return { state: 'invalid_source' };
    if (snapshot.observation) parseDomainResultResources(snapshot.domain, snapshot.observation, snapshot.resultEntities, snapshot.resultRelationships);
    const root = graph.read(owner, { type: 'ServiceRequest', id: request.id });
    if (root.properties.revision !== request.revision) return { state: 'invalid_source' };
    const objects: ObjectWrite[] = [], links: NonNullable<ObjectBatch['links']> = [], removeLinks: NonNullable<ObjectBatch['links']> = [];
    const properties = new Map<string, Record<string, unknown>>();
    const add = (type: string, id: string, title: string, values: Record<string, unknown>, immutable = false): ObjectRef => {
      const ref = { type, id }, def = graph.model.object(type), body = { [def.primaryKey]: id, displayTitle: title, ...values };
      const staged = properties.get(JSON.stringify(ref));
      if (staged) {
        if (digest(staged) !== digest(body)) throw new DomainError('INVALID_INPUT', 'One source snapshot cannot contain conflicting versions of one entity');
        return ref;
      }
      let old;
      try { old = graph.readPrivate(owner, ref); } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      if (old && immutable && digest(old.properties) !== digest(body)) throw new DomainError('INVALID_INPUT', 'An immutable source observation changed');
      properties.set(JSON.stringify(ref), body);
      if (!old || digest(old.properties) !== digest(body)) objects.push({ ref, properties: body, ...(old ? { expectedRevision: old.revision } : {}) });
      return ref;
    };
    const connect = (type: string, from: ObjectRef, to: ObjectRef) => links.push({ type, from, to });
    const requirement = add(definition.requestType, `${request.id}:r${request.revision}:${snapshot.domain}`, `${definition.name}固定要求`, { ...parameters, requestRevision: request.revision, capturedAt: root.createdAt });
    connect(`${definition.requestType}Request`, requirement, root.ref);
    const provider = add('Provider', `domain:${digest({ source: snapshot.sourceId, provider: snapshot.option.providerId })}`, '合成领域来源', { name: '合成领域来源' });
    const engagement = add('ServiceEngagement', digest({ request: request.id, domain: snapshot.domain, source: snapshot.sourceId, provider: snapshot.option.providerId }), `${definition.name}来源沟通`, { progress: snapshot.observation ? 'returned' : 'waiting', startedAt: snapshot.option.observedAt, ...(snapshot.observation?.providerReference ? { remoteReference: snapshot.observation.providerReference } : {}) });
    connect('EngagementRequest', engagement, root.ref); connect('EngagementProvider', engagement, provider);
    const { id: _optionId, providerId: _providerId, ...optionValues } = snapshot.option;
    const optionIdentity = { request: request.id, requestRevision: request.revision, source: snapshot.sourceId, provider: snapshot.option.providerId,
      nativeId: snapshot.option.id, sourceEventId: snapshot.preparedSource?.eventId ?? snapshot.sourceEventId, sourceVersion: snapshot.preparedSource?.version ?? snapshot.sourceVersion, option: snapshot.option, entities: publicDomainEntities(snapshot.entities), relationships: snapshot.relationships };
    const option = add(definition.candidateType, digest(optionIdentity), `${definition.name}合成候选`, { ...optionValues, requestRevision: request.revision }, true);
    for (const target of [option]) { connect(`${target.type}Request`, target, root.ref); connect(`${target.type}Requirements`, target, requirement); connect(`${target.type}Provider`, target, provider); }
    const sealed: { ref: ObjectRef; time: string; event: string }[] = [{ ref: option, time: snapshot.option.observedAt, event: snapshot.option.id }];
    let subject = option;
    if (snapshot.observation) {
      const observation = domainResultSchemas[snapshot.domain].parse(snapshot.observation);
      if (observation.requestDigest !== digest(parameters)) return { state: 'invalid_source' };
      const resultId = digest({ request: request.id, requestRevision: request.revision, source: snapshot.sourceId, provider: snapshot.option.providerId, reference: observation.providerReference });
      const values = { ...observation, requestRevision: request.revision, sourceVersion: snapshot.sourceVersion };
      try {
        const old = graph.read(owner, { type: definition.resultType, id: resultId });
        const { objectId: _id, displayTitle: _title, ...oldValues } = old.properties;
        if (Number(oldValues.sourceVersion) > snapshot.sourceVersion || Number(oldValues.sourceVersion) === snapshot.sourceVersion && digest(oldValues) !== digest(values)) return { state: 'invalid_source' };
      } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      subject = add(definition.resultType, resultId, `${definition.name}合成结果`, values);
      try {
        for (const previous of graph.related(owner, subject, 'selectedOption', { remaining: 1000 }) ?? []) {
          if (previous.ref.id !== option.id) removeLinks.push({ type: `${subject.type}Option`, from: subject, to: previous.ref });
        }
      } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      connect(`${subject.type}Request`, subject, root.ref); connect(`${subject.type}Requirements`, subject, requirement); connect(`${subject.type}Provider`, subject, provider); connect(`${subject.type}Option`, subject, option);
      sealed.push({ ref: subject, time: observation.observedAt, event: snapshot.sourceEventId });
    }
    if (new Set(snapshot.entities.map(e => `${e.type}:${e.id}`)).size !== snapshot.entities.length) return { state: 'invalid_source' };
    const observationRefs = new Map<string, ObjectRef>();
    const reusedPreparedEntities = new Set<string>();
    const sourcedEntities = [...snapshot.entities.map(entity => ({ entity, result: false })), ...(snapshot.resultEntities ?? []).map(entity => ({ entity, result: true }))];
    for (const { entity, result } of sourcedEntities) {
      if (!(result ? definition.resultObjects : definition.objects).includes(entity.type)) return { state: 'invalid_source' };
      const sourceRevision = z.string().min(1).max(500).parse(entity.properties.sourceRevision);
      if (entity.properties.sourceId !== entity.id) return { state: 'invalid_source' };
      const ref = domainEntityRef(snapshot.sourceId, snapshot.option.providerId, entity.type, entity.id);
      const entityDefinition = graph.model.object(entity.type);
      let oldEntity;
      try { oldEntity = graph.readPrivate(owner, ref); } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      const incoming = { ...entity.properties };
      // A public readback of the same source revision deliberately omits private
      // fields. Retain those exact already-verified fields rather than treating
      // redaction as a changed identity. Never fill absent public facts or carry
      // private values across a different source revision.
      if (oldEntity?.properties.sourceRevision === sourceRevision) for (const [name, property] of Object.entries(entityDefinition.properties)) {
        if (property.restricted && !Object.hasOwn(incoming, name) && Object.hasOwn(oldEntity.properties, name)) incoming[name] = oldEntity.properties[name];
      }
      const values = graph.model.parseProperties(entity.type, { [entityDefinition.primaryKey]: ref.id, displayTitle: entity.title, ...incoming });
      const publicValues = Object.fromEntries(Object.entries(values).filter(([name]) => !entityDefinition.properties[name]?.restricted));
      const observedAt = z.iso.datetime({ offset: true }).parse(entity.observedAt ?? entity.properties.observedAt ?? (result ? snapshot.observation!.observedAt : snapshot.option.observedAt));
      if (Date.parse(observedAt) > graph.now()) return { state: 'invalid_source' };
      const contentDigest = digest(values);
      const attach = (observationRef: ObjectRef) => {
        const target = result ? subject : option;
        connect(`${target.type}${entity.type}`, target, ref);
        connect(`${target.type}${domainEntityObservationType(entity.type)}`, target, observationRef);
        if (result) observationRefs.set(`${entity.type}:${entity.id}`, observationRef);
      };
      // An independent result may arrive after the stable resource was updated.
      // Reuse the original immutable preflight observation instead of replaying
      // stale candidate facts into the current entity or changing the candidate.
      if (!result && snapshot.observation && snapshot.preparedSource && oldEntity) {
        const oldObservations = graph.related(owner, ref, 'sourceObservations', { remaining: 1000 }) ?? [];
        const exact = oldObservations.find(old => old.properties.sourceIdentity === snapshot.sourceId && old.properties.providerIdentity === snapshot.option.providerId && old.properties.sourceRevision === sourceRevision && old.properties.sourceVersion === snapshot.preparedSource!.version && old.properties.sourceEventId === snapshot.preparedSource!.eventId && old.properties.observedAt === observedAt && old.properties.valuesDigest === digest(publicValues) && digest(old.properties.snapshot) === digest(publicValues));
        const privateFieldsPresent = Object.entries(entityDefinition.properties).some(([name, property]) => property.restricted && Object.hasOwn(entity.properties, name));
        if (exact && (!privateFieldsPresent || exact.properties.contentDigest === contentDigest)) { attach(exact.ref); reusedPreparedEntities.add(`${entity.type}:${entity.id}`); continue; }
      }
      if (oldEntity) {
        const current = graph.related(owner, ref, 'currentObservation', { remaining: 1000 });
        if (current?.length !== 1) return { state: 'invalid_source' };
        const old = current[0]!.properties, previousRevision = String(old.sourceRevision);
        if (old.contentDigest !== digest(oldEntity.properties) || Number(old.sourceVersion) > snapshot.sourceVersion
          || Date.parse(String(old.observedAt)) > Date.parse(observedAt)
          || sourceRevision === previousRevision && old.contentDigest !== contentDigest
          || /^\d+$/.test(sourceRevision) && /^\d+$/.test(previousRevision) && BigInt(sourceRevision) < BigInt(previousRevision)
          || sourceRevision !== previousRevision && !(/^\d+$/.test(sourceRevision) && /^\d+$/.test(previousRevision))
            && snapshot.sourceVersion <= Number(old.sourceVersion) && Date.parse(observedAt) <= Date.parse(String(old.observedAt))) return { state: 'invalid_source' };
      }
      add(entity.type, ref.id, entity.title, incoming);
      const observationType = domainEntityObservationType(entity.type);
      const version = result ? snapshot.sourceVersion : snapshot.preparedSource?.version ?? snapshot.sourceVersion, event = result ? snapshot.sourceEventId : snapshot.preparedSource?.eventId ?? snapshot.sourceEventId;
      const observationRef = add(observationType, digest({ entity: ref, sourceRevision, sourceVersion: version, sourceEventId: event, observedAt, contentDigest }), `${entity.title}来源观察`, {
        sourceIdentity: snapshot.sourceId, providerIdentity: snapshot.option.providerId, nativeIdentity: entity.id,
        sourceRevision, sourceVersion: version, sourceEventId: event, observedAt, contentDigest,
        valuesDigest: digest(publicValues), snapshot: publicValues,
      }, true);
      // Stable resources remain separate from the immutable observation selected
      // by this candidate. User requirement links are never rewritten by a source.
      attach(observationRef);
      connect(`${observationType}Entity`, observationRef, ref); connect(`${observationType}Provider`, observationRef, provider);
      try {
        for (const old of graph.related(owner, ref, 'currentObservation', { remaining: 1000 }) ?? []) {
          if (old.ref.id !== observationRef.id) removeLinks.push({ type: `${entity.type}CurrentObservation`, from: ref, to: old.ref });
        }
      } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      connect(`${entity.type}CurrentObservation`, ref, observationRef);
      sealed.push({ ref, time: observedAt, event: snapshot.sourceEventId }, { ref: observationRef, time: observedAt, event: snapshot.sourceEventId });
    }
    for (const { relationship, result } of [...snapshot.relationships.map(relationship => ({ relationship, result: false })), ...(snapshot.resultRelationships ?? []).map(relationship => ({ relationship, result: true }))]) {
      const entities = result ? snapshot.resultEntities ?? [] : snapshot.entities;
      const relation = domainBusinessLinksFor(snapshot.domain).find(r => r.id === relationship.type);
      if (!relation || !entities.some(e => e.type === relation.from && e.id === relationship.fromId) || !entities.some(e => e.type === relation.to && e.id === relationship.toId)) return { state: 'invalid_source' };
      const identityProperty: Record<string, string> = { DepartmentHospital: 'hospitalId', PractitionerDepartment: 'departmentId', AppointmentSlotPractitioner: 'practitionerId', MenuItemMerchant: 'merchantId', RoomTypeHotel: 'hotelId', RoomInventoryType: 'roomTypeId', RentalPolicyClass: 'vehicleClassId' };
      const property = relation.identityProperty ?? identityProperty[relation.id], sourceEntity = entities.find(e => e.type === relation.from && e.id === relationship.fromId)!;
      if (property && sourceEntity.properties[property] !== undefined && sourceEntity.properties[property] !== relationship.toId) return { state: 'invalid_source' };
      if (!result && reusedPreparedEntities.has(`${relation.from}:${relationship.fromId}`)) continue;
      const from = domainEntityRef(snapshot.sourceId, snapshot.option.providerId, relation.from, relationship.fromId);
      const to = domainEntityRef(snapshot.sourceId, snapshot.option.providerId, relation.to, relationship.toId);
      try {
        for (const old of graph.related(owner, from, relation.name, { remaining: 1000 }) ?? []) {
          if (old.ref.id !== to.id) removeLinks.push({ type: relation.id, from, to: old.ref });
        }
      } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      connect(relation.id, from, to);
      if (result && ['TransportAssignment', 'VehicleInspection'].includes(relation.from)) {
        const observationRef = observationRefs.get(`${relation.from}:${relationship.fromId}`);
        if (!observationRef) return { state: 'invalid_source' };
        connect(`${relation.id}Observation`, observationRef, to);
      }
    }
    if (snapshot.observation) for (const type of definition.resultObjects) for (const targetType of [type, domainEntityObservationType(type)]) {
      const relationId = `${definition.resultType}${targetType}`, relationName = targetType.endsWith('Observation') ? `${type[0]!.toLowerCase()}${type.slice(1)}Observations` : `${type[0]!.toLowerCase()}${type.slice(1)}`;
      try {
        for (const previous of graph.related(owner, subject, relationName, { remaining: 1000 }) ?? []) {
          if (!links.some(relation => relation.type === relationId && relation.from.id === subject.id && relation.to.type === previous.ref.type && relation.to.id === previous.ref.id)) removeLinks.push({ type: relationId, from: subject, to: previous.ref });
        }
      } catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
    }
    for (const entity of sealed) {
      const storedValues = properties.get(JSON.stringify(entity.ref))!, objectDefinition = graph.model.object(entity.ref.type);
      const values = Object.fromEntries(Object.entries(storedValues).filter(([name]) => !objectDefinition.properties[name]?.restricted));
      const linksDigest = linkSnapshotDigest(entity.ref, links);
      const requestScoped = entity.ref.type === definition.candidateType || entity.ref.type === definition.resultType;
      // Provider resources and their immutable observations may be reused by
      // several owned tasks. Their proof belongs to the source observation,
      // while an option/result receipt belongs to one exact request revision.
      // Never attach a shared receipt to the first task that happened to read it.
      const receiptId = digest({ object: entity.ref, values, linksDigest, source: snapshot.sourceId,
        usage: requestScoped ? { requestId: request.id, requestRevision: request.revision } : 'shared_source_observation' });
      const receipt = add('SourceReceipt', receiptId, '合成领域来源回执', { sourceIdentity: snapshot.sourceId, sourceEventId: entity.event, scope: domainEvidenceScopes[entity.ref.type], observedAt: entity.time, evidenceLevel: 'synthetic', contentDigest: digest(values), subjects: [{ object: entity.ref, digest: digest(values), linksDigest }], safeSummary: `${definition.name}合成记录；没有真实业务操作` });
      try {
        for (const old of graph.related(owner, entity.ref, 'sourceReceipts', { remaining: 1000 }) ?? []) if (old.ref.id !== receipt.id) removeLinks.push({ type: `${entity.ref.type}Evidence`, from: entity.ref, to: old.ref });
      } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      connect(`${entity.ref.type}Evidence`, entity.ref, receipt);
      if (requestScoped) connect('ReceiptRequest', receipt, root.ref);
    }
    graph.ingest(owner, { objects, links, removeLinks }, { kind: 'synthetic', id: snapshot.sourceId, observedAt: snapshot.option.observedAt });
    return { state: 'typed_result', subject };
  } catch (e) {
    if (e instanceof DomainError && e.code !== 'INVALID_INPUT') throw e;
    return { state: 'invalid_source' };
  }
}
