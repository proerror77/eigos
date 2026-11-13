import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import {
  attachServiceInput,
  commonOffer,
  eventFacts,
  hotelFacts,
  productFacts,
  eventSearchInput,
  hotelSearchInput,
  productSearchInput,
  serviceObservation,
  readServiceInput,
  json,
  time,
  evidence,
} from './service-contracts.js';

/** Business interfaces are shared; these are the concrete source implementations. */
export const serviceCatalog = [
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
  },
] as const;
export const serviceTypes = {
  Luma: 'LumaEvent',
  RollingGo: 'RollingGoHotelOffer',
  Shopify: 'ShopifyProductOffer',
} as const;
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

export const servicesDefinition: OntologyDocument = {
  id: 'EigosServices',
  version: '1',
  objectTypes: serviceCatalog.flatMap((service) => {
    const offer = object(
      service.object,
      `${service.provider} account-scoped service facts. Not a reservation or fulfillment receipt.`,
      { ...service.facts.shape, ...common },
    );
    offer.interfaces.ServiceOffering = {
      properties: identity(Object.keys(commonOffer.shape).concat(['provider', 'observedAt', 'expiresAt', 'evidence'])),
      links: { source: 'source', plans: 'plans' },
      actions: {},
    };
    const result = object(
      service.result,
      `A bounded ${service.provider} result page; complete=false is not proof of absence.`,
      searchProperties,
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
    ...serviceCatalog.map((service) => ({
      apiName: service.searchInterface,
      description: `Business search contract; choose an authorized implementing source, independently of its MCP transport.`,
      properties: properties({ name: z.string() }),
      optionalProperties: [],
      links: {},
      actions: { search: { parameters: json(service.parameters), objectParameters: {}, required: true } },
    })),
  ],
  linkTypes: serviceCatalog.flatMap((service) => [
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
  functionTypes: [
    ...serviceCatalog.flatMap((service) => [
      {
        apiName: service.read,
        description: `Read a bounded ${service.provider} ${service.searchInterface} page.`,
        parameters: json(service.parameters),
        returns: json(serviceObservation),
        source: service.provider,
      },
      {
        apiName: service.search,
        description: `Read ${service.provider} and atomically project its business objects and source evidence.`,
        parameters: json(service.parameters),
        returns: json(objectRefSchema),
        edits: true,
      },
    ]),
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
    ...serviceCatalog.map((service) => ({
      apiName: service.action,
      description: `Query and retain ${service.provider} facts. No booking, order or payment.`,
      parameters: json(service.parameters),
      objectParameters: {},
      submissionCriteria: [],
      function: service.search,
    })),
    {
      apiName: 'AttachPlanService',
      description: 'Select a service option for this plan.',
      parameters: json(attachServiceInput),
      objectParameters: { plan: 'SchedulePlan', service: 'ServiceOffering' },
      submissionCriteria: [],
      function: 'attachPlanService',
    },
  ],
  dataSources: serviceCatalog.map((service) => ({
    apiName: service.source,
    objectType: service.object,
    function: service.read,
    properties: identity(Object.keys({ ...service.facts.shape, ...common })),
  })),
};

for (const [type, apiName, shape] of [
  ['RollingGoHotelOffer', 'HotelOffer', { ...hotelFacts.shape, priceKind: z.enum(['reference', 'room_rate']) }],
  ['ShopifyProductOffer', 'ProductOffer', productFacts.shape],
] as const) {
  servicesDefinition.interfaceTypes.push({
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
  servicesDefinition.objectTypes.find((item) => item.apiName === type)!.interfaces[apiName] = {
    properties: identity(Object.keys(shape)),
    links: { plans: 'plans' },
    actions: { select: { action: 'AttachPlanService', parameters: { service: 'service', plan: 'plan' } } },
  };
}
