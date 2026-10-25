import { z } from 'zod';
import { didiToolInputs } from './contracts.js';
export const MOCK_ORDER_ENDPOINT = 'https://mcp.didichuxing.com/mcp-servers-sandbox';
const text = z.string().min(1).max(3000);
export const mockOrderInputs = {
  taxi_estimate: didiToolInputs.taxi_estimate,
  taxi_create_order: z.strictObject({ product_category: z.literal('1'), estimate_trace_id: text }),
  taxi_query_order: z.strictObject({ order_id: text }),
};
export type MockOrderTool = keyof typeof mockOrderInputs;
export const mockOrderReceiptSchema = z.strictObject({
  id: z.uuid(), bindingId: z.string(), environment: z.literal('mock'), endpoint: z.literal(MOCK_ORDER_ENDPOINT), tool: z.enum(['taxi_estimate', 'taxi_create_order', 'taxi_query_order']),
  inputDigest: z.string(), responseSha256: z.string(), toolSchemaDigest: z.string(), startedAt: z.iso.datetime(), receivedAt: z.iso.datetime(),
});
