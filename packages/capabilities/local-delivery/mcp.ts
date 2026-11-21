import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import type { LocalDeliveryProvider } from '../../ontology/local-delivery.js';
import type { FunctionContext } from '../../runtime/functions.js';

const bindingSchema = z.strictObject({
  owner: z.string().min(1),
  provider: z.enum(['TaobaoInstantDelivery', 'Hema']),
  active: z.boolean(),
  expiresAt: z.iso.datetime(),
  port: z.number().int().min(1).max(65535),
  accountRef: z.uuid(),
  tokenFile: z.string().min(1),
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type DeliveryReadTool = 'account_cross_search' | 'account_nearby_shops' | 'account_probe_menu'
  | 'account_product_detail' | 'account_retail_resolve_search';
const readTools = new Set<DeliveryReadTool>([
  'account_cross_search', 'account_nearby_shops', 'account_probe_menu', 'account_product_detail', 'account_retail_resolve_search',
]);
const protocol = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping']);
const envelope = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), data: z.unknown() }),
  z.object({ success: z.literal(false), code: z.string().optional(), error: z.string().optional() }),
]);

export function deliveryFailure(code: string | undefined, message?: string) {
  if (code === 'verification-required' || (code === 'login-failed' && message === '盒马要求人工验证，请在官方客户端完成后重试'))
    return 'verification_required';
  if (code === 'address-required' || code === 'address-changed' || code === 'selection-invalid')
    return 'address_required';
  if (code === 'login-required' || code === 'session-expired' || code === 'account-missing' || code === 'account-changed')
    return 'authorization_required';
  return 'unavailable';
}

export class DeliveryReadFailure extends Error {
  constructor(readonly state: ReturnType<typeof deliveryFailure>) {
    super('Delivery provider read did not complete');
  }
}

export async function configuredDelivery(path: string | undefined, provider: LocalDeliveryProvider, ctx: FunctionContext) {
  const grant = async () => {
    ctx.signal.throwIfAborted();
    await ctx.assertCurrent?.();
    await ctx.objects.access.refresh();
    ctx.objects.access.source(ctx.objects.model, provider);
  };
  const load = async () => {
    try {
      if (!path) throw new Error('No binding file');
      const entries = z.array(bindingSchema).max(100).parse(JSON.parse(await readPrivateSourceFile(path)));
      const matches = entries.filter(row => row.owner === ctx.principal.owner && row.provider === provider);
      if (matches.length !== 1 || !matches[0]!.active || Date.parse(matches[0]!.expiresAt) <= Date.now()) throw new Error('Invalid binding');
      const binding = matches[0]!;
      const token = (await readPrivateSourceFile(binding.tokenFile)).trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token) ||
          createHash('sha256').update(token).digest('hex') !== binding.tokenSha256) throw new Error('Invalid token');
      return { port: binding.port, accountRef: binding.accountRef, token, id: digest(binding) };
    } catch {
      throw new Conflict('Configure an active owner-bound dsh-waimai connection for ' + provider);
    }
  };
  await grant();
  const connection = await load();
  const assertBinding = async () => {
    if ((await load()).id !== connection.id) throw new Conflict('Delivery connection changed');
  };
  return { ...connection, assertBinding, check: async () => { await grant(); await assertBinding(); } };
}

type DeliveryBinding = Awaited<ReturnType<typeof configuredDelivery>>;
export type DeliveryCall = (name: DeliveryReadTool, args: Record<string, unknown>) => Promise<unknown>;

function bounded(response: Response) {
  if (!response.body) return response;
  let received = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, output) {
      received += chunk.byteLength;
      if (received > 4 * 1024 * 1024) throw new Error('Oversized delivery response');
      output.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, headers: response.headers });
}

/** The upstream host token remains in process. Exact calls terminate at its loopback Host RPC. */
export async function deliveryMcp<T>(
  connection: DeliveryBinding,
  outer: AbortSignal,
  read: (call: DeliveryCall) => Promise<T>,
  fetcher: typeof fetch,
): Promise<T> {
  const endpoint = new URL('http://127.0.0.1:' + connection.port + '/host');
  const signal = AbortSignal.any([outer, AbortSignal.timeout(30000)]);
  const client = new Client({ name: 'eigos-local-delivery', version: '1' });
  let permitted: { name: DeliveryReadTool; args: string; sent: boolean } | undefined;
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: 'Bearer ' + connection.token } },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: async (target, init) => {
      signal.throwIfAborted();
      if (String(target) !== endpoint.href || !['POST', 'GET', 'DELETE'].includes(init?.method ?? 'GET'))
        throw new Error('Unexpected MCP destination');
      if (init?.method !== 'POST') return new Response(null, { status: 405 });
      const message = JSON.parse(String(init.body));
      if (message.method === 'tools/call') {
        if (!permitted || permitted.sent || message.params?.name !== permitted.name ||
            digest(message.params.arguments) !== permitted.args) throw new Error('Unexpected delivery request');
        permitted.sent = true;
      } else if (!protocol.has(message.method)) throw new Error('Unsupported MCP method');
      return bounded(await fetcher(target, { ...init, signal, redirect: 'error' }));
    },
  });

  const call: DeliveryCall = async (name, args) => {
    if (!readTools.has(name) || permitted) throw new Error('Unsupported delivery tool');
    await connection.check();
    permitted = { name, args: digest(args), sent: false };
    try {
      const result = await client.callTool({ name, arguments: args }, { signal, timeout: 9000 });
      const [message] = result.content;
      if (result.content.length !== 1 || message?.type !== 'text' || message.text.includes(connection.token))
        throw new DeliveryReadFailure('unavailable');
      const parsed = envelope.parse(JSON.parse(message.text));
      if (!parsed.success) throw new DeliveryReadFailure(deliveryFailure(parsed.code, parsed.error));
      if (result.isError) throw new DeliveryReadFailure('unavailable');
      return parsed.data;
    } catch (error) {
      outer.throwIfAborted();
      if (error instanceof DeliveryReadFailure) throw error;
      throw new DeliveryReadFailure('unavailable');
    } finally {
      permitted = undefined;
    }
  };

  try {
    try { await client.connect(transport, { signal, timeout: 5000 }); }
    catch { outer.throwIfAborted(); throw new DeliveryReadFailure('unavailable'); }
    return await read(call);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}
