import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { Conflict, digest, SourceReadFailure } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import type { FunctionContext } from '../../runtime/functions.js';

const toolNames = ['maps_geo', 'maps_regeocode', 'maps_text_search', 'maps_search_detail',
  'maps_around_search', 'maps_direction_walking', 'maps_direction_driving', 'maps_weather'] as const;
const webRoutes = ['/v3/assistant/coordinate/convert', '/v3/geocode/regeo', '/v3/weather/weatherInfo', '/v3/geocode/geo',
  '/v5/direction/walking', '/v5/direction/driving', '/v5/direction/bicycling', '/v5/direction/transit/integrated',
  '/v3/distance', '/v3/traffic/status/rectangle'] as const;
type Tool = typeof toolNames[number];
type WebService = typeof webRoutes[number];

export const amapMcpEndpoint = 'https://mcp.amap.com/mcp';
const setup = z.strictObject({
  owner: z.string().min(1), active: z.boolean(), expiresAt: z.iso.datetime(),
  keyFile: z.string().min(1), keySha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const sharedSetup = setup.omit({ owner: true });
type BetaAmap = { path: string; eligible(owner: string): Promise<boolean> };
const protocolMethods = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping']);
const status = z.object({ status: z.literal('1') }).passthrough();

function bounded(response: Response) {
  if (response.redirected) throw new Error('Unexpected Amap redirect');
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) throw new Error('Amap response too large');
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText });
}

export class AmapClient {
  constructor(private readonly key: string, private readonly fetcher: typeof fetch, private readonly guard: () => Promise<void>,
    readonly authorityId?: string) {}

  private async fetchResponse(target: string | URL | Request, init: RequestInit) {
    const response = await this.fetcher(target, init).catch((error: unknown) => {
      if (error instanceof TypeError || init.signal?.aborted)
        throw new SourceReadFailure('高德来源暂时不可用。', { unavailable: true });
      throw error;
    });
    if ([429, 503, 504].includes(response.status)) {
      await response.body?.cancel();
      throw new SourceReadFailure('高德来源暂时不可用。', { unavailable: true });
    }
    return bounded(response);
  }

  async mcp(name: Tool, args: Record<string, string>, outer: AbortSignal): Promise<unknown> {
    if (!toolNames.includes(name)) throw new Conflict('This Amap MCP tool is outside the published read contract');
    return this.readMcp(amapMcpEndpoint, name, args, outer);
  }

  protected async readMcp(endpoint: string, name: string, args: Record<string, unknown>, outer: AbortSignal,
    allowPlainText = false): Promise<unknown> {
    const url = new URL(endpoint);
    url.searchParams.set('key', this.key);
    const signal = AbortSignal.any([outer, AbortSignal.timeout(16000)]);
    let sent = false, guardFailure: { error: unknown } | undefined, transportFailure: SourceReadFailure | undefined;
    const client = new Client({ name: 'eigos-amap', version: '1' });
    const transport = new StreamableHTTPClientTransport(url, {
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      fetch: async (target, init) => {
        signal.throwIfAborted();
        if (String(target) !== url.href || !['POST', 'GET', 'DELETE'].includes(init?.method ?? 'GET'))
          throw new Error('Unexpected Amap MCP endpoint or method');
        if (init?.method === 'POST') {
          const packet = JSON.parse(String(init.body));
          if (packet.method === 'tools/call') {
            if (sent || packet.params?.name !== name || digest(packet.params.arguments) !== digest(args))
              throw new Error('Unexpected Amap MCP operation');
            sent = true;
            try { await this.guard(); }
            catch (error) { guardFailure = { error }; throw error; }
          } else if (!protocolMethods.has(packet.method)) throw new Error('Unsupported Amap MCP request');
        }
        signal.throwIfAborted();
        try { return await this.fetchResponse(target, { ...init, redirect: 'error', signal }); }
        catch (error) {
          if (error instanceof SourceReadFailure) transportFailure = error;
          throw error;
        }
      },
    });
    try {
      await client.connect(transport, { signal, timeout: 6000 });
      const result = await client.callTool({ name, arguments: args }, { signal, timeout: 11000 });
      if (result.isError || JSON.stringify(result).includes(this.key)) throw new Error('Amap MCP rejected the read');
      const content = result.content.filter(block => block.type === 'text');
      if (!result.structuredContent && content.length !== 1) throw new Error('Expected a single Amap MCP result');
      try { await this.guard(); }
      catch (error) { guardFailure = { error }; throw error; }
      if (result.structuredContent) return result.structuredContent;
      const text = (content[0] as { text: string }).text;
      try { return JSON.parse(text); }
      catch (error) { if (allowPlainText) return text; throw error; }
    } catch {
      outer.throwIfAborted();
      if (guardFailure) throw guardFailure.error;
      if (transportFailure) throw transportFailure;
      throw new SourceReadFailure('高德 MCP 查询失败，请检查来源授权和接口权限。', { unavailable: signal.aborted });
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }

  async web(path: WebService, args: Record<string, string>, outer: AbortSignal) {
    if (!webRoutes.includes(path)) throw new Conflict('This Amap operation is outside the published read contract');
    const url = new URL(path, 'https://restapi.amap.com');
    url.search = new URLSearchParams({ ...args, key: this.key, output: 'JSON' }).toString();
    const signal = AbortSignal.any([outer, AbortSignal.timeout(10000)]);
    await this.guard();
    signal.throwIfAborted();
    let result: z.infer<typeof status>;
    try {
      const response = await this.fetchResponse(url, { method: 'GET', signal, redirect: 'error' });
      if (!response.ok) throw new Error('Unexpected Amap HTTP status');
      result = status.parse(await response.json());
      if (JSON.stringify(result).includes(this.key)) throw new Error('Unexpected Amap response');
    } catch (error) {
      outer.throwIfAborted();
      if (error instanceof SourceReadFailure) throw error;
      throw new SourceReadFailure('高德 Web 服务查询失败，请检查来源授权和接口权限。', { unavailable: signal.aborted });
    }
    await this.guard();
    return result;
  }
}

function configuredAmapSource(path: string | undefined, source: 'Amap' | 'AmapRide', beta?: BetaAmap) {
  return async (ctx: FunctionContext) => {
    const { access, model } = ctx.objects;
    const { owner, memberAccess } = ctx.principal;
    await access.refresh();
    access.source(model, source);
    const connection = async () => {
      const own = path ? setup.parse(JSON.parse(await readPrivateSourceFile(path))) : undefined;
      const config = own?.owner === owner ? own
        : beta && memberAccess && await beta.eligible(owner)
          ? sharedSetup.parse(JSON.parse(await readPrivateSourceFile(beta.path)))
          : undefined;
      if (!config?.active || Date.parse(config.expiresAt) <= Date.now()) throw new Error('Invalid Amap binding');
      const key = (await readPrivateSourceFile(config.keyFile)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(key) || createHash('sha256').update(key).digest('hex') !== config.keySha256)
        throw new Error('Amap key missing or changed');
      return { key, binding: config === own ? digest(config) : digest([owner, config]) };
    };
    const read = () => connection().catch(() => {
      throw new SourceReadFailure(source === 'AmapRide' ? '此账号尚未绑定有效的高德打车 Web 服务 Key。'
        : '此账号尚未配置有效的高德 Web 服务连接。', { unavailable: true });
    });
    const { key, binding } = await read();
    const guard = async () => {
      ctx.signal.throwIfAborted();
      await ctx.assertCurrent?.();
      await access.refresh();
      access.source(model, source);
      if ((await read()).binding !== binding) throw new Conflict('高德来源权限已变化。');
    };
    return { key, guard, binding };
  };
}

export function configuredAmap(path?: string, fetcher: typeof fetch = fetch, beta?: BetaAmap) {
  const source = configuredAmapSource(path, 'Amap', beta);
  return async (ctx: FunctionContext) => {
    const { key, guard, binding } = await source(ctx);
    return new AmapClient(key, fetcher, guard, binding);
  };
}

export const amapRideMcpEndpoint = 'https://mcp.amap.com/rest/amap_car/dev/mcp';

class AmapRideClient extends AmapClient {
  plan(args: Record<string, unknown>, signal: AbortSignal) {
    return this.readMcp(amapRideMcpEndpoint, 'get_taxi_service', args, signal, true);
  }
}

export function configuredAmapRide(path?: string, fetcher: typeof fetch = fetch) {
  const source = configuredAmapSource(path, 'AmapRide');
  return async (ctx: FunctionContext) => {
    const { key, guard, binding } = await source(ctx);
    const client = new AmapRideClient(key, fetcher, guard, binding);
    return { plan: client.plan.bind(client), assertCurrent: guard };
  };
}

export type AmapResolver = ReturnType<typeof configuredAmap>;
