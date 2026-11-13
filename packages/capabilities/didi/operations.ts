import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { digest } from '../../core/identity.js';
import { didiEndpoint, type DidiBinding } from './contracts.js';
import { readDidiCredential } from './connector.js';
import { mapDidiResult } from './mapping.js';

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
  cancel(orderId: string, reason: string, signal: AbortSignal, beforeDispatch: () => Promise<void>): Promise<RideOrder>;
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
  ) {
    this.environment = binding.environment;
  }
  async assertAvailable() {
    if (!this.enabled) throw new Error('DIDI_ORDER_EXECUTION_DISABLED');
    await readDidiCredential(this.binding);
  }
  private async call(
    tool: Command,
    input: Record<string, unknown>,
    signal: AbortSignal,
    beforeDispatch?: () => Promise<void>,
  ) {
    if (tool === 'taxi_create_order' || tool === 'taxi_cancel_order') await this.assertAvailable();
    const args = commandSchemas[tool].parse(input),
      secret = await readDidiCredential(this.binding),
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
  async cancel(orderId: string, reason: string, signal: AbortSignal, beforeDispatch: () => Promise<void>) {
    await this.call('taxi_cancel_order', { order_id: orderId, reason }, signal, beforeDispatch);
    return this.query(orderId, signal);
  }
}
