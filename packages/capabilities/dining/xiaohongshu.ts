import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import { noteSearch, noteSource, notesResult } from '../../ontology/dining.js';
import type { FunctionContext } from '../../runtime/functions.js';

const connection = z.strictObject({
  owner: z.string().min(1), active: z.boolean(), expiresAt: z.iso.datetime(),
  endpoint: z.url(), tokenFile: z.string().min(1).optional(),
});
const feed = z.object({
  id: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
  noteCard: z.object({ displayTitle: z.string().max(400).optional(), title: z.string().max(400).optional() }).optional(),
});
const protocol = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping']);
const tool = 'search_feeds';

function limited(response: Response) {
  if (!response.body) return response;
  let received = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, stream) {
      received += chunk.byteLength;
      if (received > 2 * 1024 * 1024) throw new Error('Oversized restaurant search response');
      stream.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, headers: response.headers });
}

export function configuredNoteSearch(path: string, fetcher: typeof fetch = fetch) {
  return async (ctx: FunctionContext, input: z.output<typeof noteSearch>) => {
    const access = ctx.objects.access, model = ctx.objects.model;
    const authorize = async () => {
      ctx.signal.throwIfAborted();
      await ctx.assertCurrent?.();
      await access.refresh();
      access.source(model, noteSource);
      try {
        const config = connection.parse(JSON.parse(await readPrivateSourceFile(path)));
        const url = new URL(config.endpoint);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (!config.active || config.owner !== ctx.principal.owner || Date.parse(config.expiresAt) <= Date.now() ||
          url.username || url.password || url.search || url.hash ||
          (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
          (!loopback && !config.tokenFile)) throw new Error('Inactive or insecure connection');
        const token = config.tokenFile ? (await readPrivateSourceFile(config.tokenFile)).trim() : undefined;
        if (token !== undefined && !/^[A-Za-z0-9_.~+/=-]{16,1024}$/.test(token)) throw new Error('Invalid credential');
        return { endpoint: url.href, token, authority: digest([config, token]) };
      } catch {
        throw new Conflict('The authorized Xiaohongshu search connection is unavailable');
      }
    };
    const configured = await authorize();
    const check = async () => {
      if ((await authorize()).authority !== configured.authority) throw new Conflict('Xiaohongshu source authorization changed');
    };
    const query = async () => {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(35000)]);
      const client = new Client({ name: 'eigos-restaurant-notes', version: '1' });
      let searched = false;
      const transport = new StreamableHTTPClientTransport(new URL(configured.endpoint), {
        requestInit: { headers: configured.token ? { Authorization: 'Bearer ' + configured.token } : {} },
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        fetch: async (target, init) => {
          signal.throwIfAborted();
          if (String(target) !== configured.endpoint || !['GET', 'POST', 'DELETE'].includes(init?.method ?? 'GET')) throw new Error('Unexpected connector target');
          if (init?.method === 'POST') {
            const message = JSON.parse(String(init.body));
            if (message.method === 'tools/call') {
              if (searched || message.params?.name !== tool || message.params?.arguments?.keyword !== input.query) throw new Error('Unexpected Xiaohongshu operation');
              searched = true;
              await check();
            } else if (!protocol.has(message.method)) throw new Error('Unexpected MCP request');
          }
          return limited(await fetcher(target, { ...init, signal, redirect: 'error' }));
        },
      });
      try {
        await client.connect(transport, { signal, timeout: 6000 });
        const result = await client.callTool({ name: tool, arguments: { keyword: input.query, filters: { sort_by: '最新' } } }, { signal, timeout: 28000 });
        const [message] = result.content;
        if (result.isError || (!result.structuredContent && (result.content.length !== 1 || message?.type !== 'text'))) {
          throw new Error('Unrecognized search response');
        }
        const payload = result.structuredContent ?? JSON.parse((message as { text: string }).text);
        const rows = z.union([z.object({ feeds: z.array(z.unknown()).max(200) }), z.array(z.unknown()).max(200)])
          .transform(value => Array.isArray(value) ? value : value.feeds).parse(payload);
        const notes = new Map<string, { title: string; url: string }>();
        for (const row of rows) {
          const parsed = feed.safeParse(row);
          if (!parsed.success) continue;
          const { id, noteCard } = parsed.data;
          const title = (noteCard?.displayTitle || noteCard?.title)?.trim().slice(0, 200);
          if (title && (!configured.token || !title.includes(configured.token)) && !notes.has(id)) {
            notes.set(id, { title, url: 'https://www.xiaohongshu.com/explore/' + id });
          }
          if (notes.size === input.limit) break;
        }
        await check();
        return notesResult.parse({ status: 'available', evidence: 'provider', observedAt: new Date().toISOString(), notes: [...notes.values()] });
      } catch {
        ctx.signal.throwIfAborted();
        throw new Conflict('The Xiaohongshu connector did not return a usable read-only search result');
      } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      }
    };
    const execution = ctx.execution;
    const key = digest({ source: noteSource, input, authority: configured.authority });
    const result = execution
      ? await execution.tasks.readSource(execution.task, key, input, query)
      : await query();
    await check();
    return notesResult.parse(result);
  };
}
