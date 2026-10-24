import { z } from 'zod';
import type { OntologyDocument, SerializableProperty } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import { composable } from './composition-kernel.js';
import { executionReferenceLinks } from './execution-model.js';
import { catalogMcpActions } from './catalog-agent.js';
import { meituanReadObjects, meituanReadLinks, meituanReadActions, meituanReadFunctions } from './meituan-read.js';
import { rideEstimateObjects, rideEstimateLinks, rideEstimateActions, rideEstimateFunctions } from './ride-estimate.js';

/** Extend the PA-payment kernel with source-bound provider mappings. Previously
 * published payment and composition definitions retain their original hashes. */
export function extendProviderReadKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  const document = structuredClone(original); document.version = '20';
  for (const object of [...meituanReadObjects, ...rideEstimateObjects]) document.objects.push({
    ...object, resourceId: `builtin:eigos.business:object:${object.id}`, writePolicy: 'source',
    properties: Object.fromEntries(Object.entries(object.properties).map(([name, { schema, schemaMetadata: _schemaMetadata, sourceBinding: _sourceBinding, ...metadata }]) => {
      const json = z.toJSONSchema(schema);
      return [name, { ...metadata, schema: json, validatorRef: registry.registerValidator(`eigos.business:object:${object.id}:${name}`, 'eigos-provider-reads-v20', schema, json) } satisfies SerializableProperty];
    })),
  });
  document.links.push(...[...meituanReadLinks, ...rideEstimateLinks].map(link => ({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' as const })));
  const evidenceTypes = new Set(document.objects.filter(type => type.interfaces?.some(value => value.id === 'EvidenceBacked')).map(type => type.id));
  for (const value of [...meituanReadActions, ...rideEstimateActions, ...catalogMcpActions]) {
    const action = composable(value, evidenceTypes);
    const definition = { ...action, resourceId: `builtin:eigos.business:action:${action.id}`, implementation: { kind: 'trusted' as const, handlerRef: registry.registerAction(action) } };
    const index = document.actions.findIndex(current => current.id === action.id);
    if (index < 0) document.actions.push(definition); else document.actions[index] = definition;
  }
  document.functions.push(...[...meituanReadFunctions, ...rideEstimateFunctions].map(fn => ({ ...fn, handlerRef: registry.registerFunction(fn) })));
  const known = new Set(document.links.map(link => link.id));
  for (const link of executionReferenceLinks(document.objects, document.actions, document.interfaces)) if (!known.has(link.id)) {
    document.links.push({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' });
  }
  return document;
}
