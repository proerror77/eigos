import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { bindDeliveryAddressInput, deliveryAddressList, deliveryAddressNames, deliveryAddressRecord,
  deliveryAddressRef, deliveryAddressType, deliveryDestination, personalDeliveryLinks } from './delivery-addresses.js';
import { personalPlaceType, privateLocation } from './personal-places.js';
import { json, time } from './service-contracts.js';

const text = z.string().trim().min(1).max(300);
const limit = z.number().int().min(1).max(20).default(8);
export const deliveryMerchantId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const hemaSearchInput = z.strictObject({ query: text.max(100), limit });
export const instantDeliveryInput = z.strictObject({
  mode: z.enum(['products', 'stores', 'menu']).optional(),
  query: text.max(100).optional(),
  merchantId: deliveryMerchantId.optional(),
  limit,
}).superRefine(({ mode, query, merchantId }, ctx) => {
  if ((!mode || mode === 'products') && !query)
    ctx.addIssue({ code: 'custom', path: ['query'], message: 'Enter a product or dish keyword' });
  if ((mode === 'menu') !== Boolean(merchantId))
    ctx.addIssue({ code: 'custom', path: ['merchantId'], message: 'Supply a merchant reference when reading a menu' });
});


const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const availability = z.enum(['available', 'sold_out', 'outside_sale_time', 'unknown']);
const stockEvidence = z.enum(['verified', 'verification_required', 'unavailable', 'unknown']);
const amount = z.number().int().nonnegative().safe();
const quantity = z.number().nonnegative().finite();
const store = z.strictObject({ merchantId: deliveryMerchantId, name: text.nullable() });
const item = z.strictObject({
  merchantId: deliveryMerchantId,
  itemId: deliveryMerchantId,
  name: text,
  merchantName: text.nullable(),
  listedPriceMinor: amount.nullable(),
  priceUnit: text.nullable(),
  availability,
  stockEvidence,
  stockQuantity: quantity.nullable(),
  variants: z.array(z.strictObject({
    name: text,
    quantity,
    saleUnit: text.nullable(),
  })).max(100),
});

export const addressedDeliveryInput = {
  TaobaoInstantDelivery: instantDeliveryInput.safeExtend({ destination: deliveryDestination }),
  Hema: hemaSearchInput.extend({ destination: deliveryDestination }),
};
export const deliverySearchReport = z.strictObject({
  provider: z.enum(['TaobaoInstantDelivery', 'Hema']),
  scope: z.enum(['delivery_area', 'nearby_recommendations', 'selected_store', 'delivery_groups']),
  status: z.enum(['available', 'partial', 'verification_required', 'address_required', 'authorization_required', 'unavailable']),
  query: text.max(100).nullable(),
  complete: z.boolean(),
  observedAt: time,
  expiresAt: time,
  evidence: z.enum(['live_readonly', 'provider_mock']),
  currency: z.literal('CNY'),
  stores: z.array(store).max(20),
  items: z.array(item).max(20),
});
const deliverySearchRead = deliverySearchReport.extend({ search: objectRefSchema });
export const addressedDeliveryReport = deliverySearchRead.extend({ deliveryAddress: deliveryAddressRef.nullable() });
export const deliveryReportRef = z.strictObject({ search: objectRefSchema });
export const deliveryRecord = z.strictObject({
  id: checksum, name: text, bindingId: checksum, deliveryAddressKey: checksum.optional(), ...deliverySearchReport.shape,
});
export const localDeliveryServices = {
  TaobaoInstantDelivery: {
    platformId: 'taobao', inquiry: 'InstantDeliveryInquiry', displayName: '淘宝闪购', object: 'TaobaoInstantDeliverySearch',
    action: 'SearchTaobaoInstantDelivery', edit: 'recordTaobaoInstantDeliverySearch', read: 'readTaobaoInstantDeliverySearch',
    input: instantDeliveryInput,
    description: 'Search Taobao Instant Delivery (淘宝闪购) for food and local retail at the connected account’s current delivery address. Use products for keyword search, stores for one nearby recommendation page, or menu with the returned merchantId.',
  },
  Hema: {
    platformId: 'hema', inquiry: 'GroceryDeliveryInquiry', displayName: '盒马', object: 'HemaProductSearch',
    action: 'SearchHemaProducts', edit: 'recordHemaProductSearch', read: 'readHemaProductSearch',
    input: hemaSearchInput,
    description: 'Search Hema (盒马) products in the connected account’s current delivery groups. Report listed prices and independently returned SKU stock when available.',
  },
} as const;
export type LocalDeliveryProvider = keyof typeof localDeliveryServices;
export const localDeliveryProviders = ['TaobaoInstantDelivery', 'Hema'] as const;

const services = localDeliveryProviders.map(provider => {
  const service = localDeliveryServices[provider];
  return { provider, ...service, addresses: deliveryAddressNames(provider),
    addressedInput: addressedDeliveryInput[provider] };
});
const noObjectParameters: Record<string, string> = {};
const properties = Object.fromEntries(Object.entries(deliveryRecord.shape).map(([name, schema]) =>
  [name, { description: name, schema: json(schema), required: !schema.isOptional() }]));

export const localDeliveryDefinition: Pick<OntologyDocument, 'objectTypes' | 'interfaceTypes' | 'linkTypes' | 'actionTypes' | 'functionTypes'> = {
  objectTypes: [{
    apiName: deliveryAddressType, displayName: '配送地址', primaryKey: 'id', titleProperty: 'name', interfaces: {},
    description: 'An opaque address identity observed in an authorized supplier account.',
    properties: Object.fromEntries(Object.entries(deliveryAddressRecord.shape).map(([name, field]) =>
      [name, { description: name, required: true, schema: json(field) }])),
  }, ...services.map(service => ({
    apiName: service.object, displayName: service.displayName + '查询结果',
    description: 'An owner-scoped and time-bounded observation of the selected delivery area.',
    primaryKey: 'id', titleProperty: 'name', properties: structuredClone(properties),
    interfaces: { [service.inquiry]: { properties: { name: 'name' }, links: { deliveryAddress: 'deliveryAddress' }, actions: {
      search: { action: service.action, parameters: Object.fromEntries(Object.keys(service.input.shape).map(name => [name, name])) },
      searchAt: { action: service.addresses.search,
        parameters: Object.fromEntries(Object.keys(service.addressedInput.shape).map(name => [name, name])) },
    } } },
  }))],
  linkTypes: [...personalDeliveryLinks, ...services.map(service => ({
    apiName: service.addresses.searchLink, description: 'Supplier address actually used for the search observation.',
    from: { type: service.object, name: 'deliveryAddress', cardinality: 'one' as const },
    to: { type: deliveryAddressType, name: service.addresses.personalNavigation.replace(/Addresses$/, 'Searches'), cardinality: 'many' as const },
  }))],
  interfaceTypes: services.map(service => ({
    apiName: service.inquiry, description: service.description, properties: { name: structuredClone(properties.name!) },
    optionalProperties: [], links: { deliveryAddress: { target: deliveryAddressType, cardinality: 'one', required: false } },
    actions: {
      search: { parameters: json(service.input), objectParameters: noObjectParameters, required: true },
      searchAt: { parameters: json(service.addressedInput), objectParameters: noObjectParameters, required: true },
    },
  })),
  actionTypes: services.flatMap<OntologyDocument['actionTypes'][number]>(service => [{
    apiName: service.action, description: service.description,
    parameters: json(service.input), objectParameters: noObjectParameters, submissionCriteria: [], function: service.edit,
  }, {
    apiName: service.addresses.search, description: 'Search at the account’s selected delivery address, or at a verified address linked to the chosen personal place.',
    parameters: json(service.addressedInput), objectParameters: noObjectParameters, submissionCriteria: [], function: service.addresses.editSearch,
  }, {
    apiName: service.addresses.bind, description: 'Link a reviewed address from this supplier account to the owner-confirmed personal place.',
    parameters: json(bindDeliveryAddressInput), objectParameters: { place: personalPlaceType }, submissionCriteria: [],
    function: service.addresses.editBinding, classification: privateLocation,
  }]),
  functionTypes: services.flatMap<OntologyDocument['functionTypes'][number]>(service => [
    {
      apiName: service.edit, description: service.description, parameters: json(service.input),
      returns: json(objectRefSchema), edits: true, source: service.provider, dependencies: { objectTypes: [service.object] },
    },
    {
      apiName: service.read, description: 'Read the current saved search observation. Inventory and listed prices are time-bound.',
      parameters: json(deliveryReportRef), returns: json(deliverySearchRead), source: service.provider,
      dependencies: { objectTypes: [service.object] },
    }, {
      apiName: service.addresses.list, description: 'Read delivery addresses from the authorized supplier account. Review the returned address before binding it to a personal place.',
      parameters: json(z.strictObject({})), returns: json(deliveryAddressList), source: service.provider,
      classification: privateLocation, dependencies: {},
    }, {
      apiName: service.addresses.editBinding, description: 'Bind a reviewed supplier address to the exact revision of a personal place.',
      parameters: json(bindDeliveryAddressInput), returns: json(deliveryAddressRef), edits: true, source: service.provider,
      classification: privateLocation, dependencies: { objectTypes: [personalPlaceType, deliveryAddressType], linkTypes: [service.addresses.personalLink] },
    }, {
      apiName: service.addresses.editSearch, description: 'Record an address-bound delivery search.',
      parameters: json(service.addressedInput), returns: json(objectRefSchema), edits: true, source: service.provider,
      dependencies: { objectTypes: [service.object, deliveryAddressType], linkTypes: [service.addresses.searchLink] },
    }, {
      apiName: service.addresses.readSearch, description: 'Read the search result together with the verified supplier delivery address reference.',
      parameters: json(deliveryReportRef), returns: json(addressedDeliveryReport), source: service.provider,
      dependencies: { objectTypes: [service.object, deliveryAddressType], linkTypes: [service.addresses.searchLink] },
    },
  ]),
};
