import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadOperatorCredential } from './ontology-operator-credential.mjs';

async function main() {
  const [city, origin, destination, requestId = randomUUID()] = process.argv.slice(2);
  if (!city || !origin || !destination) throw new Error('Usage: ontology-agent.mjs CITY ORIGIN DESTINATION [REQUEST_ID]');
  const startedAt = new Date().toISOString(), started = performance.now();
  const auth = await loadOperatorCredential(), authorized = performance.now();
  const client = new Client({ name: 'codex-production-ontology-agent', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', auth.base), {
      requestInit: { headers: { Authorization: 'Bearer ' + auth.token }, redirect: 'error' },
      reconnectionOptions: { maxRetries: 0 },
    }), { timeout: 10000 });
    const connected = performance.now();
    const result = await client.callTool({
      name: 'complete_with_action',
      arguments: {
        requestId,
        action: { interface: { type: 'RideInquiry', action: 'estimate', implementation: 'RideRequest' },
          input: { city, origin, destination } },
        read: { function: 'readRideEstimates', resultParameter: 'request' },
      },
    }, { timeout: 35000 });
    const returnedAt = new Date().toISOString(), returned = performance.now();
    if (result.isError) throw new Error(result.content?.[0]?.text ?? 'EIGOS quote failed');
    const quote = JSON.parse(result.content[0].text);
    if (quote.accepted !== true || !quote.evidence?.includes('live_readonly')) {
      throw new Error('EIGOS did not return a verified live quote');
    }
    console.log(JSON.stringify({
      requestId, startedAt, returnedAt, refreshed: auth.refreshed,
      timingMs: {
        credentials: Math.round(authorized - started), connect: Math.round(connected - authorized),
        call: Math.round(returned - connected), total: Math.round(returned - started),
      },
      request: quote.request, accepted: quote.accepted, evidence: quote.evidence,
      route: Object.fromEntries(Object.entries(quote.route).map(([side, { name, address }]) => [side, { name, address }])),
      estimates: quote.estimates.map(({ properties: { name, priceText, expiresAt } }) => ({ name, priceText, expiresAt })),
    }));
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch(error => {
  // Transport errors can contain request details; do not print arbitrary exceptions.
  const message = error instanceof Error ? error.message : '';
  console.error(/^(Usage:|EIGOS did not|OAuth |Unexpected operator|The operator |请选择|未找到|请提供|滴滴查询)/.test(message)
    ? message : 'EIGOS Agent call failed. Check the authorized local profile, connection and tool availability.');
  process.exitCode = 1;
});
