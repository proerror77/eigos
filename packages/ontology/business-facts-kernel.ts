import { z } from 'zod';
import { businessFactObjects, businessFactLinks } from './business-facts.js';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import { sharedBusinessInterfaces } from './shared-business-interfaces.js';

/** Add business projections without changing any predecessor schema, action or fingerprint. */
export function extendBusinessFactsKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  const document = structuredClone(original); document.version = '24';
  const technicalReads = new Set(['RideEstimateTask', 'DidiPlaceObservation', 'RideEstimateObservation', 'RollingGoSearchTask', 'RollingGoSearchObservation',
    'MeituanReadTask', 'MeituanReadObservation', 'ShopifyCheckoutProducts', 'ShopifyCheckoutObservation']);
  for (const type of document.objects) if (technicalReads.has(type.id)) type.visibility = 'technical';
  for (const type of sharedBusinessInterfaces) document.interfaces.push({ ...type, resourceId: `builtin:eigos.business:interface:${type.id}`,
    properties: Object.fromEntries(Object.entries(type.properties).map(([name, p]) => {
      const { schema: validator, ...metadata } = p, schema = z.toJSONSchema(validator);
      return [name, { ...metadata, schema, validatorRef: registry.registerValidator(`eigos.business:interface:${type.id}:${name}`, 'shared-business-v24', validator, schema) }];
    })) });
  // Reuse the existing reviewed address value contract rather than cloning a
  // different address schema for public places, private addresses or journeys.
  document.interfaces.push({ id: 'Addressable', resourceId: 'builtin:eigos.business:interface:Addressable', description: 'Read an existing address value; public and private rows retain their own permissions.',
    projectionOnly: true, propertyCompatibility: 'structural_v1', properties: { address: structuredClone(document.objects.find(type => type.id === 'SavedAddress')!.properties.address!) } });
  for (const id of ['Place', 'SavedAddress']) document.objects.find(type => type.id === id)!.interfaces!.push({ id: 'Addressable' });
  document.objects.find(type => type.id === 'HotelProperty')!.interfaces!.push({ id: 'Located' });
  document.objects.find(type => type.id === 'RideRoute')!.interfaces!.push({ id: 'OriginDestination', linkMap: { origin: 'originPlace', destination: 'destinationPlace' } });
  document.objects.find(type => type.id === 'TravelLeg')!.interfaces!.push({ id: 'Scheduled' }, { id: 'OriginDestination', linkMap: { origin: 'departurePlace', destination: 'arrivalPlace' } });
  for (const type of businessFactObjects) document.objects.push({ ...type, resourceId: `builtin:eigos.business:object:${type.id}`, writePolicy: 'source',
    properties: Object.fromEntries(Object.entries(type.properties).map(([name, p]) => {
      const { schema: validator, ...metadata } = p, schema = z.toJSONSchema(validator);
      return [name, { ...metadata, schema, validatorRef: registry.registerValidator(`eigos.business:object:${type.id}:${name}`, 'business-facts-v24', validator, schema) }];
    })) });
  document.links.push(...businessFactLinks.map(link => ({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' as const })));
  const fn = { id: 'businessFactStatus', version: '1', inputTypes: ['ObservedFact'], description: 'Check source-sealed properties, relationships, freshness and the applicable request revision through the shared observation contract. A current observed fact is not fulfillment or execution authority.' };
  document.functions.push({ ...fn, handlerRef: registry.registerFunction(fn) });
  return document;
}
