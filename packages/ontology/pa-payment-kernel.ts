import { z } from 'zod';
import type { OntologyDocument, SerializableProperty } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import type { ObjectTypeDefinition } from './model.js';
import { executionReferenceLinks } from './execution-model.js';
import { paHandoffTermsSchema } from '../capabilities/payment-handoff.js';
import { shopifyPAObjects, shopifyPALinks, shopifyPAActions, shopifyPAFunctions } from './shopify-pa-payment.js';

/** Add checkout handoffs without reinterpreting version-2 booking history. */
export function extendPAPaymentKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  const document = structuredClone(original); document.version = '19';
  const property = (type: string, name: string, metadata: Omit<SerializableProperty, 'schema' | 'validatorRef'>, schema: z.ZodType): SerializableProperty => {
    const json = z.toJSONSchema(schema);
    return { ...metadata, schema: json, validatorRef: registry.registerValidator(`eigos.business:object:${type}:${name}`, 'eigos-pa-checkout-v19', schema, json) };
  };
  const handoff = document.objects.find(object => object.id === 'PAPaymentRequest')!;
  const { schema: _schema, validatorRef: _ref, ...metadata } = handoff.properties.terms!;
  handoff.properties.terms = property(handoff.id, 'terms', { ...metadata, description: 'Versioned original booking or merchant-checkout terms; credentials remain with the PA' }, paHandoffTermsSchema);
  handoff.version = '3';
  // Each domain validates its own complete link set. A checkout must not be
  // represented as a booking just to satisfy the old booking relationships.
  for (const link of document.links) if (['PAPaymentRequestScope', 'PAPaymentBooking', 'PAPaymentUnpaidProof'].includes(link.id)) link.from.required = false;
  for (const object of shopifyPAObjects) document.objects.push({ ...object, resourceId: `builtin:eigos.business:object:${object.id}`, writePolicy: 'source',
    properties: Object.fromEntries(Object.entries(object.properties).map(([name, { schema, schemaMetadata: _schemaMetadata, sourceBinding: _sourceBinding, ...metadata }]) => [name, property(object.id, name, metadata, schema)])) });
  document.links.push(...shopifyPALinks.map(link => ({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' as const })));
  document.actions.push(...shopifyPAActions.map(action => ({ ...action, resourceId: `builtin:eigos.business:action:${action.id}`, implementation: { kind: 'trusted' as const, handlerRef: registry.registerAction(action) } })));
  document.functions.push(...shopifyPAFunctions.map(fn => ({ ...fn, handlerRef: registry.registerFunction(fn) })));
  const known = new Set(document.links.map(link => link.id));
  for (const link of executionReferenceLinks(document.objects as Pick<ObjectTypeDefinition, 'id' | 'interfaces'>[], document.actions, document.interfaces)) if (!known.has(link.id)) document.links.push({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' });
  return document;
}
