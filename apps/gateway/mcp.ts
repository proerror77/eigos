import type { NetworkService } from '../../packages/network/service.js';
import type { MemberSourceService } from '../../packages/members/source-service.js';
import { sourceBeginSchema, sourceRevokeSchema } from '../../packages/core/member-source.js';
import { mountNetworkMcp } from './network/mcp.js';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DomainError, versionedReplySchema, resumeTaskSchema, requireScope, submitSchema, ontologySubmitSchema, taskIdSchema, remediationSchema, requestIdSchema, type Principal } from '../../packages/core/domain.js';
import { TaskService } from '../../packages/core/tasks.js';
import { taskSummary } from '../../packages/core/task-summary.js';
import { objectQuerySchema } from '../../packages/ontology/object-store.js';
import { functionCallSchema } from '../../packages/ontology/object-functions.js';
import { paPaymentReportSchema, paPaymentRouteSchema } from '../../packages/core/pa-payment.js';
import type { DefinitionService } from '../../packages/ontology/definition-service.js';
import { ontologyIdSchema, ontologyReleaseRefSchema } from '../../packages/ontology/definition-contracts.js';
import { mountDefinitionMcp } from './ontology/mcp.js';
import { externalDraftPermitSchema } from '../../packages/ontology/external-draft.js';

async function result(action: () => unknown): Promise<CallToolResult> {
  try {
    const value = await action();
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { result: value } };
  } catch (error) {
    if (error instanceof DomainError) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code, message: error.message }) }] };
    }
    throw error;
  }
}

export function createMcpServer(tasks: TaskService, principal: Principal, network?: { service: NetworkService; token: string }, sources?: { service: MemberSourceService; token: string }, definitions?: DefinitionService, options: { payment?: boolean; externalDrafts?: boolean } = {}): McpServer {
  const server = new McpServer({ name: 'eigos', version: '0.1.0' });
  if (definitions) mountDefinitionMcp(server, definitions, principal);
  if (network) mountNetworkMcp(server, network.service, principal, network.token);
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const ontologyContext = { ontologyId: ontologyIdSchema.optional(), taskId: taskIdSchema.optional(), release: ontologyReleaseRefSchema.optional() };
  if (sources) {
    server.registerTool('list_source_connections', { description: 'Discover available account-backed services and the current user\'s own connection status. Visibility does not lend another member\'s credential.', inputSchema: z.object({}).strict(), annotations: read }, () => result(() => sources.service.list(principal, sources.token)));
    server.registerTool('get_source_connection', { description: 'Read this user\'s Meituan connection state, expiry and next action. Accepted credential is not provider verification.', inputSchema: z.object({}).strict(), annotations: read }, () => result(() => sources.service.status(principal, sources.token)));
    server.registerTool('begin_source_connection', { description: 'Begin or rotate the user\'s own read-only Meituan connection. The PA must obtain the credential locally and upload through the returned private HTTP path. Never send a token through MCP or task text.', inputSchema: sourceBeginSchema, annotations: { idempotentHint: true, destructiveHint: false } }, args => result(() => sources.service.begin(principal, sources.token, args)));
    server.registerTool('revoke_source_connection', { description: 'Revoke this user\'s source connection and all pending upload requests immediately. Does not revoke the provider account itself.', inputSchema: sourceRevokeSchema, annotations: { idempotentHint: true, destructiveHint: true } }, args => result(() => sources.service.revoke(principal, sources.token, args)));
    server.registerTool('resume_source_task', { description: 'Resume the SAME owned task after its source connection is ready. Re-reads addresses and price; no order or payment authorization.', inputSchema: z.object({ taskId: taskIdSchema, requestId: z.uuid(), expectedRevision: z.number().int().positive() }).strict(), annotations: { idempotentHint: true, destructiveHint: false } }, args => result(() => taskSummary(sources.service.resume(principal, sources.token, args))));
  }
  server.registerTool('describe_ontology', {
    description: 'Read bounded business object/interface definitions, properties, source semantics and bidirectional links. Definitions do not grant access or prove live supply.',
    inputSchema: z.object({ ...ontologyContext, search: z.string().max(100).optional(), limit: z.number().int().min(1).max(5).optional(), after: z.string().optional(), kind: z.enum(['types', 'actions', 'functions']).optional().describe('Discover types with related contracts by default; use actions or functions to page through their complete catalogues') }).strict(), annotations: read,
  }, args => result(() => tasks.describeOntology(principal, args)));
  server.registerTool('query_ontology', {
    description: 'Read only owned business objects or one named relationship. Filters and projections use registered fields; private fields are forbidden. Inspect hasMore/cursor, source kind and evidence level.',
    inputSchema: z.union(objectQuerySchema.options.map(schema => schema.safeExtend(ontologyContext))), annotations: read,
  }, args => result(() => tasks.queryOntology(principal, args, network?.service.ontologyReader(principal, network.token))));
  server.registerTool('evaluate_ontology', {
    description: 'Run a registered, bounded, read-only business calculation. Missing or incompatible evidence stays unknown; synthetic evidence is never live fulfillment.',
    inputSchema: z.union(functionCallSchema.options.map(schema => schema.safeExtend(ontologyContext))), annotations: read,
  }, args => result(() => tasks.evaluateOntology(principal, args, network?.service.ontologyReader(principal, network.token))));
  server.registerTool('list_services', {
    description: 'Discover configured EIGOS services and their actual scope. The ontology backend exposes eigos.delegate and optional sandbox after-sales.',
    inputSchema: z.object({}), annotations: read,
  }, () => result(() => { requireScope(principal, 'services:read'); return tasks.services(); }));
  server.registerTool('submit_task', {
    description: 'Submit a goal to a discovered service. eigos.delegate uses Ontology + LLM, provider facts, validated plans and independent acceptance; optional structured requirements preserve explicit hard constraints. Use executionBudget=extended when longer work is requested. Discover the current scope first. Reuse requestId for identical retries; never create a replacement to escape a task budget.',
    inputSchema: submitSchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args: unknown) => result(() => taskSummary(tasks.submit(principal, args))));
  server.registerTool('get_task', {
    description: 'Read an owned task business summary with current revision, pending question, authorization/recovery status and intact artifacts. While submitted/working, use waitMs up to 30000 to await a terminal state or needed action without rapid repeated calls. Timeout returns the unchanged original task and never cancels execution. Internal model and ontology histories stay in EIGOS. Technical recovering/paused states do not request business input: preserve this task and confirmed facts; never create a replacement. Only input-required asks for missing owner facts. Works across MCP/A2A.',
    inputSchema: z.object({ taskId: taskIdSchema, waitMs: z.number().int().min(0).max(30000).optional() }).strict(), annotations: read,
  }, ({ taskId, waitMs }) => result(async () => taskSummary(await tasks.getAfterWait(principal, taskId, waitMs))));
  if (options.externalDrafts) server.registerTool('authorize_checkout_draft', {
    description: 'Authorize exactly one live unpaid checkout draft for the merchant, items and source preview returned by this owned task. Copy its planDigest and draft unchanged; expiresAt may copy draft.sourceExpiresAt and must not exceed it. This grants no order, payment, customer-data submission or later edit. Reuse requestId for identical retries.',
    inputSchema: externalDraftPermitSchema.omit({ action: true, environment: true }).extend({ taskId: taskIdSchema }).strict(),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ taskId, ...permit }) => result(() => taskSummary(tasks.authorize(principal, taskId, { ...permit, action: 'approve_external_draft', environment: 'live' }))));
  server.registerTool('get_member_usage', {
    description: 'Read only the authenticated member’s recorded EIGOS Worker usage across tasks. Member limits are disabled. Unknown/unreported usage is separate; task safety budgets still apply.',
    inputSchema: z.object({}).strict(), annotations: read,
  }, () => result(() => tasks.usage(principal)));
  server.registerTool('list_tasks', {
    description: 'List tasks owned by the authenticated user within the authenticated organization.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(1_000_000).default(0) }).strict(),
    annotations: read,
  }, args => result(() => { const found = tasks.list(principal, args); return { ...found, jobs: found.jobs.map(taskSummary) }; }));
  server.registerTool('reply_to_task', {
    description: 'Answer the current owned task question using expectedRevision from get_task. A later explicit correction replaces the corresponding old value and retains unchanged facts. Technical pauses use resume_task, not a fabricated owner reply. A reply never grants business authorization. Reuse requestId only for identical retries.',
    inputSchema: versionedReplySchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(() => taskSummary(tasks.reply(principal, args))));
  server.registerTool('amend_task', {
    description: 'Apply an owner correction to the SAME open read-only task, including while it is working or waiting for source login. Read current expectedRevision first. Obsolete in-flight results cannot overwrite the correction. Fixed business effects cannot be amended here.',
    inputSchema: versionedReplySchema, annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(() => taskSummary(tasks.amend(principal, args))));
  server.registerTool('resume_task', {
    description: 'Resume the SAME technically paused read-only task after its runtime prerequisite has been restored. No owner answer or repeated business confirmation is needed. Preserve history and cumulative usage; this grants no new business authority. Do not repeatedly call while the failure is unchanged.',
    inputSchema: resumeTaskSchema, annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(() => taskSummary(tasks.resume(principal, args))));
  if (options.payment !== false) server.registerTool('select_payment_route', {
    description: 'Select a route for the original unpaid handoff. Version 2 uses current Link wallet availability; version 3 uses the PA own sandbox Vault or payment-account capability supported by the merchant checkout. Selection is durable and cannot be switched after issuance; no credentials or payment execution are accepted.',
    inputSchema: paPaymentRouteSchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(() => taskSummary(tasks.selectPaymentRoute(principal, args))));
  if (options.payment !== false) server.registerTool('report_payment_result', {
    description: 'Notify an owned task after the PA used its own payment capability. Exact handoff ID/digest required. Accepts no payment credentials; notifications trigger independent provider readback and never prove payment, order or booking completion.',
    inputSchema: paPaymentReportSchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(() => taskSummary(tasks.reportPayment(principal, args))));
  server.registerTool('cancel_task', {
    description: 'Cancel an owned open ontology task. Completed tasks cannot be canceled. This does not cancel or reverse provider orders.',
    inputSchema: z.object({ taskId: taskIdSchema }).strict(),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ taskId }) => result(() => taskSummary(tasks.cancel(principal, taskId))));
  if (tasks.services().some(s => s.id === 'eigos.delegate')) {
    server.registerTool('reconcile_task', { description: 'Query the original owned business operation after an unknown result; never place a replacement order.', inputSchema: z.object({ taskId: taskIdSchema, requestId: requestIdSchema }).strict(), annotations: { idempotentHint: true, destructiveHint: false } }, ({ taskId, requestId }) => result(() => taskSummary(tasks.reconcile(principal, taskId, requestId))));
    server.registerTool('revoke_task_authorization', { description: 'Revoke permits for future dispatch. In-flight facts still require reconciliation; this does not reverse an order or payment.', inputSchema: z.object({ taskId: taskIdSchema, requestId: requestIdSchema }).strict(), annotations: { idempotentHint: true, destructiveHint: false } }, ({ taskId, requestId }) => result(() => taskSummary(tasks.revokeAuthorization(principal, taskId, requestId))));
    if (tasks.services().some(s => s.id === 'eigos.aftersales')) server.registerTool('request_remediation', { description: 'Create a separate linked cancellation/refund task for a verified owned operation. A request or application is not proof of cancellation/refund success. Only explicitly configured sandbox effects are enabled.', inputSchema: remediationSchema, annotations: { idempotentHint: true, destructiveHint: false } }, args => result(() => taskSummary(tasks.requestRemediation(principal, args))));
  }
  return server;
}
