import type { PersonalSourceAccess } from '../core/personal-source.js';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { paotuiQuerySchema, type PaotuiQuery, type PaotuiReader } from './paotui-contracts.js';
import { PAOTUI_READ_CAPABILITIES, paotuiReadDefinitions, ontologyToolName } from './paotui-ontology.js';
import { ontologyReceiptSchema } from './paotui-mcp-server.js';

export class OntologyMcpPaotuiReader implements PaotuiReader {
  readonly configurationDigest: string;
  constructor(private skillDirectory: string, private auditPath?: string, private options: { access?: PersonalSourceAccess; databasePath?: string; execute?: boolean } = {}) {
    if (!isAbsolute(skillDirectory) || (auditPath && !isAbsolute(auditPath))) throw new Error('Ontology MCP requires absolute private local paths');
    if (options.access && (!options.databasePath || !isAbsolute(options.databasePath))) throw new Error('Member source requires a persistent shared business database');
    this.configurationDigest = digest({ server: 'eigos-ontology', version: '1', skillDirectory, capabilityDefinitions: PAOTUI_READ_CAPABILITIES, ...(options.access ? { memberConnection: options.access.configurationDigest } : {}) });
  }
  async query(input: PaotuiQuery, signal: AbortSignal): Promise<object> {
    signal.throwIfAborted();
    if (this.options.execute === false) throw new Error('Source reads run only in the Worker');
    this.options.access?.assert();
    const query = paotuiQuerySchema.parse(input);
    if (this.options.access && query.action !== 'addresses' && query.action !== 'preview') throw new Error('Member source permits only owned address and delivery quote reads');
    if (query.action === 'authorization') throw new Error('Authorization is not an ontology business read');
    const id = query.action === 'preview' ? 'delivery.quote' : query.action === 'addresses' ? 'address.book.read' : 'geo.search';
    const definition = paotuiReadDefinitions.find(d => d.id === id)!;
    const { action: _action, ...values } = query;
    const args = definition.schema.parse(values);
    const capability = PAOTUI_READ_CAPABILITIES.find(c => c.ref.id === id)!;
    const tool = ontologyToolName(id);
    const source = import.meta.url.endsWith('.ts');
    const script = fileURLToPath(new URL(`../../apps/ontology-mcp/main.${source ? 'ts' : 'js'}`, import.meta.url));
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR'].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
    env.EIGOS_PAOTUI_SKILL_DIR = this.skillDirectory;
    if (this.auditPath) env.EIGOS_ONTOLOGY_AUDIT_PATH = this.auditPath;
    if (this.options.access) {
      env.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE = this.options.access.path;
      env.EIGOS_PAOTUI_CONNECTION_DIGEST = this.options.access.configurationDigest;
      env.EIGOS_SOURCE_DATABASE_PATH = this.options.databasePath!;
    }
    const client = new Client({ name: 'eigos-ontology-worker', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [...(source ? ['--import', 'tsx'] : []), script], env, stderr: 'ignore', maxBufferSize: 1024 * 1024 });
    const abort = () => { void client.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect(transport);
      signal.throwIfAborted();
      const described = await client.callTool({ name: 'ontology_definition', arguments: { id } }, { signal, timeout: 10000 });
      if (described.isError || digest(z.object({ capability: z.unknown() }).parse(described.structuredContent).capability) !== digest(capability)) throw new Error('Ontology definition mismatch');
      const response = await client.callTool({ name: tool, arguments: args }, { signal, timeout: 120000 });
      if (response.isError) throw new Error('Ontology read rejected');
      const { result, receipt } = z.object({ result: z.record(z.string(), z.unknown()), receipt: ontologyReceiptSchema }).parse(response.structuredContent);
      if (!result || typeof result !== 'object' || receipt.evidenceKind !== 'live_readonly' || receipt.sourceConnectionDigest !== this.options.access?.configurationDigest || receipt.tool !== tool || digest(receipt.capabilityRef) !== digest(capability.ref) || digest(receipt.ontologyRef) !== digest(capability.ontologyRef) || receipt.inputDigest !== digest(args) || receipt.resultDigest !== digest(result)) throw new Error('Ontology response mismatch');
      signal.throwIfAborted(); this.options.access?.assert();
      return { ...result, ontologyReceipt: receipt };
    } catch {
      signal.throwIfAborted();
      throw new Error('Ontology MCP read failed; check personal Meituan authorization and connectivity.');
    } finally { signal.removeEventListener('abort', abort); await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  }
}
