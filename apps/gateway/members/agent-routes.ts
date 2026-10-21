import type { Express, Request, Response } from 'express';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import type { Config } from '../../../packages/core/config.js';
import { DomainError, TASK_SCOPES } from '../../../packages/core/domain.js';
import { SOURCE_SCOPES } from '../../../packages/core/member-source.js';
import { MemberStore, applicationSchema } from '../../../packages/members/store.js';
import { AgentAccessError, MEMBERSHIP_SCOPE, type AgentRegistration } from '../../../packages/members/agents.js';
import type { VerifyToken } from '../auth.js';

export const REGISTRATION_HEADER = 'X-EIGOS-Registration-Token';
export const enrollmentClaim = (resource: string) => `${resource}/claims/agent_enrollment`;
export function agentOnboardingMetadata(c: Config) {
  return { version: 1, registration_endpoint: `${c.PUBLIC_URL}/agents/registrations`,
    issuer: c.OAUTH_ISSUER, client_id: c.OIDC_AGENT_CLIENT_ID, audience: c.OAUTH_AUDIENCE,
    scopes: ['openid', 'offline_access', MEMBERSHIP_SCOPE, ...TASK_SCOPES, ...(c.EIGOS_MEMBER_SOURCE_KEY_FILE ? SOURCE_SCOPES : [])],
    membership_url: `${c.PUBLIC_URL}/members`, admission_policy: c.EIGOS_MEMBERSHIP_APPROVAL,
    authorization_grant: 'urn:ietf:params:oauth:grant-type:device_code', credential_header: REGISTRATION_HEADER,
    registration_credential: { generation: '32 cryptographically random bytes, unpadded base64url', length: 43, purpose: 'Registration status and binding only; not a business access token' },
    registration_request: { method: 'POST', content_type: 'application/json', schema: {
      type: 'object', required: ['registrationId', 'displayName'], additionalProperties: false,
      properties: { registrationId: { type: 'string', format: 'uuid' }, displayName: { type: 'string', minLength: 1, maxLength: 80 } },
    } },
    membership_application: { required_scope: MEMBERSHIP_SCOPE, consent: 'Save the supplied membership profile and allow this Agent to call services within the granted OAuth scopes. Purchases, payment and external sends require separate authorization.',
      schema: { type: 'object', required: ['displayName', 'locale', 'timezone', 'consent'], additionalProperties: false,
        properties: { displayName: { type: 'string', minLength: 1, maxLength: 80 }, locale: { enum: ['zh-CN', 'en'] }, timezone: { type: 'string', description: 'Valid IANA timezone, e.g. Asia/Shanghai or UTC' }, consent: { const: true } } } },
    token_binding: { method: 'POST', action: 'links.bind', body: {}, when: 'After the initial grant and every access-token refresh; keep the same registration and credential' },
  };
}

export function mountAgentRoutes(app: Express, c: Config, members: MemberStore, verify: VerifyToken): void {
  app.get('/.well-known/eigos-agent-registration', (_req, res) => {
    if (!c.OIDC_AGENT_CLIENT_ID || c.EIGOS_AUTH_MODE !== 'jwt') { res.status(404).json({ error: 'agent_onboarding_not_configured' }); return; }
    res.json(agentOnboardingMetadata(c));
  });
  const view = (value: AgentRegistration) => {
    const status = members.agents.status(value, c.EIGOS_MEMBERSHIP_APPROVAL);
    const base = `${c.PUBLIC_URL}/agents/registrations/${value.id}`;
    return { registrationId: value.id, displayName: value.displayName, status,
      nextAction: ({ authorization_required: 'authorize_user', registration_required: 'submit_membership', waiting_invitation: 'wait_for_invitation', pending_approval: 'wait_for_approval', active: 'call_services', registration_expired: 'start_new_registration' } as Record<string, string>)[status] ?? 'contact_member',
      pollAfterSeconds: 5, links: { status: base, bind: `${base}/token`, application: `${base}/application`, invitation: `${base}/invitation`, revoke: `${base}/revoke`, membership: `${c.PUBLIC_URL}/members`, mcp: `${c.PUBLIC_URL}/mcp`, a2a: `${c.PUBLIC_URL}/a2a` } };
  };
  app.all(['/agents/registrations', '/agents/registrations/:id', '/agents/registrations/:id/:action'], async (req, res, next) => {
    if (!c.OIDC_AGENT_CLIENT_ID || c.EIGOS_AUTH_MODE !== 'jwt') { res.status(503).json({ error: 'agent_onboarding_not_configured' }); return; }
    try {
      const credential = req.get(REGISTRATION_HEADER) ?? '';
      if (req.path === '/agents/registrations' && req.method === 'POST') {
        res.status(201).json(view(members.agents.create(req.body, credential))); return;
      }
      const id = z.uuid().parse(req.params.id), value = members.agents.get(id, credential);
      if (!req.params.action && req.method === 'GET') { res.json(view(value)); return; }
      if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
      const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!token) { res.status(401).json({ error: 'user_authorization_required', onboarding_url: `${c.PUBLIC_URL}/.well-known/eigos-agent-registration` }); return; }
      let principal;
      try { principal = await verify(token); }
      catch { res.status(401).json({ error: 'invalid_token' }); return; }
      if (principal.clientId !== c.OIDC_AGENT_CLIENT_ID) throw new DomainError('FORBIDDEN', 'Use the registered Agent connector client');
      if (req.params.action === 'token') {
        const claims = decodeJwt(token);
        const { exp, iat } = z.object({ exp: z.number(), iat: z.number() }).parse(claims);
        if (exp * 1000 <= Date.now()) { res.status(401).json({ error: 'invalid_token' }); return; }
        const canEnroll = claims[enrollmentClaim(c.OAUTH_AUDIENCE!)] === true;
        if (!value.memberId && (!canEnroll || iat * 1000 + 5000 < value.createdAt)) throw new AgentAccessError('fresh_authorization_required');
        const member = members.find(principal) ?? members.login(principal);
        res.json(view(members.agents.bind(id, credential, principal, member.id, token, exp * 1000, iat * 1000, canEnroll))); return;
      }
      const memberId = members.agents.requireOwner(value, principal);
      if (['application', 'invitation'].includes(String(req.params.action)) && !principal.scopes.includes(MEMBERSHIP_SCOPE)) {
        res.set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${MEMBERSHIP_SCOPE}"`).status(403).json({ error: 'insufficient_scope', scope: MEMBERSHIP_SCOPE }); return;
      }
      if (req.params.action === 'application') {
        const application = applicationSchema.parse(req.body);
        // Installing another Agent must not overwrite an existing member's
        // user-edited profile or reset their already granted admission.
        members.apply(memberId, application, c.EIGOS_MEMBERSHIP_APPROVAL !== 'self-service', { preserveActiveProfile: true });
      } else if (req.params.action === 'invitation') {
        const body = z.object({ invitationToken: z.string().min(32).max(200) }).strict().parse(req.body);
        members.agents.redeem(value, principal, body.invitationToken);
      } else if (req.params.action === 'revoke') members.agents.revoke(memberId, id);
      else { res.status(404).json({ error: 'unknown_registration_action' }); return; }
      res.json(view(members.agents.get(id, credential)));
    } catch (error) {
      if (error instanceof AgentAccessError) { res.status(error.code === 'registration_limit' ? 429 : 403).json({ error: error.code }); return; }
      if (error instanceof DomainError) { res.status(error.code === 'CONFLICT' ? 409 : error.code === 'NOT_FOUND' ? 404 : 403).json({ error: error.code, message: error.message }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_registration_input' }); return; }
      next(error);
    }
  });
}
