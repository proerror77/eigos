import { z } from 'zod';
import type { OntologyDocument, SerializableProperty } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import { shopCheckoutObjects, shopCheckoutLinks, shopCheckoutActions, shopCheckoutFunctions } from './shopify-checkout.js';
import { externalDraftScopeSchema } from './external-draft.js';
import { executionReferenceLinks } from './execution-model.js';
import type { ObjectTypeDefinition } from './model.js';

const effects = ['local', 'read', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund', 'object_write', 'external_draft'] as const;

/** v18 adds one narrowly authorized nonfinancial external draft effect. The
 * reconstructed v15/v16/v17 releases keep their original validators and hashes. */
export function extendCheckoutKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  const document = structuredClone(original); document.version = '18';
  const property = (type: string, name: string, metadata: Omit<SerializableProperty, 'schema' | 'validatorRef'>, schema: z.ZodType): SerializableProperty => {
    const json = z.toJSONSchema(schema);
    return { ...metadata, schema: json, validatorRef: registry.registerValidator(`eigos.business:object:${type}:${name}`, 'eigos-checkout-v18', schema, json) };
  };
  const replace = (type: string, name: string, schema: z.ZodType) => {
    const object = document.objects.find(value => value.id === type)!;
    const { schema: _old, validatorRef: _ref, ...metadata } = object.properties[name]!;
    object.properties[name] = property(type, name, metadata, schema);
    if (!object.version.endsWith('.checkout1')) object.version += '.checkout1';
  };
  replace('RegisteredActionType', 'effect', z.enum([...effects, 'definition_only']));
  replace('BusinessResult', 'effect', z.enum(effects));
  replace('Authorization', 'environment', z.enum(['sandbox', 'local_simulation', 'managed', 'live']));
  replace('Authorization', 'allowedEffects', z.array(z.enum(effects)).max(8));
  const authorization = document.objects.find(value => value.id === 'Authorization')!;
  authorization.properties.externalDraftScope = property('Authorization', 'externalDraftScope', { kind: 'struct', description: 'Exact merchant, items and source binding for one unpaid external checkout; never an order or payment permit', source: 'Original nonfinancial grant ledger', required: false }, externalDraftScopeSchema);
  const ref = z.strictObject({ id: z.string().min(1).max(200), version: z.string().min(1).max(80) });
  replace('ResolutionContext', 'capabilityActions', z.array(z.strictObject({ ref, effect: z.enum(effects), additionalEffects: z.array(z.enum(effects)).max(8).optional() })).min(1).max(32));
  for (const object of shopCheckoutObjects) document.objects.push({ ...object, resourceId: `builtin:eigos.business:object:${object.id}`, writePolicy: 'source',
    properties: Object.fromEntries(Object.entries(object.properties).map(([name, { schema, schemaMetadata: _schemaMetadata, sourceBinding: _sourceBinding, ...metadata }]) => [name, property(object.id, name, metadata, schema)])) });
  document.links.push(...shopCheckoutLinks.map(link => ({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' as const })));
  document.actions.push(...shopCheckoutActions.map(action => ({ ...action, resourceId: `builtin:eigos.business:action:${action.id}`, implementation: { kind: 'trusted' as const, handlerRef: registry.registerAction(action) } })));
  document.functions.push(...shopCheckoutFunctions.map(fn => ({ ...fn, handlerRef: registry.registerFunction(fn) })));
  const known = new Set(document.links.map(link => link.id));
  for (const link of executionReferenceLinks(document.objects as Pick<ObjectTypeDefinition, 'id' | 'interfaces'>[], document.actions, document.interfaces)) if (!known.has(link.id)) document.links.push({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' });
  return document;
}
