import type { NetworkService } from '../../packages/network/service.js';
import type { MemberSourceService } from '../../packages/members/source-service.js';
import { sourceBeginSchema, sourceRevokeSchema } from '../../packages/core/member-source.js';
import { mountNetworkMcp } from './network/mcp.js';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { prepareObservationSchema } from '../../packages/ontology/observation-contract.js';
import { DomainError, versionedReplySchema, resumeTaskSchema, requireScope, submitSchema, ontologySubmitSchema, taskIdSchema, remediationSchema, requestIdSchema, type Principal } from '../../packages/core/domain.js';
import type { GatewayTaskService } from './task-service.js';
import { publicTask as taskSummary } from './task-view.js';
import {secureDescribeSchema,secureQuerySchema,secureEvaluateSchema,checkAccessSchema} from '../../packages/security/view.js';
import { SecurityError } from '../../packages/security/store.js';
import { securityErrorResponse } from '../../packages/security/error-guidance.js';
import { objectQuerySchema } from '../../packages/ontology/object-store.js';
import { functionCallSchema } from '../../packages/ontology/object-functions.js';
import { paPaymentReportSchema, paPaymentRouteSchema } from '../../packages/core/pa-payment.js';
import type { DefinitionService } from '../../packages/ontology/definition-service.js';
import { PA_DISCOVERY_GUIDANCE } from '../../packages/core/services.js';
import { ontologyIdSchema, ontologyReleaseRefSchema } from '../../packages/ontology/definition-contracts.js';
import { mountDefinitionMcp } from './ontology/mcp.js';
import { externalDraftPermitSchema } from '../../packages/ontology/external-draft.js';
import { mountMessagingMcp } from './messaging/mcp.js';
import type { AgentMessagingService } from '../../packages/agent-messaging/service.js';
import type { MessagingIdentity } from '../../packages/agent-messaging/contracts.js';

async function toolResult(action: () => unknown, instance?: string): Promise<CallToolResult> {
  try {
    const value = await action();
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { result: value } };
  } catch (error) {
    if(error instanceof z.ZodError) return {isError:true,content:[{type:'text',text:JSON.stringify({code:'INVALID_INPUT',message:'Input does not match the authorized tool contract'})}]};
    if (error instanceof DomainError) {
      const payload = error instanceof SecurityError ? securityErrorResponse(error, instance) : { code: error.code, message: error.message };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: { error: payload } };
    }
    throw error;
  }
}

export function createMcpServer(tasks: GatewayTaskService, principal: Principal, network?: { service: NetworkService; token: string }, sources?: { service: MemberSourceService; token: string }, definitions?: DefinitionService, options: { payment?: boolean; externalDrafts?: boolean; messaging?: { service: AgentMessagingService; identity: MessagingIdentity }; messagingOnly?: boolean; runtime?: { instance: string; backend: string; releaseDigest?: string; ontologyTransport: 'native-mcp' } } = {}): McpServer {
  const result = (action: () => unknown) => toolResult(action, options.runtime?.instance);
  const communication = 'Use the Personal Agent communication tools for messages to other people’s PAs. Only an explicit service delegation uses submit_task/eigos.delegate. Message delivery does not authorize a business action.';
  const server = new McpServer({ name: 'eigos', version: '0.1.0' }, { instructions: options.messagingOnly ? communication : PA_DISCOVERY_GUIDANCE + (options.messaging ? '\n' + communication : '') });
  if (options.messaging) mountMessagingMcp(server, options.messaging.service, options.messaging.identity);
  if (options.messagingOnly) return server;
  if (definitions) mountDefinitionMcp(server, definitions, principal);
  if (!tasks.secured && network) mountNetworkMcp(server, network.service, principal, network.token);
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  if (options.runtime) server.registerTool('get_runtime_info', {
    description: 'Identify this EIGOS deployment and its MCP/A2A endpoints. This describes the installed runtime, not Worker availability or business completion.',
    inputSchema: z.object({}).strict(), annotations: read,
  }, () => result(() => { requireScope(principal, 'services:read'); return { ...options.runtime, mcp: `${options.runtime!.instance}/mcp`, a2a: `${options.runtime!.instance}/a2a` }; }));
  const ontologyContext = { ontologyId: ontologyIdSchema.optional(), taskId: taskIdSchema.optional(), release: ontologyReleaseRefSchema.optional() };
  if (!tasks.secured && sources) {
    server.registerTool('list_source_connections', { description: 'Discover available account-backed services and the current user\'s own connection status. Visibility does not lend another member\'s credential.', inputSchema: z.object({}).strict(), annotations: read }, () => result(() => sources.service.list(principal, sources.token)));
    server.registerTool('get_source_connection', { description: 'Read this user\'s Meituan connection state, expiry and next action. Accepted credential is not provider verification.', inputSchema: z.object({}).strict(), annotations: read }, () => result(() => sources.service.status(principal, sources.token)));
    server.registerTool('begin_source_connection', { description: 'Begin or rotate the user\'s own read-only Meituan connection. The PA must obtain the credential locally and upload through the returned private HTTP path. Never send a token through MCP or task text.', inputSchema: sourceBeginSchema, annotations: { idempotentHint: true, destructiveHint: false } }, args => result(() => sources.service.begin(principal, sources.token, args)));
    server.registerTool('revoke_source_connection', { description: 'Revoke this user\'s source connection and all pending upload requests immediately. Does not revoke the provider account itself.', inputSchema: sourceRevokeSchema, annotations: { idempotentHint: true, destructiveHint: true } }, args => result(() => sources.service.revoke(principal, sources.token, args)));
    server.registerTool('resume_source_task', { description: 'Resume the SAME owned task after its source connection is ready. Re-reads addresses and price; no order or payment authorization.', inputSchema: z.object({ taskId: taskIdSchema, requestId: z.uuid(), expectedRevision: z.number().int().positive() }).strict(), annotations: { idempotentHint: true, destructiveHint: false } }, args => result(() => taskSummary(sources.service.resume(principal, sources.token, args))));
  }
  server.registerTool('describe_ontology', {
    description: 'Read bounded business object/interface definitions, properties, source semantics and bidirectional links. Definitions do not grant access or prove live supply.',
    inputSchema: tasks.secured ? secureDescribeSchema : z.object({ ...ontologyContext, search: z.string().max(100).optional(), limit: z.number().int().min(1).max(5).optional(), after: z.string().optional(), kind: z.enum(['types', 'actions', 'functions']).optional().describe('Discover types with related contracts by default; use actions or functions to page through their complete catalogues') }).strict(), annotations: read,
  }, (args: unknown) => result(() => tasks.describeOntology(principal, args)));
  server.registerTool('query_ontology', {
    description: 'Read only owned business objects or one named relationship. Filters and projections use registered fields; private fields are forbidden. Inspect hasMore/cursor, source kind and evidence level.',
    inputSchema: tasks.secured ? secureQuerySchema : z.union(objectQuerySchema.options.map(schema => schema.safeExtend(ontologyContext))), annotations: read,
  }, (args: unknown) => result(() => tasks.queryOntology(principal, args, network?.service.ontologyReader(principal, network.token))));
  server.registerTool('evaluate_ontology', {
    description: 'Run a registered, bounded, read-only business calculation. Missing or incompatible evidence stays unknown; synthetic evidence is never live fulfillment.',
    inputSchema: tasks.secured ? secureEvaluateSchema : z.union(functionCallSchema.options.map(schema => schema.safeExtend(ontologyContext))), annotations: read,
  }, (args: unknown) => result(() => tasks.evaluateOntology(principal, args, network?.service.ontologyReader(principal, network.token))));
  if (tasks.secured) server.registerTool('check_access',{description:'Check current access to your granted task and selected fields; this grants no authority.',inputSchema:checkAccessSchema,annotations:read},args=>result(()=>tasks.checkAccess(principal,args)));
  server.registerTool('list_services', {
    description: 'Discover current EIGOS service entry points before delegating a practical service request, such as ride estimates, accommodation, travel or appointments. eigos.delegate is an entry point; inspect permitted describe_ontology contracts for business scope. Definitions do not prove a live source or execution permission.',
    inputSchema: z.object({}), annotations: read,
  }, () => result(() => { requireScope(principal, 'services:read'); return tasks.services(); }));
  server.registerTool('submit_task', {
    description: 'Submit the original goal to a discovered service. Include personalContext only when the goal needs authorized stored personal facts or preferences; self requests personal data, not caller identity. Public named-place queries normally omit personalContext and unverified street addresses. For an already bound self whose facts are needed, select only the needed defaults and known references; do not bind again or repeat known facts. Explicit overrides and clears take precedence. Before location-dependent delegation, obtain the actual needed endpoints and city through the PA authorized tools, then supply locationContext. It becomes Ontology RequestFact inputs before planning. Keep ordinary constraints in goal text; structured condition predicates must be discovered registered IDs, never user prose. eigos.delegate uses Ontology + LLM, source actions and independent acceptance. Reuse requestId for identical retries; never replace a pending task. On denial follow the returned authorization guidance, without inferring task-creation permission or requesting unrelated personal access.',
    inputSchema: submitSchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args: unknown) => result(async () => taskSummary(await tasks.submit(principal, args))));
  server.registerTool('get_task', {
    description: 'Read an owned task business summary with current revision, pending question, authorization/recovery status and intact artifacts. While submitted/working, use waitMs up to 30000 to await a terminal state or needed action without rapid repeated calls. Timeout returns the unchanged original task and never cancels execution. Internal model and ontology histories stay in EIGOS. Technical recovering/paused states do not request business input: preserve this task and confirmed facts; never create a replacement. Only input-required asks for missing owner facts. Works across MCP/A2A.',
    inputSchema: z.object({ taskId: taskIdSchema, waitMs: z.number().int().min(0).max(30000).optional() }).strict(), annotations: read,
  }, ({ taskId, waitMs }) => result(async () => taskSummary(await tasks.getAfterWait(principal, taskId, waitMs))));
  if (tasks.secured) server.registerTool('prepare_observation_contract', {
    description: 'Record an explicitly delegated, bounded observation contract for a completed owned task, creating a separate paused guardian. Requires current task/source/field permissions, exact published mapping and read input, horizon and lifetime budgets. This stage does not start monitoring or authorize source calls, calendar edits, orders or payments. Target account/native identity remains unverified until a trusted observer binds it. Read lifecycle with get_task; cancel_task revokes the contract. Never infer this delegation from task completion.',
    inputSchema: prepareObservationSchema, annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(async () => taskSummary(await tasks.prepareObservationContract(principal, args))));
  if (!tasks.secured && options.externalDrafts) server.registerTool('authorize_checkout_draft', {
    description: 'Authorize exactly one live unpaid checkout draft for the merchant, items and source preview returned by this owned task. Copy its planDigest and draft unchanged; expiresAt may copy draft.sourceExpiresAt and must not exceed it. This grants no order, payment, customer-data submission or later edit. Reuse requestId for identical retries.',
    inputSchema: externalDraftPermitSchema.omit({ action: true, environment: true }).extend({ taskId: taskIdSchema }).strict(),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ taskId, ...permit }) => result(async () => taskSummary(await tasks.authorize(principal, taskId, { ...permit, action: 'approve_external_draft', environment: 'live' }))));
  if (!tasks.secured) server.registerTool('get_member_usage', {
    description: 'Read only the authenticated member’s recorded EIGOS Worker usage across tasks. Member limits are disabled. Unknown/unreported usage is separate; task safety budgets still apply.',
    inputSchema: z.object({}).strict(), annotations: read,
  }, () => result(() => tasks.usage(principal)));
  server.registerTool('list_tasks', {
    description: 'List tasks owned by the authenticated user within the authenticated organization.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(1_000_000).default(0) }).strict(),
    annotations: read,
  }, args => result(async () => { const found = await tasks.list(principal, args); return { ...found, jobs: found.jobs.map(taskSummary) }; }));
  server.registerTool('reply_to_task', {
    description: 'Answer the current owned task question using expectedRevision from get_task. A later explicit correction replaces the corresponding old value and retains unchanged facts. Technical pauses use resume_task, not a fabricated owner reply. A reply never grants business authorization. Reuse requestId only for identical retries.',
    inputSchema: versionedReplySchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(async () => taskSummary(await tasks.reply(principal, args))));
  server.registerTool('amend_task', {
    description: 'Apply an owner correction to the SAME open read-only task, including while it is working or waiting for source login. In Foundation mode this accepts only an explicit personalContext or locationContext refresh within existing installation permissions. Read current expectedRevision first. Obsolete in-flight results cannot overwrite the correction. Fixed business effects cannot be amended here.',
    inputSchema: versionedReplySchema, annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(async () => taskSummary(await tasks.amend(principal, args))));
  server.registerTool('resume_task', {
    description: 'Resume the SAME technically paused read-only task after its runtime prerequisite has been restored. In Foundation mode only the original PA with current task-processing permission and execution authority can resume, using the current expectedRevision without increasing its budget or expiry. No owner answer or repeated business confirmation is needed. Preserve history and cumulative usage; this grants no new business authority. Do not repeatedly call while the failure is unchanged. An inactive observation contract cannot be activated with this tool.',
    inputSchema: resumeTaskSchema, annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(async () => taskSummary(await tasks.resume(principal, args))));
  if (options.payment !== false) server.registerTool('select_payment_route', {
    description: 'Select a route for the original unpaid handoff. Version 2 uses current Link wallet availability; version 3 uses the PA own sandbox Vault or payment-account capability supported by the merchant checkout. Selection is durable and cannot be switched after issuance; no credentials or payment execution are accepted.',
    inputSchema: paPaymentRouteSchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(async () => taskSummary(await tasks.selectPaymentRoute(principal, args))));
  if (options.payment !== false) server.registerTool('report_payment_result', {
    description: 'Notify an owned task after the PA used its own payment capability. Exact handoff ID/digest required. Accepts no payment credentials; notifications trigger independent provider readback and never prove payment, order or booking completion.',
    inputSchema: paPaymentReportSchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(async () => taskSummary(await tasks.reportPayment(principal, args))));
  server.registerTool('cancel_task', {
    description: 'Cancel an owned open ontology task. Completed tasks cannot be canceled. This does not cancel or reverse provider orders.',
    inputSchema: z.object({ taskId: taskIdSchema }).strict(),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ taskId }) => result(async () => taskSummary(await tasks.cancel(principal, taskId))));
  if (tasks.services().some(s => s.id === 'eigos.delegate')) {
    server.registerTool('reconcile_task', { description: 'Query the original owned business operation after an unknown result; never place a replacement order.', inputSchema: z.object({ taskId: taskIdSchema, requestId: requestIdSchema }).strict(), annotations: { idempotentHint: true, destructiveHint: false } }, ({ taskId, requestId }) => result(async () => taskSummary(await tasks.reconcile(principal, taskId, requestId))));
    server.registerTool('revoke_task_authorization', { description: 'Revoke permits for future dispatch. In-flight facts still require reconciliation; this does not reverse an order or payment.', inputSchema: z.object({ taskId: taskIdSchema, requestId: requestIdSchema }).strict(), annotations: { idempotentHint: true, destructiveHint: false } }, ({ taskId, requestId }) => result(async () => taskSummary(await tasks.revokeAuthorization(principal, taskId, requestId))));
    if (tasks.services().some(s => s.id === 'eigos.aftersales')) server.registerTool('request_remediation', { description: 'Create a separate linked cancellation/refund task for a verified owned operation. A request or application is not proof of cancellation/refund success. Only explicitly configured sandbox effects are enabled.', inputSchema: remediationSchema, annotations: { idempotentHint: true, destructiveHint: false } }, args => result(async () => taskSummary(await tasks.requestRemediation(principal, args))));
  }
  return server;
}
