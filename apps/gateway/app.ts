import { NetworkService } from '../../packages/network/service.js';
import { MemberSourceService } from '../../packages/members/source-service.js';
import { mountSourceRoutes } from './sources.js';
import { assertSourceProxy } from '../../packages/core/private-source-proxy.js';
import { mountNetworkRoutes } from './network/routes.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { paPaymentProtocol, paPaymentRequestSchema } from '../../packages/core/pa-payment.js';
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
import { DidiMemberAccess, didiSourceOwner } from '../../packages/core/didi-source.js';
import { createVerifier, protectedResourceMetadata, type VerifyToken } from './auth.js';
import { A2AGateway, AgentUser, agentCard } from './a2a.js';
import { DomainError, ownerKey, SCOPES, type Principal, type Scope } from '../../packages/core/domain.js';
import { createMcpServer } from './mcp.js';
import { JobStore } from '../../packages/core/store.js';
import { TaskService } from '../../packages/core/tasks.js';
import { publicTask as taskSummary } from './task-view.js';
import { AuthorizationCoordinator } from '../../packages/security/coordinator.js';
import { SecurityError } from '../../packages/security/store.js';
import { accessContextSchema } from '../../packages/security/contracts.js';
import { digest } from '../../packages/core/delegation.js';
import { MemberAccessError, MemberStore } from '../../packages/members/store.js';
import { mountMemberRoutes } from './members/routes.js';
import type { LoginProvider } from './members/oidc.js';
import { mountAgentRoutes } from './members/agent-routes.js';
import { AgentAccessError } from '../../packages/members/agents.js';
import { BACKEND_VERSION } from '../../packages/ontology/execution.js';
import { DefinitionService } from '../../packages/ontology/definition-service.js';
import { mountDefinitionRoutes } from './ontology/routes.js';
import { inviteBetaPrincipal, mountInviteBeta } from './invite-beta.js';
import { createIngressRouter } from './ingress.js';
import { decodeJwt } from 'jose';

const principalSchema = z.object({ issuer: z.string(), subject: z.string(), tenant: z.string(), clientId: z.string(), scopes: z.array(z.string()), access: accessContextSchema.optional() });
const auditId = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined;

export function createApp(config: Config, verify?: VerifyToken, catalogFactory?: (store: JobStore) => ExecutionCatalog, loginProvider?: LoginProvider, verifierFactory?: (config: Config) => VerifyToken) {
  assertPersonalSourceConfig(config);
  assertSourceProxy(config);
  if (config.EIGOS_CSV_PILOT === 'true' && (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(config.HOST) || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.PUBLIC_URL).hostname))) throw new Error('CSV simulation requires non-production loopback');
  if (config.EIGOS_NETWORK_ENABLED === 'true' && (config.EIGOS_AUTH_MODE !== 'jwt' || !config.OIDC_AGENT_CLIENT_ID || !config.OIDC_CLIENT_ID || !config.EIGOS_NETWORK_MEMBER_IDS.length)) throw new Error('Network requires explicit JWT and enrolled-member configuration');
  const hostname = new URL(config.PUBLIC_URL).hostname;
  const ingress = createIngressRouter(config, verify, verifierFactory);
  const allowedOrigins = new Set([config.PUBLIC_URL, ...(config.authority?.ingresses.map(value => value.origin) ?? []), ...config.ALLOWED_ORIGINS.split(',').filter(Boolean)]);
  const app = createMcpExpressApp({
    host: config.HOST,
    allowedHosts: [...new Set([hostname, ...(config.authority?.ingresses.map(value => new URL(value.origin).hostname) ?? [])])],
    allowedOrigins: [...allowedOrigins].map(origin => new URL(origin).hostname),
    jsonLimit: '64kb',
  });
  app.disable('x-powered-by');
  const principals = new WeakMap<Request, Principal>();
  const store = new JobStore(config.DATABASE_PATH, { securityMode: config.EIGOS_SECURITY_MODE, authority: config.authority });
  const members = new MemberStore(config.MEMBERSHIP_DATABASE_PATH ?? (config.DATABASE_PATH === ':memory:' ? ':memory:' : `${config.DATABASE_PATH}.members`));
  let catalog: ExecutionCatalog, tasks: TaskService, network: NetworkService | undefined;
  try {
    catalog = catalogFactory?.(store) ?? createExecutionCatalog({ store, personalSourceOwner: config.EIGOS_PERSONAL_SOURCE_OWNER, didiOrderTestEnabled: config.EIGOS_DIDI_ORDER_TEST_ENABLED === 'true', csvInputDirectory: config.EIGOS_CSV_PILOT === 'true' ? config.EIGOS_CSV_INPUT_DIR : undefined,
      documentEnabled: config.EIGOS_EXECUTOR === 'codex', paotuiSkillDirectory: config.EIGOS_PAOTUI_SKILL_DIR,
      paotuiMemberConnectionFile: config.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE, memberSourceKeyFile: config.EIGOS_MEMBER_SOURCE_KEY_FILE, executionHost: 'gateway',
      rollinggo: config.EIGOS_ROLLINGGO_KEY_FILE ? { keyFile: config.EIGOS_ROLLINGGO_KEY_FILE, keySha256: config.EIGOS_ROLLINGGO_KEY_SHA256! } : undefined,
      didiMember: config.EIGOS_DIDI_MEMBER_CONNECTION_FILE ? { connectionFile: config.EIGOS_DIDI_MEMBER_CONNECTION_FILE } : undefined,
      didi: config.EIGOS_DIDI_KEY_FILE ? { keyFile: config.EIGOS_DIDI_KEY_FILE, keySha256: config.EIGOS_DIDI_KEY_SHA256!, bindingId: config.EIGOS_DIDI_BINDING_ID!, bookingEnabled: config.EIGOS_DIDI_ORDERS_ENABLED === 'mock', environment: config.EIGOS_DIDI_ENVIRONMENT, auditDirectory: config.EIGOS_DIDI_AUDIT_DIR } : undefined,
      publicGeoDiscoveryQueries: config.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES,
      shopifyCatalog: config.EIGOS_SHOPIFY_CATALOG_MERCHANTS?.length ? { merchants: config.EIGOS_SHOPIFY_CATALOG_MERCHANTS } : undefined,
      participantBooking: config.EIGOS_FREE_BOOKING_BRIDGE_URL ? { endpoint: config.EIGOS_FREE_BOOKING_BRIDGE_URL, tokenFile: config.EIGOS_FREE_BOOKING_TOKEN_FILE!, bindingId: config.EIGOS_FREE_BOOKING_BINDING_ID!, attendeeRef: config.EIGOS_FREE_BOOKING_ATTENDEE_SHA256! } : undefined,
      shopifyCheckout: config.EIGOS_SHOPIFY_CHECKOUT_MERCHANTS?.length ? { merchants: config.EIGOS_SHOPIFY_CHECKOUT_MERCHANTS, auditDirectory: config.EIGOS_SHOPIFY_CHECKOUT_AUDIT_DIR } : undefined,
      shopifyPaymentSandbox: config.EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL ? { endpoint: config.EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL, tokenFile: config.EIGOS_SHOPIFY_PAYMENT_SANDBOX_TOKEN_FILE! } : undefined,
      bookingSandbox: config.EIGOS_BOOKING_SANDBOX_URL ? { endpoint: config.EIGOS_BOOKING_SANDBOX_URL, tokenFile: config.EIGOS_BOOKING_SANDBOX_TOKEN_FILE! } : undefined,
      commerceSandbox: config.EIGOS_COMMERCE_SANDBOX_URL ? { endpoint: config.EIGOS_COMMERCE_SANDBOX_URL, tokenFile: config.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE! } : undefined,
      sandbox: config.EIGOS_SANDBOX_PROVIDER_URL ? { endpoint: config.EIGOS_SANDBOX_PROVIDER_URL, tokenFile: config.EIGOS_SANDBOX_TOKEN_FILE! } : undefined });
    tasks = new TaskService(store, { catalog, allowSandboxActions: config.EIGOS_ACTION_SANDBOX === 'true', allowExternalDrafts: !!config.EIGOS_SHOPIFY_CHECKOUT_MERCHANTS?.length });
    if (!store.security.enabled && config.EIGOS_NETWORK_ENABLED === 'true') network = new NetworkService(store.createNetworkStore(), members, { memberIds: config.EIGOS_NETWORK_MEMBER_IDS, operatorIds: config.EIGOS_NETWORK_OPERATOR_MEMBER_IDS, collaborationLimits: { maxResponders: config.EIGOS_NETWORK_MAX_RESPONDERS, maxClarificationRounds: config.EIGOS_NETWORK_MAX_CLARIFICATION_ROUNDS }, catalog, jobs: store, tasks });
    if (config.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE) {
      const access = new PersonalSourceAccess(config.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE, (c, hash) => store.personalSourceAdmitted(c, hash), config.EIGOS_PAOTUI_SKILL_DIR!);
      const member = members.get(access.record.memberId);
      if (!config.EIGOS_NETWORK_MEMBER_IDS.includes(member.id) || member.status !== 'active' || member.issuer !== config.OAUTH_ISSUER
        || ownerKey({ ...member, clientId: '', scopes: [] }) !== sourceOwner(access.record)) throw new Error('Personal source must identify its exact active enrolled member');
      store.admitPersonalSource(access.record, access.configurationDigest);
    } else store.admitPersonalSource();
    if (config.EIGOS_DIDI_MEMBER_CONNECTION_FILE) {
      const access = new DidiMemberAccess(config.EIGOS_DIDI_MEMBER_CONNECTION_FILE, (record, hash) => store.memberDidiSourceAdmitted(record, hash));
      const member = members.get(access.record.memberId);
      if (network || !config.authority && config.EIGOS_INVITE_BETA !== 'true' || member.status !== 'active' || member.issuer !== config.OAUTH_ISSUER
        || ownerKey({ ...member, clientId: '', scopes: [] }) !== didiSourceOwner(access.record)) throw new Error('Member DiDi must identify its exact active invited member');
      store.admitMemberDidiSource(access.record, access.configurationDigest);
      members.setRevocationObserver(change => { if (!store.security.enabled || change.kind === 'member') store.revokeMemberDidiSource(change.memberId); });
    } else store.admitMemberDidiSource();
  } catch (error) { network?.close(); store.close(); members.close(); throw error; }
  const security = store.security.enabled ? new AuthorizationCoordinator(store.security, members, store, catalog) : undefined;
  try { security?.start(); } catch(error) { network?.close(); store.close(); members.close(); throw error; }
  app.use((req, res, next) => {
    if (!store.authorityCurrent()) { res.status(503).json({ error: 'runtime_authority_unavailable' }); return; }
    if (config.authority) {
      let route;
      try { route = ingress.selected(req)!; } catch { res.status(403).json({ error: 'unregistered_ingress' }); return; }
      res.setHeader('X-EIGOS-Authority-Id', config.authority.id);
      if (route.browserRedirect && (req.path === '/' || req.path === '/members' || req.path.startsWith('/members/'))) {
        res.redirect(307, config.PUBLIC_URL + req.originalUrl); return;
      }
    }
    next();
  });
  if (config.EIGOS_AUDIT_PATH) mkdirSync(dirname(config.EIGOS_AUDIT_PATH), { recursive: true, mode: 0o700 });
  app.use((req, res, next) => {
    if (config.EIGOS_AUDIT_PATH && (['/mcp', '/a2a', '/.well-known/agent-card.json', '/agents/registrations'].includes(req.path) || /^\/tasks\/[^/]+\/authorize$/.test(req.path) || /^\/agents\/registrations\/[0-9a-f-]{36}(?:\/[a-z]+)?$/i.test(req.path))) {
      const entry = security ? {
        at:new Date().toISOString(),path:req.path.startsWith('/tasks/')?'/tasks/:taskId/authorize':req.path.startsWith('/agents/registrations/')?'/agents/registrations/:id/:action':req.path,
        method:['SendMessage','GetTask','ListTasks','CancelTask','tools/call','tools/list','initialize','approve_plan','confirm_simulated_payment'].includes(req.body?.method??req.body?.action)?req.body.method??req.body.action:req.method,
        requestDigest:digest({requestId:req.body?.id,messageId:req.body?.params?.message?.messageId,taskId:req.body?.params?.id??req.body?.params?.message?.taskId,registrationId:req.body?.registrationId}),
      } : {
        at: new Date().toISOString(), path: req.path, method: req.body?.method ?? req.body?.action ?? req.method,
        requestId: auditId(req.body?.id), messageId: auditId(req.body?.params?.message?.messageId),
        taskId: auditId(req.body?.params?.id ?? req.body?.params?.message?.taskId ?? req.body?.params?.arguments?.taskId),
        operationId: auditId(req.body?.params?.arguments?.requestId),
        ...(req.path === '/mcp' && /^[a-z_]{1,80}$/.test(req.body?.params?.name ?? '') ? { tool: req.body.params.name } : {}),
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
  const runtimeIdentity = { instance: config.PUBLIC_URL, backend: BACKEND_VERSION, releaseDigest: config.EIGOS_RELEASE_DIGEST, ontologyTransport: 'native-mcp' as const,
    ...(config.authority ? { authorityId: config.authority.id, authorityRevision: config.authority.revision } : {}) };
  app.get('/health', (_req, res) => { const available = !security || security.available; res.status(available ? 200 : 503).json({ status: available ? 'ok' : 'unavailable', version: '0.1.0', ...runtimeIdentity,
    ...(config.authority?{ontologyRelease:store.definitions.active().ref}:{}),securityStage: security ? 'S5_foundation_v2' : 'legacy' }); });
  mountInviteBeta(app, config);
  if (config.EIGOS_INVITE_BETA === 'true') app.get('/.well-known/eigos-pa-payment', (_req, res) => { res.status(404).json({ error: 'payment_unavailable_in_invite_beta' }); });
  app.get('/.well-known/eigos-pa-payment', (_req, res) => { const protocol = paPaymentProtocol(!security && !!config.EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL); res.json(security ? { ...protocol, requestPath: 'metadata.payment.request', selectionPath: 'metadata.payment.selection', requestSchema: z.toJSONSchema(paPaymentRequestSchema.omit({ownerDigest:true,configurationDigest:true})) } : protocol); });
  mountMemberRoutes(app, config, members, loginProvider, security);
  mountAgentRoutes(app, config, members, verify ?? createVerifier(config), security, config.authority ? req => ({ config: ingress.config(req), verify: ingress.verify(req), route: ingress.selected(req)! }) : undefined);
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource/a2a'], (req, res) => {
    if (config.EIGOS_AUTH_MODE !== 'jwt') { res.status(404).json({ error: 'oauth_not_configured', mode: 'local-development' }); return; }
    res.json(protectedResourceMetadata(ingress.config(req)));
  });

  const authenticate: RequestHandler = async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    try {
      if (!match?.[1]) throw new Error('Missing token');
      const verified = await ingress.verify(req)(match[1]);
      const principal = config.authority ? ingress.principal(req, verified) : inviteBetaPrincipal(config, verified);
      if (!principal) { res.status(403).json({ error: 'client_not_admitted', membership_url: `${config.PUBLIC_URL}/members` }); return; }
      if (security) {
        try {
          if (config.authority) {
            const route = ingress.selected(req)!;
            if (route.nativeClientIds.includes(principal.clientId)) {
              members.authorize(principal);
              const member = members.find(principal)!;
              const claims = z.object({ exp: z.number() }).parse(decodeJwt(match[1]));
              members.agents.authorizeNative(principal, member.id, match[1], claims.exp * 1000);
            } else if (!route.agentClientIds.includes(principal.clientId)) throw new SecurityError('AUTHORIZATION_REQUIRED');
          } else if (principal.clientId !== config.OIDC_AGENT_CLIENT_ID) throw new SecurityError('AUTHORIZATION_REQUIRED');
          principal.access = security.authenticate(principal, match[1]);
        } catch(error) {
          const guidance = { onboarding_url: `${ingress.config(req).PUBLIC_URL}/.well-known/eigos-agent-registration`, permissions_url: `${config.PUBLIC_URL}/members/permissions` };
          if(error instanceof SecurityError) res.status(error.reason==='AUTHORITY_UNAVAILABLE'||error.reason==='REVOCATION_PENDING'?503:403).json({error:error.reason,...guidance});
          else if(error instanceof AgentAccessError||error instanceof MemberAccessError) res.status(403).json({error:error.code,...guidance});
          else if(error instanceof DomainError) res.status(403).json({error:error.code});
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
      const discovery = config.EIGOS_AUTH_MODE === 'jwt' ? `, resource_metadata="${ingress.config(req).PUBLIC_URL}/.well-known/oauth-protected-resource"` : '';
      res.setHeader('WWW-Authenticate', `Bearer realm="eigos", error="invalid_token"${discovery}`);
      res.status(401).json({ error: 'invalid_token', ...(config.OIDC_AGENT_CLIENT_ID ? { onboarding_url: `${config.PUBLIC_URL}/.well-known/eigos-agent-registration` } : {}) });
    }
  };

  if (!security) mountNetworkRoutes(app, config, members, network, authenticate, req => principals.get(req)!);
  const sources = !security && config.EIGOS_MEMBER_SOURCE_KEY_FILE ? new MemberSourceService(store.memberSources(config.EIGOS_MEMBER_SOURCE_KEY_FILE, config.EIGOS_PAOTUI_SKILL_DIR!), members, tasks, config) : undefined;
  if (!security) mountSourceRoutes(app, sources, authenticate, req => principals.get(req)!);
  const definitions = new DefinitionService(store, tasks, catalog);
  mountDefinitionRoutes(app, definitions, authenticate, req => principals.get(req)!);

  app.post('/security/context', authenticate, (req, res) => {
    if (!security) { res.status(404).json({error:'security_foundation_not_enabled'}); return; }
    if (!z.strictObject({}).safeParse(req.body).success) {res.status(400).json({error:'invalid_security_context_input'});return;}
    const p=principals.get(req)!,context=p.access;
    if(!p.scopes.includes('services:read')){res.status(403).json({error:'insufficient_scope'});return;}
    if(context?.actorKind!=='agent'){res.status(403).json({error:'AUTHORIZATION_REQUIRED'});return;}
    res.json({stage:'S5',actorKind:context.actorKind,installationId:context.installationId,grant:context.agentGrant,authEpoch:context.authEpoch,businessAccess:'task_grant_required'});
  });

  // Same authentication, membership, scopes and owner as MCP/A2A; no object-write endpoint.
  for (const operation of ['describe', 'query', 'evaluate','check-access'] as const) app.post(`/ontology/${operation}`, authenticate, (req, res, next) => {
    try {
      const p = principals.get(req)!;
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
      const reader = operation === 'describe' ? undefined : network?.ontologyReader(p, token);
      res.json(operation === 'describe' ? tasks.describeOntology(p, req.body) : operation === 'query' ? tasks.queryOntology(p, req.body, reader) : operation === 'check-access' ? tasks.checkAccess(p,req.body) : tasks.evaluateOntology(p, req.body, reader));
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
  app.get('/tasks',authenticate,taskHttp(req=>{const found=tasks.list(principals.get(req)!,z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(1_000_000).default(0)}).parse(req.query));return {...found,jobs:found.jobs.map(taskSummary)};}));
  app.get('/tasks/:taskId',authenticate,taskHttp(req=>taskSummary(tasks.get(principals.get(req)!,String(req.params.taskId)))));
  app.post('/tasks',authenticate,taskHttp(req=>taskSummary(tasks.submit(principals.get(req)!,req.body))));
  app.post('/tasks/:taskId/reply',authenticate,taskHttp(req=>taskSummary(tasks.reply(principals.get(req)!,{...req.body,taskId:String(req.params.taskId)}))));
  app.post('/tasks/:taskId/cancel',authenticate,taskHttp(req=>{z.strictObject({}).parse(req.body);return taskSummary(tasks.cancel(principals.get(req)!,String(req.params.taskId)));}));
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

  const mcp = createMcpHandler(ctx => createMcpServer(tasks, principalSchema.parse(ctx.authInfo?.extra?.principal), network ? { service: network, token: ctx.authInfo?.token ?? '' } : undefined, sources ? { service: sources, token: ctx.authInfo?.token ?? '' } : undefined, !security && config.EIGOS_INVITE_BETA === 'true' ? undefined : definitions, { payment: config.EIGOS_INVITE_BETA !== 'true', runtime: runtimeIdentity, externalDrafts: !!config.EIGOS_SHOPIFY_CHECKOUT_MERCHANTS?.length }), {
    legacy: 'stateless', maxSubscriptions: 0,
  });
  const handleMcp = toNodeHandler(mcp);
  app.all('/mcp', authenticate, async (req, res) => { await handleMcp(req, res, req.body); });

  const a2a = new A2AGateway(tasks, agentCard(config, tasks.services()));
  app.get('/.well-known/agent-card.json', async (req, res) => { res.json(AgentCard.toJSON(config.authority ? agentCard(ingress.config(req), tasks.services()) : await a2a.getAgentCard())); });
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
  return { app, tasks, store, members, network, catalog, definitions, security, scopes: SCOPES, close: async () => { security?.close(); await tasks.close(); await mcp.close(); network?.close(); store.close(); members.close(); } };
}
