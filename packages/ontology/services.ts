import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import {
  attachServiceInput,
  commonOffer,
  eventFacts,
  hotelFacts,
  fliggyHotelFacts,
  flightFacts,
  productFacts,
  marketplaceFacts,
  marketplaceObservation,
  marketplacePurchaseFacts,
  prepareMarketplacePurchaseInput,
  readMarketplacePurchaseInput,
  eventSearchInput,
  hotelSearchInput,
  flightSearchInput,
  productSearchInput,
  serviceObservation,
  fliggyAccessMode,
  fliggyHotelObservation,
  fliggyFlightObservation,
  readServiceInput,
  readServiceSearchPagesInput,
  readTravelOfferSearchInput,
  travelOfferSearchInput,
  travelOfferSearchOutcomes,
  json,
  time,
  evidence,
} from './service-contracts.js';

/** Business interfaces are shared; these are the concrete source implementations. */
const searchContracts = {
  EventSearch: eventSearchInput,
  HotelSearch: hotelSearchInput,
  ProductSearch: productSearchInput,
};
const coreServiceCatalog = [
  {
    provider: 'Luma',
    object: 'LumaEvent',
    result: 'LumaEventSearch',
    searchInterface: 'EventSearch',
    source: 'LumaEvents',
    read: 'readLumaEvents',
    search: 'searchLumaEvents',
    action: 'SearchLumaEvents',
    parameters: eventSearchInput,
    facts: eventFacts,
    observation: serviceObservation,
  },
  {
    provider: 'RollingGo',
    object: 'RollingGoHotelOffer',
    result: 'RollingGoHotelSearch',
    searchInterface: 'HotelSearch',
    source: 'RollingGoHotels',
    read: 'readRollingGoHotels',
    search: 'searchRollingGoHotels',
    action: 'SearchRollingGoHotels',
    parameters: hotelSearchInput,
    facts: hotelFacts,
    observation: serviceObservation,
  },
  {
    provider: 'Shopify',
    object: 'ShopifyProductOffer',
    result: 'ShopifyProductSearch',
    searchInterface: 'ProductSearch',
    source: 'ShopifyProducts',
    read: 'readShopifyProducts',
    search: 'searchShopifyProducts',
    action: 'SearchShopifyProducts',
    parameters: productSearchInput,
    facts: productFacts,
    observation: serviceObservation,
  },
] as const;
const fliggyServiceCatalog = [
  {
    provider: 'Fliggy',
    object: 'FliggyHotelOffer',
    result: 'FliggyHotelSearch',
    searchInterface: 'HotelSearch',
    source: 'FliggyHotels',
    read: 'readFliggyHotels',
    search: 'searchFliggyHotels',
    action: 'SearchFliggyHotels',
    parameters: hotelSearchInput,
    facts: fliggyHotelFacts,
    observation: fliggyHotelObservation,
    terms: 'FlyAI finds hotels by place and dates. Use CNY. Adults is requested occupancy and FlyAI has not verified it. Keep masked and starting prices as displayed.',
  },
  {
    provider: 'Fliggy',
    object: 'FliggyFlightOffer',
    result: 'FliggyFlightSearch',
    searchInterface: 'FlightSearch',
    source: 'FliggyFlights',
    read: 'readFliggyFlights',
    search: 'searchFliggyFlights',
    action: 'SearchFliggyFlights',
    parameters: flightSearchInput,
    facts: flightFacts,
    observation: fliggyFlightObservation,
    terms: 'FlyAI returns dated flight candidates with local times and displayed fares. Passenger totals, taxes, seats and fare terms require provider confirmation.',
  },
] as const;
export const marketplaceServiceCatalog = [
  {
    provider: 'Taobao',
    object: 'TaobaoProductOffer',
    result: 'TaobaoProductSearch',
    searchInterface: 'ProductSearch',
    source: 'TaobaoProducts',
    read: 'readTaobaoProducts',
    search: 'searchTaobaoProducts',
    action: 'SearchTaobaoProducts',
    prepare: 'prepareTaobaoPurchase',
    purchase: 'PrepareTaobaoPurchase',
    parameters: productSearchInput,
    facts: marketplaceFacts,
    observation: marketplaceObservation,
    terms: 'Search the eligible Taobao and Tmall affiliate catalog in CN. Prices are reference amounts; inventory, options and checkout total require buyer verification.',
  },
  {
    provider: 'JD',
    object: 'JdProductOffer',
    result: 'JdProductSearch',
    searchInterface: 'ProductSearch',
    source: 'JdProducts',
    read: 'readJdProducts',
    search: 'searchJdProducts',
    action: 'SearchJdProducts',
    prepare: 'prepareJdPurchase',
    purchase: 'PrepareJdPurchase',
    parameters: productSearchInput,
    facts: marketplaceFacts,
    observation: marketplaceObservation,
    terms: 'Search the eligible JD Union catalog in CN. Prices are reference amounts; inventory, delivery and checkout total require buyer verification.',
  },
] as const;
export const serviceCatalog = [...coreServiceCatalog, ...fliggyServiceCatalog, ...marketplaceServiceCatalog] as const;
export const travelOfferSources = serviceCatalog.filter(service =>
  service.searchInterface === 'HotelSearch' || service.searchInterface === 'FlightSearch',
);
export const travelOfferSearchType = 'TravelOfferSearch';

const properties = (shape: Record<string, z.ZodType>) =>
  Object.fromEntries(
    Object.entries(shape).map(([name, schema]) => [
      name,
      { description: name, schema: json(schema), required: !schema.isOptional() },
    ]),
  );
const identity = (names: string[]) => Object.fromEntries(names.map((name) => [name, name]));
const common = {
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  bindingId: z.string(),
  observedAt: time,
  expiresAt: time,
  evidence,
  nativeId: z.string(),
  url: z.url().optional(),
};
const searchProperties = {
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  bindingId: z.string(),
  observedAt: time,
  expiresAt: time,
  evidence,
  complete: z.boolean(),
  cursor: z.string().nullable(),
  inputDigest: z.string(),
  contentDigest: z.string(),
  proofDigest: z.string().optional(),
};
const object = (
  apiName: string,
  description: string,
  shape: Record<string, z.ZodType>,
): OntologyDocument['objectTypes'][number] => ({
  apiName,
  displayName: apiName,
  description,
  primaryKey: 'id',
  titleProperty: 'name',
  properties: properties(shape),
  interfaces: {},
});

type ProviderServices = Pick<OntologyDocument, 'objectTypes' | 'linkTypes' | 'functionTypes' | 'actionTypes' | 'dataSources'>;
const providerServices = (catalog: readonly (typeof serviceCatalog)[number][]): ProviderServices => ({
  objectTypes: catalog.flatMap((service) => {
    const offer = object(
      service.object,
      `${service.provider} account-scoped service facts. Not a reservation or fulfillment receipt.`,
      { ...common, ...service.facts.shape },
    );
    offer.interfaces.ServiceOffering = {
      properties: identity(Object.keys(commonOffer.shape).concat(['provider', 'observedAt', 'expiresAt', 'evidence'])),
      links: { source: 'source', plans: 'plans' },
      actions: {},
    };
    const result = object(
      service.result,
      `A bounded ${service.provider} result page; complete=false is not proof of absence.`,
      service.provider === 'Fliggy' ? { ...searchProperties, accessMode: fliggyAccessMode } : searchProperties,
    );
    result.interfaces.ServiceSearchResult = {
      properties: identity(Object.keys(searchProperties)),
      links: { results: 'results' },
      actions: {},
    };
    result.interfaces[service.searchInterface] = {
      properties: { name: 'name' },
      links: {},
      actions: { search: { action: service.action, parameters: identity(Object.keys(service.parameters.shape)) } },
    };
    return [offer, result];
  }),
  linkTypes: catalog.flatMap((service) => [
    {
      apiName: `${service.object}Source`,
      description: 'Current source supporting this canonical provider object.',
      from: { type: service.object, name: 'source', cardinality: 'one' as const },
      to: { type: service.result, name: 'currentObjects', cardinality: 'many' as const },
    },
    {
      apiName: `${service.object}SearchResult`,
      description: 'Original page membership; current values retain their own source link.',
      from: { type: service.result, name: 'results', cardinality: 'many' as const },
      to: { type: service.object, name: 'searches', cardinality: 'many' as const },
    },
    {
      apiName: `${service.object}Plan`,
      description: 'Service option selected in a plan without an external commitment.',
      from: { type: service.object, name: 'plans', cardinality: 'many' as const },
      to: { type: 'SchedulePlan', name: service.object + 's', cardinality: 'many' as const },
    },
  ]),
  functionTypes: catalog.flatMap((service) => [
    {
      apiName: service.read,
      description: `Read a bounded ${service.provider} ${service.searchInterface} page.${'terms' in service ? ' ' + service.terms : ''}`,
      parameters: json(service.parameters),
      returns: json(service.observation),
      source: service.provider,
      ...('purchase' in service ? { dependencies: {} } : {}),
    },
    {
      apiName: service.search,
      description: `Read ${service.provider} and atomically project its business objects and source evidence.`,
      parameters: json(service.parameters),
      returns: json(objectRefSchema),
      edits: true,
      ...('terms' in service ? { dependencies: {
        objectTypes: [service.object, service.result],
        linkTypes: [service.object + 'Source', service.object + 'SearchResult'],
        dataSources: [service.source],
        functions: [service.read],
      } } : {}),
    },
  ]),
  actionTypes: catalog.map((service) => ({
    apiName: service.action,
    description: `Query and retain ${service.provider} facts. No booking, order or payment.${'terms' in service ? ' ' + service.terms : ''}`,
    parameters: json(service.parameters),
    objectParameters: {},
    submissionCriteria: [],
    function: service.search,
  })),
  dataSources: catalog.map((service) => ({
    apiName: service.source,
    objectType: service.object,
    function: service.read,
    properties: identity(Object.keys({ ...service.facts.shape, ...common })),
  })),
});

function searchInterface(apiName: string, parameters: z.ZodType): OntologyDocument['interfaceTypes'][number] {
  return {
    apiName,
    description: 'Business search contract; choose an authorized implementing source, independently of its MCP transport.',
    properties: properties({ name: z.string() }),
    optionalProperties: [],
    links: {},
    actions: { search: { parameters: json(parameters), objectParameters: {}, required: true } },
  };
}

const coreServices = providerServices(coreServiceCatalog);
export const servicesDefinition: OntologyDocument = {
  id: 'EigosServices',
  version: '1',
  ...coreServices,
  interfaceTypes: [
    {
      apiName: 'ServiceOffering',
      description:
        'A selectable service with source identity, freshness and plan relationships. Selection does not reserve or purchase it.',
      properties: properties({
        ...commonOffer.shape,
        provider: z.string(),
        observedAt: time,
        expiresAt: time,
        evidence,
      }),
      optionalProperties: ['url'],
      links: {
        source: { target: 'ServiceSearchResult', cardinality: 'one', required: true },
        plans: { target: 'SchedulePlan', cardinality: 'many', required: true },
      },
      actions: {},
    },
    {
      apiName: 'ServiceSearchResult',
      description: 'Provider-neutral bounded search output with concrete source identity and pagination.',
      properties: properties(searchProperties),
      optionalProperties: ['proofDigest'],
      links: { results: { target: 'ServiceOffering', cardinality: 'many', required: true } },
      actions: {},
    },
    ...Object.entries(searchContracts).map(([name, parameters]) => searchInterface(name, parameters)),
  ],
  functionTypes: [
    ...coreServices.functionTypes,
    {
      apiName: 'attachPlanService',
      description:
        'Select a service option in a plan. Hotel stays and products do not automatically occupy calendar time.',
      parameters: json(attachServiceInput),
      returns: json(objectRefSchema),
      edits: true,
    },
    {
      apiName: 'readServiceOffering',
      description: 'Read a current service with source and freshness.',
      parameters: json(readServiceInput),
      returns: json(
        z.object({ ref: objectRefSchema, revision: z.number(), properties: z.record(z.string(), z.unknown()) }),
      ),
    },
    {
      apiName: 'readServiceSearch',
      description:
        'Read a result page with completeness, cursor and evidence. Superseded pages do not become empty results.',
      parameters: json(z.strictObject({ search: objectRefSchema })),
      returns: json(z.record(z.string(), z.unknown())),
    },
    {
      apiName: 'evaluateServiceOffering',
      description:
        'Check business-specific planning and commitment conditions without assuming inventory, room terms, delivery or authority.',
      parameters: json(readServiceInput),
      returns: json(
        z.strictObject({
          service: objectRefSchema,
          planning: z.enum(['available', 'unavailable', 'unknown']),
          commitment: z.enum(['requires_authorization', 'unavailable', 'unknown']),
          reasons: z.array(z.string()),
          externalEffect: z.literal(false),
        }),
      ),
    },
  ],
  actionTypes: [
    ...coreServices.actionTypes,
    {
      apiName: 'AttachPlanService',
      description: 'Select a service option for this plan.',
      parameters: json(attachServiceInput),
      objectParameters: { plan: 'SchedulePlan', service: 'ServiceOffering' },
      submissionCriteria: [],
      function: 'attachPlanService',
    },
  ],
};

// Compose these providers into Eigos without changing the original service Function contracts.
export const fliggyServicesDefinition = {
  ...providerServices(fliggyServiceCatalog),
  interfaceTypes: [searchInterface('FlightSearch', flightSearchInput)],
};
fliggyServicesDefinition.functionTypes.push({
  apiName: 'readServiceSearchPages',
  description: 'Return several exact service search pages together, retaining each provider, freshness, and completeness.',
  parameters: json(readServiceSearchPagesInput),
  returns: json(z.strictObject({ pages: z.array(z.record(z.string(), z.unknown())).min(1).max(5) })),
  dependencies: { functions: ['readServiceSearch'] },
});

const travelOfferLinks: OntologyDocument['linkTypes'] = travelOfferSources.map(service => ({
  apiName: travelOfferSearchType + service.result,
  description: 'The exact supplier result page returned for this travel search.',
  from: { type: travelOfferSearchType, name: service.source, cardinality: 'one' },
  to: { type: service.result, name: 'travelSearches', cardinality: 'many' },
}));
const travelOfferDependencies = {
  objectTypes: [travelOfferSearchType, ...travelOfferSources.flatMap(service => [service.result, service.object])],
  linkTypes: [...travelOfferLinks.map(link => link.apiName),
    ...travelOfferSources.flatMap(service => [service.object + 'Source', service.object + 'SearchResult'])],
  dataSources: travelOfferSources.map(service => service.source),
};
const travelOfferSearch = object(travelOfferSearchType, 'A search for dated flight and hotel offers with one outcome per supplier source.', {
  id: z.string(), name: z.string(), outcomes: travelOfferSearchOutcomes,
});
travelOfferSearch.interfaces.TravelOfferInquiry = {
  properties: { name: 'name' },
  links: {},
  actions: { search: { action: 'SearchTravelOffers', parameters: { hotel: 'hotel', flight: 'flight' } } },
};
fliggyServicesDefinition.objectTypes.push(travelOfferSearch);
fliggyServicesDefinition.interfaceTypes.push(searchInterface('TravelOfferInquiry', travelOfferSearchInput));
fliggyServicesDefinition.linkTypes.push(...travelOfferLinks);
fliggyServicesDefinition.functionTypes.push(
  {
    apiName: 'searchTravelOffers',
    description: 'Query the authorized hotel and flight sources concurrently and retain each successful result page.',
    parameters: json(travelOfferSearchInput),
    returns: json(objectRefSchema),
    edits: true,
    dependencies: { ...travelOfferDependencies, functions: travelOfferSources.map(service => service.read) },
  },
  {
    apiName: 'readTravelOfferSearch',
    description: 'Read the retained supplier pages plus the outcome of every requested source.',
    parameters: json(readTravelOfferSearchInput),
    returns: json(z.strictObject({
      search: objectRefSchema,
      outcomes: travelOfferSearchOutcomes,
      pages: z.array(z.record(z.string(), z.unknown())).max(3),
    })),
    dependencies: { ...travelOfferDependencies, functions: ['readServiceSearch'] },
  },
);
fliggyServicesDefinition.actionTypes.push({
  apiName: 'SearchTravelOffers',
  description: 'Find flights from Fliggy and compare hotels from RollingGo and Fliggy with concurrent supplier reads. Supply hotel criteria, flight criteria, or both. Preserves separate prices and availability evidence.',
  parameters: json(travelOfferSearchInput),
  objectParameters: {},
  submissionCriteria: [],
  function: 'searchTravelOffers',
});

for (const [types, apiName, shape] of [
  [['RollingGoHotelOffer', 'FliggyHotelOffer'], 'HotelOffer', { ...hotelFacts.shape, priceKind: z.enum(['reference', 'room_rate']) }],
  [['FliggyFlightOffer'], 'FlightOffer', flightFacts.shape],
  [['ShopifyProductOffer'], 'ProductOffer', productFacts.shape],
] as const) {
  const definition = apiName === 'FlightOffer' ? fliggyServicesDefinition : servicesDefinition;
  definition.interfaceTypes.push({
    apiName,
    description: `Provider-neutral ${apiName} selection. Concrete implementations bind source-specific identity and Actions.`,
    properties: properties(shape),
    optionalProperties: ['url'],
    links: { plans: { target: 'SchedulePlan', cardinality: 'many', required: true } },
    actions: {
      select: {
        parameters: json(attachServiceInput),
        objectParameters: { service: apiName, plan: 'SchedulePlan' },
        required: true,
      },
    },
  });
  for (const type of types) {
    const offer = [...servicesDefinition.objectTypes, ...fliggyServicesDefinition.objectTypes].find(item => item.apiName === type)!;
    offer.interfaces[apiName] = {
      properties: identity(Object.keys(shape)),
      links: { plans: 'plans' },
      actions: { select: { action: 'AttachPlanService', parameters: { service: 'service', plan: 'plan' } } },
    };
  }
}

export const marketplacePurchaseType = 'MarketplacePurchaseHandoff';
export const marketplaceOfferType = 'MarketplaceProductOffer';
export const marketplaceDefinition = {
  ...providerServices(marketplaceServiceCatalog),
  interfaceTypes: [{
    apiName: marketplaceOfferType,
    description: 'A marketplace catalog observation with optional seller, variant and product link.',
    properties: properties(marketplaceFacts.shape),
    optionalProperties: Object.entries(marketplaceFacts.shape).filter(([, schema]) => schema.isOptional()).map(([name]) => name),
    links: { plans: { target: 'SchedulePlan', cardinality: 'many', required: true } },
    actions: {
      select: {
        parameters: json(attachServiceInput),
        objectParameters: { service: marketplaceOfferType, plan: 'SchedulePlan' },
        required: true,
      },
    },
  }] satisfies OntologyDocument['interfaceTypes'],
};
const purchaseHandoff = object(marketplacePurchaseType, 'A buyer handoff for one current marketplace offer.', {
  id: z.string(),
  ...marketplacePurchaseFacts.omit({ url: true }).shape,
  offerRevision: z.number().int().positive(),
});
marketplaceDefinition.objectTypes.push(purchaseHandoff);
for (const service of marketplaceServiceCatalog) {
  const offer = marketplaceDefinition.objectTypes.find(item => item.apiName === service.object)!;
  offer.interfaces[marketplaceOfferType] = {
    properties: identity(Object.keys(marketplaceFacts.shape)),
    links: { plans: 'plans' },
    actions: { select: { action: 'AttachPlanService', parameters: { service: 'service', plan: 'plan' } } },
  };
  const link = service.object + 'PurchaseHandoff';
  marketplaceDefinition.linkTypes.push({
    apiName: link,
    description: 'The exact source offer the buyer selected for handoff.',
    from: { type: marketplacePurchaseType, name: service.provider === 'Taobao' ? 'taobaoOffer' : 'jdOffer', cardinality: 'one' },
    to: { type: service.object, name: 'purchaseHandoffs', cardinality: 'many' },
  });
  marketplaceDefinition.functionTypes.push({
    apiName: service.prepare,
    description: 'Record a handoff for a current marketplace offer so the buyer can open the platform and confirm the purchase.',
    parameters: json(prepareMarketplacePurchaseInput),
    returns: json(objectRefSchema),
    source: service.provider,
    edits: true,
    dependencies: { objectTypes: [service.object, marketplacePurchaseType], linkTypes: [link, service.object + 'Source'] },
  });
  marketplaceDefinition.actionTypes.push({
    apiName: service.purchase,
    description: 'Prepare a verified product link for the buyer to review and complete on the marketplace.',
    parameters: json(prepareMarketplacePurchaseInput),
    objectParameters: { offer: service.object },
    submissionCriteria: [],
    function: service.prepare,
  });
}
marketplaceDefinition.functionTypes.push({
  apiName: 'readMarketplacePurchaseHandoff',
  description: 'Return the product, reference price and approved marketplace URL while the original offer remains current.',
  parameters: json(readMarketplacePurchaseInput),
  returns: json(marketplacePurchaseFacts.extend({ offer: objectRefSchema })),
  dependencies: {
    objectTypes: [marketplacePurchaseType, ...marketplaceServiceCatalog.map(service => service.object)],
    linkTypes: marketplaceServiceCatalog.flatMap(service => [service.object + 'PurchaseHandoff', service.object + 'Source']),
  },
});
