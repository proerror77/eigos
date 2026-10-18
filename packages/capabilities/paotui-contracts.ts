import { z } from 'zod';

export const publicGeoQuerySchema = z.object({ keyword: z.string().trim().min(1).max(100), city: z.string().trim().min(1).max(50) }).strict();
export const paotuiPreviewSchema = z.object({ action: z.literal('preview'), senderAddressId: z.string().min(1).max(128), recipientAddressId: z.string().min(1).max(128), goodsName: z.string().trim().min(1).max(100), category: z.enum(['文件', '快递', '餐饮']), weightKg: z.number().positive().max(50), service: z.enum(['ordinary', 'express']).default('ordinary') }).strict();
export const paotuiQuerySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('authorization') }).strict(),
  z.object({ action: z.literal('addresses') }).strict(),
  paotuiPreviewSchema,
  z.object({ action: z.literal('search_address'), ...publicGeoQuerySchema.shape }).strict(),
]);
export type PaotuiQuery = z.infer<typeof paotuiQuerySchema>;
export interface PaotuiReader { query(input: PaotuiQuery, signal: AbortSignal): Promise<object> }
