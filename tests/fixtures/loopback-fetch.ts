import { request as httpRequest } from 'node:http';

/** Synthetic TLS termination: retain canonical Host/proof URLs and prohibit every unlisted destination. */
export function loopbackFetch(routes: () => ReadonlyMap<string, string>): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init), target = new URL(request.url), origin = routes().get(target.origin);
    if (!origin) throw new Error('Fixture forbids external network');
    const headers = new Headers(request.headers); headers.set('Host', target.host);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(origin + target.pathname + target.search, { method: request.method, headers: Object.fromEntries(headers), signal: request.signal }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
        incoming.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
          resolve(new Response([204, 304].includes(incoming.statusCode!) ? null : Buffer.concat(chunks), { status: incoming.statusCode!, headers: responseHeaders }));
        });
        incoming.on('error', reject);
      });
      outgoing.on('error', reject); outgoing.end(body);
    });
  };
}
