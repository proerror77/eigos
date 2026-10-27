import { authorizationScope, withAuthorization } from '../security/context.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { McpServer, createMcpHandler, type CallToolResult } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { planningToolSchemas, type OntologyPlanningSession } from './planning-session.js';
import type { NativeMcpConnection } from '../capabilities/executor.js';
import { objectRefSchema } from '../ontology/model.js';

const decisionSchema = z.object({ receiptIds: z.array(z.string().min(1)).max(20), decisionJson: z.string().min(2).max(100000) }).strict();
const descriptions: Record<keyof typeof planningToolSchemas, string> = {
  read_task_context: 'Read the current owned task, instructions, facts, execution state and bounded Ontology definitions once at the start of a decision. Reuse this successful receipt after paging read_task_instructions; paging does not change the context. Use focused queries for further facts. Repeating this full read consumes the same cumulative byte budget.',
  read_task_instructions: 'Read remaining original instruction pages for this task. Preserve exact user facts and read all required pages before interpreting the goal.',
  describe_ontology: 'Discover registered types, relationships, functions and action schemas. Definitions grant no authority.',
  discover_actions: 'Discover current task-bound service actions, exact binding pins, context input schemas and completion contracts.',
  query_ontology: 'Read current task-owned objects or named relationships. Only authorized evidence can support decisions.',
  evaluate_ontology: 'Evaluate a registered read-only Ontology function against actual objects. Missing evidence remains unknown.',
  assess_conditions: 'Assess typed business conditions against current candidate or subject evidence.',
  propose_action: 'Propose a registered Ontology decision action using observed object revisions. This does not execute a business effect.',
};

/** Expose argument names at the root for native model tool discovery. A root
 * union has no properties, which caused the real client to invent functionId /
 * inputs instead of function / object. The session still validates the exact
 * original union, including branch-specific requirements and forbidden mixes. */
function nativeInputSchema(schema: z.ZodType): z.ZodType {
  if (!(schema instanceof z.ZodUnion)) return schema;
  const branches = schema.options;
  if (!branches.every(branch => branch instanceof z.ZodObject)) throw new Error('Native tool union requires object branches');
  const shapes = branches.map(branch => (branch as z.ZodObject).shape as Record<string, z.ZodType>);
  const properties: Record<string, z.ZodType> = {};
  for (const key of new Set(shapes.flatMap(shape => Object.keys(shape)))) {
    const variants = shapes.flatMap(shape => shape[key] ? [shape[key]!] : []);
    const distinct = [...new Set(variants)];
    const property = distinct.length === 1 ? distinct[0]! : z.union(distinct as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    properties[key] = variants.length === shapes.length && variants.every(value => !value.isOptional()) ? property : property.optional();
  }
  return z.object(properties).strict().describe(schema.description ?? 'Use the displayed argument names; the selected operation validates its exact argument combination.');
}
const nativeSchemas = Object.fromEntries(Object.entries(planningToolSchemas).map(([name, schema]) => [name, nativeInputSchema(schema)]));
const functionNames = planningToolSchemas.evaluate_ontology.options.map(branch => String(branch.shape.function.value));
nativeSchemas.evaluate_ontology = z.object({
  function: z.enum(functionNames as [string, ...string[]]).describe('Exact function NAME STRING from this enum, without a version or reference object.'),
  object: objectRefSchema,
  argumentsJson: z.string().max(16000).nullish().describe('JSON object of additional function parameters, or "{}" for status/freshness functions. Never include function or object here. For withinBudget, supply budget and priceBasis here.'),
}).passthrough(); // Existing native clients may still send the original flat arguments.

function nativeArguments(name: string, raw: unknown): unknown {
  if (name !== 'evaluate_ontology') return raw;
  const { argumentsJson, ...args } = raw as Record<string, unknown>;
  if (argumentsJson === undefined || argumentsJson === null) return args;
  const extra: unknown = JSON.parse(String(argumentsJson));
  if (!extra || typeof extra !== 'object' || Array.isArray(extra) || Object.keys(extra).some(key => Object.hasOwn(args, key))) throw new Error('Additional function arguments must be an object without duplicate fields');
  return { ...args, ...extra };
}

/** A native MCP endpoint owned by one Worker model session, never a public gateway. */
export async function openOntologyMcp(session: OntologyPlanningSession, signal: AbortSignal, onBudgetExceeded?: () => void, finalSchema?: object, modelChannelId?: string) {
  signal.throwIfAborted();
  const authority = authorizationScope();
  const authorized = <T>(action: () => T): T => authority ? withAuthorization(authority, action) : action();
  const finalDecision = finalSchema ? z.fromJSONSchema(finalSchema as Parameters<typeof z.fromJSONSchema>[0]) : undefined;
  const sessionId = randomUUID(), token = randomBytes(32).toString('base64url');
  const authorizedFunctions = session.graph.security ? session.catalog().functions.map(fn => fn.id) : undefined;
  const offered = session.catalog().tools.map(tool => tool.name as keyof typeof planningToolSchemas).filter(name => name !== 'evaluate_ontology' || !authorizedFunctions || authorizedFunctions.length > 0);
  let decision: { output: unknown; digest: string; receiptIds: string[] } | undefined;
  let closed = false;
  let toolAttempts = 0, readAttempts = 0;
  const active = () => { signal.throwIfAborted(); if (closed) throw new Error('Ontology MCP session closed'); };
  const respond = (action: () => unknown): CallToolResult => {
    try {
      active(); const result = authorized(() => { authority?.assertCurrent(); const value = action(); session.authorizeModel(modelChannelId); return value; });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error instanceof DomainError ? error.code : 'REJECTED', message: error instanceof Error ? error.message : 'Ontology request rejected' }) }] };
    }
  };
  const makeServer = () => {
    const server = new McpServer({ name: 'eigos-ontology', version: '1.0.0' });
    for (const name of offered) server.registerTool(name, {
      description: descriptions[name], inputSchema: name === 'evaluate_ontology' && authorizedFunctions ? (nativeSchemas[name] as z.ZodObject).extend({ function: z.enum(authorizedFunctions as [string,...string[]]) }) : nativeSchemas[name]!,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, (args: unknown) => respond(() => {
      if (decision) throw new Error('This decision has already been submitted');
      const result = session.call(name, nativeArguments(name, args)), receipt = session.lastReceipt();
      if (!receipt) throw new Error('Ontology call produced no receipt');
      return { result, receipt: { id: receipt.id, tool: receipt.tool, status: receipt.status, inputDigest: receipt.inputDigest, outputDigest: receipt.outputDigest }, budget: session.readBudget() };
    }));
    server.registerTool('submit_decision', {
      description: 'Submit this model session\'s final structured decision and successful Ontology receipt IDs. The Worker separately validates and authorizes execution.',
      inputSchema: decisionSchema, annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, args => respond(() => {
      const output: unknown = JSON.parse(args.decisionJson);
      if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Decision must be a JSON object');
      const validation = finalDecision?.safeParse(output);
      if (validation && !validation.success) throw new Error('Invalid final decision: ' + validation.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 1600));
      const candidate = { output, digest: digest(output), receiptIds: args.receiptIds };
      if (!session.usesTaskContext() && (!session.receipts().some(r => r.tool === 'describe_ontology' && r.status === 'ok') || !session.receipts().some(r => r.tool === 'query_ontology' && r.status === 'ok'))) throw new Error('The model skipped required ontology reads');
      session.acceptReceipts(args.receiptIds);
      if (decision) {
        if (digest(candidate) !== digest(decision)) throw new Error('A different decision was already submitted');
      } else {
        decision = candidate;
      }
      return { decisionDigest: decision.digest, sessionId, taskId: session.request.id, execution: 'not_dispatched' };
    }));
    return server;
  };
  const app = createMcpExpressApp({ host: '127.0.0.1', allowedHosts: ['127.0.0.1'], jsonLimit: '128kb' });
  const handler = toNodeHandler(createMcpHandler(makeServer, { legacy: 'stateless', maxSubscriptions: 0 }));
  app.all('/mcp', async (req, res) => {
    const provided = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
    if (closed || signal.aborted || provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.status(401).json({ error: 'invalid_session' }); return; }
    try { authorized(() => { authority?.assertCurrent(); session.authorizeModel(modelChannelId); }); }
    catch { res.status(403).json({error:'session_authority_ended'}); return; }
    if (req.body?.method === 'tools/call') {
      toolAttempts++;
      if (req.body.params?.name !== 'submit_decision') readAttempts++;
      if (readAttempts > 20 || toolAttempts > 24) {
        res.status(200).json({ jsonrpc: '2.0', id: req.body.id, result: { isError: true, content: [{ type: 'text', text: 'Native Ontology MCP call limit reached' }] } });
        onBudgetExceeded?.(); return;
      }
    }
    await handler(req, res, req.body);
  });
  const http = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); listener.once('error', reject);
  });
  const close = async () => {
    if (closed) return;
    closed = true; signal.removeEventListener('abort', abort);
    await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
  };
  const abort = () => { void close(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) { await close(); signal.throwIfAborted(); }
  const connection: NativeMcpConnection = { name: 'eigos_ontology', url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, token, tools: [...offered, 'submit_decision'] };
  return { connection, close, result: () => { active(); if (!decision) throw new Error('The model did not submit a decision through native Ontology MCP'); return decision; },
    evidence: () => ({ server: 'eigos_ontology' as const, transport: 'streamable-http' as const, sessionId, taskId: session.request.id, toolAttempts,
      calls: session.receipts().map(r => ({ tool: r.tool, receiptId: r.id, status: r.status, inputDigest: r.inputDigest, outputDigest: r.outputDigest })), decisionSubmitted: !!decision }) };
}
