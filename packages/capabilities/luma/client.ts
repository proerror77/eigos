import { z } from 'zod';
import { eventFacts, eventSearchInput } from '../../ontology/service-contracts.js';

const event = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  start_at: z.string(),
  end_at: z.string(),
  timezone: z.string(),
  location_type: z.string(),
  location_visibility: z.enum(['public', 'guests-only']),
  access: z.enum(['view', 'manage']),
  registration_open: z.boolean(),
  require_approval: z.boolean(),
  geo_address_json: z.record(z.string(), z.unknown()).nullable(),
  display_price: z.object({ amount: z.number().int().nonnegative(), currency: z.string() }).nullable(),
});
/** The documented public API supplies the same event facts as MCP. It does not
 * expose an attendee-registration operation; organizer guest writes are excluded. */
export class LumaReadClient {
  constructor(
    private readonly credential: () => Promise<string>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async read(raw: unknown, signal: AbortSignal) {
    try {
      return await this.request(raw, signal);
    } catch {
      throw new Error('Luma source unavailable; verify account authorization and the response contract');
    }
  }
  private async request(raw: unknown, signal: AbortSignal) {
    const input = eventSearchInput.parse(raw),
      url = new URL(input.eventId ? '/v1/events/get' : '/v1/calendars/events/list', 'https://public-api.luma.com');
    if (input.query || input.location)
      throw new Error(
        'Luma discovery requires the PA MCP connection; this API connection only reads an event or calendar',
      );
    if (input.eventId) url.searchParams.set('event_id', input.eventId);
    else {
      url.searchParams.set('pagination_limit', String(input.limit));
      for (const [key, value] of Object.entries({
        after: input.after,
        before: input.before,
        pagination_cursor: input.cursor,
      }))
        if (value) url.searchParams.set(key, value);
    }
    const key = await this.credential(),
      bounded = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    const response = await this.fetcher(url, {
      headers: { 'x-luma-api-key': key, accept: 'application/json' },
      redirect: 'error',
      signal: bounded,
    });
    if (!response.ok) throw new Error(`Luma source unavailable (HTTP ${response.status})`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Luma returned no response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 1048576) {
          await reader.cancel();
          throw new Error('Luma response exceeded its bound');
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.includes(key)) throw new Error('Credential echo blocked');
    const result = JSON.parse(text);
    const page = input.eventId
      ? { entries: [event.parse(result)], has_more: false, next_cursor: undefined }
      : z
          .object({ entries: z.array(event).max(50), has_more: z.boolean(), next_cursor: z.string().optional() })
          .parse(result);
    if (page.has_more && !page.next_cursor) throw new Error('Luma pagination is incomplete');
    if (input.eventId && page.entries[0]?.id !== input.eventId) throw new Error('Luma event identity mismatch');
    const items = page.entries.map((e) => {
      const address = e.geo_address_json ?? {},
        exact = e.access === 'manage' || e.location_visibility === 'public';
      return eventFacts.parse({
        nativeId: e.id,
        name: e.name,
        url: e.url,
        status: 'unknown',
        start: e.start_at,
        end: e.end_at,
        timeZone: e.timezone,
        address: [address.address, address.city, address.region, address.country]
          .filter((x) => typeof x === 'string')
          .join(', '),
        locationPrecision:
          e.location_type === 'offline'
            ? exact && typeof address.address === 'string'
              ? 'exact'
              : 'coarse'
            : ['missing', 'unknown'].includes(e.location_type)
              ? 'unknown'
              : 'online',
        registrationOpen: e.registration_open,
        approvalRequired: e.require_approval,
        startingPrice: e.display_price?.amount ?? null,
        currency: e.display_price?.currency.toUpperCase() ?? null,
      });
    });
    return { items, complete: !page.has_more, cursor: page.next_cursor ?? null };
  }
}
