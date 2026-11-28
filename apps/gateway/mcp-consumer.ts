import express, { type Request } from 'express';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { InvalidInput, NotFound, PermissionDenied, requireScope, type Principal } from '../../packages/core/identity.js';
import type { Config } from '../../packages/core/config.js';
import { Access } from '../../packages/runtime/access.js';
import { discoverOntology, discoveryOptions, ontologyIndex } from '../../packages/runtime/agent-catalogue.js';
import type { Database, Sql } from '../../packages/runtime/database.js';
import type { InstalledRuntime } from '../../packages/runtime/installation.js';
import type { Metadata } from '../../packages/runtime/metadata.js';
import { Objects } from '../../packages/runtime/objects.js';
import { ontologyServices } from '../../packages/runtime/services.js';
import { submitSchema, type Task, type Tasks } from '../../packages/runtime/tasks.js';
import { publicError } from './public-error.js';

/**
 * Modeling and Ontology administration services exposed on `/mcp/builder` (spec section 6.8 & Appendix A).
 * Consumer and business Action execution tools live exclusively on `/mcp`.
 */
export const BUILDER_SERVICE_NAMES: ReadonlySet<string> = new Set([
  // Definitions & branches
  'workbench_access', 'raw_definition', 'function_versions', 'proposal_diff',
  'create_branch', 'get_branch', 'list_branches', 'update_branch',
  'prepare_branch', 'review_branch', 'merge_branch', 'rebase_branch', 'catch_up_branch',
  // Publishing & projects
  'publish_workflow', 'withdraw_workflow', 'publish_public_place', 'withdraw_public_place',
  'project', 'assign_project',
  // Packages & migrations
  'export_package', 'import_package', 'migrate_definitions', 'migrate_data', 'migration_receipt',
  // Semantic indexing
  'semantic_configure', 'semantic_index', 'semantic_status',
  // Source indexing & materialization
  'submit_index', 'index_status', 'retry_index', 'cancel_index',
  'materialize', 'read_materialization', 'materialized_links',
  // Entities, policies & views
  'bind_entity', 'entity_history', 'edit_policy', 'save_object_view',
  // Evaluation
  'trial_candidate_scenarios', 'evaluation_suites', 'evaluation_cases_from_set',
  'save_evaluation_suite', 'run_evaluation_suite', 'promote_evaluation_candidate',
  // Machinery modeling & reviews
  'machinery_processes', 'machinery_analysis', 'ingest_machinery_history',
  'save_machinery_cases', 'machinery_propose_model', 'save_machinery_review',
  'machinery_reviews', 'machinery_review', 'run_machinery_review',
  'machinery_next_actions', 'machinery_replan_changes', 'machinery_rule_bindings',
  'refresh_machinery_proposal_evidence', 'watch_machinery_process', 'cancel_machinery_watch',
]);

const discoverySchema = discoveryOptions.extend({ ontology: z.string().optional() });
const mcpDescription = 'Without arguments it returns a compact index of resource names by kind. Use query to find up to 16 resources by name or description, then names to read exact contracts.';
const dynamicInputSchema = z.record(z.string(), z.unknown()).default({});

function profileInstructionsFor(
  agentProfiles: readonly { instructions?: readonly { action?: string; function?: string; text: string }[] }[] | undefined,
  kind: 'action' | 'function',
  apiName: string,
): string {
  if (!agentProfiles?.length) return '';
  const notes: string[] = [];
  for (const profile of agentProfiles) {
    for (const hint of profile.instructions ?? []) {
      if ((kind === 'action' ? hint.action : hint.function) === apiName) {
        notes.push(hint.text);
      }
    }
  }
  return notes.join(' ');
}

function summarizeParameters(parameters: Record<string, unknown>, objectParameters?: Record<string, string>): string {
  const keys = [...Object.keys(parameters), ...Object.keys(objectParameters ?? {})];
  if (keys.length === 0) return '';
  const unique = [...new Set(keys)];
  return ` Parameters: ${unique.join(', ')}.`;
}

export interface ConsumerMcpContext {
  server: McpServer;
  db: Database;
  tasks: Tasks;
  metadata: Metadata;
  capabilities: InstalledRuntime;
  p: Principal;
  response: (operation: () => Promise<unknown>) => Promise<CallToolResult>;
  authorize: (client: Sql) => Promise<void>;
  publicTask: (task: Task) => unknown;
}

function needsDynamicTools(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  if (Array.isArray(body)) return body.some(needsDynamicTools);
  const message = body as { method?: unknown; params?: { name?: unknown } };
  if (message.method === 'tools/list') return true;
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    return typeof name === 'string' && (name.startsWith('action_') || name.startsWith('function_'));
  }
  return false;
}

/**
 * Registers consumer-grade Ontology MCP tools for Beta / member accounts:
 * - `cancel_task` for cancelling pending or awaiting-input tasks with active-account authorization
 * - Per-Action `action_<ApiName>` tools for every Action authorized by `Access.load(db, p)`
 * - Per-Function `function_<apiName>` tools for every read-only Function authorized by `Access.load(db, p)`
 *
 * Because `BusinessAdapter.registerTools` is invoked synchronously before `await server.connect(transport)`,
 * dynamic Ontology tool registration hooks into `server.connect` / `transport.handleRequest` so only
 * `tools/list` and `action_*` / `function_*` tool calls load live permissions and the active published
 * `Eigos` release — keeping `get_task` and other calls at zero extra DB overhead.
 */
export function registerConsumerMcpTools(ctx: ConsumerMcpContext): void {
  const { server, db, tasks, p, response, authorize, publicTask } = ctx;

  server.registerTool('cancel_task', {
    description: 'Cancel a pending, working, or awaiting-input task owned by this account.',
    inputSchema: z.strictObject({ taskId: z.uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ taskId }) => response(async () => {
    await db.transaction(client => authorize(client));
    return publicTask(await tasks.cancel(p, taskId));
  }));

  let dynamicRegistered = false;
  const ensureDynamic = async () => {
    if (dynamicRegistered) return;
    dynamicRegistered = true;
    await registerAuthorizedOntologyTools(ctx);
  };

  const originalConnect = server.connect.bind(server);
  server.connect = async (transport) => {
    const candidate = transport as unknown as {
      handleRequest?: (req: unknown, res: unknown, parsedBody?: unknown) => Promise<void>;
    };
    if (typeof candidate.handleRequest === 'function') {
      const originalHandle = candidate.handleRequest.bind(transport);
      candidate.handleRequest = async (req, res, parsedBody) => {
        if (needsDynamicTools(parsedBody)) {
          await ensureDynamic();
        }
        return originalHandle(req, res, parsedBody);
      };
    } else {
      await ensureDynamic();
    }
    return originalConnect(transport);
  };
}

async function registerAuthorizedOntologyTools(ctx: ConsumerMcpContext): Promise<void> {
  const { server, db, tasks, metadata, capabilities, p, response, authorize, publicTask } = ctx;
  const [access, model] = await Promise.all([Access.load(db, p), metadata.active('Eigos')]);
  const document = access.describe(model, true);

  for (const action of document.actionTypes) {
    const toolName = `action_${action.apiName}`;
    const guidance = profileInstructionsFor(document.agentProfiles, 'action', action.apiName);
    const paramHint = summarizeParameters(action.parameters, action.objectParameters);
    const description = [action.description, guidance].filter(Boolean).join(' ') + paramHint;
    const hasExternalEffect = Boolean(action.effects?.length);

    server.registerTool(toolName, {
      description,
      inputSchema: z.strictObject({
        requestId: submitSchema.shape.requestId,
        input: dynamicInputSchema,
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: hasExternalEffect,
        openWorldHint: hasExternalEffect,
      },
    }, ({ requestId, input }) => response(async () => publicTask(
      await tasks.submit(
        p,
        { requestId, message: `Execute ${action.apiName}` },
        { actionInvocation: { action: { action: action.apiName, input } }, authorize },
      ),
    )));
  }

  for (const fn of document.functionTypes) {
    if (fn.edits) continue;
    const toolName = `function_${fn.apiName}`;
    const guidance = profileInstructionsFor(document.agentProfiles, 'function', fn.apiName);
    const paramHint = summarizeParameters(fn.parameters);
    const description = [fn.description, guidance].filter(Boolean).join(' ') + paramHint;

    server.registerTool(toolName, {
      description,
      inputSchema: z.strictObject({
        input: dynamicInputSchema,
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: Boolean(fn.source),
      },
    }, ({ input }) => response(async () => {
      requireScope(p, 'tasks:read');
      await db.transaction(client => authorize(client));
      const [liveAccess, liveModel] = await Promise.all([Access.load(db, p), metadata.active('Eigos')]);
      liveAccess.function(liveModel, fn.apiName);
      if (liveModel.functions.get(fn.apiName)?.edits) {
        throw new PermissionDenied('Editing Functions must be called through a published Action');
      }
      const result = await capabilities.functions.invoke(liveModel, fn.apiName, input, {
        principal: p,
        objects: new Objects(db, liveModel, liveAccess),
        signal: AbortSignal.timeout(30000),
      });
      if (!await liveAccess.canReturn(liveAccess.dataRequirements())) {
        throw new PermissionDenied('Result permissions changed');
      }
      return result;
    }));
  }
}

/**
 * Mounts `/mcp/builder` for first-party operator modeling & Ontology administration.
 * Rejects Beta / member tokens (`memberAccess` or `memberAudience`) with 403 and
 * exposes only builder/modeling `ontology_*` services plus read-only `describe_ontology`.
 */
export function mountBuilderMcp(
  app: express.Express,
  config: Config,
  db: Database,
  metadata: Metadata,
  capabilities: InstalledRuntime,
  principal: (request: Request) => Principal,
): void {
  const services = ontologyServices(db, metadata, capabilities, capabilities.functions, capabilities.effects, capabilities.actions, 'Eigos');

  app.get('/mcp/builder', (_req, res) => res.set('Allow', 'POST').sendStatus(405));
  app.post('/mcp/builder', async (req, res) => {
    const p = principal(req);
    if (p.memberAccess || p.memberAudience) {
      res.status(403).json({
        error: 'Builder MCP requires a first-party operator token',
        reason: 'client_not_allowed',
      });
      return;
    }

    const readScope = p.scopes.includes('ontology:read');
    const matchesOperator = (binding: string | undefined) =>
      Boolean(p.clientId && p.scopes.includes('tasks:read') && binding === `${p.clientId}:${p.owner}`);

    const server = new McpServer(
      { name: 'eigos-builder', version: '0.2.0' },
      { instructions: 'EIGOS Builder MCP for first-party operators: Ontology definitions, branches, releases, indexing, evaluation, and Machinery. Business Actions are executed on /mcp.' },
    );

    const response = async (operation: () => Promise<unknown>): Promise<CallToolResult> => {
      try {
        const result = await operation();
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const { status, message, requestId } = publicError(error);
        return {
          isError: true,
          content: [{ type: 'text', text: requestId ? `${message} (request ID: ${requestId})` : message }],
          structuredContent: { status, error: message, ...(requestId ? { requestId } : {}) },
        };
      }
    };

    server.registerTool('describe_ontology', {
      description: 'Inspect published Ontology definitions. ' + mcpDescription,
      inputSchema: discoverySchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, ({ ontology, query, names }) => response(async () => {
      if (!readScope) {
        const operatorCatalog = (ontology ?? 'Eigos') === 'Eigos' && matchesOperator(config.EIGOS_MCP_OPERATOR_CATALOG);
        if (!operatorCatalog) requireScope(p, 'ontology:read');
      }
      if (query && names) throw new InvalidInput('Provide either query or names');
      const [access, model] = await Promise.all([Access.load(db, p), metadata.active(ontology)]);
      if (!readScope) access.require('Eigos', 'view_definition', 'Eigos');
      const document = access.describe(model, false);
      return query || names ? discoverOntology(model, document, { query, names }) : ontologyIndex(model, document);
    }));

    for (const [name, service] of services) {
      if (!BUILDER_SERVICE_NAMES.has(name)) continue;
      server.registerTool('ontology_' + name, {
        description: service.description,
        inputSchema: (service.schema as z.ZodObject<z.ZodRawShape>).safeExtend({ _ontology: z.string().optional() }),
      }, input => response(() => {
        const { _ontology, ...args } = input as { _ontology?: unknown; [key: string]: unknown };
        const selected = _ontology
          ? ontologyServices(db, metadata, capabilities, capabilities.functions, capabilities.effects, capabilities.actions, z.string().parse(_ontology))
          : services;
        const operation = selected.get(name);
        if (!operation) throw new NotFound('Ontology service is unavailable');
        if (!readScope && operation.invokeForMcpOperator && matchesOperator(config.EIGOS_MCP_OPERATOR_MACHINERY)) {
          return operation.invokeForMcpOperator(p, args);
        }
        return operation.invoke(p, args);
      }));
    }

    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    res.on('close', () => { void server.close(); });
    await transport.handleRequest(req, res, req.body);
  });
}
