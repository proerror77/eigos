import { z } from 'zod';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import type { ModelDefinition } from './model.js';
import { composable } from './composition-kernel.js';
import { executionReferenceLinks } from './execution-model.js';
import { registrationObjects, registrationLinks, registrationActions, registrationFunctions } from './free-booking.js';
import { meituanReadObjects, meituanReadLinks, meituanReadActions, meituanReadFunctions } from './meituan-read.js';
import { catalogAgentActions } from './catalog-agent.js';

/** One new release integrates the resident capabilities. Historical releases
 * keep their original schemas, handlers and fingerprints. */
export function extendConsolidatedKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry, current: ModelDefinition): OntologyDocument {
  const document = structuredClone(original);
  document.version = '20';
  const objects = [...registrationObjects, ...meituanReadObjects];
  const property = (type: string, name: string, value: ModelDefinition['objects'][number]['properties'][string]) => {
    const { schema: validator, ...metadata } = value;
    const schema = value.schemaMetadata ?? z.toJSONSchema(validator);
    return { ...metadata, schema, validatorRef: registry.registerValidator(`eigos.business:object:${type}:${name}`, 'eigos-consolidated-v20', validator, schema) };
  };
  for (const value of objects) document.objects.push({ ...value, resourceId: `builtin:eigos.business:object:${value.id}`, writePolicy: 'source',
    properties: Object.fromEntries(Object.entries(value.properties).map(([name, definition]) => [name, property(value.id, name, definition)])) });
  for (const id of ['BookingOffers', 'BookingObservation', 'BookingPaymentObservation']) {
    const value = current.objects.find(type => type.id === id)!.properties.data!;
    document.objects.find(type => type.id === id)!.properties.data = property(id, 'data', value);
  }
  const authorization = document.objects.find(type => type.id === 'Authorization')!;
  authorization.properties.environment = property('Authorization', 'environment', {
    ...current.objects.find(type => type.id === 'Authorization')!.properties.environment!,
    schema: z.enum(['sandbox', 'local_simulation', 'managed', 'live', 'live_free']),
  });
  document.links.push(...[...registrationLinks, ...meituanReadLinks].map(value => ({ ...value, resourceId: `builtin:eigos.business:link:${value.id}`, writePolicy: 'source' as const })));
  const evidenceTypes = new Set(document.objects.filter(type => type.interfaces?.some(value => value.id === 'EvidenceBacked')).map(type => type.id));
  for (const value of [...registrationActions, ...meituanReadActions, ...catalogAgentActions]) {
    const action = composable(value, evidenceTypes);
    const definition = { ...action, resourceId: `builtin:eigos.business:action:${action.id}`, implementation: { kind: 'trusted' as const, handlerRef: registry.registerAction(action) } };
    const index = document.actions.findIndex(item => item.id === action.id);
    if (index < 0) document.actions.push(definition); else document.actions[index] = definition;
  }
  for (const fn of [...registrationFunctions, ...meituanReadFunctions]) document.functions.push({ ...fn, handlerRef: registry.registerFunction(fn) });
  const known = new Set(document.links.map(link => link.id));
  for (const link of executionReferenceLinks(document.objects, document.actions, document.interfaces)) if (!known.has(link.id)) {
    document.links.push({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' });
  }
  return document;
}
