import { z } from 'zod';

export const commerceProviders = ['alipay', 'wechatpay', 'unionpay', 'taobao'] as const;
export const commerceProviderSchema = z.enum(commerceProviders);
export type CommerceProvider = z.infer<typeof commerceProviderSchema>;
export const commerceParameters = {
  QueryAlipayTrade: z.strictObject({ outTradeNo: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
  QueryWechatPayTrade: z.strictObject({ outTradeNo: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/) }),
  QueryUnionPayTrade: z.strictObject({ orderId: z.string().regex(/^[A-Za-z0-9]{8,40}$/), txnTime: z.string().regex(/^\d{14}$/) }),
  SearchTaobaoProducts: z.strictObject({ query: z.string().trim().min(1).max(200), page: z.number().int().min(1).max(100), limit: z.number().int().min(1).max(20) }),
  GetTaobaoProducts: z.strictObject({ itemIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).min(1).max(20).refine(ids => new Set(ids).size === ids.length) }),
};
export type CommerceReadAction = keyof typeof commerceParameters;
export const commerceQuerySchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('QueryAlipayTrade'), parameters: commerceParameters.QueryAlipayTrade }),
  z.strictObject({ action: z.literal('QueryWechatPayTrade'), parameters: commerceParameters.QueryWechatPayTrade }),
  z.strictObject({ action: z.literal('QueryUnionPayTrade'), parameters: commerceParameters.QueryUnionPayTrade }),
  z.strictObject({ action: z.literal('SearchTaobaoProducts'), parameters: commerceParameters.SearchTaobaoProducts }),
  z.strictObject({ action: z.literal('GetTaobaoProducts'), parameters: commerceParameters.GetTaobaoProducts }),
]);
export type CommerceQuery = z.infer<typeof commerceQuerySchema>;
export const providerActions: Record<CommerceProvider, CommerceReadAction[]> = {
  alipay: ['QueryAlipayTrade'], wechatpay: ['QueryWechatPayTrade'], unionpay: ['QueryUnionPayTrade'], taobao: ['SearchTaobaoProducts', 'GetTaobaoProducts'],
};
export const providerNames: Record<CommerceProvider, string> = { alipay: '支付宝', wechatpay: '微信支付', unionpay: '银联', taobao: '淘宝' };
export const providerCapabilityIds: Record<CommerceProvider, string> = {
  alipay: 'alipay.trade.query', wechatpay: 'wechatpay.trade.query', unionpay: 'unionpay.trade.query', taobao: 'taobao.catalog.query',
};
export interface CommerceReadSource {
  invoke(query: CommerceQuery, signal: AbortSignal): Promise<{ result: Record<string, unknown>; observedAt: string }>;
}
export class CommerceReadError extends Error {
  constructor(readonly provider: CommerceProvider, readonly requestId?: string) {
    super(`${provider} read unavailable; verify the private connection, source permission and provider response. No order or payment was sent.`);
    this.name = 'CommerceReadError';
  }
}
