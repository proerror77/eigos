import { z } from 'zod';
import { digest, Conflict } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import { json } from '../../ontology/service-contracts.js';
import { Accounts } from '../../runtime/accounts.js';
import { ActionPARequestRequired, PARequestRequired } from '../../runtime/clarification.js';
import { PARequests } from '../../runtime/pa.js';
import { currentTaskExecution, type Task } from '../../runtime/tasks.js';
import { DidiMcpConnector } from './connector.js';
import { didiEndpoint, type DidiBinding } from './contracts.js';
import type { DidiSource, SourceResolver } from './functions.js';
import { DidiOperations } from './operations.js';

export const didiPAConnectionCapability = 'didi.authorize';
const leaseDurationMs = 30 * 60_000;
const leaseReply = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({
    status: z.literal('authorized'), connectionRef: z.uuid(), expiresAt: z.iso.datetime(),
    access: z.enum(['read', 'ride']),
  }),
]);

export function withDidiPAConnection(fallback: SourceResolver,
  relay: { url: string; tokenFile: string; ordersEnabled?: boolean }, fetcher: typeof fetch = fetch,
  environment: DidiBinding['environment'] = 'production'): SourceResolver {
  const connections = new WeakMap<Task, Promise<DidiSource>>();
  const connect = async (execution: NonNullable<ReturnType<typeof currentTaskExecution.getStore>>): Promise<DidiSource> => {
    const { task, tasks } = execution;
    const owner = task.owner;
    const request = new PARequests(tasks);
    const { requestId, response } = await request.requestWithId(task, didiPAConnectionCapability, didiPAConnectionCapability, {
      provider: 'DiDi', relay: relay.url, taskId: task.id, maxLeaseMinutes: leaseDurationMs / 60_000,
      message: '请在原 PA 内连接滴滴官方 MCP。请把短期连接引用和已授权的访问级别回传，滴滴 MCP Key 留在 PA。',
    }, json(leaseReply)).catch((error: unknown) => {
      if (error instanceof PARequestRequired) throw new ActionPARequestRequired(error.message, error.choices, error.permissions);
      throw error;
    });
    const lease = leaseReply.parse(response);
    if (lease.status !== 'authorized') throw new Conflict('The original PA did not authorize the DiDi connection');
    const expiresAt = Date.parse(lease.expiresAt);
    if (expiresAt <= Date.now() || expiresAt > Date.now() + leaseDurationMs)
      throw new Conflict('The DiDi connection has expired or exceeds its lease limit');
    const bindingId = digest([owner, task.id, requestId, lease.connectionRef, lease.access]);
    const binding: DidiBinding = {
      bindingId, keyFile: '/unused-pa-connection-reference', keySha256: digest(lease.connectionRef), environment,
    };
    const readReference = async () => {
      await tasks.current(task);
      if (!await new Accounts(tasks.db, 'invite').active(owner, tasks.db.pool))
        throw new Conflict('The PA account authorization is no longer active');
      if (Date.now() >= expiresAt) throw new Conflict('The DiDi connection has expired');
      return lease.connectionRef;
    };
    const transport: typeof fetch = async (target, init) => {
      const source = new URL(String(target));
      if (source.origin + source.pathname !== didiEndpoint(environment) || source.searchParams.get('key') !== lease.connectionRef)
        throw new Conflict('Unexpected DiDi transport resource');
      const headers = new Headers(init?.headers);
      headers.set('Authorization', 'Bearer ' + (await readPrivateSourceFile(relay.tokenFile)).trim());
      headers.set('X-EIGOS-Owner', owner);
      headers.set('X-EIGOS-Task', task.id);
      headers.set('X-EIGOS-PA-Request', requestId);
      headers.set('X-EIGOS-Connection', await readReference());
      return fetcher(relay.url, { ...init, headers, redirect: 'manual' });
    };
    return {
      bindingId, connector: new DidiMcpConnector(binding, transport, false, readReference),
      orders: lease.access === 'ride' ? new DidiOperations(binding, relay.ordersEnabled, transport, undefined, false, readReference) : undefined,
      async assertCurrent() { await readReference(); },
    };
  };
  return async (owner, order) => {
    const execution = currentTaskExecution.getStore();
    if (!execution?.task.input.memberAccess || execution.task.owner !== owner || execution.task.cognitive_context)
      return fallback(owner, order);
    let connected = connections.get(execution.task);
    if (!connected) {
      connected = connect(execution);
      connections.set(execution.task, connected);
    }
    const source = await connected;
    if (order && order.bindingId !== source.bindingId) throw new Conflict('The original DiDi order belongs to a different connection');
    return source;
  };
}
