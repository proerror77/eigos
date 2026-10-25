import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { digest } from '../../core/delegation.js';
import { AgentReadError } from '../../core/agent-program.js';
import { didiBindingSchema, type DidiBinding } from './contracts.js';
import { readDidiCredential } from './connector.js';

import { MOCK_ORDER_ENDPOINT, mockOrderInputs, mockOrderReceiptSchema, type MockOrderTool } from './order-test-contracts.js';
export { MOCK_ORDER_ENDPOINT, mockOrderInputs, mockOrderReceiptSchema, type MockOrderTool } from './order-test-contracts.js';
export interface MockOrderSource {
  readonly evidenceKind: 'provider_mock' | 'fixture';
  invoke(tool: MockOrderTool, input: Record<string, unknown>, signal: AbortSignal): Promise<{ raw: unknown; receipt: z.infer<typeof mockOrderReceiptSchema> }>;
}
export class MockOrderError extends AgentReadError {
  constructor(readonly code: string) { super(`Official DiDi mock call failed (${code}); an uncertain creation must not be repeated or inferred from the account's latest order`); }
}
/** This transport has no production write branch, phone override, implicit
 * retries, account-wide order query or arbitrary URL/tool escape hatch. */
export class DidiMockOrderConnector implements MockOrderSource {
  readonly evidenceKind = 'provider_mock' as const;
  readonly binding: DidiBinding;
  constructor(binding: DidiBinding, private fetcher: typeof fetch = fetch) {
    this.binding = didiBindingSchema.parse(binding);
    if (!isAbsolute(binding.keyFile) || binding.auditDirectory && !isAbsolute(binding.auditDirectory)) throw new MockOrderError('PRIVATE_ABSOLUTE_PATH_REQUIRED');
    if (binding.environment !== 'mock') throw new MockOrderError('MOCK_ENDPOINT_REQUIRED');
  }
  async invoke(tool: MockOrderTool, input: Record<string, unknown>, signal: AbortSignal) {
    if (!Object.hasOwn(mockOrderInputs, tool)) throw new MockOrderError('TOOL_NOT_ALLOWED');
    const args = mockOrderInputs[tool].parse(input), secret = await readDidiCredential(this.binding), url = new URL(MOCK_ORDER_ENDPOINT);
    url.searchParams.set('key', secret); signal.throwIfAborted();
    const client = new Client({ name: 'eigos-didi-order-test', version: '1' });
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]); let calls = 0, requests = 0;
    const transport = new StreamableHTTPClientTransport(url, { reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 }, fetch: async (target, init = {}) => {
      if (String(target) !== url.href || ++requests > 20) throw new MockOrderError('UNEXPECTED_ENDPOINT');
      if (init.method === 'POST') {
        const rpc = JSON.parse(String(init.body));
        if (!['initialize', 'notifications/initialized', 'notifications/cancelled', 'tools/list', 'tools/call', 'ping'].includes(rpc.method)) throw new MockOrderError('RPC_NOT_ALLOWED');
        if (rpc.method === 'tools/call' && (rpc.params?.name !== tool || digest(rpc.params.arguments) !== digest(args) || ++calls > 1)) throw new MockOrderError('REPLAY_OR_ARGUMENT_CHANGE_BLOCKED');
      } else if (!['GET', 'DELETE'].includes(init.method ?? 'GET')) throw new MockOrderError('METHOD_NOT_ALLOWED');
      const response = await this.fetcher(target, { ...init, redirect: 'manual', signal: bounded });
      if (response.redirected || response.status >= 300 && response.status < 400) throw new MockOrderError('REDIRECT_BLOCKED');
      if (!response.ok && !(init.method === 'GET' && response.status === 405)) throw new MockOrderError('HTTP_REJECTED');
      let bytes = 0;
      const body = response.body?.pipeThrough(new TransformStream({ transform(chunk, controller) { bytes += chunk.byteLength; if (bytes > 1048576) throw new MockOrderError('RESPONSE_TOO_LARGE'); controller.enqueue(chunk); } }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } });
    try {
      await client.connect(transport, { signal: bounded, timeout: 10000 });
      const directory = await client.listTools({}, { signal: bounded, timeout: 10000 });
      const definition = directory.tools.find(t => t.name === tool);
      const expected = Object.keys(mockOrderInputs[tool].shape);
      if (!definition || directory.tools.filter(t => t.name === tool).length !== 1 || definition.inputSchema.type !== 'object' || (definition.inputSchema.required ?? []).some(k => !expected.includes(k)) || expected.some(k => (definition.inputSchema.properties?.[k] as { type?: string })?.type !== 'string')) throw new MockOrderError('TOOL_SCHEMA_CHANGED');
      const startedAt = new Date().toISOString(); bounded.throwIfAborted();
      const raw = await client.callTool({ name: tool, arguments: args }, { signal: bounded, timeout: 20000 });
      const receivedAt = new Date().toISOString(), serialized = JSON.stringify(raw);
      if (serialized.includes(secret)) throw new MockOrderError('CREDENTIAL_ECHO_BLOCKED');
      const receipt = mockOrderReceiptSchema.parse({ id: randomUUID(), bindingId: this.binding.bindingId, environment: 'mock', endpoint: MOCK_ORDER_ENDPOINT, tool, inputDigest: digest(args), responseSha256: createHash('sha256').update(serialized).digest('hex'), toolSchemaDigest: digest(definition.inputSchema), startedAt, receivedAt });
      if (this.binding.auditDirectory) { await mkdir(this.binding.auditDirectory, { recursive: true, mode: 0o700 }); await writeFile(join(this.binding.auditDirectory, `${receipt.id}.json`), JSON.stringify({ receipt, raw }) + '\n', { mode: 0o600, flag: 'wx' }); }
      if (raw.isError) throw new MockOrderError('PROVIDER_REJECTED');
      return { raw, receipt };
    } catch (e) { if (e instanceof MockOrderError) throw e; if (e && typeof e === 'object' && 'code' in e && e.code === -32001) throw new MockOrderError('RATE_LIMITED'); throw new MockOrderError(bounded.aborted ? 'OUTCOME_UNKNOWN_AFTER_INTERRUPT' : 'MCP_REJECTED'); }
    finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  }
}

const statuses = new Map([
  ['系统正在为您匹配最近的司机...', 0], ['系统已为您匹配到司机，正在快马加鞭来接您。', 1],
  ['司机已经到达起点附近，请尽快上车。', 2], ['行程进行中，请系好安全带', 4], ['✅ 行程已完成！', 5],
]);
/** Mock currently returns plain text for status, despite the documentation's
 * structured example. Only exact observed Mock templates are recognized. */
export function parseMockOrderStatus(raw: any, orderId: string) {
  const s = raw?.structuredContent;
  if (s && Number.isInteger(s.statusCode)) {
    if (s.orderId !== undefined && s.orderId !== orderId) throw new MockOrderError('ORDER_ID_MISMATCH');
    return { orderId, statusCode: s.statusCode as number, statusText: ({ 0: '匹配中', 1: '司机已接单', 2: '司机已到达', 4: '行程中', 5: '行程完成', 6: '系统取消', 7: '已取消' } as Record<number, string>)[s.statusCode] ?? '未知或终止状态', encoding: 'structured' as const, identityEchoed: s.orderId === orderId };
  }
  const line = raw?.content?.find((c: any) => c.type === 'text')?.text?.split('\n')[0]?.trim();
  const code = statuses.get(line);
  if (code === undefined) throw new MockOrderError('UNRECOGNIZED_MOCK_STATUS');
  return { orderId, statusCode: code, statusText: line as string, encoding: 'exact_mock_text' as const, identityEchoed: false };
}
