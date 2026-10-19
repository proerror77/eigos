import { randomUUID } from 'node:crypto';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { paotuiQuerySchema, type PaotuiReader } from './paotui-contracts.js';
import { PAOTUI_READ_CAPABILITIES, paotuiReadDefinitions, ontologyToolName } from './paotui-ontology.js';

export const ontologyReceiptSchema = z.object({
  id: z.uuid(), transport: z.literal('mcp-stdio'), server: z.literal('eigos-ontology'),
  capabilityRef: z.object({ id: z.string(), version: z.literal('1') }).strict(),
  ontologyRef: z.object({ id: z.literal('locations-and-parcel-quotes'), version: z.literal('1') }).strict(),
  tool: z.string(), evidenceKind: z.enum(['live_readonly', 'fixture']),
  inputDigest: z.string(), resultDigest: z.string(), observedAt: z.iso.datetime(),
  sourceConnectionDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sourceCalls: z.array(z.string()), readOnly: z.literal(true),
}).strict();
export type OntologyReceipt = z.infer<typeof ontologyReceiptSchema>;

// This internal server has no HTTP listener or write tools. The Worker owns its stdio pipe.
export function createPaotuiOntologyServer(reader: PaotuiReader, options: {
  allowedActions?: readonly ('addresses' | 'preview')[]; sourceConnectionDigest?: string;
  evidenceKind: OntologyReceipt['evidenceKind']; sourceCalls?: () => string[];
  record?: (receipt: OntologyReceipt) => void;
}) {
  const server = new McpServer({ name: 'eigos-ontology', version: '1' });
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  server.registerTool('ontology_definition', {
    description: 'Read a pinned ontology capability definition before invoking its read action.',
    inputSchema: z.object({ id: z.enum(['geo.search', 'delivery.quote', 'address.book.read']) }).strict(),
    annotations: { ...read, openWorldHint: false },
  }, ({ id }) => {
    const capability = PAOTUI_READ_CAPABILITIES.find(c => c.ref.id === id)!;
    return { content: [{ type: 'text', text: JSON.stringify(capability) }], structuredContent: { capability } };
  });
  for (const [i, definition] of paotuiReadDefinitions.entries()) {
    const capability = PAOTUI_READ_CAPABILITIES[i]!;
    const tool = ontologyToolName(definition.id);
    const inputSchema: z.ZodObject = definition.schema;
    server.registerTool(tool, { description: definition.description, inputSchema, annotations: read }, async (input, extra): Promise<CallToolResult> => {
      try {
        options.sourceCalls?.();
        const parsed = definition.schema.parse(input);
        const query = paotuiQuerySchema.parse({ action: definition.kind === 'geo' ? 'search_address' : definition.kind === 'quote' ? 'preview' : 'addresses', ...parsed });
        if (options.allowedActions && !options.allowedActions.some(action => action === query.action)) throw new Error('Read action outside connection scope');
        const result = await reader.query(query, extra.mcpReq.signal) as Record<string, unknown>;
        if (result.source !== 'meituan' || (query.action === 'preview' ? result.previewOnly !== true || result.orderCreated !== false : result.readOnly !== true)) throw new Error('Invalid read-only source receipt');
        const receipt = ontologyReceiptSchema.parse({ id: randomUUID(), transport: 'mcp-stdio', server: 'eigos-ontology',
          capabilityRef: capability.ref, ontologyRef: capability.ontologyRef, tool, evidenceKind: options.evidenceKind,
          inputDigest: digest(parsed), resultDigest: digest(result), observedAt: new Date().toISOString(),
          ...(options.sourceConnectionDigest ? { sourceConnectionDigest: options.sourceConnectionDigest } : {}),
          sourceCalls: options.sourceCalls?.() ?? [], readOnly: true });
        options.record?.(receipt);
        return { content: [{ type: 'text', text: JSON.stringify({ result, receipt }) }], structuredContent: { result, receipt } };
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'Ontology read unavailable; check personal Meituan authorization and connectivity.' }] };
      }
    });
  }
  return server;
}
