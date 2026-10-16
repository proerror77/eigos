import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DomainError, replySchema, requireScope, submitSchema, taskIdSchema, type Principal } from '../../packages/core/domain.js';
import { TaskService } from '../../packages/core/tasks.js';

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
    description: 'Discover configured EIGOS services and their actual scope. Optional life.request accepts everyday service goals for intake only, without provider execution. Other services have their own stated limits.',
    inputSchema: z.object({}), annotations: read,
  }, () => result(() => { requireScope(principal, 'services:read'); return tasks.services(); }));
  server.registerTool('submit_task', {
    description: 'Submit a goal to a discovered service. life.request preserves the original everyday-service goal and returns a submitted task with an intake receipt: waiting_provider, execution=not_started, businessCompleted=false; it does not search, order, book or pay. Use get_task to inspect, reply_to_task to add information, cancel_task to withdraw. Other services: brief.prepare, configured agent.execute, local Paotui JSON queries, or CSV simulation with datasetId/fileName. Reuse requestId for identical retries.',
    inputSchema: submitSchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    description: 'Add information to an open life.request without starting execution, or answer an owned task waiting for input. For CSV simulation, confirmation requires action=confirm_simulated_payment, quoteId and quoteDigest; plain answer cannot approve payment. Reuse requestId only for identical retries.',
    inputSchema: replySchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(() => tasks.reply(principal, args)));
  server.registerTool('cancel_task', {
    description: 'Cancel an owned open task or life.request registration. Completed tasks cannot be canceled. This does not cancel or reverse provider orders.',
    inputSchema: z.object({ taskId: taskIdSchema }).strict(),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ taskId }) => result(() => tasks.cancel(principal, taskId)));
  return server;
}
