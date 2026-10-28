import { DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import type { AgentCard } from '@a2a-js/sdk';

/** Public discovery sends no installation credentials. Only the advertised
 * same-origin A2A 1.0 JSON-RPC interface is eligible for authenticated calls. */
export async function discoverA2A(baseUrl: string, fetcher: typeof fetch = fetch): Promise<AgentCard> {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' || origin.origin !== baseUrl) throw new Error('https_origin_required');
  const card = await new DefaultAgentCardResolver({
    fetchImpl: (input, init) => fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) }),
  }).resolve(baseUrl);
  const endpoint = card.supportedInterfaces.find(value => value.protocolBinding === 'JSONRPC'
    && value.protocolVersion === '1.0' && value.url === baseUrl + '/a2a');
  if (!endpoint) throw new Error('compatible_a2a_interface_required');
  // The SDK chooses from the supplied interfaces. Do not let another advertised
  // transport or origin receive this installation's token.
  return { ...card, supportedInterfaces: [endpoint] };
}
