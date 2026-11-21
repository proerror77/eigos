import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, digest } from '../core/identity.js';
import { grabRideLink, validUberFare } from '../capabilities/partner-rides/handoff.js';
import {
  partnerRideQuotes, partnerRideRequest, partnerRideResponse, partnerRideServices, uberFareRange,
} from '../ontology/partner-rides.js';
import type { OntologyClient } from './client.js';

type Request = z.infer<typeof partnerRideRequest>;
type ResponseData = z.infer<typeof partnerRideResponse>;
const grantBase = partnerRideRequest.pick({ bindingId: true, environment: true }).extend({
  accessToken: z.string().regex(/^[A-Za-z0-9._~+/-]{8,8192}={0,2}$/),
  expiresAt: z.iso.datetime(),
});
export const partnerRidePAGrant = z.discriminatedUnion('provider', [
  grantBase.extend({ provider: z.literal('Uber'), riderId: z.string().min(1).max(200) }),
  grantBase.extend({ provider: z.literal('Grab') }),
]);
export type PartnerRideGrant = z.infer<typeof partnerRidePAGrant>;
const pending = z.object({
  taskId: z.uuid(), requestId: z.uuid(), kind: z.literal('pa-request'),
  capability: z.string(), input: partnerRideRequest,
});
const unavailable = (reason: Extract<ResponseData, { status: 'unavailable' }>['reason']): ResponseData =>
  ({ status: 'unavailable', reason });
const endpoint = {
  Uber: {
    production: 'https://api.uber.com/v1/rides/estimates',
    sandbox: 'https://sandbox-api.uber.com/v1/rides/estimates',
  },
  Grab: {
    production: 'https://partner-api.grab.com/farefeed/v1/estimate',
    sandbox: 'https://partner-api.stg-myteksi.com/farefeed/v1/estimate',
  },
} as const;
const uberReply = z.object({
  ride_estimate: z.object({ product_estimates: z.array(z.object({
    product: z.object({ product_id: z.string(), display_name: z.string().optional() }),
    eta: z.object({ eta_in_seconds: z.number().int().nonnegative().optional() }).optional(),
    fare: z.object({
      currency_code: z.string().optional(), point_fare: z.string().optional(), range_fare: uberFareRange.optional(),
      expires_at: z.iso.datetime({ offset: true }).optional(), no_fare: z.record(z.string(), z.unknown()).optional(),
    }).optional(),
  })).max(100).optional() }).optional(),
});
const grabReply = z.object({
  services: z.array(z.object({
    serviceID: z.number(), serviceName: z.string(), eta: z.number().int().nonnegative(),
    fare: z.object({ currency: z.string(), minFare: z.number(), maxFare: z.number() }),
    deepLink: z.string().max(8192),
  })).max(100),
});

function quoteData(request: Request, raw: unknown) {
  if (request.provider === 'Grab') {
    const quotes = grabReply.parse(raw).services.map(service => ({
      id: service.serviceID, name: service.serviceName, etaSeconds: service.eta * 60,
      currency: service.fare.currency, minAmount: service.fare.minFare, maxAmount: service.fare.maxFare,
      appLink: grabRideLink(service.deepLink, request.route, service.serviceID),
    }));
    if (!quotes.length) return;
    return partnerRideQuotes.parse({ provider: 'Grab', amountUnit: 'major', quotes });
  }
  const products = uberReply.parse(raw).ride_estimate?.product_estimates ?? [];
  const quotes = products.flatMap(({ product, fare, eta }) => {
    if (!fare || fare.no_fare || !validUberFare({ point: fare.point_fare, range: fare.range_fare, expiresAt: fare.expires_at }))
      return [];
    return [{ id: product.product_id, name: product.display_name, etaSeconds: eta?.eta_in_seconds, fare: {
      currency: fare.currency_code, point: fare.point_fare, range: fare.range_fare, expiresAt: fare.expires_at,
    } }];
  });
  if (quotes.length) return partnerRideQuotes.parse({ provider: 'Uber', amountUnit: 'provider_wire_unverified', quotes });
}

async function readBody(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing partner ride response');
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(parts).toString('utf8');
      length += value.byteLength;
      if (length > 1024 * 1024) throw new Error('Partner ride response is too large');
      parts.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Run in the original authenticated PA. The caller supplies its local, partner-approved grant. */
export class PartnerRidesPA {
  constructor(private readonly options: {
    ontology: Pick<OntologyClient, 'request'>;
    loadGrant: (request: Request, signal: AbortSignal) => Promise<PartnerRideGrant | undefined>;
    fetch?: typeof fetch;
  }) {}

  private async pending(taskId: string, signal: AbortSignal) {
    const task = await this.options.ontology.request<{ id: string; state: string; result: unknown }>(`tasks/${taskId}`, undefined, signal);
    const request = pending.parse(task.result);
    if (task.id !== taskId || task.state !== 'input-required' || request.taskId !== taskId ||
        request.capability !== partnerRideServices[request.input.provider].capability)
      throw new Conflict('The original task is not waiting for this partner ride estimate');
    return request;
  }

  async answer(taskId: string, signal = AbortSignal.timeout(30000)) {
    const request = await this.pending(z.uuid().parse(taskId), signal);
    const response = await this.estimate(request, signal);
    if (digest(await this.pending(taskId, signal)) !== digest(request))
      throw new Conflict('The original partner ride request changed');
    return this.options.ontology.request(`tasks/${taskId}/pa-response`, { requestId: request.requestId, response }, signal);
  }

  private async estimate(pendingRequest: z.infer<typeof pending>, signal: AbortSignal): Promise<ResponseData> {
    const { input } = pendingRequest;
    try {
      const load = async () => partnerRidePAGrant.optional().parse(await this.options.loadGrant(input, signal));
      const grant = await load();
      if (!grant || grant.provider !== input.provider || grant.bindingId !== input.bindingId ||
          grant.environment !== input.environment || Date.parse(grant.expiresAt) <= Date.now())
        return unavailable('authorization-required');
      const { pickup, dropoff } = input.route;
      const uberPoint = ({ address, ...point }: Request['route']['pickup']) => ({ point, oneline_address: address });
      const body = grant.provider === 'Uber' ? {
        context: { trace_id: randomUUID(), timestamp: String(Date.now()) },
        participant_spec: { requester: { user_id: grant.riderId } },
        intent: { ride_intent_spec: { origin: uberPoint(pickup), destination: uberPoint(dropoff),
          response_options: { include_product_details: true } } },
      } : { pickUp: pickup, dropOff: dropoff };
      if (digest(await this.pending(pendingRequest.taskId, signal)) !== digest(pendingRequest))
        throw new Conflict('The original partner ride request changed');
      const fingerprint = digest(grant);
      if (digest(await load() ?? null) !== fingerprint || Date.parse(grant.expiresAt) <= Date.now())
        return unavailable('authorization-required');
      const response = await (this.options.fetch ?? fetch)(endpoint[grant.provider][grant.environment], {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${grant.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.redirected || response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return unavailable([401, 403].includes(response.status) ? 'authorization-required' : 'source-unavailable');
      }
      const raw = await readBody(response, signal);
      if (raw.includes(grant.accessToken)) return unavailable('source-unavailable');
      const data = quoteData(input, JSON.parse(raw));
      const encoded = JSON.stringify(data ?? null);
      if (encoded.includes(grant.accessToken) || encoded.includes(encodeURIComponent(grant.accessToken)))
        return unavailable('source-unavailable');
      if (digest(await load() ?? null) !== fingerprint || Date.parse(grant.expiresAt) <= Date.now())
        return unavailable('authorization-required');
      return data ? { status: 'quoted', requestDigest: digest(input), observedAt: new Date().toISOString(), data }
        : unavailable('no-estimate');
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Conflict) throw error;
      return unavailable('source-unavailable');
    }
  }
}
