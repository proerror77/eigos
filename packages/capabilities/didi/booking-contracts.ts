import { z } from 'zod';
import { didiReceiptSchema } from './contracts.js';

const text = z.string().min(1).max(500);
export const didiBookingToolInputs = {
  taxi_create_order: z.strictObject({ product_category: text, estimate_trace_id: text }),
  // The provider permits omission; EIGOS always requires the original order ID.
  taxi_query_order: z.strictObject({ order_id: text }),
};
export type DidiBookingTool = keyof typeof didiBookingToolInputs;
export const didiOrderDataSchema = z.strictObject({
  orderId: text, statusCode: z.number().int().optional(), statusText: z.string().min(1).max(6000),
  state: z.enum(['created', 'matching', 'accepted', 'arrived', 'in_trip', 'completed', 'reported', 'unknown']),
  sourceFormat: z.enum(['structured', 'text']), identityBasis: z.enum(['provider_echo', 'requested_order']),
  origin: text.optional(), destination: text.optional(),
  driver: z.strictObject({ name: text.optional(), carModel: text.optional(), carPlate: text.optional() }).optional(),
  independentRead: z.boolean(), finalFare: z.literal('unknown'),
});
export const didiOrderReceiptSchema = didiReceiptSchema.extend({
  environment: z.literal('mock'), endpoint: z.literal('https://mcp.didichuxing.com/mcp-servers-sandbox'),
  tool: z.enum(['taxi_create_order', 'taxi_query_order']),
});
export const didiOrderResultSchema = z.strictObject({ data: didiOrderDataSchema, receipt: didiOrderReceiptSchema });
export type DidiOrderResult = z.infer<typeof didiOrderResultSchema>;

export function mapDidiOrder(tool: DidiBookingTool, raw: unknown, requestedOrderId?: string): z.infer<typeof didiOrderDataSchema> {
  const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown().optional(), content: z.array(z.object({ type: z.string(), text: z.string().max(6000).optional() })).max(10).optional() }).parse(raw);
  if (envelope.isError) throw new Error('Provider rejected the operation');
  // The official mock query currently returns only a text status report. Its
  // identity is the required original order_id in this exact authenticated RPC,
  // not an echoed ID. Preserve the report; never invent a structured trip state.
  if (tool === 'taxi_query_order' && envelope.structuredContent === undefined && requestedOrderId) {
    const report = envelope.content?.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n').trim() ?? '';
    const recognized = report.startsWith('系统正在为您匹配最近的司机') || report.startsWith('系统已为您匹配到司机') && report.includes('司机信息：');
    return didiOrderDataSchema.parse({ orderId: requestedOrderId, statusText: report, state: recognized ? 'reported' : 'unknown',
      sourceFormat: 'text', identityBasis: 'requested_order', independentRead: true, finalFare: 'unknown' });
  }
  const reply = z.object({ isError: z.boolean().optional(), structuredContent: z.object({
    orderId: text, status: text.optional(), statusText: text.optional(), statusCode: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),
    from: z.object({ name: text }).optional(), to: z.object({ name: text }).optional(),
    driver: z.object({ name: text.optional(), carModel: text.optional(), carPlate: text.optional() }).optional(),
  }) }).parse(raw);
  if (reply.isError) throw new Error('Provider rejected the operation');
  const s = reply.structuredContent, statusCode = s.statusCode === undefined ? undefined : Number(s.statusCode);
  const states = { 0: 'matching', 1: 'accepted', 2: 'arrived', 4: 'in_trip', 5: 'completed' } as const;
  const state = tool === 'taxi_create_order' ? 'created' : states[statusCode as keyof typeof states] ?? 'unknown';
  return didiOrderDataSchema.parse({ orderId: s.orderId, statusCode, statusText: s.statusText ?? s.status ?? '未知状态', state, sourceFormat: 'structured', identityBasis: 'provider_echo',
    origin: s.from?.name, destination: s.to?.name, driver: s.driver, independentRead: tool === 'taxi_query_order', finalFare: 'unknown' });
}
