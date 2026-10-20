import { z } from 'zod';

// Saved-address coordinates use the official CLI integer microdegree contract, unchanged.
// Provider-only payloads. These schemas are never used as model action schemas.
const id = z.union([z.string().min(1).max(128), z.number().finite()]).transform(String);
export const savedAddressSchema = z.object({ addressId: id, address: z.string().min(1).max(300), houseNumber: z.string().max(200).nullish(), cityId: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,11}$/)]).transform(String),
  name: z.string().max(100).nullish(), tag: z.union([z.string().max(100), z.number().finite(), z.null()]).optional(), lat: z.number().int().min(-90000000).max(90000000), lng: z.number().int().min(-180000000).max(180000000) });
export type SavedAddress = z.infer<typeof savedAddressSchema>;
export const contactSchema = z.object({ phone: z.string().regex(/^1\d{10}$/) });
export const parcelInputSchema = z.strictObject({ goodsName: z.string().trim().min(1).max(100), category: z.enum(['文件', '快递', '餐饮']), weightKg: z.number().positive().max(50), service: z.enum(['ordinary', 'express']) });
const providerAddress = savedAddressSchema.omit({ addressId: true, tag: true }).extend({ cityId: z.number().int().positive(), houseNumber: z.string().max(200).optional(), name: z.string().max(100).optional(), ...contactSchema.shape }).strict();
export const atomicPaotuiSchemas = {
  get_address_list: z.strictObject({}),
  get_address_info: z.strictObject({ addressId: z.string().min(1).max(128) }),
  delivery_preview: z.strictObject({ sender: providerAddress, recipient: providerAddress, ...parcelInputSchema.shape }),
};
export type PaotuiOperation = keyof typeof atomicPaotuiSchemas;
export const paotuiOperations = Object.keys(atomicPaotuiSchemas) as [PaotuiOperation, ...PaotuiOperation[]];
const amount = z.union([z.number().finite().nonnegative(), z.string()]).transform(String).pipe(z.string().regex(/^\d+(?:\.\d{1,2})?$/));
export const atomicResultSchemas = {
  get_address_list: z.object({ addresses: z.array(savedAddressSchema).max(100).refine(a => new Set(a.map(v => v.addressId)).size === a.length), accountIdentity: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  get_address_info: contactSchema,
  delivery_preview: z.object({ _previewTotal: amount, _deliveryFee: amount, feeDisplay: z.string().max(500).optional(), estimateTime: z.union([z.string().max(100), z.number().finite()]).optional(), distance: z.union([z.string().max(100), z.number().finite()]).optional() }),
};
export const atomicDefinition = (operation: PaotuiOperation) => ({ operation, version: '1', effect: 'read', inputSchema: z.toJSONSchema(atomicPaotuiSchemas[operation]) });
export const atomicTool = (operation: PaotuiOperation) => `source_${operation}`;
export const atomicReceiptSchema = z.strictObject({ id: z.uuid(), server: z.literal('eigos-ontology'), transport: z.literal('mcp-stdio'), version: z.literal('1'),
  operation: z.enum(paotuiOperations), tool: z.string(), evidenceKind: z.enum(['live_readonly', 'fixture']), inputDigest: z.string().regex(/^[a-f0-9]{64}$/), resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.iso.datetime(), sourceConnectionDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), sourceCalls: z.array(z.string()).length(1), readOnly: z.literal(true) });
export type AtomicReceipt = z.infer<typeof atomicReceiptSchema>;
export interface PaotuiAtomicReader { invoke(operation: PaotuiOperation, input: Record<string, unknown>, signal: AbortSignal): Promise<{ result: Record<string, unknown>; receipt: AtomicReceipt }> }
