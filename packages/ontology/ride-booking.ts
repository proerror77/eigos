import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { didiOrderResultSchema } from '../capabilities/didi/booking-contracts.js';
import { objectRefSchema, type ActionDefinition, type FunctionDefinition, type ObjectTypeDefinition, type LinkDefinition, type ObjectRef } from './model.js';

const text = z.string().min(1).max(500), sha = z.string().regex(/^[a-f0-9]{64}$/);
const scope = objectRefSchema.extend({ type: z.literal('RideEstimateTask') }), estimate = objectRefSchema.extend({ type: z.literal('RideEstimateObservation') });
const order = objectRefSchema.extend({ type: z.literal('DidiOrderObservation') });
export const rideBookingActionSchemas = {
  CreateDidiRide: z.strictObject({ scope, estimate, productCategory: text, productName: text, priceText: text, fareBasis: z.literal('estimate_not_final_fare') }),
  ReadDidiRide: z.strictObject({ scope, order }),
};
export const rideBookingCompletionSchema = z.strictObject({ order, rationale: z.string().min(1).max(2000) });
export const rideOrderSnapshotSchema = z.strictObject({
  id: z.uuid(), requestId: text, requestRevision: z.number().int().positive(), configurationDigest: sha, scope,
  action: z.enum(['CreateDidiRide', 'ReadDidiRide']), actionInput: z.record(z.string(), z.unknown()),
  planId: text, intentId: text, attemptId: text, modelRunId: text,
  originalIntentId: text, estimate, productCategory: text, productName: text, priceText: text,
  source: didiOrderResultSchema, evidenceKind: z.enum(['provider_mock', 'fixture']), observedAt: z.iso.datetime(), contentDigest: sha,
});
export type RideOrderSnapshot = z.infer<typeof rideOrderSnapshotSchema>;
export const rideBookingObjects: ObjectTypeDefinition[] = [{ id: 'DidiOrderObservation', version: '1', name: '滴滴模拟订单回执', aliases: ['DidiOrderObservation'], description: 'Official mock order identity and independently read status. No real dispatch, payment or trip fulfillment.', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: {
  id: { kind: 'string', schema: text, required: true, source: 'Provider mock', description: 'Immutable observation identity' },
  displayTitle: { kind: 'string', schema: text, required: true, source: 'Provider mock', description: 'Mock order observation' },
  snapshot: { kind: 'struct', schema: rideOrderSnapshotSchema, required: true, source: 'Provider mock', description: 'Exact source result and original order binding' },
} }];
export const rideBookingLinks: LinkDefinition[] = [
  { id: 'DidiOrderRequest', description: 'Order task', from: { type: 'DidiOrderObservation', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'didiOrders', many: true } },
  { id: 'DidiOrderScope', description: 'Exact binding and revision', from: { type: 'DidiOrderObservation', name: 'scope', many: false, required: true }, to: { type: 'RideEstimateTask', name: 'orders', many: true } },
  { id: 'DidiOrderEstimate', description: 'The exact confirmed estimate; historical after creation', from: { type: 'DidiOrderObservation', name: 'estimate', many: false, required: true }, to: { type: 'RideEstimateObservation', name: 'orders', many: true } },
  { id: 'DidiOrderEvidence', description: 'Source receipt', from: { type: 'DidiOrderObservation', name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: 'didiOrders', many: true } },
];
export const rideBookingActions: ActionDefinition[] = [
  { id: 'CreateDidiRide', description: 'Propose one official mock ride plan from the observed route, estimate and selected vehicle. The host requests exact plan authorization before dispatching creation; proposing this action does not place an order. This does not guarantee a final fare or real fulfillment.', inputs: { scope: 'RideEstimateTask', estimate: 'RideEstimateObservation' }, changes: ['DidiOrderObservation'], submissionCriteria: ['same_owner', 'fresh_source_estimate', 'exact_vehicle_and_price', 'explicit_plan_authorization', 'mock_only', 'one_original_order'], operation: { version: '1', effect: 'order', environment: 'sandbox', inputSchema: z.toJSONSchema(rideBookingActionSchemas.CreateDidiRide), resultType: 'DidiOrderObservation' } },
  { id: 'ReadDidiRide', description: 'Read the original mock order ID and current driver status. Never omit order ID or infer trip completion from acceptance.', inputs: { scope: 'RideEstimateTask', order: 'DidiOrderObservation' }, changes: ['DidiOrderObservation'], submissionCriteria: ['same_owner', 'original_order_id', 'mock_only'], read: { version: '1', effect: 'read', inputSchema: z.toJSONSchema(rideBookingActionSchemas.ReadDidiRide), resultType: 'DidiOrderObservation' } },
];
export const rideBookingFunctions: FunctionDefinition[] = [{ id: 'didiOrderStatus', version: '1', inputTypes: ['DidiOrderObservation'], description: 'Validate original mock order identity, source proof and current readback. Provider mock is never real fulfillment.' }];
export function checkedRideOrder(raw: unknown): RideOrderSnapshot {
  const s = rideOrderSnapshotSchema.parse(raw), { contentDigest, ...body } = s;
  if (digest(body) !== contentDigest || s.id !== s.source.receipt.id || s.source.receipt.resultDigest !== digest(s.source.data) || s.observedAt !== s.source.receipt.receivedAt
    || (s.action === 'ReadDidiRide') !== s.source.data.independentRead || (s.action === 'ReadDidiRide' ? 'taxi_query_order' : 'taxi_create_order') !== s.source.receipt.tool
    || digest(rideBookingActionSchemas[s.action].parse(s.actionInput).scope) !== digest(s.scope)) throw new DomainError('CONFLICT', 'DiDi order source binding is invalid');
  return s;
}
