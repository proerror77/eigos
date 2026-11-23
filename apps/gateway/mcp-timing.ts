import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';
import { withOperationTiming } from '../../packages/core/operation-timing.js';

const toolCall = z.object({
  method: z.literal('tools/call'),
  params: z.object({ name: z.enum(['submit_task', 'get_task', 'complete_with_action']) }),
});
const taskResult = z.object({ id: z.uuid(), state: z.string(), createdAt: z.date(), updatedAt: z.date(), result: z.unknown() });

type Call = {
  mcpRequestId: string;
  tool: z.infer<typeof toolCall>['params']['name'];
  clientId?: string;
  toolStartedAt?: string;
  toolFinishedAt?: string;
  toolStatus?: number;
  taskId?: string;
  taskState?: string;
  taskCreatedAt?: string;
  taskCompletedAt?: string;
  resultIncluded?: boolean;
};

/** Record transport timings without retaining the request or response payload. */
export function startMcpTiming(res: Response) {
  const receivedAt = new Date().toISOString(), started = performance.now();
  let call: Call | undefined;
  const log = (transport: 'sent' | 'closed') => {
    if (!call) return;
    console.info(JSON.stringify({
      event: 'mcp_request', ...call, receivedAt, finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started), transport,
      httpStatus: res.headersSent ? res.statusCode : undefined,
    }));
    call = undefined;
  };
  res.once('finish', () => log('sent'));
  res.once('close', () => log('closed'));

  return (body: unknown, clientId?: string) => {
    const parsed = toolCall.safeParse(body);
    if (!parsed.success) return;
    const entry: Call = { mcpRequestId: randomUUID(), tool: parsed.data.params.name, clientId };
    call = entry;
    res.setHeader('X-EIGOS-MCP-Request-Id', entry.mcpRequestId);
    return {
      start() { entry.toolStartedAt = new Date().toISOString(); },
      run<T>(operation: () => Promise<T>) { return withOperationTiming({ mcpRequestId: entry.mcpRequestId }, operation); },
      succeed(result: unknown) {
        entry.toolFinishedAt = new Date().toISOString();
        entry.toolStatus = 200;
        if (entry.tool === 'complete_with_action') {
          entry.resultIncluded = result != null;
          return;
        }
        const snapshot = taskResult.safeParse(result);
        if (!snapshot.success) return;
        const { id, state, createdAt, updatedAt, result: visibleResult } = snapshot.data;
        entry.taskId = id;
        entry.taskState = state;
        entry.taskCreatedAt = createdAt.toISOString();
        entry.resultIncluded = visibleResult != null;
        if (state === 'completed') entry.taskCompletedAt = updatedAt.toISOString();
      },
      fail(status: number) {
        entry.toolFinishedAt = new Date().toISOString();
        entry.toolStatus = status;
      },
    };
  };
}
