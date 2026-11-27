import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, digest } from '../core/identity.js';
import { readPrivateSourceFile } from '../core/private-source.js';
import { didiToolInputs } from '../capabilities/didi/contracts.js';
import { DidiReadError, type DidiMcpConnector } from '../capabilities/didi/connector.js';
import type { DidiOperations, RideOrder } from '../capabilities/didi/operations.js';
import { didiPAOrderCapability, didiPAOrderInput, didiPAOrderObservation, didiPAOrderReply, didiPAReconcileCapability, didiPAReconcileInput,
  type DidiPAOrderInput } from '../capabilities/didi/pa-order.js';
import { didiMcpConsole, didiPAAuthorizeCapability, didiPAConnectionRef, didiPAReadCapability,
  didiPAReadTool, didiPAReceipt } from '../capabilities/didi/pa-read.js';
import type { OntologyClient } from './client.js';

const requestSchema = z.object({
  kind: z.literal('pa-request'), taskId: z.uuid(), requestId: z.uuid(), capability: z.string(),
  input: z.record(z.string(), z.unknown()),
});
type Request = z.infer<typeof requestSchema>;
type Reply = z.infer<typeof didiPAOrderReply>;
const missing = (error: unknown) => typeof error === 'object' && !!error && 'code' in error && error.code === 'ENOENT';
const proof = ({ reference, quoteDigest, connectionRef }: Pick<DidiPAOrderInput, 'reference' | 'quoteDigest' | 'connectionRef'>) =>
  ({ reference, quoteDigest, connectionRef });
const observation = ({ orderId, status, observedAt, contentDigest }: RideOrder) =>
  didiPAOrderObservation.parse({ orderId, status, observedAt, contentDigest });

export interface DidiPAOptions {
  ontology: Pick<OntologyClient, 'request'>;
  privateDirectory: string;
  connection?: {
    reference: string;
    reads: Pick<DidiMcpConnector, 'discover' | 'invoke'>;
    orders: Pick<DidiOperations, 'checkOrderConnection' | 'quote' | 'create' | 'query'>;
  };
}

/** Runs only an authenticated pending task from the personal agent's EIGOS connection. */
export class DidiPA {
  constructor(private readonly options: DidiPAOptions) {
    if (!isAbsolute(options.privateDirectory)) throw new Conflict('Configure an absolute private DiDi PA directory');
    if (options.connection) didiPAConnectionRef.parse(options.connection.reference);
  }

  private async pending(taskId: string, signal: AbortSignal) {
    const task = await this.options.ontology.request<{ id: string; state: string; result: unknown }>(`tasks/${taskId}`, undefined, signal);
    const request = task.state === 'input-required' && task.id === taskId ? requestSchema.safeParse(task.result) : undefined;
    if (!request?.success || request.data.taskId !== taskId)
      throw new Conflict('The original DiDi task is no longer waiting for this request');
    return request.data;
  }

  async answer(taskId: string, signal: AbortSignal, permitDispatch = false) {
    const request = await this.pending(z.uuid().parse(taskId), signal);
    const response = await this.respond(request, signal, permitDispatch);
    if (!response) return { state: 'authorization_required', taskId, requestId: request.requestId, authorizationUrl: didiMcpConsole };
    return this.options.ontology.request(`tasks/${taskId}/pa-response`, { requestId: request.requestId, response }, signal);
  }

  private async respond(request: Request, signal: AbortSignal, permitDispatch: boolean) {
    const { connection } = this.options;
    if (request.capability === didiPAAuthorizeCapability) {
      if (!connection) return;
      const { purpose, tools } = z.object({ purpose: z.enum(['read', 'order']), tools: z.array(z.string()) }).parse(request.input);
      try {
        const available = new Set((await connection.reads.discover(signal)).enabledTools.map(tool => tool.name));
        if (purpose === 'order') await connection.orders.checkOrderConnection(signal);
        if (tools.some(tool => !tool.startsWith('taxi_') && !available.has(tool))) return;
        if (purpose === 'read' && tools.some(tool => !available.has(tool))) return;
        return { status: 'connected', connectionRef: connection.reference };
      } catch { signal.throwIfAborted(); return; }
    }
    if (request.capability === didiPAReadCapability) {
      const method = didiPAReadTool.parse(request.input.tool), args = didiToolInputs[method].parse(request.input.arguments);
      if (request.input.inputDigest !== digest(args)) throw new Conflict('The original DiDi read arguments changed');
      if (!connection || (request.input.connectionRef && request.input.connectionRef !== connection.reference))
        return { status: 'authorization_required' };
      try {
        const { data, receipt } = await connection.reads.invoke(
          { requestId: request.requestId, requestRevision: 1 }, method, args, signal);
        const { bindingId: _binding, environment: _environment, ...observed } = receipt;
        return { status: 'observed', data, receipt: didiPAReceipt.parse(observed),
          ...(request.input.connectionRef ? { connectionRef: connection.reference } : {}) };
      } catch (error) {
        signal.throwIfAborted();
        const denied = error instanceof DidiReadError && ['AUTH_REJECTED', 'PRIVATE_CREDENTIAL_UNAVAILABLE'].includes(error.code);
        return { status: denied ? 'authorization_required' : 'unavailable' };
      }
    }
    if (request.capability === didiPAReconcileCapability) {
      const input = didiPAReconcileInput.parse(request.input);
      const identity = proof(input);
      if (!connection || connection.reference !== input.connectionRef) return { ...identity, status: 'unknown' };
      const receipt = join(this.options.privateDirectory, digest(['didi-order', input.originalTaskId]) + '.json');
      let local: Reply | undefined;
      try {
        local = didiPAOrderReply.parse(JSON.parse(await readPrivateSourceFile(receipt)));
      } catch (error) { if (!missing(error)) throw error; }
      if (local && digest(proof(local)) !== digest(identity))
        throw new Conflict('The DiDi PA journal contains a different order for this task');
      if (local?.status === 'submitted' && input.acknowledgement &&
          digest(local.created) !== digest(input.acknowledgement.created))
        throw new Conflict('The original DiDi acknowledgements disagree');
      const original = local?.status === 'submitted' ? local : input.acknowledgement;
      if (!original) return { ...identity, status: 'unknown' };
      const checked = await connection.orders.query(original.created.orderId, signal).catch(() => undefined);
      signal.throwIfAborted();
      if (checked?.orderId !== original.created.orderId || checked.state !== 'reported' ||
          !checked.independentRead || checked.evidence !== 'live') return original;
      return { ...original, readback: observation(checked) };
    }
    if (request.capability !== didiPAOrderCapability || !permitDispatch)
      throw new Conflict('Use the DiDi order runner only for a pending order the user already approved');
    const input = didiPAOrderInput.parse(request.input);
    if (!connection || connection.reference !== input.connectionRef) return;
    return this.submit(request, input, connection.orders, signal);
  }

  private async submit(request: Request, input: DidiPAOrderInput, orders: NonNullable<DidiPAOptions['connection']>['orders'],
    signal: AbortSignal): Promise<Reply> {
    const directory = this.options.privateDirectory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid?.())
      throw new Conflict('Use an owned private DiDi PA directory');
    const base = join(directory, digest(['didi-order', request.taskId]));
    const receipt = base + '.json', dispatch = base + '.dispatched';
    try {
      const saved = didiPAOrderReply.parse(JSON.parse(await readPrivateSourceFile(receipt)));
      if (digest(proof(saved)) !== digest(proof(input)))
        throw new Conflict('The DiDi PA journal contains a different order for this task');
      return saved;
    } catch (error) { if (!missing(error)) throw error; }
    const data = proof(input);
    const used = await lstat(dispatch).catch(error => { if (!missing(error)) throw error; });
    if (used) return { ...data, status: 'unknown' };
    const expiry = Date.parse(input.expiresAt);
    if (Date.now() >= expiry) return { ...data, status: 'expired' };
    if (input.fare.category.includes(',')) return { ...data, status: 'unavailable' };
    const fresh = await orders.quote(input.arguments, input.fare.category, signal).catch(() => undefined);
    signal.throwIfAborted();
    if (!fresh || fresh.category !== input.fare.category || fresh.currency !== input.fare.currency)
      return { ...data, status: 'unavailable' };
    if (fresh.amountMinor !== input.fare.amountMinor)
      return { ...data, status: 'price_changed', amountMinor: fresh.amountMinor };
    let dispatchedAt: string | undefined;
    const original = await orders.create(fresh, signal, async () => {
      if (digest(await this.pending(request.taskId, signal)) !== digest(request) || Date.now() >= expiry)
        throw new Conflict('The original order is no longer approved for dispatch');
      signal.throwIfAborted();
      const file = await open(dispatch, 'wx', 0o600);
      try { await file.sync(); }
      finally { await file.close(); }
      if (Date.now() >= expiry) throw new Conflict('The approved DiDi estimate expired before dispatch');
      dispatchedAt = new Date().toISOString();
    }).catch(() => undefined);
    if (!original || !dispatchedAt || original.state !== 'created' || original.independentRead || original.evidence !== 'live')
      return { ...data, status: 'unknown' };

    const created = observation(original);
    const save = async (value: Reply) => {
      const staged = base + '.' + randomUUID();
      const file = await open(staged, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
      finally { await file.close(); }
      await rename(staged, receipt);
      return value;
    };
    const acknowledged = { ...data, status: 'submitted' as const, created, dispatchedAt };
    await save(acknowledged);
    const checked = await orders.query(original.orderId, signal).catch(() => undefined);
    if (checked?.orderId !== original.orderId || checked.state !== 'reported' || !checked.independentRead || checked.evidence !== 'live')
      return acknowledged;
    return save({ ...acknowledged, readback: observation(checked) });
  }
}
