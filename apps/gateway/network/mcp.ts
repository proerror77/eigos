import { updatesQuerySchema } from '../../../packages/network/activity-contracts.js';
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
  server.registerTool('network_command', { description: 'Manage own need, structured response, one-hop listing referral and service drafts; close own needs; set private follows; prepare fixed-field evidence summaries from owned results without copying private payloads; prepare private inquiry/quote choices and apply them only after controller confirmation; manage representation requests, request controller approval, and publish or withdraw exact approved content in invited circles. Cannot approve grants, perform operator reviews or execute commerce.', inputSchema: networkCommandSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, args => wrap(() => service.command(principal, token, args)));
  server.registerTool('network_query', { description: 'Read authorized needs, structured messages, Agent profiles, reviewed service listings, private drafts, approved evidence cards and owned inquiries/selections; search only visible content in invited circles. Role verification and per-account binding eligibility do not prove current availability or permit commerce.', inputSchema: networkQuerySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, args => wrap(() => service.query(principal, token, args)));
  server.registerTool('network_updates', { description: 'Pull currently authorized publication and need-state notifications in bounded pages. Follow filters do not grant access. Persist page cursor/checkpoint; deduplicate by eventId; clear cached data and restart on CURSOR_STALE. No model, task, commerce or external push is triggered.', inputSchema: updatesQuerySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, args => wrap(() => service.updates(principal, token, args)));
  server.registerTool('network_get_command', { description: 'Read an earlier command receipt; withdrawn content is never replayed.', inputSchema: receiptQuerySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, args => wrap(() => service.receipt(principal, token, args)));
}
