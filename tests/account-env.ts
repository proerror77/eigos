export const portalEnv = {
  DATABASE_URL: 'postgres://synthetic', PUBLIC_URL: 'https://127.0.0.1',
  OAUTH_ISSUER: 'https://identity.example/', OAUTH_AUDIENCE: 'https://127.0.0.1',
  OAUTH_JWKS_URL: 'https://identity.example/.well-known/jwks.json',
  OAUTH_MEMBER_CLIENT_ID: 'portal', OAUTH_MEMBER_CLIENT_SECRET: 'synthetic-portal-secret',
  OAUTH_MEMBER_MCP_CLIENT_ID: 'grok', OAUTH_EXISTING_CLIENT_IDS: 'existing-client',
  EIGOS_PORTAL_SECRET: 'p'.repeat(32), EIGOS_ACCOUNT_LINK_SECRET: 'l'.repeat(32), EIGOS_ENFORCE_OWNER_RLS: 'true',
};
