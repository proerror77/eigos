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
import { allowsBoundPersonalSource, type Config } from '../../packages/core/config.js';
import { createVerifier, protectedResourceMetadata, type VerifyToken } from './auth.js';
import { A2AGateway, AgentUser, agentCard } from './a2a.js';
import { DomainError, SCOPES, type Principal, type Scope } from '../../packages/core/domain.js';
import { createMcpServer } from './mcp.js';
import { JobStore } from '../../packages/core/store.js';
import { TaskService } from '../../packages/core/tasks.js';
import { MemberAccessError, MemberStore } from '../../packages/members/store.js';
import { mountMemberRoutes } from './members/routes.js';
import type { LoginProvider } from './members/oidc.js';
import { mountAgentRoutes } from './members/agent-routes.js';
import { AgentAccessError } from '../../packages/members/agents.js';
import { BACKEND_VERSION } from '../../packages/ontology/execution.js';
import { AuthorizationCoordinator } from '../../packages/security/coordinator.js';
import { SecurityError } from '../../packages/security/store.js';
import { accessContextSchema } from '../../packages/security/contracts.js';
import {digest} from '../../packages/core/delegation.js';

const principalSchema = z.object({ issuer: z.string(), subject: z.string(), tenant: z.string(), clientId: z.string(), scopes: z.array(z.string()), access: accessContextSchema.optional() });

export function createApp(config: Config, verify: VerifyToken = createVerifier(config), catalogFactory?: (store: JobStore) => ExecutionCatalog, loginProvider?: LoginProvider) {
  if (config.EIGOS_PAOTUI_SKILL_DIR && !allowsBoundPersonalSource(config, process.env.NODE_ENV) && (config.EIGOS_AUTH_MODE !== 'development' || process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(config.HOST) || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.PUBLIC_URL).hostname))) throw new Error('Paotui requires a bound foundation owner or loopback development mode');
  if (config.EIGOS_CSV_PILOT === 'true' && (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(config.HOST) || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.PUBLIC_URL).hostname))) throw new Error('CSV simulation requires non-production loopback');
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
  const store = new JobStore(config.DATABASE_PATH, { securityMode: config.EIGOS_SECURITY_MODE });
  const members = new MemberStore(config.MEMBERSHIP_DATABASE_PATH ?? (config.DATABASE_PATH === ':memory:' ? ':memory:' : `${config.DATABASE_PATH}.members`));
  const catalog = catalogFactory?.(store) ?? createExecutionCatalog({ store, personalSourceOwner: config.EIGOS_PERSONAL_SOURCE_OWNER, csvInputDirectory: config.EIGOS_CSV_PILOT === 'true' ? config.EIGOS_CSV_INPUT_DIR : undefined,
    documentEnabled: config.EIGOS_EXECUTOR === 'codex', paotuiSkillDirectory: config.EIGOS_PAOTUI_SKILL_DIR,
    publicGeoDiscoveryQueries: config.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES,
    didi: config.EIGOS_DIDI_KEY_FILE ? { keyFile: config.EIGOS_DIDI_KEY_FILE, keySha256: config.EIGOS_DIDI_KEY_SHA256!, bindingId: config.EIGOS_DIDI_BINDING_ID!, environment: config.EIGOS_DIDI_ENVIRONMENT } : undefined,
    shopifyCatalog: config.EIGOS_SHOPIFY_CATALOG_MERCHANTS?.length ? { merchants: config.EIGOS_SHOPIFY_CATALOG_MERCHANTS } : undefined,
    participantBooking: config.EIGOS_FREE_BOOKING_BRIDGE_URL ? { endpoint: config.EIGOS_FREE_BOOKING_BRIDGE_URL, tokenFile: config.EIGOS_FREE_BOOKING_TOKEN_FILE!, bindingId: config.EIGOS_FREE_BOOKING_BINDING_ID!, attendeeRef: config.EIGOS_FREE_BOOKING_ATTENDEE_SHA256! } : undefined,
    bookingSandbox: config.EIGOS_BOOKING_SANDBOX_URL ? { endpoint: config.EIGOS_BOOKING_SANDBOX_URL, tokenFile: config.EIGOS_BOOKING_SANDBOX_TOKEN_FILE! } : undefined,
    commerceSandbox: config.EIGOS_COMMERCE_SANDBOX_URL ? { endpoint: config.EIGOS_COMMERCE_SANDBOX_URL, tokenFile: config.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE! } : undefined,
    sandbox: config.EIGOS_SANDBOX_PROVIDER_URL ? { endpoint: config.EIGOS_SANDBOX_PROVIDER_URL, tokenFile: config.EIGOS_SANDBOX_TOKEN_FILE! } : undefined });
  const tasks = new TaskService(store, { catalog, allowSandboxActions: config.EIGOS_ACTION_SANDBOX === 'true' });
  const security = store.security.enabled ? new AuthorizationCoordinator(store.security, members, store, catalog) : undefined;
  try { security?.start(); } catch (error) { store.close(); members.close(); throw error; }
  if (config.EIGOS_AUDIT_PATH) mkdirSync(dirname(config.EIGOS_AUDIT_PATH), { recursive: true, mode: 0o700 });
  app.use((req, res, next) => {
    if (config.EIGOS_AUDIT_PATH && (['/mcp', '/a2a', '/.well-known/agent-card.json', '/agents/registrations'].includes(req.path) || /^\/tasks\/[^/]+\/authorize$/.test(req.path) || /^\/agents\/registrations\/[0-9a-f-]{36}(?:\/[a-z]+)?$/i.test(req.path))) {
      const entry = security ? {
        at:new Date().toISOString(),path:req.path.startsWith('/tasks/')?'/tasks/:taskId/authorize':req.path.startsWith('/agents/registrations/')?'/agents/registrations/:id/:action':req.path,
        method:['SendMessage','GetTask','ListTasks','CancelTask','tools/call','tools/list','initialize','approve_plan','confirm_simulated_payment'].includes(req.body?.method??req.body?.action)?req.body.method??req.body.action:req.method,
        requestDigest:digest({requestId:req.body?.id,messageId:req.body?.params?.message?.messageId,taskId:req.body?.params?.id??req.body?.params?.message?.taskId,registrationId:req.body?.registrationId}),
      } : {
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
  app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0', backend: BACKEND_VERSION, releaseDigest: config.EIGOS_RELEASE_DIGEST, securityStage: security ? 'S5_foundation_v2' : 'legacy' }));
  app.get('/.well-known/eigos-pa-payment', (_req, res) => res.json({ version: '2', environment: 'sandbox', paymentAuthority: 'pa_owned', credentialsAccepted: false, routePolicy: 'prefer_link_agent_wallet', routes: ['link_agent_wallet', 'link_checkout'], checkoutRequiresUserConfirmation: true, switchAfterSelection: false, requestPath: security ? 'metadata.payment.request' : 'metadata.delegation.agent.paPayment.request', selectionPath: security ? 'metadata.payment.selection' : 'metadata.delegation.agent.paPayment.selection', a2a: { method: 'SendMessage', actions: ['select_payment_route', 'report_payment_result'] }, mcpTools: ['select_payment_route', 'report_payment_result'], notificationIsPaymentProof: false, completionRequires: ['independent_provider_payment', 'independent_provider_booking'], requestSchema: z.toJSONSchema(security ? paPaymentRequestSchema.omit({ownerDigest:true,configurationDigest:true}) : paPaymentRequestSchema), routeSchema: z.toJSONSchema(paPaymentRouteSchema), selectionSchema: z.toJSONSchema(paPaymentSelectionSchema), reportSchema: z.toJSONSchema(paPaymentReportSchema) }));
  mountMemberRoutes(app, config, members, loginProvider, security);
  mountAgentRoutes(app, config, members, verify, security);
  const metadataUrl = `${config.PUBLIC_URL}/.well-known/oauth-protected-resource`;
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource/a2a'], (_req, res) => {
    if (config.EIGOS_AUTH_MODE !== 'jwt') { res.status(404).json({ error: 'oauth_not_configured', mode: 'local-development' }); return; }
    res.json(protectedResourceMetadata(config));
  });

  const authenticate: RequestHandler = async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    try {
      if (!match?.[1]) throw new Error('Missing token');
      const { issuer, subject, tenant, clientId, scopes } = await verify(match[1]);
      const principal: Principal = { issuer, subject, tenant, clientId, scopes };
      if (security) {
        try {
          if (principal.clientId !== config.OIDC_AGENT_CLIENT_ID) throw new SecurityError('AUTHORIZATION_REQUIRED');
          principal.access = security.authenticate(principal, match[1]);
        } catch (error) {
          if (error instanceof SecurityError) res.status(error.reason === 'AUTHORITY_UNAVAILABLE' || error.reason === 'REVOCATION_PENDING' ? 503 : 403).json({ error: error.reason });
          else if (error instanceof AgentAccessError || error instanceof MemberAccessError) res.status(403).json({ error: error.code });
          else if (error instanceof DomainError) res.status(403).json({ error: error.code });
          else next(error);
          return;
        }
      } else if (config.EIGOS_AUTH_MODE === 'jwt') {
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

  app.post('/security/context', authenticate, (req, res) => {
    if (!security) { res.status(404).json({ error: 'security_foundation_not_enabled' }); return; }
    if (!z.strictObject({}).safeParse(req.body).success) { res.status(400).json({ error: 'invalid_security_context_input' }); return; }
    const p = principals.get(req)!, context = p.access;
    if (!p.scopes.includes('services:read')) { res.status(403).json({ error: 'insufficient_scope' }); return; }
    if (context?.actorKind !== 'agent') { res.status(403).json({ error: 'AUTHORIZATION_REQUIRED' }); return; }
    res.json({ stage: 'S5', actorKind: context.actorKind, installationId: context.installationId, grant: context.agentGrant, authEpoch: context.authEpoch, businessAccess: 'task_grant_required' });
  });

  // Same authentication, membership, scopes and owner as MCP/A2A; no object-write endpoint.
  for (const operation of ['describe', 'query', 'evaluate','check-access'] as const) app.post(`/ontology/${operation}`, authenticate, (req, res, next) => {
    try {
      const p = principals.get(req)!;
      res.json(operation === 'describe' ? tasks.describeOntology(p, req.body) : operation === 'query' ? tasks.queryOntology(p, req.body) : operation==='check-access' ? tasks.checkAccess(p,req.body) : tasks.evaluateOntology(p, req.body));
    } catch (error) {
      if (error instanceof DomainError) { res.status(error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : 409).json({ error: error.code, message: error.message }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_ontology_input' }); return; }
      next(error);
    }
  });

  const taskHttp=(action:(req:Request)=>unknown):RequestHandler=>(req,res,next)=>{
    try {res.json(action(req));} catch(error) {
      if(error instanceof DomainError){res.status(error.code==='FORBIDDEN'?403:error.code==='NOT_FOUND'?404:error.code==='INVALID_INPUT'?400:409).json({error:error instanceof SecurityError?error.reason:error.code});return;}
      if(error instanceof z.ZodError){res.status(400).json({error:'invalid_task_input'});return;} next(error);
    }
  };
  app.get('/tasks',authenticate,taskHttp(req=>tasks.list(principals.get(req)!,z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(1_000_000).default(0)}).parse(req.query))));
  app.get('/tasks/:taskId',authenticate,taskHttp(req=>tasks.get(principals.get(req)!,String(req.params.taskId))));
  app.post('/tasks',authenticate,taskHttp(req=>tasks.submit(principals.get(req)!,req.body)));
  app.post('/tasks/:taskId/reply',authenticate,taskHttp(req=>tasks.reply(principals.get(req)!,{...req.body,taskId:String(req.params.taskId)})));
  app.post('/tasks/:taskId/cancel',authenticate,taskHttp(req=>{z.strictObject({}).parse(req.body);return tasks.cancel(principals.get(req)!,String(req.params.taskId));}));
  app.get('/tasks/:taskId/artifacts/:artifactId',authenticate,(req,res,next)=>{
    try {
      const artifact=tasks.downloadArtifact(principals.get(req)!,String(req.params.taskId),String(req.params.artifactId));
      res.set({'Content-Type':artifact.mediaType,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Disposition':`attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`}).send(artifact.content);
    } catch(error) {
      if(error instanceof DomainError){res.status(error.code==='NOT_FOUND'?404:403).json({error:error instanceof SecurityError?error.reason:error.code});return;}
      if(error instanceof z.ZodError){res.status(400).json({error:'invalid_artifact'});return;}next(error);
    }
  });

  // Application authorization channel, separate from A2A messages. No raw credentials in task parts.
  app.post('/tasks/:taskId/authorize', authenticate, (req, res, next) => {
    try { res.json({ task: tasks.authorize(principals.get(req)!, String(req.params.taskId), req.body) }); }
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
      res.json({ task });
    } catch (error) {
      if (error instanceof DomainError) { res.status(error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : 409).json({ error: error.code, message: error.message }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_business_action' }); return; } next(error);
    }
  });

  const mcp = createMcpHandler(ctx => createMcpServer(tasks, principalSchema.parse(ctx.authInfo?.extra?.principal)), {
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
  return { app, tasks, store, members, catalog, security, scopes: SCOPES, close: async () => { security?.close(); await tasks.close(); await mcp.close(); store.close(); members.close(); } };
}
