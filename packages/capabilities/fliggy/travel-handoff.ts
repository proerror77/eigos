import { Conflict, digest } from '../../core/identity.js';
import type { ObjectRef } from '../../ontology/schema.js';
import { flightFacts, fliggyAccessMode, fliggyHotelFacts } from '../../ontology/service-contracts.js';
import {
  fliggyHandoffKinds,
  readTravelHandoff,
  selectTravelOffer,
  travelHandoffType,
} from '../../ontology/travel-handoff.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { currentService, assertServiceAuthority } from '../services/functions.js';
import type { ServiceResolver } from '../services/sources.js';
import { providerLink } from './connector.js';

export function fliggyHandoffFunctions(resolve: ServiceResolver): Map<string, FunctionHandler> {
  async function selected(objects: FunctionContext['objects'], offer: ObjectRef, search: ObjectRef) {
    const kind = offer.type === fliggyHandoffKinds.hotel.offer ? 'hotel' : 'flight';
    const expected = fliggyHandoffKinds[kind];
    if (offer.type !== expected.offer || search.type !== expected.search)
      throw new Conflict('Select a FlyAI offer and its matching search page');
    const row = await currentService(objects, offer, search);
    const page = await objects.read(search);
    // Search receipts are created once from a content-addressed provider observation.
    if (page.revision !== 1) throw new Conflict('The FlyAI search receipt has been edited; select a fresh offer');
    if (row.properties.provider !== 'Fliggy' || page.properties.provider !== 'Fliggy')
      throw new Conflict('The selected offer and receipt must originate from FlyAI');
    await assertServiceAuthority(
      resolve,
      objects.access.principal.owner,
      'Fliggy',
      String(row.properties.bindingId),
    );
    const facts = kind === 'hotel' ? fliggyHotelFacts.parse(row.properties) : flightFacts.parse(row.properties);
    const { url: raw, ...details } = facts;
    const url = providerLink(raw);
    if (!url) throw new Conflict('The selected FlyAI offer has no supported supplier detail link');
    return {
      kind,
      details,
      url,
      offerRevision: row.revision,
      searchRevision: page.revision,
      accessMode: fliggyAccessMode.parse(page.properties.accessMode),
      evidence: row.properties.evidence,
      observedAt: row.properties.observedAt,
      expiresAt: row.properties.expiresAt,
    };
  }
  return new Map<string, FunctionHandler>([
    [
      'prepareFliggyTravelHandoff',
      async (raw, ctx) => {
        if (!ctx.edit || !ctx.operationId || ctx.objects.model.scenario)
          throw new Conflict('Prepare the handoff through a live Action');
        const { offer, search } = selectTravelOffer.parse(raw);
        const before = await selected(ctx.objects, offer, search);
        const handoff = {
          type: travelHandoffType,
          id: digest([ctx.principal.owner, travelHandoffType, ctx.operationId]),
        };
        return ctx.edit(handoff, async (graph) => {
          const now = await selected(graph, offer, search);
          if (now.offerRevision !== before.offerRevision || now.searchRevision !== before.searchRevision)
            throw new Conflict('FlyAI selection changed; choose the current offer');
          await graph.create(handoff, {
            id: handoff.id,
            name: 'FlyAI ' + now.kind + ' handoff',
            kind: now.kind,
            offerRevision: now.offerRevision,
            searchRevision: now.searchRevision,
          });
          await graph.link({ type: offer.type + 'TravelHandoff', from: handoff, to: offer });
          await graph.link({ type: search.type + 'TravelHandoff', from: handoff, to: search });
        });
      },
    ],
    [
      'readFliggyTravelHandoff',
      async (raw, ctx) => {
        const { handoff } = readTravelHandoff.parse(raw);
        if (handoff.type !== travelHandoffType) throw new Conflict('Select a FlyAI travel handoff');
        const { properties } = await ctx.objects.read(handoff),
          kind = properties.kind;
        if (kind !== 'hotel' && kind !== 'flight') throw new Conflict('FlyAI handoff kind unavailable');
        const [offers, searches] = await Promise.all([
          ctx.objects.follow(handoff, kind + 'Offer'),
          ctx.objects.follow(handoff, kind + 'Search'),
        ]);
        if (offers.length !== 1 || searches.length !== 1)
          throw new Conflict('FlyAI handoff lacks its original offer or receipt');
        const offer = offers[0]!.ref,
          search = searches[0]!.ref,
          now = await selected(ctx.objects, offer, search);
        if (now.offerRevision !== properties.offerRevision || now.searchRevision !== properties.searchRevision)
          throw new Conflict('FlyAI selection changed; prepare a new handoff');
        return {
          handoff,
          offer,
          search,
          provider: 'Fliggy',
          accessMode: now.accessMode,
          status: 'ready_for_review',
          url: now.url,
          observedAt: now.observedAt,
          expiresAt: now.expiresAt,
          evidence: now.evidence,
          selection: { kind, details: now.details },
        };
      },
    ],
  ]);
}
