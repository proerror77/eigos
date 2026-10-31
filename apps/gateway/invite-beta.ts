import type { Config } from '../../packages/core/config.js';
import { TASK_SCOPES, type Principal } from '../../packages/core/domain.js';

/** The public beta exposes task access even if an issuer accidentally returns
 * additional scopes. Membership and per-user client revocation still apply. */
export function inviteBetaPrincipal(config: Config, principal: Principal): Principal | undefined {
  if (config.EIGOS_INVITE_BETA !== 'true') return principal;
  if (![config.OIDC_MCP_CLIENT_ID, config.OIDC_AGENT_CLIENT_ID].includes(principal.clientId)) return undefined;
  return { ...principal, scopes: principal.scopes.filter(scope => (TASK_SCOPES as readonly string[]).includes(scope)) };
}
