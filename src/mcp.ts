import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DomainError, replySchema, requireScope, submitSchema, taskIdSchema, type Principal } from './domain.js';
import { TaskService } from './tasks.js';

function result(action: () => unknown): CallToolResult {
  try {
    const value = action();
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { result: value } };
  } catch (error) {
    if (error instanceof DomainError) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code, message: error.message }) }] };
    }
    throw error;
  }
}

export function createMcpServer(tasks: TaskService, principal: Principal): McpServer {
  const server = new McpServer({ name: 'eigos', version: '0.1.0' });
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool('list_services', {
    description: 'List currently configured EIGOS capabilities. agent.execute is available only when a real executor is configured. No purchases or external business actions.',
    inputSchema: z.object({}), annotations: read,
  }, () => result(() => { requireScope(principal, 'services:read'); return tasks.services(); }));
  server.registerTool('submit_task', {
    description: 'Submit brief.prepare or configured agent.execute. A model task initially returns working: use get_task to retrieve its question or deliverable. Reply to input-required tasks with reply_to_task. Reuse requestId for identical retries.',
    inputSchema: submitSchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(() => tasks.submit(principal, args)));
  server.registerTool('get_task', {
    description: 'Read an owned task, its pending question and artifacts. Works for tasks created through MCP or A2A.',
    inputSchema: z.object({ taskId: taskIdSchema }).strict(), annotations: read,
  }, ({ taskId }) => result(() => tasks.get(principal, taskId)));
  server.registerTool('list_tasks', {
    description: 'List tasks owned by the authenticated user within the authenticated organization.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(1_000_000).default(0) }).strict(),
    annotations: read,
  }, args => result(() => tasks.list(principal, args)));
  server.registerTool('reply_to_task', {
    description: 'Answer an owned task waiting for input. For agent.execute, the model continues with the full task history; poll get_task while working. Reuse requestId only for identical retries.',
    inputSchema: replySchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(() => tasks.reply(principal, args)));
  server.registerTool('cancel_task', {
    description: 'Cancel an owned task waiting for input. A completed task cannot be canceled.',
    inputSchema: z.object({ taskId: taskIdSchema }).strict(),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ taskId }) => result(() => tasks.cancel(principal, taskId)));
  return server;
}
