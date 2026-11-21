import { z } from 'zod';
import { Conflict, digest, SourceReadFailure } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import { json } from '../../ontology/service-contracts.js';
import {
  partnerRideEnvironment, partnerRideProvider, partnerRideRequest, partnerRideResponse,
  partnerRideRoute, partnerRideServices,
} from '../../ontology/partner-rides.js';
import type { FunctionHandler } from '../../runtime/functions.js';
import { PARequests } from '../../runtime/pa.js';
import { grabRideLink, uberRideLink, validUberFare } from './handoff.js';

const connections = z.array(z.strictObject({
  owner: z.string().min(1).max(200), provider: partnerRideProvider,
  environment: partnerRideEnvironment, bindingId: z.uuid(),
  active: z.boolean(), expiresAt: z.iso.datetime(),
})).max(100);
const responseSchema = json(partnerRideResponse);
const unavailable = { status: 'unavailable', reason: 'authorization-required' } as const;

export function partnerRideFunctions(path?: string) {
  return new Map<string, FunctionHandler>(partnerRideProvider.options.map(provider => {
    const { capability, function: name } = partnerRideServices[provider];
    return [name, async (input, context) => {
      if (!path) return unavailable;
      const route = partnerRideRoute.parse(input);
      const load = async () => {
        try {
          const configured = connections.parse(JSON.parse(await readPrivateSourceFile(path)));
          const matches = configured.filter(item => item.owner === context.principal.owner && item.provider === provider);
          if (matches.length !== 1 || !matches[0]!.active || Date.parse(matches[0]!.expiresAt) <= Date.now()) return;
          return matches[0]!;
        } catch {
          throw new SourceReadFailure('Private partner ride configuration is unavailable', { unavailable: true });
        }
      };
      const binding = await load();
      if (!binding) return unavailable;
      const execution = context.execution;
      if (!execution) throw new Conflict('Request this partner ride estimate on the original Personal Agent task');
      const request = partnerRideRequest.parse({ provider, route, bindingId: binding.bindingId, environment: binding.environment });
      const fingerprint = digest(binding);
      const reply = await new PARequests(execution.tasks).requestWithId(
        execution.task, digest([capability, request, fingerprint]), capability, request, responseSchema,
      );
      if (digest(await load() ?? null) !== fingerprint) throw new Conflict('The partner ride authorization changed');
      const answer = partnerRideResponse.parse(reply.response);
      if (answer.status === 'unavailable') return answer;
      const now = Date.now();
      const observedAt = Date.parse(answer.observedAt);
      if (answer.requestDigest !== digest(request) || answer.data.provider !== provider ||
          observedAt < reply.requestedAt.getTime() - 5000 || observedAt > now + 5000 || now - observedAt >= 300000)
        throw new Conflict('The partner estimate does not match the original current PA request');
      const { data } = answer;
      const ids = data.quotes.map(quote => quote.id);
      if (new Set(ids).size !== ids.length) throw new Conflict('The partner estimate contains duplicate vehicles');
      const quotes = data.provider === 'Uber'
        ? data.quotes.filter(quote => validUberFare(quote.fare, now))
          .map(quote => ({ ...quote, appLink: uberRideLink(route, quote.id) }))
        : data.quotes.map(quote => {
          if (quote.minAmount > quote.maxAmount) throw new Conflict('Invalid Grab fare range');
          try { return { ...quote, appLink: grabRideLink(quote.appLink, route, quote.id) }; }
          catch { throw new Conflict('Invalid Grab handoff for the original route'); }
        });
      if (!quotes.length) return { status: 'unavailable', reason: 'no-estimate' };
      return { status: 'quoted', provider, route, environment: binding.environment, observedAt: answer.observedAt,
        amountUnit: data.amountUnit, quotes, evidence: 'pa_reported', paRequestId: reply.requestId,
        handoff: 'user_action_required', orderCreated: false, paymentInitiated: false };
    }];
  }));
}
