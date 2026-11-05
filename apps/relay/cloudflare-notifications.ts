import { MemoryRelayNotifications, type RelayNotifications } from '../../packages/relay/notifications.js';

export interface RelayNotificationNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/** Exactly one object per namespace, regardless of node count. Its storage API
 * is never used: restarting or losing all state only causes a final PG read. */
export class RelayNotificationObject {
  private readonly notifications = new MemoryRelayNotifications();
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/revision') return Response.json({ revision: await this.notifications.snapshot() });
    if (request.method === 'POST' && path === '/notify') { await this.notifications.notify(); return new Response(null, { status: 204 }); }
    if (request.method !== 'POST' || path !== '/wait') return new Response(null, { status: 404 });
    const text = await request.text();
    if (text.length > 256) return new Response(null, { status: 400 });
    let value: { revision?: unknown; milliseconds?: unknown };
    try { value = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
    if (!value || typeof value.revision !== 'string' || value.revision.length > 64 || !Number.isInteger(value.milliseconds)
      || Number(value.milliseconds) < 0 || Number(value.milliseconds) > 25000) return new Response(null, { status: 400 });
    await this.notifications.wait(value.revision, Number(value.milliseconds), request.signal);
    return new Response(null, { status: 204 });
  }
}

/** This HTTP exchange is private to the runtime binding; the Relay exposes no
 * new public endpoint or client notification protocol. */
export function cloudflareRelayNotifications(namespace: RelayNotificationNamespace): RelayNotifications {
  const stub = namespace.get(namespace.idFromName('relay-notifications'));
  async function call(path: string, body?: unknown, signal?: AbortSignal) {
    const response = await stub.fetch(new Request('https://relay-notification.internal/' + path, {
      method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(26000)]) : AbortSignal.timeout(1000),
    }));
    if (!response.ok) throw new Error('Relay notifications unavailable');
    return response;
  }
  return {
    async snapshot() {
      const value = await (await call('revision')).json() as { revision?: unknown };
      if (typeof value.revision !== 'string' || value.revision.length > 64) throw new Error('Invalid Relay notification revision');
      return value.revision;
    },
    async wait(revision, milliseconds, signal) { await call('wait', { revision, milliseconds: Math.min(25000, Math.max(0, Math.ceil(milliseconds))) }, signal); },
    async notify() { await call('notify', {}); },
  };
}
