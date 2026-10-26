import type { Request } from 'express';
import type { Config } from '../../packages/core/config.js';
import { runtimeIngress, type RuntimeIngress } from '../../packages/core/runtime-authority.js';
import { TASK_SCOPES, type Principal } from '../../packages/core/domain.js';
import { createVerifier, type VerifyToken } from './auth.js';

/** Transport adaptation only: every ingress reaches the same TaskService,
 * membership store and authority. Forwarded headers cannot select an audience. */
export function createIngressRouter(config: Config, override?: VerifyToken, factory: (config: Config) => VerifyToken = createVerifier) {
  const verifiers = new Map<string, VerifyToken>();
  const selected = (request: Pick<Request, 'headers'>): RuntimeIngress | undefined => {
    if (!config.authority) return;
    const ingress = runtimeIngress(config.authority, request.headers.host);
    if (!ingress) throw new Error('Ingress is not registered to this authority');
    return ingress;
  };
  const effective = (request: Pick<Request, 'headers'>): Config => {
    const ingress = selected(request);
    return ingress ? { ...config, PUBLIC_URL: ingress.origin, OAUTH_AUDIENCE: ingress.audience, OAUTH_LEGACY_AUDIENCE: undefined,
      OIDC_AGENT_CLIENT_ID: ingress.agentClientId, OIDC_MCP_CLIENT_ID: ingress.nativeClientIds[0] } : config;
  };
  return {
    selected, config: effective,
    verify(request: Pick<Request, 'headers'>): VerifyToken {
      if (override) return override;
      const current = effective(request), key = current.PUBLIC_URL;
      let verifier = verifiers.get(key);
      if (!verifier) { verifier = factory(current); verifiers.set(key, verifier); }
      return verifier;
    },
    principal(request: Pick<Request, 'headers'>, principal: Principal): Principal | undefined {
      const ingress = selected(request);
      if (!ingress) return principal;
      if (![...ingress.agentClientIds, ...ingress.nativeClientIds].includes(principal.clientId)) return;
      return { ...principal, scopes: principal.scopes.filter(scope => (TASK_SCOPES as readonly string[]).includes(scope)) };
    },
  };
}
