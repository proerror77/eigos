import { z } from 'zod';
import { personalPlaceRef, personalPlaceType, placeKey } from './personal-places.js';

export const deliveryAddressType = 'ProviderDeliveryAddress';
export const deliveryAddressRef = z.strictObject({ type: z.literal(deliveryAddressType), id: placeKey });
export const deliveryAddressRecord = z.strictObject({
  id: placeKey,
  name: z.string().min(1).max(80),
  provider: z.enum(['TaobaoInstantDelivery', 'Hema']),
});
export const deliveryAddressChoice = z.strictObject({
  addressKey: placeKey,
  label: z.string().max(100),
  address: z.string().min(1).max(1100),
  selected: z.boolean(),
});
export const deliveryAddressList = z.strictObject({ addresses: z.array(deliveryAddressChoice).max(100) });
export const bindDeliveryAddressInput = z.strictObject({
  place: personalPlaceRef,
  expectedRevision: z.number().int().positive(),
  addressKey: placeKey,
  confirmed: z.literal(true),
});
export const deliveryDestination = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('selected') }),
  z.strictObject({ source: z.literal('personal'), place: personalPlaceRef }),
]);

export function deliveryAddressNames(provider: string) {
  const delivery = provider === 'Hema' ? 'HemaDelivery' : provider;
  return {
    list: 'list' + delivery + 'Addresses',
    bind: 'Bind' + delivery + 'Address',
    editBinding: 'bind' + delivery + 'Address',
    search: 'Search' + provider + 'AtAddress',
    editSearch: 'record' + provider + 'AddressedSearch',
    readSearch: 'read' + provider + 'AddressedSearch',
    searchLink: provider + 'SearchDeliveryAddress',
    personalLink: provider + 'PersonalDeliveryAddress',
    personalNavigation: provider[0]!.toLowerCase() + provider.slice(1) + 'Addresses',
  };
}

export const personalDeliveryLinks = ['TaobaoInstantDelivery', 'Hema'].map(provider => {
  const names = deliveryAddressNames(provider);
  return { apiName: names.personalLink, description: 'Supplier address the owner confirmed for this personal place.',
    from: { type: personalPlaceType, name: names.personalNavigation, cardinality: 'many' as const },
    to: { type: deliveryAddressType, name: provider[0]!.toLowerCase() + provider.slice(1) + 'PersonalPlaces', cardinality: 'many' as const } };
});
