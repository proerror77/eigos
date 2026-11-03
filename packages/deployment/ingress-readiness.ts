import type { RuntimeAuthority } from '../core/runtime-authority.js';

type Read = (url: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;
async function read(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const reader = response.body?.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', bytes = 0;
  try {
    if (reader) while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.length; if (bytes > 65536) throw new Error('Ingress verification response exceeds its bound');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader?.cancel(); }
  let body: unknown; try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: response.status, body };
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Operator-only readback: no login, grant creation, task submission, source
 * action or forwarding-header override. Every registered origin stands alone. */
export async function verifyPrimaryIngresses(authority: RuntimeAuthority, expected: { authorityId: string; releaseDigest: string }, request: Read = read) {
  return Promise.all(authority.ingresses.map(async ingress => {
    const base = ingress.origin;
    const [health, card, oauth, deniedMcp, deniedA2a] = await Promise.all([
      request(base + '/health'),
      request(base + '/.well-known/agent-card.json'),
      request(base + '/.well-known/oauth-protected-resource'),
      request(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'deployment-readiness', method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'eigos-deployment-readback', version: '1' } } }) }),
      request(base + '/a2a', { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'deployment-readiness', method: 'GetTask', params: { id: 'deployment-readback-no-task' } }) }),
    ]);
    const status = object(health.body), agent = object(card.body), resource = object(oauth.body);
    const interfaces = Array.isArray(agent.supportedInterfaces) ? agent.supportedInterfaces : [];
    if (health.status !== 200 || status.status !== 'ok' || status.authorityId !== expected.authorityId || status.releaseDigest !== expected.releaseDigest
      || card.status !== 200 || !interfaces.some(value => object(value).protocolBinding === 'JSONRPC' && object(value).url === base + '/a2a')
      || oauth.status !== 200 || resource.resource !== ingress.audience
      || !Array.isArray(resource.authorization_servers) || !resource.authorization_servers.includes(authority.issuer)
      || deniedMcp.status !== 401 || deniedA2a.status !== 401)
      throw new Error('Registered ingress did not verify its authority, release, discovery and authentication boundary: ' + base);
    return { origin: base, authorityId: expected.authorityId, releaseDigest: expected.releaseDigest, discovery: true, unauthenticatedMcp: 401, unauthenticatedA2a: 401 };
  }));
}
