import { SHOPIFY_AGENT_PROFILE_PATH, shopifyCatalogProfile } from '../../packages/capabilities/shopify/read-only.js';
import {mountWorkbench} from './workbench.js';
import {Applications} from '../../packages/runtime/applications.js';
import type { RuntimeExtensions } from '../../packages/runtime/extensions.js';
import { ontologyServices } from '../../packages/runtime/services.js';
import express, { type Request } from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { AgentCard } from '@a2a-js/sdk';
import { z } from 'zod';
import { Conflict, digest, InvalidInput, NotFound, PermissionDenied, requireScope, type Principal } from '../../packages/core/identity.js';
import type { Config } from '../../packages/core/config.js';
import { restaurantSearchInput, restaurantVenueType, restaurantVenueRecord, visitInput } from '../../packages/ontology/restaurant-services.js';
import { actionRequestSchema as actionInput, functionRequestSchema as functionInput, completeWithActionRequestSchema } from '../../packages/ontology/invocation.js';
import { withoutExternalDispatch } from '../../packages/runtime/external-operations.js';
import { Access } from '../../packages/runtime/access.js';
import { Database, type Sql } from '../../packages/runtime/database.js';
import { Metadata, type PublishedOntology } from '../../packages/runtime/metadata.js';
import { Objects, querySchema } from '../../packages/runtime/objects.js';
import { Scenarios, createScenarioSchema } from '../../packages/runtime/scenarios.js';
import { PARequests, paResponseSchema,paInboxSchema } from '../../packages/runtime/pa.js';
import { HotelWorkflows, hotelApprovalSchema } from '../../packages/capabilities/services/hotel-workflows.js';
import { amendMapPlace } from '../../packages/capabilities/amap/task-correction.js';
import { Tasks, submitSchema, routeInputSchema, publicTask as projectTask, taskPlaceAmendmentSchema, placeSelectionSchema, taskInputAnswerSchema, type Task } from '../../packages/runtime/tasks.js';
import { configuredCapabilities } from '../../packages/capabilities/index.js';
import type { SourceResolver } from '../../packages/capabilities/didi/functions.js';
import { verifier, type VerifyToken } from './auth.js';
import { mountAccountPortal, type auth0AccountLogin } from './account-portal.js';
import { auth0Management, type Auth0Management } from './auth0-management.js';
import { Accounts, accountTaskScopes, agentTokenPattern, type Denial } from '../../packages/runtime/accounts.js';
import { A2A, AgentUser, agentCard } from './a2a.js';
import { publicError } from './public-error.js';
import { developmentSandboxEnabled } from '../../packages/core/sandbox-mode.js';

const queryInput = z.strictObject({ ontology:z.string().optional(), taskId: z.uuid().optional(), scenarioId: z.uuid().optional(), query: querySchema });
const scenarioCreateInput = createScenarioSchema.safeExtend({ ontology: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(80).optional() });
const rideQuoteRequestSchema = completeWithActionRequestSchema.pick({ requestId: true }).extend({
  ontology: z.literal('Eigos').optional(),
  action: z.strictObject({
    interface: z.strictObject({ type: z.literal('RideInquiry'), action: z.literal('estimate'), implementation: z.literal('RideRequest') }),
    input: routeInputSchema,
  }),
  read: z.strictObject({ function: z.literal('readRideEstimates'), resultParameter: z.literal('request') }),
});
const rideQuoteInstructions = 'For fare-only queries with a known city and confirmed pickup and destination, call complete_with_action directly in the current conversation and deliver the quote as soon as it returns. Pass the confirmed venue names. If the Action needs a more specific place, ask for it before retrying. Use submit_task for general or incomplete travel requests.';

const paTravelInstructions = [
  'For user-authorized travel reminders, keep the object reference from StartCalendarJourney or StartFlightWatch.',
  'Use your own PA notification capability and the channel selected by the user. EIGOS owns travel scheduling and computes notices.',
  'When EIGOS sends a travel_reminder event, use its authoritative reference, version, and operation. Keep only the newest version and withdraw pending notices on withdraw.',
  'Use readCalendarJourney, readFlightWatch or readDidiRideWatch via evaluate_ontology for independent readback with the original typed reference.',
  'If EIGOS requests calendar.journey.read, respond to the original taskId and requestId with only the required source fields.',
  'Withdraw pending notifications when the current reminder or alert is null. Discard expired calendar timing using validUntil.',
  'Report notification delivery only after your PA channel confirms it.',
].join(' ');

/** What an agent is told when an account token is refused. English, for machine clients; the reason code is the stable part. */
const refusal: Record<Denial, string> = {
  signup_closed: 'EIGOS sign-up is closed',
  invite_required: 'Redeem an EIGOS invitation on the account page first',
  operator_account: 'Operator accounts use their existing client',
  account_suspended: 'This EIGOS account is suspended',
  client_not_allowed: 'This client is not allowed for EIGOS accounts',
  client_not_authorized: 'Authorize this client on the EIGOS account page',
  insufficient_scope: 'The token is missing tasks:read or tasks:write',
};

export function createApp(config: Config, db: Database, source: SourceResolver, verify: VerifyToken = verifier(config), extensions: RuntimeExtensions = {},
  providerFetch: { amapFetch?: typeof fetch; variFlightFetch?: typeof fetch; calendarFetch?: typeof fetch; travelPAFetch?: typeof fetch;
    dianpingFetch?: typeof fetch; tableCheckFetch?: typeof fetch; marketplaceFetch?: typeof fetch; localDeliveryFetch?: typeof fetch;
    accountLogin?: ReturnType<typeof auth0AccountLogin>; management?: Auth0Management } = {}) {
  if (db.sandboxEnabled && !developmentSandboxEnabled({ ...config, NODE_ENV: process.env.NODE_ENV }))
    throw new Error('Gateway sandbox requires explicit loopback development configuration');
  const { accountLogin, management, ...sourceFetch } = providerFetch;
  const app = express(), metadata = new Metadata(db), tasks = new Tasks(db, metadata);
  const capabilities = configuredCapabilities(db, config, extensions, source, sourceFetch);
  const publicTask = (task: Task) => projectTask(task, capabilities.projectTaskResult);
  const scenarios = new Scenarios(db), pa = new PARequests(tasks);
  const hotelWorkflows = new HotelWorkflows(db, metadata, capabilities.functions);
  const principals = new WeakMap<Request, Principal>();
  const memberRequests = new WeakSet<Request>();
  const agentTokenHashes = new WeakMap<Request, string>();
  const memberClient = config.OAUTH_MEMBER_MCP_CLIENT_ID;
  const members = memberClient ? new Accounts(db, config.EIGOS_SIGNUP) : undefined;
  const existingClients = config.OAUTH_EXISTING_CLIENT_IDS?.split(',') ?? [];
  const mcpResource = config.PUBLIC_URL + '/mcp';
  const mcpMetadataPath = '/.well-known/oauth-protected-resource/mcp';
  const challenge = members
    ? `Bearer resource_metadata="${config.PUBLIC_URL + mcpMetadataPath}", scope="${accountTaskScopes.join(' ')}"`
    : `Bearer resource_metadata="${config.PUBLIC_URL}/.well-known/oauth-protected-resource"`;
  const insufficientScope = `Bearer error="insufficient_scope", scope="${accountTaskScopes.join(' ')}", resource_metadata="${config.PUBLIC_URL + mcpMetadataPath}"`;
  app.disable('x-powered-by');
  // Behind a reverse proxy, `req.ip` (the per-address rate limits) is the forwarded client only if the proxy is trusted.
  if (config.EIGOS_TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(config.EIGOS_TRUST_PROXY) ? Number(config.EIGOS_TRUST_PROXY) : config.EIGOS_TRUST_PROXY);
  // Published domain definitions can exceed the ordinary task/query body bound.
  app.use(['/mcp','/ontology/services'],express.json({limit:'2mb'}));
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    if (req.headers.origin && req.headers.origin !== config.PUBLIC_URL) { res.status(403).json({ error: 'Origin is not permitted' }); return; }
    if (req.hostname !== new URL(config.PUBLIC_URL).hostname) { res.status(403).json({ error: 'Host is not configured' }); return; }
    next();
  });
  app.get('/health', async (_req, res) => {
    const model = await metadata.active(); metadata.checkBindings(model, capabilities);
    res.json({ status: 'ok', backend: 'postgres', sourceCommit: config.EIGOS_SOURCE_COMMIT, ontologyRelease: model.release, definitionDigest: model.digest, implementationDigest: db.runtimeId });
  });
  app.get(SHOPIFY_AGENT_PROFILE_PATH, (_req, res) => res.json(shopifyCatalogProfile()));
  const card = agentCard(config.PUBLIC_URL);
  app.get('/.well-known/agent-card.json', (_req, res) => res.json(AgentCard.toJSON(card)));
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({ resource: config.PUBLIC_URL, authorization_servers: config.OAUTH_ISSUER ? [config.OAUTH_ISSUER] : [], bearer_methods_supported: ['header'] }));
  if (members) app.get(mcpMetadataPath, (_req, res) => res.json({
    resource: mcpResource, authorization_servers: [config.OAUTH_ISSUER],
    scopes_supported: accountTaskScopes, bearer_methods_supported: ['header'],
  }));
  if (members) {
    mountAccountPortal(app, config, members, accountLogin, management ?? auth0Management(config));
    app.get('/', (_req, res) => res.redirect(302, '/account'));
  }
  mountWorkbench(app, config, verify);
  app.use(async (req, res, next) => {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    let verified: Principal | undefined;
    const agentTokenHash = members && token && agentTokenPattern.test(token) ? digest(token) : undefined;
    if (agentTokenHash) {
      const owner = await members?.agentTokenOwner(agentTokenHash);
      if (owner) {
        if (!['/mcp', '/a2a', '/a2a/', '/identity'].includes(req.path)) {
          res.status(403).json({ error: refusal.client_not_allowed, reason: 'client_not_allowed', account: '/account' });
          return;
        }
        verified = { owner, clientId: 'account-token', scopes: accountTaskScopes, memberAccess: true };
        memberRequests.add(req);
        agentTokenHashes.set(req, agentTokenHash);
      }
    } else if (token) {
      try { verified = await verify(token); } catch { /* Return the transport challenge below. */ }
    }
    if (!verified) {
      const auth = req.path === '/mcp' && config.OAUTH_ISSUER ? challenge : 'Bearer';
      res.setHeader('WWW-Authenticate', token ? auth + (auth === 'Bearer' ? ' ' : ', ') + 'error="invalid_token"' : auth);
      res.status(401).json({ error: 'Authentication required' }); return;
    }
    if (!agentTokenHash && members && memberClient) {
      const result = await members.authorize(verified, memberClient, existingClients);
      if (result.kind === 'account' && (req.path === '/mcp' || req.path === '/identity')) {
        verified = { ...verified, scopes: accountTaskScopes, memberAccess: true };
        memberRequests.add(req);
      } else if (result.kind !== 'existing') {
        const reason: Denial = result.kind === 'denied' ? result.reason : 'client_not_allowed';
        if (reason === 'insufficient_scope') res.setHeader('WWW-Authenticate', insufficientScope);
        res.status(403).json({ error: refusal[reason], reason, account: '/account' }); return;
      }
    }
    principals.set(req, verified);
    db.withOwner(verified.owner, next);
  });
  const principal = (req: Request) => principals.get(req)!;
  const authorizeMemberSubmission = (req: Request) =>
    async (client: Sql) => {
      if (!await members!.active(principal(req).owner, client, agentTokenHashes.get(req)))
        throw new PermissionDenied('This EIGOS account is suspended or its client authorization was revoked');
    };
  const services=ontologyServices(db,metadata,capabilities,capabilities.functions,capabilities.effects,capabilities.actions);
  app.post('/ontology/services/:operation',async(req,res)=>{
    const {_ontology,...input}=z.record(z.string(),z.unknown()).parse(req.body);
    const name=_ontology===undefined?'Eigos':z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(80).parse(_ontology);
    const selected=name==='Eigos'?services:ontologyServices(db,metadata,capabilities,capabilities.functions,capabilities.effects,capabilities.actions,name);
    const service=selected.get(String(req.params.operation));
    if(!service)throw new NotFound('Ontology service is unavailable');
    res.json(await service.invoke(principal(req),input));
  });
  const modelFor = async (p: Principal, taskId?: string, scenarioId?: string, access?: Access, ontology = 'Eigos') => {
    const model = await (taskId ? metadata.get((await tasks.get(p, taskId)).release) : metadata.active(ontology));
    return scenarioId ? scenarios.view(access ?? await Access.load(db,p),model,scenarioId) : model;
  };
  const query = async (p: Principal, raw: unknown) => {
    requireScope(p, 'ontology:read'); const input = queryInput.parse(raw);
    const access = await Access.load(db, p), result = await new Objects(db, await modelFor(p, input.taskId, input.scenarioId,undefined,input.ontology), access).query(input.query);
    if(!await access.canReturn(access.dataRequirements()))throw new PermissionDenied('Result permissions changed');
    return result;
  };
  const evaluate = async (p: Principal, raw: unknown) => {
    const input = functionInput.parse(raw);
    const liveTravelReminder = (input.function === 'readCalendarJourney' || input.function === 'readFlightWatch' || input.function === 'readDidiRideWatch') &&
      !input.taskId && !input.scenarioId && (input.ontology === undefined || input.ontology === 'Eigos');
    // Existing PA clients carry task scopes. These two reads still use the published Function,
    // source, object, and row permissions of the authenticated owner.
    if (!liveTravelReminder || !p.scopes.includes('tasks:read')) requireScope(p, 'ontology:read');
    const model = await modelFor(p, input.taskId, input.scenarioId,undefined,input.ontology), access = await Access.load(db, p);
    const result = await capabilities.functions.invoke(model, input.function, input.input, { principal: p, objects: new Objects(db, model, access), signal: AbortSignal.timeout(30000) });
    if(!await access.canReturn(access.dataRequirements()))throw new PermissionDenied('Result permissions changed');
    return result;
  };
  const apply = async (p: Principal, raw: unknown) => {
    requireScope(p, 'ontology:write');
    const input = actionInput.parse(raw), access = await Access.load(db, p), model = await modelFor(p,undefined,input.scenarioId,access,input.ontology);
    const selected = capabilities.actions.resolve(access, model, input);
    return capabilities.actions.apply(access, model, selected.action, selected.input, input.requestId);
  };
  const completeWithAction = async (req: Request, input: z.infer<typeof completeWithActionRequestSchema>, quoteOnly = false) => {
    const p = principal(req);
    for (const scope of quoteOnly ? accountTaskScopes : ['ontology:read', 'ontology:write']) requireScope(p, scope);
    const access = await Access.load(db, p), model = await modelFor(p, undefined, input.action.scenarioId, access, input.ontology);
    const selected = capabilities.actions.resolve(access, model, input.action);
    if (quoteOnly) {
      const action = model.action(selected.action);
      if (selected.action !== 'EstimateRide' || action.function !== 'prepareRideInquiry' || action.rules?.length || action.effects?.length)
        throw new PermissionDenied('The published quote-only Action is unavailable');
    }
    const complete = () => capabilities.actions.complete(
      access, model, selected, input.requestId, input.read, undefined, AbortSignal.timeout(30000),
      quoteOnly && memberRequests.has(req) ? { authorize: authorizeMemberSubmission(req) } : {},
    );
    const result = await (quoteOnly ? withoutExternalDispatch(complete) : complete());
    if (!await access.canReturn(access.dataRequirements())) throw new PermissionDenied('Result permissions changed');
    return result;
  };
  const scenarioCreate = async (p: Principal, raw: unknown) => { requireScope(p,'ontology:write'); const {ontology,...input}=scenarioCreateInput.parse(raw);return scenarios.create(await Access.load(db,p),await metadata.active(ontology),input); };
  const scenarioRead = async (p: Principal, id: string,ontology='Eigos') => { requireScope(p,'ontology:read'); return scenarios.inspect(await Access.load(db,p),await metadata.active(ontology),id); };
  const scenarioList = async (p: Principal,cursor?:string,ontology='Eigos') => { requireScope(p,'ontology:read'); return scenarios.list(await Access.load(db,p),await metadata.active(ontology),cursor); };
  const scenarioDiscard = async (p: Principal, id: string, revision: number,ontology='Eigos') => { requireScope(p,'ontology:write'); return scenarios.discard(await Access.load(db,p),await metadata.active(ontology),id,revision); };
  app.post('/ontology/scenarios', async (req,res)=>res.json(await scenarioCreate(principal(req),req.body)));
  app.get('/ontology/scenarios', async (req,res)=>res.json(await scenarioList(principal(req),typeof req.query.cursor==='string'?req.query.cursor:undefined,typeof req.query.ontology==='string'?req.query.ontology:'Eigos')));
  app.get('/ontology/scenarios/:id', async (req,res)=>res.json(await scenarioRead(principal(req),String(req.params.id),typeof req.query.ontology==='string'?req.query.ontology:'Eigos')));
  app.post('/ontology/scenarios/:id/discard', async (req,res) => {
    const { revision, ontology } = z.object({ revision: z.number().int().positive(), ontology: z.string().optional() }).parse(req.body);
    res.json(await scenarioDiscard(principal(req), String(req.params.id), revision, ontology));
  });
  app.post('/ontology/media',express.raw({type:'application/octet-stream',limit:'20mb'}),async(req,res)=>{
    const p=principal(req);requireScope(p,'ontology:write');
    if (!Buffer.isBuffer(req.body)) throw new InvalidInput('Media body must use application/octet-stream');
    const header = (value: unknown) => {
      try { return decodeURIComponent(String(value)); }
      catch { throw new InvalidInput('Invalid media header encoding'); }
    };
    const model=await metadata.active(typeof req.query.ontology==='string'?req.query.ontology:'Eigos');
    res.json(await new Applications(db).upload(await Access.load(db,p),model,capabilities.actions,req.body,{
      name: header(req.headers['x-asset-name']??''),
      format: String(req.headers['x-asset-format']??''),
      units: header(req.headers['x-asset-units']??'file units'),
    }));
  });
  app.get('/ontology/media/:id',async(req,res)=>{
    const p=principal(req);requireScope(p,'ontology:read');
    const model=await metadata.active(typeof req.query.ontology==='string'?req.query.ontology:'Eigos'),access=await Access.load(db,p);
    const file=await new Applications(db).download(access,model,String(req.params.id));
    if(!await access.canReturn(access.dataRequirements()))throw new PermissionDenied('Model permissions changed');
    res.setHeader('Cache-Control','no-store');res.type('application/octet-stream').send(file.bytes);
  });
  app.post('/tasks/:id/pa-response', async (req,res)=>res.json(publicTask(await pa.respond(principal(req),String(req.params.id),req.body))));
  app.get('/pa/requests',async(req,res)=>res.json(await pa.pending(principal(req),{...(typeof req.query.cursor==='string'?{cursor:req.query.cursor}:{}),...(typeof req.query.limit==='string'?{limit:Number(req.query.limit)}:{})})));
  app.get('/identity', (req, res) => {
    const { owner, scopes, clientId } = principal(req);
    res.json({ owner, scopes, clientId });
  });
  app.post('/tasks', async (req, res) => res.json(publicTask(await tasks.submit(principal(req), req.body))));
  app.post('/tasks/:id/hotel-simulation-approval', async (req, res) => {
    res.json(await hotelWorkflows.approve(principal(req), { ...req.body, taskId: req.params.id }));
  });
  app.get('/tasks/:id', async (req, res) => res.json(publicTask(await tasks.get(principal(req), String(req.params.id)))));
  app.post('/tasks/:id/cancel', async (req, res) => res.json(publicTask(await tasks.cancel(principal(req), String(req.params.id)))));
  app.post('/tasks/:id/places', async (req, res) => res.json(publicTask(await tasks.selectPlaces(principal(req), String(req.params.id), req.body))));
  app.post('/tasks/:id/input', async (req, res) =>
    res.json(publicTask(await tasks.answerInput(principal(req), String(req.params.id), req.body))));
  const amendPlace = (p: Principal, id: string, raw: unknown) => {
    const input = taskPlaceAmendmentSchema.parse(raw);
    return 'source' in input ? amendMapPlace(tasks, metadata, capabilities.functions, p, id, input) : tasks.amendPlace(p, id, input);
  };
  app.post('/tasks/:id/place-amendment', async (req, res) =>
    res.json(publicTask(await amendPlace(principal(req), String(req.params.id), req.body))));
  app.get('/ontology',async(req,res)=>{const p=principal(req);requireScope(p,'ontology:read');const ontology=typeof req.query.ontology==='string'?req.query.ontology:'Eigos';res.json((await Access.load(db,p)).describe(await metadata.active(ontology)));});
  app.post('/ontology/query', async (req, res) => res.json(await query(principal(req), req.body)));
  app.post('/ontology/functions', async (req, res) => res.json(await evaluate(principal(req), req.body)));
  app.post('/ontology/actions', async (req, res) => res.json(await apply(principal(req), req.body)));
  app.get('/mcp', (_req, res) => res.set('Allow', 'POST').sendStatus(405));
  app.post('/mcp', async (req, res) => {
    const p = principal(req), member = memberRequests.has(req);
    const quoteOnly = member || (accountTaskScopes.every(scope => p.scopes.includes(scope)) &&
      !(p.scopes.includes('ontology:read') && p.scopes.includes('ontology:write')));
    const taskInstructions = member ? 'Submit other read-only travel queries once and poll get_task with the original returned ID.' : paTravelInstructions;
    const instructions = quoteOnly ? `${rideQuoteInstructions} ${taskInstructions}` : taskInstructions;
    const server = new McpServer({ name: 'eigos', version: '0.2.0' }, { instructions });
    const response = async (operation: () => Promise<unknown>) => {
      try { const result = await operation(); return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }; }
      catch (error) {
        const { status, message, requestId } = publicError(error);
        return { isError: true,
          content: [{ type: 'text' as const, text: requestId ? `${message} (request ID: ${requestId})` : message }],
          structuredContent: { status, error: message, ...(requestId ? { requestId } : {}) },
        };
      }
    };
    const serve = async () => {
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      res.on('close', () => { void server.close(); });
      await transport.handleRequest(req, res, req.body);
    };
    const restaurantAccess = async (provider: 'Amap' | 'TableCheck') => {
      requireScope(p, 'tasks:read');
      requireScope(p, 'tasks:write');
      const access = await Access.load(db, p), model = await metadata.active('Eigos');
      access.source(model, provider);
      return { access, model };
    };
    const completeRestaurantRead = async (access: Access, model: PublishedOntology, requestId: string,
      operation: 'search' | 'availability', input: Record<string, unknown>) => {
      const contract = operation === 'search'
        ? { type: 'RestaurantDiscovery', action: 'search', implementation: 'RestaurantSearchResult',
            actionName: 'FindRestaurants', function: 'findRestaurants', read: 'readRestaurantSearch', resultParameter: 'search' }
        : { type: 'RestaurantVisitReview', action: 'review', implementation: 'RestaurantVisitOption',
            actionName: 'ReviewRestaurantVisit', function: 'reviewRestaurantVisit', read: 'readRestaurantVisit', resultParameter: 'visit' };
      const { type, action, implementation } = contract;
      const selected = capabilities.actions.resolve(access, model, { interface: { type, action, implementation }, input });
      const definition = model.action(selected.action);
      if (selected.action !== contract.actionName || definition.function !== contract.function || definition.effects?.length)
        throw new Conflict('The published restaurant query is unavailable');
      const result = await withoutExternalDispatch(() => capabilities.actions.complete(access, model, selected, requestId,
        { function: contract.read, resultParameter: contract.resultParameter }, undefined, AbortSignal.timeout(30000),
        member ? { authorize: authorizeMemberSubmission(req) } : {}));
      if (!await access.canReturn(access.dataRequirements())) throw new PermissionDenied('Result permissions changed');
      return result;
    };
    server.registerTool('search_restaurants', {
      description: 'Find Amap restaurant listings or TableCheck venues by city and keyword. Amap is the default. Preserve the returned TableCheck venue ID for an availability query.',
      inputSchema: restaurantSearchInput.pick({ city: true, query: true, limit: true })
        .extend({ requestId: submitSchema.shape.requestId, provider: z.enum(['Amap', 'TableCheck']).optional() }),
    }, ({ requestId, provider = 'Amap', ...input }) => response(async () => {
      const { access, model } = await restaurantAccess(provider);
      if (provider === 'Amap') access.function(model, 'searchMapPlaces');
      return completeRestaurantRead(access, model, requestId, 'search', { ...input, providers: [provider] });
    }));
    server.registerTool('check_restaurant_availability', {
      description: 'Read TableCheck availability for a venue returned by search_restaurants, on an exact local date and for a specified party size. Reuse the same request ID to read the original result.',
      inputSchema: visitInput.pick({ date: true, partySize: true })
        .extend({ venueId: z.string().regex(/^[a-f0-9]{64}$/), requestId: submitSchema.shape.requestId }),
    }, ({ requestId, venueId, ...input }) => response(async () => {
      const { access, model } = await restaurantAccess('TableCheck');
      const venue = { type: restaurantVenueType, id: venueId };
      const snapshot = await new Objects(db, model, access).read(venue);
      if (restaurantVenueRecord.parse(snapshot.properties).provider !== 'TableCheck')
        throw new InvalidInput('Use the venue ID returned from a TableCheck search');
      return completeRestaurantRead(access, model, requestId, 'availability', { ...input, venue, channel: 'provider' });
    }));
    if (quoteOnly) server.registerTool('complete_with_action', {
      description: 'Return a DiDi fare estimate in one call when both venues and the city are known. This call uses RideInquiry.estimate and reads its verified result.',
      inputSchema: rideQuoteRequestSchema,
    }, input => response(() => completeWithAction(req, input, true)));
    if (member) {
      const memberSubmit = submitSchema.pick({ requestId: true, message: true, conversationId: true });
      server.registerTool('submit_task', {
        description: 'Submit a read-only travel inquiry. Send the natural-language request once and preserve the returned task ID.',
        inputSchema: memberSubmit,
      }, input => response(async () => publicTask(await tasks.submit(p, input, {
        authorize: authorizeMemberSubmission(req),
      }))));
      server.registerTool('get_task', {
        description: 'Poll the same task ID for the completed result.', inputSchema: z.strictObject({ taskId: z.uuid() }),
      }, input => response(async () => publicTask(await tasks.get(p, input.taskId))));
      await serve(); return;
    }
    for (const [name, service] of services) {
      server.registerTool('ontology_' + name, {
        description: service.description, inputSchema: (service.schema as z.ZodObject).safeExtend({ _ontology: z.string().optional() }),
      }, input => response(() => {
        const { _ontology, ...args } = input;
        const selected = _ontology ? ontologyServices(db, metadata, capabilities, capabilities.functions,
          capabilities.effects, capabilities.actions, z.string().parse(_ontology)) : services;
        const operation = selected.get(name);
        if (!operation) throw new NotFound('Ontology service is unavailable');
        return operation.invoke(p, args);
      }));
    }
    server.registerTool('submit_task', { description: 'Submit a natural-language goal. To batch rapid messages, pass the same conversationId from your chat host and a distinct, stable requestId per message. Set learnHotelWorkflow when asked to learn and save a hotel itinerary, or replayHotelWorkflow with a saved ID and new date when asked to reuse one. Forward the goal without proposing tool steps. PA information requests resume on the original task.', inputSchema: submitSchema }, input => response(async () => publicTask(await tasks.submit(p, input))));
    server.registerTool('list_learned_hotel_workflows', {
      description: 'Find previously saved hotel itinerary workflows for the signed-in owner. To reuse, submit a task with the workflow ID and the new check-in date. Every proposal needs separate approval in EIGOS.',
      inputSchema: z.strictObject({}),
    }, () => response(() => hotelWorkflows.list(p)));
    server.registerTool('get_task', { description: 'Read your original task, result or PA information request.', inputSchema: z.strictObject({ taskId: z.uuid() }) }, input => response(async () => publicTask(await tasks.get(p, input.taskId))));
    server.registerTool('select_task_places', { description: 'Confirm endpoints from the original task’s current candidates. Present their formal names and addresses to the user. A PA may select a previously confirmed address; if uncertain it must ask the user.', inputSchema: z.strictObject({ taskId: z.uuid(), places: placeSelectionSchema }) }, input => response(async () => publicTask(await tasks.selectPlaces(p, input.taskId, input.places))));
    server.registerTool('supply_task_input', {
      description: 'Supply the city, pickup or destination requested by the original Action. Retry only when the task explicitly returns retry-source.',
      inputSchema: z.strictObject({ taskId: z.uuid(), answer: taskInputAnswerSchema }),
    }, input => response(async () => publicTask(await tasks.answerInput(p, input.taskId, input.answer))));
    server.registerTool('amend_task_place', {
      description: 'Continue the original task with a user-confirmed endpoint. For ride Actions use an address or landmark and pass keep if the unchanged side has multiple candidates. For an older Amap clarification use the confirmed Amap place ID, a fresh request ID and the original task updatedAt. Restore a canceled task only with specific user authorization.',
      inputSchema: z.strictObject({ taskId: z.uuid(), amendment: taskPlaceAmendmentSchema }),
    }, input => response(async () => publicTask(await amendPlace(p, input.taskId, input.amendment))));
    server.registerTool('respond_to_task', { description:'Supply the authenticated PA response to the original task information request. Use the responseSchema returned with that request.',inputSchema:z.strictObject({taskId:z.uuid(),...paResponseSchema.shape}) }, input=>response(async()=>publicTask(await pa.respond(p,input.taskId,{requestId:input.requestId,response:input.response}))));
    server.registerTool('list_pa_requests',{description:'Read your pending PA requests, including scheduled calendar journey checks, event and ride executions. Preserve returned taskId and requestId when replying. Follow cursor for subsequent pages.',inputSchema:paInboxSchema},input=>response(()=>pa.pending(p,input)));
    server.registerTool('create_scenario', { description:'Create an isolated what-if view over the selected Ontology.',inputSchema:scenarioCreateInput }, input=>response(()=>scenarioCreate(p,input)));
    server.registerTool('list_scenarios', { description:'List your open scenarios in the selected Ontology; follow cursor for the next page.',inputSchema:z.strictObject({ontology:z.string().optional(),cursor:z.uuid().optional()}) }, input=>response(()=>scenarioList(p,input.cursor,input.ontology)));
    server.registerTool('inspect_scenario', { description:'Read a scenario revision, proposed object/link changes and object conflicts in the selected Ontology.',inputSchema:z.strictObject({ontology:z.string().optional(),scenarioId:z.uuid()}) }, input=>response(()=>scenarioRead(p,input.scenarioId,input.ontology)));
    server.registerTool('discard_scenario', { description:'Discard the exact reviewed scenario revision in the selected Ontology.',inputSchema:z.strictObject({ontology:z.string().optional(),scenarioId:z.uuid(),revision:z.number().int().positive()}) }, input=>response(()=>scenarioDiscard(p,input.scenarioId,input.revision,input.ontology)));
    server.registerTool('query_ontology', { description: 'Query object sets using an Object Type or Interface and its property and link names.', inputSchema: queryInput }, input => response(() => query(p, input)));
    server.registerTool('evaluate_ontology', { description: 'Invoke a published Function. A PA managing travel reminders reads readCalendarJourney, readFlightWatch or readDidiRideWatch with the original object reference.', inputSchema: functionInput }, input => response(() => evaluate(p, input)));
    server.registerTool('apply_ontology_action', { description: 'Submit a published Action through its declared parameters and submission criteria.', inputSchema: actionInput }, input => response(() => apply(p, input)));
    if (!quoteOnly) server.registerTool('complete_with_action', {
      description: 'Execute a published Interface Action and return its result through a published read Function. Bind the committed reference to read.resultParameter. Retry with the same requestId to read the result afresh. Use submit_task for requests that require clarification.',
      inputSchema: completeWithActionRequestSchema,
    }, input => response(() => completeWithAction(req, input)));
    server.registerTool('describe_ontology', {
      description: 'Read published types, properties, interfaces, links, functions and actions.',
      inputSchema: z.strictObject({ ontology: z.string().optional() }),
    }, input => response(async () => {
      const readScope = p.scopes.includes('ontology:read');
      const operatorCatalog = !p.memberAudience && p.clientId && (input.ontology ?? 'Eigos') === 'Eigos' &&
        config.EIGOS_MCP_OPERATOR_CATALOG === `${p.clientId}:${p.owner}` && p.scopes.includes('tasks:read');
      if (!readScope && !operatorCatalog) requireScope(p, 'ontology:read');
      const access = await Access.load(db, p), model = await metadata.active(input.ontology);
      if (!readScope) access.require('Eigos', 'view_definition', 'Eigos');
      return access.describe(model);
    }));
    await serve();
  });
  app.use('/a2a', jsonRpcHandler({ requestHandler: new A2A(tasks, card, capabilities.projectTaskResult), userBuilder: async req => new AgentUser(principal(req), agentTokenHashes.has(req) ? authorizeMemberSubmission(req) : undefined) }));
  app.use((error: unknown, _req: Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(error);
    const { status, message, requestId } = publicError(error);
    res.status(status).json({ error: message, ...(requestId ? { requestId } : {}) });
  });
  return { app, tasks, metadata, capabilities };
}
