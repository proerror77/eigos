import { Conflict, digest } from '../../core/identity.js';
import { type ObjectRef } from '../../ontology/schema.js';
import {
  marketplaceFacts, marketplacePurchaseFacts, prepareMarketplacePurchaseInput, readMarketplacePurchaseInput,
} from '../../ontology/service-contracts.js';
import { marketplacePurchaseType, marketplaceServiceCatalog } from '../../ontology/services.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { assertServiceAuthority, currentService } from '../services/functions.js';
import type { ServiceResolver } from '../services/sources.js';
import { marketplaceProductUrl } from './connector.js';

type Marketplace = (typeof marketplaceServiceCatalog)[number];

export function marketplaceFunctions(resolve: ServiceResolver) {
  const handlers = new Map<string, FunctionHandler>();
  const readOffer = async (objects: FunctionContext['objects'], service: Marketplace, ref: ObjectRef) => {
    if (ref.type !== service.object) throw new Conflict('A matching marketplace offer is required');
    const offer = await currentService(objects, ref);
    const properties = marketplaceFacts.parse(offer.properties);
    const url = marketplaceProductUrl(service.provider, properties.url, properties.productId);
    if (!url) throw new Conflict('The provider did not return a verified product link for this offer');
    await assertServiceAuthority(resolve, objects.access.principal.owner, service.provider, String(offer.properties.bindingId));
    const facts = marketplacePurchaseFacts.parse({
      provider: service.provider, name: properties.name, url, amountMinor: properties.amountMinor,
      currency: properties.currency, priceKind: properties.priceKind, status: 'awaiting_buyer',
      observedAt: offer.properties.observedAt, expiresAt: offer.properties.expiresAt, evidence: offer.properties.evidence,
    });
    return { facts, offerRevision: offer.revision };
  };

  for (const service of marketplaceServiceCatalog) {
    handlers.set(service.prepare, async (input, context) => {
      if (!context.edit || !context.operationId || context.objects.model.scenario)
        throw new Conflict('Use the marketplace purchase Action in live Ontology');
      const { offer } = prepareMarketplacePurchaseInput.parse(input);
      const { offerRevision } = await readOffer(context.objects, service, offer);
      const handoff = { type: marketplacePurchaseType, id: digest([context.principal.owner, service.purchase, context.operationId]) };
      return context.edit(handoff, async graph => {
        const current = await readOffer(graph, service, offer);
        if (current.offerRevision !== offerRevision) throw new Conflict('Marketplace offer changed; review the current offer');
        const { url: _url, ...snapshot } = current.facts;
        await graph.create(handoff, { id: handoff.id, ...snapshot, offerRevision });
        await graph.link({ type: service.object + 'PurchaseHandoff', from: handoff, to: offer });
      });
    });
  }

  handlers.set('readMarketplacePurchaseHandoff', async (input, context) => {
    const { handoff } = readMarketplacePurchaseInput.parse(input);
    if (handoff.type !== marketplacePurchaseType) throw new Conflict('A marketplace purchase handoff is required');
    const record = await context.objects.read(handoff);
    const service = marketplaceServiceCatalog.find(item => item.provider === record.properties.provider);
    if (!service) throw new Conflict('Marketplace handoff provider is unavailable');
    const offers = await context.objects.follow(handoff, service.provider === 'Taobao' ? 'taobaoOffer' : 'jdOffer');
    if (offers.length !== 1) throw new Conflict('Marketplace handoff has no unique source offer');
    const offer = offers[0]!.ref;
    const { facts, offerRevision } = await readOffer(context.objects, service, offer);
    if (record.properties.offerRevision !== offerRevision || record.properties.observedAt !== facts.observedAt)
      throw new Conflict('Marketplace offer changed; prepare a new handoff after review');
    return { ...facts, offer };
  });
  return handlers;
}
