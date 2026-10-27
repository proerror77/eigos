import { z } from 'zod';
import { TASK_SCOPES, ONTOLOGY_OPERATOR_SCOPES, type Principal } from '../core/domain.js';

const https = z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; });
export const ontologyOperatorScopes = [...TASK_SCOPES, ...ONTOLOGY_OPERATOR_SCOPES];
export const ontologyOperatorProfileSchema = z.strictObject({
  baseUrl: https.refine(value => new URL(value).origin === value),
  issuer: https.refine(value => value === new URL(value).origin + '/'),
  audience: https.refine(value => new URL(value).pathname === '/'),
  clientId: z.string().trim().min(1).max(200), subject: z.string().trim().min(1).max(500), tenant: z.string().trim().min(1).max(200),
  tenantClaim: z.string().trim().min(1).max(400),
  callbackUrl: z.url().refine(value => { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && url.pathname === '/callback' && !url.search && !url.hash && !url.username && !url.password; }),
}).refine(value => value.audience === value.baseUrl || value.audience === value.baseUrl + '/', 'Operator audience must bind the exact primary endpoint');
export type OntologyOperatorProfile = z.infer<typeof ontologyOperatorProfileSchema>;

export function assertOntologyOperator(profile: OntologyOperatorProfile, principal: Principal): void {
  if (principal.issuer !== profile.issuer || principal.clientId !== profile.clientId || principal.subject !== profile.subject || principal.tenant !== profile.tenant)
    throw new Error('Operator identity does not match the reviewed member and client');
  if (ontologyOperatorScopes.some(scope => !principal.scopes.includes(scope))) throw new Error('The issuer did not grant the required ontology management scopes');
  const allowed: readonly string[] = [...ontologyOperatorScopes, 'openid', 'profile', 'email', 'offline_access'];
  if (principal.scopes.some(scope => !allowed.includes(scope))) throw new Error('Operator credential contains permissions outside its reviewed purpose');
}
