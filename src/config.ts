import { z } from 'zod';

const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url().default('http://127.0.0.1:3000'),
  DATABASE_PATH: z.string().default('./data/eigos.sqlite'),
  EIGOS_AUTH_MODE: z.enum(['jwt', 'development']).default('jwt'),
  EIGOS_DEV_TOKEN: z.string().optional(),
  OAUTH_ISSUER: z.url().optional(),
  OAUTH_JWKS_URL: z.url().optional(),
  OAUTH_AUDIENCE: z.url().optional(),
  ALLOWED_ORIGINS: z.string().default(''),
});
export type Config = z.infer<typeof schema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  const publicUrl = new URL(c.PUBLIC_URL);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_URL must be an origin without a path, credentials, query or fragment');
  }
  c.PUBLIC_URL = publicUrl.origin;
  if (c.EIGOS_AUTH_MODE === 'development') {
    if (!['127.0.0.1', 'localhost', '::1'].includes(c.HOST) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname) ||
        env.NODE_ENV === 'production') throw new Error('Development credentials are restricted to loopback and non-production');
    if (!c.EIGOS_DEV_TOKEN || c.EIGOS_DEV_TOKEN.length < 32) throw new Error('Development token must contain at least 32 characters; run npm run setup:dev');
  } else {
    if (!c.OAUTH_ISSUER || !c.OAUTH_JWKS_URL || !c.OAUTH_AUDIENCE) throw new Error('JWT mode requires OAUTH_ISSUER, OAUTH_JWKS_URL and OAUTH_AUDIENCE');
    for (const value of [c.PUBLIC_URL, c.OAUTH_ISSUER, c.OAUTH_JWKS_URL, c.OAUTH_AUDIENCE]) {
      if (new URL(value).protocol !== 'https:') throw new Error('JWT mode requires HTTPS public, issuer, JWKS and audience URLs');
    }
  }
  for (const origin of c.ALLOWED_ORIGINS.split(',').filter(Boolean)) {
    if (new URL(origin).origin !== origin) throw new Error('ALLOWED_ORIGINS must contain exact origins, without trailing slashes');
  }
  return c;
}
