// Historical v14 read receipts only; no network or executable mapping.
import { z } from 'zod';
export const ontologyReceiptSchema = z.object({
  id: z.uuid(), transport: z.literal('mcp-stdio'), server: z.literal('eigos-ontology'),
  capabilityRef: z.object({ id: z.string(), version: z.literal('1') }).strict(),
  ontologyRef: z.object({ id: z.literal('locations-and-parcel-quotes'), version: z.literal('1') }).strict(),
  tool: z.string(), evidenceKind: z.enum(['live_readonly', 'fixture']),
  inputDigest: z.string(), resultDigest: z.string(), observedAt: z.iso.datetime(),
  sourceCalls: z.array(z.string()), readOnly: z.literal(true),
}).strict();
export type OntologyReceipt = z.infer<typeof ontologyReceiptSchema>;
