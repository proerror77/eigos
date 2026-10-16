import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SCOPES } from '../core/domain.js';

type ManagementApi = (method: 'get' | 'patch', path: string, body?: unknown) => unknown;
const clientPage = z.object({ clients: z.array(z.object({ client_id: z.string().min(1) })), next: z.string().min(1).optional() });

// Auth0 retired connection.enabled_clients in 2026. Only enable our entries;
// the dedicated endpoint leaves every other application's connection intact.
export function ensureAuth0ConnectionClients(api: ManagementApi, connectionId: string, clientIds: string[]): void {
  const desired = new Set(z.array(z.string().min(1)).min(1).max(50).parse(clientIds));
  const path = `connections/${encodeURIComponent(connectionId)}/clients`;
  const read = () => {
    const enabled = new Set<string>(), cursors = new Set<string>();
    let from: string | undefined;
    for (let page = 0; page < 100; page++) {
      const response = clientPage.parse(api('get', `${path}?take=100${from ? `&from=${encodeURIComponent(from)}` : ''}`));
      for (const client of response.clients) enabled.add(client.client_id);
      if (!response.next) return enabled;
      if (cursors.has(response.next)) throw new Error('Connection client pagination repeated a cursor');
      cursors.add(response.next); from = response.next;
    }
    throw new Error('Connection client pagination exceeded its bound');
  };
  const before = read();
  const missing = [...desired].filter(id => !before.has(id));
  if (missing.length) api('patch', path, missing.map(client_id => ({ client_id, status: true })));
  const confirmed = read();
  if ([...desired].some(id => !confirmed.has(id))) throw new Error('Connection readback did not confirm both OAuth clients');
}

export function auth0Plan(publicUrl: string, agentCallback = 'http://127.0.0.1:3211/callback') {
  const origin = new URL(publicUrl);
  if (origin.protocol !== 'https:' || origin.origin !== publicUrl || origin.username || origin.password) throw new Error('Auth0 requires an exact HTTPS Gateway origin');
  const callback = new URL(agentCallback);
  if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port || Number(callback.port) < 1024 || callback.pathname !== '/callback' || callback.search || callback.hash || callback.username || callback.password) throw new Error('The native Agent callback must be an exact loopback /callback URL on an unprivileged port');
  const suffix = createHash('sha256').update(publicUrl).digest('hex').slice(0, 10);
  const metadata = (component: string) => ({ eigos_component: component, eigos_resource: publicUrl });
  return {
    resource: publicUrl, tenantClaim: `${publicUrl}/claims/tenant_id`, agentCallback: callback.href,
    api: {
      name: `EIGOS API ${suffix}`, identifier: publicUrl, signing_alg: 'RS256', token_dialect: 'rfc9068_profile',
      token_lifetime: 900, token_lifetime_for_web: 900, allow_offline_access: false,
      skip_consent_for_verifiable_first_party_clients: false,
      scopes: SCOPES.map(value => ({ value, description: value === 'services:read' ? 'View EIGOS services' : value === 'tasks:read' ? 'Read your EIGOS tasks' : 'Submit, reply to and cancel your EIGOS tasks' })),
    },
    portal: {
      name: `EIGOS member portal ${suffix}`, app_type: 'regular_web', oidc_conformant: true, is_first_party: true,
      callbacks: [`${publicUrl}/members/callback`], allowed_logout_urls: [`${publicUrl}/members`], web_origins: [publicUrl],
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code'], jwt_configuration: { alg: 'RS256' },
      client_metadata: metadata('member-portal'),
    },
    agent: {
      name: `EIGOS personal agent ${suffix}`, app_type: 'native', oidc_conformant: true,
      callbacks: [callback.href], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
      // This pre-registered reference client is owned by EIGOS. API consent
      // remains required independently of the application's ownership flag.
      jwt_configuration: { alg: 'RS256' }, is_first_party: true, client_metadata: metadata('personal-agent'),
    },
    actionName: `EIGOS member identity ${suffix}`,
  };
}
