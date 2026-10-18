import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import type { Principal } from '../../../packages/core/domain.js';
import type { NetworkService } from '../../../packages/network/service.js';
import { networkCommandSchema, networkQuerySchema, receiptQuerySchema } from '../../../packages/network/contracts.js';
import { networkFailure } from './routes.js';

export function mountNetworkMcp(server: McpServer, service: NetworkService, principal: Principal, token: string) {
  const wrap = (action: () => unknown): CallToolResult => {
    try { const value = action(); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { result: value } }; }
    catch (error) { const { body } = networkFailure(error); return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: { result: body } }; }
  };
  server.registerTool('network_command', { description: 'Prepare closed-pilot drafts and request a controller review, or consume/revoke only an exact existing publication permission. Cannot approve grants or execute commerce.', inputSchema: networkCommandSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, args => wrap(() => service.command(principal, token, args)));
  server.registerTool('network_query', { description: 'Read allowed private drafts or an exact publication in the closed pilot. No search, task sharing, payments or implicit publication.', inputSchema: networkQuerySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, args => wrap(() => service.query(principal, token, args)));
  server.registerTool('network_get_command', { description: 'Read an earlier command receipt; withdrawn content is never replayed.', inputSchema: receiptQuerySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, args => wrap(() => service.receipt(principal, token, args)));
}
