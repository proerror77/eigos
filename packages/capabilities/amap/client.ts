import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import type { FunctionContext } from '../../runtime/functions.js';

const toolNames = ['maps_geo', 'maps_regeocode', 'maps_text_search', 'maps_search_detail',
  'maps_around_search', 'maps_direction_walking', 'maps_direction_driving', 'maps_weather'] as const;
const webRoutes = ['/v3/assistant/coordinate/convert', '/v3/geocode/regeo', '/v3/weather/weatherInfo'] as const;
type Tool = typeof toolNames[number];
type WebService = typeof webRoutes[number];

export const amapMcpEndpoint = 'https://mcp.amap.com/mcp';
const setup = z.strictObject({
  owner: z.string().min(1), active: z.boolean(), expiresAt: z.iso.datetime(),
  keyFile: z.string().min(1), keySha256: z.string().regex(/^[a-f0-9]{64}$/),
});
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
  constructor(private readonly key: string, private readonly fetcher: typeof fetch, private readonly guard: () => Promise<void>) {}

  async mcp(name: Tool, args: Record<string, string>, outer: AbortSignal): Promise<unknown> {
    if (!toolNames.includes(name)) throw new Conflict('This Amap MCP tool is outside the published read contract');
    const url = new URL(amapMcpEndpoint);
    url.searchParams.set('key', this.key);
    const signal = AbortSignal.any([outer, AbortSignal.timeout(16000)]);
    let sent = false;
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
            await this.guard();
          } else if (!protocolMethods.has(packet.method)) throw new Error('Unsupported Amap MCP request');
        }
        signal.throwIfAborted();
        return bounded(await this.fetcher(target, { ...init, redirect: 'error', signal }));
      },
    });
    try {
      await client.connect(transport, { signal, timeout: 6000 });
      const result = await client.callTool({ name, arguments: args }, { signal, timeout: 11000 });
      if (result.isError || JSON.stringify(result).includes(this.key)) throw new Error('Amap MCP rejected the read');
      const content = result.content.filter(block => block.type === 'text');
      if (!result.structuredContent && content.length !== 1) throw new Error('Expected a single Amap MCP result');
      await this.guard();
      return result.structuredContent ?? JSON.parse((content[0] as { text: string }).text);
    } catch {
      outer.throwIfAborted();
      throw new Conflict('高德 MCP 查询失败，请检查来源授权和接口权限。');
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
    try {
      await this.guard();
      signal.throwIfAborted();
      const response = bounded(await this.fetcher(url, { method: 'GET', signal, redirect: 'error' }));
      if (!response.ok) throw new Error('Unexpected Amap HTTP status');
      const result = status.parse(await response.json());
      if (JSON.stringify(result).includes(this.key)) throw new Error('Unexpected Amap response');
      await this.guard();
      return result;
    } catch {
      outer.throwIfAborted();
      throw new Conflict('高德 Web 服务查询失败，请检查来源授权和接口权限。');
    }
  }
}

export function configuredAmap(path?: string, fetcher: typeof fetch = fetch) {
  return async (ctx: FunctionContext) => {
    const { access, model } = ctx.objects;
    await access.refresh();
    access.source(model, 'Amap');
    const connection = async () => {
      if (!path) throw new Error('Missing connection');
      const config = setup.parse(JSON.parse(await readPrivateSourceFile(path)));
      if (!config.active || config.owner !== ctx.principal.owner || Date.parse(config.expiresAt) <= Date.now())
        throw new Error('Invalid owner binding');
      const key = (await readPrivateSourceFile(config.keyFile)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(key) || createHash('sha256').update(key).digest('hex') !== config.keySha256)
        throw new Error('Amap key missing or changed');
      return { key, binding: digest(config) };
    };
    const read = () => connection().catch(() => {
      throw new Conflict('此账号尚未配置有效的高德 Web 服务连接。');
    });
    const { key, binding } = await read();
    return new AmapClient(key, fetcher, async () => {
      ctx.signal.throwIfAborted();
      await access.refresh();
      if ((await read()).binding !== binding) throw new Conflict('高德来源权限已变化。');
    });
  };
}

export type AmapResolver = ReturnType<typeof configuredAmap>;
