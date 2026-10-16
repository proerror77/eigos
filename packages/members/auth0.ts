import { createHash } from 'node:crypto';
import { SCOPES } from '../core/domain.js';

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
      name: `EIGOS member portal ${suffix}`, app_type: 'regular_web', oidc_conformant: true,
      callbacks: [`${publicUrl}/members/callback`], allowed_logout_urls: [`${publicUrl}/members`], web_origins: [publicUrl],
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code'], jwt_configuration: { alg: 'RS256' },
      client_metadata: metadata('member-portal'),
    },
    agent: {
      name: `EIGOS personal agent ${suffix}`, app_type: 'native', oidc_conformant: true,
      callbacks: [callback.href], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
      jwt_configuration: { alg: 'RS256' }, is_first_party: false, client_metadata: metadata('personal-agent'),
    },
    actionName: `EIGOS member identity ${suffix}`,
  };
}
