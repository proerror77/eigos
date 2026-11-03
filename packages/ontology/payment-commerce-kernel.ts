import { z } from 'zod';
import { commerceReadObjects, commerceReadLinks, commerceReadActions, commerceReadFunctions } from './payment-commerce.js';
import { composable } from './composition-kernel.js';
import { executionReferenceLinks } from './execution-model.js';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';

/** Additive v27 release. Historical releases and existing task pins stay intact. */
export function extendPaymentCommerceKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  const document = structuredClone(original); document.version = '27';
  for (const type of commerceReadObjects) document.objects.push({
    ...type, resourceId: `builtin:eigos.business:object:${type.id}`, writePolicy: 'source',
    properties: Object.fromEntries(Object.entries(type.properties).map(([name, property]) => {
      const { schema: validator, ...metadata } = property, schema = z.toJSONSchema(validator);
      return [name, { ...metadata, schema, validatorRef: registry.registerValidator(`eigos.business:object:${type.id}:${name}`, 'payment-commerce-v27', validator, schema) }];
    })),
  });
  const evidenceTypes = new Set(document.objects.filter(type => type.interfaces?.some(i => i.id === 'EvidenceBacked')).map(type => type.id));
  for (const definition of commerceReadActions) {
    const action = composable(definition, evidenceTypes);
    document.actions.push({ ...action, resourceId: `builtin:eigos.business:action:${action.id}`, implementation: { kind: 'trusted', handlerRef: registry.registerAction(action) } });
  }
  for (const fn of commerceReadFunctions) document.functions.push({ ...fn, handlerRef: registry.registerFunction(fn) });
  const known = new Set(document.links.map(link => link.id));
  for (const link of [...commerceReadLinks, ...executionReferenceLinks(document.objects, document.actions, document.interfaces)]) if (!known.has(link.id)) {
    document.links.push({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' }); known.add(link.id);
  }
  return document;
}
