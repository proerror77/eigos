import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { domainNames, domainObjects, domainBusinessLinks, domainResultSchemas, parseDomainParameters, serviceDomain, type ServiceDomain } from './service-domains.js';
import { linkSnapshotDigest, type ObjectBatch, type ObjectWrite, type OntologyObjectStore } from './object-store.js';
import type { ObjectRef } from './model.js';

export const domainOptionSchema = z.object({ id: z.string().min(1).max(200), providerId: z.string().min(1).max(200), parametersDigest: z.string().regex(/^[a-f0-9]{64}$/), offeredParameters: z.record(z.string(), z.unknown()), availability: z.enum(['available', 'unavailable', 'unknown']), eligibility: z.enum(['verified', 'ineligible', 'unknown']), observedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }), total: z.object({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.enum(['CNY', 'USD', 'EUR']) }).strict(), feesComplete: z.boolean(), commitmentBy: z.iso.datetime({ offset: true }).optional(), termsMatch: z.boolean() }).strict();
export const domainSnapshotSchema = z.object({ domain: z.enum(domainNames), environment: z.literal('sandbox'), requestId: z.string().min(1).max(200), requestRevision: z.number().int().positive(), parameters: z.record(z.string(), z.unknown()), option: domainOptionSchema, observation: z.record(z.string(), z.unknown()).optional(), sourceId: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200), sourceVersion: z.number().int().positive(), entities: z.array(z.object({ type: z.string().min(1).max(80), id: z.string().min(1).max(200), title: z.string().min(1).max(500), properties: z.record(z.string(), z.unknown()) }).strict()).max(40).default([]), relationships: z.array(z.object({ type: z.string().min(1).max(80), fromId: z.string().min(1).max(200), toId: z.string().min(1).max(200) }).strict()).max(60).default([]) }).strict();
export type DomainSnapshot = z.infer<typeof domainSnapshotSchema>;
export const domainCapabilityId = (domain: ServiceDomain) => `service.${domain}.sandbox`;
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
    const root = graph.read(owner, { type: 'ServiceRequest', id: request.id });
    if (root.properties.revision !== request.revision) return { state: 'invalid_source' };
    const objects: ObjectWrite[] = [], links: NonNullable<ObjectBatch['links']> = [], removeLinks: NonNullable<ObjectBatch['links']> = [];
    const properties = new Map<string, Record<string, unknown>>();
    const add = (type: string, id: string, title: string, values: Record<string, unknown>): ObjectRef => {
      const ref = { type, id }, def = graph.model.object(type), body = { [def.primaryKey]: id, displayTitle: title, ...values };
      let old;
      try { old = graph.read(owner, ref); } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      properties.set(JSON.stringify(ref), body);
      if (!old || digest(old.properties) !== digest(body)) objects.push({ ref, properties: body, ...(old ? { expectedRevision: old.revision } : {}) });
      return ref;
    };
    const connect = (type: string, from: ObjectRef, to: ObjectRef) => links.push({ type, from, to });
    const requirement = add(definition.requestType, `${request.id}:r${request.revision}:${snapshot.domain}`, `${definition.name}固定要求`, { ...parameters, requestRevision: request.revision, capturedAt: snapshot.option.observedAt });
    connect(`${definition.requestType}Request`, requirement, root.ref);
    const provider = add('Provider', `domain:${snapshot.sourceId}:${snapshot.option.providerId}`, '合成领域来源', { name: '合成领域来源' });
    const engagement = add('ServiceEngagement', `${request.id}:${snapshot.domain}:${snapshot.sourceId}`, `${definition.name}来源沟通`, { progress: snapshot.observation ? 'returned' : 'waiting', startedAt: snapshot.option.observedAt, ...(snapshot.observation?.providerReference ? { remoteReference: snapshot.observation.providerReference } : {}) });
    connect('EngagementRequest', engagement, root.ref); connect('EngagementProvider', engagement, provider);
    const { id: _optionId, providerId: _providerId, ...optionValues } = snapshot.option;
    const option = add(definition.candidateType, `${request.id}:${snapshot.option.id}`, `${definition.name}合成候选`, { ...optionValues, requestRevision: request.revision });
    for (const target of [option]) { connect(`${target.type}Request`, target, root.ref); connect(`${target.type}Requirements`, target, requirement); connect(`${target.type}Provider`, target, provider); }
    const sealed: { ref: ObjectRef; time: string; event: string }[] = [{ ref: option, time: snapshot.option.observedAt, event: snapshot.option.id }];
    let subject = option;
    if (snapshot.observation) {
      const observation = domainResultSchemas[snapshot.domain].parse(snapshot.observation);
      if (observation.requestDigest !== digest(parameters)) return { state: 'invalid_source' };
      const resultId = `${request.id}:${digest({ source: snapshot.sourceId, reference: observation.providerReference })}`;
      const values = { ...observation, requestRevision: request.revision, sourceVersion: snapshot.sourceVersion };
      try {
        const old = graph.read(owner, { type: definition.resultType, id: resultId });
        const { objectId: _id, displayTitle: _title, ...oldValues } = old.properties;
        if (Number(oldValues.sourceVersion) > snapshot.sourceVersion || Number(oldValues.sourceVersion) === snapshot.sourceVersion && digest(oldValues) !== digest(values)) return { state: 'invalid_source' };
      } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      subject = add(definition.resultType, resultId, `${definition.name}合成结果`, values);
      connect(`${subject.type}Request`, subject, root.ref); connect(`${subject.type}Requirements`, subject, requirement); connect(`${subject.type}Provider`, subject, provider); connect(`${subject.type}Option`, subject, option);
      sealed.push({ ref: subject, time: observation.observedAt, event: snapshot.sourceEventId });
    }
    if (new Set(snapshot.entities.map(e => `${e.type}:${e.id}`)).size !== snapshot.entities.length) return { state: 'invalid_source' };
    for (const entity of snapshot.entities) {
      if (!definition.objects.includes(entity.type)) return { state: 'invalid_source' };
      const ref = add(entity.type, `${snapshot.sourceId}:${entity.id}`, entity.title, entity.properties);
      connect(`${definition.requestType}${entity.type}`, requirement, ref);
    }
    for (const relationship of snapshot.relationships) {
      const relation = domainBusinessLinks.find(r => r.id === relationship.type && r.domain === snapshot.domain);
      if (!relation || !snapshot.entities.some(e => e.type === relation.from && e.id === relationship.fromId) || !snapshot.entities.some(e => e.type === relation.to && e.id === relationship.toId)) return { state: 'invalid_source' };
      const identityProperty: Record<string, string> = { DepartmentHospital: 'hospitalId', PractitionerDepartment: 'departmentId', AppointmentSlotPractitioner: 'practitionerId' };
      const property = identityProperty[relation.id], sourceEntity = snapshot.entities.find(e => e.type === relation.from && e.id === relationship.fromId)!;
      if (property && sourceEntity.properties[property] !== undefined && sourceEntity.properties[property] !== relationship.toId) return { state: 'invalid_source' };
      connect(relation.id, { type: relation.from, id: `${snapshot.sourceId}:${relationship.fromId}` }, { type: relation.to, id: `${snapshot.sourceId}:${relationship.toId}` });
    }
    for (const entity of sealed) {
      const values = properties.get(JSON.stringify(entity.ref))!;
      const linksDigest = linkSnapshotDigest(entity.ref, links);
      const receiptId = digest({ object: entity.ref, values, linksDigest, source: snapshot.sourceId });
      const receipt = add('SourceReceipt', receiptId, '合成领域来源回执', { sourceIdentity: snapshot.sourceId, sourceEventId: entity.event, scope: `domain_${snapshot.domain}`, observedAt: entity.time, evidenceLevel: 'synthetic', contentDigest: digest(values), subjects: [{ object: entity.ref, digest: digest(values), linksDigest }], safeSummary: `${definition.name}合成记录；没有真实业务操作` });
      try {
        for (const old of graph.related(owner, entity.ref, 'sourceReceipts', { remaining: 1000 }) ?? []) if (old.ref.id !== receipt.id) removeLinks.push({ type: `${entity.ref.type}Evidence`, from: entity.ref, to: old.ref });
      } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      connect(`${entity.ref.type}Evidence`, entity.ref, receipt); connect('ReceiptRequest', receipt, root.ref);
    }
    graph.ingest(owner, { objects, links, removeLinks }, { kind: 'synthetic', id: snapshot.sourceId, observedAt: snapshot.option.observedAt });
    return { state: 'typed_result', subject };
  } catch (e) {
    if (e instanceof DomainError && e.code !== 'INVALID_INPUT') throw e;
    return { state: 'invalid_source' };
  }
}
