import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { digest } from '../../core/identity.js';
import { didiEndpoint, type DidiBinding } from './contracts.js';
import { readDidiCredential } from './connector.js';
import { mapDidiResult } from './mapping.js';
import { sandboxOrderStatusText, sandboxRideStatus } from './sandbox-status.js';
import { ridePosition, rideProgress } from '../../ontology/ride-watch.js';

const text = z.string().min(1).max(500);
const commandSchemas = {
  taxi_create_order: z.strictObject({ product_category: text, estimate_trace_id: text }),
  taxi_query_order: z.strictObject({ order_id: text }),
  taxi_cancel_order: z.strictObject({ order_id: text, reason: text.optional() }),
  taxi_get_driver_location: z.strictObject({ order_id: text }),
  taxi_estimate: z.strictObject({
    from_lng: text,
    from_lat: text,
    from_name: text,
    to_lng: text,
    to_lat: text,
    to_name: text,
  }),
};
type Command = keyof typeof commandSchemas;
export const rideOrderSchema = z.strictObject({
  orderId: text,
  status: z.string().max(6000),
  state: z.enum(['created', 'reported', 'unknown']),
  independentRead: z.boolean(),
  evidence: z.enum(['live', 'provider_mock', 'synthetic']),
  observedAt: z.iso.datetime(),
  contentDigest: z.string().length(64),
});
export type RideOrder = z.infer<typeof rideOrderSchema>;
export interface RideOrders {
  readonly environment: 'production' | 'mock';
  readonly supportedCurrencies: readonly string[];
  assertAvailable(): Promise<void>;
  assertCancellationAvailable?(): Promise<void>;
  quote(
    input: Record<string, string>,
    category: string,
    signal: AbortSignal,
  ): Promise<{ traceId: string; amountMinor: string; currency: string; category: string }>;
  create(
    quote: { traceId: string; category: string },
    signal: AbortSignal,
    beforeDispatch: () => Promise<void>,
  ): Promise<RideOrder>;
  query(orderId: string, signal: AbortSignal): Promise<RideOrder>;
  queryAfterCreate?(created: RideOrder, signal: AbortSignal): Promise<RideOrder>;
  observe?(orderId: string, signal: AbortSignal): Promise<z.infer<typeof rideProgress>>;
  driverPosition?(orderId: string, signal: AbortSignal): Promise<z.infer<typeof ridePosition>>;
  cancel(orderId: string, reason: string | undefined, signal: AbortSignal, beforeDispatch: () => Promise<void>): Promise<{ order: RideOrder; acknowledgementDigest: string }>;
}
/** Mutations have a separate transport and an operator connection switch. They
 * are unreachable through the read connector or a model-selected MCP tool name. */
export class DidiOperations implements RideOrders {
  readonly environment: 'production' | 'mock';
  readonly supportedCurrencies = ['CNY'];
  constructor(
    private readonly binding: DidiBinding,
    private readonly enabled = false,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sandboxOrderId?: string,
    private readonly cancellationsEnabled = enabled,
  ) {
    this.environment = binding.environment;
    if (sandboxOrderId !== undefined && (this.environment !== 'mock' || enabled || cancellationsEnabled))
      throw new Error('A sandbox watch must use a read-only sandbox connection');
  }
  async assertAvailable() {
    if (!this.enabled) throw new Error('DIDI_ORDER_EXECUTION_DISABLED');
    await readDidiCredential(this.binding);
  }
  async assertCancellationAvailable() {
    if (!this.cancellationsEnabled) throw new Error('DIDI_ORDER_CANCELLATION_DISABLED');
    await readDidiCredential(this.binding);
  }
  private async call(
    tool: Command,
    input: Record<string, unknown>,
    signal: AbortSignal,
    beforeDispatch?: () => Promise<void>,
  ) {
    if (tool === 'taxi_create_order') await this.assertAvailable();
    if (tool === 'taxi_cancel_order') await this.assertCancellationAvailable();
    const args = commandSchemas[tool].parse(input);
    if (this.sandboxOrderId !== undefined && 'order_id' in args && args.order_id !== this.sandboxOrderId)
      throw new Error('Original sandbox order identity changed');
    const secret = await readDidiCredential(this.binding),
      url = new URL(didiEndpoint(this.binding.environment));
    url.searchParams.set('key', secret);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    let calls = 0,
      requests = 0;
    const guarded: typeof fetch = async (target, init = {}) => {
      if (String(target) !== url.href || ++requests > 20) throw new Error('Unexpected DiDi endpoint');
      if (init.method === 'POST') {
        const rpc = JSON.parse(String(init.body));
        if (
          ![
            'initialize',
            'notifications/initialized',
            'notifications/cancelled',
            'tools/list',
            'tools/call',
            'ping',
          ].includes(rpc.method)
        )
          throw new Error('Unexpected MCP operation');
        if (rpc.method === 'tools/call') {
          if (++calls !== 1 || rpc.params?.name !== tool || digest(rpc.params.arguments) !== digest(args))
            throw new Error('DiDi command changed');
          await beforeDispatch?.();
          await readDidiCredential(this.binding);
        }
      } else if (!['GET', 'DELETE'].includes(init.method ?? 'GET')) throw new Error('Unexpected method');
      const response = await this.fetcher(target, { ...init, redirect: 'error', signal: bounded });
      if (!response.body) return response;
      let bytes = 0;
      return new Response(
        response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > 1048576) throw new Error('DiDi response too large');
              controller.enqueue(chunk);
            },
          }),
        ),
        { status: response.status, headers: response.headers },
      );
    };
    const client = new Client({ name: 'eigos-didi-actions', version: '1' }),
      transport = new StreamableHTTPClientTransport(url, {
        fetch: guarded,
        reconnectionOptions: {
          maxRetries: 0,
          maxReconnectionDelay: 1000,
          initialReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      });
    try {
      await client.connect(transport, { signal: bounded, timeout: 10000 });
      let cursor: string | undefined,
        found = false;
      for (let page = 0; page < 4; page++) {
        const list = await client.listTools(cursor ? { cursor } : {}, { signal: bounded, timeout: 10000 });
        for (const item of list.tools)
          if (item.name === tool) {
            if (found) throw new Error('Duplicate DiDi command');
            found = true;
            const fields = Object.keys(commandSchemas[tool].shape);
            if (
              item.inputSchema.type !== 'object' ||
              (item.inputSchema.required ?? []).some((k) => !fields.includes(k)) ||
              fields.some((k) => (item.inputSchema.properties?.[k] as { type?: string })?.type !== 'string')
            )
              throw new Error('DiDi command schema changed');
          }
        cursor = list.nextCursor;
        if (!cursor) break;
        if (page === 3) throw new Error('DiDi tool directory incomplete');
      }
      if (!found) throw new Error('DiDi command unavailable');
      const raw = await client.callTool({ name: tool, arguments: args }, { signal: bounded, timeout: 20000 });
      if (JSON.stringify(raw).includes(secret)) throw new Error('Credential echo blocked');
      if (raw.isError) throw new Error('DiDi rejected the operation');
      return raw;
    } catch {
      throw new Error(`DiDi ${tool} request failed; inspect the original operation before retrying`);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }
  async quote(input: Record<string, string>, category: string, signal: AbortSignal) {
    const raw = await this.call('taxi_estimate', input, signal),
      data = mapDidiResult('taxi_estimate', raw);
    if (data.kind !== 'estimate') throw new Error('Invalid quote');
    const selected = data.items.filter((i) => i.productCategory === category);
    if (selected.length !== 1 || !selected[0]!.estimatedMoney)
      throw new Error('Selected ride has no exact comparable estimate');
    const traceId = z.object({ traceId: text }).parse(raw.structuredContent).traceId;
    return {
      traceId,
      category,
      amountMinor: selected[0]!.estimatedMoney!.minor,
      currency: selected[0]!.estimatedMoney!.currency,
    };
  }
  private normalize(raw: unknown, independentRead: boolean, requested?: string): RideOrder {
    const envelope = z
      .object({
        structuredContent: z.unknown().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().max(6000).optional() })).optional(),
      })
      .parse(raw);
    let orderId = requested,
      status = '',
      state: 'created' | 'reported' | 'unknown' = 'unknown';
    if (envelope.structuredContent) {
      const value = z
        .object({ orderId: text, status: z.string().optional(), statusText: z.string().optional() })
        .parse(envelope.structuredContent);
      if (requested && value.orderId !== requested) throw new Error('Original order identity changed');
      orderId = value.orderId;
      status = value.statusText ?? value.status ?? 'Provider returned no normalized status';
      state = independentRead ? 'reported' : 'created';
    } else {
      status =
        envelope.content
          ?.filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n') ?? '';
    }
    if (!orderId) throw new Error('Provider did not return an order identity');
    return rideOrderSchema.parse({
      orderId,
      status,
      state,
      independentRead,
      evidence: this.environment === 'mock' ? 'provider_mock' : 'live',
      observedAt: new Date().toISOString(),
      contentDigest: digest(raw),
    });
  }
  async create(quote: { traceId: string; category: string }, signal: AbortSignal, beforeDispatch: () => Promise<void>) {
    return this.normalize(
      await this.call(
        'taxi_create_order',
        { estimate_trace_id: quote.traceId, product_category: quote.category },
        signal,
        beforeDispatch,
      ),
      false,
    );
  }
  async query(orderId: string, signal: AbortSignal) {
    return this.normalize(await this.call('taxi_query_order', { order_id: orderId }, signal), true, orderId);
  }
  async queryAfterCreate(created: RideOrder, signal: AbortSignal) {
    const orderId = created.orderId;
    const raw = await this.call('taxi_query_order', { order_id: orderId }, signal);
    const result = this.normalize(raw, true, orderId);
    if (this.environment !== 'mock' || raw.structuredContent !== undefined) return result;
    if (created.evidence !== 'provider_mock' || created.state !== 'created' || created.independentRead)
      throw new Error('Sandbox lookup requires the original create acknowledgement');
    const { heading } = sandboxOrderStatusText(raw.content, orderId);
    sandboxRideStatus(raw.content, orderId);
    return { ...result, status: heading!, state: 'reported' as const };
  }
  async observe(orderId: string, signal: AbortSignal) {
    const raw = await this.call('taxi_query_order', { order_id: orderId }, signal);
    const receipt = { orderId, observedAt: new Date().toISOString(), contentDigest: digest(raw) };
    if (raw.structuredContent === undefined && this.sandboxOrderId === orderId)
      return rideProgress.parse({ ...receipt, ...sandboxRideStatus(raw.content, orderId) });
    const body = z.object({
      orderId: text,
      statusCode: z.union([z.number().int(), z.string().regex(/^\d{1,4}$/)]),
      driver: z.record(z.string(), z.unknown()).nullish(),
      map: z.record(z.string(), z.unknown()).nullish(),
    }).parse(raw.structuredContent);
    if (body.orderId !== orderId) throw new Error('Original provider order identity changed');
    const label = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
    const number = (value: unknown) => {
      const n = typeof value === 'number' ? value :
        typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    return rideProgress.parse({
      ...receipt, statusCode: Number(body.statusCode),
      driver: body.driver ? {
        name: label(body.driver.name), carModel: label(body.driver.carModel), carPlate: label(body.driver.carPlate),
      } : null,
      distanceKm: number(body.map?.distanceKm), etaMinutes: number(body.map?.eta),
    });
  }
  async driverPosition(orderId: string, signal: AbortSignal) {
    const raw = await this.call('taxi_get_driver_location', { order_id: orderId }, signal);
    const { orderId: observedOrder, ...point } = z.object({
      orderId: text.optional(), longitude: z.number(), latitude: z.number(),
    }).parse(raw.structuredContent);
    if (observedOrder && observedOrder !== orderId) throw new Error('Original provider order identity changed');
    return ridePosition.parse({ ...point, coordinateSystem: 'provider_unspecified', observedAt: new Date().toISOString() });
  }
  async cancel(orderId: string, reason: string | undefined, signal: AbortSignal, beforeDispatch: () => Promise<void>) {
    const reply = await this.call('taxi_cancel_order', { order_id: orderId, ...(reason ? { reason } : {}) }, signal, beforeDispatch);
    const accepted = z.object({ success: z.literal(true), orderId: text.optional() }).parse(reply.structuredContent);
    if (accepted.orderId && accepted.orderId !== orderId) throw new Error('Cancellation order identity changed');
    const raw = await this.call('taxi_query_order', { order_id: orderId }, signal);
    let order = this.normalize(raw, true, orderId);
    if (this.environment === 'mock' && raw.structuredContent === undefined) {
      // The mock returns text after cancellation. Only accept it after the
      // explicit success acknowledgement for the exact test request.
      const { heading } = sandboxOrderStatusText(raw.content, orderId);
      if (heading !== '❌ 订单已取消') throw new Error('The sandbox did not read back a canceled order');
      order = { ...order, status: '订单已取消', state: 'reported' };
    }
    return { order, acknowledgementDigest: digest(reply) };
  }
}
