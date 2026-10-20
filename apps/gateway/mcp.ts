import type { NetworkService } from '../../packages/network/service.js';
import type { MemberSourceService } from '../../packages/members/source-service.js';
import { sourceBeginSchema, sourceRevokeSchema } from '../../packages/core/member-source.js';
import { mountNetworkMcp } from './network/mcp.js';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DomainError, versionedReplySchema, resumeTaskSchema, requireScope, submitSchema, ontologySubmitSchema, taskIdSchema, remediationSchema, requestIdSchema, type Principal } from '../../packages/core/domain.js';
import { TaskService } from '../../packages/core/tasks.js';
import { objectQuerySchema } from '../../packages/ontology/object-store.js';
import { functionCallSchema } from '../../packages/ontology/object-functions.js';

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

export function createMcpServer(tasks: TaskService, principal: Principal, network?: { service: NetworkService; token: string }, sources?: { service: MemberSourceService; token: string }): McpServer {
  const server = new McpServer({ name: 'eigos', version: '0.1.0' });
  if (network) mountNetworkMcp(server, network.service, principal, network.token);
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  if (sources) {
    server.registerTool('list_source_connections', { description: 'Discover available account-backed services and the current user\'s own connection status. Visibility does not lend another member\'s credential.', inputSchema: z.object({}).strict(), annotations: read }, () => result(() => sources.service.list(principal, sources.token)));
    server.registerTool('get_source_connection', { description: 'Read this user\'s Meituan connection state, expiry and next action. Accepted credential is not provider verification.', inputSchema: z.object({}).strict(), annotations: read }, () => result(() => sources.service.status(principal, sources.token)));
    server.registerTool('begin_source_connection', { description: 'Begin or rotate the user\'s own read-only Meituan connection. The PA must obtain the credential locally and upload through the returned private HTTP path. Never send a token through MCP or task text.', inputSchema: sourceBeginSchema, annotations: { idempotentHint: true, destructiveHint: false } }, args => result(() => sources.service.begin(principal, sources.token, args)));
    server.registerTool('revoke_source_connection', { description: 'Revoke this user\'s source connection and all pending upload requests immediately. Does not revoke the provider account itself.', inputSchema: sourceRevokeSchema, annotations: { idempotentHint: true, destructiveHint: true } }, args => result(() => sources.service.revoke(principal, sources.token, args)));
    server.registerTool('resume_source_task', { description: 'Resume the SAME owned task after its source connection is ready. Re-reads addresses and price; no order or payment authorization.', inputSchema: z.object({ taskId: taskIdSchema, requestId: z.uuid(), expectedRevision: z.number().int().positive() }).strict(), annotations: { idempotentHint: true, destructiveHint: false } }, args => result(() => sources.service.resume(principal, sources.token, args)));
  }
  server.registerTool('describe_ontology', {
    description: 'Read bounded business object/interface definitions, properties, source semantics and bidirectional links. Definitions do not grant access or prove live supply.',
    inputSchema: z.object({ search: z.string().max(100).optional(), limit: z.number().int().min(1).max(5).optional(), after: z.string().optional() }).strict(), annotations: read,
  }, args => result(() => tasks.describeOntology(principal, args)));
  server.registerTool('query_ontology', {
    description: 'Read only owned business objects or one named relationship. Filters and projections use registered fields; private fields are forbidden. Inspect hasMore/cursor, source kind and evidence level.',
    inputSchema: objectQuerySchema, annotations: read,
  }, args => result(() => tasks.queryOntology(principal, args)));
  server.registerTool('evaluate_ontology', {
    description: 'Run a registered, bounded, read-only business calculation. Missing or incompatible evidence stays unknown; synthetic evidence is never live fulfillment.',
    inputSchema: functionCallSchema, annotations: read,
  }, args => result(() => tasks.evaluateOntology(principal, args)));
  server.registerTool('list_services', {
    description: 'Discover configured EIGOS services and their actual scope. The ontology backend exposes eigos.delegate and optional sandbox after-sales.',
    inputSchema: z.object({}), annotations: read,
  }, () => result(() => { requireScope(principal, 'services:read'); return tasks.services(); }));
  server.registerTool('submit_task', {
    description: 'Submit a goal to a discovered service. eigos.delegate uses Ontology + LLM, provider facts, validated plans and independent acceptance; optional structured requirements preserve explicit hard constraints. Use executionBudget=extended when longer work is requested. Discover the current scope first. Reuse requestId for identical retries; never create a replacement to escape a task budget.',
    inputSchema: submitSchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args: unknown) => result(() => tasks.submit(principal, args)));
  server.registerTool('get_task', {
    description: 'Read an owned task, current revision, pending question and artifacts. Technical recovering/paused states do not request business input: preserve this task and confirmed facts; never create a replacement. Only input-required asks for missing owner facts. Works across MCP/A2A.',
    inputSchema: z.object({ taskId: taskIdSchema }).strict(), annotations: read,
  }, ({ taskId }) => result(() => tasks.get(principal, taskId)));
  server.registerTool('get_member_usage', {
    description: 'Read only the authenticated member’s recorded EIGOS Worker usage across tasks. Member limits are disabled. Unknown/unreported usage is separate; task safety budgets still apply.',
    inputSchema: z.object({}).strict(), annotations: read,
  }, () => result(() => tasks.usage(principal)));
  server.registerTool('list_tasks', {
    description: 'List tasks owned by the authenticated user within the authenticated organization.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(1_000_000).default(0) }).strict(),
    annotations: read,
  }, args => result(() => tasks.list(principal, args)));
  server.registerTool('reply_to_task', {
    description: 'Answer the current owned task question using expectedRevision from get_task. A later explicit correction replaces the corresponding old value and retains unchanged facts. Technical pauses use resume_task, not a fabricated owner reply. A reply never grants business authorization. Reuse requestId only for identical retries.',
    inputSchema: versionedReplySchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(() => tasks.reply(principal, args)));
  server.registerTool('amend_task', {
    description: 'Apply an owner correction to the SAME open read-only task, including while it is working or waiting for source login. Read current expectedRevision first. Obsolete in-flight results cannot overwrite the correction. Fixed business effects cannot be amended here.',
    inputSchema: versionedReplySchema, annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(() => tasks.amend(principal, args)));
  server.registerTool('resume_task', {
    description: 'Resume the SAME technically paused read-only task after its runtime prerequisite has been restored. No owner answer or repeated business confirmation is needed. Preserve history and cumulative usage; this grants no new business authority. Do not repeatedly call while the failure is unchanged.',
    inputSchema: resumeTaskSchema, annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(() => tasks.resume(principal, args)));
  server.registerTool('cancel_task', {
    description: 'Cancel an owned open ontology task. Completed tasks cannot be canceled. This does not cancel or reverse provider orders.',
    inputSchema: z.object({ taskId: taskIdSchema }).strict(),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ taskId }) => result(() => tasks.cancel(principal, taskId)));
  if (tasks.services().some(s => s.id === 'eigos.delegate')) {
    server.registerTool('reconcile_task', { description: 'Query the original owned business operation after an unknown result; never place a replacement order.', inputSchema: z.object({ taskId: taskIdSchema, requestId: requestIdSchema }).strict(), annotations: { idempotentHint: true, destructiveHint: false } }, ({ taskId, requestId }) => result(() => tasks.reconcile(principal, taskId, requestId)));
    server.registerTool('revoke_task_authorization', { description: 'Revoke permits for future dispatch. In-flight facts still require reconciliation; this does not reverse an order or payment.', inputSchema: z.object({ taskId: taskIdSchema, requestId: requestIdSchema }).strict(), annotations: { idempotentHint: true, destructiveHint: false } }, ({ taskId, requestId }) => result(() => tasks.revokeAuthorization(principal, taskId, requestId)));
    if (tasks.services().some(s => s.id === 'eigos.aftersales')) server.registerTool('request_remediation', { description: 'Create a separate linked cancellation/refund task for a verified owned operation. A request or application is not proof of cancellation/refund success. Only explicitly configured sandbox effects are enabled.', inputSchema: remediationSchema, annotations: { idempotentHint: true, destructiveHint: false } }, args => result(() => tasks.requestRemediation(principal, args)));
  }
  return server;
}
