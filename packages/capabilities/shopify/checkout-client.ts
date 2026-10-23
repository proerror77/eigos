import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { AgentReadError } from '../../core/agent-program.js';
import { DomainError } from '../../core/domain.js';
import { SHOP_MCP_ENDPOINT, SHOP_MCP_PROTOCOL, checkoutIdempotencyKey, shopCheckoutId, shopCheckoutReceiptSchema, shopVariantId, type ShopCallContext, type ShopCallResult, type ShopCheckoutConnector, type ShopTool } from './checkout-contracts.js';

const domain = z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/), sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const schemas = {
  lookup_catalog: z.strictObject({ catalog: z.strictObject({ ids: z.array(shopVariantId).min(1).max(20), filters: z.strictObject({ shops: z.array(z.string().regex(/^gid:\/\/shopify\/Shop\/[0-9]+$/)).length(1) }), context: z.strictObject({ address_country: z.literal('US'), currency: z.literal('USD') }) }) }),
  create_checkout: z.strictObject({ shop: domain, checkout: z.strictObject({ line_items: z.array(z.strictObject({ item: z.strictObject({ id: shopVariantId }), quantity: z.number().int().min(1).max(1000) })).min(1).max(20) }), meta: z.strictObject({ 'idempotency-key': z.uuid() }) }),
  get_checkout: z.strictObject({ shop: domain, id: shopCheckoutId }),
};

/** Fixed official anonymous MCP transport. No sign-in, account, order,
 * completion, payment credential, update or arbitrary tool entry point exists. */
export class OfficialShopCheckoutConnector implements ShopCheckoutConnector {
  readonly evidenceKind: 'provider' | 'fixture';
  constructor(private options: { auditDirectory?: string; execute?: boolean; fetcher?: typeof fetch } = {}) {
    if (options.auditDirectory && !isAbsolute(options.auditDirectory)) throw new DomainError('INVALID_INPUT', 'Checkout audit directory must be absolute');
    this.evidenceKind = options.fetcher ? 'fixture' : 'provider';
  }
  private journalPath(context: ShopCallContext) {
    return this.options.auditDirectory ? join(this.options.auditDirectory, `${digest({ owner: context.ownerDigest, key: context.operationKey })}.creation.json`) : undefined;
  }
  private auditDirectory() {
    const directory = this.options.auditDirectory;
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new DomainError('FORBIDDEN', 'Checkout audit directory must be owned and private');
    return directory;
  }
  originalCreation(context: ShopCallContext, requestDigest: string): ShopCallResult | undefined {
    if (this.options.execute === false) throw new DomainError('FORBIDDEN', 'Only Worker may read private Shopify recovery receipts');
    const path = this.journalPath(context); if (!path || !existsSync(path)) return;
    this.auditDirectory();
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new DomainError('FORBIDDEN', 'Checkout recovery receipt must be an owned private regular file');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.ownerDigest !== context.ownerDigest || record.requestId !== context.requestId || record.intentId !== context.intentId || record.operationKey !== context.operationKey
      || record.requestDigest !== requestDigest || record.resultDigest !== digest(record.result)) throw new DomainError('CONFLICT', 'Original checkout receipt does not match its owned operation');
    const receipt = shopCheckoutReceiptSchema.parse(record.result.receipt);
    if (receipt.tool !== 'create_checkout' || receipt.requestDigest !== requestDigest || receipt.operationKey !== context.operationKey || receipt.idempotencyKey !== checkoutIdempotencyKey(context.operationKey)) throw new DomainError('CONFLICT', 'Original checkout identity is not a creation receipt');
    return { ...record.result, receipt } as ShopCallResult;
  }
  async call(tool: ShopTool, args: Record<string, unknown>, context: ShopCallContext, signal: AbortSignal): Promise<ShopCallResult> {
    if (this.options.execute === false) throw new DomainError('FORBIDDEN', 'Only Worker may call Shopify');
    if (!Object.hasOwn(schemas, tool)) throw new DomainError('FORBIDDEN', 'This connector cannot place orders or make payments');
    const parsed = schemas[tool].parse(args);
    if (digest(parsed) !== digest(args)) throw new DomainError('INVALID_INPUT', 'Unexpected Shopify argument fields');
    const requestDigest = digest(args), write = tool === 'create_checkout';
    const auditDirectory = this.auditDirectory();
    if (write && !auditDirectory) throw new DomainError('FORBIDDEN', 'Checkout creation requires durable private recovery receipts');
    if (write && (!context.assertDispatchAllowed || (args.meta as Record<string, unknown>)['idempotency-key'] !== checkoutIdempotencyKey(context.operationKey))) throw new DomainError('FORBIDDEN', 'Checkout creation lacks exact current authority and idempotency');
    if (write && this.originalCreation(context, requestDigest)) throw new AgentReadError('Original checkout response already exists; query that checkout instead of creating again');
    const fetcher = this.options.fetcher ?? globalThis.fetch;
    let receipt: ShopCallResult['receipt'] | undefined, writeRequests = 0;
    const guardedFetch: typeof fetch = async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== SHOP_MCP_ENDPOINT || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new DomainError('FORBIDDEN', 'Shopify transport target changed');
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      if (headers.has('authorization') || headers.has('cookie') || headers.has('shopify-buyer-ip')) throw new DomainError('FORBIDDEN', 'Checkout preparation is anonymous and cannot borrow account credentials');
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      const business = body?.method === 'tools/call';
      if (business && (body.params?.name !== tool || digest(body.params?.arguments) !== requestDigest)) throw new DomainError('FORBIDDEN', 'Shopify transport escaped its exact single action');
      if (business && write) {
        if (++writeRequests > 1) throw new AgentReadError('Automatic replay of checkout creation is forbidden');
        context.assertDispatchAllowed!();
      }
      signal.throwIfAborted();
      const startedAt = new Date().toISOString();
      const response = await fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : []), AbortSignal.timeout(30000)]) });
      if (!business) return response;
      if (!response.headers.get('content-type')?.startsWith('application/json')) throw new AgentReadError('Shopify returned an unsupported response; preserve the original operation');
      const reader = response.body?.getReader(); if (!reader) throw new AgentReadError('Shopify returned no response body');
      const chunks: Uint8Array[] = []; let length = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 2_097_152) { await reader.cancel(); throw new AgentReadError('Shopify response exceeds its bounded contract'); } chunks.push(part.value); } } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks), receivedAt = new Date().toISOString();
      if (response.status !== 200) throw new AgentReadError('Shopify did not return a successful original response');
      receipt = shopCheckoutReceiptSchema.parse({ id: randomUUID(), endpoint: SHOP_MCP_ENDPOINT, protocolVersion: SHOP_MCP_PROTOCOL, tool, startedAt, receivedAt, httpStatus: 200,
        requestDigest, responseSha256: sha(bytes), responseBytes: bytes.length, ...(write ? { operationKey: context.operationKey, idempotencyKey: checkoutIdempotencyKey(context.operationKey) } : {}) });
      const envelope = JSON.parse(bytes.toString('utf8'));
      if (envelope.jsonrpc !== '2.0' || envelope.id !== body.id) throw new AgentReadError('Shopify response does not bind its original request');
      if (auditDirectory) {
        writeFileSync(join(auditDirectory, `${receipt.id}.json`), bytes, { mode: 0o600, flag: 'wx' });
        if (write && envelope.result?.structuredContent) {
          const result = { value: envelope.result.structuredContent, isError: envelope.result.isError === true, receipt };
          const record = { ownerDigest: context.ownerDigest, requestId: context.requestId, intentId: context.intentId, operationKey: context.operationKey, requestDigest, result, resultDigest: digest(result) };
          const path = this.journalPath(context)!, temporary = `${path}.${randomUUID()}.tmp`;
          writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); renameSync(temporary, path);
        }
      }
      return new Response(bytes, { status: response.status, headers: response.headers });
    };
    const client = new Client({ name: 'eigos-unpaid-checkout', version: '1' }, { versionNegotiation: { mode: { pin: SHOP_MCP_PROTOCOL } } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(SHOP_MCP_ENDPOINT), { fetch: guardedFetch }));
      if (write) context.assertDispatchAllowed!();
      const result = await client.callTool({ name: tool, arguments: args });
      if (!receipt || result.structuredContent === undefined) throw new AgentReadError('Shopify returned no bound structured result');
      return { value: result.structuredContent, receipt, isError: result.isError === true };
    } catch (error) {
      if (error instanceof DomainError || error instanceof AgentReadError) throw error;
      throw new AgentReadError('Shopify call did not establish a validated result; preserve the original operation');
    } finally { await client.close(); }
  }
}
