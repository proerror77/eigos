import { constants } from 'node:fs';
import { open, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import { digest } from '../../core/delegation.js';
import { AgentReadError, type AgentActionContext } from '../../core/agent-program.js';
import type { RideEstimateObservation } from '../../ontology/ride-estimate.js';
import { DidiMcpConnector } from './connector.js';
import type { DidiBinding } from './contracts.js';
import { didiBookingToolInputs, didiOrderResultSchema, mapDidiOrder, type DidiBookingTool, type DidiOrderResult } from './booking-contracts.js';

/** A separate, mock-only transport. The read-only connector's allowlist stays
 * unchanged. There is deliberately no production write switch or retry. */
export class DidiBookingConnector extends DidiMcpConnector {
  constructor(binding: DidiBinding, fetcher: typeof fetch = fetch, fixture = false) {
    super(binding, fetcher, fixture);
    if (binding.environment !== 'mock' || !binding.auditDirectory) throw new Error('DiDi booking requires the official mock endpoint and a private durable audit directory');
  }
  private async bookingDirectory(client: Client, signal: AbortSignal) {
    const found = new Map<string, object>(); let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const list = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 10000 });
      for (const tool of list.tools) {
        if (!Object.hasOwn(didiBookingToolInputs, tool.name)) continue;
        if (found.has(tool.name)) throw new Error('Duplicate operation tool');
        const expected = Object.keys(didiBookingToolInputs[tool.name as DidiBookingTool].shape), schema = tool.inputSchema;
        if (schema.type !== 'object' || expected.some(name => (schema.properties?.[name] as { type?: unknown })?.type !== 'string')
          || (schema.required ?? []).some(name => !expected.includes(name))) throw new Error('Operation schema changed');
        found.set(tool.name, { type: 'object', properties: Object.fromEntries(expected.map(name => [name, { type: 'string' }])), required: schema.required ?? [] });
      }
      cursor = list.nextCursor; if (!cursor) break;
      if (page === 3) throw new Error('Operation directory too large');
    }
    if (found.size !== 2) throw new Error('Mock order tools unavailable');
    return found;
  }
  async discoverBooking(signal: AbortSignal) {
    return this.session(signal, async client => ({ environment: 'mock', tools: [...await this.bookingDirectory(client, signal)].map(([name, schema]) => ({ name, schema })) }), { tools: didiBookingToolInputs });
  }
  private path(ctx: AgentActionContext) { return join(this.binding.auditDirectory!, 'operations', digest({ binding: this.binding.bindingId, request: ctx.request.id, intent: ctx.intentId })); }
  async recoverCreate(ctx: AgentActionContext): Promise<DidiOrderResult | undefined> {
    try {
      const record = JSON.parse(await readFile(this.path(ctx) + '.result.json', 'utf8'));
      if (record.requestId !== ctx.request.id || record.intentId !== ctx.intentId || record.inputDigest !== ctx.execution?.intent.inputDigest || record.bindingDigest !== digest(this.binding)) throw new Error();
      const result = didiOrderResultSchema.parse(record.result);
      if (result.receipt.tool !== 'taxi_create_order') throw new Error();
      return result;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new AgentReadError('Original DiDi mock operation evidence cannot be verified; do not submit another order.'); }
  }
  async create(ctx: AgentActionContext, quote: RideEstimateObservation, productCategory: string, signal: AbortSignal): Promise<DidiOrderResult> {
    // Only the private raw response contains the provider's trace ID. Never
    // accept one from a model, PA argument, task text or an unrelated quote.
    const file = await open(join(this.binding.auditDirectory!, 'responses', `${quote.receipt.id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try { const stat = await file.stat(); if (!stat.isFile() || stat.mode & 0o077 || stat.size > 1048576) throw new Error('Private quote receipt unavailable'); raw = await file.readFile('utf8'); } finally { await file.close(); }
    if (createHash('sha256').update(raw).digest('hex') !== quote.receipt.responseSha256) throw new AgentReadError('The original private estimate receipt changed.');
    const parsed = didiBookingToolInputs.taxi_create_order.parse({ product_category: productCategory, estimate_trace_id: JSON.parse(raw).structuredContent?.traceId });
    if (!ctx.assertDispatchAllowed || !ctx.execution || ctx.execution.intent.effect !== 'order' || ctx.execution.attempt.id !== ctx.attemptId) throw new AgentReadError('An exact authorized durable order attempt is required.');
    const recovered = await this.recoverCreate(ctx); if (recovered) return recovered;
    await mkdir(join(this.binding.auditDirectory!, 'operations'), { recursive: true, mode: 0o700 });
    const path = this.path(ctx);
    ctx.assertDispatchAllowed(); signal.throwIfAborted();
    try {
      const marker = await open(path + '.sent.json', 'wx', 0o600);
      try { await marker.writeFile(JSON.stringify({ requestId: ctx.request.id, intentId: ctx.intentId, quote: quote.id, at: new Date().toISOString() })); await marker.sync(); } finally { await marker.close(); }
    } catch { throw new AgentReadError('The original DiDi mock order may have been sent. Automatic resubmission is disabled.'); }
    const result = await this.call('taxi_create_order', parsed, signal, ctx.assertDispatchAllowed);
    const temp = path + `.${randomUUID()}.tmp`;
    const record = { requestId: ctx.request.id, intentId: ctx.intentId, inputDigest: ctx.execution.intent.inputDigest, bindingDigest: digest(this.binding), result };
    const fileOut = await open(temp, 'wx', 0o600);
    try { await fileOut.writeFile(JSON.stringify(record)); await fileOut.sync(); } finally { await fileOut.close(); }
    await rename(temp, path + '.result.json');
    return result;
  }
  query(orderId: string, signal: AbortSignal): Promise<DidiOrderResult> { return this.call('taxi_query_order', { order_id: orderId }, signal); }
  private async call(tool: DidiBookingTool, input: Record<string, unknown>, signal: AbortSignal, beforeCall?: () => void): Promise<DidiOrderResult> {
    try {
      const parsed = didiBookingToolInputs[tool].parse(input);
      return await this.session(signal, async (client, secret) => {
        const directory = await this.bookingDirectory(client, signal), startedAt = new Date().toISOString();
        const raw = await client.callTool({ name: tool, arguments: parsed }, { signal, timeout: 20000 });
        const receivedAt = new Date().toISOString(), serialized = JSON.stringify(raw);
        if (serialized.includes(secret)) throw new Error('Credential echo');
        await this.verifyCredential();
        const data = mapDidiOrder(tool, raw, tool === 'taxi_query_order' ? String(input.order_id) : undefined);
        if (tool === 'taxi_query_order' && data.orderId !== input.order_id) throw new Error('Different order');
        const result = didiOrderResultSchema.parse({ data, receipt: { id: randomUUID(), bindingId: this.binding.bindingId, environment: 'mock', endpoint: 'https://mcp.didichuxing.com/mcp-servers-sandbox', tool,
          inputDigest: digest(parsed), resultDigest: digest(data), responseSha256: createHash('sha256').update(serialized).digest('hex'), toolSchemaDigest: digest(directory.get(tool)), startedAt, receivedAt } });
        await mkdir(join(this.binding.auditDirectory!, 'responses'), { recursive: true, mode: 0o700 });
        await writeFile(join(this.binding.auditDirectory!, 'responses', `${result.receipt.id}.json`), serialized, { mode: 0o600, flag: 'wx' });
        return result;
      }, { tools: didiBookingToolInputs, beforeCall });
    } catch { throw new AgentReadError(tool === 'taxi_create_order' ? 'DiDi mock order outcome is unresolved; preserve the original attempt and never repeat creation.' : 'The original DiDi mock order could not be independently read.'); }
  }
}
