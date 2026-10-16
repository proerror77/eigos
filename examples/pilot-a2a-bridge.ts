// A thin transport adapter for a client without native A2A tools. No workflow decisions.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
const targets = JSON.parse(process.env.EIGOS_SIM_TARGETS ?? '{}') as Record<string, string>;
const token = process.env.EIGOS_SIM_ACCESS_TOKEN;
if (!token) throw new Error('Missing ephemeral simulation credential');
for (const base of Object.values(targets)) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/') throw new Error('Loopback origins only');
}
const server = new McpServer({ name: 'simulation-a2a-transport', version: '1.0.0' });
server.registerTool('a2a_request', {
  description: 'Forward one A2A 1.0 JSON-RPC request to a local CSV simulation gateway. SendMessage params: {message:{messageId,role:"ROLE_USER",taskId(optional),parts:[{data:{...}}]},configuration:{returnImmediately:true}}. GetTask params:{id}. The model chooses all arguments; no workflow automation.',
  inputSchema: z.object({ scenario: z.enum(['normal', 'repair', 'refund']), method: z.enum(['SendMessage', 'GetTask']), params: z.record(z.string(), z.unknown()) }).strict(),
}, async ({ scenario, method, params }) => {
  const base = targets[scenario]; if (!base) throw new Error('Unknown simulation target');
  const response = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }), signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  return { isError: !response.ok || !!body.error, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
});
await server.connect(new StdioServerTransport());
