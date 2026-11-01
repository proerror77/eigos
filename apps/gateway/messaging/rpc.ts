import { COMMUNICATION_SCHEMA, MESSAGING_TOOLS, operationScope, type MessagingOperation } from '../../../packages/agent-messaging/contracts.js';

/** Select only explicit communication operations. Unknown/compound requests never acquire business access. */
export function communicationIntent(path: string, body: unknown): 'call' | 'discovery' | undefined {
  path = path.replace(/\/$/, '');
  if (path === '/mcp' && body === undefined) return 'discovery';
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  if (path === '/communication') return 'call';
  const rpc = body as { method?: unknown; params?: { name?: unknown; message?: { parts?: { data?: { schema?: unknown } }[] } } };
  if (path === '/mcp') {
    if (['initialize', 'server/discover', 'tools/list', 'ping', 'notifications/initialized'].includes(String(rpc.method))) return 'discovery';
    if (rpc.method === 'tools/call' && typeof rpc.params?.name === 'string' && Object.hasOwn(MESSAGING_TOOLS, rpc.params.name)) return 'call';
  }
  if (path === '/a2a' && rpc.method === 'SendMessage' && Array.isArray(rpc.params?.message?.parts)
    && rpc.params.message.parts.some(part => typeof part?.data?.schema === 'string' && part.data.schema.startsWith('eigos.agent-communication/'))) return 'call';
}
export function communicationScope(path: string, body: unknown): 'messaging:read' | 'messaging:write' {
  path = path.replace(/\/$/, '');
  const rpc = body as { params?: { name?: keyof typeof MESSAGING_TOOLS; message?: { parts?: { data?: { schema?: string; operation?: { action?: string } } }[] } } };
  const action = path === '/communication' ? (body as { operation?: { action?: string } }).operation?.action : path === '/mcp' && rpc.params?.name ? MESSAGING_TOOLS[rpc.params.name]
    : rpc.params?.message?.parts?.find(part => part?.data?.schema === COMMUNICATION_SCHEMA)?.data?.operation?.action;
  return operationScope(action as MessagingOperation['action']);
}
