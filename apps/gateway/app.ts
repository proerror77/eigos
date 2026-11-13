import {mountWorkbench} from './workbench.js';
import {Applications} from '../../packages/runtime/applications.js';
import type { RuntimeExtensions } from '../../packages/runtime/extensions.js';
import { ontologyServices } from '../../packages/runtime/services.js';
import { Effects } from '../../packages/runtime/effects.js';
import express, { type Request } from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { AgentCard } from '@a2a-js/sdk';
import { z } from 'zod';
import { Conflict, NotFound, requireScope, type Principal } from '../../packages/core/identity.js';
import type { Config } from '../../packages/core/config.js';
import { objectRefSchema } from '../../packages/ontology/schema.js';
import { Access } from '../../packages/runtime/access.js';
import { Database } from '../../packages/runtime/database.js';
import { Metadata } from '../../packages/runtime/metadata.js';
import { Objects, querySchema } from '../../packages/runtime/objects.js';
import { Scenarios, createScenarioSchema } from '../../packages/runtime/scenarios.js';
import { PARequests, paResponseSchema,paInboxSchema } from '../../packages/runtime/pa.js';
import { Tasks, submitSchema, publicTask, placeSelectionSchema } from '../../packages/runtime/tasks.js';
import { createCapabilities } from '../../packages/capabilities/index.js';
import { configuredServices } from '../../packages/capabilities/services/sources.js';
import type { SourceResolver } from '../../packages/capabilities/didi/functions.js';
import { verifier, type VerifyToken } from './auth.js';
import { A2A, AgentUser, agentCard } from './a2a.js';

const queryInput = z.strictObject({ ontology:z.string().optional(), taskId: z.uuid().optional(), scenarioId: z.uuid().optional(), query: querySchema });
const scenarioCreateInput = createScenarioSchema.safeExtend({ ontology: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(80).optional() });
const functionInput = z.strictObject({ ontology:z.string().optional(), taskId: z.uuid().optional(), scenarioId: z.uuid().optional(), function: z.string(), input: z.record(z.string(), z.unknown()) });
const actionInput = z.strictObject({ ontology:z.string().optional(), scenarioId: z.uuid().optional(), requestId: z.string().min(1).max(128), action: z.string().optional(),
  interface: z.strictObject({ object: objectRefSchema.optional(), implementation: z.string().optional(), type: z.string(), action: z.string() })
    .refine(value => !!value.object !== !!value.implementation, 'Select an object or implementing Object Type').optional(), input: z.record(z.string(), z.unknown()) })
  .refine(value => !!value.action !== !!value.interface, 'Select an Action or an Interface Action');

export function createApp(config: Config, db: Database, source: SourceResolver, verify: VerifyToken = verifier(config), extensions: RuntimeExtensions = {}) {
  const app = express(), metadata = new Metadata(db), tasks = new Tasks(db, metadata), capabilities = createCapabilities(db, source, extensions, configuredServices(config.EIGOS_SERVICE_CONNECTION_FILE));
  const scenarios = new Scenarios(db), pa = new PARequests(tasks);
  const principals = new WeakMap<Request, Principal>();
  app.disable('x-powered-by');
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
  const card = agentCard(config.PUBLIC_URL);
  app.get('/.well-known/agent-card.json', (_req, res) => res.json(AgentCard.toJSON(card)));
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({ resource: config.PUBLIC_URL, authorization_servers: config.OAUTH_ISSUER ? [config.OAUTH_ISSUER] : [], bearer_methods_supported: ['header'] }));
  mountWorkbench(app,config);
  app.use(async (req, res, next) => {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    try { if (!token) throw new Error(); principals.set(req, await verify(token)); next(); }
    catch { res.setHeader('WWW-Authenticate', 'Bearer'); res.status(401).json({ error: 'Authentication required' }); }
  });
  const principal = (req: Request) => principals.get(req)!;
  const services=ontologyServices(db,metadata,capabilities,capabilities.functions,new Effects(db,extensions.effects??new Map()),capabilities.actions);
  app.post('/ontology/services/:operation',async(req,res)=>{
    const {_ontology,...input}=z.record(z.string(),z.unknown()).parse(req.body);
    const name=_ontology===undefined?'Eigos':z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(80).parse(_ontology);
    const selected=name==='Eigos'?services:ontologyServices(db,metadata,capabilities,capabilities.functions,new Effects(db,extensions.effects??new Map()),capabilities.actions,name);
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
    if(!await access.canReturn(access.dataRequirements()))throw new Error('Result permissions changed');
    return result;
  };
  const evaluate = async (p: Principal, raw: unknown) => {
    requireScope(p, 'ontology:read');
    const input = functionInput.parse(raw), model = await modelFor(p, input.taskId, input.scenarioId,undefined,input.ontology), access = await Access.load(db, p);
    const result = await capabilities.functions.invoke(model, input.function, input.input, { principal: p, objects: new Objects(db, model, access), signal: AbortSignal.timeout(30000) });
    if(!await access.canReturn(access.dataRequirements()))throw new Error('Result permissions changed');
    return result;
  };
  const apply = async (p: Principal, raw: unknown) => {
    requireScope(p, 'ontology:write');
    const input = actionInput.parse(raw), access = await Access.load(db, p), model = await modelFor(p,undefined,input.scenarioId,access,input.ontology);
    const target = input.interface;
    if (target) { access.definition(model, 'interface', target.type); access.definition(model, 'object', target.implementation ?? target.object!.type); }
    const selected = target ? target.object ? model.resolveAction(target.object, target.type, target.action, input.input)
      : model.resolveTypeAction(target.implementation!, target.type, target.action, input.input) : { action: input.action!, input: input.input };
    return capabilities.actions.apply(access, model, selected.action, selected.input, input.requestId);
  };
  const scenarioCreate = async (p: Principal, raw: unknown) => { requireScope(p,'ontology:write'); const {ontology,...input}=scenarioCreateInput.parse(raw);return scenarios.create(await Access.load(db,p),await metadata.active(ontology),input); };
  const scenarioRead = async (p: Principal, id: string,ontology='Eigos') => { requireScope(p,'ontology:read'); return scenarios.inspect(await Access.load(db,p),await metadata.active(ontology),id); };
  const scenarioList = async (p: Principal,cursor?:string,ontology='Eigos') => { requireScope(p,'ontology:read'); return scenarios.list(await Access.load(db,p),await metadata.active(ontology),cursor); };
  const scenarioDiscard = async (p: Principal, id: string, revision: number,ontology='Eigos') => { requireScope(p,'ontology:write'); return scenarios.discard(await Access.load(db,p),await metadata.active(ontology),id,revision); };
  app.post('/ontology/scenarios', async (req,res)=>res.json(await scenarioCreate(principal(req),req.body)));
  app.get('/ontology/scenarios', async (req,res)=>res.json(await scenarioList(principal(req),typeof req.query.cursor==='string'?req.query.cursor:undefined,typeof req.query.ontology==='string'?req.query.ontology:'Eigos')));
  app.get('/ontology/scenarios/:id', async (req,res)=>res.json(await scenarioRead(principal(req),String(req.params.id),typeof req.query.ontology==='string'?req.query.ontology:'Eigos')));
  app.post('/ontology/scenarios/:id/discard', async (req,res)=>res.json(await scenarioDiscard(principal(req),String(req.params.id),req.body.revision,typeof req.body.ontology==='string'?req.body.ontology:'Eigos')));
  app.post('/ontology/media',express.raw({type:'application/octet-stream',limit:'20mb'}),async(req,res)=>{
    const p=principal(req);requireScope(p,'ontology:write');
    const model=await metadata.active(typeof req.query.ontology==='string'?req.query.ontology:'Eigos');
    res.json(await new Applications(db).upload(await Access.load(db,p),model,capabilities.actions,req.body,{name:decodeURIComponent(String(req.headers['x-asset-name']??'')),format:String(req.headers['x-asset-format']??''),units:decodeURIComponent(String(req.headers['x-asset-units']??'file units'))}));
  });
  app.get('/ontology/media/:id',async(req,res)=>{
    const p=principal(req);requireScope(p,'ontology:read');
    const model=await metadata.active(typeof req.query.ontology==='string'?req.query.ontology:'Eigos'),access=await Access.load(db,p);
    const file=await new Applications(db).download(access,model,String(req.params.id));
    if(!await access.canReturn(access.dataRequirements()))throw new Error('Model permissions changed');
    res.setHeader('Cache-Control','no-store');res.type('application/octet-stream').send(file.bytes);
  });
  app.post('/tasks/:id/pa-response', async (req,res)=>res.json(publicTask(await pa.respond(principal(req),String(req.params.id),req.body))));
  app.get('/pa/requests',async(req,res)=>res.json(await pa.pending(principal(req),{...(typeof req.query.cursor==='string'?{cursor:req.query.cursor}:{}),...(typeof req.query.limit==='string'?{limit:Number(req.query.limit)}:{})})));
  app.get('/identity', (req, res) => res.json(principal(req)));
  app.post('/tasks', async (req, res) => res.json(publicTask(await tasks.submit(principal(req), req.body))));
  app.get('/tasks/:id', async (req, res) => res.json(publicTask(await tasks.get(principal(req), String(req.params.id)))));
  app.post('/tasks/:id/cancel', async (req, res) => res.json(publicTask(await tasks.cancel(principal(req), String(req.params.id)))));
  app.post('/tasks/:id/places', async (req, res) => res.json(publicTask(await tasks.selectPlaces(principal(req), String(req.params.id), req.body))));
  app.get('/ontology',async(req,res)=>{const p=principal(req);requireScope(p,'ontology:read');const ontology=typeof req.query.ontology==='string'?req.query.ontology:'Eigos';res.json((await Access.load(db,p)).describe(await metadata.active(ontology)));});
  app.post('/ontology/query', async (req, res) => res.json(await query(principal(req), req.body)));
  app.post('/ontology/functions', async (req, res) => res.json(await evaluate(principal(req), req.body)));
  app.post('/ontology/actions', async (req, res) => res.json(await apply(principal(req), req.body)));
  app.post('/mcp', async (req, res) => {
    const p = principal(req), server = new McpServer({ name: 'eigos', version: '0.2.0' });
    const response = async (operation: () => Promise<unknown>) => {
      try { const result = await operation(); return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Request failed' }] }; }
    };
    for(const [name,service] of services) server.registerTool('ontology_'+name,{description:service.description,inputSchema:(service.schema as z.ZodObject).safeExtend({_ontology:z.string().optional()})},input=>response(()=>{const {_ontology,...args}=input;const selected=_ontology?ontologyServices(db,metadata,capabilities,capabilities.functions,new Effects(db,extensions.effects??new Map()),capabilities.actions,z.string().parse(_ontology)):services;return selected.get(name)!.invoke(p,args);}));
    server.registerTool('submit_task', { description: 'Submit an inquiry or calendar-backed planning request. PA information requests resume on the original task.', inputSchema: submitSchema }, input => response(async () => publicTask(await tasks.submit(p, input))));
    server.registerTool('get_task', { description: 'Read your original task, result or PA information request.', inputSchema: z.strictObject({ taskId: z.uuid() }) }, input => response(async () => publicTask(await tasks.get(p, input.taskId))));
    server.registerTool('select_task_places', { description: 'Select source-returned endpoints for a task waiting for clarification.', inputSchema: z.strictObject({ taskId: z.uuid(), places: placeSelectionSchema }) }, input => response(async () => publicTask(await tasks.selectPlaces(p, input.taskId, input.places))));
    server.registerTool('respond_to_task', { description:'Supply the authenticated PA response to the original task information request. Use the responseSchema returned with that request.',inputSchema:z.strictObject({taskId:z.uuid(),...paResponseSchema.shape}) }, input=>response(async()=>publicTask(await pa.respond(p,input.taskId,{requestId:input.requestId,response:input.response}))));
    server.registerTool('list_pa_requests',{description:'Read your pending PA requests, including scheduled event and ride executions. Preserve returned taskId and requestId when replying. Follow cursor for subsequent pages.',inputSchema:paInboxSchema},input=>response(()=>pa.pending(p,input)));
    server.registerTool('create_scenario', { description:'Create an isolated what-if view over the selected Ontology.',inputSchema:scenarioCreateInput }, input=>response(()=>scenarioCreate(p,input)));
    server.registerTool('list_scenarios', { description:'List your open scenarios in the selected Ontology; follow cursor for the next page.',inputSchema:z.strictObject({ontology:z.string().optional(),cursor:z.uuid().optional()}) }, input=>response(()=>scenarioList(p,input.cursor,input.ontology)));
    server.registerTool('inspect_scenario', { description:'Read a scenario revision, proposed object/link changes and object conflicts in the selected Ontology.',inputSchema:z.strictObject({ontology:z.string().optional(),scenarioId:z.uuid()}) }, input=>response(()=>scenarioRead(p,input.scenarioId,input.ontology)));
    server.registerTool('discard_scenario', { description:'Discard the exact reviewed scenario revision in the selected Ontology.',inputSchema:z.strictObject({ontology:z.string().optional(),scenarioId:z.uuid(),revision:z.number().int().positive()}) }, input=>response(()=>scenarioDiscard(p,input.scenarioId,input.revision,input.ontology)));
    server.registerTool('query_ontology', { description: 'Query object sets using an Object Type or Interface and its property and link names.', inputSchema: queryInput }, input => response(() => query(p, input)));
    server.registerTool('evaluate_ontology', { description: 'Invoke a published Function.', inputSchema: functionInput }, input => response(() => evaluate(p, input)));
    server.registerTool('apply_ontology_action', { description: 'Submit a published Action through its declared parameters and submission criteria.', inputSchema: actionInput }, input => response(() => apply(p, input)));
    server.registerTool('describe_ontology', { description: 'Read published types, properties, interfaces, links, functions and actions.', inputSchema: z.strictObject({ontology:z.string().optional()}) }, input => response(async () => { requireScope(p, 'ontology:read'); return (await Access.load(db, p)).describe(await metadata.active(input.ontology)); }));
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    res.on('close', () => { void server.close(); });
    await transport.handleRequest(req, res, req.body);
  });
  app.use('/a2a', jsonRpcHandler({ requestHandler: new A2A(tasks, card), userBuilder: async req => new AgentUser(principal(req)) }));
  app.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof NotFound ? 404 : error instanceof Conflict ? 409 : error instanceof z.ZodError ? 400 : 403;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Request failed' });
  });
  return { app, tasks, metadata, capabilities };
}
