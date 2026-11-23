import { z } from 'zod';
import { Conflict, SourceReadFailure, digest } from '../../core/identity.js';
import { json } from '../../ontology/service-contracts.js';
import { ActionPARequestRequired, PARequestRequired } from '../../runtime/clarification.js';
import { PARequests } from '../../runtime/pa.js';
import { currentTaskExecution } from '../../runtime/tasks.js';
import type { DidiConnector } from './connector.js';
import { didiDataSchema, didiEndpoint, didiReceiptSchema, didiToolInputs } from './contracts.js';
import type { SourceResolver } from './functions.js';

export const didiPAReadCapability = 'didi.read';
export const didiPAReadTool = z.enum(['maps_textsearch', 'maps_place_around', 'taxi_estimate', 'maps_direction_driving']);
const expectedKind = {
  maps_textsearch: 'places', maps_place_around: 'places', taxi_estimate: 'estimate', maps_direction_driving: 'driving',
} as const;
export const didiPAReceipt = didiReceiptSchema.omit({ bindingId: true, environment: true }).extend({
  endpoint: z.literal(didiEndpoint('production')), tool: didiPAReadTool,
});

/** The original authenticated PA supplies a normalized observation through its existing task connection. */
export function withDidiPAReads(fallback: SourceResolver): SourceResolver {
  return async (owner, order) => {
    const execution = currentTaskExecution.getStore();
    if (!execution?.task.input.memberAccess || execution.task.owner !== owner || execution.task.cognitive_context)
      return fallback(owner, order);
    if (order) {
      // An existing provider order must use its verified owner-bound source.
      // The PA quotation observation is scoped to a task and cannot authorize order operations.
      if (order.readOnly) return fallback(owner, order);
      throw new Conflict('The PA DiDi pilot does not authorize order mutations');
    }
    const { task, tasks } = execution;
    const bindingId = digest(['didi-pa', owner, task.id]);
    const assertCurrent = () => tasks.current(task);
    const connector: DidiConnector = {
      evidenceKind: 'pa_reported',
      async invoke(_context, tool, input, signal, beforeCall) {
        const method = didiPAReadTool.parse(tool), args = didiToolInputs[method].parse(input), inputDigest = digest(args);
        const replySchema = z.discriminatedUnion('status', [
          z.strictObject({ status: z.enum(['unavailable', 'authorization_required']) }),
          z.strictObject({ status: z.literal('observed'), data: didiDataSchema,
            receipt: didiPAReceipt.extend({ tool: z.literal(method), inputDigest: z.literal(inputDigest) }) }),
        ]);
        signal.throwIfAborted();
        await beforeCall?.('prepare');
        let reply;
        try {
          reply = await new PARequests(tasks).requestWithId(task, digest([method, inputDigest, task.execution_step ?? 0]), didiPAReadCapability, {
            provider: 'DiDi', endpoint: didiEndpoint('production'), tool: method, arguments: args, inputDigest,
            instruction: 'Use the original PA’s authorized DiDi MCP connection. Call only this exact read tool. Respond with normalized data and its credential-free supplier-call receipt. If connection or authorization is unavailable, return the appropriate status.',
          }, json(replySchema));
        } catch (error) {
          if (error instanceof PARequestRequired) throw new ActionPARequestRequired(error.message, error.choices, error.permissions);
          throw error;
        }
        const observed = replySchema.parse(reply.response);
        if (observed.status !== 'observed')
          throw new Conflict(observed.status === 'authorization_required' ? 'The original PA needs to authorize its DiDi MCP connection' : 'The original PA could not read DiDi');
        const { data, receipt } = observed, now = Date.now();
        const start = Date.parse(receipt.startedAt), end = Date.parse(receipt.receivedAt);
        if (data.kind !== expectedKind[method] || receipt.resultDigest !== digest(data) ||
            start < reply.requestedAt.getTime() - 5_000 || end < start || end > now + 5_000 || now - end >= 300_000)
          throw new SourceReadFailure('The original PA receipt does not match the DiDi request or is stale');
        await beforeCall?.('dispatch');
        signal.throwIfAborted();
        return { data, receipt: { ...receipt, id: reply.requestId, bindingId, environment: 'production' } };
      },
    };
    return { bindingId, assertCurrent, connector };
  };
}
