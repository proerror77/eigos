import { z } from 'zod';
import type { ModelDefinition, PropertyDefinition } from './model.js';
import { objectRefSchema } from './model.js';

const code = z.string().trim().min(1).max(100);
const sha = z.string().regex(/^[a-f0-9]{64}$/), time = z.iso.datetime({ offset: true });
const condition = z.enum(['new', 'open_box', 'refurbished', 'used']);
const color = z.enum(['black', 'white', 'gray', 'silver', 'gold', 'red', 'blue', 'green', 'yellow', 'orange', 'pink', 'purple', 'brown', 'transparent', 'multicolor']);
const common = {
  schemaVersion: z.literal('1'),
  manufacturerModel: z.strictObject({ namespace: code, id: code }).optional(),
  color: color.optional(), condition: condition.optional(),
  package: z.strictObject({ kind: z.enum(['single_item', 'bundle']), itemCount: z.number().int().positive().max(10000),
    componentCodes: z.array(code).max(30).optional() }).optional(),
};
const profiles = [
  z.strictObject({ ...common, profile: z.literal('electronics'),
    storage: z.strictObject({ amount: z.number().int().positive().max(1000000), unit: z.enum(['GB', 'TB', 'GiB', 'TiB']) }).optional(),
    connectivity: z.enum(['wifi', 'cellular', 'wifi_and_cellular', 'wired', 'none']).optional(),
    marketCountry: z.string().regex(/^[A-Z]{2}$/).optional(),
  }),
  z.strictObject({ ...common, profile: z.literal('apparel'),
    size: z.strictObject({ system: z.enum(['EU', 'US', 'UK', 'CN', 'manufacturer']), code,
      manufacturer: code.optional() }).optional(),
  }),
  z.strictObject({ ...common, profile: z.literal('packaged_goods'),
    netContent: z.strictObject({ amount: z.string().regex(/^(0|[1-9]\d{0,8})(\.\d{1,3})?$/).refine(value => Number(value) > 0, 'Net content must be positive'), unit: z.enum(['g', 'kg', 'ml', 'l']) }).optional(),
    flavorCode: code.optional(),
  }),
  z.strictObject({ ...common, profile: z.literal('general_goods') }),
] as const;

/** A profile is an explicit source contract. Neither titles nor legacy free-form
 * specifications determine a profile, a condition, a color, or a unit. */
export const productAttributesSchema = z.discriminatedUnion('profile', profiles);
export type ProductAttributes = z.infer<typeof productAttributesSchema>;
export const productAttributeConstraintsSchema = productAttributesSchema;
const agreedObservation = <T extends string>(type: T) => z.strictObject({ object: objectRefSchema.extend({ type: z.literal(type) }), contentDigest: sha,
  sourceId: z.string().min(1).max(200), sourceVersion: z.number().int().positive(), checkedAt: time });
export const orderLineSourceAgreementSchema = z.strictObject({
  schemaVersion: z.literal('1'), basis: z.literal('source_order_and_checkout'),
  merchantId: z.string().min(1).max(200), variantId: z.string().min(1).max(200),
  product: agreedObservation('CommerceProduct'), quote: agreedObservation('LandedCostQuote'),
  checkout: agreedObservation('CommerceCheckout'), order: agreedObservation('CommerceOrderObservation'),
});
export type OrderLineSourceAgreement = z.infer<typeof orderLineSourceAgreementSchema>;
export const deliveryVariantVerificationSchema = z.strictObject({ kind: z.literal('source_reported_variant_identity'),
  reportedVariantId: z.string().min(1).max(200), sourceObservation: objectRefSchema.extend({ type: z.literal('CommerceDeliveryObservation') }), physicalAttributes: z.literal('unknown') });
export const shipmentExpectedAllocationSchema = z.strictObject({ schemaVersion: z.literal('1'), basis: z.literal('source_quoted_fulfillment_group'),
  orderLine: objectRefSchema.extend({ type: z.literal('OrderLine') }), quantity: z.strictObject({ amount: z.string().regex(/^[1-9]\d{0,3}$/), unit: z.literal('piece') }), agreedSpecificationRef: sha,
  sourceQuote: objectRefSchema.extend({ type: z.literal('LandedCostQuote') }), sourceQuoteDigest: sha, sourceGroupId: z.string().min(1).max(200), destinationDigest: sha });
export const productAttributeFunctionSchemas = [
  z.strictObject({ function: z.literal('productAttributesMatch'), object: objectRefSchema, constraints: productAttributeConstraintsSchema }),
  z.strictObject({ function: z.literal('orderLineAgreementStatus'), object: objectRefSchema.extend({ type: z.literal('OrderLine') }) }),
  z.strictObject({ function: z.literal('shipmentAllocationStatus'), object: objectRefSchema.extend({ type: z.literal('Shipment') }) }),
] as const;

const property: PropertyDefinition = { kind: 'struct', schema: productAttributesSchema, description: 'Optional source-declared category profile and typed variant attributes. Absence is unknown; legacy specification strings and titles are not equivalent evidence.', source: 'Exact validated catalog or commerce source observation; never model inference or buyer intent' };
export function extendProductAttributesModel(base: ModelDefinition): ModelDefinition {
  return { ...base,
    objects: base.objects.map(type => type.id === 'ProductVariant' ? { ...type, version: '2', properties: { ...type.properties, typedAttributes: property } }
      : type.id === 'OrderLine' ? { ...type, version: String(Number(type.version) + 1), properties: { ...type.properties, sourceAgreement: { kind: 'struct', schema: orderLineSourceAgreementSchema, description: 'Fixed source product, quote, checkout and original submission observations. Added only when a new line is created from a complete sealed chain; legacy absence remains unknown.', source: 'Exact validated source observations at the original contractual check times' } } }
      : type.id === 'DeliveryAllocation' ? { ...type, version: String(Number(type.version) + 1), properties: { ...type.properties, verificationBasis: { kind: 'struct', schema: deliveryVariantVerificationSchema, description: 'Source-reported variant identity and quantity allocation; physical color, storage, condition and other attributes remain unobserved.', source: 'Independent delivery source observation; never copied from catalog or checkout attributes' } } }
      : type.id === 'Shipment' ? { ...type, version: String(Number(type.version) + 1), properties: { ...type.properties, expectedAllocation: { kind: 'struct', schema: shipmentExpectedAllocationSchema, description: 'Original quoted package group and expected order-line quantity. A pending planned package is not evidence of dispatch or actual receipt. Historical absence remains unknown.', source: 'Exact immutable quote fixed by the original order agreement, separate from actual delivery allocations' } } }
      : type),
    links: [...base.links,
      { id: 'CommerceProductVariant', description: 'The stable source variant actually described by this sealed product observation; no cross-source identity inference.', from: { type: 'CommerceProduct', name: 'productVariant', many: false }, to: { type: 'ProductVariant', name: 'commerceProductObservations', many: true } },
      { id: 'ProductVariantCurrentCommerceProduct', description: 'Current source product facts. Historical observations and order terms retain their own versions.', from: { type: 'ProductVariant', name: 'currentCommerceProduct', many: false }, to: { type: 'CommerceProduct', name: 'currentProductVariants', many: true } },
      { id: 'OrderLineAgreedCommerceProduct', description: 'Exact historical product observation selected by the agreed quote; later catalog changes never replace it.', from: { type: 'OrderLine', name: 'agreedProduct', many: false }, to: { type: 'CommerceProduct', name: 'agreedOrderLines', many: true } },
      { id: 'OrderLineAgreedLandedCostQuote', description: 'Exact historical complete-price source observation used for the checkout.', from: { type: 'OrderLine', name: 'agreedQuote', many: false }, to: { type: 'LandedCostQuote', name: 'agreedOrderLines', many: true } },
      { id: 'OrderLineAgreedCommerceCheckout', description: 'Exact checkout observation used by the original order submission.', from: { type: 'OrderLine', name: 'agreedCheckout', many: false }, to: { type: 'CommerceCheckout', name: 'agreedOrderLines', many: true } },
      { id: 'OrderLineAgreedCommerceOrder', description: 'Original source submission observation, separate from subsequent order-state reads.', from: { type: 'OrderLine', name: 'agreementOrderObservation', many: false }, to: { type: 'CommerceOrderObservation', name: 'agreedOrderLines', many: true } },
      { id: 'ShipmentExpectedOrderLine', description: 'The exact original order line expected in this planned package; actual received quantities use separate DeliveryAllocation objects.', from: { type: 'Shipment', name: 'expectedOrderLine', many: false }, to: { type: 'OrderLine', name: 'plannedShipments', many: true } },
      { id: 'ShipmentExpectedSourceQuote', description: 'Original source quote for the immutable expected package allocation, without treating the plan as shipment evidence.', from: { type: 'Shipment', name: 'expectedQuote', many: false }, to: { type: 'LandedCostQuote', name: 'plannedShipments', many: true } },
    ],
    functions: [...base.functions,
      { id: 'productAttributesMatch', version: '1', inputTypes: ['ProductVariant', 'ProductOffer', 'CommerceProduct'], description: 'Deterministically compare explicitly requested typed category attributes against their sealed source facts. Missing, untyped, stale or contradictory facts are unknown; prices, stock, merchant identity and authority remain separate.' },
      { id: 'orderLineAgreementStatus', version: '1', inputTypes: ['OrderLine'], description: 'Read the exact sealed source specification and checkout agreement fixed when a new order line was created. Later source changes do not rewrite it. Historical agreement is not current purchasing authority or proof of physical attributes delivered.' },
      { id: 'shipmentAllocationStatus', version: '1', inputTypes: ['Shipment'], description: 'Compare this planned package\'s original source-quoted quantity with independently evidenced actual allocations for its exact order line. Missing packages remain visible as pending; source-reported identity never proves physical attributes were inspected.' },
    ],
  };
}

/** Shared source normalization; excludes price and inventory from specification
 * identity. Call only for a source-validated product record. */
export function commerceProductVariantValues(data: { merchantId: string; variantId: string; title: string; typedAttributes?: ProductAttributes }) {
  return { name: data.title, sourceProductRef: { namespace: `commerce-sandbox:${data.merchantId}`, id: data.variantId },
    specification: [{ name: 'variant', value: data.variantId }], ...(data.typedAttributes ? { typedAttributes: data.typedAttributes } : {}) };
}
