import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../../core/identity.js';
import {
  serviceName,
  serviceObservation,
  type ServiceName,
  type ServiceObservation,
  hotelSearchInput,
  productSearchInput,
} from '../../ontology/service-contracts.js';
import { LumaReadClient } from '../luma/client.js';
import { RollingGoSearchConnector } from '../rollinggo/connector.js';
import { ShopifyCatalogAccess, ShopifyReadOnlyClient } from '../shopify/read-only.js';

export interface ServiceSource {
  bindingId: string;
  provider: ServiceName;
  read(input: Record<string, unknown>, signal: AbortSignal): Promise<ServiceObservation>;
  assertCurrent(): Promise<void>;
}
export type ServiceResolver = (owner: string, provider: ServiceName) => Promise<ServiceSource>;
export class ServiceAuthorizationRequired extends Error {}
export const unavailableServices: ServiceResolver = async () => {
  throw new ServiceAuthorizationRequired(
    'SERVICE_AUTHORIZATION_REQUIRED: configure the owner-scoped service connection',
  );
};

const connection = z.strictObject({
  owner: z.string().min(1),
  provider: serviceName,
  bindingId: z.string().min(1).max(100),
  active: z.boolean(),
  expiresAt: z.iso.datetime(),
  credentialFile: z.string().min(1),
  credentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
async function privateFile(path: string) {
  if (!isAbsolute(path)) throw new Error('Service credentials require an absolute private path');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 65536 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Private service configuration unavailable');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
/** Configuration grants source access to one owner; it never grants booking or
 * payment authority. Secrets and raw provider responses are not Ontology rows. */
export function configuredServices(path?: string): ServiceResolver {
  if (!path) return unavailableServices;
  const load = async () =>
    z
      .array(connection)
      .max(100)
      .parse(JSON.parse(await privateFile(path)));
  return async (owner, provider) => {
    const entries = (await load()).filter((c) => c.owner === owner && c.provider === provider);
    if (entries.length === 0)
      throw new ServiceAuthorizationRequired('SERVICE_AUTHORIZATION_REQUIRED: no owner connection');
    if (entries.length !== 1) throw new Error('Ambiguous service connection');
    const binding = entries[0]!,
      fingerprint = digest(binding);
    const credential = async () => {
      const text = (await privateFile(binding.credentialFile)).trim();
      if (createHash('sha256').update(text).digest('hex') !== binding.credentialSha256)
        throw new Error('Service credential changed');
      return text;
    };
    const assertCurrent = async () => {
      const now = (await load()).filter((c) => c.owner === owner && c.provider === provider);
      if (
        !binding.active ||
        Date.parse(binding.expiresAt) <= Date.now() ||
        now.length !== 1 ||
        digest(now[0]) !== fingerprint
      )
        throw new Error('Service connection expired or was revoked');
      await credential();
    };
    await assertCurrent();
    return {
      provider,
      bindingId: binding.bindingId,
      assertCurrent,
      async read(input, signal) {
        await assertCurrent();
        let result: { items: unknown[]; complete: boolean; cursor: string | null };
        if (provider === 'Luma') result = await new LumaReadClient(credential).read(input, signal);
        else if (provider === 'RollingGo') {
          const q = hotelSearchInput.parse(input);
          const response = await new RollingGoSearchConnector(binding.credentialFile, binding.credentialSha256).search(
            {
              originQuery: q.place,
              place: q.place,
              placeType: 'city',
              checkInParam: { checkInDate: q.checkIn, stayNights: q.nights, adultCount: q.adults },
              localeParam: { currency: q.currency, language: 'zh' },
              size: q.limit,
            },
            signal,
          );
          result = {
            complete: false,
            cursor: null,
            items: response.hotels.map((h) => ({
              nativeId: String(h.hotelId),
              name: h.name || h.nameEn || String(h.hotelId),
              address: h.address ?? '',
              checkIn: q.checkIn,
              nights: q.nights,
              adults: q.adults,
              amount: h.price?.hasPrice ? (h.price.lowestPrice ?? null) : null,
              currency: h.price?.currency ?? q.currency,
              priceKind: 'reference',
            })),
          };
        } else {
          const q = productSearchInput.parse(input);
          let secret: { clientId: string; clientSecret: string };
          try {
            secret = z
              .strictObject({ clientId: z.string(), clientSecret: z.string() })
              .parse(JSON.parse(await credential()));
          } catch {
            throw new Error('Private Shopify credential configuration is invalid');
          }
          const access = await ShopifyCatalogAccess.exchange(secret.clientId, secret.clientSecret, signal),
            client = new ShopifyReadOnlyClient({ access });
          const response = await client.read(
            'search_catalog',
            { query: q.query, context: { address_country: q.country }, pagination: { limit: q.limit } },
            signal,
          );
          result = {
            complete: false,
            cursor: null,
            items: response.value.products.flatMap((p) =>
              p.variants
                .filter((v) => v.seller)
                .map((v) => ({
                  nativeId: `${v.seller!.id}/${v.id}`,
                  name: p.title,
                  productId: p.id,
                  variantId: v.id,
                  sellerId: v.seller!.id,
                  merchantDomain: v.seller!.domain,
                  amountMinor: v.price?.amount ?? null,
                  currency: v.price?.currency ?? null,
                  available: v.availability?.available ?? null,
                  deliveryTime: 'unknown',
                })),
            ),
          };
        }
        await assertCurrent();
        const observedAt = new Date().toISOString();
        return serviceObservation.parse({
          provider,
          bindingId: binding.bindingId,
          observedAt,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          evidence: 'live_readonly',
          ...result,
          inputDigest: digest(input),
          contentDigest: digest(result),
        });
      },
    };
  };
}
