import { z } from 'zod';
import { objectRefSchema, type ActionDefinition } from './model.js';
import { serviceDomain, serviceDomains, type ServiceDomain } from './service-domains.js';

export function domainAtomicMetadata(id: ServiceDomain) {
  const domain = serviceDomain(id);
  return {
    read: `Read${domain.candidateType}`, execute: `Execute${domain.action}`,
    readSchema: z.strictObject({ scope: objectRefSchema.extend({ type: z.literal(domain.requestType) }) }),
    executeSchema: z.strictObject({ scope: objectRefSchema.extend({ type: z.literal(domain.requestType) }), option: objectRefSchema.extend({ type: z.literal(domain.candidateType) }) }),
  };
}

export const domainAtomicActions: ActionDefinition[] = serviceDomains.flatMap((domain): ActionDefinition[] => {
  const metadata = domainAtomicMetadata(domain.id);
  return [
    { id: metadata.read, version: '1', kind: 'source_read', description: `Read one configured ${domain.name} provider's current eligibility, complete quote and exact offered terms. No reservation, order or payment.`,
      inputs: { scope: domain.requestType }, resultTypes: [domain.candidateType], effects: ['read'], changes: [domain.candidateType, 'SourceReceipt', ...domain.objects], submissionCriteria: ['same_owner', 'current_request_revision'],
      read: { version: '1', effect: 'read', inputSchema: z.toJSONSchema(metadata.readSchema), resultType: domain.candidateType } },
    { id: metadata.execute, version: '1', kind: 'business', description: `Submit exactly one original ${domain.name} operation for an accepted, evaluated option. Pending results retain their original operation key; recovery only queries that key. ${domain.endpoint}. Isolated synthetic provider only.`,
      inputs: { scope: domain.requestType, option: domain.candidateType }, resultTypes: [domain.resultType], effects: [domain.effect], changes: [domain.resultType, 'SourceReceipt', ...domain.resultObjects],
      submissionCriteria: ['same_owner', 'current_request_revision', 'eligible_option', 'within_authority'],
      operation: { version: '1', effect: domain.effect, environment: 'sandbox', inputSchema: z.toJSONSchema(metadata.executeSchema), resultType: domain.resultType } },
  ];
});

/** A private, original preparation receipt. Public domain objects remain typed;
 * this record binds the adapter's exact accepted source payload retained in the private intent ledger. */
export const domainPreparedReceiptSchema = z.strictObject({
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/), scope: objectRefSchema,
  planId: z.uuid(), intentId: z.uuid(), attemptId: z.uuid(),
  preparationDigest: z.string().regex(/^[a-f0-9]{64}$/), evidenceRefs: z.array(z.string()).min(1),
  observedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }),
});
