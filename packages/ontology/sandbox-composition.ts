import { z } from 'zod';
import { sandboxInputSchema, sandboxOrderSchema, sandboxQuoteSchema } from '../capabilities/sandbox-service.js';
import { domainPreparedReceiptSchema } from './domain-composition.js';
import { objectRefSchema, type ActionDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import type { CompositionPort } from './composition-contract.js';

export const sandboxScopeSchema = z.union([sandboxInputSchema, z.strictObject({ caseId: z.uuid() })]);
const ref = (type: string) => objectRefSchema.extend({ type: z.literal(type) });
const scope = { scope: ref('SandboxTask') }, order = { ...scope, order: ref('SandboxOrderObservation') };
export const sandboxActionSchemas = {
  ReadSandboxQuote: z.strictObject(scope), SubmitSandboxOrder: z.strictObject({ ...scope, quote: ref('SandboxQuoteObservation') }),
  ExecuteSandboxPayment: z.strictObject(order), ReadSandboxOrder: z.strictObject(order), AwaitSandboxDelivery: z.strictObject(order),
  ExecuteSandboxCancel: z.strictObject({ ...order, reason: z.string().min(1).max(1000) }), ExecuteSandboxRefund: z.strictObject({ ...order, reason: z.string().min(1).max(1000) }),
  ReadSandboxRemedyOrder: z.strictObject(scope),
};
export const sandboxAtomicOperations = { SubmitSandboxOrder: 'sandbox.place_order', ExecuteSandboxPayment: 'sandbox.pay', ReadSandboxOrder: 'sandbox.read_order', AwaitSandboxDelivery: 'sandbox.await_delivery', ExecuteSandboxCancel: 'sandbox.cancel', ExecuteSandboxRefund: 'sandbox.refund', ReadSandboxRemedyOrder: 'sandbox.read_order' } as const;
const property = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Original authenticated loopback simulator, never live commerce' });
const text = z.string().min(1).max(200), common = { id: property('string', text, 'Immutable object identity'), displayTitle: property('string', text, 'Readable label'), requestRevision: property('integer', z.number().int().positive(), 'Original request revision') };
export const sandboxCompositionObjects: ObjectTypeDefinition[] = [
  { id: 'SandboxTask', version: '1', name: '模拟履约操作范围', aliases: [], description: 'Exact user service inputs or an independently owned existing after-sales case; initialization performs no source operations', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common, input: property('struct', sandboxScopeSchema, 'Immutable scoped inputs'), configurationDigest: property('string', text, 'Exact configured source') } },
  { id: 'SandboxQuoteObservation', version: '1', name: '模拟履约报价观察', aliases: [], description: 'Original exact quote, capacity and validity; no order or fulfillment', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { ...common, quote: property('struct', sandboxQuoteSchema, 'Original simulator quote'), receipt: property('struct', domainPreparedReceiptSchema, 'Exact accepted preparation') } },
  { id: 'SandboxOrderObservation', version: '1', name: '模拟订单观察', aliases: [], description: 'Immutable observation of the original order. Order, payment, delivery and refund phases remain distinct.', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { ...common, record: property('struct', sandboxOrderSchema, 'Original provider record'), intentId: property('string', z.uuid(), 'Original producing intent'), action: property('string', text, 'Actual producing atomic action'), scope: property('struct', ref('SandboxTask'), 'Original component scope') } },
];
export const sandboxCompositionLinks: LinkDefinition[] = [
  ...sandboxCompositionObjects.map(object => ({ id: `${object.id}Request`, description: 'Original owned request', from: { type: object.id, name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: `${object.id}Objects`, many: true } })),
  ...['SandboxQuoteObservation', 'SandboxOrderObservation'].map(type => ({ id: `${type}Evidence`, description: 'Original verified source receipt', from: { type, name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: `${type}Objects`, many: true } })),
];
const port = (type: string, role: string, phase: CompositionPort['semantics']['phase'], identity = false): CompositionPort => ({ kind: 'object', type, cardinality: 'one', semantics: { role, phase }, evidence: { origins: type === 'SandboxTask' ? ['managed', 'user'] : ['synthetic'], ...(identity || type === 'SandboxTask' ? {} : { maxAgeMs: 300000 }) } });
export const sandboxCompositionActions: ActionDefinition[] = Object.entries(sandboxActionSchemas).map(([id, schema]) => {
  const quote = id === 'ReadSandboxQuote', read = id.startsWith('Read') || id === 'AwaitSandboxDelivery';
  const businessEffect = id === 'SubmitSandboxOrder' ? 'order' : id === 'ExecuteSandboxPayment' ? 'payment' : id === 'ExecuteSandboxCancel' ? 'cancel' : 'refund';
  const effect = read ? 'read' : businessEffect;
  const phase = quote ? 'quote' : id === 'SubmitSandboxOrder' ? 'commitment' : id === 'ExecuteSandboxPayment' || id === 'ExecuteSandboxRefund' ? 'payment' : id === 'AwaitSandboxDelivery' ? 'delivery' : 'fact';
  const resultType = quote ? 'SandboxQuoteObservation' : 'SandboxOrderObservation';
  const inputs: Record<string, string> = { scope: 'SandboxTask', ...(id === 'SubmitSandboxOrder' ? { quote: 'SandboxQuoteObservation' } : !['ReadSandboxQuote', 'ReadSandboxRemedyOrder'].includes(id) ? { order: 'SandboxOrderObservation' } : {}) };
  return { id, version: '1', kind: read ? 'source_read' : 'business', description: quote ? 'Read one exact simulator quote; no order or payment.' : id === 'ReadSandboxRemedyOrder' ? 'Read the original order named by this task\'s existing owned after-sales case. Never import arbitrary cross-task objects.' : id === 'AwaitSandboxDelivery' ? 'Observe the original order until a terminal delivery fact exists; partial or failed delivery does not satisfy completion.' : `One exact ${effect} operation on the original accepted simulator object; no subsequent business action is selected by this handler.`,
    inputs, resultTypes: [resultType], effects: [effect], changes: [resultType, 'SourceReceipt', 'Order', 'Payment', 'Shipment', 'DeliveryEvent', 'DeliveryAllocation', 'Refund'], submissionCriteria: ['same_owner', 'current_request_revision', 'original_operation_and_source'],
    ...(read ? { read: { version: '1', effect: 'read', inputSchema: z.toJSONSchema(schema), resultType } as const } : { operation: { version: '1', effect: businessEffect, environment: 'sandbox', inputSchema: z.toJSONSchema(schema), resultType } as const }),
    composition: { version: '1', inputs: Object.fromEntries(Object.entries(inputs).map(([name, type]) => [name, port(type, name === 'order' ? 'original_SandboxOrderObservation' : type, name === 'scope' ? 'request' : name === 'order' ? 'fact' : 'quote', name === 'order')])), outputs: { result: port(resultType, quote ? resultType : `${id}_result`, phase), ...(!quote ? { identity: port(resultType, 'original_SandboxOrderObservation', 'fact', true) } : {}) }, checks: [], effectScope: { effects: [effect], targetInputs: read ? [] : Object.keys(inputs), recovery: quote ? { kind: 'none' } : { kind: 'original_intent', version: '1', effect: 'read' }, compensation: [] } },
  };
});
