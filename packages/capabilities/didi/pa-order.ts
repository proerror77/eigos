import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { immediateFare, immediateRideTerms } from '../../ontology/didi-immediate-ride.js';
import { resolvedRideEndpoints } from '../../ontology/didi-ride-endpoints.js';
import { type Database, type Sql } from '../../runtime/database.js';
import { ExternalOperations } from '../../runtime/external-operations.js';
import type { FunctionContext } from '../../runtime/functions.js';
import { askDidiPA, didiPAConnectionRef } from './pa-read.js';
import { didiToolInputs } from './contracts.js';
import type { RideOrder } from './operations.js';

export const didiPAOrderCapability = 'didi.place_order';
export const didiPAOrderTools = ['maps_textsearch', 'taxi_estimate', 'taxi_create_order', 'taxi_query_order'] as const;
export const didiPAOrderInput = z.strictObject({
  reference: didiPAConnectionRef, connectionRef: didiPAConnectionRef, quoteDigest: didiPAConnectionRef,
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
export const didiPAOrderReply = z.discriminatedUnion('status', [
  proof.extend({ status: z.literal('submitted'), dispatchedAt: z.iso.datetime(),
    created: didiPAOrderObservation, readback: didiPAOrderObservation.optional() }),
  proof.extend({ status: z.literal('price_changed'), amountMinor: immediateFare.shape.amountMinor }),
  proof.extend({ status: z.enum(['expired', 'unknown', 'unavailable']) }),
]);
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
    });
  if (response.reference !== input.reference || response.quoteDigest !== input.quoteDigest || response.connectionRef !== input.connectionRef)
    throw new Conflict('DiDi order proof does not match the original approval and connection');
  const bindingId = digest(['didi-pa-order', task.owner, input.connectionRef]);
  if (response.status === 'price_changed') return { state: 'price_changed' as const, bindingId, amount: response.amountMinor };
  if (response.status === 'expired') return { state: 'quote_expired' as const, bindingId };
  if (response.status === 'unavailable') return { state: 'quote_unavailable' as const, bindingId };
  if (response.status !== 'submitted') return { state: 'unknown' as const, bindingId };

  const dispatchedAt = Date.parse(response.dispatchedAt), createdAt = Date.parse(response.created.observedAt);
  const checkedAt = Date.parse(response.readback?.observedAt ?? '');
  if (dispatchedAt < requestedAt.getTime() - 5000 || dispatchedAt >= Date.parse(input.expiresAt) ||
      createdAt < dispatchedAt || createdAt > Date.now() + 5000)
    throw new Conflict('DiDi order acknowledgement is outside the original dispatch window');
  const verified = response.readback?.orderId === response.created.orderId && checkedAt >= createdAt && checkedAt <= Date.now() + 5000;
  const value: RideOrder = {
    ...(verified ? response.readback! : response.created), independentRead: verified,
    state: verified ? 'reported' : 'created', evidence: 'pa_reported',
  };
  if (verified)
    await operation.reconcile(task.owner, input.reference, scope, assertAuthorized, async () => value, context.objects);
  return { state: verified ? 'ordered' as const : 'submitted' as const, bindingId, order: { bindingId, value } };
}
