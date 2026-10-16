import { z } from 'zod';

export const paotuiPreviewSchema = z.object({ action: z.literal('preview'), senderAddressId: z.string().min(1).max(128), recipientAddressId: z.string().min(1).max(128), goodsName: z.string().trim().min(1).max(100), category: z.enum(['文件', '快递', '餐饮']), weightKg: z.number().positive().max(50), service: z.enum(['ordinary', 'express']).default('ordinary') }).strict();
export const paotuiQuerySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('authorization') }).strict(),
  z.object({ action: z.literal('addresses') }).strict(),
  paotuiPreviewSchema,
  z.object({ action: z.literal('search_address'), keyword: z.string().trim().min(1).max(100), city: z.string().trim().min(1).max(50) }).strict(),
]);
export type PaotuiQuery = z.infer<typeof paotuiQuerySchema>;
export interface PaotuiReader { query(input: PaotuiQuery, signal: AbortSignal): Promise<object> }

export const previewInputSchema = paotuiPreviewSchema;
export const orderQuerySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare_order'), intentId: z.string().min(1).max(128), preview: previewInputSchema }).strict(),
  z.object({ action: z.literal('confirm_order'), previewId: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), amountFen: z.number().int().nonnegative(), confirmation: z.literal('确认下单') }).strict(),
  z.object({ action: z.literal('payment_links'), previewId: z.uuid() }).strict(),
  z.object({ action: z.literal('order_state'), previewId: z.uuid() }).strict(),
]);
