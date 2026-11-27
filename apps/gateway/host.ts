import { once } from 'node:events';
import { FunctionInvocations, functionInvocationsQuery } from '../../packages/runtime/function-invocations.js';
import { ComponentFunctions } from '../../packages/runtime/component-functions.js';
import {Applications} from '../../packages/runtime/applications.js';
import { ontologyServices } from '../../packages/runtime/services.js';
import express, { type Request } from 'express';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { AgentCard } from '@a2a-js/sdk';
import type { InstalledRuntime } from '../../packages/runtime/installation.js';
import { z } from 'zod';
import { Conflict, digest, InvalidInput, NotFound, PermissionDenied, requireScope, type Principal } from '../../packages/core/identity.js';
import type { Config } from '../../packages/core/config.js';
import { actionRequestSchema as actionInput, functionRequestSchema as functionInput, completeWithActionRequestSchema, type ActionCall } from '../../packages/ontology/invocation.js';
import { withoutExternalDispatch } from '../../packages/runtime/external-operations.js';
import { Access } from '../../packages/runtime/access.js';
import { checkAgentCapability, discoverOntology, discoveryOptions, ontologyIndex } from '../../packages/runtime/agent-catalogue.js';
import { Database, type Sql } from '../../packages/runtime/database.js';
import { Metadata, type PublishedOntology } from '../../packages/runtime/metadata.js';
import { Objects, querySchema } from '../../packages/runtime/objects.js';
import { Scenarios, createScenarioSchema } from '../../packages/runtime/scenarios.js';
import { PARequests, paDispatchClaimSchema, paResponseSchema, paInboxSchema } from '../../packages/runtime/pa.js';
import { Tasks, submitSchema, routeInputSchema, publicTask as projectTask, taskPlaceAmendmentSchema, placeSelectionSchema, taskInputAnswerSchema, type Task } from '../../packages/runtime/tasks.js';
import { verifier, type VerifyToken } from './auth.js';
import { Accounts, accountTaskScopes, agentTokenPattern, type Denial } from '../../packages/runtime/accounts.js';
import { A2A, AgentUser, agentCard } from './a2a.js';
import { publicError } from './public-error.js';
import { CodeMode, codeModeInput } from './code-mode.js';
import { startMcpTiming } from './mcp-timing.js';
import { developmentSandboxEnabled } from '../../packages/core/sandbox-mode.js';

const queryInput = z.strictObject({ ontology:z.string().optional(), taskId: z.uuid().optional(), scenarioId: z.uuid().optional(), query: querySchema });
const mcpDescription = 'Without arguments it returns a compact index of resource names by kind. Use query to find up to 16 resources by name or description, then names to read exact contracts.';
const discoverySchema = discoveryOptions.extend({ ontology: z.string().optional() });
const scenarioCreateInput = createScenarioSchema.safeExtend({ ontology: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(80).optional() });
/** What an agent is told when an account token is refused. English, for machine clients; the reason code is the stable part. */
const refusal: Record<Denial, string> = {
  signup_closed: 'EIGOS sign-up is closed',
  invite_required: 'Sign in on the account page to join the EIGOS waiting list. Access opens after review.',
  operator_account: 'Operator accounts use their existing client',
  account_suspended: 'This EIGOS account is suspended',
  client_not_allowed: 'This client is not allowed for EIGOS accounts',
  client_not_authorized: 'Authorize this client on the EIGOS account page',
  insufficient_scope: 'The token is missing tasks:read or tasks:write',
};

export interface BusinessAdapter {
  card: AgentCard;
  profile(app: express.Express): void;
  mountPortal(app: express.Express, members: Accounts): void;
  mountWorkbench(app: express.Express): void;
  instructions(member: boolean, quoteOnly: boolean): string;
  submitDescription: string;
  taskRead(name: string): boolean;
  validateQuote(model: PublishedOntology, action: string): void;
  mountTasks(app: express.Express, tasks: Tasks, metadata: Metadata, principal: (request: Request) => Principal,
    publicTask: (task: Task) => unknown): void;
  registerTools(context: { server: McpServer; tasks: Tasks; metadata: Metadata; p: Principal; member: boolean; quoteOnly: boolean;
    response: (operation: () => Promise<unknown>) => Promise<CallToolResult>; authorize: (client: Sql) => Promise<void>;
    publicTask: (task: Task) => unknown; completeQuote: (input: z.infer<typeof completeWithActionRequestSchema>) => Promise<unknown> }): void;
}
export function createHostApp(config: Config, db: Database, capabilities: InstalledRuntime, ontologyId: string,
  verify: VerifyToken = verifier({ ...config, OAUTH_MEMBER_MCP_CLIENT_ID: undefined }), business?: BusinessAdapter) {
  if (db.sandboxEnabled && !developmentSandboxEnabled({ ...config, NODE_ENV: process.env.NODE_ENV }))
    throw new Error('Gateway sandbox requires explicit loopback development configuration');
  const app = express(), metadata = new Metadata(db, ontologyId), tasks = new Tasks(db, metadata);
  const publicTask = (task: Task) => projectTask(task, capabilities.projectTaskResult);
  const scenarios = new Scenarios(db), pa = new PARequests(tasks);
  const principals = new WeakMap<Request, Principal>();
  const memberRequests = new WeakSet<Request>();
  const agentTokenHashes = new WeakMap<Request, string>();
  const mcpTiming = new WeakMap<Request, ReturnType<typeof startMcpTiming>>();
  const memberClient = business && config.OAUTH_MEMBER_MCP_CLIENT_ID;
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
  app.post('/mcp', (req, res, next) => {
    mcpTiming.set(req, startMcpTiming(res));
    next();
  });
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
  business?.profile(app);
  const card = business?.card ?? agentCard(config.PUBLIC_URL, { name: ontologyId, description: 'Published ' + ontologyId + ' services', skills: capabilities.publicSkills ?? [] });
  app.get('/.well-known/agent-card.json', (_req, res) => res.json(AgentCard.toJSON(card)));
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({ resource: config.PUBLIC_URL, authorization_servers: config.OAUTH_ISSUER ? [config.OAUTH_ISSUER] : [], bearer_methods_supported: ['header'] }));
  if (members) app.get(mcpMetadataPath, (_req, res) => res.json({
    resource: mcpResource, authorization_servers: [config.OAUTH_ISSUER],
    scopes_supported: accountTaskScopes, bearer_methods_supported: ['header'],
  }));
  if (members) {
    business!.mountPortal(app, members);
    app.get('/', (_req, res) => res.redirect(302, '/account'));
  }
  business?.mountWorkbench(app);
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
  const codeMode = new CodeMode();
  app.post('/ontology/services/:operation',async(req,res)=>{
    const {_ontology,...input}=z.record(z.string(),z.unknown()).parse(req.body);
    const name=_ontology===undefined?ontologyId:z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(80).parse(_ontology);
    const selected=name===ontologyId?services:ontologyServices(db,metadata,capabilities,capabilities.functions,capabilities.effects,capabilities.actions,name);
    const service=selected.get(String(req.params.operation));
    if(!service)throw new NotFound('Ontology service is unavailable');
    res.json(await service.invoke(principal(req),input));
  });
  const modelFor = async (p: Principal, taskId?: string, scenarioId?: string, access?: Access, ontology = ontologyId) => {
    const task = taskId ? await tasks.get(p, taskId) : undefined;
    if (task && access) access.observeClassification(task.input.classification);
    const model = task ? await metadata.get(task.release) : await metadata.active(ontology);
    return scenarioId ? scenarios.view(access ?? await Access.load(db,p),model,scenarioId) : model;
  };
  const confirmReadAccess = async (access: Access) => {
    if (!await access.canReturn(access.dataRequirements())) throw new PermissionDenied('Result permissions changed');
  };
  const query = async (p: Principal, raw: unknown) => {
    requireScope(p, p.memberAccess ? 'tasks:read' : 'ontology:read'); const input = queryInput.parse(raw);
    const access = await Access.load(db, p), result = await new Objects(db, await modelFor(p, input.taskId, input.scenarioId,undefined,input.ontology), access).query(input.query);
    await confirmReadAccess(access);
    return result;
  };
  const evaluate = async (p: Principal, raw: unknown, stream?: {send:(text:string)=>Promise<void>;signal:AbortSignal}) => {
    const input = functionInput.parse(raw);
    const liveTravelReminder = business?.taskRead(input.function) &&
      !input.taskId && !input.scenarioId && (input.ontology === undefined || input.ontology === 'Eigos');
    // Existing PA clients carry task scopes. These two reads still use the published Function,
    // source, object, and row permissions of the authenticated owner.
    if (!liveTravelReminder || !p.scopes.includes('tasks:read')) requireScope(p, 'ontology:read');
    const access = await Access.load(db, p), model = await modelFor(p, input.taskId, input.scenarioId,access,input.ontology);
    access.function(model,input.function);
    if (stream && !model.functions.get(input.function)?.implementation?.stream) throw new InvalidInput('This Function has no published stream');
    const result = await capabilities.functions.invoke(model, input.function, input.input, { principal: p, objects: new Objects(db, model, access),
      signal: stream?.signal ?? AbortSignal.timeout(30000), onChunk:stream?.send });
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
    if (quoteOnly) business!.validateQuote(model, selected.action);
    const complete = () => capabilities.actions.complete(
      access, model, selected, input.requestId, input.read, undefined, AbortSignal.timeout(30000),
    );
    const result = await (quoteOnly ? withoutExternalDispatch(complete) : complete());
    if (!await access.canReturn(access.dataRequirements())) throw new PermissionDenied('Result permissions changed');
    return result;
  };
  const scenarioCreate = async (p: Principal, raw: unknown) => { requireScope(p,'ontology:write'); const {ontology,...input}=scenarioCreateInput.parse(raw);return scenarios.create(await Access.load(db,p),await metadata.active(ontology),input); };
  const scenarioRead = async (p: Principal, id: string,ontology=ontologyId) => { requireScope(p,'ontology:read'); return scenarios.inspect(await Access.load(db,p),await metadata.active(ontology),id); };
  const scenarioList = async (p: Principal,cursor?:string,ontology=ontologyId) => { requireScope(p,'ontology:read'); return scenarios.list(await Access.load(db,p),await metadata.active(ontology),cursor); };
  const scenarioDiscard = async (p: Principal, id: string, revision: number,ontology=ontologyId) => { requireScope(p,'ontology:write'); return scenarios.discard(await Access.load(db,p),await metadata.active(ontology),id,revision); };
  app.post('/ontology/scenarios', async (req,res)=>res.json(await scenarioCreate(principal(req),req.body)));
  app.get('/ontology/scenarios', async (req,res)=>res.json(await scenarioList(principal(req),typeof req.query.cursor==='string'?req.query.cursor:undefined,typeof req.query.ontology==='string'?req.query.ontology:ontologyId)));
  app.get('/ontology/scenarios/:id', async (req,res)=>res.json(await scenarioRead(principal(req),String(req.params.id),typeof req.query.ontology==='string'?req.query.ontology:ontologyId)));
  app.post('/ontology/scenarios/:id/discard', async (req,res) => {
    const { revision, ontology } = z.object({ revision: z.number().int().positive(), ontology: z.string().optional() }).parse(req.body);
    res.json(await scenarioDiscard(principal(req), String(req.params.id), revision, ontology));
  });
  // A component for component Functions, which a definition branch then refers to by SHA-256. The function host checks it.
  app.post('/ontology/function-artifacts',express.raw({type:'application/wasm',limit:'16mb'}),async(req,res)=>{
    const p=principal(req);requireScope(p,'ontology:write');
    if (!Buffer.isBuffer(req.body)) throw new InvalidInput('A component body must use application/wasm');
    const ontology=typeof req.query.ontology==='string'?req.query.ontology:ontologyId;
    (await Access.load(db,p)).require(ontology,'edit_definition',ontology);
    res.json(await new ComponentFunctions(db).upload(req.body,p));
  });
  app.post('/ontology/media',express.raw({type:'application/octet-stream',limit:'20mb'}),async(req,res)=>{
    const p=principal(req);requireScope(p,'ontology:write');
    if (!Buffer.isBuffer(req.body)) throw new InvalidInput('Media body must use application/octet-stream');
    const header = (value: unknown) => {
      try { return decodeURIComponent(String(value)); }
      catch { throw new InvalidInput('Invalid media header encoding'); }
    };
    const model=await metadata.active(typeof req.query.ontology==='string'?req.query.ontology:ontologyId);
    res.json(await new Applications(db).upload(await Access.load(db,p),model,capabilities.actions,req.body,{
      name: header(req.headers['x-asset-name']??''),
      format: String(req.headers['x-asset-format']??''),
      units: header(req.headers['x-asset-units']??'file units'),
    }));
  });
  app.get('/ontology/media/:id',async(req,res)=>{
    const p=principal(req);requireScope(p,'ontology:read');
    const model=await metadata.active(typeof req.query.ontology==='string'?req.query.ontology:ontologyId),access=await Access.load(db,p);
    const file=await new Applications(db).download(access,model,String(req.params.id));
    if(!await access.canReturn(access.dataRequirements()))throw new PermissionDenied('Model permissions changed');
    res.setHeader('Cache-Control','no-store');res.type('application/octet-stream').send(file.bytes);
  });
  app.post('/tasks/:id/pa-dispatch-claim', async (req,res)=>{
    res.set('Cache-Control','no-store').json(await pa.claimDispatch(principal(req),String(req.params.id),req.body));
  });
  app.post('/tasks/:id/pa-response', async (req,res)=>res.json(publicTask(await pa.respond(principal(req),String(req.params.id),req.body))));
  app.get('/pa/requests',async(req,res)=>res.json(await pa.pending(principal(req),{...(typeof req.query.cursor==='string'?{cursor:req.query.cursor}:{}),...(typeof req.query.limit==='string'?{limit:Number(req.query.limit)}:{})})));
  app.get('/identity', (req, res) => {
    const { owner, scopes, clientId } = principal(req);
    res.json({ owner, scopes, clientId });
  });
  app.post('/tasks', async (req, res) => res.json(publicTask(await tasks.submit(principal(req), req.body))));
  app.get('/tasks/:id', async (req, res) => res.json(publicTask(await tasks.get(principal(req), String(req.params.id)))));
  app.post('/tasks/:id/cancel', async (req, res) => res.json(publicTask(await tasks.cancel(principal(req), String(req.params.id)))));
  business?.mountTasks(app, tasks, metadata, principal, publicTask);
  app.get('/ontology',async(req,res)=>{const p=principal(req);requireScope(p,'ontology:read');const ontology=typeof req.query.ontology==='string'?req.query.ontology:ontologyId;res.json((await Access.load(db,p)).describe(await metadata.active(ontology)));});
  app.post('/ontology/query', async (req, res) => res.json(await query(principal(req), req.body)));
  app.post('/ontology/functions', async (req, res) => {
    if (!req.get('accept')?.split(',').some(type=>type.split(';')[0]?.trim()==='text/event-stream'))
      return res.json(await evaluate(principal(req),req.body));
    const closed=new AbortController(), signal=AbortSignal.any([closed.signal,AbortSignal.timeout(30000)]);
    res.once('close',()=>closed.abort());
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    const write = async (event:unknown) => {
      signal.throwIfAborted();
      if (!res.write('data: '+JSON.stringify(event)+'\n\n')) await once(res,'drain',{signal});
    };
    try {
      const result=await evaluate(principal(req),req.body,{signal,send:text=>write({type:'chunk',text})});
      await write({type:'result',value:result});
      res.end();
    } catch (error) {
      if (!res.headersSent) { res.removeHeader('Content-Type'); throw error; }
      if (!res.destroyed) res.end('data: {"type":"error"}\n\n');
    }
  });
  app.get('/ontology/function-invocations', async (req, res) => {
    const p = principal(req);
    requireScope(p, 'ontology:read');
    const input = functionInvocationsQuery.parse(req.query);
    const model = await metadata.active(input.ontology);
    res.json(await new FunctionInvocations(db).list(await Access.load(db, p), model, input));
  });
  app.post('/ontology/actions', async (req, res) => res.json(await apply(principal(req), req.body)));
  app.get('/mcp', (_req, res) => res.set('Allow', 'POST').sendStatus(405));
  app.post('/mcp', async (req, res) => {
    const p = principal(req), member = memberRequests.has(req);
    const matchesOperator = (binding?: string) => !!business && !member && !p.memberAudience && p.clientId &&
      p.scopes.includes('tasks:read') && binding === `${p.clientId}:${p.owner}`;
    const readScope = p.scopes.includes('ontology:read');
    const quoteOnly = !!business && !member && accountTaskScopes.every(scope => p.scopes.includes(scope)) &&
      !(p.scopes.includes('ontology:read') && p.scopes.includes('ontology:write'));
    const taskInstructions = business?.instructions(member, quoteOnly) ?? 'Keep the original task ID for PA replies.';
    const canExecuteCode = member || (!p.memberAudience && readScope);
    const canSubmitCode = !member && canExecuteCode && ['ontology:write', ...accountTaskScopes].every(scope => p.scopes.includes(scope));
    const instructions = [
      taskInstructions,
      canExecuteCode ? 'For multiple Ontology reads with joins, pagination, or filtering, use execute_ontology and return a compact result. Discover exact contracts with describe_ontology. Use query_ontology for a single read or as a fallback.' : '',
      canSubmitCode ? 'To combine reads and submit one published Action, use execute_ontology_action with a stable requestId. Follow its original task with get_task and respond to any PA request outside the script.' : '',
    ].filter(Boolean).join(' ');
    const server = new McpServer({ name: business ? 'eigos' : ontologyId, version: '0.2.0' }, { instructions });
    const timing = mcpTiming.get(req)?.(req.body, p.clientId);
    const response = async (operation: () => Promise<unknown>) => {
      timing?.start();
      try {
        const result = await (timing ? timing.run(operation) : operation()), text = JSON.stringify(result);
        timing?.succeed(result);
        return { content: [{ type: 'text' as const, text }] };
      }
      catch (error) {
        const { status, message, requestId } = publicError(error);
        timing?.fail(status);
        return { isError: true,
          content: [{ type: 'text' as const, text: requestId ? `${message} (request ID: ${requestId})` : message }],
          structuredContent: { status, error: message, ...(requestId ? { requestId } : {}) },
        };
      }
    };
    const describe = async ({ ontology, query, names }: z.infer<typeof discoverySchema>) => {
      if (!member && !readScope) {
        const operatorCatalog = (ontology ?? 'Eigos') === 'Eigos' && matchesOperator(config.EIGOS_MCP_OPERATOR_CATALOG);
        if (!operatorCatalog) requireScope(p, 'ontology:read');
      }
      if (query && names) throw new InvalidInput('Provide either query or names');
      const access = await Access.load(db, p), model = await metadata.active(ontology);
      if (!member && !readScope) access.require('Eigos', 'view_definition', 'Eigos');
      const document = access.describe(model, member);
      return query || names ? discoverOntology(model, document, { query, names }) : ontologyIndex(model, document);
    };
    const serve = async () => {
      const streams = req.body?.method === 'tools/call' && req.body?.params?.name === 'stream_ontology_function';
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !streams });
      await server.connect(transport);
      res.on('close', () => { void server.close(); });
      await transport.handleRequest(req, res, req.body);
    };
    business?.registerTools({ server, tasks, metadata, p, member, quoteOnly, response, publicTask, authorize: authorizeMemberSubmission(req),
      completeQuote: input => completeWithAction(req, input, true) });
    const runCode = async (code: string, requestId?: string) => {
      requireScope(p, member ? 'tasks:read' : 'ontology:read');
      if (requestId !== undefined)
        for (const scope of ['ontology:write', ...accountTaskScopes]) requireScope(p, scope);
      const cancel = new AbortController();
      const disconnected = () => cancel.abort(new InvalidInput('Code Mode request ended'));
      res.once('close', disconnected);
      if (res.destroyed) disconnected();
      try {
        cancel.signal.throwIfAborted();
        const access = await Access.load(db, p), model = await metadata.active();
        const graph = new Objects(db, model, access);
        let stagedAction: ActionCall | undefined;
        const value = await codeMode.execute(code, async input => {
          const page = await graph.query(input);
          await confirmReadAccess(access);
          return page;
        }, cancel.signal, requestId === undefined ? undefined : input => { stagedAction = input; });
        await confirmReadAccess(access);
        if (requestId === undefined) return value;
        const action = stagedAction;
        if (!action) throw new InvalidInput('Call and await applyAction() to submit a published Action');
        const task = await tasks.submit(p, { requestId, message: 'Execute the selected published Action' }, {
          actionInvocation: { action }, expectedRelease: model.release,
          authorize: async client => {
            cancel.signal.throwIfAborted();
            if (!await access.canReturn(access.dataRequirements(), client)) throw new PermissionDenied('Result permissions changed');
          },
          admit: async (client, release) => {
            cancel.signal.throwIfAborted();
            const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(30_000)]);
            const selected = await capabilities.actions.validateSubmission(access, release, action, client, signal);
            checkAgentCapability(release, db.sandboxEnabled, 'action', selected);
            if (!await access.canReturn(access.dataRequirements(), client)) throw new PermissionDenied('Result permissions changed');
          },
        });
        return { value, task: publicTask(task) };
      } finally { res.removeListener('close', disconnected); }
    };
    if (canExecuteCode) server.registerTool('execute_ontology', {
      description: 'Run an async JavaScript function for read-only composition against the live Ontology. query accepts the inner query_ontology object directly and returns { items, cursor }. Await every query and return a compact JSON value. Supports up to 12 reads against one live release.',
      inputSchema: codeModeInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, ({ code }) => response(() => runCode(code)));
    if (canSubmitCode) server.registerTool('execute_ontology_action', {
      description: 'Use async ({ query, applyAction }) => { ... } to compose reads and stage one published Action. Pass {action, input} or {interface, input} as in apply_ontology_action. Await applyAction and return a JSON value. The Action task is submitted only after the script succeeds. Keep requestId stable on retry and read task.id with get_task. Follow user confirmation outside the script.',
      inputSchema: codeModeInput.extend({ requestId: submitSchema.shape.requestId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, ({ code, requestId }) => response(() => runCode(code, requestId)));
    if (member) {
      server.registerTool('claim_task_dispatch', {
        description: 'Claim the one-time dispatch grant for a pending authorized PA operation. Preserve the returned token privately and include it with the response for this dispatch.',
        inputSchema: z.strictObject({ taskId: z.uuid(), ...paDispatchClaimSchema.shape }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      }, ({ taskId, ...input }) => response(() =>
        pa.claimDispatch(p, taskId, input, authorizeMemberSubmission(req))));
      const memberSubmit = submitSchema.pick({ requestId: true, message: true, conversationId: true });
      const queueAction = async (requestId: string, ontology: string | undefined, action: ActionCall,
        read?: z.infer<typeof completeWithActionRequestSchema>['read']) => {
        if (ontology && ontology !== 'Eigos' || action.scenarioId) throw new PermissionDenied('Account Actions use the live Eigos Ontology');
        return publicTask(await tasks.submit(p, { requestId, message: 'Execute the selected published Action' }, {
          actionInvocation: { action, read }, authorize: authorizeMemberSubmission(req),
        }));
      };
      server.registerTool('describe_ontology', {
        description: 'Discover the published business capabilities available to this account. ' + mcpDescription,
        inputSchema: discoverySchema.extend({ ontology: z.literal('Eigos').optional() }),
      }, input => response(() => describe(input)));
      server.registerTool('query_ontology', {
        description: 'Read authorized Eigos objects and links for this account.',
        inputSchema: queryInput.pick({ query: true }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      }, input => response(() => query(p, input)));
      server.registerTool('apply_ontology_action', {
        description: 'Start a task for a published Action. Use the returned task ID for status and authorization.',
        inputSchema: actionInput,
      }, ({ requestId, ontology, ...action }) => response(() => queueAction(requestId, ontology, action)));
      server.registerTool('complete_with_action', {
        description: 'Start a task for a published Interface Action and a result Function. Use the returned task ID for status and authorization.',
        inputSchema: completeWithActionRequestSchema,
      }, ({ requestId, ontology, action, read }) => response(() => queueAction(requestId, ontology, action, read)));
      server.registerTool('respond_to_task', {
        description: 'Return the original PA response using the request ID and schema reported by get_task.',
        inputSchema: z.strictObject({ taskId: z.uuid(), ...paResponseSchema.shape }),
      }, ({ taskId, ...answer }) => response(async () => publicTask(await pa.respond(p, taskId, answer, undefined, authorizeMemberSubmission(req)))));
      server.registerTool('submit_task', {
        description: 'Submit a business request once and preserve the returned task ID.',
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
        if (!readScope && operation.invokeForMcpOperator && matchesOperator(config.EIGOS_MCP_OPERATOR_MACHINERY))
          return operation.invokeForMcpOperator(p, args);
        return operation.invoke(p, args);
      }));
    }
    server.registerTool('submit_task', { description: business?.submitDescription ?? 'Submit a goal to the installed Ontology.', inputSchema: business ? submitSchema : submitSchema.pick({ requestId: true, message: true, conversationId: true, classification: true }) }, input => response(async () => publicTask(await tasks.submit(p, input))));
    server.registerTool('get_task', { description: 'Read your original task, result or PA information request.', inputSchema: z.strictObject({ taskId: z.uuid() }) }, input => response(async () => publicTask(await tasks.get(p, input.taskId))));
    server.registerTool('respond_to_task', { description:'Supply the authenticated PA response to the original task information request. Use the responseSchema returned with that request.',inputSchema:z.strictObject({taskId:z.uuid(),...paResponseSchema.shape}) }, input=>response(async()=>publicTask(await pa.respond(p,input.taskId,{requestId:input.requestId,response:input.response,dispatchToken:input.dispatchToken}))));
    server.registerTool('list_pa_requests',{description:'Read your pending PA requests. Preserve returned taskId and requestId when replying. Follow cursor for subsequent pages.',inputSchema:paInboxSchema},input=>response(()=>pa.pending(p,input)));
    server.registerTool('create_scenario', { description:'Create an isolated what-if view over the selected Ontology.',inputSchema:scenarioCreateInput }, input=>response(()=>scenarioCreate(p,input)));
    server.registerTool('list_scenarios', { description:'List your open scenarios in the selected Ontology; follow cursor for the next page.',inputSchema:z.strictObject({ontology:z.string().optional(),cursor:z.uuid().optional()}) }, input=>response(()=>scenarioList(p,input.cursor,input.ontology)));
    server.registerTool('inspect_scenario', { description:'Read a scenario revision, proposed object/link changes and object conflicts in the selected Ontology.',inputSchema:z.strictObject({ontology:z.string().optional(),scenarioId:z.uuid()}) }, input=>response(()=>scenarioRead(p,input.scenarioId,input.ontology)));
    server.registerTool('discard_scenario', { description:'Discard the exact reviewed scenario revision in the selected Ontology.',inputSchema:z.strictObject({ontology:z.string().optional(),scenarioId:z.uuid(),revision:z.number().int().positive()}) }, input=>response(()=>scenarioDiscard(p,input.scenarioId,input.revision,input.ontology)));
    server.registerTool('query_ontology', { description: 'Query object sets using an Object Type or Interface and its property and link names.', inputSchema: queryInput }, input => response(() => query(p, input)));
    server.registerTool('stream_ontology_function', { description:'Read an authorized streaming Function; text chunks are sent as MCP progress and the final result is returned.',inputSchema:functionInput },
      (input,ctx) => response(async () => {
        const token=ctx.mcpReq._meta?.progressToken;
        if (typeof token!=='string' && typeof token!=='number') throw new InvalidInput('Supply an MCP progress token for streamed output');
        let progress=0;
        return evaluate(p,input,{signal:AbortSignal.any([ctx.mcpReq.signal,AbortSignal.timeout(30000)]),
          send:message=>ctx.mcpReq.notify({method:'notifications/progress',params:{progressToken:token,progress:++progress,message}})});
      }));
    server.registerTool('evaluate_ontology', { description: 'Invoke a published Function using the declared input.', inputSchema: functionInput }, input => response(() => evaluate(p, input)));
    server.registerTool('apply_ontology_action', { description: 'Submit a published Action through its declared parameters and submission criteria.', inputSchema: actionInput }, input => response(() => apply(p, input)));
    if (!quoteOnly) server.registerTool('complete_with_action', {
      description: 'Execute a published Interface Action and return its result through a published read Function. Bind the committed reference to read.resultParameter. Retry with the same requestId to read the result afresh. Use submit_task for requests that require clarification.',
      inputSchema: completeWithActionRequestSchema,
    }, input => response(() => completeWithAction(req, input)));
    server.registerTool('describe_ontology', {
      description: 'Discover published Ontology resources. ' + mcpDescription,
      inputSchema: discoverySchema,
    }, input => response(() => describe(input)));
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
