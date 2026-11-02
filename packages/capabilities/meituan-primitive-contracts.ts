import { z } from 'zod';

const text = z.string().min(1).max(500);
export const privateMeituanAddressSchema = z.object({ address: text, houseNumber: z.string().max(200).optional(), lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180), name: text, cityId: z.union([z.string(), z.number()]), phone: z.string().regex(/^1\d{10}$/) }).strict();
export const meituanPrimitiveSchemas = {
  search_poi: z.strictObject({ keyword: z.string().trim().min(1).max(100), city: z.string().trim().min(1).max(50) }),
  get_address_list: z.strictObject({}),
  get_address_info: z.strictObject({ address_id: z.string().min(1).max(128) }),
  delivery_preview: z.strictObject({ sender: privateMeituanAddressSchema, recipient: privateMeituanAddressSchema,
    goods: z.strictObject({ goodsName: text, goodsWeight: z.number().positive().max(50), goodTypes: z.array(z.union([z.literal(2), z.literal(4), z.literal(8)])).length(1), goodTypeNames: z.array(z.enum(['文件', '快递', '餐饮'])).length(1) }),
    business_type: z.literal(1), service_type: z.enum(['1003', '4033']) }),
};
export type MeituanPrimitiveTool = keyof typeof meituanPrimitiveSchemas;
export const meituanPrimitiveReceiptSchema = z.strictObject({ id: z.uuid(), server: z.literal('meituan-personal'), transport: z.literal('mcp-stdio'), tool: z.enum(['search_poi', 'get_address_list', 'get_address_info', 'delivery_preview']), inputDigest: text, resultDigest: text, observedAt: z.iso.datetime(), evidenceKind: z.enum(['fixture', 'live_readonly']), readOnly: z.literal(true) });
export type MeituanPrimitiveReceipt = z.infer<typeof meituanPrimitiveReceiptSchema>;
export interface MeituanReadContext { accountBinding?: string }
export interface MeituanPrimitiveResult { value: Record<string, unknown>; receipt: MeituanPrimitiveReceipt; accountBinding: string }
export interface MeituanPrimitiveReader {
  readonly configurationDigest: string;
  readonly evidenceKind: 'fixture' | 'live_readonly';
  invoke(tool: string, input: Record<string, unknown>, signal: AbortSignal, context?: MeituanReadContext): Promise<MeituanPrimitiveResult>;
}
