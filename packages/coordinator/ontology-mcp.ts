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

const decisionSchema = z.object({ receiptIds: z.array(z.string().min(1)).max(20), decisionJson: z.string().min(2).max(100000) }).strict();
const descriptions: Record<keyof typeof planningToolSchemas, string> = {
  read_task_context: 'Read the current owned task, exact instructions, facts, execution state and bounded Ontology definitions. Start each decision here.',
  read_task_instructions: 'Read remaining original instruction pages for this task. Preserve exact user facts and read all required pages before interpreting the goal.',
  describe_ontology: 'Discover registered types, relationships, functions and action schemas. Definitions grant no authority.',
  discover_actions: 'Discover current task-bound service actions, exact binding pins, context input schemas and completion contracts.',
  query_ontology: 'Read current task-owned objects or named relationships. Only authorized evidence can support decisions.',
  evaluate_ontology: 'Evaluate a registered read-only Ontology function against actual objects. Missing evidence remains unknown.',
  assess_conditions: 'Assess typed business conditions against current candidate or subject evidence.',
  propose_action: 'Propose a registered Ontology decision action using observed object revisions. This does not execute a business effect.',
};

/** A native MCP endpoint owned by one Worker model session, never a public gateway. */
export async function openOntologyMcp(session: OntologyPlanningSession, signal: AbortSignal, onBudgetExceeded?: () => void) {
  signal.throwIfAborted();
  const sessionId = randomUUID(), token = randomBytes(32).toString('base64url');
  const offered = session.catalog().tools.map(tool => tool.name as keyof typeof planningToolSchemas);
  let decision: { output: unknown; digest: string; receiptIds: string[] } | undefined;
  let closed = false;
  let toolAttempts = 0, readAttempts = 0;
  const active = () => { signal.throwIfAborted(); if (closed) throw new Error('Ontology MCP session closed'); };
  const respond = (action: () => unknown): CallToolResult => {
    try {
      active(); const result = action();
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error instanceof DomainError ? error.code : 'REJECTED', message: error instanceof Error ? error.message : 'Ontology request rejected' }) }] };
    }
  };
  const makeServer = () => {
    const server = new McpServer({ name: 'eigos-ontology', version: '1.0.0' });
    for (const name of offered) server.registerTool(name, {
      description: descriptions[name], inputSchema: planningToolSchemas[name],
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, (args: unknown) => respond(() => {
      if (decision) throw new Error('This decision has already been submitted');
      const result = session.call(name, args), receipt = session.lastReceipt();
      if (!receipt) throw new Error('Ontology call produced no receipt');
      return { result, receipt: { id: receipt.id, tool: receipt.tool, status: receipt.status, inputDigest: receipt.inputDigest, outputDigest: receipt.outputDigest }, budget: { readsRemaining: 20 - session.receipts().length, finalResponseRequired: session.requiresFinalResponse() } };
    }));
    server.registerTool('submit_decision', {
      description: 'Submit this model session\'s final structured decision and successful Ontology receipt IDs. The Worker separately validates and authorizes execution.',
      inputSchema: decisionSchema, annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, args => respond(() => {
      const output: unknown = JSON.parse(args.decisionJson);
      if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Decision must be a JSON object');
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
