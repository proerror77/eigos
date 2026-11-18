import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { evidence, flightFacts, fliggyAccessMode, fliggyHotelFacts, json, time } from './service-contracts.js';

export const travelHandoffType = 'FliggyTravelOfferHandoff';
export const fliggyHandoffKinds = {
  hotel: { offer: 'FliggyHotelOffer', search: 'FliggyHotelSearch' },
  flight: { offer: 'FliggyFlightOffer', search: 'FliggyFlightSearch' },
} as const;
export const selectTravelOffer = z.strictObject({ offer: objectRefSchema, search: objectRefSchema });
export const readTravelHandoff = z.strictObject({ handoff: objectRefSchema });
export const travelHandoffResult = selectTravelOffer.extend({
  handoff: objectRefSchema,
  provider: z.literal('Fliggy'),
  accessMode: fliggyAccessMode,
  observedAt: time,
  expiresAt: time,
  evidence,
  status: z.literal('ready_for_review'),
  url: z.url().max(2000),
  selection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('hotel'), details: fliggyHotelFacts.omit({ url: true }) }),
    z.strictObject({ kind: z.literal('flight'), details: flightFacts.omit({ url: true }) }),
  ]),
});
const fields = {
  id: z.string(),
  name: z.string(),
  kind: z.enum(['hotel', 'flight']),
  offerRevision: z.number().int().positive(),
  searchRevision: z.number().int().positive(),
};
const links = Object.entries(fliggyHandoffKinds).flatMap(([kind, types]) =>
  (['offer', 'search'] as const).map((role) => ({
    apiName: types[role] + 'TravelHandoff',
    description: 'Selected FlyAI ' + kind + ' ' + role + ' for this handoff.',
    from: {
      type: travelHandoffType,
      name: kind + (role === 'offer' ? 'Offer' : 'Search'),
      cardinality: 'one' as const,
    },
    to: { type: types[role], name: 'travelHandoffs', cardinality: 'many' as const },
  })),
);
const dependencies = {
  objectTypes: [travelHandoffType, ...Object.values(fliggyHandoffKinds).flatMap((x) => [x.offer, x.search])],
  interfaceTypes: ['ServiceOffering', 'ServiceSearchResult'],
  linkTypes: [...links.map((x) => x.apiName), ...Object.values(fliggyHandoffKinds).map((x) => x.offer + 'Source')],
};
const sourceParameters = { offer: 'ServiceOffering', search: 'ServiceSearchResult' };
export const travelHandoffDefinition: Pick<
  OntologyDocument,
  'objectTypes' | 'interfaceTypes' | 'linkTypes' | 'functionTypes' | 'actionTypes'
> = {
  interfaceTypes: [
    {
      apiName: 'TravelOfferSelection',
      description: 'Prepare a customer review of one available supplier offer and its exact search receipt.',
      properties: { name: { description: 'Selection name', required: true, schema: { type: 'string' } } },
      optionalProperties: [],
      links: {},
      actions: {
        prepare: { parameters: json(selectTravelOffer), objectParameters: sourceParameters, required: true },
      },
    },
  ],
  objectTypes: [
    {
      apiName: travelHandoffType,
      displayName: 'Selected FlyAI travel offer',
      primaryKey: 'id',
      titleProperty: 'name',
      description: 'A selection of one dated offer and its original source page for customer review in Fliggy.',
      properties: Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [
          name,
          { description: name, required: true, schema: json(field) },
        ]),
      ),
      interfaces: {
        TravelOfferSelection: {
          properties: { name: 'name' },
          links: {},
          actions: {
            prepare: { action: 'PrepareFliggyTravelHandoff', parameters: { offer: 'offer', search: 'search' } },
          },
        },
      },
    },
  ],
  linkTypes: links,
  functionTypes: [
    {
      apiName: 'prepareFliggyTravelHandoff',
      description: 'Pin a selected FlyAI offer and its source receipt for a customer handoff.',
      parameters: json(selectTravelOffer),
      returns: json(objectRefSchema),
      edits: true,
      source: 'Fliggy',
      dependencies,
    },
    {
      apiName: 'readFliggyTravelHandoff',
      description: 'Recheck a dated FlyAI selection and return its supplier detail link and displayed price.',
      parameters: json(readTravelHandoff),
      returns: json(travelHandoffResult),
      source: 'Fliggy',
      dependencies,
    },
  ],
  actionTypes: [
    {
      apiName: 'PrepareFliggyTravelHandoff',
      description:
        'Prepare the supplier-provided hotel or flight detail link for buyer review. Supports FlyAI trial search without a supplier login.',
      parameters: json(selectTravelOffer),
      objectParameters: sourceParameters,
      submissionCriteria: [],
      function: 'prepareFliggyTravelHandoff',
    },
  ],
};
