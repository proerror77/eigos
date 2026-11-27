import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { immediateFare, immediateRideTerms } from '../../ontology/didi-immediate-ride.js';
import { json } from '../../ontology/service-contracts.js';
import { PARequests } from '../../runtime/pa.js';
import { resolvedRideEndpoints } from '../../ontology/didi-ride-endpoints.js';
import { type Database, type Sql } from '../../runtime/database.js';
import { ExternalOperations, UnknownExternalOperation } from '../../runtime/external-operations.js';
import type { FunctionContext } from '../../runtime/functions.js';
import { askDidiPA, didiPAConnectionRef } from './pa-read.js';
import { didiToolInputs } from './contracts.js';
import type { RideOrder } from './operations.js';

export const didiPAOrderCapability = 'didi.place_order';
export const didiPAReconcileCapability = 'didi.reconcile_order';
export const didiPAOrderTools = ['maps_textsearch', 'taxi_estimate', 'taxi_create_order', 'taxi_query_order'] as const;
export const didiPAOrderInput = z.strictObject({
  reference: didiPAConnectionRef, connectionRef: didiPAConnectionRef, quoteDigest: didiPAConnectionRef,
  dispatchProtocol: z.literal('server-claim-v1').optional(),
  pickup: immediateRideTerms.shape.pickup, destination: immediateRideTerms.shape.destination,
  fare: immediateFare, expiresAt: z.iso.datetime(), arguments: didiToolInputs.taxi_estimate,
  endpoints: resolvedRideEndpoints.optional(),
  instruction: z.string(),
});
export const didiPAOrderObservation = z.strictObject({
  orderId: z.string().regex(/^[A-Za-z0-9._~-]{1,160}$/), status: z.string().trim().min(1).max(200),
  observedAt: z.iso.datetime(), contentDigest: didiPAConnectionRef,
});
const proof = didiPAOrderInput.pick({ reference: true, quoteDigest: true, connectionRef: true });
const submittedOrder = proof.extend({ status: z.literal('submitted'), dispatchedAt: z.iso.datetime(),
  created: didiPAOrderObservation, readback: didiPAOrderObservation.optional() });
export const didiPAOrderReply = z.discriminatedUnion('status', [
  submittedOrder,
  proof.extend({ status: z.literal('price_changed'), amountMinor: immediateFare.shape.amountMinor }),
  proof.extend({ status: z.enum(['expired', 'unknown', 'unavailable']) }),
]);
export const didiPAReconcileInput = proof.extend({
  originalTaskId: z.uuid(), acknowledgement: submittedOrder.optional(),
});
export const didiPAReconcileReply = z.discriminatedUnion('status', [
  submittedOrder,
  proof.extend({ status: z.literal('unknown') }),
]);
type SubmittedOrder = z.infer<typeof submittedOrder>;
export type DidiPAOrderInput = z.infer<typeof didiPAOrderInput>;
export const didiPAOrderInstruction = 'Use the durable DiDi PA runner on the user’s own connection. Reprice the exact route. Send once only at the confirmed fare and before expiry, then query that exact order ID. Keep the MCP key and estimate trace in the PA. On a lost response report unknown and check the original DiDi account. Do not send another order.';

export async function savedDidiPAOrder(db: Database, owner: string, taskId: string) {
  const { rows: [row] } = await db.query<{ input: unknown }>(`SELECT request->'input' AS input FROM ${db.schema}.pa_requests
    WHERE owner=$1 AND task_id=$2 AND request->>'capability'=$3`, [owner, taskId, didiPAOrderCapability]);
  return row ? didiPAOrderInput.parse(row.input) : undefined;
}

export async function completeDidiPAOrder(
  db: Database, context: FunctionContext, input: DidiPAOrderInput, guard?: (client: Sql) => Promise<void>,
) {
  const { task, tasks } = context.execution!;
  const operation = new ExternalOperations(db);
  const scope = { taskId: task.id, inputDigest: digest(input) };
  const assertAuthorized = async (client: Sql) => {
    await context.assertDispatch!(client);
    context.objects.access.source(context.objects.model, 'Didi');
  };
  const { response, requestedAt } = await askDidiPA(tasks, task, input.reference, didiPAOrderCapability,
    input, didiPAOrderReply, async client => {
      await assertAuthorized(client);
      if (!guard) throw new Conflict('The original DiDi dispatch is unavailable');
      await guard(client);
      await operation.claimDispatch(client, task.owner, input.reference, scope, context.objects,
        { taskId: task.id, requestId: context.operationId });
    }, 'execution-result', input.dispatchProtocol && context.operationId ? {
      actionRequestId: context.operationId,
      grant: { expiresAt: input.expiresAt, operationKey: input.reference,
        responseWithoutDispatch: { type: 'object', required: ['status'],
          properties: { status: { enum: ['price_changed', 'expired', 'unavailable'] } } } },
    } : undefined);
  if (response.reference !== input.reference || response.quoteDigest !== input.quoteDigest || response.connectionRef !== input.connectionRef)
    throw new Conflict('DiDi order proof does not match the original approval and connection');
  const bindingId = digest(['didi-pa-order', task.owner, input.connectionRef]);
  if (response.status === 'price_changed') return { state: 'price_changed' as const, bindingId, amount: response.amountMinor };
  if (response.status === 'expired') return { state: 'quote_expired' as const, bindingId };
  if (response.status === 'unavailable') return { state: 'quote_unavailable' as const, bindingId };
  if (response.status !== 'submitted') return { state: 'unknown' as const, bindingId };

  const value = orderFromAcknowledgement(input, response, requestedAt);
  if (value.independentRead)
    await operation.reconcile(task.owner, input.reference, scope, assertAuthorized, async () => value, context.objects);
  return { state: value.independentRead ? 'ordered' as const : 'submitted' as const, bindingId, order: { bindingId, value } };
}

function orderFromAcknowledgement(input: DidiPAOrderInput, response: SubmittedOrder, requestedAt: Date): RideOrder {
  const dispatchedAt = Date.parse(response.dispatchedAt), createdAt = Date.parse(response.created.observedAt);
  const checkedAt = Date.parse(response.readback?.observedAt ?? '');
  if (dispatchedAt < requestedAt.getTime() - 5000 || dispatchedAt >= Date.parse(input.expiresAt) ||
      createdAt < dispatchedAt || createdAt > Date.now() + 5000)
    throw new Conflict('DiDi order acknowledgement is outside the original dispatch window');
  const verified = response.readback?.orderId === response.created.orderId && checkedAt >= createdAt && checkedAt <= Date.now() + 5000;
  return {
    ...(verified ? response.readback! : response.created), independentRead: verified,
    state: verified ? 'reported' : 'created', evidence: 'pa_reported',
  };
}

export async function reconcileDidiPAOrder(db: Database, context: FunctionContext, originalTaskId: string, reference: string) {
  const execution = context.execution;
  if (!execution || execution.task.input.scheduledAction || execution.task.cognitive_context || !context.assertDispatch)
    throw new Conflict('Original PA reconciliation requires an authenticated task');
  const { task, tasks } = execution;
  const { rows: [original] } = await db.query<{
    input: unknown; response: unknown; requested_at: Date; pa_client: string | null; action_request_id: string;
  }>(`SELECT r.request->'input' AS input,r.response,r.created_at AS requested_at,
      t.input->>'paClient' AS pa_client,o.request_id AS action_request_id
    FROM ${db.schema}.pa_requests r JOIN ${db.schema}.tasks t ON t.owner=r.owner AND t.id=r.task_id
    JOIN ${db.schema}.external_operations o ON o.owner=t.owner AND o.task_id=t.id AND o.operation_key=$4
    WHERE r.owner=$1 AND r.task_id=$2 AND r.request->>'capability'=$3 AND t.input ? 'memberAccess'`,
    [task.owner, originalTaskId, didiPAOrderCapability, reference]);
  if (!original || (original.pa_client ?? undefined) !== task.input.paClient)
    throw new Conflict('The original DiDi operation belongs to a different PA');
  const input = didiPAOrderInput.parse(original.input);
  if (input.reference !== reference) throw new Conflict('The original dispatch reference changed');
  const scope = { taskId: originalTaskId, inputDigest: digest(input) };
  const operation = new ExternalOperations(db);
  let verified: RideOrder | undefined;
  try {
    verified = await operation.recover<RideOrder>(task.owner, reference, scope, context.objects);
  } catch (error) {
    if (!(error instanceof UnknownExternalOperation)) throw error;
  }
  const originalResponse = original.response === null ? undefined : didiPAOrderReply.parse(original.response);
  if (originalResponse && (originalResponse.reference !== reference || originalResponse.quoteDigest !== input.quoteDigest ||
      originalResponse.connectionRef !== input.connectionRef))
    throw new Conflict('Original DiDi acknowledgement does not match the approval and connection');
  if (originalResponse && !['submitted', 'unknown'].includes(originalResponse.status)) return;
  const acknowledgement = originalResponse?.status === 'submitted' ? originalResponse : undefined;
  const bindingId = digest(['didi-pa-order', task.owner, input.connectionRef]);
  const result = (value: RideOrder) => ({
    value, bindingId, input, requestId: original.action_request_id, state: value.independentRead ? 'ordered' as const : 'submitted' as const,
  });
  if (verified) return result(verified);
  const request = didiPAReconcileInput.parse({ ...proof.parse({
    reference, quoteDigest: input.quoteDigest, connectionRef: input.connectionRef,
  }), originalTaskId, acknowledgement });
  const response = didiPAReconcileReply.parse(await new PARequests(tasks).requestActionInput(task, context.operationId!,
    reference, didiPAReconcileCapability, 'observation', request, json(didiPAReconcileReply)));
  if (response.reference !== reference || response.quoteDigest !== input.quoteDigest || response.connectionRef !== input.connectionRef)
    throw new Conflict('DiDi readback does not match the original approval and connection');
  if (response.status === 'unknown') return;
  if (acknowledgement && (digest(acknowledgement.created) !== digest(response.created) ||
      acknowledgement.dispatchedAt !== response.dispatchedAt))
    throw new Conflict('DiDi readback changed the original acknowledgement');
  const value = orderFromAcknowledgement(input, response, original.requested_at);
  if (value.independentRead) {
    const saved = await operation.reconcile(task.owner, reference, scope, context.assertDispatch, async () => value, context.objects);
    if (saved) return result(saved);
  }
  return result(value);
}
