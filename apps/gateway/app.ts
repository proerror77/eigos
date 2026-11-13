import express, { type Request } from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { AgentCard } from '@a2a-js/sdk';
import { z } from 'zod';
import { Conflict, NotFound, requireScope, type Principal } from '../../packages/core/identity.js';
import type { Config } from '../../packages/core/config.js';
import { objectRefSchema } from '../../packages/ontology/schema.js';
import { Database } from '../../packages/runtime/database.js';
import { Metadata } from '../../packages/runtime/metadata.js';
import { Objects, querySchema } from '../../packages/runtime/objects.js';
import { Tasks, submitSchema, publicTask, placeSelectionSchema } from '../../packages/runtime/tasks.js';
import { RideWorkflow } from '../../packages/capabilities/didi/workflow.js';
import type { SourceResolver } from '../../packages/capabilities/didi/functions.js';
import { verifier, type VerifyToken } from './auth.js';
import { A2A, AgentUser, agentCard } from './a2a.js';

const queryInput = z.strictObject({ taskId: z.uuid().optional(), query: querySchema });
const functionInput = z.strictObject({ taskId: z.uuid().optional(), function: z.string(), input: z.record(z.string(), z.unknown()) });
const actionInput = z.strictObject({ requestId: z.string().min(1).max(128), action: z.string().optional(),
  interface: z.strictObject({ object: objectRefSchema, type: z.string(), action: z.string() }).optional(), input: z.record(z.string(), z.unknown()) })
  .refine(value => !!value.action !== !!value.interface, 'Select an Action or an Interface Action');

export function createApp(config: Config, db: Database, source: SourceResolver, verify: VerifyToken = verifier(config)) {
  const app = express(), metadata = new Metadata(db), tasks = new Tasks(db, metadata), workflow = new RideWorkflow(db, metadata, tasks, source);
  const principals = new WeakMap<Request, Principal>();
  app.disable('x-powered-by'); app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    if (req.headers.origin && req.headers.origin !== config.PUBLIC_URL) { res.status(403).json({ error: 'Origin is not permitted' }); return; }
    if (req.hostname !== new URL(config.PUBLIC_URL).hostname) { res.status(403).json({ error: 'Host is not configured' }); return; }
    next();
  });
  app.get('/health', async (_req, res) => { await metadata.active(); res.json({ status: 'ok', backend: 'postgres' }); });
  const card = agentCard(config.PUBLIC_URL);
  app.get('/.well-known/agent-card.json', (_req, res) => res.json(AgentCard.toJSON(card)));
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({ resource: config.PUBLIC_URL, authorization_servers: config.OAUTH_ISSUER ? [config.OAUTH_ISSUER] : [], bearer_methods_supported: ['header'] }));
  app.use(async (req, res, next) => {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    try { if (!token) throw new Error(); principals.set(req, await verify(token)); next(); }
    catch { res.setHeader('WWW-Authenticate', 'Bearer'); res.status(401).json({ error: 'Authentication required' }); }
  });
  const principal = (req: Request) => principals.get(req)!;
  const modelFor = async (p: Principal, taskId?: string) => taskId ? metadata.get((await tasks.get(p, taskId)).release) : metadata.active();
  const query = async (p: Principal, raw: unknown) => {
    requireScope(p, 'ontology:read'); const input = queryInput.parse(raw);
    return new Objects(db, await modelFor(p, input.taskId), p.owner).query(input.query);
  };
  const evaluate = async (p: Principal, raw: unknown) => {
    const input = functionInput.parse(raw), model = await modelFor(p, input.taskId);
    return workflow.functions.invoke(model, input.function, input.input, { principal: p, objects: new Objects(db, model, p.owner), signal: AbortSignal.timeout(30000) });
  };
  const apply = async (p: Principal, raw: unknown) => {
    const input = actionInput.parse(raw), model = await metadata.active();
    const selected = input.interface ? model.resolveAction(input.interface.object, input.interface.type, input.interface.action, input.input) : { action: input.action!, input: input.input };
    return workflow.actions.apply(p, model, selected.action, selected.input, input.requestId);
  };
  app.get('/identity', (req, res) => res.json(principal(req)));
  app.post('/tasks', async (req, res) => res.json(publicTask(await tasks.submit(principal(req), req.body))));
  app.get('/tasks/:id', async (req, res) => res.json(publicTask(await tasks.get(principal(req), String(req.params.id)))));
  app.post('/tasks/:id/cancel', async (req, res) => res.json(publicTask(await tasks.cancel(principal(req), String(req.params.id)))));
  app.post('/tasks/:id/places', async (req, res) => res.json(publicTask(await tasks.selectPlaces(principal(req), String(req.params.id), req.body))));
  app.get('/ontology', async (req, res) => { requireScope(principal(req), 'ontology:read'); res.json((await metadata.active()).document); });
  app.post('/ontology/query', async (req, res) => res.json(await query(principal(req), req.body)));
  app.post('/ontology/functions', async (req, res) => res.json(await evaluate(principal(req), req.body)));
  app.post('/ontology/actions', async (req, res) => res.json(await apply(principal(req), req.body)));
  app.post('/mcp', async (req, res) => {
    const p = principal(req), server = new McpServer({ name: 'eigos', version: '0.2.0' });
    const response = async (operation: () => Promise<unknown>) => {
      try { const result = await operation(); return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Request failed' }] }; }
    };
    server.registerTool('submit_task', { description: 'Submit a read-only ride estimate request.', inputSchema: submitSchema }, input => response(async () => publicTask(await tasks.submit(p, input))));
    server.registerTool('get_task', { description: 'Read your original task and quote.', inputSchema: z.strictObject({ taskId: z.uuid() }) }, input => response(async () => publicTask(await tasks.get(p, input.taskId))));
    server.registerTool('select_task_places', { description: 'Select source-returned endpoints for a task waiting for clarification.', inputSchema: z.strictObject({ taskId: z.uuid(), places: placeSelectionSchema }) }, input => response(async () => publicTask(await tasks.selectPlaces(p, input.taskId, input.places))));
    server.registerTool('query_ontology', { description: 'Query object sets using an Object Type or Interface and its property and link names.', inputSchema: queryInput }, input => response(() => query(p, input)));
    server.registerTool('evaluate_ontology', { description: 'Invoke a published Function.', inputSchema: functionInput }, input => response(() => evaluate(p, input)));
    server.registerTool('apply_ontology_action', { description: 'Submit a published Action through its declared parameters and submission criteria.', inputSchema: actionInput }, input => response(() => apply(p, input)));
    server.registerTool('describe_ontology', { description: 'Read published types, properties, interfaces, links, functions and actions.', inputSchema: z.strictObject({}) }, () => response(async () => { requireScope(p, 'ontology:read'); return (await metadata.active()).document; }));
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
  return { app, tasks, metadata };
}
