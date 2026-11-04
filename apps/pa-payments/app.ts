/** A separate, PA-owned MCP endpoint. Never mounted by Gateway or Worker. */
import { timingSafeEqual } from 'node:crypto';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { noSpendAuthoritySchema, taobaoCatalogReadSchema, rehearsalOrderSchema,
  prepareTaobaoShopping, prepareAlipayRehearsal } from '../../packages/pa/alipay-agent-pay.js';

export function createPAPaymentsApp(accessToken: string) {
  if (!/^[a-f0-9]{64}$/.test(accessToken)) throw new Error('Use a separate private PA tools token');
  const app = createMcpExpressApp({ host: '127.0.0.1', allowedHosts: ['127.0.0.1'], allowedOrigins: ['127.0.0.1'], jsonLimit: '64kb' });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'pa-alipay-no-spend', version: '1.0.0' });
    const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const output = (value: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value });
    server.registerTool('get_payment_policy', { description: 'Read this PA connector policy. Real order creation and real Alipay payment submission are disabled.',
      inputSchema: z.strictObject({}), annotations }, () => output({ mode: 'rehearsal_only', paymentAuthority: 'pa_owned',
      realOrdersAllowed: false, realPaymentsAllowed: false, credentialsAccepted: false, officialPaymentVerified: false }));
    const input = z.strictObject({ catalogRead: taobaoCatalogReadSchema, authority: noSpendAuthoritySchema });
    server.registerTool('prepare_taobao_shopping', { description: 'Prepare a shopping draft from the original EIGOS Taobao catalog result. Reference prices cannot become a final order or payment. Does not contact Taobao or Alipay.',
      inputSchema: input, annotations }, args => output(prepareTaobaoShopping(args.catalogRead, args.authority)));
    server.registerTool('prepare_alipay_rehearsal', { description: 'Validate synthetic Taobao order materials and prepare the official Alipay Agent Pay argument contract without executing it. Only reserved .invalid cashier URLs are accepted. Returns no payment link or wallet credentials.',
      inputSchema: input.extend({ order: rehearsalOrderSchema, sessionId: z.uuid() }), annotations }, args =>
      output(prepareAlipayRehearsal(args.catalogRead, args.authority, args.order, args.sessionId).preparation));
    return server;
  }, { legacy: 'stateless', maxSubscriptions: 0 });
  const nodeHandler = toNodeHandler(handler);
  app.all('/mcp', async (req, res) => {
    const received = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${accessToken}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) { res.sendStatus(401); return; }
    await nodeHandler(req, res, req.body);
  });
  return app;
}
