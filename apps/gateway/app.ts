import { NetworkService } from '../../packages/network/service.js';
import { MemberSourceService } from '../../packages/members/source-service.js';
import { mountSourceRoutes } from './sources.js';
import { assertSourceProxy } from '../../packages/core/private-source-proxy.js';
import { mountNetworkRoutes } from './network/routes.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { paPaymentRequestSchema, paPaymentReportSchema, paPaymentRouteSchema, paPaymentSelectionSchema } from '../../packages/core/pa-payment.js';
import type { ExecutionCatalog } from '../../packages/core/catalog.js';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { AgentCard } from '@a2a-js/sdk';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { z } from 'zod';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertPersonalSourceConfig, type Config } from '../../packages/core/config.js';
import { PersonalSourceAccess, sourceOwner } from '../../packages/core/personal-source.js';
import { createVerifier, protectedResourceMetadata, type VerifyToken } from './auth.js';
import { A2AGateway, AgentUser, agentCard } from './a2a.js';
import { DomainError, ownerKey, SCOPES, type Principal, type Scope } from '../../packages/core/domain.js';
import { createMcpServer } from './mcp.js';
import { JobStore } from '../../packages/core/store.js';
import { TaskService } from '../../packages/core/tasks.js';
import { taskSummary } from '../../packages/core/task-summary.js';
import { MemberAccessError, MemberStore } from '../../packages/members/store.js';
import { mountMemberRoutes } from './members/routes.js';
import type { LoginProvider } from './members/oidc.js';
import { mountAgentRoutes } from './members/agent-routes.js';
import { AgentAccessError } from '../../packages/members/agents.js';
import { BACKEND_VERSION } from '../../packages/ontology/execution.js';
import { DefinitionService } from '../../packages/ontology/definition-service.js';
import { mountDefinitionRoutes } from './ontology/routes.js';

const principalSchema = z.object({ issuer: z.string(), subject: z.string(), tenant: z.string(), clientId: z.string(), scopes: z.array(z.string()) });

export function createApp(config: Config, verify: VerifyToken = createVerifier(config), catalogFactory?: (store: JobStore) => ExecutionCatalog, loginProvider?: LoginProvider) {
  assertPersonalSourceConfig(config);
  assertSourceProxy(config);
  if (config.EIGOS_CSV_PILOT === 'true' && (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(config.HOST) || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.PUBLIC_URL).hostname))) throw new Error('CSV simulation requires non-production loopback');
  if (config.EIGOS_NETWORK_ENABLED === 'true' && (config.EIGOS_AUTH_MODE !== 'jwt' || !config.OIDC_AGENT_CLIENT_ID || !config.OIDC_CLIENT_ID || !config.EIGOS_NETWORK_MEMBER_IDS.length)) throw new Error('Network requires explicit JWT and enrolled-member configuration');
  const hostname = new URL(config.PUBLIC_URL).hostname;
  const allowedOrigins = new Set([config.PUBLIC_URL, ...config.ALLOWED_ORIGINS.split(',').filter(Boolean)]);
  const app = createMcpExpressApp({
    host: config.HOST,
    allowedHosts: [hostname],
    allowedOrigins: [...allowedOrigins].map(origin => new URL(origin).hostname),
    jsonLimit: '64kb',
  });
  app.disable('x-powered-by');
  const principals = new WeakMap<Request, Principal>();
  const store = new JobStore(config.DATABASE_PATH);
  const members = new MemberStore(config.MEMBERSHIP_DATABASE_PATH ?? (config.DATABASE_PATH === ':memory:' ? ':memory:' : `${config.DATABASE_PATH}.members`));
  let catalog: ExecutionCatalog, tasks: TaskService, network: NetworkService | undefined;
  try {
    catalog = catalogFactory?.(store) ?? createExecutionCatalog({ store, csvInputDirectory: config.EIGOS_CSV_PILOT === 'true' ? config.EIGOS_CSV_INPUT_DIR : undefined,
      documentEnabled: config.EIGOS_EXECUTOR === 'codex', paotuiSkillDirectory: config.EIGOS_PAOTUI_SKILL_DIR,
      paotuiMemberConnectionFile: config.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE, memberSourceKeyFile: config.EIGOS_MEMBER_SOURCE_KEY_FILE, executionHost: 'gateway',
      publicGeoDiscoveryQueries: config.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES,
      shopifyCatalog: config.EIGOS_SHOPIFY_CATALOG_MERCHANTS?.length ? { merchants: config.EIGOS_SHOPIFY_CATALOG_MERCHANTS } : undefined,
      bookingSandbox: config.EIGOS_BOOKING_SANDBOX_URL ? { endpoint: config.EIGOS_BOOKING_SANDBOX_URL, tokenFile: config.EIGOS_BOOKING_SANDBOX_TOKEN_FILE! } : undefined,
      commerceSandbox: config.EIGOS_COMMERCE_SANDBOX_URL ? { endpoint: config.EIGOS_COMMERCE_SANDBOX_URL, tokenFile: config.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE! } : undefined,
      sandbox: config.EIGOS_SANDBOX_PROVIDER_URL ? { endpoint: config.EIGOS_SANDBOX_PROVIDER_URL, tokenFile: config.EIGOS_SANDBOX_TOKEN_FILE! } : undefined });
    tasks = new TaskService(store, { catalog, allowSandboxActions: config.EIGOS_ACTION_SANDBOX === 'true' });
    if (config.EIGOS_NETWORK_ENABLED === 'true') network = new NetworkService(store.createNetworkStore(), members, { memberIds: config.EIGOS_NETWORK_MEMBER_IDS, operatorIds: config.EIGOS_NETWORK_OPERATOR_MEMBER_IDS, collaborationLimits: { maxResponders: config.EIGOS_NETWORK_MAX_RESPONDERS, maxClarificationRounds: config.EIGOS_NETWORK_MAX_CLARIFICATION_ROUNDS }, catalog, jobs: store, tasks });
    if (config.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE) {
      const access = new PersonalSourceAccess(config.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE, (c, hash) => store.personalSourceAdmitted(c, hash), config.EIGOS_PAOTUI_SKILL_DIR!);
      const member = members.get(access.record.memberId);
      if (!config.EIGOS_NETWORK_MEMBER_IDS.includes(member.id) || member.status !== 'active' || member.issuer !== config.OAUTH_ISSUER
        || ownerKey({ ...member, clientId: '', scopes: [] }) !== sourceOwner(access.record)) throw new Error('Personal source must identify its exact active enrolled member');
      store.admitPersonalSource(access.record, access.configurationDigest);
    } else store.admitPersonalSource();
  } catch (error) { network?.close(); store.close(); members.close(); throw error; }
  if (config.EIGOS_AUDIT_PATH) mkdirSync(dirname(config.EIGOS_AUDIT_PATH), { recursive: true, mode: 0o700 });
  app.use((req, res, next) => {
    if (config.EIGOS_AUDIT_PATH && (['/mcp', '/a2a', '/.well-known/agent-card.json', '/agents/registrations'].includes(req.path) || /^\/tasks\/[^/]+\/authorize$/.test(req.path) || /^\/agents\/registrations\/[0-9a-f-]{36}(?:\/[a-z]+)?$/i.test(req.path))) {
      const entry = {
        at: new Date().toISOString(), path: req.path, method: req.body?.method ?? req.body?.action ?? req.method,
        requestId: req.body?.id, messageId: req.body?.params?.message?.messageId,
        taskId: req.body?.params?.id ?? req.body?.params?.message?.taskId,
        ...(req.path.startsWith('/agents/registrations') ? { registrationId: req.body?.registrationId ?? req.path.split('/')[3] } : {}),
      };
      res.on('finish', () => {
        // Never persist headers, tokens, prompts, or arbitrary peer metadata here.
        try { appendFileSync(config.EIGOS_AUDIT_PATH!, JSON.stringify({ ...entry, httpStatus: res.statusCode }) + '\n', { mode: 0o600 }); }
        catch { console.error('EIGOS audit write failed'); }
      });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin) {
      if (!allowedOrigins.has(origin)) { res.status(403).json({ error: 'origin_not_allowed' }); return; }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, A2A-Version, X-EIGOS-Registration-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version, A2A-Version');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0', backend: BACKEND_VERSION, releaseDigest: config.EIGOS_RELEASE_DIGEST }));
  app.get('/.well-known/eigos-pa-payment', (_req, res) => res.json({ version: '2', environment: 'sandbox', paymentAuthority: 'pa_owned', credentialsAccepted: false, routePolicy: 'prefer_link_agent_wallet', routes: ['link_agent_wallet', 'link_checkout'], checkoutRequiresUserConfirmation: true, switchAfterSelection: false, requestPath: 'metadata.delegation.agent.paPayment.request', selectionPath: 'metadata.delegation.agent.paPayment.selection', a2a: { method: 'SendMessage', actions: ['select_payment_route', 'report_payment_result'] }, mcpTools: ['select_payment_route', 'report_payment_result'], notificationIsPaymentProof: false, completionRequires: ['independent_provider_payment', 'independent_provider_booking'], requestSchema: z.toJSONSchema(paPaymentRequestSchema), routeSchema: z.toJSONSchema(paPaymentRouteSchema), selectionSchema: z.toJSONSchema(paPaymentSelectionSchema), reportSchema: z.toJSONSchema(paPaymentReportSchema) }));
  mountMemberRoutes(app, config, members, loginProvider);
  mountAgentRoutes(app, config, members, verify);
  const metadataUrl = `${config.PUBLIC_URL}/.well-known/oauth-protected-resource`;
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource/a2a'], (_req, res) => {
    if (config.EIGOS_AUTH_MODE !== 'jwt') { res.status(404).json({ error: 'oauth_not_configured', mode: 'local-development' }); return; }
    res.json(protectedResourceMetadata(config));
  });

  const authenticate: RequestHandler = async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    try {
      if (!match?.[1]) throw new Error('Missing token');
      const principal = await verify(match[1]);
      if (config.EIGOS_AUTH_MODE === 'jwt') {
        if (principal.clientId === config.OIDC_AGENT_CLIENT_ID) {
          try { members.agents.authorize(principal, match[1]); }
          catch (error) {
            if (error instanceof AgentAccessError || error instanceof DomainError) res.status(403).json({ error: error instanceof AgentAccessError ? error.code : 'agent_registration_required', onboarding_url: `${config.PUBLIC_URL}/.well-known/eigos-agent-registration` });
            else next(error);
            return;
          }
        }
        try { members.authorize(principal); }
        catch (error) {
          if (error instanceof MemberAccessError) res.status(403).json({ error: error.code, membership_url: `${config.PUBLIC_URL}/members`, ...(config.OIDC_AGENT_CLIENT_ID ? { onboarding_url: `${config.PUBLIC_URL}/.well-known/eigos-agent-registration` } : {}) });
          else next(error);
          return;
        }
      }
      principals.set(req, principal);
      Object.assign(req, { auth: { token: match[1], clientId: principal.clientId, scopes: principal.scopes, extra: { principal } } });
      next();
    } catch {
      const discovery = config.EIGOS_AUTH_MODE === 'jwt' ? `, resource_metadata="${metadataUrl}"` : '';
      res.setHeader('WWW-Authenticate', `Bearer realm="eigos", error="invalid_token"${discovery}`);
      res.status(401).json({ error: 'invalid_token', ...(config.OIDC_AGENT_CLIENT_ID ? { onboarding_url: `${config.PUBLIC_URL}/.well-known/eigos-agent-registration` } : {}) });
    }
  };

  mountNetworkRoutes(app, config, members, network, authenticate, req => principals.get(req)!);
  const sources = config.EIGOS_MEMBER_SOURCE_KEY_FILE ? new MemberSourceService(store.memberSources(config.EIGOS_MEMBER_SOURCE_KEY_FILE, config.EIGOS_PAOTUI_SKILL_DIR!), members, tasks, config) : undefined;
  mountSourceRoutes(app, sources, authenticate, req => principals.get(req)!);
  const definitions = new DefinitionService(store, tasks, catalog);
  mountDefinitionRoutes(app, definitions, authenticate, req => principals.get(req)!);

  // Same authentication, membership, scopes and owner as MCP/A2A; no object-write endpoint.
  for (const operation of ['describe', 'query', 'evaluate'] as const) app.post(`/ontology/${operation}`, authenticate, (req, res, next) => {
    try {
      const p = principals.get(req)!;
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
      const reader = operation === 'describe' ? undefined : network?.ontologyReader(p, token);
      res.json(operation === 'describe' ? tasks.describeOntology(p, req.body) : operation === 'query' ? tasks.queryOntology(p, req.body, reader) : tasks.evaluateOntology(p, req.body, reader));
    } catch (error) {
      if (error instanceof DomainError) { res.status(error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : 409).json({ error: error.code, message: error.message }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_ontology_input' }); return; }
      next(error);
    }
  });

  // Application authorization channel, separate from A2A messages. No raw credentials in task parts.
  app.post('/tasks/:taskId/authorize', authenticate, (req, res, next) => {
    try { res.json({ task: taskSummary(tasks.authorize(principals.get(req)!, String(req.params.taskId), req.body)) }); }
    catch (error) {
      if (error instanceof DomainError) { res.status(error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : 409).json({ error: error.code, message: error.message }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_authorization' }); return; }
      next(error);
    }
  });
  for (const action of ['reconcile', 'revoke-authorization', 'aftersales'] as const) app.post(`/tasks/:taskId/${action}`, authenticate, (req, res, next) => {
    try {
      const p = principals.get(req)!; const id = String(req.params.taskId);
      const task = action === 'aftersales' ? tasks.requestRemediation(p, { ...req.body, originalTaskId: id })
        : action === 'reconcile' ? tasks.reconcile(p, id, z.object({ requestId: z.string().min(1).max(128) }).strict().parse(req.body).requestId)
        : tasks.revokeAuthorization(p, id, z.object({ requestId: z.string().min(1).max(128) }).strict().parse(req.body).requestId);
      res.json({ task: taskSummary(task) });
    } catch (error) {
      if (error instanceof DomainError) { res.status(error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : 409).json({ error: error.code, message: error.message }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_business_action' }); return; } next(error);
    }
  });

  const mcp = createMcpHandler(ctx => createMcpServer(tasks, principalSchema.parse(ctx.authInfo?.extra?.principal), network ? { service: network, token: ctx.authInfo?.token ?? '' } : undefined, sources ? { service: sources, token: ctx.authInfo?.token ?? '' } : undefined, definitions), {
    legacy: 'stateless', maxSubscriptions: 0,
  });
  const handleMcp = toNodeHandler(mcp);
  app.all('/mcp', authenticate, async (req, res) => { await handleMcp(req, res, req.body); });

  const a2a = new A2AGateway(tasks, agentCard(config, tasks.services()));
  app.get('/.well-known/agent-card.json', async (_req, res) => { res.json(AgentCard.toJSON(await a2a.getAgentCard())); });
  const a2aScopes: Record<string, Scope> = {
    SendMessage: 'tasks:write', SendStreamingMessage: 'tasks:write',
    GetTask: 'tasks:read', ListTasks: 'tasks:read', SubscribeToTask: 'tasks:read', CancelTask: 'tasks:write',
  };
  app.use('/a2a', authenticate, (req, res, next) => {
    const scope = a2aScopes[req.body?.method];
    if (scope && !principals.get(req)?.scopes.includes(scope)) {
      res.setHeader('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${scope}"`);
      res.status(403).json({ error: 'insufficient_scope', scope });
      return;
    }
    next();
  }, jsonRpcHandler({
    requestHandler: a2a,
    userBuilder: async req => {
      const p = principals.get(req);
      if (!p) throw new Error('Authentication middleware was not run');
      return new AgentUser(p);
    },
  }));

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    const status = error?.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: status === 500 ? 'internal_error' : 'invalid_request' });
  };
  app.use(errors);
  return { app, tasks, store, members, network, catalog, definitions, scopes: SCOPES, close: async () => { await tasks.close(); await mcp.close(); network?.close(); store.close(); members.close(); } };
}
