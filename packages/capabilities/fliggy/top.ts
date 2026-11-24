import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { Conflict, ProviderAuthorizationRequired, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';

const endpoint = 'https://eco.taobao.com/router/rest';
const hotelMethods = {
  rates: ['taobao.xhotel.distribution.price', undefined],
  validate: ['taobao.xhotel.order.distribution.validate', 'validate_req'],
  create: ['taobao.xhotel.order.distribution.create', 'create_req'],
  pay: ['taobao.xhotel.order.distribution.pay', 'order_base_req'],
  detail: ['taobao.xhotel.order.distribution.detail', 'order_base_req'],
  cancel: ['taobao.xhotel.order.distribution.cancel', 'order_base_req'],
} as const;
const flightMethods = {
  search: ['alitrip.flight.service.search', 'search_flight_info_req'],
  create: ['alitrip.flight.service.airbook', 'create_order_request'],
  pay: ['alitrip.flight.service.pay', 'pay_request'],
  close: ['alitrip.flight.service.close', 'close_order_req'],
  detail: ['alitrip.flight.service.queryorderdetail', 'query_order_detail_req'],
} as const;
const credentials = z.strictObject({
  owner: z.string().min(1),
  account: z.string().min(1),
  appKey: z.string().regex(/^\d+$/),
  appSecret: z.string().min(8),
  expiresAt: z.iso.datetime(),
  enabled: z.boolean(),
});
const hotelCredentials = credentials.extend({
  distributor: z.string().min(1).max(100),
  hotelProfilesFile: z.string().min(1),
  hotelPaymentsFile: z.string().min(1).optional(),
});
const flightCredentials = credentials.extend({
  session: z.string().min(8),
  channelName: z.string().min(1).max(100),
  flightProfilesFile: z.string().min(1),
});
const record = z.record(z.string(), z.unknown());
const result = z.object({ is_success: z.boolean(), result: z.unknown() });
export const topIdentifier = z.union([z.string().regex(/^[1-9]\d{0,29}$/), z.number().int().positive().safe()]).transform(String);

// TOP order identifiers are Longs. The reviver retains an unsafe integer's
// original JSON lexeme before it can be used in a database key or a readback.
function parseTopResponse(text: string) {
  try {
    return record.parse(JSON.parse(text, (_name: string, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' && !Number.isSafeInteger(value) && /^\d+$/.test(context?.source ?? '') ? context!.source : value,
    ));
  } catch {
    throw new Conflict('Fliggy TOP returned invalid JSON');
  }
}
export function topNumber(id: string) {
  const decimal = topIdentifier.parse(id);
  const raw = (JSON as typeof JSON & { rawJSON(value: string): unknown }).rawJSON;
  return raw(decimal);
}
function configureTop<T extends z.infer<typeof credentials>>(provider: string, path: string | undefined, schema: z.ZodType<T>, testFetch?: typeof fetch) {
  const load = async (owner: string) => {
    if (!path) throw new ProviderAuthorizationRequired(provider, 'Configure the owner’s Fliggy TOP partner connection');
    const config = schema.parse(JSON.parse(await readPrivateSourceFile(path)));
    if (!config.enabled || config.owner !== owner || Date.parse(config.expiresAt) <= Date.now())
      throw new ProviderAuthorizationRequired(provider, 'The Fliggy TOP connection is unavailable for this owner');
    return config;
  };
  return async (owner: string) => {
    const config = await load(owner);
    const assertCurrent = async () => {
      if (digest(config) !== digest(await load(owner))) throw new Conflict('Fliggy TOP connection changed');
    };
    return {
      config, evidence: testFetch ? 'synthetic' as const : 'provider' as const, assertCurrent,
      async request([method, parameter]: readonly [string, string | undefined], input: Record<string, unknown>, signal: AbortSignal, session?: string) {
        await assertCurrent();
        const params = new URLSearchParams({
          method, app_key: config.appKey, format: 'json', v: '2.0', sign_method: 'hmac',
          timestamp: new Date(Date.now() + 28800000).toISOString().slice(0, 19).replace('T', ' '),
          ...(parameter ? { [parameter]: JSON.stringify(input) } : z.record(z.string(), z.string()).parse(input)),
          ...(session ? { session } : {}),
        });
        params.sort();
        const signingInput = [...params].map(([key, value]) => key + value).join('');
        params.set('sign', createHmac('md5', config.appSecret).update(signingInput, 'utf8').digest('hex').toUpperCase());
        const response = await (testFetch ?? fetch)(endpoint, {
          method: 'POST', body: params, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        });
        if (!response.ok) throw new Conflict('Fliggy TOP request failed');
        const text = await response.text();
        if (text.length > 524288) throw new Conflict('Fliggy TOP response exceeds its limit');
        const envelope = parseTopResponse(text);
        if (envelope.error_response) throw new Conflict('Fliggy TOP rejected this operation');
        const key = method.replace(/^taobao\./, '').replaceAll('.', '_') + '_response';
        const body = record.parse(envelope[key]);
        await assertCurrent();
        return body;
      },
    };
  };
}

export function configuredFliggyHotel(path?: string, testFetch?: typeof fetch) {
  const connect = configureTop('FliggyHotelDistribution', path, hotelCredentials, testFetch);
  return async (owner: string) => {
    const { config, request, assertCurrent, evidence } = await connect(owner);
    return {
      authority: digest([owner, config.appKey, config.account, config.distributor]),
      distributor: config.distributor, evidence, assertCurrent,
      profilesFile: config.hotelProfilesFile, paymentsFile: config.hotelPaymentsFile,
      async call(operation: keyof typeof hotelMethods, input: Record<string, unknown>, signal: AbortSignal) {
        const reply = await request(hotelMethods[operation], input, signal);
        if (operation === 'rates') return reply.hotel_prices_result;
        const body = result.parse(reply);
        if (!body.is_success || body.result === undefined || body.result === null)
          throw new Conflict('Fliggy did not confirm this hotel operation');
        return body.result;
      },
    };
  };
}
export type FliggyHotelResolver = ReturnType<typeof configuredFliggyHotel>;

export function configuredFliggyFlight(path?: string, testFetch?: typeof fetch) {
  const connect = configureTop('FliggyFlightJinghang', path, flightCredentials, testFetch);
  return async (owner: string) => {
    const { config, request, assertCurrent, evidence } = await connect(owner);
    return {
      authority: digest([owner, config.appKey, config.account, config.channelName, config.session]),
      channelName: config.channelName, profilesFile: config.flightProfilesFile, evidence, assertCurrent,
      async call(operation: keyof typeof flightMethods, input: Record<string, unknown>, signal: AbortSignal) {
        const body = await request(flightMethods[operation], input, signal, config.session);
        const facts = operation === 'search' ? record.parse(body.search_flight_info_res) : body;
        if (facts.is_success !== true && (operation !== 'search' || facts.is_success !== 'true'))
          throw new Conflict('Fliggy did not confirm this flight operation');
        return facts;
      },
    };
  };
}
export type FliggyFlightResolver = ReturnType<typeof configuredFliggyFlight>;
