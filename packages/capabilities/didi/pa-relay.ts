import { createHash, timingSafeEqual } from 'node:crypto';
import { DIDI_TOOLS, didiEndpoint } from './contracts.js';

/** The PA host binds a random reference to its authenticated owner, task and supplier session. */
export interface DidiPALease {
  owner: string;
  taskId: string;
  requestId: string;
  expiresAt: string;
  access: 'read' | 'ride';
  readKey(): Promise<string>;
}

const hash = (value: string) => createHash('sha256').update(value).digest();
const methods = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'tools/list', 'tools/call', 'ping']);
const readTools = new Set<string>(DIDI_TOOLS);
const rideTools = new Set(['taxi_create_order', 'taxi_query_order']);

/** Mount this handler inside the PA host. Only the PA loads the official supplier credential. */
export function createDidiPARelay(transportToken: string, findLease: (reference: string) => Promise<DidiPALease | undefined>,
  fetcher: typeof fetch = fetch) {
  if (transportToken.length < 32) throw new Error('Use a private PA relay transport credential');
  return async (request: Request) => {
    if (!timingSafeEqual(hash(request.headers.get('Authorization') ?? ''), hash('Bearer ' + transportToken)))
      return new Response(null, { status: 401 });
    const reference = request.headers.get('X-EIGOS-Connection') ?? '';
    const lease = await findLease(reference);
    if (!lease || lease.owner !== request.headers.get('X-EIGOS-Owner') || lease.taskId !== request.headers.get('X-EIGOS-Task') ||
        lease.requestId !== request.headers.get('X-EIGOS-PA-Request') || !(Date.parse(lease.expiresAt) > Date.now()))
      return new Response(null, { status: 403 });
    if (!['POST', 'DELETE'].includes(request.method)) return new Response(null, { status: 405 });
    try {
      const body = request.method === 'POST' ? await request.text() : undefined;
      if (body !== undefined) {
        if (body.length > 64_000) return new Response(null, { status: 413 });
        const rpc = JSON.parse(body);
        if (!methods.has(rpc.method) || rpc.method === 'tools/call' && !readTools.has(rpc.params?.name) &&
            !(lease.access === 'ride' && rideTools.has(rpc.params?.name))) return new Response(null, { status: 403 });
      }
      const key = (await lease.readKey()).trim();
      if (!/^[A-Za-z0-9._~-]{8,1024}$/.test(key)) return new Response(null, { status: 403 });
      const target = new URL(didiEndpoint('production'));
      target.searchParams.set('key', key);
      const headers = new Headers();
      for (const name of ['Accept', 'Content-Type', 'Mcp-Session-Id', 'MCP-Protocol-Version']) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
      const upstream = await fetcher(target, { method: request.method, headers, body, redirect: 'manual', signal });
      if (!upstream.ok || upstream.redirected) return new Response(null, { status: upstream.status === 429 ? 429 : 502 });
      const responseHeaders = new Headers();
      for (const name of ['Content-Type', 'Mcp-Session-Id']) {
        const value = upstream.headers.get(name);
        if (value && !value.includes(key)) responseHeaders.set(name, value);
      }
      if (!upstream.body) return new Response(null, { status: upstream.status, headers: responseHeaders });
      const content = await upstream.text();
      if (content.length > 1_048_576 || content.includes(key)) return new Response(null, { status: 502 });
      return new Response(content, { status: upstream.status, headers: responseHeaders });
    } catch {
      return new Response(null, { status: 502 });
    }
  };
}
