// Synthetic model driver only. All tool interactions still traverse the actual
// native MCP HTTP transport; this helper is never a production model fallback.
import { z } from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CodexExecutor, RunEvidence } from '../../packages/capabilities/executor.js';
import { reasoningTurnSchema } from '../../packages/ontology/planning-contract.js';

export function scriptedMcpModel(script: Pick<CodexExecutor, 'runStructured'>): Pick<CodexExecutor, 'runStructured' | 'ontologyTransport'> {
  return { ontologyTransport: 'native-mcp', runStructured: async (prompt, _schema, signal, options) => {
    if (!options?.mcp) throw new Error('Fixture requires the actual native Ontology MCP connection');
    const client = new Client({ name: 'synthetic-ontology-model', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(options.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${options.mcp.token}` } } });
    const conversation: { call: { tool: string; argumentsJson: string }; result: unknown; receipt: { id: string; status: string } }[] = [];
    const nativeMcpCalls: NonNullable<RunEvidence['nativeMcpCalls']> = [];
    let finalRequired = false;
    const parts = prompt.split('\n\n'), packet = JSON.parse(parts.pop()!);
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const call = async (name: string, args: Record<string, unknown>) => {
        signal.throwIfAborted();
        const response = await client.callTool({ name, arguments: args }, { signal });
        nativeMcpCalls.push({ server: 'eigos_ontology', tool: name, status: response.isError ? 'failed' : 'completed' });
        if (response.isError) throw new Error(response.content.filter(x => x.type === 'text').map(x => x.text).join('\n'));
        return (response.structuredContent as { result: any }).result;
      };
      for (let turn = 0; turn < 40; turn++) {
        signal.throwIfAborted();
        const schema = finalRequired ? reasoningTurnSchema.extend({ kind: z.literal('final'), calls: reasoningTurnSchema.shape.calls.max(0) }) : reasoningTurnSchema;
        const response = await script.runStructured([...parts, JSON.stringify({ ...packet, interface: { tools: tools.tools, finalResponseRequired: finalRequired }, conversation })].join('\n\n'), z.toJSONSchema(schema), signal);
        signal.throwIfAborted();
        const step = response.output as { kind: string; calls?: { tool: string; argumentsJson: string }[]; receiptIds?: string[]; finalJson?: string };
        if (step.kind === 'final') {
          const result = await call('submit_decision', { receiptIds: step.receiptIds ?? conversation.filter(t => t.receipt.status === 'ok').map(t => t.receipt.id), decisionJson: step.finalJson });
          return { output: { decisionDigest: result.decisionDigest }, evidence: { ...response.evidence, nativeMcpCalls } };
        }
        for (const request of step.calls ?? []) {
          const result = await call(request.tool, JSON.parse(request.argumentsJson));
          finalRequired = result.budget.finalResponseRequired;
          conversation.push({ call: request, result: result.result, receipt: result.receipt });
        }
      }
      throw new Error('Synthetic model did not complete within the fixture limit');
    } finally { await client.close(); await transport.close(); }
  } };
}
