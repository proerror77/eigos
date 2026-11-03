import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { commerceReadDefinition, commerceReadModule } from '../../ontology/payment-commerce.js';
import { resolveOntologyMcpRead } from '../../ontology/mcp-read.js';
import { commerceQuerySchema, providerActions, CommerceReadError, type CommerceProvider, type CommerceQuery, type CommerceReadSource } from './contracts.js';
import { readCommerceConnection, readCommerceCredential, readCommerceFile, alipayCredentialSchema, unionPayCredentialSchema, type CommerceConnectionOptions } from './connection.js';
import { queryWechatPay, queryTaobao } from './http.js';

/** Source policy is independent of editable argument mappings. A declaration
 * labelled read-only must never turn into a provider write after DSL drift. */
export function assertCommerceReadTool(provider: CommerceProvider, tool: string): void {
  const allowed: Record<CommerceProvider, string[]> = { alipay: ['query-alipay-payment'], wechatpay: ['query-wechatpay-order'],
    unionpay: ['query-unionpay-payment'], taobao: ['taobao.tbk.dg.material.optional', 'taobao.tbk.item.info.get'] };
  if (!allowed[provider].includes(tool)) throw new Error('Provider write or unregistered read tool is forbidden');
}
/** Only the immutable Ontology mapping supplies the provider tool and arguments. */
export function resolveCommerceQuery(provider: CommerceProvider, value: CommerceQuery) {
  const query = commerceQuerySchema.parse(value);
  if (!providerActions[provider].includes(query.action) || digest(query) !== digest(value)) throw new Error('Read action is outside this provider');
  const action = commerceReadDefinition.actions.find(action => action.id === query.action)!;
  const resolved = resolveOntologyMcpRead(action.mcp, {}, { input: query }, () => { throw new Error('Unexpected read dependency'); });
  if (resolved.server !== provider) throw new Error('Provider read mapping changed');
  assertCommerceReadTool(provider, resolved.tool);
  return { query, ...resolved };
}
function mcpValue(raw: { isError?: boolean; structuredContent?: unknown; content: unknown[] }) {
  if (raw.isError || Buffer.byteLength(JSON.stringify(raw)) > 1048576) throw new Error('MCP read failed');
  if (raw.structuredContent !== undefined) return z.record(z.string(), z.unknown()).parse(raw.structuredContent);
  const parts = z.array(z.object({ type: z.literal('text'), text: z.string().max(1000000) })).length(1).parse(raw.content);
  return parts[0]!.text;
}
export function normalizeAlipayRead(raw: Parameters<typeof mcpValue>[0], outTradeNo: string) {
  const value = mcpValue(raw);
  // Official 2.0.0 returns human-readable text even for a business rejection.
  // Match the entire known success response; isError=false alone proves nothing.
  const match = typeof value === 'string' ? /^交易状态: (WAIT_BUYER_PAY|TRADE_CLOSED|TRADE_SUCCESS|TRADE_FINISHED) , 交易金额: (\d{1,18}(?:\.\d{1,6})?) , 支付宝交易号: ([A-Za-z0-9_-]{1,64})$/.exec(value.trim()) : null;
  if (!match) throw new Error('Unverified Alipay query response');
  return { outTradeNo, tradeState: match[1]!, totalAmount: match[2]!, amountUnit: 'major', currency: 'CNY', transactionId: match[3]! };
}
export function normalizeUnionPayRead(raw: Parameters<typeof mcpValue>[0], args: Record<string, unknown>) {
  const value = mcpValue(raw);
  const data = z.object({ code: z.string().min(1).max(32), transStatus: z.string().min(1).max(64),
    orderId: z.string().max(40).optional(), txnTime: z.string().regex(/^\d{14}$/).optional(), txnAmt: z.union([z.string().regex(/^\d{1,18}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]).optional(),
  }).parse(typeof value === 'string' ? JSON.parse(value) : value);
  if (data.orderId && data.orderId !== args.orderId || data.txnTime && data.txnTime !== args.txnTime) throw new Error('UnionPay returned another trade');
  // Preserve the provider's code/state. This query does not classify an original
  // contract, payment or refund as successful, and drops card/token information.
  return { orderId: args.orderId, txnTime: args.txnTime, responseCode: data.code, sourceTradeState: data.transStatus,
    ...(data.txnAmt !== undefined ? { sourceAmount: String(data.txnAmt), amountUnit: 'provider_reported' } : {}) };
}

export class PaymentCommerceConnector implements CommerceReadSource {
  readonly connection;
  readonly configurationDigest: string;
  constructor(readonly provider: CommerceProvider, private readonly options: CommerceConnectionOptions, private readonly fetcher: typeof fetch = fetch) {
    this.connection = readCommerceConnection(provider, options.connectionFile);
    this.configurationDigest = digest({ policy: 'payment-commerce-readonly@1', connectionFile: options.connectionFile, connection: this.connection, module: commerceReadModule });
  }
  private assertCurrent() {
    if (digest(readCommerceConnection(this.provider, this.options.connectionFile)) !== digest(this.connection)) throw new Error('Provider connection changed');
  }
  async invoke(value: CommerceQuery, signal: AbortSignal) {
    signal.throwIfAborted();
    let directory: string | undefined;
    try {
      const { tool, args } = resolveCommerceQuery(this.provider, value);
      this.assertCurrent();
      const credential = readCommerceCredential(this.connection);
      let result: Record<string, unknown>;
      if (this.provider === 'wechatpay') result = await queryWechatPay(credential, String(args.outTradeNo), signal, this.fetcher);
      else if (this.provider === 'taobao') result = await queryTaobao(credential, tool, args, signal, this.fetcher);
      else {
        if (!('mcpScript' in this.connection)) throw new Error('Missing MCP runtime');
        readCommerceFile(this.connection.mcpScript, this.connection.mcpScriptSha256, true);
        directory = await mkdtemp(join(tmpdir(), 'eigos-payment-read-'));
        const env: Record<string, string> = { HOME: directory, TMPDIR: directory, ...(process.env.PATH ? { PATH: process.env.PATH } : {}) };
        if (this.provider === 'alipay') Object.assign(env, alipayCredentialSchema.parse(credential), {
          AP_CURRENT_ENV: this.connection.environment === 'sandbox' ? 'sandbox' : 'prod', AP_SELECT_TOOLS: tool, AP_LOG_ENABLED: 'false',
        });
        else {
          const key = unionPayCredentialSchema.parse(credential), certs = join(directory, 'certs');
          await mkdir(certs, { mode: 0o700 });
          const signingPath = join(directory, 'signing.pfx');
          await writeFile(signingPath, Buffer.from(key.signingCertificateBase64, 'base64'), { mode: 0o600 });
          for (const cert of key.validationCertificates) await writeFile(join(certs, cert.name), Buffer.from(cert.base64, 'base64'), { mode: 0o600 });
          Object.assign(env, { UP_ACCESS_TYPE: '0', UP_MER_ID: key.UP_MER_ID, UP_SIGN_CERT_PWD: key.UP_SIGN_CERT_PWD, UP_SIGN_CERT_PATH: signingPath,
            UP_VALIDATE_CERT_DIR: certs, UP_AVAILABLE_TOOLS: tool, UP_LOG_DIR: directory, UP_TIME_OUT: '10000',
            ...(key.UP_TR_ID ? { UP_TR_ID: key.UP_TR_ID } : {}), ...(key.UP_TOKEN_TYPE ? { UP_TOKEN_TYPE: key.UP_TOKEN_TYPE } : {}) });
        }
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
        const client = new Client({ name: 'eigos-payment-readonly', version: '1' });
        const transport = new StdioClientTransport({ command: process.execPath, args: [this.connection.mcpScript], env, stderr: 'ignore', maxBufferSize: 1048576 });
        const abort = () => { void client.close().catch(() => {}); };
        bounded.addEventListener('abort', abort, { once: true });
        try {
          bounded.throwIfAborted();
          await client.connect(transport, { signal: bounded, timeout: 15000 });
          const listed = await client.listTools({}, { signal: bounded, timeout: 10000 });
          if (!listed.tools.some(t => t.name === tool)) throw new Error('Official MCP read tool unavailable');
          const raw = await client.callTool({ name: tool, arguments: args }, { signal: bounded, timeout: 30000 });
          result = this.provider === 'alipay' ? normalizeAlipayRead(raw, String(args.outTradeNo)) : normalizeUnionPayRead(raw, args);
        } finally {
          bounded.removeEventListener('abort', abort);
          await client.close().catch(() => {}); await transport.close().catch(() => {});
        }
      }
      signal.throwIfAborted(); this.assertCurrent(); readCommerceCredential(this.connection);
      return { result, observedAt: new Date().toISOString() };
    } catch (error) {
      signal.throwIfAborted();
      throw error instanceof CommerceReadError ? error : new CommerceReadError(this.provider);
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
}
