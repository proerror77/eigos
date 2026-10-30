import { z } from 'zod';
import { businessFactObjects, businessFactLinks, businessFactTypes } from './business-facts.js';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';

/** Add business projections without changing any predecessor schema, action or fingerprint. */
export function extendBusinessFactsKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  const document = structuredClone(original); document.version = '24';
  for (const type of businessFactObjects) document.objects.push({ ...type, resourceId: `builtin:eigos.business:object:${type.id}`, writePolicy: 'source',
    properties: Object.fromEntries(Object.entries(type.properties).map(([name, p]) => {
      const { schema: validator, ...metadata } = p, schema = z.toJSONSchema(validator);
      return [name, { ...metadata, schema, validatorRef: registry.registerValidator(`eigos.business:object:${type.id}:${name}`, 'business-facts-v24', validator, schema) }];
    })) });
  document.links.push(...businessFactLinks.map(link => ({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' as const })));
  const fn = { id: 'businessFactStatus', version: '1', inputTypes: businessFactTypes.filter(type => type !== 'Event'), description: 'Check source-sealed properties, relationships, freshness and the applicable request revision. A current observed fact is not fulfillment or execution authority.' };
  document.functions.push({ ...fn, handlerRef: registry.registerFunction(fn) });
  return document;
}
