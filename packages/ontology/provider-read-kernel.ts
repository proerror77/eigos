import { predecessorRideActions, predecessorRideFunctions } from './provider-read-predecessor.js';
import { z } from 'zod';
import type { OntologyDocument, SerializableProperty } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import { composable } from './composition-kernel.js';
import { executionReferenceLinks } from './execution-model.js';
import { catalogReadDefinition, catalogReadDefinitionRef } from './catalog-read-definition.js';
import type { ModelDefinition } from './model.js';
import { meituanReadObjects, meituanReadLinks, meituanReadActions, meituanReadFunctions } from './meituan-read.js';
import { rideEstimateObjects, rideEstimateLinks, rideEstimateActions, rideEstimateFunctions } from './ride-estimate.js';

/** Reconstruct the published provider-read v20 contract. Its original scope
 * ports and two-action DiDi validator remain pinned, independently of v21. */
export function extendProviderReadKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry, historical: ModelDefinition): OntologyDocument {
  const document = structuredClone(original); document.version = '20';
  const catalogMcpActions = historical.actions.filter(legacy => catalogReadDefinition.actions.some(action => action.id === legacy.id)).map(legacy => {
    const action = catalogReadDefinition.actions.find(action => action.id === legacy.id)!;
    return { ...legacy, version: catalogReadDefinition.version, description: action.description,
      read: { ...legacy.read!, version: catalogReadDefinition.version,
        mcp: action.mcp, module: { ...catalogReadDefinitionRef, completion: catalogReadDefinition.completion } } };
  });
  for (const object of [...meituanReadObjects, ...rideEstimateObjects]) document.objects.push({
    ...object, resourceId: `builtin:eigos.business:object:${object.id}`, writePolicy: 'source',
    properties: Object.fromEntries(Object.entries(object.properties).map(([name, { schema, schemaMetadata: _schemaMetadata, sourceBinding: _sourceBinding, ...metadata }]) => {
      if (object.id === 'RideEstimateTask' && name === 'allowedActions') {
        schema = z.array(z.string()).max(2);
        metadata.description = 'Only these read actions may execute';
      }
      const json = z.toJSONSchema(schema);
      return [name, { ...metadata, schema: json, validatorRef: registry.registerValidator(`eigos.business:object:${object.id}:${name}`, 'eigos-provider-reads-v20', schema, json) } satisfies SerializableProperty];
    })),
  });
  document.links.push(...[...meituanReadLinks, ...rideEstimateLinks].map(link => ({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' as const })));
  const evidenceTypes = new Set(document.objects.filter(type => type.interfaces?.some(value => value.id === 'EvidenceBacked')).map(type => type.id));
  for (const value of [...meituanReadActions, ...predecessorRideActions, ...catalogMcpActions]) {
    const action = composable(value, evidenceTypes);
    for (const port of Object.values(action.composition!.inputs)) if (port.kind === 'object' && ['MeituanReadTask', 'RideEstimateTask'].includes(port.type)) {
      port.semantics.phase = 'fact';
      port.evidence = { origins: ['provider', 'synthetic'], maxAgeMs: 300000 };
    }
    const result = action.composition!.outputs.result;
    if (result?.kind === 'object' && result.type === 'RideEstimateObservation') result.semantics.phase = 'fact';
    const definition = { ...action, resourceId: `builtin:eigos.business:action:${action.id}`, implementation: { kind: 'trusted' as const, handlerRef: registry.registerAction(action) } };
    const index = document.actions.findIndex(current => current.id === action.id);
    if (index < 0) document.actions.push(definition); else document.actions[index] = definition;
  }
  document.functions.push(...[...meituanReadFunctions, ...predecessorRideFunctions].map(fn => ({ ...fn, handlerRef: registry.registerFunction(fn) })));
  const known = new Set(document.links.map(link => link.id));
  for (const link of executionReferenceLinks(document.objects, document.actions, document.interfaces)) if (!known.has(link.id)) {
    document.links.push({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' });
  }
  return document;
}
