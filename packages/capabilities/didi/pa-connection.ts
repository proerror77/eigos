import { z } from 'zod';
import { digest, Conflict } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import { json } from '../../ontology/service-contracts.js';
import { Accounts } from '../../runtime/accounts.js';
import { ActionPARequestRequired, PARequestRequired } from '../../runtime/clarification.js';
import { PARequests } from '../../runtime/pa.js';
import { currentTaskExecution, type Task, type Tasks } from '../../runtime/tasks.js';
import { DidiMcpConnector } from './connector.js';
import { didiEndpoint, type DidiBinding } from './contracts.js';
import type { DidiOrderSource, DidiSource, SourceResolver } from './functions.js';
import { DidiOperations } from './operations.js';

export const didiPAConnectionCapability = 'didi.authorize';
export const didiPAFollowupCapability = 'didi.authorize_followup';
const leaseDurationMs = 30 * 60_000;
const authorized = z.strictObject({
  status: z.literal('authorized'), connectionRef: z.uuid(), expiresAt: z.iso.datetime(),
  access: z.enum(['read', 'ride']),
});
const unavailable = z.strictObject({ status: z.literal('unavailable') });
const leaseReply = z.discriminatedUnion('status', [unavailable, authorized]);
const authorizedFollowup = authorized.extend({ access: z.literal('followup') });
const followupReply = z.discriminatedUnion('status', [unavailable, authorizedFollowup]);
const attestation = z.strictObject({ authorityId: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(), access: z.enum(['read', 'ride', 'followup']), orderId: z.string().optional() });
type Execution = { task: Task; tasks: Tasks };
type Lease = z.infer<typeof authorized> | z.infer<typeof authorizedFollowup>;

export function withDidiPAConnection(fallback: SourceResolver,
  relay: { url: string; tokenFile: string; ordersEnabled?: boolean }, fetcher: typeof fetch = fetch,
  environment: DidiBinding['environment'] = 'production'): SourceResolver {
  const connections = new WeakMap<Task, Promise<DidiSource>>();
  async function establish(owner: string, taskId: string, requestId: string, lease: Lease,
    check: () => Promise<void>, order?: DidiOrderSource): Promise<DidiSource> {
    const claimedExpiry = Date.parse(lease.expiresAt);
    if (!Number.isFinite(claimedExpiry) || claimedExpiry <= Date.now() || claimedExpiry > Date.now() + leaseDurationMs)
      throw new Conflict('The DiDi connection has expired or exceeds its lease limit');
    const bindingId = digest([owner, taskId, requestId, lease.connectionRef, lease.access]);
    const headersFor = async (headers?: HeadersInit) => {
      const values = new Headers(headers);
      values.set('Authorization', 'Bearer ' + (await readPrivateSourceFile(relay.tokenFile)).trim());
      values.set('X-EIGOS-Owner', owner);
      values.set('X-EIGOS-Task', taskId);
      values.set('X-EIGOS-PA-Request', requestId);
      values.set('X-EIGOS-Connection', lease.connectionRef);
      if (order) values.set('X-EIGOS-Order', order.orderId);
      return values;
    };
    await check();
    const proof = await fetcher(relay.url, { method: 'GET', headers: await headersFor(),
      redirect: 'manual', signal: AbortSignal.timeout(5000) });
    // Older relays can finish same-task inquiries and orders. Only a verified
    // relay authority can resume an original order across tasks.
    const verified = proof.ok ? attestation.parse(await proof.json()) : undefined;
    if ((!verified && (order || proof.status !== 405)) || verified &&
        (verified.access !== lease.access || verified.orderId !== order?.orderId) ||
        order && verified?.authorityId !== order.authorityId)
      throw new Conflict('The PA relay did not verify the original DiDi account and follow-up scope');
    const expiry = Math.min(claimedExpiry, verified ? Date.parse(verified.expiresAt) : claimedExpiry);
    const readReference = async () => {
      await check();
      if (Date.now() >= expiry) throw new Conflict('The DiDi connection has expired');
      return lease.connectionRef;
    };
    const binding: DidiBinding = {
      bindingId, keyFile: '/unused-pa-connection-reference', keySha256: digest(lease.connectionRef), environment,
    };
    const transport: typeof fetch = async (target, init) => {
      const endpoint = new URL(String(target));
      if (endpoint.origin + endpoint.pathname !== didiEndpoint(environment) || endpoint.searchParams.get('key') !== lease.connectionRef)
        throw new Conflict('Unexpected DiDi transport resource');
      await readReference();
      const headers = await headersFor(init?.headers);
      if (verified) headers.set('X-EIGOS-Authority', verified.authorityId);
      return fetcher(relay.url, { ...init, headers, redirect: 'manual' });
    };
    const operations = lease.access === 'ride' || lease.access === 'followup'
      ? new DidiOperations(binding, lease.access === 'ride' && relay.ordersEnabled, transport, undefined, false, readReference)
      : undefined;
    return { bindingId, authorityId: verified?.authorityId,
      connector: new DidiMcpConnector(binding, transport, false, readReference),
      orders: operations,
      ...(order ? { followup: { taskId, requestId, expiresAt: new Date(expiry).toISOString() } } : {}),
      async assertCurrent() { await readReference(); },
    };
  }

  async function connect({ task, tasks }: Execution, order?: DidiOrderSource) {
    const capability = order ? didiPAFollowupCapability : didiPAConnectionCapability;
    const responseSchema = order ? followupReply : leaseReply;
    const { requestId, response } = await new PARequests(tasks).requestWithId(task, capability, capability, {
      provider: 'DiDi', relay: relay.url, taskId: task.id, maxLeaseMinutes: leaseDurationMs / 60_000,
      ...(order ? { orderId: order.orderId, message: '请在原 PA 授权只读跟踪这一个滴滴原单。' }
        : { message: '请在原 PA 内连接滴滴官方 MCP。请回传短期连接引用和访问级别。' }),
    }, json(responseSchema)).catch((error: unknown) => {
      if (error instanceof PARequestRequired) throw new ActionPARequestRequired(error.message, error.choices, error.permissions);
      throw error;
    });
    const lease = responseSchema.parse(response);
    if (lease.status !== 'authorized') throw new Conflict('The original PA did not authorize the DiDi connection');
    return establish(task.owner, task.id, requestId, lease, async () => {
      await tasks.current(task);
      if (!await new Accounts(tasks.db, 'invite').active(task.owner, tasks.db.pool))
        throw new Conflict('The PA account authorization is no longer active');
    }, order);
  }

  async function resume(owner: string, order: DidiOrderSource) {
    const db = order.db;
    if (!db || !order.followup || !order.authorityId) throw new Conflict('The original DiDi follow-up authorization is unavailable');
    const { taskId, requestId } = order.followup;
    const { rows: [grant] } = await db.query(`SELECT r.response FROM ${db.schema}.pa_requests r
      JOIN ${db.schema}.tasks t ON t.owner=r.owner AND t.id=r.task_id
      WHERE r.owner=$1 AND r.task_id=$2 AND r.id=$3 AND r.request->>'capability'=$4
        AND r.request->'input'->>'orderId'=$5 AND t.state='completed'`,
    [owner, taskId, requestId, didiPAFollowupCapability, order.orderId]);
    const parsed = authorizedFollowup.safeParse(grant?.response);
    if (!parsed.success) throw new Conflict('The original DiDi follow-up authorization is unavailable');
    const lease = { ...parsed.data, expiresAt: new Date(Math.min(Date.parse(parsed.data.expiresAt),
      Date.parse(order.followup.expiresAt))).toISOString() };
    return establish(owner, taskId, requestId, lease, async () => {
      if (order.execution) await order.execution.tasks.current(order.execution.task);
      if (!await new Accounts(db, 'invite').active(owner, db.pool))
        throw new Conflict('The PA account authorization is no longer active');
    }, order);
  }

  return async (owner, order) => {
    if (order?.followup) return resume(owner, order);
    const execution = currentTaskExecution.getStore();
    if (!execution?.task.input.memberAccess || execution.task.owner !== owner || execution.task.cognitive_context)
      return fallback(owner, order);
    if (order) {
      if (!order.authorityId) throw new Conflict('The original DiDi order has no verified PA account authority');
      return connect(execution, order);
    }
    let connected = connections.get(execution.task);
    if (!connected) {
      connected = connect(execution);
      connections.set(execution.task, connected);
    }
    return connected;
  };
}
