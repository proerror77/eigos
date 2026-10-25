import { predecessorRideActions, predecessorRideFunctions } from './provider-read-predecessor.js';
import { z } from 'zod';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import { rideEstimateActions, rideEstimateFunctions, rideEstimateLinks, rideEstimateObjects } from './ride-estimate.js';
import { rideBookingActions, rideBookingFunctions, rideBookingLinks, rideBookingObjects } from './ride-booking.js';
import { executionReferenceLinks } from './execution-model.js';
import { composable } from './composition-kernel.js';

/** Additive v18 release: historical v15/v16/v17 schemas retain their identities. */
export function extendDidiKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  const document = structuredClone(original); document.version = '18';
  const objects = [...rideEstimateObjects, ...rideBookingObjects], links = [...rideEstimateLinks, ...rideBookingLinks];
  for (const value of objects) document.objects.push({ ...value, resourceId: `builtin:eigos.business:object:${value.id}`, writePolicy: 'source',
    properties: Object.fromEntries(Object.entries(value.properties).map(([name, property]) => {
      const { schema: validator, ...metadata } = property, schema = z.toJSONSchema(validator);
      return [name, { ...metadata, schema, validatorRef: registry.registerValidator(`eigos.business:object:${value.id}:${name}`, 'eigos-didi-v18', validator, schema) }];
    })) });
  document.links.push(...links.map(value => ({ ...value, resourceId: `builtin:eigos.business:link:${value.id}`, writePolicy: 'source' as const })));
  const evidenceTypes = new Set(objects.filter(object => object.interfaces?.some(value => value.id === 'EvidenceBacked')).map(object => object.id));
  for (const value of [...predecessorRideActions, ...rideBookingActions]) {
    const action = composable(value, evidenceTypes);
    document.actions.push({ ...action, resourceId: `builtin:eigos.business:action:${action.id}`, implementation: { kind: 'trusted', handlerRef: registry.registerAction(action) } });
  }
  for (const fn of [...predecessorRideFunctions, ...rideBookingFunctions]) document.functions.push({ ...fn, handlerRef: registry.registerFunction(fn) });
  const known = new Set(document.links.map(link => link.id));
  for (const link of executionReferenceLinks(document.objects, document.actions, document.interfaces)) if (!known.has(link.id)) document.links.push({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' });
  return document;
}
