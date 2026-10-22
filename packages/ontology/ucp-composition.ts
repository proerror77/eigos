import { z } from 'zod';
import { moneySchema } from './execution.js';
import { objectRefSchema, type ActionDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import { commerceSnapshotSchema } from './commerce.js';
import { domainPreparedReceiptSchema } from './domain-composition.js';
import { prepareCheckoutInput } from '../capabilities/ucp/adapter.js';
import type { CompositionPort } from './composition-contract.js';

export const ucpConfirmScopeSchema = z.strictObject({ budget: moneySchema });
const ref = (type: string) => objectRefSchema.extend({ type: z.literal(type) });
export const ucpSchemas = {
  ReadUcpCreateTerms: z.strictObject({ scope: ref('UcpTask') }),
  CreateUcpCheckout: z.strictObject({ scope: ref('UcpTask'), terms: ref('UcpOperationTerms') }),
  ReadUcpConfirmationTerms: z.strictObject({ scope: ref('UcpTask'), checkout: ref('UcpCheckoutObservation') }),
  ConfirmUcpCheckout: z.strictObject({ scope: ref('UcpTask'), terms: ref('UcpOperationTerms') }),
};
const property = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Owned UCP context and independently verified local merchant receipt' });
const common = { id: property('string', z.string().min(1).max(200), 'Immutable object identity'), displayTitle: property('string', z.string().min(1).max(200), 'Readable label'), requestRevision: property('integer', z.number().int().positive(), 'Fixed original request revision') };
export const ucpCompositionObjects: ObjectTypeDefinition[] = [
  { id: 'UcpTask', version: '1', name: 'UCP 原子操作范围', aliases: [], description: 'Pure user inputs, without merchant facts or implicit checkout actions', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common, mode: property('string', z.enum(['prepare', 'confirm']), 'Requested endpoint'), input: property('struct', z.union([prepareCheckoutInput, ucpConfirmScopeSchema]), 'User-confirmed parameters'), configurationDigest: property('string', z.string().min(1).max(200), 'Exact configured merchant') } },
  { id: 'UcpOperationTerms', version: '1', name: 'UCP 操作条款回执', aliases: [], description: 'Original source preparation; complete payload stays in the private intent ledger', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { ...common, receipt: property('struct', domainPreparedReceiptSchema, 'Exact accepted preparation identity and expiry') } },
  { id: 'UcpCheckoutObservation', version: '1', name: 'UCP 结账观察', aliases: [], description: 'Immutable original checkout or order observation; its business phase is fixed by the producing action', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { ...common, snapshot: property('struct', commerceSnapshotSchema, 'Exact original local merchant response'), intentId: property('string', z.uuid(), 'Producing intent'), scope: property('struct', ref('UcpTask'), 'Original operation scope') } },
];
export const ucpCompositionLinks: LinkDefinition[] = [
  ...ucpCompositionObjects.map(object => ({ id: `${object.id}Request`, description: 'Original owned request', from: { type: object.id, name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: `${object.id}Objects`, many: true } })),
  ...['UcpOperationTerms', 'UcpCheckoutObservation'].map(type => ({ id: `${type}Evidence`, description: 'Original merchant source receipt', from: { type, name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: `${type}Objects`, many: true } })),
  { id: 'UcpObservationSession', description: 'Original checkout entity without merging unrelated merchant identities', from: { type: 'UcpCheckoutObservation', name: 'session', many: false, required: true }, to: { type: 'CheckoutSession', name: 'observations', many: true } },
];
const port = (type: string, role: string, phase: CompositionPort['semantics']['phase']): CompositionPort => ({ kind: 'object', type, cardinality: 'one', semantics: { role, phase }, evidence: { origins: type === 'UcpTask' ? ['managed', 'user'] : ['synthetic'], ...(type === 'UcpTask' ? {} : { maxAgeMs: 300000 }) } });
export const ucpCompositionActions: ActionDefinition[] = Object.entries(ucpSchemas).map(([id, schema]) => {
  const read = id.startsWith('Read'), confirm = id.includes('Confirm'), resultType = read ? 'UcpOperationTerms' : 'UcpCheckoutObservation';
  const inputs: Record<string, string> = { scope: 'UcpTask', ...(read ? confirm ? { checkout: 'UcpCheckoutObservation' } : {} : { terms: 'UcpOperationTerms' }) };
  const effects = read ? ['read' as const] : confirm ? ['order' as const, 'payment' as const] : ['reserve' as const];
  return { id, version: '1', kind: read ? 'source_read' : 'business', description: read ? 'Read exact configured local merchant terms. Confirmation consumes an accepted checkout observation and checks its current quote.' : confirm ? 'Confirm precisely the accepted original checkout, then independently read the original order. Explicit sandbox order and payment authorization required.' : 'Create one local test checkout under its original operation key; this does not purchase or pay.',
    inputs, resultTypes: [resultType], effects, changes: [resultType, 'SourceReceipt', ...(read ? [] : ['CheckoutRequest', 'CheckoutSession', 'ProductVariant', 'Order', 'OrderLine'])], submissionCriteria: ['same_owner', 'current_request_revision', 'original_merchant_configuration'],
    ...(read ? { read: { version: '1', effect: 'read', inputSchema: z.toJSONSchema(schema), resultType } as const } : { operation: { version: '1', effect: confirm ? 'order' : 'reserve', environment: 'sandbox', inputSchema: z.toJSONSchema(schema), resultType, ...(confirm ? { additionalEffects: ['payment'] } : {}) } as const }),
    composition: { version: '1', inputs: Object.fromEntries(Object.entries(inputs).map(([name, type]) => [name, port(type, name === 'checkout' ? 'ucp_prepared_checkout' : type, name === 'scope' ? 'request' : name === 'checkout' ? 'artifact' : 'quote')])),
      outputs: { result: port(resultType, read ? resultType : confirm ? 'ucp_confirmed_order' : 'ucp_prepared_checkout', read ? 'quote' : confirm ? 'commitment' : 'artifact') }, checks: [], effectScope: { effects, targetInputs: read ? [] : ['scope', 'terms'], recovery: read ? { kind: 'none' } : { kind: 'original_intent', version: '1', effect: 'read' }, compensation: [] } },
  };
});
