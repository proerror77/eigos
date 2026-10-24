import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { meituanReadDefinition, meituanReadDefinitionRef } from '../ontology/meituan-read-definition.js';
import { meituanPrimitiveSchemas, meituanPrimitiveReceiptSchema, type MeituanPrimitiveReader, type MeituanPrimitiveReceipt, type MeituanPrimitiveResult, type MeituanReadContext } from './meituan-primitives.js';

export function createMeituanPrimitiveServer(reader: MeituanPrimitiveReader, record?: (receipt: MeituanPrimitiveReceipt) => void) {
  const server = new McpServer({ name: 'meituan-personal', version: '2' });
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  server.registerTool('ontology_module', { description: 'Pinned read-only ontology module; no execution authority.', inputSchema: z.strictObject({}), annotations }, () => ({ content: [], structuredContent: { module: meituanReadDefinitionRef, definition: meituanReadDefinition } }));
  for (const [tool, inputSchema] of Object.entries(meituanPrimitiveSchemas)) {
    const schema: z.ZodObject = inputSchema.extend({ readContext: z.strictObject({ accountBinding: z.string().regex(/^[a-f0-9]{64}$/).optional() }).optional() });
    server.registerTool(tool, { description: 'One authorized private Meituan read. Selection and dependencies belong to the Worker ontology plan.', inputSchema: schema, annotations }, async (input, extra) => {
      try {
        const { readContext, ...business } = input;
        const result = await reader.invoke(tool, business, extra.mcpReq.signal, readContext as MeituanReadContext | undefined);
        if (result.receipt.tool !== tool || result.receipt.inputDigest !== digest(business) || result.receipt.resultDigest !== digest(result.value) || result.receipt.evidenceKind !== reader.evidenceKind) throw new Error();
        record?.(result.receipt);
        return { content: [], structuredContent: result };
      } catch { return { isError: true, content: [{ type: 'text' as const, text: 'Meituan primitive read unavailable; no order or payment was sent.' }] }; }
    });
  }
  return server;
}

export class OntologyMeituanMcpReader implements MeituanPrimitiveReader {
  readonly evidenceKind = 'live_readonly' as const;
  readonly configurationDigest: string;
  constructor(private directory: string, private audit?: string) {
    if (!isAbsolute(directory) || audit && !isAbsolute(audit)) throw new Error('Meituan requires private absolute paths');
    this.configurationDigest = digest({ directory, ontology: meituanReadDefinitionRef, protocol: 'atomic-mcp-v2' });
  }
  async invoke(tool: string, input: Record<string, unknown>, signal: AbortSignal, context: MeituanReadContext = {}): Promise<MeituanPrimitiveResult> {
    if (!Object.hasOwn(meituanPrimitiveSchemas, tool)) throw new Error('Meituan write or unknown tool is forbidden');
    const parsed = meituanPrimitiveSchemas[tool as keyof typeof meituanPrimitiveSchemas].parse(input);
    const source = import.meta.url.endsWith('.ts'), script = fileURLToPath(new URL(`../../apps/ontology-mcp/main.${source ? 'ts' : 'js'}`, import.meta.url));
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR'].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
    env.EIGOS_PAOTUI_SKILL_DIR = this.directory;
    if (this.audit) env.EIGOS_ONTOLOGY_AUDIT_PATH = this.audit;
    const client = new Client({ name: 'eigos-meituan-worker', version: '2' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [...(source ? ['--import', 'tsx'] : []), script], env, stderr: 'ignore', maxBufferSize: 1048576 });
    const abort = () => { void client.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted(); await client.connect(transport);
      const described = await client.callTool({ name: 'ontology_module', arguments: {} }, { signal, timeout: 10000 });
      if (described.isError || digest(z.object({ module: z.unknown() }).parse(described.structuredContent).module) !== digest(meituanReadDefinitionRef)) throw new Error();
      const raw = await client.callTool({ name: tool, arguments: { ...parsed, readContext: context } }, { signal, timeout: 45000 });
      if (raw.isError) throw new Error();
      const result = z.strictObject({ value: z.record(z.string(), z.unknown()), receipt: meituanPrimitiveReceiptSchema, accountBinding: z.string().regex(/^[a-f0-9]{64}$/) }).parse(raw.structuredContent);
      if (context.accountBinding && context.accountBinding !== result.accountBinding) throw new Error();
      if (result.receipt.evidenceKind !== this.evidenceKind || result.receipt.tool !== tool || result.receipt.inputDigest !== digest(parsed) || result.receipt.resultDigest !== digest(result.value)) throw new Error();
      return result;
    } catch { signal.throwIfAborted(); throw new Error('Meituan MCP read unavailable; inspect local authorization or source evidence'); }
    finally { signal.removeEventListener('abort', abort); await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  }
}
