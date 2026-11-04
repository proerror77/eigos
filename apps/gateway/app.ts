import { commerceConnectionsFromConfig } from '../../packages/capabilities/payment-commerce/connection.js';
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
import { securityErrorResponse } from '../../packages/security/error-guidance.js';
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
import { inviteBetaPrincipal } from './invite-beta.js';
import { mountPaOnboarding } from './pa-onboarding.js';
import { createIngressRouter } from './ingress.js';
import { decodeJwt } from 'jose';
import { TaskRelayGateway, mountTaskRelay, readTaskRelayConfig } from './relay.js';
import { AgentMessagingService } from '../../packages/agent-messaging/service.js';
import { communicationRequestSchema, MESSAGING_SCOPES, MESSAGING_TOOLS, MessagingError, type MessagingIdentity } from '../../packages/agent-messaging/contracts.js';
import { communicationIntent, communicationScope } from './messaging/rpc.js';
import { mountMessagingMemberRoutes } from './messaging/routes.js';
import {memberPermissionCoordinatorPort} from '../../packages/members/ports.js';
import {runtimeAuthorityDigest} from '../../packages/core/runtime-authority.js';
import type {GatewayRuntimePorts,GatewayApplication,GatewayApplicationFactory} from './runtime-ports.js';

const principalSchema = z.object({ issuer: z.string(), subject: z.string(), tenant: z.string(), clientId: z.string(), scopes: z.array(z.string()), access: accessContextSchema.optional() });
const auditId = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined;

export function createApp(config: Config, verify?: VerifyToken, catalogFactory?: (store: JobStore) => ExecutionCatalog, loginProvider?: LoginProvider, verifierFactory?: (config: Config) => VerifyToken) {
  assertPersonalSourceConfig(config);
  assertSourceProxy(config);
  assertHttpConfiguration(config);
  const store = new JobStore(config.DATABASE_PATH, { securityMode: config.EIGOS_SECURITY_MODE, authority: config.authority });
  const members = new MemberStore(config.MEMBERSHIP_DATABASE_PATH ?? (config.DATABASE_PATH === ':memory:' ? ':memory:' : `${config.DATABASE_PATH}.members`));
  let catalog: ExecutionCatalog, tasks: TaskService, network: NetworkService | undefined;
  try {
    catalog = catalogFactory?.(store) ?? createExecutionCatalog({ paymentCommerce: commerceConnectionsFromConfig(config), store, didiRelayAgentId: config.EIGOS_DIDI_RELAY_AGENT_ID, personalSourceOwner: config.EIGOS_PERSONAL_SOURCE_OWNER, didiOrderTestEnabled: config.EIGOS_DIDI_ORDER_TEST_ENABLED === 'true', csvInputDirectory: config.EIGOS_CSV_PILOT === 'true' ? config.EIGOS_CSV_INPUT_DIR : undefined,
      documentEnabled: config.EIGOS_EXECUTOR !== 'disabled', paotuiSkillDirectory: config.EIGOS_PAOTUI_SKILL_DIR,
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
  let relay: TaskRelayGateway | undefined, messaging: AgentMessagingService | undefined;
  try {
    const relayConfig = config.EIGOS_TASK_RELAY_FILE ? readTaskRelayConfig(config.EIGOS_TASK_RELAY_FILE) : undefined;
    relay = relayConfig ? new TaskRelayGateway(store, tasks, config.PUBLIC_URL, relayConfig, config.EIGOS_DIDI_RELAY_AGENT_ID) : undefined;
    security?.start();
    if (config.EIGOS_MESSAGING_ENABLED === 'true') {
      if (!config.authority || !security || !relay?.enrollment || !relayConfig || !config.EIGOS_MESSAGING_NODE_DIR)
        throw new Error('Messaging requires the primary JWT authority, its configured Relay enrollment issuer and a private node directory');
      messaging = new AgentMessagingService(store.createMessagingStore(), members, { relayUrl: relayConfig.relayUrl,
        nodeDirectory: config.EIGOS_MESSAGING_NODE_DIR, enrollment: relay.enrollment, available: () => !!security?.available && store.authorityCurrent(),
        permissionsUrl: `${config.PUBLIC_URL}/members/communications`,
        checkIdentity: facts => {
          if (store.security.hasFence({ ownerKey: facts.ownerKey, kind: 'member', targetId: facts.memberId })
            || store.security.hasFence({ ownerKey: facts.ownerKey, kind: 'connection', targetId: facts.clientId })
            || store.security.hasFence({ ownerKey: facts.ownerKey, kind: 'installation', targetId: facts.installationId })) throw new MessagingError('MESSAGING_AUTHORIZATION_REQUIRED');
          return store.security.identityGeneration(facts);
        } });
    }
  } catch(error) { security?.close(); network?.close(); store.close(); members.close(); throw error; }
  const sources = !security && config.EIGOS_MEMBER_SOURCE_KEY_FILE ? new MemberSourceService(store.memberSources(config.EIGOS_MEMBER_SOURCE_KEY_FILE, config.EIGOS_PAOTUI_SKILL_DIR!), members, tasks, config) : undefined;
  const definitions = new DefinitionService(store, tasks, catalog);
  const runtime:GatewayRuntimePorts={backend:'sqlite',tasks,members,definitions,
    ...(config.authority?{authority:{id:config.authority.id,revision:config.authority.revision,digest:runtimeAuthorityDigest(config.authority)}}:{}),
    security:security?{permissions:memberPermissionCoordinatorPort(security),authenticate:(principal,bearer)=>security.authenticate(principal,bearer),available:()=>security.available,onUnavailable:handler=>security.onUnavailable(handler)}:undefined,
    relay:relay?{status:()=>relay.status,mount:(app,authenticate,principal)=>mountTaskRelay(app,relay,store,authenticate,principal)}:undefined,
    messaging:messaging?{service:messaging,mountMembers:app=>mountMessagingMemberRoutes(app,config,members,messaging)}:undefined,
    legacy:{network,sources,mount:(app,authenticate,principal)=>{mountNetworkRoutes(app,config,members,network,authenticate,principal);mountSourceRoutes(app,sources,authenticate,principal);}},
    authorityCurrent:()=>store.authorityCurrent(),ontologyRelease:()=>store.definitions.active().ref,start:async()=>{await relay?.start();},
    close:async()=>{const errors:unknown[]=[];for(const action of [()=>messaging?.close(),()=>relay?.close(),()=>security?.close(),()=>network?.close(),()=>store.close(),()=>members.close()]){try{await action();}catch(error){errors.push(error);}}if(errors.length)throw new AggregateError(errors,'SQLite Gateway runtime shutdown failed');}};
  try { const gateway=createGatewayHttpApp(config,runtime,verify,loginProvider,verifierFactory);return {...gateway,tasks,store,members,network,catalog,definitions,security,relay,messaging}; }
  catch(error){security?.close();network?.close();store.close();members.close();void Promise.allSettled([messaging?.close(),relay?.close(),tasks.close()]);throw error;}
}

/** Shared authenticated HTTP layer. Runtime construction and storage ownership
 * stay in the factories; protocol routes never instantiate a storage backend. */
function createGatewayHttpApp(config:Config,runtime:GatewayRuntimePorts,verify?:VerifyToken,loginProvider?:LoginProvider,verifierFactory?:(config:Config)=>VerifyToken){
  const {tasks,members,definitions,security}=runtime,network=runtime.legacy?.network,sources=runtime.legacy?.sources,relay=runtime.relay,messaging=runtime.messaging?.service;
  const securityAdvice=(error:unknown)=>error instanceof SecurityError?securityErrorResponse(error,config.PUBLIC_URL):{};
  assertHttpConfiguration(config);
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
  const messagingIdentities = new WeakMap<Request, MessagingIdentity>();
  app.use(async (req, res, next) => {
    try { if (!await runtime.authorityCurrent()) { res.status(503).json({ error: 'runtime_authority_unavailable' }); return; } }
    catch { res.status(503).json({error:'runtime_authority_unavailable'});return; }
    if (config.authority) {
      let route;
      try { route = ingress.selected(req)!; } catch { res.status(403).json({ error: 'unregistered_ingress' }); return; }
      res.setHeader('X-EIGOS-Authority-Id', config.authority.id);
      if (route.browserRedirect && (req.path === '/' || req.path === '/connect' || req.path.startsWith('/connect/') || req.path === '/members' || req.path.startsWith('/members/'))) {
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
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, DPoP, MCP-Protocol-Version, Mcp-Method, Mcp-Name, A2A-Version, X-EIGOS-Registration-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version, A2A-Version');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  const runtimeIdentity = { instance: config.PUBLIC_URL, backend: BACKEND_VERSION, releaseDigest: config.EIGOS_RELEASE_DIGEST, ontologyTransport: 'native-mcp' as const,
    ...(config.authority ? { authorityId: config.authority.id, authorityRevision: config.authority.revision } : {}) };
  app.get('/health', async (_req, res) => { try { const available = !security || await security.available(); res.status(available ? 200 : 503).json({ status: available ? 'ok' : 'unavailable', version: '0.1.0', ...runtimeIdentity,
    ...(config.authority?{ontologyRelease:await runtime.ontologyRelease()}:{}), ...(relay ? { taskRelay: { status: await relay.status() } } : {}), securityStage: security ? 'S5_foundation_v2' : 'legacy' }); }
    catch { res.status(503).json({status:'unavailable',version:'0.1.0',...runtimeIdentity}); } });
  mountPaOnboarding(app, config);
  if (config.EIGOS_INVITE_BETA === 'true') app.get('/.well-known/eigos-pa-payment', (_req, res) => { res.status(404).json({ error: 'payment_unavailable_in_invite_beta' }); });
  app.get('/.well-known/eigos-pa-payment', (_req, res) => { const protocol = paPaymentProtocol(!security && !!config.EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL); res.json(security ? { ...protocol, requestPath: 'metadata.payment.request', selectionPath: 'metadata.payment.selection', requestSchema: z.toJSONSchema(paPaymentRequestSchema.omit({ownerDigest:true,configurationDigest:true})) } : protocol); });
  mountMemberRoutes(app, config, members, loginProvider, security?.permissions);
  runtime.messaging?.mountMembers(app);
  mountAgentRoutes(app, config, members, verify ?? createVerifier(config), security?.permissions, config.authority ? req => ({ config: ingress.config(req), verify: ingress.verify(req), route: ingress.selected(req)! }) : undefined, messaging);
  if (messaging) app.get('/.well-known/eigos-communications', (_req, res) => res.json({ version: 1, schema: 'eigos.agent-communication/1',
    tools: Object.keys(MESSAGING_TOOLS), scopes: MESSAGING_SCOPES, permissions_url: `${config.PUBLIC_URL}/members/communications`,
    operationPath: '/communication', delivery: 'pull', custody: 'eigos-service', businessTasks: 'explicit_delegation_only' }));
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource/a2a'], (req, res) => {
    if (config.EIGOS_AUTH_MODE !== 'jwt') { res.status(404).json({ error: 'oauth_not_configured', mode: 'local-development' }); return; }
    res.json(protectedResourceMetadata(ingress.config(req)));
  });

  const authenticate: RequestHandler = async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    try {
      if (!match?.[1]) throw new Error('Missing token');
      const bearer = match[1];
      const verified = await ingress.verify(req)(match[1]);
      const admitted = config.authority ? ingress.principal(req, verified) : inviteBetaPrincipal(config, verified);
      if (!admitted) { res.status(403).json({ error: 'client_not_admitted', membership_url: `${config.PUBLIC_URL}/members` }); return; }
      const principal = { ...admitted, scopes: [...admitted.scopes] };
      const rpcPath = req.originalUrl.split('?')[0]!;
      const intent = messaging ? communicationIntent(rpcPath, ['GET', 'DELETE'].includes(req.method) ? undefined : req.body) : undefined;
      let messagingOnly = false;
      if (security) {
        try {
          if (config.authority) {
            const route = ingress.selected(req)!;
            if (route.nativeClientIds.includes(principal.clientId)) {
              await members.authorize(principal);
              const member = (await members.find(principal))!;
              const claims = z.object({ exp: z.number() }).parse(decodeJwt(match[1]));
              await members.agents.authorizeNative(principal, member.id, match[1], claims.exp * 1000);
            } else if (!route.agentClientIds.includes(principal.clientId)) throw new SecurityError('AUTHORIZATION_REQUIRED');
          } else if (principal.clientId !== config.OIDC_AGENT_CLIENT_ID) throw new SecurityError('AUTHORIZATION_REQUIRED');
          const messageIdentity = async () => {
            if (!principal.scopes.some(scope => (MESSAGING_SCOPES as readonly string[]).includes(scope))) throw new MessagingError('MESSAGING_AUTHORIZATION_REQUIRED');
            const identity = await messaging!.identity(principal, bearer);
            messagingIdentities.set(req, identity); delete principal.access; messagingOnly = true;
          };
          if (intent === 'call') {
            const required = communicationScope(rpcPath, req.body);
            if (!principal.scopes.includes(required)) {
              res.setHeader('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${required}"`);
              res.status(403).json({ error: 'insufficient_scope', scope: required, onboarding_url: `${config.PUBLIC_URL}/.well-known/eigos-agent-registration` }); return;
            }
            await messageIdentity();
          } else {
            try { principal.access = await security.authenticate(principal, match[1]); }
            catch (error) {
              if (intent !== 'discovery' || !principal.scopes.some(scope => (MESSAGING_SCOPES as readonly string[]).includes(scope))) throw error;
              await messageIdentity();
            }
            if (intent === 'discovery' && messaging && principal.scopes.some(scope => (MESSAGING_SCOPES as readonly string[]).includes(scope))) {
              messagingIdentities.set(req, await messaging.identity(principal, match[1]));
            }
          }
        } catch(error) {
          const guidance = { onboarding_url: `${ingress.config(req).PUBLIC_URL}/.well-known/eigos-agent-registration`, permissions_url: `${config.PUBLIC_URL}/members/permissions` };
          if (error instanceof MessagingError) res.status(error.status).json({ error: error.code, permissions_url: `${config.PUBLIC_URL}/members/communications` });
          else if(error instanceof SecurityError) res.status(error.reason==='AUTHORITY_UNAVAILABLE'||error.reason==='REVOCATION_PENDING'?503:403).json({error:error.reason,...guidance,...securityErrorResponse(error,config.PUBLIC_URL)});
          else if(error instanceof AgentAccessError||error instanceof MemberAccessError) res.status(403).json({error:error.code,...guidance});
          else if(error instanceof DomainError) res.status(403).json({error:error.code});
          else next(error);
          return;
        }
      } else if (config.EIGOS_AUTH_MODE === 'jwt') {
        if (principal.clientId === config.OIDC_AGENT_CLIENT_ID) {
          try { await members.agents.authorize(principal, match[1]); }
          catch (error) {
            if (error instanceof AgentAccessError || error instanceof DomainError) res.status(403).json({ error: error instanceof AgentAccessError ? error.code : 'agent_registration_required', onboarding_url: `${config.PUBLIC_URL}/.well-known/eigos-agent-registration` });
            else next(error);
            return;
          }
        }
        try { await members.authorize(principal); }
        catch (error) {
          if (error instanceof MemberAccessError) res.status(403).json({ error: error.code, membership_url: `${config.PUBLIC_URL}/members`, ...(config.OIDC_AGENT_CLIENT_ID ? { onboarding_url: `${config.PUBLIC_URL}/.well-known/eigos-agent-registration` } : {}) });
          else next(error);
          return;
        }
      }
      principals.set(req, principal);
      Object.assign(req, { auth: { token: match[1], clientId: principal.clientId, scopes: principal.scopes,
        extra: { principal, ...(messagingIdentities.has(req) ? { messagingIdentity: messagingIdentities.get(req), messagingOnly } : {}) } } });
      next();
    } catch {
      const discovery = config.EIGOS_AUTH_MODE === 'jwt' ? `, resource_metadata="${ingress.config(req).PUBLIC_URL}/.well-known/oauth-protected-resource"` : '';
      res.setHeader('WWW-Authenticate', `Bearer realm="eigos", error="invalid_token"${discovery}`);
      res.status(401).json({ error: 'invalid_token', ...(config.OIDC_AGENT_CLIENT_ID ? { onboarding_url: `${config.PUBLIC_URL}/.well-known/eigos-agent-registration` } : {}) });
    }
  };

  if (!security) runtime.legacy?.mount(app,authenticate,req=>principals.get(req)!);
  relay?.mount(app,authenticate,req=>principals.get(req)!);
  if (messaging) app.post('/communication', authenticate, async (req, res) => {
    try {
      const input = communicationRequestSchema.parse(req.body), identity = messagingIdentities.get(req);
      if (!identity) throw new MessagingError('MESSAGING_AUTHORIZATION_REQUIRED');
      res.json(await messaging.execute(identity, input.operation));
    } catch (error) {
      if (error instanceof MessagingError) res.status(error.status).json({ error: error.code });
      else res.status(error instanceof z.ZodError ? 400 : 503).json({ error: error instanceof z.ZodError ? 'INVALID_INPUT' : 'MESSAGING_UNAVAILABLE' });
    }
  });
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
  app.post('/ontology/vectors/sync',authenticate,async(req,res,next)=>{
    try{
      if(!runtime.vectors){res.status(503).json({error:'AUTHORITY_UNAVAILABLE',message:'The reviewed task vector extension is not installed'});return;}
      res.json(await runtime.vectors.sync(principals.get(req)!,req.body));
    }catch(error){
      if(error instanceof z.ZodError){res.status(400).json({error:'invalid_vector_input'});return;}
      if(error instanceof DomainError){res.status(error.code==='FORBIDDEN'?403:error.code==='INVALID_INPUT'?400:409).json({error:error.code,message:error.message,...securityAdvice(error)});return;}
      next(error);
    }
  });
  for (const operation of ['describe', 'query', 'evaluate','check-access'] as const) app.post(`/ontology/${operation}`, authenticate, async (req, res, next) => {
    try {
      const p = principals.get(req)!;
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
      const reader = operation === 'describe' ? undefined : network?.ontologyReader(p, token);
      res.json(await (operation === 'describe' ? tasks.describeOntology(p, req.body) : operation === 'query' ? tasks.queryOntology(p, req.body, reader) : operation === 'check-access' ? tasks.checkAccess(p,req.body) : tasks.evaluateOntology(p, req.body, reader)));
    } catch (error) {
      if (error instanceof DomainError) { res.status(error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : 409).json({ error: error.code, message: error.message, ...securityAdvice(error) }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_ontology_input' }); return; }
      next(error);
    }
  });

  const taskHttp=(action:(req:Request)=>unknown):RequestHandler=>async(req,res,next)=>{
    try {res.json(await action(req));} catch(error) {
      if(error instanceof DomainError){res.status(error.code==='FORBIDDEN'?403:error.code==='NOT_FOUND'?404:error.code==='INVALID_INPUT'?400:409).json({error:error instanceof SecurityError?error.reason:error.code,...securityAdvice(error)});return;}
      if(error instanceof z.ZodError){res.status(400).json({error:'invalid_task_input'});return;} next(error);
    }
  };
  app.get('/tasks',authenticate,taskHttp(async req=>{const found=await tasks.list(principals.get(req)!,z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(1_000_000).default(0)}).parse(req.query));return {...found,jobs:found.jobs.map(taskSummary)};}));
  app.get('/tasks/:taskId',authenticate,taskHttp(async req=>taskSummary(await tasks.get(principals.get(req)!,String(req.params.taskId)))));
  app.post('/tasks',authenticate,taskHttp(async req=>taskSummary(await tasks.submit(principals.get(req)!,req.body))));
  app.post('/tasks/:taskId/reply',authenticate,taskHttp(async req=>taskSummary(await tasks.reply(principals.get(req)!,{...req.body,taskId:String(req.params.taskId)}))));
  app.post('/tasks/:taskId/cancel',authenticate,taskHttp(async req=>{z.strictObject({}).parse(req.body);return taskSummary(await tasks.cancel(principals.get(req)!,String(req.params.taskId)));}));
  app.get('/tasks/:taskId/artifacts/:artifactId',authenticate,async(req,res,next)=>{
    try {
      const artifact=await tasks.downloadArtifact(principals.get(req)!,String(req.params.taskId),String(req.params.artifactId));
      res.set({'Content-Type':artifact.mediaType,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Disposition':`attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`}).send(artifact.content);
    } catch(error) {
      if(error instanceof DomainError){res.status(error.code==='NOT_FOUND'?404:403).json({error:error instanceof SecurityError?error.reason:error.code,...securityAdvice(error)});return;}
      if(error instanceof z.ZodError){res.status(400).json({error:'invalid_artifact'});return;}next(error);
    }
  });

  // Application authorization channel, separate from A2A messages. No raw credentials in task parts.
  app.post('/tasks/:taskId/authorize', authenticate, async (req, res, next) => {
    try { res.json({ task: taskSummary(await tasks.authorize(principals.get(req)!, String(req.params.taskId), req.body)) }); }
    catch (error) {
      if (error instanceof DomainError) { res.status(error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : 409).json({ error: error.code, message: error.message, ...securityAdvice(error) }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_authorization' }); return; }
      next(error);
    }
  });
  for (const action of ['reconcile', 'revoke-authorization', 'aftersales'] as const) app.post(`/tasks/:taskId/${action}`, authenticate, async (req, res, next) => {
    try {
      const p = principals.get(req)!; const id = String(req.params.taskId);
      const task = action === 'aftersales' ? tasks.requestRemediation(p, { ...req.body, originalTaskId: id })
        : action === 'reconcile' ? tasks.reconcile(p, id, z.object({ requestId: z.string().min(1).max(128) }).strict().parse(req.body).requestId)
        : tasks.revokeAuthorization(p, id, z.object({ requestId: z.string().min(1).max(128) }).strict().parse(req.body).requestId);
      res.json({ task: taskSummary(await task) });
    } catch (error) {
      if (error instanceof DomainError) { res.status(error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : 409).json({ error: error.code, message: error.message, ...securityAdvice(error) }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_business_action' }); return; } next(error);
    }
  });

  const mcp = createMcpHandler(ctx => createMcpServer(tasks, principalSchema.parse(ctx.authInfo?.extra?.principal), network ? { service: network, token: ctx.authInfo?.token ?? '' } : undefined, sources ? { service: sources, token: ctx.authInfo?.token ?? '' } : undefined, !security && config.EIGOS_INVITE_BETA === 'true' ? undefined : definitions,
    { payment: config.EIGOS_INVITE_BETA !== 'true', runtime: runtimeIdentity, externalDrafts: !!config.EIGOS_SHOPIFY_CHECKOUT_MERCHANTS?.length,
      ...(messaging && ctx.authInfo?.extra?.messagingIdentity ? { messaging: { service: messaging, identity: ctx.authInfo.extra.messagingIdentity as MessagingIdentity }, messagingOnly: ctx.authInfo.extra.messagingOnly === true } : {}) }), {
    legacy: 'stateless', maxSubscriptions: 0,
  });
  const handleMcp = toNodeHandler(mcp);
  app.all('/mcp', authenticate, async (req, res) => { await handleMcp(req, res, req.body); });

  const a2a = new A2AGateway(tasks, agentCard(config, tasks.services()), messaging);
  app.get('/.well-known/agent-card.json', async (req, res) => { res.json(AgentCard.toJSON(config.authority ? agentCard(ingress.config(req), tasks.services()) : await a2a.getAgentCard())); });
  const a2aScopes: Record<string, Scope> = {
    SendMessage: 'tasks:write', SendStreamingMessage: 'tasks:write',
    GetTask: 'tasks:read', ListTasks: 'tasks:read', SubscribeToTask: 'tasks:read', CancelTask: 'tasks:write',
  };
  app.use('/a2a', authenticate, (req, res, next) => {
    const scope = messaging && communicationIntent('/a2a', req.body) === 'call' ? communicationScope('/a2a', req.body) : a2aScopes[req.body?.method];
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
      return new AgentUser(p, messagingIdentities.get(req));
    },
  }));

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    const status = error?.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: status === 500 ? 'internal_error' : 'invalid_request' });
  };
  app.use(errors);
  let starting:Promise<void>|undefined,closing:Promise<void>|undefined;
  const start=()=>starting??=(async()=>{await runtime.start();})();
  const close=()=>closing??=(async()=>{const errors:unknown[]=[];for(const action of [()=>tasks.close(),()=>mcp.close(),()=>runtime.close()]){try{await action();}catch(error){errors.push(error);}}if(errors.length)throw new AggregateError(errors,'Gateway shutdown failed');})();
  return {app,tasks,members,definitions,security,relay,messaging,scopes:SCOPES,start,close,onUnavailable:(handler:()=>void)=>security?.onUnavailable(handler)};
}

function assertHttpConfiguration(config:Config){
  if(config.EIGOS_CSV_PILOT==='true'&&(process.env.NODE_ENV==='production'||!['127.0.0.1','localhost','::1'].includes(config.HOST)||!['127.0.0.1','localhost','[::1]'].includes(new URL(config.PUBLIC_URL).hostname)))throw new Error('CSV simulation requires non-production loopback');
  if(config.EIGOS_NETWORK_ENABLED==='true'&&(config.EIGOS_AUTH_MODE!=='jwt'||!config.OIDC_AGENT_CLIENT_ID||!config.OIDC_CLIENT_ID||!config.EIGOS_NETWORK_MEMBER_IDS.length))throw new Error('Network requires explicit JWT and enrolled-member configuration');
}

/** Awaited assembly of already bound PostgreSQL ports. This selects no URL,
 * credential, model or alternate authority. Missing installed features stop
 * startup; this factory never opens a SQLite store to fill a gap. */
export async function createPostgresApp(config:Config,runtime:GatewayRuntimePorts,options:{verify?:VerifyToken;loginProvider?:LoginProvider;verifierFactory?:(config:Config)=>VerifyToken}={}):Promise<GatewayApplication>{
  assertHttpConfiguration(config);
  if(runtime.backend!=='postgres'||!config.authority||config.EIGOS_AUTH_MODE!=='jwt'||config.EIGOS_SECURITY_MODE!=='foundation'||config.EIGOS_DEV_TOKEN)throw new Error('PostgreSQL Gateway requires the existing primary JWT authority');
  const expected={id:config.authority.id,revision:config.authority.revision,digest:runtimeAuthorityDigest(config.authority)};
  if(digest(runtime.authority??null)!==digest(expected))throw new Error('Gateway ports do not match the existing primary authority');
  if(runtime.legacy||config.EIGOS_NETWORK_ENABLED==='true')throw new Error('PostgreSQL Gateway has no installed legacy network/source-route adapter');
  if(!runtime.tasks?.secured||!runtime.security||!runtime.definitions?.secured)throw new Error('PostgreSQL Gateway requires task, member permission and definition adapters');
  if(config.EIGOS_POSTGRES_VECTOR_FEATURE_FILE&&!runtime.vectors||runtime.vectors&&typeof runtime.vectors.sync!=='function')throw new Error('Configured task vectors require their actual PostgreSQL adapter');
  if(!!config.EIGOS_TASK_RELAY_FILE!==!!runtime.relay)throw new Error('Configured Task Relay requires its installed PostgreSQL adapter');
  if((config.EIGOS_MESSAGING_ENABLED==='true')!==!!runtime.messaging)throw new Error('Configured messaging requires its installed PostgreSQL adapter');
  for(const method of ['describeOntology','queryOntology','evaluateOntology','checkAccess','usage','submit','get','getAfterWait','wait','list','reply','amend','resume','authorize','selectPaymentRoute','reportPayment','cancel','reconcile','revokeAuthorization','requestRemediation','prepareObservationContract','downloadArtifact','close','services'] as const){
    if(typeof runtime.tasks[method]!=='function')throw new Error(`PostgreSQL task adapter is missing ${method}`);
  }
  for(const method of ['query','command','prepare','approve'] as const)if(typeof runtime.definitions[method]!=='function')throw new Error(`PostgreSQL definition adapter is missing ${method}`);
  for(const method of ['find','get','list','login','apply','update','setStatus','createSession','session','logout','connections','authorizationFacts','block','authorize'] as const)if(typeof runtime.members?.[method]!=='function')throw new Error(`PostgreSQL member adapter is missing ${method}`);
  for(const method of ['create','get','list','lookup','status','requireOwner','bind','authorize','ensureNativeInstallation','authorizeNative','revoke','invite','revokeInvitation','redeem','redeemForMember'] as const)if(typeof runtime.members.agents?.[method]!=='function')throw new Error(`PostgreSQL registration adapter is missing ${method}`);
  for(const method of ['managementView','grants','sourceProfiles','recoveries','recoveryPreview','approveAgentGrant','approveSource','approveTaskGrant','approveRecovery','revokeSource','revokeGrant','revokeInstallation','setConnectionBlocked','agentGrant','applyPermissionReview'] as const)if(typeof runtime.security.permissions?.[method]!=='function')throw new Error(`PostgreSQL permission adapter is missing ${method}`);
  for(const method of ['authenticate','available','onUnavailable'] as const)if(typeof runtime.security[method]!=='function')throw new Error(`PostgreSQL security adapter is missing ${method}`);
  for(const method of ['authorityCurrent','ontologyRelease','start','close'] as const)if(typeof runtime[method]!=='function')throw new Error(`PostgreSQL runtime is missing ${method}`);
  if(runtime.relay)for(const method of ['status','mount'] as const)if(typeof runtime.relay[method]!=='function')throw new Error(`PostgreSQL Task Relay adapter is missing ${method}`);
  if(runtime.messaging){
    if(typeof runtime.messaging.mountMembers!=='function')throw new Error('PostgreSQL messaging adapter is missing member routes');
    for(const method of ['identity','execute','readiness'] as const)if(typeof runtime.messaging.service?.[method]!=='function')throw new Error(`PostgreSQL messaging adapter is missing ${method}`);
  }
  const gateway=createGatewayHttpApp(config,runtime,options.verify,options.loginProvider,options.verifierFactory);
  try{await gateway.start();return gateway;}catch(error){try{await gateway.close();}catch(closeError){throw new AggregateError([error,closeError],'PostgreSQL Gateway startup failed',{cause:error});}throw error;}
}

/** The host selects one configured runtime factory. SQLite remains the default
 * until the reviewed host binding explicitly supplies PostgreSQL assembly. */
export async function createGateway(config:Config,factory:GatewayApplicationFactory=createApp):Promise<GatewayApplication>{return factory(config);}
