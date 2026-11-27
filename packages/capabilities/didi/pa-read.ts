import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { Conflict, SourceReadFailure, digest } from '../../core/identity.js';
import { json } from '../../ontology/service-contracts.js';
import { ActionPARequestRequired, PARequestRequired, type ActionInputPurpose } from '../../runtime/clarification.js';
import { PARequests } from '../../runtime/pa.js';
import { currentTaskExecution, type Task, type Tasks } from '../../runtime/tasks.js';
import type { Sql } from '../../runtime/database.js';
import type { DidiConnector } from './connector.js';
import { didiDataSchema, didiEndpoint, didiReceiptSchema, didiToolInputs } from './contracts.js';
import type { SourceResolver } from './functions.js';

export const didiPAReadCapability = 'didi.read';
export const didiPAAuthorizeCapability = 'didi.authorize';
export const didiMcpConsole = 'https://mcp.didichuxing.com/';
export const didiPAConnectionRef = z.string().regex(/^[a-f0-9]{64}$/);
export const didiPAConnection = new AsyncLocalStorage<string>();
export const didiPAReadTool = z.enum(['maps_textsearch', 'maps_place_around', 'taxi_estimate', 'maps_direction_driving']);
const expectedKind = {
  maps_textsearch: 'places', maps_place_around: 'places', taxi_estimate: 'estimate', maps_direction_driving: 'driving',
} as const;
export const didiPAReceipt = didiReceiptSchema.omit({ bindingId: true, environment: true }).extend({
  endpoint: z.literal(didiEndpoint('production')), tool: didiPAReadTool,
});

export async function askDidiPA<T extends z.ZodType>(
  tasks: Tasks, task: Task, operation: string, capability: string, input: Record<string, unknown>, schema: T,
  beforeDispatch?: (client: Sql) => Promise<void>, purpose: ActionInputPurpose = 'observation',
) {
  try {
    const reply = await new PARequests(tasks).requestWithId(task, operation, capability, input, json(schema), undefined, beforeDispatch);
    return { ...reply, response: schema.parse(reply.response) };
  } catch (error) {
    if (error instanceof PARequestRequired) throw new ActionPARequestRequired(error.message, error.choices, error.permissions, purpose);
    throw error;
  }
}

const authorizationReply = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('connected'), connectionRef: didiPAConnectionRef }),
  z.strictObject({ status: z.literal('declined') }),
]);
export async function authorizeDidiPA(tasks: Tasks, task: Task, purpose: 'order' | 'read', operation: string, tools: readonly string[]) {
  const reply = await askDidiPA(tasks, task, operation, didiPAAuthorizeCapability, {
    provider: 'DiDi', purpose, tools,
    authorizationUrl: didiMcpConsole, authorizationLabel: '申请或开通滴滴 MCP Key',
    instruction: 'Check your own DiDi MCP connection for the required tools. If it is missing, show the official authorization link in this conversation and keep this request pending while the user sets up their personal connection. Tell the user to return here after setup. Reply connected with an opaque reference for that connection only after checking it. Keep the key in the PA; never send it to EIGOS or ask the user to paste it into the chat.',
  }, authorizationReply, undefined, 'authorization');
  return reply.response;
}

/** The original authenticated PA supplies a normalized observation through its existing task connection. */
export function withDidiPAReads(fallback: SourceResolver, ordersEnabled = false): SourceResolver {
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
    const orderConnection = didiPAConnection.getStore();
    const bindingId = digest(orderConnection ? ['didi-pa', owner, task.id, orderConnection] : ['didi-pa', owner, task.id]);
    const assertCurrent = () => tasks.current(task);
    const connector: DidiConnector = {
      evidenceKind: 'pa_reported',
      async invoke(_context, tool, input, signal, beforeCall) {
        const method = didiPAReadTool.parse(tool), args = didiToolInputs[method].parse(input), inputDigest = digest(args);
        signal.throwIfAborted();
        await beforeCall?.('prepare');
        const operation = digest([method, inputDigest, task.execution_step ?? 0]);
        const read = (key: string, connection?: string) => {
          const replySchema = z.discriminatedUnion('status', [
            z.strictObject({ status: z.enum(['unavailable', 'authorization_required']) }),
            z.strictObject({ status: z.literal('observed'), data: didiDataSchema,
              receipt: didiPAReceipt.extend({ tool: z.literal(method), inputDigest: z.literal(inputDigest) }),
              ...(connection ? { connectionRef: z.literal(connection) } : {}) }),
          ]);
          return askDidiPA(tasks, task, key, didiPAReadCapability, {
            provider: 'DiDi', endpoint: didiEndpoint('production'), tool: method, arguments: args, inputDigest,
            ...(connection ? { connectionRef: connection } : {}),
            instruction: 'Use the original PA’s authorized DiDi MCP connection. Call only this exact read tool. Respond with normalized data and its credential-free supplier-call receipt. If connection or authorization is unavailable, return the appropriate status.',
          }, replySchema);
        };
        let reply = await read(operation, orderConnection);
        if (reply.response.status === 'authorization_required') {
          const connected = await authorizeDidiPA(tasks, task, 'read', 'reauthorize:' + operation, [method]);
          if (connected.status === 'declined') throw new Conflict('DiDi connection authorization was declined');
          if (orderConnection && connected.connectionRef !== orderConnection)
            throw new Conflict('The authorized DiDi connection changed; use a new quote for this connection');
          reply = await read('authorized:' + operation, connected.connectionRef);
        }
        const observed = reply.response;
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
    return { bindingId, assertCurrent, connector, ...(ordersEnabled ? { paOrdersEnabled: true } : {}) };
  };
}
