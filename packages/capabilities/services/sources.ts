import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digest, SourceReadFailure } from '../../core/identity.js';
import {
  serviceObservation,
  fliggyFlightObservation,
  fliggyHotelObservation,
  marketplaceObservation,
  type ServiceName,
  type ServiceObservation,
  hotelSearchInput,
  productSearchInput,
} from '../../ontology/service-contracts.js';
import { searchFliggy, type FlyAIRead } from '../fliggy/connector.js';
import { LumaReadClient } from '../luma/client.js';
import { searchMarketplace } from '../marketplace/connector.js';
import { RollingGoSearchConnector } from '../rollinggo/connector.js';
import { SHOPIFY_AGENT_PROFILE_PATH, SHOPIFY_TEST_PROFILE, ShopifyCatalogAccess, ShopifyReadOnlyClient } from '../shopify/read-only.js';

export interface ServiceSource {
  bindingId: string;
  provider: ServiceName;
  read(input: Record<string, unknown>, signal: AbortSignal): Promise<ServiceObservation>;
  assertCurrent(): Promise<void>;
}
export type ServiceResolver = (owner: string, provider: ServiceName) => Promise<ServiceSource>;
export class ServiceAuthorizationRequired extends SourceReadFailure {
  constructor(message: string) { super(message, { unavailable: true }); }
}
export const unavailableServices: ServiceResolver = async () => {
  throw new ServiceAuthorizationRequired(
    'SERVICE_AUTHORIZATION_REQUIRED: configure the owner-scoped service connection',
  );
};

const connectionBase = z.strictObject({
  owner: z.string().min(1),
  bindingId: z.string().min(1).max(100),
  active: z.boolean(),
  expiresAt: z.iso.datetime(),
});
const credentialFields = {
  credentialFile: z.string().min(1),
  credentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
};
const connection = z.union([
  connectionBase.extend({ provider: z.enum(['Luma', 'RollingGo', 'Shopify', 'Taobao', 'JD']), ...credentialFields }),
  connectionBase.extend({ provider: z.literal('Shopify'), mode: z.literal('public_catalog') }),
  connectionBase.extend({ provider: z.literal('Fliggy'), mode: z.literal('trial') }),
  connectionBase.extend({ provider: z.literal('Fliggy'), mode: z.literal('key'), ...credentialFields }),
]);
export async function privateFile(path: string) {
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
async function shopifyAccess(credential: () => Promise<string>, signal: AbortSignal) {
  let secret: { clientId: string; clientSecret: string };
  try {
    secret = z.strictObject({ clientId: z.string(), clientSecret: z.string() }).parse(JSON.parse(await credential()));
  } catch {
    throw new SourceReadFailure('Private Shopify credential configuration is invalid', { unavailable: true });
  }
  return ShopifyCatalogAccess.exchange(secret.clientId, secret.clientSecret, signal);
}
type CatalogHost = { PUBLIC_URL?: string; EIGOS_AUTH_MODE?: string };

function catalogAgentProfile(host: CatalogHost) {
  const url = z.url().safeParse(host.PUBLIC_URL);
  if (!url.success) throw new SourceReadFailure('Shopify public catalog requires the Gateway public URL', { unavailable:true });
  const base = new URL(url.data);
  if (host.EIGOS_AUTH_MODE === 'development' && process.env.NODE_ENV !== 'production' &&
      base.protocol === 'http:' && ['127.0.0.1','localhost'].includes(base.hostname))
    return SHOPIFY_TEST_PROFILE;
  if (base.protocol !== 'https:' || base.origin !== url.data)
    throw new SourceReadFailure('Shopify public catalog requires the HTTPS Gateway origin', { unavailable:true });
  return new URL(SHOPIFY_AGENT_PROFILE_PATH,base).href;
}

/** Configuration grants source access to one owner; it never grants booking or
 * payment authority. Secrets and raw provider responses are not Ontology rows. */
export function configuredServices(path?: string, flyAIRead?: FlyAIRead, catalogFetch?: typeof fetch,
  host: CatalogHost = { PUBLIC_URL:process.env.PUBLIC_URL, EIGOS_AUTH_MODE:process.env.EIGOS_AUTH_MODE },
  beta?: { trialUntil: string; eligible(owner: string): Promise<boolean> }): ServiceResolver {
  if (!path && !beta) return unavailableServices;
  const load = async () => {
    if (!path) return [];
    try { return z.array(connection).max(100).parse(JSON.parse(await privateFile(path))); }
    catch {
      throw new SourceReadFailure('Private service configuration is unavailable', { unavailable: true });
    }
  };
  const select = async (owner: string, provider: ServiceName): Promise<z.infer<typeof connection>> => {
    const entries = (await load()).filter((c) => c.owner === owner && c.provider === provider);
    if (entries.length > 1) throw new SourceReadFailure('Ambiguous service connection', { unavailable: true });
    if (entries[0]) return entries[0];
    if (provider === 'Fliggy' && beta && Date.parse(beta.trialUntil) > Date.now() && await beta.eligible(owner)) {
      return { owner, provider, mode: 'trial', bindingId: 'beta-flyai-trial', active: true, expiresAt: beta.trialUntil };
    }
    throw new ServiceAuthorizationRequired('SERVICE_AUTHORIZATION_REQUIRED: no owner connection');
  };
  return async (owner, provider) => {
    const binding = await select(owner, provider), fingerprint = digest(binding);
    const marketplace = binding.provider === 'Taobao' || binding.provider === 'JD';
    const publicCatalog = binding.provider === 'Shopify' && 'mode' in binding;
    const agentProfile = publicCatalog ? catalogAgentProfile(host) : undefined;
    const bindingId = publicCatalog ? binding.bindingId + ':' + digest({ binding, agentProfile }) : binding.provider === 'Fliggy' || marketplace ? binding.bindingId + ':' + fingerprint : binding.bindingId;
    const credential = async () => {
      if (!('credentialFile' in binding))
        throw new SourceReadFailure('Service connection has no private credential', { unavailable: true });
      const text = await privateFile(binding.credentialFile).catch(() => {
        throw new SourceReadFailure('Service credential is unavailable', { unavailable: true });
      });
      if (createHash('sha256').update(text.trim()).digest('hex') !== binding.credentialSha256)
        throw new SourceReadFailure('Service credential changed', { unavailable: true });
      return text.trim();
    };
    const assertCurrent = async () => {
      const now = await select(owner, provider);
      if (!binding.active || Date.parse(binding.expiresAt) <= Date.now() || digest(now) !== fingerprint)
        throw new SourceReadFailure('Service connection expired or was revoked', { unavailable: true });
      if ('credentialFile' in binding) await credential();
    };
    await assertCurrent();
    return {
      provider,
      bindingId,
      assertCurrent,
      async read(input, signal) {
        await assertCurrent();
        let result: { items: unknown[]; complete: boolean; cursor: string | null };
        let resultSchema: z.ZodType<ServiceObservation> = serviceObservation;
        let accessMode: 'trial' | 'key' | undefined;
        if (binding.provider === 'Fliggy') {
          accessMode = binding.mode;
          const page = await searchFliggy(input, accessMode === 'key' ? await credential() : undefined, signal, flyAIRead);
          result = { items: page.items, complete: false, cursor: null };
          resultSchema = page.kind === 'flight' ? fliggyFlightObservation : fliggyHotelObservation;
        } else if (binding.provider === 'Luma') result = await new LumaReadClient(credential).read(input, signal);
        else if (binding.provider === 'RollingGo') {
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
        } else if (binding.provider === 'Taobao' || binding.provider === 'JD') {
          const items = await searchMarketplace(binding.provider, input, await credential(), signal, catalogFetch);
          result = { items, complete: false, cursor: null };
          resultSchema = marketplaceObservation;
        } else {
          const q = productSearchInput.parse(input);
          const client = publicCatalog
            ? new ShopifyReadOnlyClient({ agentProfile }, catalogFetch)
            : new ShopifyReadOnlyClient({ access: await shopifyAccess(credential, signal) });
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
        const observedAt = Date.now();
        return resultSchema.parse({
          provider,
          bindingId,
          ...(accessMode ? { accessMode } : {}),
          observedAt: new Date(observedAt).toISOString(),
          expiresAt: new Date(Math.min(observedAt + 300000, Date.parse(binding.expiresAt))).toISOString(),
          evidence: (binding.provider === 'Fliggy' && flyAIRead || (marketplace || publicCatalog) && catalogFetch) ? 'provider_mock' : 'live_readonly',
          ...result,
          inputDigest: digest(input),
          contentDigest: digest(result),
        });
      },
    };
  };
}
